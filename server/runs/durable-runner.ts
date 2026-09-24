import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { request, type ServerResponse, type ClientRequest } from 'node:http';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';
import type { SlackPublicStatus } from '../../shared/slack.js';
import type { Attachment, AutoPromptJob, AutoPromptRequest, CreateSessionRequest, MessageAttachments, Run, RunApprovalResponse, Session } from '../../shared/types.js';
import type { RunAdmission } from './manager.js';
import type { WorkspaceTerminalBackend } from '../workspace-terminals.js';
import { MAX_RPC_BYTES, RUNNER_PROTOCOL, runnerPaths, type RunnerCapability, type RunnerReply, type RunnerSnapshot, type SessionHistoryPage } from './runner-protocol.js';
import { readHandoff } from './handoff.js';
import type { TriggerOverview } from '../../shared/triggers.js';
import { APP_VERSION } from '../../shared/app-identity.js';
import { newerVersion } from '../link/service.js';

interface Options { stateDir: string; workerEntry?: string; startupTimeoutMs?: number; pollMs?: number; version?: string;
  /** How long a handed-off worker's successor may stay silent before this web starts a worker itself. */
  successorTimeoutMs?: number;
  /** While an update of this computer is being tried, the worker is not handed over to this web's build. */
  handoffHeld?: () => Promise<boolean>;
  /** Meanwhile a worker that has to be started is the previous version's, from this entry point. */
  heldWorkerEntry?: () => Promise<string | undefined>;
  spawn?: (command: { execPath: string; args: string[] }) => void }

/** A disposable UI connection. Only the independent worker owns provider lifetimes. */
export class DurableRunManager extends EventEmitter {
  private paths?: Awaited<ReturnType<typeof runnerPaths>>;
  private snapshot?: RunnerSnapshot;
  private unreachableSince?: number;
  /** Set once a proven handoff's successor stayed silent; retried with backoff until a worker answers. */
  private recovery?: { nextAt: number; delay: number };
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private closed = false;
  /** A handoff this build asks for once the update that started it is kept. */
  private handoffDue = false;
  private terminalStreams = new Set<ClientRequest>();
  readonly terminals: WorkspaceTerminalBackend = {
    create: async (cwd, cols, rows) => this.call('terminalCreate', [cwd, cols, rows]) as Promise<{ id: string }>,
    attach: (id, response, cursor) => this.attachTerminal(id, response, cursor),
    input: async (id, data) => { await this.call('terminalInput', [id, data]); },
    resize: async (id, cols, rows) => { await this.call('terminalResize', [id, cols, rows]); },
    close: async id => { await this.call('terminalClose', [id]); },
    dispose: () => { for (const stream of this.terminalStreams) stream.destroy(); this.terminalStreams.clear(); },
  };
  constructor(private readonly options: Options) { super(); }

  async start(): Promise<void> {
    this.paths = await runnerPaths(this.options.stateDir);
    try { await this.call('snapshot'); }
    catch (error) {
      // A responding but incompatible worker must never be replaced underneath tasks.
      if ((error as { incompatible?: boolean }).incompatible) throw error;
      await this.spawnWorker();
    }
    this.timer = setInterval(() => {
      if (this.polling || this.closed) return;
      this.polling = true;
      void this.poll().finally(() => { this.polling = false; });
    }, this.options.pollMs ?? 1000);
    this.timer.unref();
    if (await this.options.handoffHeld?.().catch(() => false)) this.handoffDue = true;
    else await this.requestHandoff().catch(() => {});
  }

  /** The command for this build's worker; an outdated worker starts it itself when it hands off. */
  private workerCommand() {
    const entry = this.options.workerEntry ?? fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../index.ts' : '../index.js', import.meta.url));
    const args = isSea() ? ['--runner-worker', this.paths!.stateDir] : [...process.execArgv.filter(arg => !/^--inspect(?:-brk|-port|-publish-uid)?(?:=|$)/.test(arg)), entry, '--runner-worker', this.paths!.stateDir];
    return { execPath: process.execPath, args };
  }

