import { useSyncExternalStore } from 'react';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { formatDate } from '../../../shared/todo/dates';
import type { TodoOp, TodoRequest } from '../../../shared/todo/ops';
import type { TodoChanges, TodoCompletedPage, TodoOverview, TodoTask, TodoTaskDetail } from '../../../shared/todo/types';
import { api, ApiError } from '../common/lib';
import { translate as t, translateMessage } from '../i18n/i18n';
import { applyOps, emptyWorld, inverseOps, mergeChanges, touchesDetail, withDetail, worldFromOverview, type TodoWorld } from './todo-model';

/**
 * The Todo page's data. A change shows at once, goes to the server with the changes of the next 300 ms as one request,
 * and the server's answer replaces it; a refused request takes its changes back and says why. When another page moves
 * the todo revision, the overview, the open detail and the completed list shown are read again, once whatever is in
 * flight has finished.
 */

export interface TodoTransport {
  overview(): Promise<TodoOverview>;
  detail(id: string): Promise<TodoTaskDetail>;
  completed(input: { projectId?: string; before?: string }): Promise<TodoCompletedPage>;
  search(query: string, completed: boolean): Promise<TodoTask[]>;
  apply(request: TodoRequest): Promise<TodoChanges>;
}

export function httpTransport(token: () => string): TodoTransport {
  const post = (path: string, body: unknown) => api<TodoChanges>(path, { method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token() }, body: JSON.stringify(body) });
  return {
    overview: () => api<TodoOverview>('/api/todos'),
    detail: id => api<TodoTaskDetail>(`/api/todos/tasks/${encodeURIComponent(id)}`),
    completed: ({ projectId, before }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (projectId) params.set('projectId', projectId);
      if (before) params.set('before', before);
      return api<TodoCompletedPage>(`/api/todos/completed?${params}`);
    },
    search: async (query, completed) => (await api<{ tasks: TodoTask[] }>(`/api/todos/search?${new URLSearchParams({ q: query, ...(completed ? { completed: '1' } : {}) })}`)).tasks,
    apply: request => post('/api/todos/ops', request),
  };
}

export interface TodoToastAction { label: string; run: () => void }
export interface TodoToast { id: number; message: string; tone: 'info' | 'error'; actions: TodoToastAction[] }

export interface CompletedList {
  /** A project id, or '' for every project. */
  projectId: string;
  items: TodoCompletedPage['items'];
  before?: string;
  loading: boolean;
  error: string;
}

export interface TodoState {
  phase: 'loading' | 'ready' | 'error';
  error: string;
  world: TodoWorld;
  detailId: string | null;
  detailError: string;
  completed: CompletedList | null;
  toasts: TodoToast[];
  canUndo: boolean;
}

interface Action { ops: TodoOp[]; undo: TodoOp[] | null }

export const BATCH_MS = 300;
const MAX_BATCH_OPS = 90;
const TOAST_MS = 6000;

export const localToday = (now = new Date()) => formatDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
export const newId = () => crypto.randomUUID();

export class TodoClient {
  private base: TodoWorld = emptyWorld();
  private queue: Action[] = [];
  private inflight: Action[] | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reading = false;
  private wantRead = false;
  private detailRead = 0;
  /** Each completed-list load takes a number; an answer to an older one than the latest is dropped. */
  private completedRead = 0;
  private lastUndo: { ops: TodoOp[]; action: Action } | null = null;
  private toastId = 0;
  private toastTimers = new Set<ReturnType<typeof setTimeout>>();
  private listeners = new Set<() => void>();
  private state: TodoState = { phase: 'loading', error: '', world: emptyWorld(), detailId: null, detailError: '', completed: null, toasts: [], canUndo: false };

  constructor(private readonly transport: TodoTransport, private readonly options: { now?: () => Date; batchMs?: number; toastMs?: number } = {}) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getState = () => this.state;
  private now() { return this.options.now?.() ?? new Date(); }
  today() { return localToday(this.now()); }

