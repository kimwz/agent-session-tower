import { randomUUID } from 'node:crypto';
import { APP_VERSION } from '../../shared/app-identity.js';
import type { MasterEntry, MasterOverview, MasterTaskState, MasterViewContext } from '../../shared/master.js';
import type { AutoPromptJob, ChatMessage, Run, SessionDetail, Snapshot } from '../../shared/types.js';
import { statusDigest } from './digest.js';
import { apiTarget, refusalFor, type ApiTarget, type TurnScope } from './guards.js';
import { masterInstructions } from './instructions.js';
import { fingerprint, type CallRecord, type InboxItem, type MasterJournal, type TaskRecord } from './journal.js';
import type { ModelCall, ModelItem, ModelTool } from './model-openai.js';
import type { LiveState } from './live-state.js';
import { tablesFrom, type ReadDatabase, type Table } from './read-db.js';
import type { MasterRoom } from './room.js';
import { SecretVault } from './secrets.js';
import type { MasterSettingsStore } from './settings.js';
import type { TowerClient, TowerResponse } from './tower-client.js';

const MAX_ROUNDS = 12;
const MAX_TOOL_CALLS = 24;
const TURN_MS = 120_000;
const CONTEXT_ENTRIES = 40;
const MAX_TOOL_OUTPUT = 12_000;
const TASK_POLL_MS = 5_000;
const TASK_UNKNOWN_MS = 30 * 60_000;
const REMOTE_WRITES_PER_MINUTE = 30;