  private async spawnWorker(): Promise<void> {
    const held = await this.options.heldWorkerEntry?.().catch(() => undefined);
    const command = held ? { execPath: process.execPath, args: [held, '--runner-worker', this.paths!.stateDir] } : this.workerCommand();
    let spawnError: Error | undefined;
    if (this.options.spawn) this.options.spawn(command);
    else {
      const child = spawn(command.execPath, command.args, { detached: true, stdio: 'ignore', env: process.env });
      child.on('error', error => { spawnError = error; });
      child.unref();
    }
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 60_000);
    for (;;) {
      if (spawnError) throw spawnError;
      try { await this.call('snapshot'); break; }
      catch (retryError) {
        if ((retryError as { incompatible?: boolean }).incompatible || Date.now() >= deadline) throw retryError;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  /**
   * Asks an outdated worker to start this build's worker at its next quiet moment. Running turns,
   * approvals and shells are never interrupted; the worker waits for them to finish on its own.
   */
  async requestHandoff(force = false): Promise<boolean> {
    const own = this.options.version ?? APP_VERSION;
    // A worker newer than this build (left by an update that was then undone) is never handed back to it.
    if (!this.snapshot || !this.supports('handoff') || (!force && (this.snapshot.version === own || newerVersion(this.snapshot.version ?? '', own)))) return false;
    await this.call('requestHandoff', [this.workerCommand()]);
    return true;
  }

  private async poll(): Promise<void> {
    try { await this.call('snapshot'); this.unreachableSince = undefined; this.recovery = undefined; await this.releaseHandoff(); return; }
    catch (error) {
      if ((error as { incompatible?: boolean }).incompatible || (error as { statusCode?: number }).statusCode !== 503) return;
    }
    if (!this.recovery) {
      // A worker that handed off started its successor. If that successor never answers, start one here.
      this.unreachableSince ??= Date.now();
      if (Date.now() - this.unreachableSince < (this.options.successorTimeoutMs ?? 20_000) || !this.snapshot || !(await this.handoffFrom(this.snapshot.instance))) return;
      // From here it is exactly a web restart: start a worker, then attach to whichever worker holds the lock.
      this.recovery = { nextAt: 0, delay: 1000 };
      this.snapshot = undefined;
    }
    const recovery = this.recovery;
    if (Date.now() < recovery.nextAt) return;
    try { await this.spawnWorker(); this.recovery = undefined; this.unreachableSince = undefined; }
    catch { recovery.nextAt = Date.now() + recovery.delay; recovery.delay = Math.min(recovery.delay * 2, 60_000); }
  }

  private async releaseHandoff(): Promise<void> {
    if (!this.handoffDue || await this.options.handoffHeld?.().catch(() => false)) return;
    this.handoffDue = false;
    await this.requestHandoff().catch(() => { this.handoffDue = true; });
  }

  private async handoffFrom(instance: string) {
    const record = await readHandoff(this.paths!.runtime);
    return record?.previous === instance ? record : undefined;
  }

  async close(): Promise<void> { this.closed = true; if (this.timer) clearInterval(this.timer); this.terminals.dispose(); }
  list(): Run[] { return structuredClone(this.snapshot?.runs ?? []); }
  /** The attached worker keeps its own code until it is idle, so it can lag behind the web version. */
  runnerVersion(): string | undefined { return this.snapshot ? this.snapshot.version ?? 'legacy' : undefined; }
  settledRunIds(): ReadonlySet<string> { return new Set(this.snapshot?.settled ?? []); }
  /** Answers for the attached worker; after a proven handoff that is its successor. */
  supports(capability: RunnerCapability): boolean { return this.snapshot?.capabilities?.includes(capability) ?? false; }
  sessionList(): Session[] { return structuredClone(this.snapshot?.sessions ?? []); }
  getSession(id: string): Session | undefined {
    const found = this.snapshot?.sessions.find(session => session.id === id || this.snapshot?.nativeIds[session.id] === id);
    return found && structuredClone(found);
  }
  nativeSessionId(id: string): string { return this.snapshot?.nativeIds[id] ?? id; }
  /**
   * A worker that predates origins drops them and treats every message as the owner's, so
   * work on anyone else's behalf is refused there instead of being admitted as owner work.
   */
  private requireOrigins(internal: Pick<RunAdmission, 'origin'>): void {
    if (internal.origin && internal.origin.kind !== 'owner' && !this.supports('origins')) {
      throw Object.assign(new Error('The execution worker is outdated and cannot keep who started this work. It was not submitted; retry after the worker updates.'), { statusCode: 409 });
    }
    // An older worker would drop the controller and treat remote work as local work, folders excluded from sharing included.
    if (internal.origin?.controllerId && !this.supports('remoteOrigins')) {
      throw Object.assign(new Error('The execution worker on this computer has not updated yet, so it cannot accept remote work. Nothing was submitted.'), { statusCode: 503, disposition: 'not-admitted' });
    }
  }
  /** Coordinator conversations the worker reports; undefined while the attached worker cannot say. */
  coordinators(): ReadonlySet<string> | undefined {
    return this.supports('remoteOrigins') && this.snapshot?.coordinators ? new Set(this.snapshot.coordinators) : undefined;
  }
  async create(input: CreateSessionRequest, internal: RunAdmission = {}): Promise<{ session: Session; run: Run }> {
    internal.validate?.();
    this.requireOrigins(internal);
    return this.call('create', [input, { autoPromptId: internal.autoPromptId, ...(internal.origin ? { origin: internal.origin } : {}), ...(internal.requestId ? { requestId: internal.requestId } : {}) }]) as Promise<{ session: Session; run: Run }>;
  }
  async enqueue(id: string, prompt: string, attachments: MessageAttachments = {}, internal: RunAdmission = {}): Promise<Run> {
    internal.validate?.();
    this.requireOrigins(internal);
    return this.call('enqueue', [id, prompt, attachments, { autoPromptId: internal.autoPromptId, ...(internal.origin ? { origin: internal.origin } : {}), ...(internal.requestId ? { requestId: internal.requestId } : {}) }]) as Promise<Run>;
  }
  async steer(id: string): Promise<Run> { return this.call('steer', [id]) as Promise<Run>; }
  async cancel(id: string): Promise<void> { await this.call('cancel', [id]); }
  async respondToApproval(id: string, approvalId: string, decision: RunApprovalResponse): Promise<Run> {
    return this.call('respondToApproval', [id, approvalId, decision]) as Promise<Run>;
  }
  autoPromptList(): AutoPromptJob[] { return structuredClone(this.snapshot?.autoPrompts ?? []); }
  triggerOverview(): TriggerOverview | undefined { return this.snapshot?.triggers && structuredClone(this.snapshot.triggers); }
  /** Tower operations run in the worker; an outdated worker is told apart from a real error. */
  async api(operation: string, input: unknown, internal?: Pick<RunAdmission, 'origin' | 'requestId'>): Promise<unknown> {
    if (!this.supports('triggers')) throw Object.assign(new Error('The execution worker has not updated yet. Triggers become available once it hands over to the new version.'), { statusCode: 503 });
    if (!internal?.origin?.controllerId) return this.call('api', [operation, input]);
    // An older worker would answer a controlling computer as the owner here, folders kept from sharing included.
    if (!this.supports('remoteTriggers')) throw Object.assign(new Error('The execution worker on this computer has not updated yet, so it cannot take remote requests for this. Nothing was done.'), { statusCode: 503, disposition: 'not-admitted' });
    return this.call('api', [operation, input, { origin: internal.origin, ...(internal.requestId ? { requestId: internal.requestId } : {}) }]);
  }
  async slackOverview(): Promise<SlackPublicStatus> { return this.call('slackOverview', []) as Promise<SlackPublicStatus>; }
  async slackMutate(action: string, body: Record<string, unknown>): Promise<SlackPublicStatus> { return this.call('slackMutate', [action, body]) as Promise<SlackPublicStatus>; }
  getAutoPrompt(id: string): AutoPromptJob | undefined { return this.autoPromptList().find(job => job.id === id.toLowerCase()); }
  async submitAutoPrompt(input: AutoPromptRequest, internal: Pick<RunAdmission, 'origin' | 'requestId'> = {}): Promise<AutoPromptJob> {
    this.requireOrigins(internal);
    const admitted = { ...(internal.origin ? { origin: internal.origin } : {}), ...(internal.requestId ? { requestId: internal.requestId } : {}) };
    return this.call('submitAutoPrompt', [input, ...(Object.keys(admitted).length ? [admitted] : [])]) as Promise<AutoPromptJob>;
  }
  async cancelAutoPrompt(id: string): Promise<AutoPromptJob> { return this.call('cancelAutoPrompt', [id]) as Promise<AutoPromptJob>; }
  async sessionHistory(nativeId: string, before?: number, limit?: number): Promise<SessionHistoryPage | undefined> {
    return await this.call('sessionHistory', [nativeId, before, limit]) as SessionHistoryPage | undefined;
  }
  async attachment(id: string): Promise<{ metadata: Attachment; content: Buffer; sessionId?: string }> {
    const result = await this.call('attachment', [id]) as { metadata: Attachment; content: string; sessionId?: unknown };
    return { metadata: result.metadata, content: Buffer.from(result.content, 'base64'), ...(typeof result.sessionId === 'string' ? { sessionId: result.sessionId } : {}) };
  }

  private async credential(): Promise<string> {
    if (this.closed || !this.paths) throw Object.assign(new Error('Runner connection is closed.'), { statusCode: 503 });
    let file;
    try { file = await open(this.paths.token, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw Object.assign(new Error('The execution worker is not running.'), { statusCode: 503, disposition: 'not-admitted' });
      throw error;
    }
    let token: string;
    try {
      const info = await file.stat();
      if (!info.isFile() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid()) || info.size !== 64) throw new Error('Invalid runner credentials.');
      token = await file.readFile('utf8');
    } finally { await file.close(); }
    return token;
  }

  private async attachTerminal(id: string, response: ServerResponse, cursor?: string): Promise<void> {
    const token = await this.credential();
    if (response.destroyed || response.writableEnded) return;
    await new Promise<void>((resolve, reject) => {
      const req = request({ socketPath: this.paths!.socket, path: `/terminals/${encodeURIComponent(id)}/events`, headers: {
        authorization: `Bearer ${token}`, 'x-runner-instance': this.snapshot!.instance, ...(cursor ? { 'last-event-id': cursor } : {}),
      } }, upstream => {
        if (upstream.statusCode !== 200) {
          upstream.resume(); reject(Object.assign(new Error('터미널에 연결하지 못했습니다.'), { statusCode: upstream.statusCode || 502 })); return;
        }
        if (response.destroyed || response.writableEnded) { upstream.destroy(); resolve(); return; }
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        upstream.on('error', () => response.destroy());
        upstream.pipe(response);
        resolve();
      });
      this.terminalStreams.add(req);
      req.once('close', () => this.terminalStreams.delete(req));
      response.once('close', () => req.destroy());
      req.once('error', error => { if (!response.headersSent) reject(error); else response.destroy(); });
      req.end();
    });
  }

  private async call(method: string, args: unknown[] = []): Promise<unknown> {
    const token = await this.credential();
    const body = JSON.stringify({ protocol: RUNNER_PROTOCOL, method, args, instance: this.snapshot?.instance, revision: this.snapshot?.revision });
    const reply = await new Promise<RunnerReply>((resolve, reject) => {
      const req = request({ socketPath: this.paths!.socket, method: 'POST', path: '/rpc', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
        const chunks: Buffer[] = []; let size = 0;
        // The worker received the request, so a reply lost from here on leaves its outcome unknown.
        const lost = (error: Error) => reject(Object.assign(error, { statusCode: 503, disposition: 'uncertain' }));
        res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_RPC_BYTES) res.destroy(new Error('Runner reply is too large.')); else chunks.push(chunk); });
        res.on('error', lost);
        res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as RunnerReply); } catch { lost(new Error('Invalid runner response.')); } });
      });
      let sent = false;
      req.setTimeout(60_000, () => req.destroy(Object.assign(new Error('Runner response timed out. The request was not retried; check its state before resending.'), { disposition: 'uncertain' })));
      req.on('finish', () => { sent = true; });
      // Before the request left, nothing ran. After it, the worker may have acted.
      req.on('error', error => reject(Object.assign(error, { statusCode: 503, disposition: (error as { disposition?: string }).disposition ?? (sent ? 'uncertain' : 'not-admitted') })));
      req.end(body);
    });
    const incompatible = () => Object.assign(new Error('Runner identity changed or is incompatible. Restart Tower to reconnect; requests were not retried.'), { incompatible: true, statusCode: 503 });
    if (reply.protocol !== RUNNER_PROTOCOL || reply.stateDir !== this.paths!.stateDir) throw incompatible();
    let adopted = false;
    if (this.snapshot && reply.instance !== this.snapshot.instance) {
      // Only the successor that the attached worker recorded and started may replace it.
      const record = await this.handoffFrom(this.snapshot.instance);
      if (!record || !reply.snapshot || reply.snapshot.instance !== reply.instance || reply.snapshot.handoff !== record.successor) throw incompatible();
      this.snapshot = undefined;
      adopted = true;
    }
    if (reply.snapshot && (!this.snapshot || reply.snapshot.revision >= this.snapshot.revision)) {
      this.snapshot = reply.snapshot;
      this.emit('change');
    }
    // The successor refused a request addressed to its predecessor; it never ran.
    if (adopted && reply.error?.statusCode === 409) throw Object.assign(new Error('Tower just updated its execution worker. The request was not submitted; send it again.'), { statusCode: 503, disposition: 'not-admitted' });
    if (reply.error) throw Object.assign(new Error(reply.error.message), { statusCode: reply.error.statusCode, ...(reply.error.disposition ? { disposition: reply.error.disposition } : {}) });
    return reply.result;
  }
}
