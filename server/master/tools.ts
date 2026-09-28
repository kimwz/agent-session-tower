import { randomUUID } from 'node:crypto';
import { MASTER_PANELS, type MasterDirectiveResult, type MasterFilter, type MasterPanel, type MasterScreenCommand, type MasterStreamEvent } from '../../shared/master.js';
import type { SessionDetail } from '../../shared/types.js';
import { apiTarget, type ApiTarget } from './api-target.js';
import type { LiveState } from './live-state.js';
import { READ_SCHEMA, tablesFrom, type ReadDatabase, type Table } from './read-db.js';
import type { TowerClient, TowerResponse } from './tower-client.js';

const MAX_TOOL_OUTPUT = 12_000;
const REMOTE_WRITES_PER_MINUTE = 30;
/** How long a screen command waits for the page to say it was done. */
const ACK_MS = 5_000;
/** A page that said it shows the master within this time is where screen commands go. */
const PRESENCE_MS = 2 * 60_000;
/** How long terminal_read listens: the terminal's kept output arrives at once, then new output for the rest. */
const TERMINAL_READ_MS = 1_500;
const TERMINAL_OUTPUT = 4_000;
const NODE_ID = /^[a-f0-9]{32}$/;

/** The tools the master session gets from Tower, besides its own and Tower's MCP operations. */
export const MASTER_TOOLS = [
  { name: 'tower_api', description: 'Call one of Tower\'s HTTP routes (see the Routes in your guide), exactly as the owner\'s pages do. For a joined computer pass node.',
    inputSchema: { type: 'object', properties: {
      method: { type: 'string', enum: ['GET', 'POST'] },
      path: { type: 'string', description: 'Starts with /api/, query string included for GET.' },
      body: { type: 'object', description: 'JSON body for POST.', additionalProperties: true },
      node: { type: 'string', description: '32-hex id of a joined computer, or omit for this computer.' },
    }, required: ['method', 'path'], additionalProperties: false } },
  { name: 'tower_query', description: `Run one read-only SQL SELECT over Tower's current state. The fastest way to look things up.\n${READ_SCHEMA}`,
    inputSchema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'], additionalProperties: false } },
  { name: 'session_read', description: 'Read the latest messages of a session (compact), on this or a joined computer.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, node: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 60 } }, required: ['sessionId'], additionalProperties: false } },
  { name: 'ui', description: 'Do something on the owner\'s screen, in the tab showing you, with the page\'s own controls. The result says whether the page did it.',
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['openSession', 'close', 'openPanel', 'filter', 'setPreference'], description: 'openSession: show a conversation. close: close the open conversation. openPanel: open one of the page\'s panels. filter: set the sidebar filters. setPreference: language or chat text size.' },
      sessionId: { type: 'string' },
      node: { type: 'string', description: '32-hex id of the joined computer the session, folder or Auto Prompt is on.' },
      panel: { type: 'string', enum: [...MASTER_PANELS], description: 'sessions: the session list. newSession/autoPrompt open their dialogs (cwd, and for newSession title/prompt, prefill them).' },
      cwd: { type: 'string' }, title: { type: 'string' }, prompt: { type: 'string' },
      filter: { type: 'object', additionalProperties: false, properties: {
        reset: { type: 'boolean', description: 'Clear the search and filters first.' }, query: { type: 'string' },
        provider: { type: 'string', enum: ['all', 'claude', 'codex'] }, status: { type: 'string', enum: ['all', 'working', 'idle', 'completed', 'error'] },
        period: { type: 'string', enum: ['1', '7', '30', 'all'], description: 'Days of activity shown.' },
        project: { type: 'string', description: 'A folder (cwd); on a joined computer, give computer too.' },
        computer: { type: 'string', description: '"all", "local" or a joined computer\'s id.' },
        closed: { type: 'boolean', description: 'Show closed sessions instead of open ones.' }, showHidden: { type: 'boolean', description: 'Show hidden folders on the canvas.' },
      } },
      language: { type: 'string', enum: ['ko', 'en'] },
      chatFontSize: { type: 'integer', minimum: 11, maximum: 22 },
    }, required: ['action'], additionalProperties: false } },
  { name: 'terminal_read', description: 'Read the recent output of a terminal (find terminals with GET /api/workspace/terminals?cwd=).',
    inputSchema: { type: 'object', properties: { terminalId: { type: 'string' }, node: { type: 'string' } }, required: ['terminalId'], additionalProperties: false } },
];

