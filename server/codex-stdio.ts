import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { RunApproval } from '../shared/types.js';
import { requestedModel } from './models.js';

// v2 wire shapes verified with Codex CLI 0.153.4 app-server generate-ts --experimental.
type RequestId = string | number;
type RecordValue = Record<string, any>;
type SpawnProcess = (file: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
export type CodexStdioResult = { status: 'completed' | 'error' | 'cancelled'; error?: string; finishedAt?: string };
export interface CodexStdioOptions {
  executable: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  threadId?: string;
  model?: string;
  prompt: string;
  imagePaths?: readonly string[];
  spawnProcess?: SpawnProcess;
  onSession(id: string): void | Promise<void>;
  onStarted?(turnId: string, startedAt?: string): void;
  onOutput(text: string): void;
  onApproval(approval: RunApproval): void;
  onApprovalCancelled?(id: string): void;
  onFinished(result: CodexStdioResult): void;
}
export interface CodexStdioRun {
  start(): Promise<void>;
  cancel(): Promise<void>;
  close(): void;
  done: Promise<void>;
  respondToApproval(id: string, decision: 'allow' | 'deny'): Promise<void>;
}

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const MAX_FRAME = 2_000_000;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value);
const requestId = (value: unknown): value is RequestId => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
const timestamp = (seconds: unknown): string | undefined => typeof seconds === 'number' && Number.isFinite(seconds) && Math.abs(seconds) < 8_640_000_000_000 ? new Date(seconds * 1000).toISOString() : undefined;
const approvalError = () => Object.assign(new Error('This approval is no longer pending. Refresh the conversation.'), { statusCode: 409 });

/** A dedicated stdio process owns only this run. Never connect it to the desktop daemon. */
export async function openCodexStdioRun(options: CodexStdioOptions): Promise<CodexStdioRun> {
  requestedModel(options.model);
  if (!isAbsolute(options.cwd)) throw new Error('Codex requires an absolute working directory.');
  if (options.threadId !== undefined && !UUID.test(options.threadId)) throw new Error('The native session ID is invalid.');
  return new StdioRun(options);
}

