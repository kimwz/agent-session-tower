import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import { requestedModel } from './models.js';
import { SteeringError, type SteeringInput } from './steering.js';
import { APP_TITLE, APP_VERSION, LEGACY_APP_NAME } from '../shared/app-identity.js';

type Result = { status: 'completed' | 'error' | 'cancelled'; error?: string };
type Item = { id: string; type: string; clientId?: string | null; text?: string; command?: string; aggregatedOutput?: string; changes?: { path: string }[] };
type Turn = { id: string; status: 'completed' | 'interrupted' | 'failed' | 'inProgress'; items?: Item[]; error?: { message?: string } | null };
type Notice = { method: string; params: { threadId?: string; turnId?: string; itemId?: string; delta?: string; item?: Item; turn?: Turn } };
type Page<T> = { data: T[]; nextCursor?: string | null };

export interface CodexBridgeOptions {
  codexHome: string;
  threadId: string;
  runId: string;
  prompt: string;
  imagePaths?: readonly string[];
  model?: string;
  onStarted(turnId: string): void;
  onOutput(text: string): void;
  onFinished(result: Result): void;
}
export interface CodexBridgeRun {
  start(): Promise<void>;
  canSteer?(): boolean;
  steer?(input: SteeringInput): Promise<void>;
  cancel(): Promise<void>;
  close(): void;
  done: Promise<void>;
}

const connectionLost = () => new Error('Codex 데스크톱 연결이 끊겼습니다. 요청이 대기 중이거나 실행 중일 수 있어 자동으로 다시 보내지 않았습니다. 원래 앱에서 확인하세요.');
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

class Rpc {
  private nextId = 0;
  private stopped = false;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  onNotice?: (notice: Notice) => void;
  onLost?: (error: Error) => void;

  constructor(private readonly socket: WebSocket) {
    socket.on('message', data => {
      let value;
      try { value = JSON.parse(data.toString()); }
      catch { this.fail(new Error('Codex 데스크톱이 올바르지 않은 응답을 보냈습니다.')); return; }
      if (!value || typeof value !== 'object') { this.fail(new Error('Codex 데스크톱 응답 형식이 올바르지 않습니다.')); return; }
      if (typeof value.method === 'string') {
        // Server requests (including approvals) remain owned by the existing app.
        if (value.id === undefined && value.params && typeof value.params === 'object') this.onNotice?.(value);
        return;
      }
      const request = this.pending.get(value.id);
      if (!request) return;
      this.pending.delete(value.id); clearTimeout(request.timer);
      if (value.error) request.reject(Object.assign(new Error(String(value.error.message || 'Codex request failed.')), { rpcRejected: true }));
      else if ('result' in value) request.resolve(value.result);
      else request.reject(new Error('Codex 데스크톱 응답에 결과가 없습니다.'));
    });
    socket.on('error', () => this.fail(connectionLost()));
    socket.on('close', () => this.fail(connectionLost()));
  }

  request<T>(method: string, params: object, fatal = true): Promise<T> {
    if (this.stopped || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(connectionLost());
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`Codex ${method} 응답을 확인하지 못했습니다. 요청을 다시 보내지 않았습니다. 원래 앱에서 확인하세요.`);
        if (fatal) this.fail(error);
        else { this.pending.delete(id); reject(error); }
      }, 15_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), error => { if (error) this.fail(connectionLost()); });
    });
  }

  initialized(): void { this.socket.send(JSON.stringify({ method: 'initialized' })); }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(connectionLost()); }
    this.pending.clear();
    this.socket.terminate();
  }

  private fail(error: Error): void {
    if (this.stopped) return;
    const lost = this.onLost;
    this.close();
    lost?.(error);
  }
}

