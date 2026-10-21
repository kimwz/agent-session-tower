import { useSyncExternalStore } from 'react';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { formatDate } from '../../../shared/todo/dates';
import type { TodoOp, TodoRequest } from '../../../shared/todo/ops';
import type { TodoAgent, TodoChanges, TodoCompletedPage, TodoOverview, TodoTask, TodoTaskDetail } from '../../../shared/todo/types';
import { api, ApiError } from '../common/lib';
import { translate as t, translateMessage } from '../i18n/i18n';
import { applyOps, emptyWorld, inverseOps, mergeChanges, touchesDetail, withAgents, withDetail, worldFromOverview, type TodoWorld } from './todo-model';

/**
 * The Todo page's data. A change shows at once, goes to the server with the changes of the next 300 ms as one request,
 * and the server's answer replaces it; a refused request takes its changes back and says why. When another page moves
 * the todo revision, the overview, the open detail and the completed list shown are read again, once whatever is in
 * flight has finished.
 */

export interface TodoTransport {
  overview(): Promise<TodoOverview>;
  detail(id: string): Promise<TodoTaskDetail>;
  completed(input: { projectId?: string; labelId?: string; before?: string } & Partial<CompletedRange> & { limit?: number }): Promise<TodoCompletedPage>;
  search(query: string, completed: boolean): Promise<TodoTask[]>;
  apply(request: TodoRequest): Promise<TodoChanges>;
  /** Starts a todo's issue master with the owner's first message; the answer may name the agent it recorded. */
  startAgent(taskId: string, text: string): Promise<{ agent?: TodoAgent } | undefined>;
  /** Linking projects and sections to GitHub repositories (the owner's page only). */
  github?: {
    check(repo: string): Promise<TodoGitHubCheck>;
    link(kind: 'project' | 'section', id: string, repo: string): Promise<unknown>;
    unlink(id: string): Promise<unknown>;
  };
}

/** Who gh is signed in as on the Tower's computer, and what that account may do in a repository. */
export interface TodoGitHubCheck { login: string; repo: string; private: boolean; canPush: boolean }