export interface MasterToolsOptions {
  tower: TowerClient;
  live?: LiveState;
  readDb?: ReadDatabase;
  /** Sends a screen command to the pages. */
  broadcast(event: MasterStreamEvent): void;
  /** Work a call started (a session, a message, an Auto Prompt), so its end is reported. */
  started(target: ApiTarget, body: Record<string, unknown> | undefined, answer: unknown): Promise<void>;
  /** The work the master handed out, for tower_query. */
  delegated(): Table;
  ackMs?: number;
}

/**
 * What the master session's `tower_master` tools do, run here in the master host, which calls Tower like a page.
 * Nothing is limited: the master may do whatever the owner's pages can.
 */
export class MasterTools {
  private readonly acks = new Map<string, (value: { result: MasterDirectiveResult; note?: string }) => void>();
  private readonly remoteWrites = new Map<string, number[]>();
  private tab?: { id: string; at: number };

  constructor(private readonly options: MasterToolsOptions) {}

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.options.tower.hasCredentials()) return { error: 'Tower 웹에 아직 연결되지 않았습니다. 잠시 뒤 다시 하세요.' };
    if (name === 'tower_api') return this.towerApi(args);
    if (name === 'tower_query') return this.towerQuery(args);
    if (name === 'session_read') return this.sessionRead(args);
    if (name === 'ui') return this.ui(args);
    if (name === 'terminal_read') return this.terminalRead(args);
    return { error: `알 수 없는 도구: ${name}` };
  }

  /** A page showing the master says so, and screen commands go to it. */
  present(tabId: string): void { this.tab = { id: tabId, at: Date.now() }; }

  /** The page's word on a screen command. */
  ack(id: string, result: MasterDirectiveResult, note?: string): boolean {
    const waiting = this.acks.get(id);
    waiting?.({ result, ...(note ? { note } : {}) });
    return Boolean(waiting);
  }

  private async towerApi(args: Record<string, unknown>): Promise<unknown> {
    let target: ApiTarget;
    try { target = apiTarget(String(args.method), String(args.path), typeof args.node === 'string' && args.node ? args.node : undefined); }
    catch (error) { return { error: (error as Error).message }; }
    const body = target.method === 'POST' ? (args.body && typeof args.body === 'object' && !Array.isArray(args.body) ? { ...args.body as Record<string, unknown> } : {}) : undefined;
    if (!target.write) return answer(await this.options.tower.call(target.method, target.path, body, { write: false }));
    if (target.node) await this.paceRemote(target.node);
    // A joined computer runs a new request at most once by its ID; an Auto Prompt needs its own.
    const headers: Record<string, string> = target.node ? { 'X-Tower-Request-Id': uuidv7() } : {};
    if (target.local === '/api/auto-prompts' && body && !body.requestId) body.requestId = randomUUID();
    const response = await this.options.tower.call('POST', target.path, body, { write: true, headers })
      .catch((error: unknown): TowerResponse => ({ status: 0, body: { error: error instanceof Error ? error.message : String(error) }, state: 'uncertain' }));
    if (response.state === 'succeeded') await this.options.started(target, body, response.body).catch(() => {});
    const result = answer(response);
    return response.state === 'uncertain' ? { ...result, note: '결과를 알 수 없습니다. 다시 보내지 말고 상태를 확인하세요.' } : result;
  }

  /**
   * A joined computer counts changes per controlling computer, shared with the owner's pages there; the master keeps
   * to half of that budget so the pages always have room.
   */
  private async paceRemote(node: string): Promise<void> {
    const window = 60_000;
    const recent = (this.remoteWrites.get(node) ?? []).filter(at => Date.now() - at < window);
    if (recent.length >= REMOTE_WRITES_PER_MINUTE) await new Promise(resolve => setTimeout(resolve, window - (Date.now() - recent[0]) + 10));
    this.remoteWrites.set(node, [...recent.filter(at => Date.now() - at < window), Date.now()]);
  }

  /** A quick read-only SQL question over the live state. */
  private async towerQuery(args: Record<string, unknown>): Promise<unknown> {
    const { live, readDb } = this.options;
    if (!live || !readDb) return { error: '빠른 조회를 쓸 수 없습니다. tower_api로 조회하세요.' };
    if (!await live.fresh()) return { error: 'Tower의 현재 상태를 받지 못했습니다. 잠시 뒤 다시 하거나 tower_api로 조회하세요.' };
    const delegated = this.options.delegated();
    const signature = `${live.version()}:${delegated.rows.map(row => row[2]).join(',')}`;
    try {
      const result = await readDb.query(String(args.sql ?? ''), signature, () => tablesFrom(live.snapshot(), live.nodeSnapshots(), text => text, [delegated]));
      const missing = live.missing();
      return { asOf: new Date().toISOString(), ...(missing.length ? { missingComputers: missing, note: 'These joined computers have no current data here; their rows are missing.' } : {}), ...result };
    } catch (error) { return { error: (error as Error).message }; }
  }

  private async sessionRead(args: Record<string, unknown>): Promise<unknown> {
    const id = typeof args.sessionId === 'string' ? args.sessionId : '';
    if (!id) return { error: 'sessionId가 필요합니다.' };
    const limit = typeof args.limit === 'number' ? Math.min(Math.max(Math.floor(args.limit), 1), 60) : 20;
    let target: ApiTarget;
    try { target = apiTarget('GET', `/api/sessions/${encodeURIComponent(id)}?limit=${limit}`, typeof args.node === 'string' && args.node ? args.node : undefined); }
    catch (error) { return { error: (error as Error).message }; }
    const response = await this.options.tower.call('GET', target.path, undefined, { write: false });
    if (response.state !== 'succeeded') return answer(response);
    const detail = response.body as SessionDetail;
    return answer({ ...response, body: {
      session: { id: detail.session?.id, title: detail.session?.customTitle || detail.session?.title, cwd: detail.session?.cwd, status: detail.session?.status, provider: detail.session?.provider },
      messages: (detail.messages ?? []).filter(message => message.role === 'user' || message.role === 'assistant').map(message => ({ role: message.role, at: message.timestamp, text: truncate(message.text, 2000) })),
      hasMore: detail.hasMore,
    } });
  }

  /** A screen command in the tab showing the master, done by the page with its own controls. */
  private async ui(args: Record<string, unknown>): Promise<unknown> {
    let command: MasterScreenCommand;
    try { command = screenCommand(args); } catch (error) { return { error: (error as Error).message }; }
    const tab = this.tab && Date.now() - this.tab.at < PRESENCE_MS ? this.tab.id : undefined;
    if (!tab) return { result: 'no-page', note: 'No page of the owner shows the master now, so nothing was shown.' };
    const id = randomUUID();
    const reply = await new Promise<{ result: MasterDirectiveResult; note?: string } | undefined>(resolve => {
      const finish = (value: { result: MasterDirectiveResult; note?: string } | undefined) => { clearTimeout(timer); this.acks.delete(id); resolve(value); };
      const timer = setTimeout(() => finish(undefined), this.options.ackMs ?? ACK_MS);
      this.acks.set(id, finish);
      this.options.broadcast({ type: 'directive', seq: 0, directive: { ...command, id, tabId: tab, expiresAt: Date.now() + 30_000 } });
    });
    return reply ? { result: reply.result, ...(reply.note ? { note: truncate(reply.note, 300) } : {}) } : { result: 'no-answer', note: 'The page did not confirm; it may be closed or in the background.' };
  }

  private async terminalRead(args: Record<string, unknown>): Promise<unknown> {
    const id = typeof args.terminalId === 'string' && /^[0-9a-f-]{36}$/.test(args.terminalId) ? args.terminalId : '';
    if (!id) return { error: 'terminalId가 필요합니다. GET /api/workspace/terminals?cwd=로 찾으세요.' };
    const node = typeof args.node === 'string' && args.node ? args.node : undefined;
    if (node && !NODE_ID.test(node)) return { error: '연결된 컴퓨터 ID가 올바르지 않습니다.' };
    const path = `${node ? `/api/nodes/${node}` : '/api'}/workspace/terminals/${id}/events`;
    const listening = new AbortController();
    const timer = setTimeout(() => listening.abort(), TERMINAL_READ_MS);
    let output = '';
    try {
      const stream = await this.options.tower.stream(path, listening.signal);
      await new Promise<void>(resolve => {
        let buffer = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk: string) => {
          buffer += chunk;
          for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (!/^event: output$/m.test(frame)) continue;
            const data = /^data: (.*)$/m.exec(frame)?.[1];
            try { const value = data ? JSON.parse(data) as { data?: unknown } : undefined; if (typeof value?.data === 'string') output += value.data; } catch { /* Not an output frame. */ }
          }
          if (output.length > 262_144) output = output.slice(-131_072);
        });
        stream.once('end', resolve); stream.once('close', resolve); stream.once('error', () => resolve());
      });
    } catch (error) {
      if (!listening.signal.aborted) return { error: `터미널을 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}` };
    } finally { clearTimeout(timer); }
    const text = plainTerminal(output);
    return { terminalId: id, ...(node ? { node } : {}), output: text.length > TERMINAL_OUTPUT ? `…${text.slice(-TERMINAL_OUTPUT)}` : text, ...(text.trim() ? {} : { note: 'No output yet.' }) };
  }
}