  private set(patch: Partial<TodoState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  /** What the page shows: the server's answers with the changes not yet answered on top. */
  private publish(patch: Partial<TodoState> = {}) {
    const context = { now: this.now().toISOString(), today: this.today() };
    let world = this.base;
    for (const action of [...(this.inflight ?? []), ...this.queue]) world = applyOps(world, action.ops, context);
    this.set({ ...patch, world, canUndo: !!this.lastUndo });
  }

  start() { this.wantRead = true; this.pump(); }

  /** The snapshot's todo revision: a newer one means another page changed something. */
  noticeRevision(revision: number | undefined) {
    if (revision === undefined || revision <= this.base.revision) return;
    this.wantRead = true;
    this.pump();
  }

  /**
   * What runs next, one thing at a time: changes waiting to be sent go first (once their batch window has closed), then
   * a read that was asked for meanwhile. Called whenever a read or a request ends.
   */
  private pump() {
    if (this.reading || this.inflight) return;
    if (this.queue.length) { if (!this.timer) this.flush(); return; }
    if (this.wantRead) void this.read();
  }

  private async read(): Promise<void> {
    this.wantRead = false;
    this.reading = true;
    try {
      const overview = await this.transport.overview();
      // Nothing is sent while reading, so an older overview only comes from a server that went back; it is not shown.
      if (overview.revision >= this.base.revision) {
        this.base = worldFromOverview(overview, this.base);
        this.publish({ phase: 'ready', error: '' });
      }
    } catch (error) {
      if (this.state.phase !== 'ready') this.set({ phase: 'error', error: message(error) });
      else this.toast(message(error), 'error');
    } finally {
      this.reading = false;
    }
    if (this.state.detailId) void this.readDetail(this.state.detailId);
    if (this.state.completed) void this.readCompleted(this.state.completed.projectId);
    this.pump();
  }

  openDetail(id: string | null) {
    if (id === this.state.detailId) return;
    this.base = withDetail(this.base, null);
    this.publish({ detailId: id, detailError: '' });
    if (id) void this.readDetail(id);
  }

  private async readDetail(id: string) {
    const ticket = ++this.detailRead;
    try {
      const detail = await this.transport.detail(id);
      if (ticket !== this.detailRead || this.state.detailId !== id) return;
      this.base = withDetail(this.base, detail);
      this.publish({ detailError: '' });
    } catch (error) {
      if (ticket !== this.detailRead || this.state.detailId !== id) return;
      this.publish({ detailError: message(error) });
    }
  }

  /** Shows completed tasks of a project ('' for all); `more` adds the next page. */
  async readCompleted(projectId: string, more = false) {
    const current = this.state.completed;
    const before = more && current?.projectId === projectId ? current.before : undefined;
    if (more && !before) return;
    const ticket = ++this.completedRead;
    this.set({ completed: { projectId, items: more && current ? current.items : current?.projectId === projectId ? current.items : [], before: current?.before, loading: true, error: '' } });
    try {
      const page = await this.transport.completed({ projectId: projectId || undefined, before });
      if (ticket !== this.completedRead || this.state.completed?.projectId !== projectId) return;
      const items = more ? [...this.state.completed.items, ...page.items] : page.items;
      this.set({ completed: { projectId, items, before: page.before, loading: false, error: '' } });
    } catch (error) {
      if (ticket !== this.completedRead || this.state.completed?.projectId !== projectId) return;
      this.set({ completed: { ...this.state.completed, loading: false, error: message(error) } });
    }
  }
  hideCompleted() { this.completedRead++; if (this.state.completed) this.set({ completed: null }); }

  search(query: string, completed = false) { return this.transport.search(query, completed); }
  /** A task's detail without opening it: its latest completion, to reopen it. */
  detailOf(id: string) { return this.transport.detail(id); }

  /**
   * Makes a change. It shows at once and is sent with the others of the next moment as one request; the operations of
   * one call are always in the same request, so they apply together or not at all.
   */
  apply(ops: TodoOp[], options: { undoable?: boolean } = {}): boolean {
    const availability = this.state.world.availability;
    if (availability.state !== 'ready') { this.toast(availability.state === 'read-only' ? t('할 일이 읽기 전용입니다.') : t('할 일을 사용할 수 없습니다.'), 'error'); return false; }
    if (!ops.length) return false;
    const undo = options.undoable === false ? null : inverseOps(this.state.world, ops, newId);
    const action: Action = { ops, undo };
    this.queue.push(action);
    this.lastUndo = undo ? { ops: undo, action } : options.undoable === false ? this.lastUndo : null;
    this.publish();
    if (this.queue.reduce((count, item) => count + item.ops.length, 0) >= MAX_BATCH_OPS) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, this.options.batchMs ?? BATCH_MS);
    return true;
  }

