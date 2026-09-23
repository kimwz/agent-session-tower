import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import type { CreateSessionRequest, MessageAttachments, Provider, Run, RunApprovalResponse, RunOrigin, Session } from '../../shared/types.js';
import { isImageAttachment } from '../../shared/attachments.js';
import { attachmentMetadata, attachmentPrompt, AttachmentStore } from '../stores/attachments.js';
import { normalizeSessionTitle } from '../stores/session-titles.js';
import type { CodexBridgeRun, CodexBridgeOptions } from './codex-bridge.js';
import { requestedEffort, requestedModel, validModelId } from '../providers/models.js';
import { requestedApprovalsReviewer } from '../providers/approvals.js';
import { SteeringError } from './steering.js';
import { ClaudeControl } from './claude-control.js';
import { openCodexStdioRun, type CodexStdioOptions, type CodexStdioRun } from './codex-stdio.js';
import { claudeInputTokens, contextCapacity, modelContextWindow, nativeContextObservation, withNativeContext } from '../sessions/context.js';
import { defaultStateDir } from '../state-dir.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { findExecutable, providerDirectories, PROVIDERS } from '../providers/discovery.js';
import { isCreatedSession, isSavedRun, UUID, type CreatedSession } from './saved-state.js';
import { buildCreateArgs, buildResumeArgs } from './claude-args.js';
import { NO_RUN_TOOLS, type RunTools } from './session-mcp.js';
import { parseRunOrigin, restoredSessionOrigin, sameOrigin, sessionOriginOf, type SessionOrigin } from './origin.js';