const TOOLS: ModelTool[] = [
  { type: 'function', name: 'tower_api', description: 'Call one of Tower\'s HTTP routes (see Routes), exactly as the owner\'s pages do. For a joined computer pass node.',
    parameters: { type: 'object', properties: {
      method: { type: 'string', enum: ['GET', 'POST'] },
      path: { type: 'string', description: 'Starts with /api/, query string included for GET.' },
      body: { type: 'object', description: 'JSON body for POST.', additionalProperties: true },
      node: { type: 'string', description: '32-hex id of a joined computer, or omit for this computer.' },
    }, required: ['method', 'path'], additionalProperties: false } },
  { type: 'function', name: 'tower_query', description: 'Run one read-only SQL SELECT over Tower\'s current state (see the tables in your instructions). The fastest way to look things up.',
    parameters: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'], additionalProperties: false } },
  { type: 'function', name: 'session_read', description: 'Read the latest messages of a session (compact).',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' }, node: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 60 } }, required: ['sessionId'], additionalProperties: false } },
  { type: 'function', name: 'show_session', description: 'Open a session in the tab the owner is talking from.',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' }, node: { type: 'string' } }, required: ['sessionId'], additionalProperties: false } },
];

interface Turn { id: string; abort: AbortController; inputs: InboxItem[]; scope: TurnScope; tabId?: string }

export interface MasterServiceOptions {
  settings: MasterSettingsStore;
  room: MasterRoom;
  journal: MasterJournal;
  tower: TowerClient;
  model: ModelCall;
  taskPollMs?: number;
  /** What the owner's page sees, kept live: the status digest, quick queries and the task watcher read it. */
  live?: LiveState;
  readDb?: ReadDatabase;
}

/**
 * The master agent. Owner messages and news of finished work wait in the inbox and are answered one turn at a time;
 * a turn asks the model, runs the tools it calls against Tower's own HTTP API, and adds the answer to the conversation.
 */
export class MasterService {
  private turn?: Turn;
  private readonly vault = new SecretVault();
  private taskTimer?: ReturnType<typeof setInterval>;
  private polling = false;
  private closed = false;
  private readonly remoteWrites = new Map<string, number[]>();

  constructor(private readonly options: MasterServiceOptions) {}

  async start(): Promise<void> {
    const { journal, room } = this.options;
    // A change that was being sent when the host stopped may or may not have happened.
    for (const call of journal.calls.filter(item => item.state === 'sending')) {
      call.state = 'uncertain';
      this.updateAction(call);
    }
    // A turn cut short is tried once more only if it changed nothing.
    const interrupted = new Map<string, InboxItem[]>();
    for (const item of journal.inbox.filter(input => input.state === 'processing')) interrupted.set(item.turnId ?? item.id, [...(interrupted.get(item.turnId ?? item.id) ?? []), item]);
    for (const [turnId, items] of interrupted) {
      const calls = journal.calls.filter(call => call.turnId === turnId);
      if (!calls.length && items.every(item => item.retries < 1)) {
        for (const item of items) { item.state = 'queued'; item.retries++; delete item.turnId; }
      } else {
        for (const item of items) item.state = 'failed';
        const done = calls.filter(call => call.state === 'succeeded').map(call => `${call.method} ${call.path}`);
        const unknown = calls.filter(call => call.state === 'uncertain').map(call => `${call.method} ${call.path}`);
        room.add({ kind: 'event', text: `마스터가 하던 일이 중단됐습니다.${done.length ? ` 실행된 것: ${done.join(', ')}.` : ''}${unknown.length ? ` 결과를 알 수 없는 것: ${unknown.join(', ')}.` : ''} 이어서 할지 말해 주세요.` });
      }
    }
    await journal.save('inbox', 'calls');
    this.taskTimer = setInterval(() => { void this.pollTasks(); }, this.options.taskPollMs ?? TASK_POLL_MS);
    this.taskTimer.unref();
    this.pump();
  }

  overview(): MasterOverview {
    const settings = this.options.settings.current();
    const configured = Boolean(this.options.settings.key());
    return {
      available: true, version: APP_VERSION, settings, configured, ...(configured ? { keyHint: this.options.settings.keyHint() } : {}),
      state: !settings.enabled ? 'disabled' : !configured ? 'unconfigured' : this.turn ? 'thinking' : 'idle',
      activeTasks: this.options.journal.tasks.filter(task => task.state === 'running').length,
      lastOrder: this.options.room.lastOrder(),
    };
  }

  /** Work is waiting or running, so the host must stay. */
  busy(): boolean {
    const { inbox, tasks } = this.options.journal;
    return Boolean(this.turn) || this.polling || inbox.some(item => item.state === 'queued') || tasks.some(task => task.state === 'running');
  }

  async send(input: { clientMessageId: string; text: string; viewContext?: MasterViewContext; local: boolean }): Promise<MasterEntry> {
    const { journal, room, settings } = this.options;
    const known = journal.inbox.find(item => item.clientMessageId === input.clientMessageId);
    const existing = known && room.get(known.id);
    if (existing) return existing;
    const text = settings.current().guards.hideSecrets ? this.vault.hide(input.text) : input.text;
    const item: InboxItem = { id: randomUUID(), kind: 'owner', clientMessageId: input.clientMessageId, text, local: input.local, ...(input.viewContext ? { viewContext: input.viewContext } : {}), at: new Date().toISOString(), state: 'queued', retries: 0 };
    const entry = room.add({ kind: 'owner', text, ...(input.viewContext?.tabId ? { clientId: input.viewContext.tabId } : {}) }, item.id);
    journal.inbox.push(item);
    await journal.save('inbox');
    this.pump();
    return entry;
  }

  /** The owner's "stop thinking": ends the model's work on this turn. Changes already sent finish and are recorded. */
  stop(): boolean {
    if (!this.turn) return false;
    this.turn.abort.abort(new Error('stopped'));
    return true;
  }

  async updateSettings(body: Record<string, unknown>): Promise<MasterOverview> {
    await this.options.settings.update(body);
    const overview = this.overview();
    this.options.room.broadcast({ type: 'overview', seq: 0, overview });
    this.pump();
    return overview;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.taskTimer) clearInterval(this.taskTimer);
    await this.options.journal.flush();
    await this.options.room.flush();
  }

  private pump(): void {
    if (this.closed || this.turn) return;
    const settings = this.options.settings.current();
    if (!settings.enabled || !this.options.settings.key()) return;
    const queued = this.options.journal.inbox.filter(item => item.state === 'queued');
    if (!queued.length) return;
    const owners = queued.filter(item => item.kind === 'owner');
    // Only inputs from the same kind of place share a turn, so what a turn may do follows every request in it.
    const batch = owners.length ? owners.filter(item => item.local === owners[0].local).slice(0, 10) : queued.slice(0, 10);
    void this.run(batch);
  }

  private async run(inputs: InboxItem[]): Promise<void> {
    const { journal, room, settings: store, model } = this.options;
    const turnId = randomUUID();
    const tabId = [...inputs].reverse().find(item => item.viewContext?.tabId)?.viewContext?.tabId;
    const turn: Turn = { id: turnId, abort: new AbortController(), inputs, scope: { local: inputs.every(item => item.local), cause: inputs[0].kind === 'owner' ? 'owner' : 'event', irreversible: 0 }, ...(tabId ? { tabId } : {}) };
    this.turn = turn;
    for (const item of inputs) { item.state = 'processing'; item.turnId = turnId; }
    this.broadcastOverview();
    let final = '';
    try {
      await journal.save('inbox');
      const settings = store.current();
      const live = this.options.live;
      const digest = live ? statusDigest(await live.fresh(), live.nodeSnapshots(), Date.now(), live.missing(), text => this.hideText(text)) : '';
      const items: ModelItem[] = [
        { type: 'message', role: 'developer', content: [digest ? this.hideText(digest) : '', this.context(inputs)].filter(Boolean).join('\n\n') },
        { type: 'message', role: 'user', content: inputs.map(item => item.kind === 'event' ? `[event] ${item.text}` : item.text).join('\n\n') },
      ];
      const started = Date.now();
      let toolCalls = 0;
      for (let round = 0; round < MAX_ROUNDS && !final; round++) {
        // A stop pressed between steps (or before the first) ends the turn here.
        turn.abort.signal.throwIfAborted();
        if (Date.now() - started > TURN_MS) { final = '시간이 오래 걸려 여기서 멈췄습니다. 위 작업 기록을 확인해 주세요.'; break; }
        let draft = '';
        let lastDraft = 0;
        const result = await model({ model: settings.model, effort: settings.effort, instructions: masterInstructions(), input: items, tools: TOOLS }, delta => {
          draft += delta;
          if (Date.now() - lastDraft > 150) { lastDraft = Date.now(); room.setDraft({ turnId, text: draft }); }
        }, turn.abort.signal);
        items.push(...result.output);
        const calls = result.output.filter(item => item.type === 'function_call');
        if (!calls.length) { final = result.text.trim() || '(답을 만들지 못했습니다.)'; break; }
        for (const call of calls) {
          // After "stop thinking", nothing more is sent; a change already on its way finishes and is recorded.
          if (turn.abort.signal.aborted) break;
          toolCalls++;
          const output = toolCalls > MAX_TOOL_CALLS
            ? { error: '이번 요청에서 부를 수 있는 도구 수를 넘었습니다. 지금까지 한 일을 소유자에게 보고하세요.' }
            : await this.tool(String(call.name), String(call.arguments ?? '{}'), turn).catch(error => ({ error: error instanceof Error ? error.message : String(error) }));
          items.push({ type: 'function_call_output', call_id: String(call.call_id), output: truncate(JSON.stringify(output), MAX_TOOL_OUTPUT) });
        }
        turn.abort.signal.throwIfAborted();
      }
      if (!final) final = '여러 단계를 거쳤지만 마지막 답을 만들지 못했습니다. 위 작업 기록을 확인해 주세요.';
      room.add({ kind: 'master', text: this.hideText(final), turnId, final: true });
      for (const item of inputs) item.state = 'answered';
    } catch (error) {
      if (turn.abort.signal.aborted) {
        for (const item of inputs) item.state = 'cancelled';
        room.add({ kind: 'event', text: '마스터가 생각을 멈췄습니다. 이미 보낸 작업은 그대로 진행됩니다.' });
      } else {
        for (const item of inputs) item.state = 'failed';
        room.add({ kind: 'error', text: this.hideText(error instanceof Error ? error.message : String(error)) });
      }
    } finally {
      room.setDraft(null);
      this.turn = undefined;
      await journal.save('inbox').catch(() => {});
      this.broadcastOverview();
      this.pump();
    }
  }

  /** The conversation so far, as the model reads it. */
  private context(inputs: InboxItem[]): string {
    const view = [...inputs].reverse().find(item => item.viewContext)?.viewContext;
    const lines = this.options.room.recent(CONTEXT_ENTRIES)
      .filter(entry => !inputs.some(input => input.id === entry.id))
      .map(entry => {
        const data = entry.data;
        const at = entry.at.slice(11, 16);
        if (data.kind === 'owner') return `[${at} owner] ${truncate(data.text, 1500)}`;
        if (data.kind === 'master') return `[${at} you] ${truncate(data.text, 1500)}`;
        if (data.kind === 'action') return `[${at} call] ${data.method} ${data.path}${data.node ? ` (node ${data.node})` : ''} → ${data.state}${data.summary ? `: ${truncate(data.summary, 200)}` : ''}`;
        if (data.kind === 'task') return `[${at} delegated] ${data.title} — ${data.state}${data.sessionId ? ` (session ${data.sessionId}${data.node ? ` on node ${data.node}` : ''})` : ''}`;
        return `[${at} ${data.kind}] ${truncate(data.text, 500)}`;
      });
    const running = this.options.journal.tasks.filter(task => task.state === 'running').map(task => `- ${task.title} (session ${task.sessionId ?? '?'}${task.node ? `, node ${task.node}` : ''})`);
    return [`Now: ${new Date().toISOString()}`,
      view ? `The owner is looking at: ${JSON.stringify(view)}` : '',
      running.length ? `Work you delegated that is still running:\n${running.join('\n')}` : '',
      lines.length ? `Conversation so far (oldest first):\n${lines.join('\n')}` : 'This is the start of the conversation.'].filter(Boolean).join('\n\n');
  }

  private async tool(name: string, rawArguments: string, turn: Turn): Promise<unknown> {
    let args: Record<string, unknown>;
    try { args = JSON.parse(rawArguments) as Record<string, unknown>; }
    catch { return { error: '도구 인자가 JSON이 아닙니다.' }; }
    if (name === 'tower_api') return this.towerApi(args, turn);
    if (name === 'tower_query') return this.towerQuery(args);
    if (name === 'session_read') return this.sessionRead(args, turn);
    if (name === 'show_session') return this.showSession(args, turn);
    return { error: `알 수 없는 도구: ${name}` };
  }

  private async towerApi(args: Record<string, unknown>, turn: Turn): Promise<unknown> {
    const { settings: store, journal, room, tower } = this.options;
    const guards = store.current().guards;
    let target: ApiTarget;
    try { target = apiTarget(String(args.method), String(args.path), typeof args.node === 'string' && args.node ? args.node : undefined); }
    catch (error) { return { error: (error as Error).message }; }
    // With a cap set, a change counts every piece of work it stops (closing a session also cancels its queued runs).
    const affected = target.irreversible && guards.maxIrreversiblePerTurn > 0 ? await this.affected(target) : 1;
    if (affected === undefined) return { error: '이 작업이 멈추게 할 일을 확인하지 못해 보내지 않았습니다(작업 수 제한이 켜져 있음). 잠시 뒤 다시 시도하세요.' };
    const refusal = refusalFor(guards, turn.scope, target, affected);
    if (refusal) return { error: refusal };
    const given = target.method === 'POST' ? (args.body && typeof args.body === 'object' ? args.body as Record<string, unknown> : {}) : undefined;
    let body: unknown = given;
    if (body !== undefined && guards.hideSecrets) {
      try { body = this.vault.reveal(body); } catch (error) { return { error: (error as Error).message }; }
    }
    if (!target.write) {
      const response = await tower.call(target.method, target.path, body, { write: false, signal: turn.abort.signal });
      return this.answer(target, response);
    }
    const print = fingerprint(target.method, target.path, given);
    // The same change again in one request is never sent twice: not after it ran, and not when whether it ran is unknown.
    const repeated = journal.calls.find(call => call.turnId === turn.id && call.fingerprint === print && (call.state === 'succeeded' || call.state === 'uncertain' || call.state === 'sending'));
    if (repeated?.state === 'succeeded') return { state: 'already-done', note: '이번 요청에서 같은 내용을 이미 보냈습니다. 다시 보내지 않았습니다.', summary: repeated.summary };
    if (repeated) return { state: 'uncertain', note: '같은 내용을 이미 보냈고 결과를 알 수 없습니다. 다시 보내지 않았습니다. 상태를 확인하세요.' };
    if (target.node) await this.paceRemote(target.node, turn.abort.signal);
    // A stop that came while this call was being prepared: nothing has gone out, so nothing does.
    if (turn.abort.signal.aborted) return { error: '중지되어 보내지 않았습니다.' };
    if (target.irreversible) turn.scope.irreversible += affected;
    const headers: Record<string, string> = target.node ? { 'X-Tower-Request-Id': uuidv7() } : {};
    if (target.local === '/api/auto-prompts' && body && typeof body === 'object' && !(body as Record<string, unknown>).requestId) (body as Record<string, unknown>).requestId = randomUUID();
    const entry = room.add({ kind: 'action', turnId: turn.id, method: target.method, path: target.path, ...(target.node ? { node: target.node } : {}), state: 'sending', write: true });
    const record: CallRecord = { id: randomUUID(), turnId: turn.id, inputIds: turn.inputs.map(item => item.id), method: target.method, path: target.path, ...(target.node ? { node: target.node } : {}), fingerprint: print, state: 'sending', at: new Date().toISOString(), entryId: entry.id };
    journal.calls.push(record);
    // On disk before it goes out: after a restart, a record still "sending" means the change may have happened.
    await journal.save('calls');
    if (turn.abort.signal.aborted) {
      record.state = 'failed';
      record.summary = '중지되어 보내지 않음';
      await journal.save('calls');
      this.updateAction(record);
      return { error: '중지되어 보내지 않았습니다.' };
    }
    // A change is not cut off by "stop thinking": it finishes and is recorded.
    const response = await tower.call('POST', target.path, body, { write: true, headers });
    record.state = response.state;
    record.summary = this.hideText(summary(response));
    await journal.save('calls');
    this.updateAction(record);
    if (response.state === 'succeeded') await this.watch(target, given, response.body);
    const answer = this.answer(target, response) as Record<string, unknown>;
    return response.state === 'uncertain' ? { ...answer, note: '결과를 알 수 없습니다. 다시 보내지 말고 상태를 확인하세요.' } : answer;
  }

  /** Text about to be kept (the conversation, records) or read by the model, with secrets replaced when that is on. */
  private hideText(text: string): string {
    return this.options.settings.current().guards.hideSecrets ? this.vault.hide(text) : text;
  }

  /** How much work an irreversible change stops: closing a session also cancels its queued runs. Unknown when Tower cannot say. */
  private async affected(target: ApiTarget): Promise<number | undefined> {
    const closing = /^\/api\/sessions\/([^/]+)\/close$/.exec(target.local);
    if (!closing) return 1;
    const response = await this.options.tower.call('GET', target.node ? `/api/nodes/${target.node}/snapshot` : '/api/snapshot', undefined, { write: false });
    if (response.state !== 'succeeded' || !Array.isArray((response.body as Snapshot)?.runs)) return undefined;
    const id = decodeURIComponent(closing[1]);
    return 1 + ((response.body as Snapshot).runs ?? []).filter(run => run.sessionId === id && run.status === 'queued').length;
  }

  /**
   * A joined computer counts changes per controlling computer, shared with the owner's pages there; the master keeps
   * to half of that budget so the pages always have room.
   */
  private async paceRemote(node: string, signal: AbortSignal): Promise<void> {
    const window = 60_000;
    const recent = (this.remoteWrites.get(node) ?? []).filter(at => Date.now() - at < window);
    if (recent.length >= REMOTE_WRITES_PER_MINUTE) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, window - (Date.now() - recent[0]) + 10);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
    }
    this.remoteWrites.set(node, [...recent.filter(at => Date.now() - at < window), Date.now()]);
  }

  private answer(target: ApiTarget, response: TowerResponse): Record<string, unknown> {
    const guards = this.options.settings.current().guards;
    const body = guards.hideSecrets ? this.vault.hideInResponse(target.route, response.body) : response.body;
    return { status: response.status, state: response.state, body };
  }

  private updateAction(call: CallRecord): void {
    const entry = this.options.room.get(call.entryId);
    if (entry?.data.kind === 'action') this.options.room.update(entry.id, { ...entry.data, state: call.state, ...(call.summary ? { summary: call.summary } : {}) });
  }

  /** A quick read-only SQL question over the live state; texts pass the same secret hiding as everything else. */
  private async towerQuery(args: Record<string, unknown>): Promise<unknown> {
    const { live, readDb, room, journal } = this.options;
    if (!live || !readDb) return { error: '빠른 조회를 쓸 수 없습니다. tower_api로 조회하세요.' };
    if (!await live.fresh()) return { error: 'Tower의 현재 상태를 받지 못했습니다. 잠시 뒤 다시 하거나 tower_api로 조회하세요.' };
    const conversation: Table = { name: 'conversation', columns: ['order_no', 'at', 'kind', 'text'], rows: room.recent(200).map(entry => [entry.order, entry.at, entry.data.kind,
      'text' in entry.data ? this.hideText(entry.data.text).slice(0, 500) : entry.data.kind === 'task' ? this.hideText(entry.data.title) : entry.data.kind === 'action' ? `${entry.data.method} ${entry.data.path} ${entry.data.state}` : null]) };
    const delegated: Table = { name: 'delegated', columns: ['id', 'title', 'state', 'session_id', 'node', 'created_at'], rows: journal.tasks.map(task => [task.id, this.hideText(task.title), task.state, task.sessionId ?? null, task.node ?? null, task.createdAt]) };
    const signature = `${live.version()}:${room.lastOrder()}:${journal.tasks.map(task => task.state).join(',')}`;
    try {
      const result = await readDb.query(String(args.sql ?? ''), signature, () => tablesFrom(live.snapshot(), live.nodeSnapshots(), text => this.hideText(text), [conversation, delegated]));
      const missing = live.missing();
      return { asOf: new Date().toISOString(), ...(missing.length ? { missingComputers: missing, note: 'These joined computers have no current data here; their rows are missing.' } : {}), ...result };
    } catch (error) { return { error: (error as Error).message }; }
  }

  private async sessionRead(args: Record<string, unknown>, turn: Turn): Promise<unknown> {
    const id = typeof args.sessionId === 'string' ? args.sessionId : '';
    if (!id) return { error: 'sessionId가 필요합니다.' };
    const limit = typeof args.limit === 'number' ? Math.min(Math.max(Math.floor(args.limit), 1), 60) : 20;
    const target = apiTarget('GET', `/api/sessions/${encodeURIComponent(id)}?limit=${limit}`, typeof args.node === 'string' && args.node ? args.node : undefined);
    const response = await this.options.tower.call('GET', target.path, undefined, { write: false, signal: turn.abort.signal });
    if (response.state !== 'succeeded') return this.answer(target, response);
    const detail = response.body as SessionDetail;
    const compact = {
      session: { id: detail.session?.id, title: detail.session?.customTitle || detail.session?.title, cwd: detail.session?.cwd, status: detail.session?.status, provider: detail.session?.provider },
      messages: (detail.messages ?? []).filter(message => message.role === 'user' || message.role === 'assistant').map(message => ({ role: message.role, at: message.timestamp, text: truncate(message.text, 2000) })),
      hasMore: detail.hasMore,
    };
    return this.answer(target, { ...response, body: compact });
  }

  private showSession(args: Record<string, unknown>, turn: Turn): unknown {
    if (!this.options.settings.current().showResults) return { result: 'disabled', note: '설정에서 화면 열기가 꺼져 있습니다.' };
    if (!turn.tabId) return { result: 'no-page', note: '소유자가 보고 있는 화면을 알 수 없습니다.' };
    const sessionId = typeof args.sessionId === 'string' ? args.sessionId : '';
    const node = typeof args.node === 'string' && /^[a-f0-9]{32}$/.test(args.node) ? args.node : undefined;
    if (!sessionId) return { error: 'sessionId가 필요합니다.' };
    this.options.room.broadcast({ type: 'directive', seq: 0, directive: { id: randomUUID(), kind: 'openSession', sessionId, ...(node ? { node } : {}), tabId: turn.tabId, expiresAt: Date.now() + 30_000 } });
    return { result: 'requested' };
  }

  /** Starts watching work a successful call created, so its end is reported. */
  private async watch(target: ApiTarget, body: Record<string, unknown> | undefined, answer: unknown): Promise<void> {
    const value = (answer ?? {}) as { session?: { id?: string }; run?: { id?: string; sessionId?: string }; job?: { id?: string } };
    const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
    const title = truncate(typeof body?.title === 'string' && body.title ? body.title : prompt || target.local, 80);
    let task: Omit<TaskRecord, 'id' | 'entryId' | 'createdAt' | 'state' | 'title'> | undefined;
    const message = /^\/api\/sessions\/([^/]+)\/messages$/.exec(target.local);
    if (target.local === '/api/sessions' && value.session?.id) task = { sessionId: value.session.id, ...(value.run?.id ? { runId: value.run.id } : {}) };
    else if (message && value.run?.id) task = { sessionId: value.run.sessionId ?? decodeURIComponent(message[1]), runId: value.run.id };
    else if (target.local === '/api/auto-prompts' && value.job?.id) task = { jobId: value.job.id };
    if (!task) return;
    const record: TaskRecord = { id: randomUUID(), entryId: '', ...task, ...(target.node ? { node: target.node } : {}), title, ...(prompt ? { prompt } : {}), state: 'running', createdAt: new Date().toISOString() };
    record.entryId = this.options.room.add({ kind: 'task', title, state: 'running', ...(record.sessionId ? { sessionId: record.sessionId } : {}), ...(record.runId ? { runId: record.runId } : {}), ...(record.jobId ? { jobId: record.jobId } : {}), ...(record.node ? { node: record.node } : {}) }).id;
    this.options.journal.tasks.push(record);
    await this.options.journal.save('tasks');
    this.broadcastOverview();
  }

  /** Looks at the work being watched and reports what ended, once each. */
  private async pollTasks(): Promise<void> {
    const running = this.options.journal.tasks.filter(task => task.state === 'running');
    if (this.polling || this.closed || !running.length || !this.options.tower.hasCredentials()) return;
    this.polling = true;
    try {
      const nodes = [...new Set(running.map(task => task.node ?? ''))];
      // Following the live stream (as one more page would) instead of asking for whole snapshots every few seconds.
      const local = await this.options.live?.fresh();
      for (const node of nodes) {
        let snapshot = node ? this.options.live?.node(node) : local;
        if (!snapshot) {
          const path = node ? `/api/nodes/${node}/snapshot` : '/api/snapshot';
          const response = await this.options.tower.call('GET', path, undefined, { write: false });
          if (response.state !== 'succeeded') continue;
          snapshot = response.body as Snapshot;
        }
        for (const task of running.filter(item => (item.node ?? '') === node)) await this.check(task, snapshot);
      }
    } catch (error) {
      console.error(`Master could not check delegated work: ${error instanceof Error ? error.message : String(error)}`);
    } finally { this.polling = false; }
  }

  private async check(task: TaskRecord, snapshot: Snapshot): Promise<void> {
    let ended: MasterTaskState | undefined;
    if (task.jobId && !task.runId) {
      const job = (snapshot.autoPrompts ?? []).find((item: AutoPromptJob) => item.id === task.jobId);
      if (job?.runId && job.sessionId) { task.runId = job.runId; task.sessionId = job.sessionId; await this.options.journal.save('tasks'); }
      else if (job && (job.status === 'error' || job.status === 'cancelled')) ended = job.status;
    }
    let run: Run | undefined;
    if (!ended && task.runId) {
      run = (snapshot.runs ?? []).find(item => item.id === task.runId);
      if (run && (run.status === 'completed' || run.status === 'error' || run.status === 'cancelled')) ended = run.status;
    }
    if (!ended && Date.now() - Date.parse(task.createdAt) > TASK_UNKNOWN_MS && !run && !(task.jobId && !task.runId && (snapshot.autoPrompts ?? []).some(item => item.id === task.jobId))) ended = 'unknown';
    if (!ended) return;
    // The answer is read while the task still counts as running, so the host stays until the report is saved.
    const found = task.sessionId && ended !== 'unknown' ? await this.finalAnswer(task, run).catch(() => undefined) : undefined;
    const answer = found?.text !== undefined ? this.hideText(found.text) : undefined;
    const text = `Delegated work ended: "${task.title}" — ${ended}${task.sessionId ? ` (session ${task.sessionId}${task.node ? ` on node ${task.node}` : ''})` : ''}.`
      + (answer ? `\nIts answer to your request:\n${truncate(answer, 3000)}` : run?.error ? `\nError: ${truncate(run.error, 500)}` : '\nIts answer could not be read; the owner can open the session.')
      + (found?.followedBy ? '\n(The session received more messages after this; it may have moved on.)' : '');
    // One report per task, even if a restart makes this run twice: the inbox is written before the task is marked.
    if (!this.options.journal.inbox.some(item => item.taskId === task.id)) {
      this.options.journal.inbox.push({ id: randomUUID(), kind: 'event', text: this.hideText(text), local: false, at: new Date().toISOString(), state: 'queued', retries: 0, taskId: task.id });
    }
    task.state = ended;
    task.reportedAt = new Date().toISOString();
    await this.options.journal.save('inbox', 'tasks');
    const entry = this.options.room.get(task.entryId);
    if (entry?.data.kind === 'task') this.options.room.update(entry.id, { ...entry.data, state: ended, ...(task.sessionId ? { sessionId: task.sessionId } : {}), ...(task.runId ? { runId: task.runId } : {}), ...(answer ? { answer: truncate(answer, 600) } : {}) });
    this.broadcastOverview();
    this.pump();
  }

  /**
   * The answer the watched run gave: the assistant's last words after the run's own request (found by its text) and
   * before the next message the session received. It waits until the session's history has caught up with the run's
   * end. When the request cannot be found, there is no answer rather than a guess.
   */
  private async finalAnswer(task: TaskRecord, run: Run | undefined): Promise<{ text: string; followedBy: boolean } | undefined> {
    const prompt = normalize(run?.prompt ?? task.prompt ?? '');
    if (!prompt) return undefined;
    const path = `${task.node ? `/api/nodes/${task.node}` : '/api'}/sessions/${encodeURIComponent(task.sessionId!)}?limit=200`;
    // The run's request is written to its history between being queued and finishing (or shortly after it started).
    const requested = Date.parse(run?.createdAt ?? task.createdAt) - 2000;
    const finished = run?.finishedAt ? Date.parse(run.finishedAt) : undefined;
    const latest = run?.startedAt ? Date.parse(run.startedAt) + 120_000 : (finished ?? Date.now()) + 2000;
    for (let attempt = 0; attempt < 10; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 1000));
      const response = await this.options.tower.call('GET', path, undefined, { write: false });
      if (response.state !== 'succeeded') return undefined;
      const detail = response.body as SessionDetail;
      const updated = Date.parse(detail.session?.updatedAt ?? '');
      // The history must already hold the run's end; until then, what it shows may be an earlier answer.
      const caughtUp = finished === undefined ? undefined : updated >= finished - 1000;
      if (caughtUp === false) continue;
      // Tool calls fill most of a history, so a long run's request can be pages back: read back past the run's start.
      const collected = [...(detail.messages ?? [])];
      let before = detail.hasMore ? detail.nextBefore : undefined;
      const pastStart = () => collected.some(message => Date.parse(message.timestamp) < requested);
      let unread = false;
      for (let page = 1; before !== undefined && !pastStart(); page++) {
        if (page >= 5) { unread = true; break; }
        const older = await this.options.tower.call('GET', `${path}&before=${before}`, undefined, { write: false });
        if (older.state !== 'succeeded') { unread = true; break; }
        const earlier = older.body as SessionDetail;
        collected.unshift(...(earlier.messages ?? []));
        before = earlier.hasMore ? earlier.nextBefore : undefined;
      }
      // Part of the run's time was not read: a request found in the rest might not be the only one, so no guess.
      if (unread) return undefined;
      const messages = collected.sort((a: ChatMessage, b: ChatMessage) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
      const candidates = messages.flatMap((message, index) => message.role === 'user' && sameRequest(message.text, prompt)
        && Date.parse(message.timestamp) >= requested && Date.parse(message.timestamp) <= latest ? [index] : []);
      // Two requests with the same text in that window cannot be told apart: no answer rather than a guess.
      if (candidates.length > 1) return undefined;
      const request = candidates[0] ?? -1;
      if (request >= 0) {
        const next = messages.findIndex((message, index) => index > request && message.role === 'user');
        const answer = messages.slice(request + 1, next < 0 ? messages.length : next).reverse().find(message => message.role === 'assistant' && message.text.trim());
        if (answer) return { text: answer.text, followedBy: next >= 0 };
      }
      if (caughtUp) return undefined;
    }
    return undefined;
  }

  private broadcastOverview(): void { this.options.room.broadcast({ type: 'overview', seq: 0, overview: this.overview() }); }
}

function truncate(text: string, length: number): string { return text.length > length ? `${text.slice(0, length)}…` : text; }
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
/** A history message is the run's request when it is the request's whole text (a native history may add attachments after it). */
function sameRequest(message: string, prompt: string): boolean {
  const text = normalize(message);
  return text === prompt || text.startsWith(`${prompt} `);
}
function summary(response: TowerResponse): string {
  const body = response.body as Record<string, unknown> | null;
  const error = body && typeof body === 'object' && typeof body.error === 'string' ? body.error : undefined;
  return truncate(error ?? `HTTP ${response.status}`, 300);
}
/** A time-ordered UUID, which a joined computer requires to run a new request at most once. */
function uuidv7(now = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let time = now;
  for (let index = 5; index >= 0; index--) { bytes[index] = time % 256; time = Math.floor(time / 256); }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
