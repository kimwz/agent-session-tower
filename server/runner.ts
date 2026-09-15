import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import type { CreateSessionRequest, MessageAttachments, Provider, ProviderHealth, Run, Session } from '../shared/types.js';
import { isImageAttachment } from '../shared/attachments.js';
import { attachmentMetadata, attachmentPrompt, AttachmentStore } from './attachments.js';
import { normalizeSessionTitle } from './session-titles.js';
import type { CodexBridgeRun, CodexBridgeOptions } from './codex-app-server.js';
import { requestedModel, validModelId } from './models.js';

type SpawnProcess = (file: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
interface RunnerOptions {
  getSession: (id: string) => Session | undefined;
  refreshSessions: () => Promise<void>;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: SpawnProcess;
  findExecutable?: (provider: Provider) => Promise<string | undefined>;
  maxConcurrent?: number;
  pollMs?: number;
  openCodexBridge?: (options: Omit<CodexBridgeOptions, 'codexHome'>) => Promise<CodexBridgeRun | undefined>;
}
interface OwnedProcess {
  child: ChildProcessWithoutNullStreams;
  done: Promise<void>;
  killTimer?: ReturnType<typeof setTimeout>;
}
interface CreatedSession {
  session: Session;
  runId: string;
  confirmed: boolean;
  seenNative?: boolean;
  title?: string;
}

const MAX_OUTPUT = 64_000;
const MAX_PROMPT = 32_000;
const MAX_RUNS = 100;
const MAX_QUEUED = 32;
const FINISHED = new Set<Run['status']>(['completed', 'error', 'cancelled']);
const PROVIDERS: Provider[] = ['claude', 'codex'];
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

export class RunError extends Error {
  constructor(message: string, public readonly statusCode = 400) { super(message); }
}

/** Resolve executables without invoking a shell or evaluating shell startup files. */
function providerDirectories(env: NodeJS.ProcessEnv): string[] {
  // Finder starts programs with a minimal PATH. Use the same safe lookup for the
  // CLI and its interpreters/tools; empty or relative entries would search its cwd.
  return [...new Set([...(env.PATH ?? '').split(delimiter), join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'])]
    .filter(directory => directory && isAbsolute(directory));
}

export async function findExecutable(provider: Provider, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  for (const directory of providerDirectories(env)) {
    const candidate = join(directory, provider);
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { /* Try the next installed location. */ }
  }
  return undefined;
}

export async function getProviderHealth(counts: Partial<Record<Provider, number>> = {}): Promise<ProviderHealth[]> {
  return Promise.all(PROVIDERS.map(async (provider) => {
    const executable = await findExecutable(provider);
    return { provider, available: Boolean(executable), executable, sessionCount: counts[provider] ?? 0,
      ...(!executable ? { error: `${provider === 'claude' ? 'Claude Code' : 'Codex'} CLI was not found in PATH.` } : {}) };
  }));
}

export function buildResumeArgs(session: Session, model?: string): string[] {
  const override = requestedModel(model);
  if (session.provider === 'claude') return [
    '-p', '--resume', session.nativeId, '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--permission-mode', 'acceptEdits', '--permission-prompts', 'none', ...(override ? ['--model', override] : []),
  ];
  return ['exec', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"',
    'resume', session.nativeId, '-', '--json', '--skip-git-repo-check', ...(override ? ['--model', override] : [])];
}

export function buildCreateArgs(session: Session, model?: string): string[] {
  const override = requestedModel(model);
  if (session.provider === 'claude') return [
    '-p', '--session-id', session.nativeId, '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--permission-mode', 'acceptEdits', '--permission-prompts', 'none', ...(override ? ['--model', override] : []),
  ];
  return ['exec', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '-', '--json', '--skip-git-repo-check', ...(override ? ['--model', override] : [])];
}

/** Owns only processes launched by this monitor; never signals an external agent. */
export class RunManager extends EventEmitter {
  private readonly options: RunnerOptions;
  private readonly stateFile: string;
  private readonly createdFile: string;
  private readonly attachments: AttachmentStore;
  private readonly createdSessions = new Map<string, CreatedSession>();
  private readonly runs = new Map<string, Run>();
  private readonly owned = new Map<string, OwnedProcess>();
  private readonly bridged = new Map<string, CodexBridgeRun>();
  private readonly reservedSessions = new Set<string>();
  private readonly admissions = new Set<string>();
  private readonly locallySettled = new Map<string, number>();
  private readonly settledRuns = new Set<string>();
  private pollTimer?: ReturnType<typeof setInterval>;
  private notifyTimer?: ReturnType<typeof setTimeout>;
  private pumping = false;
  private started = false;
  private stopping = false;
  private writes: Promise<void> = Promise.resolve();
  private persistenceError?: Error;

  constructor(options: RunnerOptions) {
    super();
    this.options = options;
    this.stateFile = join(options.stateDir ?? join(homedir(), '.agent-monitor'), 'runs.json');
    this.createdFile = join(options.stateDir ?? join(homedir(), '.agent-monitor'), 'created-sessions.json');
    this.attachments = new AttachmentStore(options.stateDir ?? join(homedir(), '.agent-monitor'));
  }

  async start(): Promise<void> {
    if (this.started) return;
    await mkdir(this.options.stateDir ?? join(homedir(), '.agent-monitor'), { recursive: true, mode: 0o700 });
    await this.attachments.start();
    try {
      const saved = await readPrivateJson(this.createdFile);
      if (!Array.isArray(saved) || saved.some(value => !isCreatedSession(value))) throw new Error('Saved created sessions are invalid.');
      for (const value of saved) this.createdSessions.set(value.session.id, value);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try {
      if ((await stat(this.stateFile)).size > 12_000_000) throw new Error('Saved run history is too large.');
      const saved: unknown = JSON.parse(await readFile(this.stateFile, 'utf8'));
      if (!Array.isArray(saved)) throw new Error('Saved run history is invalid.');
      for (const value of saved.slice(-MAX_RUNS)) {
        if (!isSavedRun(value)) continue;
        const run: Run = { ...value, prompt: value.prompt.slice(0, MAX_PROMPT), output: value.output.slice(-MAX_OUTPUT),
          ...(value.attachments ? { attachments: value.attachments.map(item => attachmentMetadata(item)!) } : {}) };
        if (run.status === 'running' || run.status === 'queued') {
          run.status = run.status === 'running' ? 'error' : 'cancelled';
          run.error = 'Agent Session Tower stopped before this task finished. It was not restarted; send the instruction again to continue.';
          run.finishedAt = new Date().toISOString();
        }
        this.runs.set(run.id, run);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.started = true;
    this.persist();
    await this.flush();
    this.pollTimer = setInterval(() => { void this.pump(); }, this.options.pollMs ?? 1500);
    this.pollTimer.unref();
  }

  list(): Run[] { return [...this.runs.values()].map((run) => ({ ...run, ...(run.attachments ? { attachments: run.attachments.map(item => ({ ...item })) } : {}) })); }
  async attachment(id: string) {
    const { metadata, content } = await this.attachments.read(id);
    return { metadata, content };
  }
  settledRunIds(): ReadonlySet<string> { return new Set(this.settledRuns); }

  /** Stable monitor IDs keep layout, titles and closure attached after native discovery. */
  nativeSessionId(id: string): string {
    id = this.monitorSessionId(id);
    const created = this.createdSessions.get(id);
    return created?.confirmed ? `${created.session.provider}:${created.session.nativeId}` : id;
  }

  getSession(id: string): Session | undefined {
    id = this.monitorSessionId(id);
    const created = this.createdSessions.get(id);
    if (!created) {
      const native = this.options.getSession(id);
      return native?.parentId ? { ...native, parentId: this.monitorSessionId(native.parentId) } : native;
    }
    const native = created.confirmed ? this.options.getSession(this.nativeSessionId(id)) : undefined;
    if (native && !created.seenNative) { created.seenNative = true; this.persist(); }
    const initialRun = this.runs.get(created.runId);
    if (native) return { ...native, id, ...(native.parentId ? { parentId: this.monitorSessionId(native.parentId) } : {}), ...(created.title ? { customTitle: created.title } : {}) };
    if (created.seenNative && (!initialRun || FINISHED.has(initialRun.status))) return undefined;
    const live = initialRun?.status === 'queued' || initialRun?.status === 'running';
    return {
      ...created.session,
      resumable: created.confirmed,
      creationPending: !created.confirmed && live,
      status: initialRun?.status === 'running' ? 'working' : initialRun?.status === 'queued' ? 'idle' : initialRun?.status === 'completed' ? 'completed' : 'error',
      statusReason: live ? '새 세션을 생성하고 있습니다.' : initialRun?.error || (initialRun?.status === 'completed' ? '첫 작업을 완료했습니다.' : '세션 생성이 완료되지 않았습니다. 새 세션으로 다시 시작할 수 있습니다.'),
      updatedAt: initialRun?.finishedAt || initialRun?.startedAt || created.session.updatedAt,
    };
  }

  private monitorSessionId(id: string): string {
    if (this.createdSessions.has(id)) return id;
    for (const [monitorId, created] of this.createdSessions) {
      if (created.confirmed && `${created.session.provider}:${created.session.nativeId}` === id) return monitorId;
    }
    return id;
  }

  sessionList(nativeSessions: readonly Session[]): Session[] {
    const aliases = new Map([...this.createdSessions.keys()].map(id => [this.nativeSessionId(id), id]));
    const sessions = new Map(nativeSessions.filter(session => !aliases.has(session.id)).map(session => [session.id, session]));
    for (const id of this.createdSessions.keys()) {
      const session = this.getSession(id);
      if (session) sessions.set(id, session);
    }
    return [...sessions.values()].map(session => session.parentId && aliases.has(session.parentId)
      ? { ...session, parentId: aliases.get(session.parentId) } : session);
  }

  async create(input: CreateSessionRequest): Promise<{ session: Session; run: Run }> {
    this.validateAdmission(input.prompt);
    if (!PROVIDERS.includes(input.provider)) throw new RunError('Claude 또는 Codex를 선택하세요.');
    const model = requestedModel(input.model);
    if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd) || input.cwd.includes('\0') || input.cwd.length > 4096) throw new RunError('기존 작업 폴더의 절대 경로를 입력하세요.');
    try { if (!(await stat(input.cwd)).isDirectory()) throw new Error(); }
    catch { throw new RunError('작업 폴더를 찾을 수 없습니다. 기존 폴더의 절대 경로를 입력하세요.'); }
    const title = input.title === undefined ? '' : normalizeSessionTitle(input.title);
    if (!(await this.executable(input.provider))) throw new RunError(`Install the ${input.provider} CLI and ensure it is in PATH before creating a session.`, 503);
    this.validateAdmission(input.prompt);
    const uuid = randomUUID();
    const id = `${input.provider}:${input.provider === 'codex' ? 'monitor-' : ''}${uuid}`;
    const createdAt = new Date().toISOString();
    const session: Session = {
      id, nativeId: input.provider === 'claude' ? uuid : '', provider: input.provider,
      title: input.prompt.trim().replace(/\s+/g, ' ').slice(0, 120), ...(title ? { customTitle: title } : {}), cwd: input.cwd, project: basename(input.cwd) || input.cwd,
      status: 'idle', statusReason: '새 세션을 생성하고 있습니다.', createdAt, updatedAt: createdAt,
      lastRequestAt: createdAt, lastMessage: input.prompt.trim().slice(0, 512), messageCount: 0, isSubagent: false, resumable: false, creationPending: true,
    };
    const run: Run = { id: randomUUID(), sessionId: id, prompt: input.prompt.trim(), status: 'queued', createdAt, output: 'Queued — preparing to create this conversation.', ...(model ? { model } : {}) };
    this.createdSessions.set(id, { session, runId: run.id, confirmed: false, ...(title ? { title } : {}) });
    this.runs.set(run.id, run);
    this.admissions.add(run.id);
    this.prune();
    this.changed();
    try { await this.flush(); }
    catch (error) {
      // No provider starts until both records commit. Keep failure visible; never
      // leave an unacknowledged request queued for a later polling cycle.
      this.fail(run, error);
      await this.flush().catch(() => {});
      throw error;
    } finally { this.admissions.delete(run.id); }
    void this.pump();
    return { session: this.getSession(id)!, run: { ...run } };
  }

  private validateAdmission(prompt: string, hasAttachments = false): void {
    if (!this.started || this.stopping) throw new RunError('The task runner is not accepting instructions.', 503);
    if (typeof prompt !== 'string' || (!prompt.trim() && !hasAttachments)) throw new RunError('Enter an instruction or attach a file first.');
    if (prompt.length > MAX_PROMPT) throw new RunError(`Instructions must be at most ${MAX_PROMPT.toLocaleString()} characters.`, 413);
    if ([...this.runs.values()].filter((run) => run.status === 'queued').length >= MAX_QUEUED) throw new RunError('The task queue is full. Wait for a task to finish.', 429);
  }

  async enqueue(sessionId: string, prompt: string, request: MessageAttachments = {}): Promise<Run> {
    sessionId = this.monitorSessionId(sessionId);
    const hasAttachments = Boolean(request.attachments?.length || request.attachmentIds?.length);
    this.validateAdmission(prompt, hasAttachments);
    const session = this.getSession(sessionId);
    this.validateSession(session);
    const model = requestedModel(request.model);
    if (!(await this.executable(session.provider))) throw new RunError(`Install the ${session.provider} CLI and ensure it is in PATH before sending instructions.`, 503);
    const prepared = await this.attachments.prepare(sessionId, request);
    // File writes yield; recheck admission immediately before inserting the run.
    try { this.validateAdmission(prompt, prepared.attachments.length > 0); this.validateSession(this.getSession(sessionId)); }
    catch (error) { await this.attachments.rollback(prepared.createdIds); throw error; }
    const run: Run = { id: randomUUID(), sessionId, prompt, status: 'queued', createdAt: new Date().toISOString(), output: this.waitReason(session),
      ...(model ? { model } : {}),
      ...(prepared.attachments.length ? { attachments: prepared.attachments } : {}) };
    this.admissions.add(run.id);
    this.runs.set(run.id, run);
    this.prune();
    this.changed();
    try { await this.flush(); } // An accepted instruction is durable before launching the provider.
    catch (error) { this.runs.delete(run.id); this.changed(); await this.attachments.rollback(prepared.createdIds); throw error; }
    finally { this.admissions.delete(run.id); }
    void this.pump();
    return { ...run };
  }

  async cancel(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new RunError('Task not found.', 404);
    if (FINISHED.has(run.status)) return;
    const bridge = this.bridged.get(runId);
    if (bridge) {
      // The shared server owns the process. Interrupt only our correlated turn.
      await bridge.cancel();
      await this.flush();
      return;
    }
    run.status = 'cancelled';
    run.finishedAt = new Date().toISOString();
    const owned = this.owned.get(runId);
    if (owned) this.stopOwned(runId, owned);
    this.changed();
    await this.flush();
  }

  async close(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.notifyTimer) { clearTimeout(this.notifyTimer); this.notifyTimer = undefined; }
    for (const run of this.runs.values()) {
      if ((run.status === 'queued' || run.status === 'running') && !this.bridged.has(run.id)) {
        run.status = 'cancelled';
        run.finishedAt = new Date().toISOString();
        run.error = 'Stopped when Agent Session Tower shut down. This task will not restart automatically.';
      }
    }
    const processes = [...this.owned.entries()];
    const bridges = [...this.bridged.entries()];
    for (const [id, owned] of processes) this.stopOwned(id, owned);
    await Promise.all([
      ...processes.map(([, owned]) => owned.done),
      ...bridges.map(async ([id, bridge]) => {
        try { await bridge.cancel(); }
        catch {
          const run = this.runs.get(id);
          if (run) { run.status = 'error'; run.error = 'Codex 앱과 연결이 끊어져 중지 여부를 확인하지 못했습니다. 원래 앱에서 작업 상태를 확인하세요. 이 요청은 자동 재전송하지 않습니다.'; }
        } finally { bridge.close(); }
      }),
    ]);
    this.persist();
    await this.flush();
  }

  private validateSession(session: Session | undefined): asserts session is Session {
    if (!session) throw new RunError('Session no longer exists. Refresh and select another session.', 404);
    if (!session.resumable) throw new RunError('This session cannot be resumed by its provider.');
    if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(session.nativeId)) throw new RunError('The native session ID is invalid.');
    if (!isAbsolute(session.cwd)) throw new RunError('The session has no valid working directory.');
  }

  private executable(provider: Provider): Promise<string | undefined> {
    return this.options.findExecutable?.(provider) ?? findExecutable(provider, this.options.env);
  }

  private waitReason(session: Session): string {
    if (this.isWorking(session)) return 'Waiting for the current turn to finish before resuming this conversation.';
    if (session.provider === 'codex' && session.activeProcess) return 'Codex 앱이 이 세션의 쓰기 권한을 보유하고 있습니다. 기존 앱 서버에 연결할 수 있을 때 전달하거나, 원래 세션의 연결이 종료되면 재개합니다.';
    if (this.reservedSessions.has(session.id)) return 'Waiting for the previous instruction in this conversation.';
    return 'Queued — preparing to resume this conversation.';
  }

  private isWorking(session: Session): boolean {
    if (session.status !== 'working') return false;
    const settledAt = this.locallySettled.get(session.id);
    return settledAt === undefined || Date.parse(session.updatedAt) > settledAt;
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.stopping || !this.started) return;
    this.pumping = true;
    try {
      if (![...this.runs.values()].some((run) => run.status === 'queued')) return;
      await this.options.refreshSessions();
      for (const run of this.runs.values()) {
        if (this.stopping) break;
        if (this.owned.size + this.bridged.size >= (this.options.maxConcurrent ?? 2)) break;
        if (run.status !== 'queued' || this.admissions.has(run.id)) continue;
        const session = this.getSession(run.sessionId);
        const creating = this.createdSessions.get(run.sessionId)?.runId === run.id;
        try {
          if (!session) throw new RunError('Session no longer exists.', 404);
          if (!creating) this.validateSession(session);
          if (this.isWorking(session) || this.reservedSessions.has(session.id)) {
            const reason = this.waitReason(session);
            if (run.output !== reason) { run.output = reason; this.changed(); }
            continue;
          }
          this.reservedSessions.add(session.id);
          try {
            if (!creating && session.provider === 'codex' && await this.launchBridge(run, session)) continue;
            if (!creating && session.provider === 'codex' && this.getSession(session.id)?.activeProcess) {
              this.reservedSessions.delete(session.id);
              const reason = this.waitReason(session);
              if (run.output !== reason) { run.output = reason; this.changed(); }
              continue;
            }
            await this.launch(run, session, creating);
          }
          catch (error) { this.reservedSessions.delete(session.id); throw error; }
        } catch (error) { this.fail(run, error); }
      }
    } catch (error) {
      // A failed refresh must never allow a write based on stale activity data.
      for (const run of this.runs.values()) if (run.status === 'queued') {
        run.output = `Waiting for session activity to refresh: ${errorMessage(error)}`;
      }
      this.changed();
    } finally { this.pumping = false; }
  }

  private async launchBridge(run: Run, session: Session): Promise<boolean> {
    if (!this.options.openCodexBridge) return false;
    const attachments = await this.attachments.resolve(run.sessionId, run.attachments);
    let started = false;
    const bridge = await this.options.openCodexBridge({
      threadId: session.nativeId, runId: run.id, prompt: attachmentPrompt(run.prompt, attachments),
      ...(run.model ? { model: run.model } : {}),
      ...(attachments.length ? { imagePaths: attachments.filter(item => isImageAttachment(item.metadata.mimeType)).map(item => item.path) } : {}),
      onStarted: () => {
        if (FINISHED.has(run.status)) return;
        started = true;
        run.status = 'running'; run.startedAt = new Date().toISOString(); run.output = '';
        this.changed();
      },
      onOutput: text => { if (!FINISHED.has(run.status)) this.append(run, text); },
      onFinished: result => {
        this.bridged.delete(run.id);
        this.reservedSessions.delete(session.id);
        // A lost shared connection does not prove the native turn stopped.
        if (started && result.status === 'completed') {
          this.settledRuns.add(run.id);
          this.locallySettled.set(session.id, Date.now());
        }
        if (!FINISHED.has(run.status)) {
          run.status = result.status; run.error = result.error; run.finishedAt = new Date().toISOString();
          this.changed();
        }
        if (!this.stopping) void this.options.refreshSessions().catch(() => {}).finally(() => this.pump());
      },
    });
    if (!bridge) return false;
    if (run.status !== 'queued' || this.stopping) {
      bridge.close(); this.reservedSessions.delete(session.id); return true;
    }
    this.bridged.set(run.id, bridge);
    run.output = '열려 있는 Codex 앱의 기존 세션으로 요청을 전달하고 있습니다.';
    this.changed();
    try { await bridge.start(); }
    catch (error) {
      this.bridged.delete(run.id); this.reservedSessions.delete(session.id);
      bridge.close();
      // Once a shared-server submission was attempted, never fall back to a new
      // writer: a lost acknowledgement must not duplicate the user's instruction.
      this.fail(run, error);
    }
    return true;
  }

  private async launch(run: Run, session: Session, creating = false): Promise<void> {
    const executable = await this.executable(session.provider);
    if (!executable) throw new Error(`${session.provider} CLI is no longer available in PATH.`);
    if (!(await stat(session.cwd)).isDirectory()) throw new Error('The session working directory no longer exists.');
    const attachments = await this.attachments.resolve(run.sessionId, run.attachments);
    const images = attachments.filter(item => isImageAttachment(item.metadata.mimeType));
    const args = creating ? buildCreateArgs(session, run.model) : buildResumeArgs(session, run.model);
    if (session.provider === 'claude') {
      if (images.length) args.push('--input-format', 'stream-json');
      for (const directory of new Set(attachments.map(item => dirname(item.path)))) args.push('--add-dir', directory);
    } else for (const image of images) args.push('--image', image.path);
    const prompt = attachmentPrompt(run.prompt, attachments);
    const input = session.provider === 'claude' && images.length ? JSON.stringify({
      type: 'user', session_id: session.nativeId, parent_tool_use_id: null,
      message: { role: 'user', content: [
        { type: 'text', text: prompt },
        ...images.map(item => ({ type: 'image', source: { type: 'base64', media_type: item.metadata.mimeType, data: item.content.toString('base64') } })),
      ] },
    }) + '\n' : prompt;
    // Recheck after asynchronous filesystem discovery, immediately before creating the writer.
    const latest = this.getSession(session.id);
    if (run.status !== 'queued' || this.stopping || (latest && (this.isWorking(latest) || (latest.provider === 'codex' && latest.activeProcess)))) {
      this.reservedSessions.delete(session.id);
      return;
    }
    if (!creating) this.validateSession(latest);
    else if (!latest) throw new RunError('Session no longer exists.', 404);
    const env = { ...process.env, ...this.options.env };
    env.PATH = providerDirectories(env).join(delimiter);
    // The web server may itself have been started from inside Claude Code.
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_SESSION_ID;
    const child = (this.options.spawnProcess ?? spawn)(executable, args, {
      cwd: session.cwd, env, detached: true, stdio: 'pipe', shell: false,
    });
    run.status = 'running';
    run.startedAt = new Date().toISOString();
    run.output = '';
    let finish!: () => void;
    const owned: OwnedProcess = { child, done: new Promise<void>((resolve) => { finish = resolve; }) };
    this.owned.set(run.id, owned);
    let buffer = '';
    let stderr = '';
    let streamError: string | undefined;
    let providerError: string | undefined;
    let sawCompletion = false;
    let sawSessionId = false;
    let sawPartial = false;
    let messageHasPartial = false;
    let identitySaved: Promise<void> = Promise.resolve();
    const parseEventLine = (line: string): void => {
      if (!line.trim()) return;
      let event: Record<string, any>;
      try { event = JSON.parse(line); } catch { this.append(run, line + '\n'); return; }
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Expected a provider event object.');
      const actualId = session.provider === 'codex' && event.type === 'thread.started' ? event.thread_id
        : session.provider === 'claude' && event.type === 'system' && event.subtype === 'init' ? event.session_id : undefined;
      const created = creating ? this.createdSessions.get(session.id) : undefined;
      if (actualId && created && !created.confirmed && typeof actualId === 'string' && UUID.test(actualId)
        && (session.provider === 'codex' || actualId === session.nativeId)) {
        created.confirmed = true;
        created.session.nativeId = actualId;
        created.session.creationPending = false;
        session.nativeId = actualId;
        this.changed();
        identitySaved = this.flush().catch(error => {
          streamError = `Cannot save the new conversation identity: ${errorMessage(error)}`;
          this.stopOwned(run.id, owned);
        });
      }
      if (actualId === session.nativeId) sawSessionId = true;
      if (actualId && actualId !== session.nativeId) {
        streamError = creating ? 'The provider did not confirm the new conversation ID. The task was stopped.' : 'The provider opened a different conversation instead of resuming the requested session. The task was stopped.';
        this.stopOwned(run.id, owned);
        return;
      }
      if (session.provider === 'codex') {
        if (event.type === 'item.completed') {
          if (event.item?.type === 'agent_message') this.append(run, String(event.item.text ?? '') + '\n\n');
          else if (event.item?.type === 'command_execution') this.append(run, `$ ${String(event.item.command ?? '')}\n${String(event.item.aggregated_output ?? '').slice(-4000)}\n`);
          else if (event.item?.type === 'file_change') this.append(run, `Updated ${event.item.changes?.map((change: any) => change.path).join(', ') ?? 'workspace files'}\n`);
        } else if (event.type === 'turn.completed') {
          sawCompletion = true;
        } else if (event.type === 'error' || event.type === 'turn.failed') {
          providerError = String(event.message ?? event.error?.message ?? 'Codex could not complete this turn.');
          if (event.type === 'turn.failed') streamError = providerError;
          this.append(run, providerError + '\n');
        }
      } else {
        if (event.type === 'stream_event') {
          if (event.event?.type === 'message_start') messageHasPartial = false;
          const delta = event.event?.delta;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            this.append(run, delta.text); sawPartial = true; messageHasPartial = true;
          }
          if (event.event?.type === 'message_stop' && messageHasPartial) this.append(run, '\n\n');
        } else if (event.type === 'assistant') {
          for (const block of event.message?.content ?? []) {
            if (block.type === 'text' && !messageHasPartial) this.append(run, String(block.text) + '\n\n');
            if (block.type === 'tool_use') this.append(run, `[${block.name}]\n`);
          }
          messageHasPartial = false;
        } else if (event.type === 'result') {
          sawCompletion = true;
          if (event.is_error) streamError = (event.errors ?? [event.result ?? 'Claude Code could not complete this turn.']).join('\n');
          if (event.permission_denials?.length) {
            const denied = [...new Set(event.permission_denials.map((denial: any) => denial.tool_name ?? 'tool'))].join(', ');
            streamError = `Permission required for: ${denied}. Review permissions in the original CLI and send the instruction again.`;
            this.append(run, `\n${streamError}\n`);
          }
          if (!sawPartial && !run.output && event.result) this.append(run, String(event.result));
        }
      }
    };
    const parseLine = (line: string): void => {
      try { parseEventLine(line); }
      catch {
        streamError = 'The provider emitted an invalid output event. The task was stopped.';
        this.stopOwned(run.id, owned);
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); parseLine(line); }
      if (buffer.length > 2_000_000) { streamError = 'Provider emitted an oversized output event.'; buffer = ''; this.stopOwned(run.id, owned); }
    });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8000); });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') streamError = errorMessage(error); });
    child.on('error', (error: Error) => { streamError = errorMessage(error); });
    child.on('close', async (code: number | null, signal: NodeJS.Signals | null) => {
      if (buffer) parseLine(buffer);
      // A newly bound UUID must be durable before this turn reports success.
      await identitySaved;
      if (owned.killTimer) clearTimeout(owned.killTimer);
      this.owned.delete(run.id);
      this.reservedSessions.delete(session.id);
      const writerConflict = session.provider === 'codex' && !sawSessionId && /already has an active writer|thread-store conflict/i.test(`${stderr}\n${providerError ?? ''}\n${streamError ?? ''}`);
      if (!writerConflict) {
        this.settledRuns.add(run.id);
        this.locallySettled.delete(session.id);
        this.locallySettled.set(session.id, Date.now());
        if (this.locallySettled.size > 1000) this.locallySettled.delete(this.locallySettled.keys().next().value!);
      }
      if (run.status !== 'cancelled') {
        if (writerConflict) streamError = '다른 Codex 프로세스가 이 세션의 쓰기 권한을 보유하고 있습니다. 기존 앱 서버와 연결할 수 없었습니다. 원래 앱에서 이 요청이 실행되지 않았는지 확인한 뒤 다시 보내 주세요.';
        if (!streamError && code === 0 && (!sawCompletion || !sawSessionId)) streamError = providerError ?? 'The provider exited without confirming completion in the requested conversation.';
        if (streamError || code !== 0) this.fail(run, streamError ?? (stderr.trim() || `The provider exited ${signal ? `with signal ${signal}` : `with code ${code ?? 'unknown'}`}.`));
        else { run.status = 'completed'; run.finishedAt = new Date().toISOString(); this.changed(); }
      } else this.changed();
      finish();
      if (!this.stopping) void this.options.refreshSessions().catch(() => {}).finally(() => this.pump());
    });
    child.stdin.end(input);
    this.changed();
  }

  private stopOwned(id: string, owned: OwnedProcess): void {
    const signal = (name: NodeJS.Signals): void => {
      if (this.owned.get(id) !== owned) return;
      try {
        if (owned.child.pid && process.platform !== 'win32') process.kill(-owned.child.pid, name);
        else if (owned.child.exitCode === null) owned.child.kill(name);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH' && owned.child.exitCode === null) owned.child.kill(name); }
    };
    signal('SIGTERM');
    if (!owned.killTimer) {
      owned.killTimer = setTimeout(() => { signal('SIGKILL'); }, 3000);
      owned.killTimer.unref();
    }
  }

  private fail(run: Run, error: unknown): void {
    if (run.status === 'cancelled') return;
    run.status = 'error'; run.error = errorMessage(error); run.finishedAt = new Date().toISOString(); this.changed();
  }

  private append(run: Run, value: string): void {
    run.output = (run.output + value).slice(-MAX_OUTPUT);
    if (!this.notifyTimer) {
      this.notifyTimer = setTimeout(() => { this.notifyTimer = undefined; this.changed(); }, 200);
      this.notifyTimer.unref();
    }
  }

  private changed(): void { this.persist(); this.emit('change'); }

  private prune(): void {
    for (const [id, run] of this.runs) {
      if (this.runs.size <= MAX_RUNS) break;
      if (FINISHED.has(run.status)) { this.runs.delete(id); this.settledRuns.delete(id); }
    }
  }

  private persist(): void {
    const data = JSON.stringify(this.list());
    const created = JSON.stringify([...this.createdSessions.values()]);
    this.writes = this.writes.then(async () => {
      // Write identities first. A crash between commits may leave an orphaned
      // placeholder, which recovery displays as failed and never submits again.
      if (created !== '[]') await writePrivateJson(this.createdFile, created);
      await writePrivateJson(this.stateFile, data);
      this.persistenceError = undefined;
    }).catch((error: Error) => { this.persistenceError = error; });
  }

  private async flush(): Promise<void> {
    await this.writes;
    if (this.persistenceError) throw new RunError(`Cannot save the instruction queue: ${this.persistenceError.message}`, 503);
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function isSavedRun(value: unknown): value is Run {
  if (!value || typeof value !== 'object') return false;
  const run = value as Partial<Run>;
  return typeof run.id === 'string' && typeof run.sessionId === 'string' && typeof run.prompt === 'string'
    && typeof run.createdAt === 'string' && typeof run.output === 'string'
    && (run.model === undefined || validModelId(run.model))
    && (run.attachments === undefined || (Array.isArray(run.attachments) && run.attachments.length <= 10 && run.attachments.every(item => attachmentMetadata(item))))
    && ['queued', 'running', 'completed', 'error', 'cancelled'].includes(run.status ?? '');
}

function isCreatedSession(value: unknown): value is CreatedSession {
  if (!value || typeof value !== 'object') return false;
  const created = value as Partial<CreatedSession>;
  const session = created.session;
  return typeof created.runId === 'string' && typeof created.confirmed === 'boolean' && !!session
    && PROVIDERS.includes(session.provider) && typeof session.id === 'string' && session.id.startsWith(`${session.provider}:`)
    && typeof session.nativeId === 'string' && (!created.confirmed || UUID.test(session.nativeId))
    && typeof session.cwd === 'string' && isAbsolute(session.cwd)
    && typeof session.title === 'string' && typeof session.createdAt === 'string' && typeof session.updatedAt === 'string'
    && typeof session.lastMessage === 'string' && (created.title === undefined || typeof created.title === 'string');
}

async function readPrivateJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 12_000_000) throw new Error('Saved session identities are invalid or too large.');
    await file.chmod(0o600);
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}

async function writePrivateJson(path: string, data: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${createHash('sha256').update(randomUUID()).digest('hex').slice(0, 12)}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(data); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