type PendingRpc = { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type PendingApproval = { rpcId: RequestId; method: string; permissions?: RecordValue; denial: 'decline' | 'cancel' };

class StdioRun implements CodexStdioRun {
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private child?: ChildProcessWithoutNullStreams;
  private childClosed = false;
  private result?: CodexStdioResult;
  private notified = false;
  private startPromise?: Promise<void>;
  private cancelPromise?: Promise<void>;
  private cancelRequested = false;
  private submitted = false;
  private threadId?: string;
  private turnId?: string;
  private nextId = 0;
  private buffer = '';
  private stderr = '';
  private killTimer?: ReturnType<typeof setTimeout>;
  private exitTimer?: ReturnType<typeof setTimeout>;
  private cancelTimer?: ReturnType<typeof setTimeout>;
  private pending = new Map<RequestId, PendingRpc>();
  private approvals = new Map<string, PendingApproval>();
  private early: RecordValue[] = [];
  private earlyBytes = 0;
  private items = new Map<string, RecordValue>();
  private streamedText = new Map<string, string>();
  private completedItems = new Set<string>();

  constructor(private readonly options: CodexStdioOptions) {
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
  }

  start(): Promise<void> {
    if (this.result) return Promise.resolve();
    return this.startPromise ||= this.submit().catch(error => {
      this.finish({ status: 'error', error: message(error) });
      throw error;
    });
  }

  private async submit(): Promise<void> {
    // Omitting permission and model overrides preserves user/project configuration.
    this.child = (this.options.spawnProcess ?? spawn)(this.options.executable, ['app-server', '--stdio'], {
      cwd: this.options.cwd, env: this.options.env, detached: true, stdio: 'pipe', shell: false,
    });
    const child = this.child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.read(chunk));
    child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-8000); });
    child.stdin.on('error', error => { if (!this.result) this.finish({ status: 'error', error: this.connectionError(message(error)) }); });
    child.on('error', error => this.finish({ status: 'error', error: this.connectionError(message(error)) }));
    child.on('exit', (code, signal) => {
      // A descendant may keep stdout open after the server exits. Drain any final
      // frames briefly, then reap the owned process group rather than waiting forever.
      if (!this.result) {
        this.exitTimer = setTimeout(() => {
          if (!this.result) this.finish({ status: 'error', error: this.connectionError(this.stderr.trim() || `Codex exited ${signal ? `with signal ${signal}` : `with code ${code ?? 'unknown'}`}.`) });
        }, 100);
        this.exitTimer.unref();
      }
    });
    child.on('close', (code, signal) => {
      this.childClosed = true;
      if (this.buffer.trim() && !this.result) this.read('\n');
      if (!this.result) this.finish({ status: 'error', error: this.connectionError(this.stderr.trim() || `Codex exited ${signal ? `with signal ${signal}` : `with code ${code ?? 'unknown'}`}.`) });
      this.complete();
    });
    await this.request('initialize', { clientInfo: { name: 'agent-session-tower', title: 'Agent Session Tower', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
    if (this.result) return;
    this.write({ method: 'initialized' });
    const resumed = await this.request(this.options.threadId ? 'thread/resume' : 'thread/start', {
      ...(this.options.threadId ? { threadId: this.options.threadId, excludeTurns: true } : { cwd: this.options.cwd }),
      ...(this.options.model ? { model: this.options.model } : {}),
    });
    if (this.result) return;
    const id = resumed?.thread?.id;
    if (typeof id !== 'string' || !UUID.test(id) || (this.options.threadId && id !== this.options.threadId)) {
      throw new Error('Codex returned a different or invalid conversation ID. No message was submitted.');
    }
    if (resumed.thread.status?.type === 'active') throw new Error('This Codex conversation already has an active turn. No message was submitted.');
    this.threadId = id;
    await this.options.onSession(id);
    if (this.result || this.cancelRequested) { if (!this.result) this.finish({ status: 'cancelled' }); return; }
    this.submitted = true;
    const started = await this.request('turn/start', {
      threadId: id,
      input: [{ type: 'text', text: this.options.prompt, text_elements: [] }, ...(this.options.imagePaths || []).map(path => ({ type: 'localImage', path }))],
    });
    if (this.result) return;
    if (typeof started?.turn?.id !== 'string' || !started.turn.id) throw new Error('Codex did not confirm the submitted turn ID. The request was not resent.');
    const turnId: string = started.turn.id;
    this.turnId = turnId;
    this.options.onStarted?.(turnId, timestamp(started.turn.startedAt));
    const early = this.early;
    this.early = []; this.earlyBytes = 0;
    for (const frame of early) { if (this.result) break; this.dispatch(frame); }
    if (!this.result && ['completed', 'failed', 'interrupted'].includes(started.turn.status)) this.finishTurn(started.turn);
  }

  private connectionError(detail: string): string {
    return `${detail}${this.submitted ? ' Codex may have received the request. It was not resent automatically; check the native conversation before retrying.' : ''}`;
  }

  private write(value: object): void {
    if (!this.child || this.childClosed || this.result) throw new Error('The Codex connection is closed.');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }

  private request(method: string, params: object): Promise<any> {
    if (this.result) return Promise.reject(new Error('The Codex connection is closed.'));
    const id = `tower-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.finish({ status: 'error', error: this.connectionError(`Codex did not acknowledge ${method} within 15 seconds.`) });
      }, 15_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  private read(chunk: string): void {
    if (this.result) return;
    this.buffer += chunk;
    let newline: number;
    while (!this.result && (newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (line.length > MAX_FRAME) { this.finish({ status: 'error', error: 'Codex emitted an oversized protocol message.' }); break; }
      try {
        const value = JSON.parse(line);
        if (!record(value)) throw new Error('Invalid protocol frame.');
        this.dispatch(value);
      } catch (error) { this.finish({ status: 'error', error: `Could not read the Codex protocol: ${message(error)}` }); }
    }
    if (this.buffer.length > MAX_FRAME) this.finish({ status: 'error', error: 'Codex emitted an oversized protocol message.' });
  }

  private dispatch(value: RecordValue): void {
    if (this.result) return;
    if (typeof value.method !== 'string') {
      if (!requestId(value.id)) return;
      const pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id); clearTimeout(pending.timer);
      if (value.error) pending.reject(new Error(String(value.error.message || 'Codex request failed.')));
      else if (Object.hasOwn(value, 'result')) pending.resolve(value.result);
      else pending.reject(new Error('Codex sent a response without a result.'));
      return;
    }
    if (!record(value.params)) throw new Error('Codex sent a method without parameters.');
    const params = value.params;
    if (requestId(value.id) && value.method === 'currentTime/read') {
      this.write({ id: value.id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } }); return;
    }
    // Approvals and completion may arrive before the turn/start acknowledgement.
    if (this.submitted && !this.turnId && params.threadId === this.threadId) {
      this.earlyBytes += JSON.stringify(value).length;
      if (this.earlyBytes > MAX_FRAME || this.early.length >= 1000) throw new Error('Codex sent too many events before confirming the turn.');
      this.early.push(value); return;
    }
    if (requestId(value.id)) { this.approval(value.id, value.method, params); return; }
    if (params.threadId !== this.threadId) return;
    if (value.method === 'thread/closed') {
      this.finish({ status: 'error', error: 'The owned Codex conversation closed before confirming completion. This request was not resent.' }); return;
    }
    if (value.method === 'serverRequest/resolved') {
      for (const [id, approval] of this.approvals) if (approval.rpcId === params.requestId) this.clearApproval(id);
      return;
    }
    const turnId = params.turnId || params.turn?.id;
    if (turnId !== this.turnId) return;
    if (value.method === 'item/started' && record(params.item) && typeof params.item.id === 'string') {
      if (this.items.size >= 256 && !this.items.has(params.item.id)) throw new Error('Codex sent too many unfinished items.');
      this.items.set(params.item.id, params.item);
    } else if (value.method === 'item/agentMessage/delta' && typeof params.itemId === 'string' && typeof params.delta === 'string') {
      const streamed = (this.streamedText.get(params.itemId) || '') + params.delta;
      if (streamed.length > MAX_FRAME || this.streamedText.size >= 256 && !this.streamedText.has(params.itemId)) throw new Error('Codex sent too much unfinished message output.');
      this.streamedText.set(params.itemId, streamed);
      this.options.onOutput(params.delta);
    } else if (value.method === 'item/completed' && record(params.item)) this.completeItem(params.item);
    else if (value.method === 'turn/completed' && record(params.turn)) this.finishTurn(params.turn);
  }

  private completeItem(item: RecordValue): void {
    if (typeof item.id !== 'string' || this.completedItems.has(item.id)) return;
    this.completedItems.add(item.id); this.items.delete(item.id);
    if (item.type === 'agentMessage' && typeof item.text === 'string') {
      const streamed = this.streamedText.get(item.id) || '';
      this.options.onOutput((item.text.startsWith(streamed) ? item.text.slice(streamed.length) : `\n${item.text}`) + '\n\n');
      this.streamedText.delete(item.id);
    } else if (item.type === 'commandExecution') this.options.onOutput(`$ ${String(item.command || '')}\n${String(item.aggregatedOutput || '').slice(-4000)}\n`);
    else if (item.type === 'fileChange') this.options.onOutput(`Updated ${Array.isArray(item.changes) ? item.changes.map((change: RecordValue) => String(change.path || '')).join(', ') : 'workspace files'}\n`);
  }

  private finishTurn(turn: RecordValue): void {
    if (Array.isArray(turn.items)) for (const item of turn.items) if (record(item)) this.completeItem(item);
    const finishedAt = timestamp(turn.completedAt);
    if (turn.status === 'completed') this.finish({ status: 'completed', finishedAt });
    else if (turn.status === 'interrupted') this.finish({ status: 'cancelled', finishedAt });
    else if (turn.status === 'failed') this.finish({ status: 'error', error: String(turn.error?.message || 'The Codex task failed.'), finishedAt });
    else this.finish({ status: 'error', error: 'Codex did not confirm a terminal turn status.' });
  }

  private approval(rpcId: RequestId, method: string, params: RecordValue): void {
    if (params.threadId !== this.threadId || params.turnId !== this.turnId || !this.turnId) {
      this.unsupported(rpcId, method, 'The request does not belong to this monitored turn.'); return;
    }
    if (this.approvals.size >= 32 || [...this.approvals.values()].some(item => item.rpcId === rpcId)) throw new Error('Codex sent an invalid or duplicate approval request.');
    let toolName: string;
    let input: RecordValue;
    let permissions: RecordValue | undefined;
    let denial: 'decline' | 'cancel' = 'decline';
    if (method === 'item/commandExecution/requestApproval') {
      if (params.availableDecisions !== undefined && params.availableDecisions !== null) {
        const decisions = params.availableDecisions;
        if (!Array.isArray(decisions) || !decisions.includes('accept') || (!decisions.includes('decline') && !decisions.includes('cancel'))) {
          this.unsupported(rpcId, method, 'This request does not offer both a one-time approval and a supported denial. Use the native app to review it.'); return;
        }
        denial = decisions.includes('decline') ? 'decline' : 'cancel';
      }
      toolName = params.kind === 'writeStdin' ? 'Codex terminal input' : 'Codex command';
      // Subcommand and stdin callbacks may share a parent item. Its command is
      // only an exact fallback for an ordinary command approval.
      const item = (!params.kind || params.kind === 'command') && !params.approvalId ? this.items.get(params.itemId) : undefined;
      const command = params.command ?? (item?.type === 'commandExecution' ? item.command : undefined);
      if (typeof command !== 'string' || !command.trim()) {
        this.unsupported(rpcId, method, 'Codex did not provide the exact command or terminal input for review. Continue in the native app.'); return;
      }
      const details: RecordValue = { ...params, command, cwd: params.cwd ?? item?.cwd };
      input = Object.fromEntries(['command', 'cwd', 'environmentId', 'networkApprovalContext', 'additionalPermissions', 'commandActions', 'kind'].filter(key => details[key] !== undefined && details[key] !== null).map(key => [key, details[key]]));
    } else if (method === 'item/fileChange/requestApproval') {
      toolName = 'Codex file changes';
      const item = this.items.get(params.itemId);
      if (!Array.isArray(item?.changes) || !item.changes.length) {
        this.unsupported(rpcId, method, 'Codex did not provide the file changes for review. Continue in the native app.'); return;
      }
      input = { ...(item?.changes ? { changes: item.changes } : {}), ...(params.grantRoot ? { grantRoot: params.grantRoot } : {}) };
    } else if (method === 'item/permissions/requestApproval') {
      if (!record(params.permissions) || Object.keys(params.permissions).some(key => !['network', 'fileSystem'].includes(key))
        || Object.values(params.permissions).some(value => value !== null && !record(value))) {
        this.unsupported(rpcId, method, 'Codex requested an unsupported permission profile.'); return;
      }
      permissions = Object.fromEntries(Object.entries(params.permissions).filter(([, value]) => value !== null));
      toolName = 'Codex permissions';
      input = { cwd: params.cwd, ...(params.environmentId !== undefined && params.environmentId !== null ? { environmentId: params.environmentId } : {}), permissions, scope: 'turn' };
    } else { this.unsupported(rpcId, method, 'Continue in the native Codex app for this interaction.'); return; }
    const id = randomUUID();
    this.approvals.set(id, { rpcId, method, permissions, denial });
    this.options.onApproval({ id, toolName, input: structuredClone(input), ...(permissions ? { scope: 'turn' as const } : {}), ...(typeof params.reason === 'string' && params.reason ? { description: params.reason } : {}) });
  }

  private unsupported(id: RequestId, method: string, detail: string): void {
    this.write({ id, error: { code: -32601, message: `Agent Session Tower cannot handle ${method}. ${detail}` } });
    this.finish({ status: 'error', error: `Codex requested an unsupported interaction (${method}). ${detail}` });
  }

  async respondToApproval(id: string, decision: 'allow' | 'deny'): Promise<void> {
    if (decision !== 'allow' && decision !== 'deny') throw Object.assign(new Error('Choose allow or deny.'), { statusCode: 400 });
    const approval = this.approvals.get(id);
    if (!approval || this.result) throw approvalError();
    const result = approval.method === 'item/permissions/requestApproval'
      ? { permissions: decision === 'allow' ? approval.permissions : {}, scope: 'turn' }
      : { decision: decision === 'allow' ? 'accept' : approval.denial };
    this.write({ id: approval.rpcId, result });
    this.clearApproval(id);
  }

  private clearApproval(id: string): void {
    if (this.approvals.delete(id)) this.options.onApprovalCancelled?.(id);
  }

  cancel(): Promise<void> {
    if (this.cancelPromise) return this.cancelPromise;
    this.cancelRequested = true;
    return this.cancelPromise = this.cancelTurn();
  }

  private async cancelTurn(): Promise<void> {
    if (!this.result) {
      this.cancelTimer = setTimeout(() => this.finish({ status: 'error', error: 'Could not confirm Codex cancellation. The owned process was stopped; check the native conversation before retrying.' }), 12_000);
      this.cancelTimer.unref();
      if (!this.submitted) this.finish({ status: 'cancelled' });
      else {
        await this.startPromise?.catch(() => {});
        if (!this.result && this.turnId && this.threadId) {
          // Pending approval callbacks must not hold interruption open.
          for (const id of [...this.approvals.keys()]) await this.respondToApproval(id, 'deny');
          await this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(error => this.finish({ status: 'error', error: message(error) }));
        }
      }
    }
    await this.done;
    if (this.result?.status === 'error') throw new Error(this.result.error);
  }

  close(): void {
    this.finish({ status: 'error', error: 'Agent Session Tower closed the owned Codex process. This request was not restarted automatically.' });
  }

  private finish(result: CodexStdioResult): void {
    if (this.result) return;
    this.result = result;
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    if (this.exitTimer) clearTimeout(this.exitTimer);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(result.error || 'The Codex run ended.')); }
    this.pending.clear();
    for (const id of [...this.approvals.keys()]) this.clearApproval(id);
    this.early = []; this.items.clear(); this.streamedText.clear();
    if (!this.child || this.childClosed) { this.complete(); return; }
    this.child.stdin.end();
    this.signal('SIGTERM');
    this.killTimer = setTimeout(() => this.signal('SIGKILL'), 2000);
    this.killTimer.unref();
  }

  private signal(signal: NodeJS.Signals): void {
    if (!this.child || this.childClosed) return;
    try {
      if (this.child.pid && process.platform !== 'win32') process.kill(-this.child.pid, signal);
      else this.child.kill(signal);
    } catch { /* The owned process may already have exited. */ }
  }

  private complete(): void {
    if (!this.result || this.notified) return;
    this.notified = true;
    if (this.killTimer) clearTimeout(this.killTimer);
    if (this.exitTimer) clearTimeout(this.exitTimer);
    try { this.options.onFinished(this.result); }
    finally { this.resolveDone(); }
  }
}
