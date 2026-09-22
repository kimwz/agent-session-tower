import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { validateApprovalResponse } from '../../shared/approval-interactions.js';
import type { CodexApprovalsReviewer, RunApproval, RunApprovalResponse } from '../../shared/types.js';
import { requestedModel } from '../providers/models.js';
import { SteeringError, type SteeringInput } from './steering.js';
import { APP_NAME, APP_TITLE, APP_VERSION } from '../../shared/app-identity.js';

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
  /** Only a new thread accepts it; Codex stores the choice with the thread itself. */
  approvalsReviewer?: CodexApprovalsReviewer;
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
  canSteer?(): boolean;
  steer?(input: SteeringInput): Promise<void>;
  cancel(): Promise<void>;
  close(): void;
  done: Promise<void>;
  respondToApproval(id: string, decision: RunApprovalResponse): Promise<void>;
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
type PendingApproval = { rpcId: RequestId; method: string; threadId: string; turnId: string; request: RunApproval; permissions?: RecordValue; denial: 'decline' | 'cancel' };
type LiveTurn = { id: string; startedAt?: number; observed: boolean };
type IncomingRequest = { rpcId: RequestId; method: string; params: RecordValue; resolved: boolean };
const scoped = (...parts: (string | number)[]) => JSON.stringify(parts);

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
  private steeringPending = false;
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
  private threads = new Map<string, RecordValue>();
  private liveTurns = new Map<string, LiveTurn>();
  private retiredTurns = new Set<string>();
  private turnVersions = new Map<string, number>();
  private threadReads = new Map<string, Promise<RecordValue>>();
  private incoming = new Map<string, IncomingRequest>();
  private seenRequests = new Set<string>();
  private rootStartedAt?: number;
  private closedThreads = new Set<string>();

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

  canSteer(): boolean {
    return !this.result && !this.cancelRequested && !this.steeringPending && !!this.turnId;
  }

  async steer(input: SteeringInput): Promise<void> {
    if (!this.canSteer()) throw new SteeringError('There is no active owned Codex turn available for steering.', 'rejected');
    const turnId = this.turnId!;
    this.steeringPending = true;
    try {
      const result = await this.request('turn/steer', {
        threadId: this.threadId, expectedTurnId: turnId, clientUserMessageId: input.id,
        input: [{ type: 'text', text: input.prompt, text_elements: [] }, ...(input.imagePaths || []).map(path => ({ type: 'localImage', path }))],
      }, false);
      if (!result || (result as { turnId?: unknown }).turnId !== turnId) throw new SteeringError('Codex did not confirm the expected turn. The message was not resent.', 'uncertain');
    } catch (error) {
      if (error instanceof SteeringError) throw error;
      throw new SteeringError(message(error), (error as { rpcRejected?: boolean })?.rpcRejected ? 'rejected' : 'uncertain');
    } finally { this.steeringPending = false; }
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
    await this.request('initialize', { clientInfo: { name: APP_NAME, title: APP_TITLE, version: APP_VERSION }, capabilities: { experimentalApi: true, requestAttestation: false } });
    if (this.result) return;
    this.write({ method: 'initialized' });
    const resumed = await this.request(this.options.threadId ? 'thread/resume' : 'thread/start', {
      ...(this.options.threadId ? { threadId: this.options.threadId, excludeTurns: true }
        : { cwd: this.options.cwd, ...(this.options.approvalsReviewer ? { approvalsReviewer: this.options.approvalsReviewer } : {}) }),
      ...(this.options.model ? { model: this.options.model } : {}),
    });
    if (this.result) return;
    // Auto approval review is an execution requirement, not a preference. Older
    // providers that ignore it must not receive the user's task under another mode.
    if (!this.options.threadId && this.options.approvalsReviewer === 'auto_review' && resumed?.approvalsReviewer !== 'auto_review') {
      throw new Error('Codex did not confirm Auto approval review. No message was submitted. Update Codex and retry.');
    }
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
    this.rootStartedAt = typeof started.turn.startedAt === 'number' ? started.turn.startedAt : undefined;
    this.liveTurns.set(id, { id: turnId, startedAt: this.rootStartedAt, observed: true });
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

  private request(method: string, params: object, fatal = true): Promise<any> {
    if (this.result) return Promise.reject(new Error('The Codex connection is closed.'));
    const id = `tower-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(this.connectionError(`Codex did not acknowledge ${method} within 15 seconds.`));
        if (fatal) this.finish({ status: 'error', error: error.message });
        else { this.pending.delete(id); reject(error); }
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
      if (value.error) pending.reject(Object.assign(new Error(String(value.error.message || 'Codex request failed.')), { rpcRejected: true }));
      else if (Object.hasOwn(value, 'result')) pending.resolve(value.result);
      else pending.reject(new Error('Codex sent a response without a result.'));
      return;
    }
    if (!record(value.params)) throw new Error('Codex sent a method without parameters.');
    const params = value.params;
    if (requestId(value.id) && value.method === 'currentTime/read') {
      this.write({ id: value.id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } }); return;
    }
    // Include child events: their approval or patch may precede the root acknowledgement.
    if (this.submitted && !this.turnId) {
      this.earlyBytes += JSON.stringify(value).length;
      if (this.earlyBytes > MAX_FRAME || this.early.length >= 1000) throw new Error('Codex sent too many events before confirming the turn.');
      this.early.push(value); return;
    }
    if (requestId(value.id)) { this.receiveApproval(value.id, value.method, params); return; }
    if (value.method === 'thread/started' && record(params.thread)) {
      this.rememberThread(params.thread); return;
    }
    if (typeof params.threadId !== 'string') return;
    const threadId = params.threadId;
    if (value.method === 'serverRequest/resolved') {
      const key = scoped(threadId, typeof params.requestId, params.requestId);
      const incoming = this.incoming.get(key);
      // The native notification has no turnId; an optional one must still match.
      if (incoming && (!params.turnId || params.turnId === incoming.params.turnId)) incoming.resolved = true;
      for (const [id, approval] of this.approvals) {
        if (approval.threadId === threadId && approval.rpcId === params.requestId && (!params.turnId || params.turnId === approval.turnId)) this.clearApproval(id);
      }
      return;
    }
    if (value.method === 'thread/closed') {
      if (threadId === this.threadId) this.finish({ status: 'error', error: 'The owned Codex conversation closed before confirming completion. This request was not resent.' });
      else {
        this.closedThreads.add(threadId);
        this.turnVersions.set(threadId, (this.turnVersions.get(threadId) || 0) + 1);
        for (const request of this.incoming.values()) if (request.params.threadId === threadId) {
          request.resolved = true;
          if (typeof request.params.turnId === 'string') this.retireTurn(threadId, request.params.turnId);
        }
        this.retireTurn(threadId, this.liveTurns.get(threadId)?.id);
      }
      return;
    }
    const turnId = params.turnId || params.turn?.id;
    if (typeof turnId !== 'string' || !turnId) return;
    if (threadId === this.threadId && turnId !== this.turnId) return;
    if (value.method === 'turn/started' && record(params.turn) && threadId !== this.threadId) {
      if (params.turn.status !== 'inProgress' || this.retiredTurns.has(scoped(threadId, turnId))) return;
      if (typeof params.turn.startedAt === 'number' && this.rootStartedAt !== undefined && params.turn.startedAt < this.rootStartedAt) {
        this.retireTurn(threadId, turnId); return;
      }
      this.closedThreads.delete(threadId);
      this.setLiveTurn(threadId, { id: turnId, startedAt: typeof params.turn.startedAt === 'number' ? params.turn.startedAt : undefined, observed: true });
      return;
    }
    if (value.method === 'turn/completed' && record(params.turn)) {
      if (threadId === this.threadId) this.finishTurn(params.turn);
      else this.retireTurn(threadId, turnId);
      return;
    }
    if (this.retiredTurns.has(scoped(threadId, turnId))) return;
    const itemId = params.item?.id || params.itemId;
    const key = scoped(threadId, turnId, itemId);
    if (value.method === 'item/started' && record(params.item) && typeof params.item.id === 'string') {
      // Cache exact identities even when a descendant's metadata has not arrived yet.
      if (this.items.size >= 256 && !this.items.has(key)) throw new Error('Codex sent too many unfinished items.');
      this.items.set(key, params.item);
    } else if (threadId === this.threadId && value.method === 'item/agentMessage/delta' && typeof params.itemId === 'string' && typeof params.delta === 'string') {
      const streamed = (this.streamedText.get(key) || '') + params.delta;
      if (streamed.length > MAX_FRAME || this.streamedText.size >= 256 && !this.streamedText.has(key)) throw new Error('Codex sent too much unfinished message output.');
      this.streamedText.set(key, streamed);
      this.options.onOutput(params.delta);
    } else if (value.method === 'item/completed' && record(params.item)) {
      if (threadId === this.threadId) this.completeItem(params.item);
      else this.items.delete(key);
    }
  }

  private rememberThread(thread: RecordValue): void {
    if (typeof thread.id !== 'string' || !UUID.test(thread.id)) return;
    if (this.threads.size >= 256 && !this.threads.has(thread.id)) throw new Error('Codex sent too many thread identities.');
    const prior = this.threads.get(thread.id);
    if (prior && prior.parentThreadId !== thread.parentThreadId) throw new Error('Codex changed a thread parent identity.');
    this.threads.set(thread.id, thread);
  }

  private setLiveTurn(threadId: string, turn: LiveTurn): void {
    if (this.liveTurns.size >= 256 && !this.liveTurns.has(threadId)) throw new Error('Codex sent too many active child turns.');
    const prior = this.liveTurns.get(threadId);
    if (prior && prior.id !== turn.id) this.retireTurn(threadId, prior.id);
    this.liveTurns.set(threadId, turn);
    this.turnVersions.set(threadId, (this.turnVersions.get(threadId) || 0) + 1);
  }

  private retireTurn(threadId: string, turnId?: string): void {
    if (!turnId) return;
    this.retiredTurns.add(scoped(threadId, turnId));
    this.turnVersions.set(threadId, (this.turnVersions.get(threadId) || 0) + 1);
    if (this.liveTurns.get(threadId)?.id === turnId) this.liveTurns.delete(threadId);
    for (const [id, approval] of this.approvals) if (approval.threadId === threadId && approval.turnId === turnId) this.clearApproval(id);
    for (const key of this.items.keys()) {
      const [thread, turn] = JSON.parse(key);
      if (thread === threadId && turn === turnId) this.items.delete(key);
    }
  }

  private async readThread(threadId: string, includeTurns: boolean): Promise<RecordValue> {
    const version = this.turnVersions.get(threadId) || 0;
    const wasClosed = this.closedThreads.has(threadId);
    const key = scoped(threadId, String(includeTurns), version);
    const prior = this.threadReads.get(key);
    if (prior) return prior;
    const reading = this.request('thread/read', { threadId, includeTurns: false }, false).then(async result => {
      if (this.result) throw approvalError();
      if (!record(result?.thread) || result.thread.id !== threadId) throw new Error('Codex returned a different child identity.');
      this.rememberThread(result.thread);
      if (includeTurns && version === (this.turnVersions.get(threadId) || 0)) {
        // Read only the latest summary; reused agents can have very large histories.
        const page = await this.request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'summary' }, false);
        if (this.result) throw approvalError();
        const turn = Array.isArray(page?.data) && page.data.length === 1 ? page.data[0] : undefined;
        const reopened = !wasClosed || result.thread.status?.type === 'active' && record(turn) && typeof turn.startedAt === 'number' && this.rootStartedAt !== undefined && turn.startedAt >= this.rootStartedAt;
        if (reopened && version === (this.turnVersions.get(threadId) || 0) && record(turn) && turn.status === 'inProgress' && typeof turn.id === 'string' && !this.retiredTurns.has(scoped(threadId, turn.id))) {
          this.closedThreads.delete(threadId);
          this.setLiveTurn(threadId, { id: turn.id, startedAt: typeof turn.startedAt === 'number' ? turn.startedAt : undefined, observed: false });
        }
      }
      return result.thread;
    }).finally(() => this.threadReads.delete(key));
    this.threadReads.set(key, reading);
    return reading;
  }

  private async ownedTurn(threadId: string, requestedTurn: unknown): Promise<string | undefined> {
    if (!this.turnId || this.result || this.cancelRequested || !UUID.test(threadId)) return;
    if (threadId === this.threadId) return requestedTurn === null || requestedTurn === this.turnId ? this.turnId : undefined;
    let current = threadId;
    const visited = new Set<string>();
    for (let depth = 0; current !== this.threadId; depth++) {
      if (depth >= 32 || visited.has(current) || !UUID.test(current)) return;
      visited.add(current);
      let thread = this.threads.get(current);
      const needsTurn = current === threadId && (!this.liveTurns.has(threadId) || this.closedThreads.has(threadId));
      if (!thread || needsTurn) thread = await this.readThread(current, needsTurn);
      if (this.result || typeof thread.parentThreadId !== 'string') return;
      current = thread.parentThreadId;
    }
    const turn = this.liveTurns.get(threadId);
    if (this.closedThreads.has(threadId)) return;
    if (!turn || this.retiredTurns.has(scoped(threadId, turn.id)) || requestedTurn !== null && requestedTurn !== turn.id) return;
    if (turn.startedAt !== undefined && this.rootStartedAt !== undefined) {
      if (turn.startedAt < this.rootStartedAt) return;
    } else if (!turn.observed) return;
    return turn.id;
  }

  private receiveApproval(rpcId: RequestId, method: string, params: RecordValue): void {
    const key = scoped(String(params.threadId), typeof rpcId, rpcId);
    if (this.seenRequests.has(key) || this.incoming.size >= 32 || this.seenRequests.size >= 4096) {
      this.rejectRequest(rpcId, method, 'Duplicate or excessive interaction request.'); return;
    }
    const incoming = { rpcId, method, params, resolved: false };
    this.incoming.set(key, incoming); this.seenRequests.add(key);
    void this.prepareApproval(incoming).catch(error => {
      if (!this.result && !incoming.resolved) this.rejectRequest(rpcId, method, message(error));
    }).finally(() => this.incoming.delete(key));
  }

  private async prepareApproval(incoming: IncomingRequest): Promise<void> {
    const { rpcId, method, params } = incoming;
    const requestedTurn = method === 'mcpServer/elicitation/request' && params.turnId === null ? null : params.turnId;
    if (requestedTurn !== null ? typeof requestedTurn !== 'string' || !requestedTurn : method !== 'mcpServer/elicitation/request') {
      this.rejectRequest(rpcId, method, 'The request has no valid turn identity.'); return;
    }
    const turnId = typeof params.threadId === 'string' ? await this.ownedTurn(params.threadId, requestedTurn) : undefined;
    if (this.result || incoming.resolved) return;
    if (!turnId || this.cancelRequested || this.liveTurns.get(params.threadId)?.id !== turnId) {
      this.rejectRequest(rpcId, method, 'The request does not belong to a live turn owned by this run.'); return;
    }
    if (method === 'item/fileChange/requestApproval' && params.threadId !== this.threadId && !this.items.has(scoped(params.threadId, turnId, params.itemId))) {
      // A resumed child may already be waiting on an item whose start was not replayed.
      let cursor: string | undefined;
      for (let page = 0; page < 4; page++) {
        const result = await this.request('thread/items/list', { threadId: params.threadId, turnId, limit: 32, sortDirection: 'desc', ...(cursor ? { cursor } : {}) }, false);
        if (this.result || incoming.resolved || this.cancelRequested || this.liveTurns.get(params.threadId)?.id !== turnId) return;
        const entry = Array.isArray(result?.data) ? result.data.find((entry: RecordValue) => entry.turnId === turnId && entry.item?.id === params.itemId) : undefined;
        if (record(entry?.item)) { this.items.set(scoped(params.threadId, turnId, params.itemId), entry.item); break; }
        if (typeof result?.nextCursor !== 'string' || !result.nextCursor) break;
        cursor = result.nextCursor;
      }
    }
    this.approval(rpcId, method, params, turnId);
  }

  private rejectRequest(id: RequestId, method: string, detail: string): void {
    this.write({ id, error: { code: -32602, message: `Agent Session Tower cannot handle ${method}. ${detail}` } });
  }

  private completeItem(item: RecordValue): void {
    const key = scoped(this.threadId!, this.turnId!, item.id);
    if (typeof item.id !== 'string' || this.completedItems.has(key)) return;
    this.completedItems.add(key); this.items.delete(key);
    if (item.type === 'agentMessage' && typeof item.text === 'string') {
      const streamed = this.streamedText.get(key) || '';
      this.options.onOutput((item.text.startsWith(streamed) ? item.text.slice(streamed.length) : `\n${item.text}`) + '\n\n');
      this.streamedText.delete(key);
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

  private approval(rpcId: RequestId, method: string, params: RecordValue, turnId: string): void {
    if (this.approvals.size >= 32 || [...this.approvals.values()].some(item => item.threadId === params.threadId && item.rpcId === rpcId)) throw new Error('Codex sent an invalid or duplicate approval request.');
    let toolName: string;
    let input: RecordValue;
    let permissions: RecordValue | undefined;
    let interaction: RunApproval['interaction'];
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
      const item = (!params.kind || params.kind === 'command') && !params.approvalId ? this.items.get(scoped(params.threadId, turnId, params.itemId)) : undefined;
      const command = params.command ?? (item?.type === 'commandExecution' ? item.command : undefined);
      const network = params.networkApprovalContext;
      const managedNetwork = (!params.kind || params.kind === 'command') && record(network) && typeof network.host === 'string' && !!network.host.trim() && ['http', 'https', 'socks5Tcp', 'socks5Udp'].includes(network.protocol);
      if ((typeof command !== 'string' || !command.trim()) && !managedNetwork) {
        this.unsupported(rpcId, method, 'Codex did not provide the exact command or terminal input for review. Continue in the native app.'); return;
      }
      if (managedNetwork && (typeof command !== 'string' || !command.trim())) toolName = 'Codex network access';
      const details: RecordValue = { ...params, command, cwd: params.cwd ?? item?.cwd };
      input = Object.fromEntries(['command', 'cwd', 'environmentId', 'networkApprovalContext', 'additionalPermissions', 'commandActions', 'kind'].filter(key => details[key] !== undefined && details[key] !== null).map(key => [key, details[key]]));
    } else if (method === 'item/fileChange/requestApproval') {
      toolName = 'Codex file changes';
      const item = this.items.get(scoped(params.threadId, turnId, params.itemId));
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
    } else if (method === 'item/tool/requestUserInput') {
      const questions = params.questions;
      if (!Array.isArray(questions) || !questions.length || questions.length > 32 || new Set(questions.map(question => question?.id)).size !== questions.length || questions.some(question => !record(question) || typeof question.id !== 'string' || !question.id || typeof question.header !== 'string' || typeof question.question !== 'string' || typeof question.isOther !== 'boolean' || typeof question.isSecret !== 'boolean' || !(question.options === null || Array.isArray(question.options) && question.options.every((option: unknown) => record(option) && typeof option.label === 'string' && typeof option.description === 'string')))) {
        this.unsupported(rpcId, method, 'Codex sent invalid questions.'); return;
      }
      toolName = 'Codex questions'; input = {};
      interaction = { type: 'questions', questions };
    } else if (method === 'mcpServer/elicitation/request') {
      if (typeof params.serverName !== 'string' || !params.serverName || typeof params.message !== 'string') {
        this.unsupported(rpcId, method, 'Codex sent an invalid MCP interaction.'); return;
      }
      toolName = `MCP: ${params.serverName}`; input = {};
      if (['form', 'openai/form', 'openaiForm'].includes(params.mode) && record(params.requestedSchema)) interaction = { type: 'mcp-form', schema: params.requestedSchema, serverName: params.serverName };
      else if (params.mode === 'url' && typeof params.url === 'string') {
        try { if (!['https:', 'http:'].includes(new URL(params.url).protocol)) throw new Error(); }
        catch { this.unsupported(rpcId, method, 'MCP supplied an unsupported URL.'); return; }
        interaction = { type: 'mcp-url', url: params.url, serverName: params.serverName };
      } else { this.unsupported(rpcId, method, 'Unsupported MCP elicitation mode.'); return; }
    } else { this.unsupported(rpcId, method, 'Continue in the native Codex app for this interaction.'); return; }
    const id = randomUUID();
    const description = method === 'mcpServer/elicitation/request' ? params.message : params.reason;
    const agentName = this.threads.get(params.threadId)?.agentNickname;
    const request: RunApproval = structuredClone({ id, toolName, input, ...(params.threadId !== this.threadId ? { origin: { threadId: params.threadId, turnId, ...(typeof agentName === 'string' && agentName ? { agentName } : {}) } } : {}), ...(interaction ? { interaction } : {}), ...(permissions ? { scope: 'turn' as const } : {}), ...(typeof description === 'string' && description ? { description } : {}) });
    this.approvals.set(id, { rpcId, method, threadId: params.threadId, turnId, request, permissions, denial });
    this.options.onApproval(structuredClone(request));
  }

  private unsupported(id: RequestId, method: string, detail: string): void {
    this.write({ id, error: { code: -32601, message: `Agent Session Tower cannot handle ${method}. ${detail}` } });
    // Unsupported child interactions must not tear down a valid parent turn.
    const request = [...this.incoming.values()].find(request => request.rpcId === id);
    if (request?.params.threadId === this.threadId) this.finish({ status: 'error', error: `Codex requested an unsupported interaction (${method}). ${detail}` });
  }

  async respondToApproval(id: string, response: RunApprovalResponse): Promise<void> {
    const approval = this.approvals.get(id);
    if (!approval || this.result || (this.cancelRequested && response !== 'deny') || this.liveTurns.get(approval.threadId)?.id !== approval.turnId) throw approvalError();
    const decision = validateApprovalResponse(approval.request, response);
    let result: RecordValue;
    if (approval.request.interaction?.type === 'questions') result = decision === 'deny' ? { answers: {} } : decision as RecordValue;
    else if (approval.request.interaction) result = { ...(decision === 'deny' ? { action: 'decline', content: null } : decision as RecordValue), _meta: null };
    else result = approval.method === 'item/permissions/requestApproval'
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
          for (const id of [...this.approvals.keys()]) {
            if (this.result) break;
            // A previous denial can resolve another child's pending callback.
            if (this.approvals.has(id)) await this.respondToApproval(id, 'deny');
          }
          if (!this.result) await this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(error => this.finish({ status: 'error', error: message(error) }));
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
    this.early = []; this.items.clear(); this.streamedText.clear(); this.liveTurns.clear(); this.incoming.clear();
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