async function loaded(rpc: Rpc, threadId: string): Promise<boolean> {
  let cursor: string | undefined;
  const cursors = new Set<string>();
  do {
    const page = await rpc.request<Page<string>>('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page.data)) throw new Error('Codex의 실행 중인 세션 목록을 확인하지 못했습니다.');
    if (page.data.includes(threadId)) return true;
    cursor = page.nextCursor || undefined;
    if (cursor && cursors.has(cursor)) throw new Error('Codex의 세션 목록 페이지가 반복되었습니다.');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return false;
}

/** Attach only to a thread already loaded by the existing desktop daemon. */
export async function openCodexBridgeRun(options: CodexBridgeOptions): Promise<CodexBridgeRun | undefined> {
  requestedModel(options.model);
  const path = join(options.codexHome, 'app-server-control', 'app-server-control.sock');
  try { if (!(await stat(path)).isSocket()) throw new Error('Codex control socket 경로가 소켓이 아닙니다.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  // ws supports WebSocket-over-Unix directly; raw JSONL is not this transport.
  const socket = new WebSocket(`ws+unix://${path}:/`, { perMessageDeflate: false, handshakeTimeout: 3000, maxPayload: 16 * 1024 * 1024 });
  const rpc = new Rpc(socket);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
      socket.once('close', () => reject(connectionLost()));
    });
    await rpc.request('initialize', { clientInfo: { name: LEGACY_APP_NAME, title: APP_TITLE, version: APP_VERSION }, capabilities: { experimentalApi: true, requestAttestation: false } });
    rpc.initialized();
    if (!await loaded(rpc, options.threadId)) { rpc.close(); return undefined; }
    return new BridgeRun(rpc, options);
  } catch (error) {
    rpc.close();
    if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') return undefined;
    throw error;
  }
}

class BridgeRun implements CodexBridgeRun {
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private readonly turnKnown: Promise<void>;
  private resolveTurnKnown!: () => void;
  private settled = false;
  private result?: Result;
  private startPromise?: Promise<void>;
  private cancelPromise?: Promise<void>;
  private cancelRequested = false;
  private steeringPending = false;
  private submitted = false;
  private queueId?: string;
  private turnId?: string;
  private reconciling = false;
  private timer?: ReturnType<typeof setTimeout>;
  private missingSince?: number;
  private previousTurnIds = new Set<string>();
  private early = new Map<string, { events: Notice[]; size: number }>();
  private output = new Map<string, string>();
  private completedItems = new Set<string>();

  constructor(private readonly rpc: Rpc, private readonly options: CodexBridgeOptions) {
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
    this.turnKnown = new Promise(resolve => { this.resolveTurnKnown = resolve; });
    rpc.onNotice = notice => this.notice(notice);
    rpc.onLost = error => this.finish({ status: 'error', error: message(error) });
  }

  start(): Promise<void> {
    if (this.settled) return Promise.resolve();
    return this.startPromise ||= this.submit().catch(error => {
      if (this.settled) return;
      this.finish({ status: 'error', error: message(error) });
      throw error;
    });
  }

  canSteer(): boolean {
    return !this.settled && !this.cancelRequested && !this.steeringPending && !!this.turnId;
  }

  async steer(input: SteeringInput): Promise<void> {
    if (!this.canSteer()) throw new SteeringError('There is no active owned Codex turn available for steering.', 'rejected');
    const turnId = this.turnId!;
    this.steeringPending = true;
    try {
      const result = await this.rpc.request('turn/steer', {
        threadId: this.options.threadId, expectedTurnId: turnId, clientUserMessageId: input.id,
        input: [{ type: 'text', text: input.prompt, text_elements: [] }, ...(input.imagePaths || []).map(path => ({ type: 'localImage', path }))],
      }, false);
      if (!result || (result as { turnId?: unknown }).turnId !== turnId) throw new SteeringError('Codex did not confirm the expected turn. The message was not resent.', 'uncertain');
    } catch (error) {
      if (error instanceof SteeringError) throw error;
      throw new SteeringError(message(error), (error as { rpcRejected?: boolean })?.rpcRejected ? 'rejected' : 'uncertain');
    } finally { this.steeringPending = false; }
  }

  private async submit(): Promise<void> {
    // Refresh ownership before subscribing. Never create or fork a thread.
    if (!await loaded(this.rpc, this.options.threadId)) throw new Error('이 세션이 Codex 데스크톱에서 닫혔습니다. 새 writer를 만들지 않았습니다.');
    const resumed = await this.rpc.request<{ thread: { id: string } }>('thread/resume', { threadId: this.options.threadId, excludeTurns: true });
    if (resumed.thread?.id !== this.options.threadId) throw new Error('Codex가 요청한 세션과 다른 세션을 반환했습니다. 요청을 보내지 않았습니다.');
    const previous = await this.rpc.request<Page<Turn>>('thread/turns/list', { threadId: this.options.threadId, sortDirection: 'desc', limit: 100, itemsView: 'notLoaded' });
    if (!Array.isArray(previous.data)) throw new Error('요청 전 Codex 실행 기록을 확인하지 못해 메시지를 보내지 않았습니다.');
    this.previousTurnIds = new Set(previous.data.map(turn => turn.id));
    if (this.cancelRequested || this.settled) { this.finish({ status: 'cancelled' }); return; }
    // An explicit override must be acknowledged before queue admission. Native
    // defaults stay untouched when the request omits a model.
    if (this.options.model) {
      try { await this.rpc.request('thread/settings/update', { threadId: this.options.threadId, model: this.options.model }); }
      catch { throw new Error('Codex could not apply the selected model. No message was submitted.'); }
      if (this.cancelRequested || this.settled) { this.finish({ status: 'cancelled' }); return; }
    }
    this.submitted = true;
    const added = await this.rpc.request<{ queuedSubmission: { id: string; clientUserMessageId: string } }>('thread/queue/add', {
      threadId: this.options.threadId, clientUserMessageId: this.options.runId,
      input: [{ type: 'text', text: this.options.prompt, text_elements: [] },
        ...(this.options.imagePaths || []).map(path => ({ type: 'localImage', path }))],
    });
    if (this.settled) return;
    if (!added.queuedSubmission?.id || added.queuedSubmission.clientUserMessageId !== this.options.runId) throw new Error('Codex 대기열에 접수된 요청을 식별하지 못했습니다. 자동으로 다시 보내지 않았습니다.');
    this.queueId = added.queuedSubmission.id;
    await this.reconcile();
  }

  cancel(): Promise<void> {
    if (this.cancelPromise) return this.cancelPromise;
    if (this.settled) return this.result?.status === 'error' ? Promise.reject(new Error(this.result.error)) : Promise.resolve();
    this.cancelRequested = true;
    return this.cancelPromise = this.confirmCancellation();
  }

  private async confirmCancellation(): Promise<void> {
    const timeout = setTimeout(() => this.finish({ status: 'error', error: '12초 안에 Codex 작업 종료를 확인하지 못했습니다. 취소가 완료된 것으로 처리하지 않았습니다. 원래 앱에서 확인하세요.' }), 12_000);
    timeout.unref();
    try {
      await this.cancelOwned();
      if (this.result?.status === 'error') throw new Error(this.result.error);
    } catch (error) {
      if (!this.settled) this.finish({ status: 'error', error: `요청 취소를 확인하지 못했습니다. ${message(error)}` });
      // A lost connection may have settled done while the interrupt RPC was pending.
      // Preserve that error for the caller instead of reporting successful cancellation.
      if (this.result?.status === 'error') throw new Error(this.result.error);
    } finally { clearTimeout(timeout); }
  }

  private async cancelOwned(): Promise<void> {
    if (!this.startPromise) { this.finish({ status: 'cancelled' }); return; }
    await this.startPromise;
    if (this.settled) return;
    if (!this.turnId && this.queueId) {
      const result = await this.rpc.request<{ deleted: boolean }>('thread/queue/delete', { threadId: this.options.threadId, queuedSubmissionId: this.queueId });
      if (this.settled) return;
      if (result.deleted) { this.finish({ status: 'cancelled' }); return; }
      await this.recoverTurn();
    }
    if (this.settled) return;
    if (!this.turnId) await this.turnKnown;
    if (this.settled) return;
    if (!this.turnId) throw new Error('이 요청의 실행 ID를 찾지 못해 다른 작업을 중지하지 않았습니다. 원래 앱에서 확인하세요.');
    await this.rpc.request('turn/interrupt', { threadId: this.options.threadId, turnId: this.turnId });
    this.schedule();
    // The interrupt acknowledgement only confirms receipt. Completion comes from
    // this exact turn's terminal notification or its persisted terminal status.
    await this.done;
  }

  close(): void {
    if (!this.settled) this.finish({ status: 'error', error: 'Monitor가 Codex 연결을 종료했습니다. 접수된 요청은 원래 앱에서 계속 실행될 수 있습니다.' });
  }

  private schedule(delay = 1000): void {
    if (this.settled || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.reconcile().catch(error => { if (!this.settled) this.finish({ status: 'error', error: message(error) }); });
    }, delay);
    this.timer.unref();
  }

  private async reconcile(): Promise<void> {
    if (this.settled || this.reconciling || !this.queueId) return;
    this.reconciling = true;
    try {
      if (this.turnId) { await this.readTurn(); return; }
      let cursor: string | undefined;
      let queued = false;
      do {
        const page = await this.rpc.request<Page<{ id: string }>>('thread/queue/list', { threadId: this.options.threadId, limit: 100, ...(cursor ? { cursor } : {}) });
        queued = page.data.some(item => item.id === this.queueId);
        cursor = page.nextCursor || undefined;
      } while (!queued && cursor && !this.settled);
      if (this.settled || this.turnId) return;
      if (!queued) {
        await this.recoverTurn();
        if (!this.turnId && !this.settled) {
          this.missingSince ??= Date.now();
          if (Date.now() - this.missingSince > 10_000) throw new Error('Codex 대기열에서 요청이 사라졌지만 실행 여부를 확인하지 못했습니다. 자동으로 다시 보내지 않았습니다.');
        }
        return;
      }
      this.missingSince = undefined;
      if (this.cancelRequested) return;
      const state = await this.rpc.request<{ thread: { status: { type: string } } }>('thread/read', { threadId: this.options.threadId, includeTurns: false });
      if (this.settled || this.turnId || this.cancelRequested || state.thread.status.type === 'active') return;
      try {
        const started = await this.rpc.request<{ turn: Turn }>('thread/queue/start', { threadId: this.options.threadId, queuedSubmissionId: this.queueId });
        if (!this.settled) this.acceptTurn(started.turn);
      } catch (error) {
        if (this.settled || this.turnId) return;
        if (/active or pending turn|already.*active|Core declined to start queued/i.test(message(error))) return;
        if (/queued submission not found/i.test(message(error))) { await this.recoverTurn(); return; }
        throw error;
      }
    } finally { this.reconciling = false; this.schedule(); }
  }

  private async recoverTurn(): Promise<void> {
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 10 && !this.turnId && !this.settled; pageNumber++) {
      const page = await this.rpc.request<Page<{ turnId: string; item: Item }>>('thread/items/list', { threadId: this.options.threadId, sortDirection: 'desc', limit: 100, ...(cursor ? { cursor } : {}) });
      const own = page.data.find(entry => !this.previousTurnIds.has(entry.turnId) && entry.item.type === 'userMessage' && entry.item.clientId === this.options.runId);
      if (own) { this.bindTurn(own.turnId); break; }
      cursor = page.nextCursor || undefined;
      if (!cursor) break;
    }
    if (this.turnId && !this.settled) await this.readTurn();
  }

  private async readTurn(): Promise<void> {
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 10 && !this.settled; pageNumber++) {
      const page = await this.rpc.request<Page<Turn>>('thread/turns/list', { threadId: this.options.threadId, sortDirection: 'desc', limit: 20, itemsView: 'notLoaded', ...(cursor ? { cursor } : {}) });
      const turn = page.data.find(value => value.id === this.turnId);
      if (turn) {
        if (turn.status !== 'inProgress') {
          let itemCursor: string | undefined;
          do {
            const items = await this.rpc.request<Page<{ turnId: string; item: Item }>>('thread/items/list', { threadId: this.options.threadId, turnId: this.turnId, sortDirection: 'asc', limit: 100, ...(itemCursor ? { cursor: itemCursor } : {}) });
            for (const entry of items.data) if (entry.turnId === this.turnId) this.itemComplete(entry.item);
            itemCursor = items.nextCursor || undefined;
          } while (itemCursor && !this.settled);
          this.acceptTurn(turn);
        }
        return;
      }
      cursor = page.nextCursor || undefined;
      if (!cursor) return;
    }
  }

  private notice(notice: Notice): void {
    if (this.settled || !this.submitted || notice.params.threadId !== this.options.threadId) return;
    const { params, method } = notice;
    if (method === 'thread/queue/changed' || method === 'thread/status/changed') { this.schedule(0); return; }
    const turnId = params.turnId || params.turn?.id;
    if (!turnId || this.previousTurnIds.has(turnId)) return;
    if (params.item?.type === 'userMessage' && params.item.clientId === this.options.runId
      || params.turn?.items?.some(item => item.type === 'userMessage' && item.clientId === this.options.runId)) this.bindTurn(turnId);
    if (this.settled) return;
    if (!this.turnId) {
      if (!this.early.has(turnId) && this.early.size >= 8) this.early.delete(this.early.keys().next().value!);
      const early = this.early.get(turnId) || { events: [], size: 0 };
      const size = (params.delta?.length || 0) + (params.item?.text?.length || 0)
        + (params.item?.aggregatedOutput?.length || 0)
        + (params.turn?.items?.reduce((total, item) => total + (item.text?.length || 0) + (item.aggregatedOutput?.length || 0), 0) || 0) + 256;
      if (early.events.length < 256 && early.size + size < 512_000) { early.events.push(notice); early.size += size; }
      this.early.set(turnId, early);
      return;
    }
    if (turnId !== this.turnId) return;
    if (method === 'item/agentMessage/delta' && params.itemId && typeof params.delta === 'string') {
      this.output.set(params.itemId, (this.output.get(params.itemId) || '') + params.delta);
      this.options.onOutput(params.delta);
    } else if (method === 'item/completed' && params.item) this.itemComplete(params.item);
    else if (method === 'turn/completed' && params.turn) this.acceptTurn(params.turn);
  }

  private bindTurn(id: string): void {
    // During queue admission the native history can temporarily attach the new
    // client ID to the old tail turn. A queued submission must create a new turn.
    if (this.settled || this.turnId || this.previousTurnIds.has(id)) return;
    this.turnId = id;
    this.resolveTurnKnown();
    this.options.onStarted(id);
    const events = this.early.get(id)?.events || [];
    this.early.clear();
    for (const event of events) this.notice(event);
  }

  private acceptTurn(turn: Turn): void {
    if (!turn?.id) throw new Error('Codex가 실행 ID를 반환하지 않았습니다. 요청을 다시 보내지 않았습니다.');
    // queue/start can return the preceding turn's snapshot before the queued
    // input starts. Only its persisted client ID proves ownership of a new turn.
    if (turn.items?.some(item => item.type === 'userMessage' && item.clientId === this.options.runId)) this.bindTurn(turn.id);
    if (this.settled || this.turnId !== turn.id) return;
    if (turn.status !== 'inProgress') for (const item of turn.items || []) this.itemComplete(item);
    if (turn.status === 'completed') this.finish({ status: 'completed' });
    else if (turn.status === 'interrupted') this.finish({ status: 'cancelled' });
    else if (turn.status === 'failed') this.finish({ status: 'error', error: turn.error?.message || 'Codex 작업이 실패했습니다.' });
  }

  private itemComplete(item: Item): void {
    if (this.settled || this.completedItems.has(item.id)) return;
    this.completedItems.add(item.id);
    if (item.type === 'agentMessage' && typeof item.text === 'string') {
      const streamed = this.output.get(item.id) || '';
      this.options.onOutput((item.text.startsWith(streamed) ? item.text.slice(streamed.length) : `\n${item.text}`) + '\n\n');
      this.output.delete(item.id);
    } else if (item.type === 'commandExecution') this.options.onOutput(`$ ${item.command || ''}\n${(item.aggregatedOutput || '').slice(-4000)}\n`);
    else if (item.type === 'fileChange') this.options.onOutput(`Updated ${(item.changes || []).map(change => change.path).join(', ') || 'workspace files'}\n`);
  }

  private finish(result: Result): void {
    if (this.settled) return;
    this.settled = true;
    this.result = result;
    if (this.timer) clearTimeout(this.timer);
    this.early.clear(); this.output.clear();
    this.rpc.close();
    this.resolveTurnKnown();
    try { this.options.onFinished(result); } finally { this.resolveDone(); }
  }
}