type SpawnProcess = (file: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
interface RunnerOptions {
  /**
   * Resolve trusted tools for the turn a run starts. Tools follow the run's recorded origin and its session;
   * a credential inside them may be bound to the run itself.
   */
  resolveRunTools?: (run: Run, session: Session) => RunTools;
  /** True when a ledger outside the run registry links any of these IDs of one session to external content. */
  isExternallyLinked?: (sessionIds: readonly string[]) => boolean;
  getSession: (id: string) => Session | undefined;
  refreshSessions: () => Promise<void>;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: SpawnProcess;
  findExecutable?: (provider: Provider) => Promise<string | undefined>;
  maxConcurrent?: number;
  pollMs?: number;
  openCodexBridge?: (options: Omit<CodexBridgeOptions, 'codexHome'>) => Promise<CodexBridgeRun | undefined>;
  openCodexStdio?: (options: CodexStdioOptions) => Promise<CodexStdioRun>;
  /** Pre-accepts the native folder trust prompt for a newly created session. */
  trustWorkspace?: (provider: Provider, cwd: string, env: NodeJS.ProcessEnv) => Promise<void>;
  /** Streamed output alone is saved at most this often; state changes are saved at once. */
  outputPersistMs?: number;
}
interface OwnedProcess {
  child: ChildProcessWithoutNullStreams;
  done: Promise<void>;
  killTimer?: ReturnType<typeof setTimeout>;
  claude?: ClaudeControl;
  finishInput?: () => void;
}
/** Internal admission data is never accepted from the public message endpoint. */
export interface RunAdmission {
  autoPromptId?: string;
  validate?: () => void;
  /** Recorded on the run; absent means unknown, which never gains owner privileges. */
  origin?: RunOrigin;
  /** The prompt carries Slack, GitHub or HTTP content. Only a session Tower creates for it may receive it. */
  untrustedInput?: boolean;
  /** No one is watching: Claude runs in its automatic permission mode (Codex uses its auto review reviewer). */
  unattended?: boolean;
  /** Triggers never create a missing folder. */
  createFolder?: boolean;
  /** Pre-answer the native folder trust prompt. Only for folders the owner chose. */
  trustWorkspace?: boolean;
}

const MAX_OUTPUT = 64_000;
const MAX_PROMPT = 32_000;
const MAX_RUNS = 100;
const MAX_QUEUED = 32;
const FINISHED = new Set<Run['status']>(['completed', 'error', 'cancelled']);

export class RunError extends Error {
  constructor(message: string, public readonly statusCode = 400) { super(message); }
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
  private readonly stdio = new Map<string, CodexStdioRun>();
  private readonly reservedSessions = new Set<string>();
  private readonly admissions = new Set<string>();
  private readonly locallySettled = new Map<string, number>();
  private readonly settledRuns = new Set<string>();
  private pollTimer?: ReturnType<typeof setInterval>;
  private notifyTimer?: ReturnType<typeof setTimeout>;
  private outputPersistTimer?: ReturnType<typeof setTimeout>;
  /** The last content each file holds. Updated only inside the write queue, after a successful write. */
  private readonly saved: { runs?: string; created?: string } = {};
  private pumping = false;
  private automationLimit = Infinity;
  private launchGate?: (run: Run) => string | undefined;
  private started = false;
  private stopping = false;
  private writes: Promise<void> = Promise.resolve();
  private persistenceError?: Error;

  constructor(options: RunnerOptions) {
    super();
    this.options = options;
    this.stateFile = join(options.stateDir ?? defaultStateDir(), 'runs.json');
    this.createdFile = join(options.stateDir ?? defaultStateDir(), 'created-sessions.json');
    this.attachments = new AttachmentStore(options.stateDir ?? defaultStateDir());
  }

  /** Slack and trigger work together start at most this many provider turns at once; the rest wait in the queue. */
  setAutomationLimit(limit: number): void { this.automationLimit = limit; void this.pump(); }

  /** Asked right before a queued run starts. A reason means it never starts and ends as cancelled. */
  setLaunchGate(gate: (run: Run) => string | undefined): void { this.launchGate = gate; }

  /** Checked again at the last moment before a provider is started, after every asynchronous step. */
  private refusedAtLaunch(run: Run, session: Session): boolean {
    const reason = run.status === 'queued' ? this.launchGate?.(run) : undefined;
    if (!reason) return false;
    run.status = 'cancelled'; run.error = reason; run.finishedAt = new Date().toISOString();
    this.reservedSessions.delete(session.id);
    this.changed();
    return true;
  }

  setRunToolResolver(resolver: NonNullable<RunnerOptions['resolveRunTools']>): void {
    this.options.resolveRunTools = resolver;
  }

  setExternalLinkResolver(resolver: NonNullable<RunnerOptions['isExternallyLinked']>): void {
    this.options.isExternallyLinked = resolver;
  }

  private runTools(run: Run, session: Session): RunTools {
    return this.options.resolveRunTools?.(run, session) ?? NO_RUN_TOOLS;
  }

  /**
   * Provenance of a session Tower created. Native sessions the owner opened elsewhere return undefined.
   * A ledger link to external content always wins over the stored record.
   */
  sessionOrigin(id: string): SessionOrigin | undefined {
    id = this.monitorSessionId(id);
    const created = this.createdSessions.get(id);
    const linked = this.options.isExternallyLinked?.([id, this.nativeSessionId(id)]) === true;
    if (!created) return linked ? { kind: 'unknown', untrustedInput: true } : undefined;
    if (linked && !created.origin?.untrustedInput) {
      // The mark is permanent: record it so a later ledger cleanup cannot clear it.
      created.origin = { ...(created.origin ?? { kind: 'unknown' as const }), untrustedInput: true };
      this.persist();
    }
    return { ...(created.origin ?? { kind: 'unknown' as const, untrustedInput: true }) };
  }

  /**
   * Fills provenance for sessions created before it was recorded. Only evidence that survives in the
   * run registry or in external ledgers is used; anything undecidable stays unknown and untrusted.
   */
  backfillSessionOrigins(links: { sessionIds: ReadonlySet<string>; requestIds: ReadonlySet<string> }): number {
    let changed = 0;
    for (const [id, created] of this.createdSessions) {
      if (created.origin) continue;
      const initial = this.runs.get(created.runId);
      const aliases = [id, this.nativeSessionId(id)];
      if (aliases.some(alias => links.sessionIds.has(alias)) || (initial?.autoPromptId && links.requestIds.has(initial.autoPromptId))) {
        created.origin = { kind: 'slack', untrustedInput: true };
      } else if (initial) created.origin = { kind: 'owner', untrustedInput: false };
      else created.origin = { kind: 'unknown', untrustedInput: true };
      changed++;
    }
    if (changed) this.persist();
    return changed;
  }

  async start(): Promise<void> {
    if (this.started) return;
    await mkdir(this.options.stateDir ?? defaultStateDir(), { recursive: true, mode: 0o700 });
    await this.attachments.start();
    try {
      const saved = await readPrivateJson(this.createdFile);
      if (!Array.isArray(saved) || saved.some(value => !isCreatedSession(value))) throw new Error('Saved created sessions are invalid.');
      for (const value of saved) {
        const origin = restoredSessionOrigin((value as { origin?: unknown }).origin);
        if (origin) value.origin = origin; else delete value.origin;
        this.createdSessions.set(value.session.id, value);
      }
      this.saved.created = JSON.stringify([...this.createdSessions.values()]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Without any created session, the identities file is never created.
      this.saved.created = '[]';
    }
    try {
      if ((await stat(this.stateFile)).size > 12_000_000) throw new Error('Saved run history is too large.');
      const saved: unknown = JSON.parse(await readFile(this.stateFile, 'utf8'));
      if (!Array.isArray(saved)) throw new Error('Saved run history is invalid.');
      for (const value of saved.slice(-MAX_RUNS)) {
        if (!isSavedRun(value)) continue;
        const run: Run = { ...value, prompt: value.prompt.slice(0, MAX_PROMPT), output: value.output.slice(-MAX_OUTPUT),
          ...(value.attachments ? { attachments: value.attachments.map(item => attachmentMetadata(item)!) } : {}) };
        // A malformed origin never reads back as owner work.
        if (value.origin !== undefined) run.origin = parseRunOrigin(value.origin) ?? { kind: 'unknown' };
        // A permission request belongs to a live process, never a restored run.
        delete run.approvals;
        delete run.canSteer;
        if (run.steering?.state === 'sending') run.steering.state = 'uncertain';
        const context = nativeContextObservation(run.contextUsage);
        if (context) run.contextUsage = context; else delete run.contextUsage;
        if (run.status === 'running' || run.status === 'queued') {
          run.status = run.status === 'running' ? 'error' : 'cancelled';
          run.error = run.steering
            ? 'Agent Session Tower stopped before this inserted instruction finished. It was not resent. Check the conversation before sending again.'
            : 'Agent Session Tower stopped before this task finished. It was not restarted; send the instruction again to continue.';
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

  list(): Run[] { return [...this.runs.values()].map((run) => ({ ...run, canSteer: Boolean(this.steeringTarget(run)), ...(run.steering ? { steering: { ...run.steering } } : {}), ...(run.attachments ? { attachments: run.attachments.map(item => ({ ...item })) } : {}),
    ...(run.contextUsage ? { contextUsage: { ...run.contextUsage } } : {}),
    ...(run.approvals ? { approvals: structuredClone(run.approvals) } : {}) })); }
  async attachment(id: string) {
    const { metadata, content } = await this.attachments.read(id);
    return { metadata, content };
  }
  settledRunIds(): ReadonlySet<string> { return new Set(this.settledRuns); }

  private sessionWithContext(session: Session): Session {
    let latest: Run['contextUsage'];
    for (const run of this.runs.values()) {
      if (run.sessionId === session.id && run.contextUsage && (!latest || run.contextUsage.updatedAt > latest.updatedAt)) latest = run.contextUsage;
    }
    return withNativeContext(session, latest);
  }

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
      if (!native) return undefined;
      return this.sessionWithContext(native.parentId ? { ...native, parentId: this.monitorSessionId(native.parentId) } : native);
    }
    const native = created.confirmed ? this.options.getSession(this.nativeSessionId(id)) : undefined;
    if (native && !created.seenNative) { created.seenNative = true; this.persist(); }
    const initialRun = this.runs.get(created.runId);
    const launchedBy = created.origin?.kind === 'trigger' && created.origin.triggerId ? { launchedBy: { kind: 'trigger' as const, triggerId: created.origin.triggerId } } : {};
    // The folder explicitly chosen at creation remains the project's identity.
    // Native discovery may observe a later working directory or incomplete metadata.
    if (native) return this.sessionWithContext({ ...native, id, cwd: created.session.cwd, project: created.session.project, ...(native.parentId ? { parentId: this.monitorSessionId(native.parentId) } : {}), ...(created.title ? { customTitle: created.title } : {}), ...launchedBy });
    if (created.seenNative && (!initialRun || FINISHED.has(initialRun.status))) return undefined;
    const live = initialRun?.status === 'queued' || initialRun?.status === 'running';
    return {
      ...created.session,
      ...launchedBy,
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
    return [...sessions.values()].map(session => this.sessionWithContext(session.parentId && aliases.has(session.parentId)
      ? { ...session, parentId: aliases.get(session.parentId) } : session));
  }

  async create(input: CreateSessionRequest, internal: RunAdmission = {}): Promise<{ session: Session; run: Run }> {
    this.validateCorrelation(internal.autoPromptId);
    this.validateAdmission(input.prompt, Boolean(input.attachments?.length));
    if (!PROVIDERS.includes(input.provider)) throw new RunError('Claude 또는 Codex를 선택하세요.');
    const model = requestedModel(input.model);
    const effort = requestedEffort(input.effort, input.provider);
    // Only a Codex thread has an approvals reviewer; Claude keeps its own permission flow.
    const approvalsReviewer = input.provider === 'codex' ? requestedApprovalsReviewer(input.codexApprovalsReviewer) : undefined;
    if (typeof input.cwd !== 'string' || input.cwd.includes('\0') || input.cwd.length > 4096) throw new RunError('작업 폴더의 절대 경로를 입력하세요.');
    const cwd = input.cwd === '~' || input.cwd.startsWith('~/') ? join(homedir(), input.cwd.slice(1)) : input.cwd;
    if (!isAbsolute(cwd)) throw new RunError('작업 폴더의 절대 경로를 입력하세요.');
    input = { ...input, cwd };
    const title = input.title === undefined ? '' : normalizeSessionTitle(input.title);
    if (!(await this.executable(input.provider))) throw new RunError(`Install the ${input.provider} CLI and ensure it is in PATH before creating a session.`, 503);
    if (internal.createFolder === false) {
      if (!(await stat(cwd).then(info => info.isDirectory(), () => false))) throw new RunError('The working folder does not exist. It was not created.', 404);
    } else {
      // A folder that does not exist yet is created, like `mkdir -p` before starting the CLI there.
      try { await mkdir(cwd, { recursive: true }); if (!(await stat(cwd)).isDirectory()) throw new Error(); }
      catch { throw new RunError('작업 폴더를 만들 수 없습니다. 경로와 권한을 확인하세요.'); }
    }
    const uuid = randomUUID();
    const id = `${input.provider}:${input.provider === 'codex' ? 'monitor-' : ''}${uuid}`;
    const prepared = await this.attachments.prepare(id, { attachments: input.attachments });
    try {
      this.validateAdmission(input.prompt, prepared.attachments.length > 0);
      this.validateCorrelation(internal.autoPromptId);
      internal.validate?.();
    } catch (error) { await this.attachments.rollback(prepared.createdIds); throw error; }
    const createdAt = new Date().toISOString();
    const session: Session = {
      id, nativeId: input.provider === 'claude' ? uuid : '', provider: input.provider,
      title: input.prompt.trim().replace(/\s+/g, ' ').slice(0, 120) || '첨부 파일 확인', ...(title ? { customTitle: title } : {}), cwd: input.cwd, project: basename(input.cwd) || input.cwd,
      status: 'idle', statusReason: '새 세션을 생성하고 있습니다.', createdAt, updatedAt: createdAt,
      lastRequestAt: createdAt, lastMessage: input.prompt.trim().slice(0, 512), messageCount: 0, isSubagent: false, resumable: false, creationPending: true,
    };
    const origin = internal.origin ?? { kind: 'unknown' as const };
    const run: Run = { id: randomUUID(), sessionId: id, origin, prompt: input.prompt, status: 'queued', createdAt, output: 'Queued — preparing to create this conversation.', ...(model ? { model } : {}), ...(effort ? { effort } : {}),
      ...(internal.unattended ? { unattended: true } : {}),
      ...(approvalsReviewer ? { codexApprovalsReviewer: approvalsReviewer } : {}),
      ...(prepared.attachments.length ? { attachments: prepared.attachments } : {}), ...(internal.autoPromptId ? { autoPromptId: internal.autoPromptId } : {}) };
    // Provenance commits with the session identity, before any provider starts.
    this.createdSessions.set(id, { session, runId: run.id, confirmed: false, ...(title ? { title } : {}), origin: sessionOriginOf(origin, internal.untrustedInput === true) });
    this.runs.set(run.id, run);
    this.admissions.add(run.id);
    this.prune();
    this.changed();
    try {
      // The run is already registered, so a concurrent request with the same ID is refused while this waits.
      // Only an admitted request answers the native trust prompt; a refused one leaves settings untouched.
      if (internal.trustWorkspace !== false) await this.options.trustWorkspace?.(input.provider, cwd, { ...process.env, ...this.options.env }).catch(() => {});
      await this.flush();
    }
    catch (error) {
      // No provider starts until both records commit. Keep failure visible; never
      // leave an unacknowledged request queued for a later polling cycle.
      this.fail(run, error);
      await this.flush().catch(() => {});
      await this.attachments.rollback(prepared.createdIds);
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

  /** External content only enters conversations Tower created and can keep marked. */
  private admitUntrusted(sessionId: string): void {
    if (!this.createdSessions.has(sessionId)) throw new RunError('External trigger content can only continue a conversation Tower created for it.', 409);
  }

  private validateCorrelation(id: string | undefined): void {
    if (id === undefined) return;
    if (!UUID.test(id)) throw new RunError('Invalid Auto Prompt request ID.');
    if ([...this.runs.values()].some(run => run.autoPromptId === id)) throw new RunError('This Auto Prompt already has an execution task.', 409);
  }

  async enqueue(sessionId: string, prompt: string, request: MessageAttachments = {}, internal: RunAdmission = {}): Promise<Run> {
    this.validateCorrelation(internal.autoPromptId);
    sessionId = this.monitorSessionId(sessionId);
    const hasAttachments = Boolean(request.attachments?.length || request.attachmentIds?.length);
    this.validateAdmission(prompt, hasAttachments);
    const session = this.getSession(sessionId);
    this.validateSession(session);
    if (internal.untrustedInput) this.admitUntrusted(sessionId);
    const model = requestedModel(request.model);
    const effort = requestedEffort(request.effort, session.provider);
    if (!(await this.executable(session.provider))) throw new RunError(`Install the ${session.provider} CLI and ensure it is in PATH before sending instructions.`, 503);
    const prepared = await this.attachments.prepare(sessionId, request);
    // File writes yield; recheck admission immediately before inserting the run.
    try { this.validateAdmission(prompt, prepared.attachments.length > 0); this.validateSession(this.getSession(sessionId)); this.validateCorrelation(internal.autoPromptId); internal.validate?.(); }
    catch (error) { await this.attachments.rollback(prepared.createdIds); throw error; }
    if (internal.untrustedInput) {
      // Recorded before the run exists: once external content is queued, the session stays marked.
      const created = this.createdSessions.get(sessionId)!;
      if (!created.origin?.untrustedInput) created.origin = { ...(created.origin ?? { kind: 'unknown' as const }), untrustedInput: true };
    }
    const run: Run = { id: randomUUID(), sessionId, origin: internal.origin ?? { kind: 'unknown' }, prompt, status: 'queued', createdAt: new Date().toISOString(), output: this.waitReason(session),
      ...(internal.unattended ? { unattended: true } : {}),
      ...(model ? { model } : {}), ...(effort ? { effort } : {}),
      ...(internal.autoPromptId ? { autoPromptId: internal.autoPromptId } : {}),
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

  private steeringTarget(run: Run) {
    if (this.stopping || run.status !== 'queued' || run.steering || this.admissions.has(run.id) || this.bridged.has(run.id)) return undefined;
    const target = [...this.runs.values()].find(item => item.sessionId === run.sessionId && item.status === 'running' && !item.steering);
    if (!target || (run.model && run.model !== (target.model ?? this.getSession(run.sessionId)?.model)) || (run.effort && run.effort !== target.effort)) return undefined;
    // An inserted instruction runs with the active turn's tools and approvals. Tools follow origin and
    // session alone, so the same origin in the same session is exactly the same authority.
    if (!sameOrigin(run.origin, target.origin)) return undefined;
    const adapter = this.stdio.get(target.id) ?? this.bridged.get(target.id) ?? this.owned.get(target.id)?.claude;
    return adapter?.canSteer?.() && adapter.steer ? { target, adapter } : undefined;
  }

  async steer(runId: string): Promise<Run> {
    const run = this.runs.get(runId);
    if (!run) throw new RunError('Task not found.', 404);
    if (run.steering) return this.list().find(item => item.id === runId)!;
    const selected = this.steeringTarget(run);
    if (!selected) throw new RunError('This queued instruction cannot be inserted into an active Tower turn.', 409);
    // Reserve synchronously before attachment reads so duplicate clicks cannot submit twice.
    this.admissions.add(run.id);
    let submitted = false;
    try {
      const attachments = await this.attachments.resolve(run.sessionId, run.attachments);
      this.admissions.delete(run.id);
      const current = this.steeringTarget(run);
      this.admissions.add(run.id);
      if (!current || current.target !== selected.target || current.adapter !== selected.adapter) throw new SteeringError('The active turn changed before delivery.', 'rejected');
      run.status = 'running'; run.startedAt = new Date().toISOString(); run.output = '';
      run.steering = { targetRunId: selected.target.id, state: 'sending', requestedAt: run.startedAt };
      this.changed();
      await this.flush();
      if (this.stopping || selected.target.status !== 'running' || !selected.adapter.canSteer?.()) throw new SteeringError('The active turn finished before delivery.', 'rejected');
      const prompt = attachmentPrompt(run.prompt, attachments);
      submitted = true;
      if (selected.adapter instanceof ClaudeControl) {
        await selected.adapter.steer({ type: 'user', uuid: run.id, session_id: this.getSession(run.sessionId)!.nativeId, parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'text', text: prompt }, ...attachments.filter(item => isImageAttachment(item.metadata.mimeType)).map(item => ({
            type: 'image', source: { type: 'base64', media_type: item.metadata.mimeType, data: item.content.toString('base64') },
          }))] } });
      } else await selected.adapter.steer!({ id: run.id, prompt, imagePaths: attachments.filter(item => isImageAttachment(item.metadata.mimeType)).map(item => item.path) });
      run.steering!.state = 'delivered'; run.steering!.deliveredAt = new Date().toISOString();
      this.changed(); await this.flush();
      return this.list().find(item => item.id === runId)!;
    } catch (error) {
      if (!submitted || (error instanceof SteeringError && error.disposition === 'rejected')) {
        if (run.steering) { delete run.steering; delete run.startedAt; run.status = 'queued'; }
      } else {
        run.steering!.state = 'uncertain'; run.status = 'error'; run.finishedAt = new Date().toISOString();
        run.error = `Delivery could not be confirmed. Check the conversation before sending again. ${errorMessage(error)}`;
      }
      this.changed(); await this.flush();
      throw error;
    } finally {
      this.admissions.delete(run.id);
      this.owned.get(selected.target.id)?.finishInput?.();
    }
  }

  async cancel(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new RunError('Task not found.', 404);
    if (FINISHED.has(run.status)) return;
    if (run.steering) throw new RunError('An inserted instruction belongs to the active turn. Stop the active turn instead.', 409);
    const bridge = this.bridged.get(runId);
    if (bridge) {
      // The shared server owns the process. Interrupt only our correlated turn.
      await bridge.cancel();
      await this.flush();
      return;
    }
    const stdio = this.stdio.get(runId);
    if (stdio) {
      await stdio.cancel();
      await this.flush();
      return;
    }
    run.status = 'cancelled';
    run.finishedAt = new Date().toISOString();
    const owned = this.owned.get(runId);
    owned?.claude?.close();
    if (owned) this.stopOwned(runId, owned);
    this.changed();
    await this.flush();
  }

  async respondToApproval(runId: string, approvalId: string, decision: RunApprovalResponse): Promise<Run> {
    const run = this.runs.get(runId);
    if (!run) throw new RunError('Task not found.', 404);
    const owned = this.owned.get(runId);
    const stdio = this.stdio.get(runId);
    if (this.stopping || run.status !== 'running' || (!owned?.claude && !stdio) || !run.approvals?.some(approval => approval.id === approvalId)) {
      throw new RunError('This permission request is no longer pending. Refresh the conversation.', 409);
    }
    if (stdio) await stdio.respondToApproval(approvalId, decision);
    else {
      await owned!.claude!.respond(approvalId, decision);
    }
    return this.list().find(item => item.id === runId)!;
  }

  async close(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.notifyTimer) { clearTimeout(this.notifyTimer); this.notifyTimer = undefined; }
    this.cancelOutputPersist();
    for (const run of this.runs.values()) {
      if ((run.status === 'queued' || run.status === 'running') && !this.bridged.has(run.id) && !this.stdio.has(run.id)) {
        run.status = 'cancelled';
        run.finishedAt = new Date().toISOString();
        run.error = 'Stopped when Agent Session Tower shut down. This task will not restart automatically.';
      }
    }
    const processes = [...this.owned.entries()];
    const bridges = [...this.bridged.entries()];
    const stdio = [...this.stdio.values()];
    for (const [id, owned] of processes) this.stopOwned(id, owned);
    await Promise.all([
      ...processes.map(([, owned]) => owned.done),
      ...stdio.map(async owned => { try { await owned.cancel(); } catch { /* The adapter records unconfirmed cancellation as an error. */ } finally { owned.close(); await owned.done; } }),
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
        // Independent conversations can run immediately. Only callers that
        // explicitly configure a worker limit impose a global queue.
        if (this.options.maxConcurrent !== undefined && this.owned.size + this.bridged.size + this.stdio.size >= this.options.maxConcurrent) break;
        if (run.status !== 'queued' || this.admissions.has(run.id)) continue;
        const refused = this.launchGate?.(run);
        if (refused) {
          run.status = 'cancelled'; run.error = refused; run.finishedAt = new Date().toISOString(); this.changed();
          continue;
        }
        if (automated(run) && [...this.runs.values()].filter(item => item.status === 'running' && automated(item)).length >= this.automationLimit) {
          const reason = 'Waiting: Slack and trigger work is already running at the limit set in Triggers.';
          if (run.output !== reason) { run.output = reason; this.changed(); }
          continue;
        }
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
    // The desktop app owns its tools; only turns that can do without Tower's tools are forwarded.
    const tools = this.runTools(run, session);
    if (tools.required) return false;
    if (!this.options.openCodexBridge) return false;
    const attachments = await this.attachments.resolve(run.sessionId, run.attachments);
    let started = false;
    const bridge = await this.options.openCodexBridge({
      threadId: session.nativeId, runId: run.id, prompt: attachmentPrompt(run.prompt, attachments),
      ...(run.model ? { model: run.model } : {}), ...(run.effort ? { effort: run.effort } : {}),
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
    if (run.status !== 'queued' || this.stopping || this.refusedAtLaunch(run, session)) {
      bridge.close(); this.reservedSessions.delete(session.id); return true;
    }
    this.bridged.set(run.id, bridge);
    // The desktop app runs the turn with its own tools; Tower's cannot be attached there.
    if (tools.towerTools) run.towerTools = tools.servers ? 'desktop-app' : tools.towerTools;
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

  private async launchCodex(run: Run, session: Session, creating: boolean): Promise<void> {
    const executable = await this.executable('codex');
    if (!executable) throw new Error('Codex CLI is no longer available in PATH.');
    if (!(await stat(session.cwd)).isDirectory()) throw new Error('The session working directory no longer exists.');
    const attachments = await this.attachments.resolve(run.sessionId, run.attachments);
    const latest = this.getSession(session.id);
    if (run.status !== 'queued' || this.stopping || (latest && (this.isWorking(latest) || latest.activeProcess))) {
      this.reservedSessions.delete(session.id);
      return;
    }
    if (!creating) this.validateSession(latest);
    else if (!latest) throw new RunError('Session no longer exists.', 404);
    const env = { ...process.env, ...this.options.env };
    env.PATH = providerDirectories(env).join(delimiter);
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_SESSION_ID;
    let started = false;
    let registered = false;
    const tools = this.runTools(run, session);
    const mcpServers = tools.servers;
    if (tools.towerTools) run.towerTools = tools.towerTools;
    const owned = await (this.options.openCodexStdio ?? openCodexStdioRun)({
      executable, cwd: session.cwd, env, spawnProcess: this.options.spawnProcess,
      mcpServers,
      ...(!creating ? { threadId: session.nativeId } : { ...(run.codexApprovalsReviewer ? { approvalsReviewer: run.codexApprovalsReviewer } : {}) }),
      ...(mcpServers?.tower_slack ? { approvalsReviewer: 'auto_review' as const } : {}),
      ...(run.model ? { model: run.model } : {}), ...(run.effort ? { effort: run.effort } : {}),
      prompt: attachmentPrompt(run.prompt, attachments),
      imagePaths: attachments.filter(item => isImageAttachment(item.metadata.mimeType)).map(item => item.path),
      onSession: async id => {
        if (!UUID.test(id) || (!creating && id !== session.nativeId)) throw new Error('Codex returned a different or invalid conversation ID. No message was submitted.');
        if (run.status !== 'running' || this.stopping) throw new Error('The task stopped before a message was submitted.');
        if (creating) {
          const created = this.createdSessions.get(session.id);
          if (!created || (created.confirmed && created.session.nativeId !== id)) throw new Error('The new conversation identity changed. No message was submitted.');
          created.confirmed = true; created.session.nativeId = id; created.session.creationPending = false; session.nativeId = id;
          this.changed();
          try { await this.flush(); }
          catch (error) { throw new Error(`Cannot save the new conversation identity: ${errorMessage(error)}`); }
        }
      },
      onStarted: (_turnId, startedAt) => {
        if (FINISHED.has(run.status)) return;
        started = true; run.startedAt = startedAt ?? new Date().toISOString(); this.changed();
      },
      onOutput: text => { if (!FINISHED.has(run.status)) this.append(run, text); },
      onApproval: approval => { if (run.status === 'running') { run.approvals = [...(run.approvals || []), approval]; this.changed(); } },
      onApprovalCancelled: id => {
        if (!run.approvals?.some(approval => approval.id === id)) return;
        run.approvals = run.approvals.filter(approval => approval.id !== id);
        if (!run.approvals.length) delete run.approvals;
        this.changed();
      },
      // The adapter reports completion only after its native child has closed.
      onFinished: result => {
        if (!registered) return;
        this.stdio.delete(run.id); this.reservedSessions.delete(session.id); delete run.approvals;
        if (started) {
          this.settledRuns.add(run.id); this.locallySettled.delete(session.id); this.locallySettled.set(session.id, Date.now());
          if (this.locallySettled.size > 1000) this.locallySettled.delete(this.locallySettled.keys().next().value!);
        }
        if (!FINISHED.has(run.status)) {
          run.status = result.status; run.error = result.error; run.finishedAt = result.finishedAt ?? new Date().toISOString();
        }
        this.changed();
        if (!this.stopping) void this.options.refreshSessions().catch(() => {}).finally(() => this.pump());
      },
    });
    // Opening an adapter does not spawn. Admission can be cancelled during discovery.
    const current = this.getSession(session.id);
    if (run.status !== 'queued' || this.stopping || (current && (this.isWorking(current) || current.activeProcess)) || this.refusedAtLaunch(run, session)) {
      owned.close(); this.reservedSessions.delete(session.id); return;
    }
    registered = true;
    this.stdio.set(run.id, owned);
    run.status = 'running'; run.output = ''; this.changed();
    // Initialization is independently cancellable and does not block unrelated sessions.
    void owned.start().catch(() => { owned.close(); });
  }

  private async launch(run: Run, session: Session, creating = false): Promise<void> {
    if (session.provider === 'codex') return this.launchCodex(run, session, creating);
    const executable = await this.executable(session.provider);
    if (!executable) throw new Error(`${session.provider} CLI is no longer available in PATH.`);
    if (!(await stat(session.cwd)).isDirectory()) throw new Error('The session working directory no longer exists.');
    const attachments = await this.attachments.resolve(run.sessionId, run.attachments);
    const images = attachments.filter(item => isImageAttachment(item.metadata.mimeType));
    const args = creating ? buildCreateArgs(session, run.model, run.effort) : buildResumeArgs(session, run.model, run.effort);
    const tools = this.runTools(run, session);
    const mcpServers = tools.servers;
    if (tools.towerTools) run.towerTools = tools.towerTools;
    // A capability in a tool server's environment would be visible in the process list as an argument,
    // so such a configuration goes to a private file that lives only as long as the turn.
    if (run.unattended) args.push('--permission-mode', 'auto');
    for (const directory of new Set(attachments.map(item => dirname(item.path)))) args.push('--add-dir', directory);
    const prompt = attachmentPrompt(run.prompt, attachments);
    const input = {
      type: 'user', session_id: session.nativeId, parent_tool_use_id: null,
      message: { role: 'user', content: [
        { type: 'text', text: prompt },
        ...images.map(item => ({ type: 'image', source: { type: 'base64', media_type: item.metadata.mimeType, data: item.content.toString('base64') } })),
      ] },
    };
    // Recheck after asynchronous filesystem discovery, immediately before creating the writer.
    const latest = this.getSession(session.id);
    if (run.status !== 'queued' || this.stopping || (latest && (this.isWorking(latest) || (latest.provider === 'codex' && latest.activeProcess))) || this.refusedAtLaunch(run, session)) {
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
    const privateConfig = mcpServers && Object.values(mcpServers).some(server => server.env) ? await privateMcpConfig(mcpServers) : undefined;
    // Writing the file yielded; nothing may have stopped the run in the meantime.
    if (privateConfig && (run.status !== 'queued' || this.stopping || this.refusedAtLaunch(run, session))) {
      privateConfig.remove(); this.reservedSessions.delete(session.id); return;
    }
    if (mcpServers) args.push('--mcp-config', privateConfig?.path ?? JSON.stringify({ mcpServers }));
    let child: ChildProcessWithoutNullStreams;
    try {
      child = (this.options.spawnProcess ?? spawn)(executable, args, {
        cwd: session.cwd, env, detached: true, stdio: 'pipe', shell: false,
      });
    } catch (error) { privateConfig?.remove(); throw error; }
    if (privateConfig) child.once('close', privateConfig.remove);
    run.status = 'running';
    run.startedAt = new Date().toISOString();
    run.output = '';
    let finish!: () => void;
    const owned: OwnedProcess = { child, done: new Promise<void>((resolve) => { finish = resolve; }) };
    this.owned.set(run.id, owned);
    let buffer = '';
    let stderr = '';
    let streamError: string | undefined;
    let sawCompletion = false;
    let sawSessionId = false;
    let sawPartial = false;
    let messageHasPartial = false;
    let contextInput: { model: string; usedTokens: number } | undefined;
    let identitySaved: Promise<void> = Promise.resolve();
    owned.claude = new ClaudeControl({
      write: message => new Promise<void>((resolve, reject) => {
        if (run.status !== 'running' || child.exitCode !== null || child.stdin.destroyed || child.stdin.writableEnded) { reject(new Error('Provider input is closed.')); return; }
        child.stdin.write(JSON.stringify(message) + '\n', error => error ? reject(error) : resolve());
      }),
      onApproval: approval => { if (run.status === 'running') { run.approvals = [...(run.approvals || []), approval]; this.changed(); } },
      onCancelled: id => {
        if (!run.approvals?.some(approval => approval.id === id)) return;
        run.approvals = run.approvals.filter(approval => approval.id !== id);
        if (!run.approvals.length) delete run.approvals;
        this.changed();
      },
      onError: error => { streamError = error.message; this.stopOwned(run.id, owned); },
    });
    owned.finishInput = () => {
      if (sawCompletion && !owned.claude?.hasPendingSteers()) { owned.claude?.close(); child.stdin.end(); }
    };
    const parseEventLine = (line: string): void => {
      if (!line.trim()) return;
      let event: Record<string, any>;
      try { event = JSON.parse(line); } catch { this.append(run, line + '\n'); return; }
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Expected a provider event object.');
      if (owned.claude?.handle(event)) {
        if (event.type === 'user' && event.isReplay) sawCompletion = false;
        return;
      }
      const actualId = event.type === 'system' && event.subtype === 'init' ? event.session_id : undefined;
      const created = creating ? this.createdSessions.get(session.id) : undefined;
      if (actualId && created && !created.confirmed && typeof actualId === 'string' && UUID.test(actualId)
        && actualId === session.nativeId) {
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
      // Claude reports the mode it actually runs in before doing anything. An unattended run continues only in
      // automatic mode, or in a mode that asks the owner; any other or missing mode is stopped.
      if (actualId && run.unattended && event.permissionMode !== 'auto') {
        if (OWNER_APPROVAL_MODES.has(String(event.permissionMode))) {
          this.append(run, `[Tower] Claude did not start in automatic permission mode (${String(event.permissionMode)}). Approval requests will wait for you in Tower.\n`);
        } else {
          streamError = `Claude started in an unexpected permission mode (${event.permissionMode === undefined ? 'not reported' : String(event.permissionMode)}). The unattended run was stopped before doing anything.`;
          this.stopOwned(run.id, owned);
          return;
        }
      }
      if (actualId && actualId !== session.nativeId) {
        streamError = creating ? 'The provider did not confirm the new conversation ID. The task was stopped.' : 'The provider opened a different conversation instead of resuming the requested session. The task was stopped.';
        this.stopOwned(run.id, owned);
        return;
      }
      const mainContext = event.parent_tool_use_id == null && (event.session_id === undefined || event.session_id === session.nativeId);
      if (mainContext && event.type === 'system' && event.subtype === 'compact_boundary') contextInput = undefined;
      if (mainContext && event.type === 'assistant' && !event.isMeta && !event.is_meta) {
        const model = event.message?.model;
        if (!String(model || '').includes('synthetic')) {
          contextInput = undefined;
          const usedTokens = claudeInputTokens(event.message?.usage);
          if (validModelId(model) && usedTokens !== undefined) contextInput = { model, usedTokens };
        }
      }
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
        const capacity = contextInput && mainContext ? modelContextWindow(event.modelUsage, contextInput.model) : undefined;
        if (contextInput && contextCapacity(capacity) && sawSessionId && !streamError) {
          run.contextUsage = { ...contextInput, contextWindow: capacity, usedPercent: contextInput.usedTokens / capacity * 100,
            updatedAt: new Date().toISOString() };
          this.changed();
        }
        sawCompletion = true;
        owned.finishInput?.();
        if (event.is_error) streamError = (event.errors ?? [event.result ?? 'Claude Code could not complete this turn.']).join('\n');
        // A denied tool call (by the user or the auto mode classifier) is part of a turn that
        // still finished; Claude's own reply explains it. Only a failed turn is reported.
        if (event.is_error && event.permission_denials?.length) {
          const denied = [...new Set(event.permission_denials.map((denial: any) => denial.tool_name ?? 'tool'))].join(', ');
          streamError = `Permission was denied for: ${denied}. The instruction could not complete with the current permissions.`;
          this.append(run, `\n${streamError}\n`);
        }
        if (!sawPartial && !run.output && event.result) this.append(run, String(event.result));
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
      owned.claude?.close();
      // A newly bound UUID must be durable before this turn reports success.
      await identitySaved;
      if (owned.killTimer) clearTimeout(owned.killTimer);
      this.owned.delete(run.id);
      this.reservedSessions.delete(session.id);
      this.settledRuns.add(run.id);
      this.locallySettled.delete(session.id);
      this.locallySettled.set(session.id, Date.now());
      if (this.locallySettled.size > 1000) this.locallySettled.delete(this.locallySettled.keys().next().value!);
      if (run.status !== 'cancelled') {
        if (!streamError && code === 0 && (!sawCompletion || !sawSessionId)) streamError = 'The provider exited without confirming completion in the requested conversation.';
        if (streamError || code !== 0) this.fail(run, streamError ?? (stderr.trim() || `The provider exited ${signal ? `with signal ${signal}` : `with code ${code ?? 'unknown'}`}.`));
        else { run.status = 'completed'; run.finishedAt = new Date().toISOString(); this.changed(); }
      } else this.changed();
      finish();
      if (!this.stopping) void this.options.refreshSessions().catch(() => {}).finally(() => this.pump());
    });
    owned.claude.start(input);
    this.changed();
  }

  private stopOwned(id: string, owned: OwnedProcess): void {
    owned.claude?.close();
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
      this.notifyTimer = setTimeout(() => { this.notifyTimer = undefined; this.outputChanged(); }, 200);
      this.notifyTimer.unref();
    }
  }

  /**
   * Output is shown at once but saved on a slower cadence: a restored in-progress run is marked
   * interrupted anyway, and every state change saves the latest output with it.
   */
  private outputChanged(): void {
    this.emit('change');
    if (this.outputPersistTimer || this.stopping) return;
    this.outputPersistTimer = setTimeout(() => { this.outputPersistTimer = undefined; this.persist(); }, this.options.outputPersistMs ?? 2000);
    this.outputPersistTimer.unref();
  }

  private cancelOutputPersist(): void {
    if (this.outputPersistTimer) clearTimeout(this.outputPersistTimer);
    this.outputPersistTimer = undefined;
  }

  private changed(): void {
    for (const run of this.runs.values()) {
      if (run.status !== 'running' || run.steering?.state !== 'delivered') continue;
      const target = this.runs.get(run.steering.targetRunId);
      if (target && FINISHED.has(target.status)) {
        run.status = target.status; run.finishedAt = target.finishedAt; run.error = target.error;
        this.settledRuns.add(run.id);
      }
    }
    this.persist(); this.emit('change');
  }

  private prune(): void {
    for (const [id, run] of this.runs) {
      if (this.runs.size <= MAX_RUNS) break;
      if (FINISHED.has(run.status)) { this.runs.delete(id); this.settledRuns.delete(id); }
    }
  }

  private persist(): void {
    // This save includes any streamed output that was waiting for its slower cadence.
    this.cancelOutputPersist();
    const data = JSON.stringify(this.list().map(({ approvals: _liveApprovals, canSteer: _liveSteering, ...run }) => run));
    const created = JSON.stringify([...this.createdSessions.values()]);
    this.writes = this.writes.then(async () => {
      // Compare inside the queue: an earlier queued write may still change what a file holds.
      // Write identities first. A crash between commits may leave an orphaned
      // placeholder, which recovery displays as failed and never submits again.
      if (created !== this.saved.created) { await writePrivateJson(this.createdFile, created); this.saved.created = created; }
      if (data !== this.saved.runs) { await writePrivateJson(this.stateFile, data); this.saved.runs = data; }
      this.persistenceError = undefined;
    }).catch((error: Error) => { this.persistenceError = error; });
  }

  /** Waits for every accepted change to reach disk, without stopping or cancelling anything. */
  async flushState(): Promise<void> { this.persist(); await this.flush(); }

  /** True while any provider process, desktop turn or admission is still live, whatever the run status says. */
  busy(): boolean { return this.owned.size + this.bridged.size + this.stdio.size + this.admissions.size + this.reservedSessions.size > 0 || this.pumping; }

  private async flush(): Promise<void> {
    await this.writes;
    if (this.persistenceError) throw new RunError(`Cannot save the instruction queue: ${this.persistenceError.message}`, 503);
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
async function privateMcpConfig(mcpServers: NonNullable<RunTools['servers']>): Promise<{ path: string; remove: () => void }> {
  const directory = await mkdtemp(join(tmpdir(), 'tower-mcp-'));
  const remove = () => { void rm(directory, { recursive: true, force: true }).catch(() => {}); };
  try {
    await chmod(directory, 0o700);
    const path = join(directory, 'config.json');
    await writeFile(path, JSON.stringify({ mcpServers }), { mode: 0o600, flag: 'wx' });
    return { path, remove };
  } catch (error) { remove(); throw error; }
}
/** Work nobody typed into Tower: Slack coordination and delegation, and trigger runs. */
function automated(run: Run): boolean { return run.origin?.kind === 'slack' || run.origin?.kind === 'trigger'; }
/** Modes at least as careful as asking the owner. Anything else is not what an unattended run asked for. */
const OWNER_APPROVAL_MODES = new Set(['default', 'manual', 'plan', 'dontAsk']);