  /** Takes back the last change. */
  undo(): boolean {
    const last = this.lastUndo;
    if (!last) return false;
    this.lastUndo = null;
    return this.apply(last.ops, { undoable: false });
  }

  private flush() {
    if (this.inflight || this.reading || !this.queue.length) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const batch: Action[] = [];
    let count = 0;
    while (this.queue.length && (!batch.length || count + this.queue[0].ops.length <= 100)) { const action = this.queue.shift()!; batch.push(action); count += action.ops.length; }
    this.inflight = batch;
    void this.send(batch, { requestId: newId(), ops: batch.flatMap(action => action.ops) });
  }

  private async send(batch: Action[], request: TodoRequest, attempt = 0): Promise<void> {
    try {
      const changes = await this.transport.apply(request);
      // One request moves the revision by one: more means another page changed something in between.
      if (changes.revision > this.base.revision + 1) this.wantRead = true;
      this.base = mergeChanges(this.base, changes);
      this.inflight = null;
      this.publish();
      if (this.state.detailId && touchesDetail(this.base.detail, changes)) void this.readDetail(this.state.detailId);
      if (this.state.completed && request.ops.some(op => op.op === 'task.complete' || op.op === 'task.uncomplete' || op.op === 'task.delete' || op.op === 'task.restore')) void this.readCompleted(this.state.completed.projectId);
    } catch (error) {
      // A lost answer is asked again with the same request id, which the server answers without applying it twice.
      if (!(error instanceof ApiError) && attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
        return this.send(batch, request, attempt + 1);
      }
      this.inflight = null;
      if (this.lastUndo && batch.includes(this.lastUndo.action)) this.lastUndo = null;
      this.publish();
      this.toast(t('변경을 저장하지 못했습니다: {0}', { 0: message(error) }), 'error');
      // Another page changed it first, or it is gone: show what is there now.
      if (error instanceof ApiError && (error.status === 409 || error.status === 404)) this.wantRead = true;
    }
    this.pump();
  }

  toast(text: string, tone: TodoToast['tone'] = 'info', actions: TodoToastAction[] = []): number {
    const id = ++this.toastId;
    this.set({ toasts: [...this.state.toasts.filter(toast => toast.tone === 'error' || toast.actions.length).slice(-2), { id, message: text, tone, actions }] });
    const timer = setTimeout(() => { this.toastTimers.delete(timer); this.dismiss(id); }, this.options.toastMs ?? TOAST_MS);
    this.toastTimers.add(timer);
    return id;
  }
  dismiss(id: number) { if (this.state.toasts.some(toast => toast.id === id)) this.set({ toasts: this.state.toasts.filter(toast => toast.id !== id) }); }

  /** Requests not answered yet, for tests and for leaving the page. */
  pending() { return this.queue.length + (this.inflight?.length ?? 0); }
  /** Leaving the page: what is waiting is sent now, and nothing is shown any more. */
  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.queue.length) this.flush();
    for (const timer of this.toastTimers) clearTimeout(timer);
    this.toastTimers.clear();
    this.listeners.clear();
  }
}

const message = (error: unknown) => error instanceof Error ? translateMessage(error.message) : t('요청을 처리하지 못했습니다.');

export function useTodoState(client: TodoClient): TodoState {
  return useSyncExternalStore(client.subscribe, client.getState, client.getState);
}