function answer(response: TowerResponse): Record<string, unknown> {
  const text = JSON.stringify(response.body ?? null);
  return { status: response.status, state: response.state, body: text.length > MAX_TOOL_OUTPUT ? { truncated: true, text: `${text.slice(0, MAX_TOOL_OUTPUT)}…` } : response.body };
}

function truncate(text: string, length: number): string { return text.length > length ? `${text.slice(0, length)}…` : text; }

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

/** A screen command from the model's arguments, checked field by field. */
export function screenCommand(args: Record<string, unknown>): MasterScreenCommand {
  const refuse = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
  const text = (value: unknown, max: number, name: string) => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length > max) throw refuse(`${name}이(가) 올바르지 않습니다.`);
    return value;
  };
  const node = (value: unknown) => {
    const id = text(value, 32, 'node');
    if (id && !NODE_ID.test(id)) throw refuse('연결된 컴퓨터 ID가 올바르지 않습니다.');
    return id || undefined;
  };
  switch (args.action) {
    case 'openSession': {
      const sessionId = text(args.sessionId, 400, 'sessionId');
      if (!sessionId) throw refuse('sessionId가 필요합니다.');
      const where = node(args.node);
      return { kind: 'openSession', sessionId, ...(where ? { node: where } : {}) };
    }
    case 'close': return { kind: 'close' };
    case 'openPanel': {
      if (!(MASTER_PANELS as readonly unknown[]).includes(args.panel)) throw refuse(`panel은 ${MASTER_PANELS.join(', ')} 중 하나입니다.`);
      const cwd = text(args.cwd, 4096, 'cwd'), title = text(args.title, 200, 'title'), prompt = text(args.prompt, 8000, 'prompt'), where = node(args.node);
      return { kind: 'openPanel', panel: args.panel as MasterPanel, ...(cwd ? { cwd } : {}), ...(where ? { node: where } : {}), ...(title ? { title } : {}), ...(prompt ? { prompt } : {}) };
    }
    case 'filter': {
      const input = args.filter;
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw refuse('filter가 필요합니다.');
      const filter: MasterFilter = {};
      for (const [key, value] of Object.entries(input)) {
        const one = (allowed: readonly string[]) => { if (typeof value !== 'string' || !allowed.includes(value)) throw refuse(`${key} 값이 올바르지 않습니다.`); return value; };
        const flag = () => { if (typeof value !== 'boolean') throw refuse(`${key} 값이 올바르지 않습니다.`); return value; };
        if (key === 'reset') filter.reset = flag();
        else if (key === 'query') filter.query = text(value, 200, 'query') ?? '';
        else if (key === 'provider') filter.provider = one(['all', 'claude', 'codex']) as MasterFilter['provider'];
        else if (key === 'status') filter.status = one(['all', 'working', 'idle', 'completed', 'error']) as MasterFilter['status'];
        else if (key === 'period') filter.period = one(['1', '7', '30', 'all']) as MasterFilter['period'];
        else if (key === 'project') filter.project = text(value, 4096, 'project') ?? '';
        else if (key === 'computer') { const computer = text(value, 32, 'computer'); if (computer !== 'all' && computer !== 'local' && !NODE_ID.test(computer ?? '')) throw refuse('computer 값이 올바르지 않습니다.'); filter.computer = computer; }
        else if (key === 'closed') filter.closed = flag();
        else if (key === 'showHidden') filter.showHidden = flag();
        else throw refuse(`알 수 없는 필터: ${key}`);
      }
      return { kind: 'filter', filter };
    }
    case 'setPreference': {
      const language = args.language === undefined ? undefined : args.language === 'ko' || args.language === 'en' ? args.language : null;
      const size = args.chatFontSize === undefined ? undefined : Number.isInteger(args.chatFontSize) && (args.chatFontSize as number) >= 11 && (args.chatFontSize as number) <= 22 ? args.chatFontSize as number : null;
      if (language === null || size === null || (language === undefined && size === undefined)) throw refuse('language(ko, en) 또는 chatFontSize(11–22)를 주세요.');
      return { kind: 'preference', ...(language ? { language } : {}), ...(size !== undefined ? { chatFontSize: size } : {}) };
    }
  }
  throw refuse('action은 openSession, close, openPanel, filter, setPreference 중 하나입니다.');
}

/** A terminal's output as plain text: escape sequences removed, carriage returns as line ends. */
function plainTerminal(output: string): string {
  return output
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r+\n/g, '\n').replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}