export function httpTransport(token: () => string): TodoTransport {
  const post = (path: string, body: unknown) => api<TodoChanges>(path, { method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token() }, body: JSON.stringify(body) });
  return {
    overview: () => api<TodoOverview>('/api/todos'),
    detail: id => api<TodoTaskDetail>(`/api/todos/tasks/${encodeURIComponent(id)}`),
    completed: ({ projectId, labelId, before, since, until, limit }) => {
      const params = new URLSearchParams({ limit: String(limit ?? 50) });
      if (projectId) params.set('projectId', projectId);
      if (labelId) params.set('labelId', labelId);
      if (before) params.set('before', before);
      if (since) params.set('since', since);
      if (until) params.set('until', until);
      return api<TodoCompletedPage>(`/api/todos/completed?${params}`);
    },
    search: async (query, completed) => (await api<{ tasks: TodoTask[] }>(`/api/todos/search?${new URLSearchParams({ q: query, ...(completed ? { completed: '1' } : {}) })}`)).tasks,
    apply: request => post('/api/todos/ops', request),
    startAgent: (taskId, text) => api<{ agent?: TodoAgent } | undefined>(`/api/todos/tasks/${encodeURIComponent(taskId)}/agent`, { method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token() }, body: JSON.stringify({ text }) }),
    github: {
      check: repo => api<TodoGitHubCheck>('/api/todos/github/check', { method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token() }, body: JSON.stringify({ repo }) }),
      link: (kind, id, repo) => api('/api/todos/github/bindings', { method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token() }, body: JSON.stringify({ kind, id, repo }) }),
      unlink: id => api(`/api/todos/github/bindings/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { [REQUEST_TOKEN_HEADER]: token() } }),
    },
  };
}

export interface TodoToastAction { label: string; run: () => void }
export interface TodoToast { id: number; message: string; tone: 'info' | 'error'; actions: TodoToastAction[] }

/** The times a completed list keeps: from `since` (included) to `until` (left out), as `toISOString` writes them. */
export interface CompletedRange { since: string; until: string }

/** A period's list is read whole, up to this many pages of 100. */
const RANGE_PAGES = 10;

export interface CompletedList {
  /** A project id, or '' for every project. */
  projectId: string;
  /** Only tasks with this label, when set (a label's list). */
  labelId?: string;
  /** Only completions of this period, read whole at once (the calendar's days); otherwise a page at a time. */
  range?: CompletedRange;
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
  /**
   * The completions this page made, newest first, that a completed list may not have yet: each stays from the moment it
   * shows until a list read after the server took it has come (listing it or not), or until it is refused or taken back.
   */
  completing: TodoCompletedPage['items'];
  /** The completions this page is taking back, not yet answered: they show as taken back, and again if refused. */
  undoing: string[];
  toasts: TodoToast[];
  canUndo: boolean;
}

interface Action { ops: TodoOp[]; undo: TodoOp[] | null; settled?: (ok: boolean) => void; refused?: boolean }
/** A completion of `completing`, with its change and, once the server has it, the completed-list read number then. */
interface Completing { item: TodoCompletedPage['items'][number]; action: Action; answered?: number }
type Undo = { ops: TodoOp[]; action: Action; used?: boolean };

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
  private completing: Completing[] = [];
  private lastUndo: Undo | null = null;
  private toastId = 0;
  private toastTimers = new Set<ReturnType<typeof setTimeout>>();
  private listeners = new Set<() => void>();
  private state: TodoState = { phase: 'loading', error: '', world: emptyWorld(), detailId: null, detailError: '', completed: null, completing: [], undoing: [], toasts: [], canUndo: false };

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
    this.completing = this.completing.filter(entry => !entry.action.refused);
    const undoing = [...(this.inflight ?? []), ...this.queue].flatMap(action => action.ops.flatMap(op => op.op === 'task.uncomplete' ? [op.completionId] : []));
    this.set({ ...patch, world, completing: this.completing.map(entry => entry.item), undoing, canUndo: !!this.lastUndo });
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
    if (this.state.completed) this.rereadCompleted();
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
    const revision = this.base.revision;
    try {
      const detail = await this.transport.detail(id);
      if (ticket !== this.detailRead || this.state.detailId !== id) return;
      // Something was saved while it was read: the answer may be older than that, so it is read again.
      if (this.base.revision !== revision) { void this.readDetail(id); return; }
      this.base = withDetail(this.base, detail);
      this.publish({ detailError: '' });
    } catch (error) {
      if (ticket !== this.detailRead || this.state.detailId !== id) return;
      this.publish({ detailError: message(error) });
    }
  }

  /**
   * Shows completed tasks of a project ('' for all), only those with `labelId` when it is given; `more` adds the next
   * page of the list shown (its label and period unless others are given). With `range`, the whole period is read.
   */
  async readCompleted(projectId: string, more = false, labelId?: string, range?: CompletedRange) {
    const current = this.state.completed;
    const label = (more ? labelId ?? current?.labelId : labelId) || undefined;
    const period = more ? range ?? current?.range : range;
    const same = (list: CompletedList | null | undefined): list is CompletedList => !!list && list.projectId === projectId && (list.labelId || undefined) === label
      && list.range?.since === period?.since && list.range?.until === period?.until;
    const before = more && same(current) ? current.before : undefined;
    if (more && !before) return;
    const ticket = ++this.completedRead;
    const scope = { projectId, ...(label ? { labelId: label } : {}), ...(period ? { range: period } : {}) };
    this.set({ completed: { ...scope, items: same(current) ? current.items : [], before: current?.before, loading: true, error: '' } });
    try {
      const ask = (after?: string) => this.transport.completed({ projectId: projectId || undefined, ...(label ? { labelId: label } : {}), before: after, ...(period ? { ...period, limit: 100 } : {}) });
      let page = await ask(before);
      let read = page.items;
      // A period shows whole: its pages are read one after another before any shows, so it never shows half.
      for (let pages = 1; period && page.before && pages < RANGE_PAGES; pages++) {
        if (ticket !== this.completedRead) return;
        page = await ask(page.before);
        read = [...read, ...page.items];
      }
      if (ticket !== this.completedRead || !same(this.state.completed)) return;
      const items = more ? [...this.state.completed.items, ...read] : read;
      // What the server took before this read began is in it now, or gone (reopened or deleted elsewhere).
      this.completing = this.completing.filter(entry => entry.answered === undefined || entry.answered >= ticket);
      this.set({ completed: { ...scope, items, before: period ? undefined : page.before, loading: false, error: '' }, completing: this.completing.map(entry => entry.item) });
    } catch (error) {
      if (ticket !== this.completedRead || !same(this.state.completed)) return;
      this.set({ completed: { ...this.state.completed, loading: false, error: message(error) } });
    }
  }
  /** Reads the completed list shown again, as it was asked for. */
  private rereadCompleted() {
    const list = this.state.completed;
    if (list) void this.readCompleted(list.projectId, false, list.labelId, list.range);
  }
  hideCompleted() { this.completedRead++; if (this.state.completed) this.set({ completed: null }); }

  search(query: string, completed = false) { return this.transport.search(query, completed); }
  /** A task's detail without opening it: its latest completion, to reopen it. */
  detailOf(id: string) { return this.transport.detail(id); }

  /**
   * Makes a change. It shows at once and is sent with the others of the next moment as one request; the operations of
   * one call are always in the same request, so they apply together or not at all.
   */
  apply(ops: TodoOp[], options: { undoable?: boolean; settled?: (ok: boolean) => void } = {}): boolean {
    const availability = this.state.world.availability;
    if (availability.state !== 'ready') { this.toast(availability.state === 'read-only' ? t('할 일이 읽기 전용입니다.') : t('할 일을 사용할 수 없습니다.'), 'error'); return false; }
    if (!ops.length) return false;
    const undo = options.undoable === false ? null : inverseOps(this.state.world, ops, newId);
    const action: Action = { ops, undo, settled: options.settled };
    this.queue.push(action);
    this.lastUndo = undo ? { ops: undo, action } : options.undoable === false ? this.lastUndo : null;
    this.publish();
    const completedAt = this.now().toISOString();
    const made = ops.flatMap(op => op.op === 'task.complete' && this.state.world.tasks[op.id]
      ? [{ item: { completion: { id: op.completionId, taskId: op.id, occurrenceDate: op.occurrence, completedAt }, task: this.state.world.tasks[op.id] }, action }] : []);
    if (made.length) { this.completing = [...made.reverse(), ...this.completing]; this.set({ completing: this.completing.map(entry => entry.item) }); }
    if (this.queue.reduce((count, item) => count + item.ops.length, 0) >= MAX_BATCH_OPS) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, this.options.batchMs ?? BATCH_MS);
    return true;
  }

  /** Makes a change and answers once the server has it (true) or refused it (false): for work that needs it saved first. */
  applyAndWait(ops: TodoOp[]): Promise<boolean> {
    return new Promise(resolve => { if (!this.apply(ops, { settled: resolve })) resolve(false); });
  }

  /** What another route changed (an upload's completion), taken in as a request's answer is. */
  receive(changes: TodoChanges) {
    this.accept(changes, []);
  }

  private accept(changes: TodoChanges, ops: readonly TodoOp[]) {
    if (changes.revision <= this.base.revision) {
      // An answer the page has already moved past (an upload finishing after a newer overview): what it changed is in
      // what the page has, maybe newer, and counting it again would count it twice. Read again to be sure.
      this.wantRead = true;
      this.publish();
      this.pump();
      return;
    }
    // One request moves the revision by one: more means another page changed something in between.
    if (changes.revision > this.base.revision + 1) this.wantRead = true;
    // A task opened again comes without its completed sub-tasks, which its card lists: they come with the overview.
    if (ops.some(op => op.op === 'task.uncomplete')) this.wantRead = true;
    this.base = mergeChanges(this.base, changes);
    this.publish();
    if (this.state.detailId && touchesDetail(this.base.detail, changes)) void this.readDetail(this.state.detailId);
    // A list still being read may answer from before this change: it is read again too.
    if (this.state.completed && (this.state.completed.loading || touchesCompleted(this.state.completed, ops, changes))) this.rereadCompleted();
    this.pump();
  }

  /** Takes back the last change. */
  undo(): boolean {
    return this.lastUndo ? this.takeBack(this.lastUndo) : false;
  }

  /** A toast's undo: it takes back the change just made, even after others were made since. */
  undoActions(): TodoToastAction[] {
    const last = this.lastUndo;
    return last ? [{ label: t('되돌리기'), run: () => { this.takeBack(last); } }] : [];
  }

  private takeBack(undo: Undo): boolean {
    if (this.lastUndo === undo) this.lastUndo = null;
    // Taken back once only, whether by ⌘Z or its toast.
    if (undo.used || undo.action.refused) return false;
    undo.used = true;
    return this.apply(undo.ops, { undoable: false });
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
      this.inflight = null;
      // Read again with the list shown (`accept`), or by the next list asked for; with none shown, no list needs them.
      // One taken back is gone for good.
      const undone = new Set(request.ops.flatMap(op => op.op === 'task.uncomplete' ? [op.completionId] : []));
      this.completing = this.completing.filter(entry => !undone.has(entry.item.completion.id) && (!batch.includes(entry.action) || !!this.state.completed));
      for (const entry of this.completing) if (batch.includes(entry.action)) entry.answered = this.completedRead;
      this.accept(changes, request.ops);
      for (const action of batch) action.settled?.(true);
      return;
    } catch (error) {
      // A lost answer is asked again with the same request id, which the server answers without applying it twice.
      if (!(error instanceof ApiError) && attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
        return this.send(batch, request, attempt + 1);
      }
      this.inflight = null;
      for (const action of batch) action.refused = true;
      if (this.lastUndo && batch.includes(this.lastUndo.action)) this.lastUndo = null;
      this.publish();
      this.toast(t('변경을 저장하지 못했습니다: {0}', { 0: message(error) }), 'error');
      for (const action of batch) action.settled?.(false);
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

  /**
   * Starts the todo's issue master. It shows as soon as the server answers; the overview is read again for what the
   * server recorded. A refusal throws, so the page keeps the message to send again.
   */
  async startAgent(taskId: string, text: string): Promise<void> {
    const answer = await this.transport.startAgent(taskId, text);
    const agent = answer?.agent;
    if (agent?.taskId === taskId) {
      this.base = { ...this.base, agents: withAgents(this.base.agents, { [taskId]: agent }) };
      this.publish();
    }
    this.wantRead = true;
    this.pump();
  }

  /** Who gh is signed in as and what it may do in `repo`; a refusal throws with GitHub's words. */
  githubCheck(repo: string): Promise<TodoGitHubCheck> {
    if (!this.transport.github) return Promise.reject(new Error(t('GitHub 연결을 사용할 수 없습니다.')));
    return this.transport.github.check(repo);
  }

  /** Links a project or section (or ends a link); the overview is read again for what the server recorded. */
  async githubLink(kind: 'project' | 'section', id: string, repo: string): Promise<void> {
    if (!this.transport.github) throw new Error(t('GitHub 연결을 사용할 수 없습니다.'));
    await this.transport.github.link(kind, id, repo);
    this.wantRead = true;
    this.pump();
  }

  async githubUnlink(id: string): Promise<void> {
    if (!this.transport.github) throw new Error(t('GitHub 연결을 사용할 수 없습니다.'));
    await this.transport.github.unlink(id);
    this.wantRead = true;
    this.pump();
  }

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

const COMPLETED_OPS = new Set<TodoOp['op']>(['task.complete', 'task.uncomplete', 'task.delete', 'task.restore']);
/**
 * Whether a change may show in the completed list: it completes or reopens a task, or changes one listed, asked for or
 * changed along with another (a completed sub-task moved with its parent).
 */
function touchesCompleted(list: CompletedList, ops: readonly TodoOp[], changes: TodoChanges): boolean {
  const listed = new Set(list.items.map(item => item.task.id));
  return ops.some(op => COMPLETED_OPS.has(op.op) || ('id' in op && typeof op.id === 'string' && listed.has(op.id))) || changes.tasks.some(task => listed.has(task.id));
}

const message = (error: unknown) => error instanceof Error ? translateMessage(error.message) : t('요청을 처리하지 못했습니다.');

export function useTodoState(client: TodoClient): TodoState {
  return useSyncExternalStore(client.subscribe, client.getState, client.getState);
}
