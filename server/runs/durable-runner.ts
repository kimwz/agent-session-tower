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

interface Options { stateDir: string; workerEntry?: string; startupTimeoutMs?: number; pollMs?: number }

/** A disposable UI connection. Only the independent worker owns provider lifetimes. */
export class DurableRunManager extends EventEmitter {
  private paths?: Awaited<ReturnType<typeof runnerPaths>>;
  private snapshot?: RunnerSnapshot;
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private closed = false;
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
      const entry = this.options.workerEntry ?? fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../index.ts' : '../index.js', import.meta.url));
      const args = isSea() ? ['--runner-worker', this.paths.stateDir] : [...process.execArgv.filter(arg => !/^--inspect(?:-brk|-port|-publish-uid)?(?:=|$)/.test(arg)), entry, '--runner-worker', this.paths.stateDir];
      const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env: process.env });
      let spawnError: Error | undefined;
      child.on('error', error => { spawnError = error; });
      child.unref();
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
    this.timer = setInterval(() => {
      if (this.polling || this.closed) return;
      this.polling = true;
      void this.call('snapshot').catch(() => {}).finally(() => { this.polling = false; });
    }, this.options.pollMs ?? 1000);
    this.timer.unref();
  }

  async close(): Promise<void> { this.closed = true; if (this.timer) clearInterval(this.timer); this.terminals.dispose(); }
  list(): Run[] { return structuredClone(this.snapshot?.runs ?? []); }
  /** The attached worker keeps its own code until it is idle, so it can lag behind the web version. */
  runnerVersion(): string | undefined { return this.snapshot ? this.snapshot.version ?? 'legacy' : undefined; }
  settledRunIds(): ReadonlySet<string> { return new Set(this.snapshot?.settled ?? []); }
  /** The attached worker stays the same for this connection's lifetime, so the answer is stable after start(). */
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
  }
  async create(input: CreateSessionRequest, internal: RunAdmission = {}): Promise<{ session: Session; run: Run }> {
    internal.validate?.();
    this.requireOrigins(internal);
    return this.call('create', [input, { autoPromptId: internal.autoPromptId, ...(internal.origin ? { origin: internal.origin } : {}) }]) as Promise<{ session: Session; run: Run }>;
  }
  async enqueue(id: string, prompt: string, attachments: MessageAttachments = {}, internal: RunAdmission = {}): Promise<Run> {
    internal.validate?.();
    this.requireOrigins(internal);
    return this.call('enqueue', [id, prompt, attachments, { autoPromptId: internal.autoPromptId, ...(internal.origin ? { origin: internal.origin } : {}) }]) as Promise<Run>;
  }
  async steer(id: string): Promise<Run> { return this.call('steer', [id]) as Promise<Run>; }
  async cancel(id: string): Promise<void> { await this.call('cancel', [id]); }
  async respondToApproval(id: string, approvalId: string, decision: RunApprovalResponse): Promise<Run> {
    return this.call('respondToApproval', [id, approvalId, decision]) as Promise<Run>;
  }
  autoPromptList(): AutoPromptJob[] { return structuredClone(this.snapshot?.autoPrompts ?? []); }
  async slackOverview(): Promise<SlackPublicStatus> { return this.call('slackOverview', []) as Promise<SlackPublicStatus>; }
  async slackMutate(action: string, body: Record<string, unknown>): Promise<SlackPublicStatus> { return this.call('slackMutate', [action, body]) as Promise<SlackPublicStatus>; }
  getAutoPrompt(id: string): AutoPromptJob | undefined { return this.autoPromptList().find(job => job.id === id.toLowerCase()); }
  async submitAutoPrompt(input: AutoPromptRequest, internal: Pick<RunAdmission, 'origin'> = {}): Promise<AutoPromptJob> {
    this.requireOrigins(internal);
    return this.call('submitAutoPrompt', [input, ...(internal.origin ? [{ origin: internal.origin }] : [])]) as Promise<AutoPromptJob>;
  }
  async cancelAutoPrompt(id: string): Promise<AutoPromptJob> { return this.call('cancelAutoPrompt', [id]) as Promise<AutoPromptJob>; }
  async sessionHistory(nativeId: string, before?: number, limit?: number): Promise<SessionHistoryPage | undefined> {
    return await this.call('sessionHistory', [nativeId, before, limit]) as SessionHistoryPage | undefined;
  }
  async attachment(id: string): Promise<{ metadata: Attachment; content: Buffer }> {
    const result = await this.call('attachment', [id]) as { metadata: Attachment; content: string };
    return { metadata: result.metadata, content: Buffer.from(result.content, 'base64') };
  }

  private async credential(): Promise<string> {
    if (this.closed || !this.paths) throw Object.assign(new Error('Runner connection is closed.'), { statusCode: 503 });
    const file = await open(this.paths.token, constants.O_RDONLY | constants.O_NOFOLLOW);
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
        res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_RPC_BYTES) res.destroy(new Error('Runner reply is too large.')); else chunks.push(chunk); });
        res.on('error', reject);
        res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as RunnerReply); } catch { reject(new Error('Invalid runner response.')); } });
      });
      req.setTimeout(60_000, () => req.destroy(new Error('Runner response timed out. The request was not retried; check its state before resending.')));
      req.on('error', error => reject(Object.assign(error, { statusCode: 503 })));
      req.end(body);
    });
    if (reply.protocol !== RUNNER_PROTOCOL || reply.stateDir !== this.paths!.stateDir || (this.snapshot && reply.instance !== this.snapshot.instance)) {
      throw Object.assign(new Error('Runner identity changed or is incompatible. Restart Tower to reconnect; requests were not retried.'), { incompatible: true, statusCode: 503 });
    }
    if (reply.snapshot && (!this.snapshot || reply.snapshot.revision >= this.snapshot.revision)) {
      this.snapshot = reply.snapshot;
      this.emit('change');
    }
    if (reply.error) throw Object.assign(new Error(reply.error.message), { statusCode: reply.error.statusCode, ...(reply.error.disposition ? { disposition: reply.error.disposition } : {}) });
    return reply.result;
  }
}
