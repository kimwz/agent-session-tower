import { randomUUID } from 'node:crypto';
import type { SessionDetail } from '../../shared/types.js';
import { apiTarget, type ApiTarget } from './api-target.js';
import type { LiveState } from './live-state.js';
import { READ_SCHEMA, tablesFrom, type ReadDatabase, type Table } from './read-db.js';
import type { TowerClient, TowerResponse } from './tower-client.js';

const MAX_TOOL_OUTPUT = 12_000;
/** A tool call ends by then, before its caller (the relay and the CLI, five minutes) gives up on it. */
const TOOL_MS = 4 * 60_000;
const REMOTE_WRITES_PER_MINUTE = 30;
/** How long terminal_read listens: the terminal's kept output arrives at once, then new output for the rest. */
const TERMINAL_READ_MS = 1_500;
const TERMINAL_OUTPUT = 4_000;
export const NODE_ID = /^[a-f0-9]{32}$/;

/** Tools that use Tower as the owner's pages do: the master's, and those of the owner's own agents on this computer. */
export const TOWER_TOOLS = [
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
  { name: 'terminal_read', description: 'Read the recent output of a terminal (find terminals with GET /api/workspace/terminals?cwd=).',
    inputSchema: { type: 'object', properties: { terminalId: { type: 'string' }, node: { type: 'string' } }, required: ['terminalId'], additionalProperties: false } },
];

export interface TowerToolsOptions {
  tower: TowerClient;
  live?: LiveState;
  readDb?: ReadDatabase;
  /** Work a call started (a session, a message, an Auto Prompt), so its end is reported. */
  started(target: ApiTarget, body: Record<string, unknown> | undefined, answer: unknown): Promise<void>;
  /** The work handed out, for tower_query. */
  delegated(): Table;
  toolMs?: number;
  /** Routes tower_api may not call (the master's own list unless given). */
  refused?: readonly RegExp[];
  /** Says why a route is not called through tower_api, if it is not. */
  elsewhere?(target: ApiTarget): string | undefined;
}

/** What the Tower tools do. They call Tower like a page; nothing is limited beyond what the page may do. */
export class TowerTools {
  private readonly remoteWrites = new Map<string, number[]>();

  constructor(private readonly options: TowerToolsOptions) {}

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.options.tower.hasCredentials()) return { error: 'Tower 웹에 아직 연결되지 않았습니다. 잠시 뒤 다시 하세요.' };
    const signal = AbortSignal.timeout(this.options.toolMs ?? TOOL_MS);
    if (name === 'tower_api') return this.towerApi(args, signal);
    if (name === 'tower_query') return this.towerQuery(args);
    if (name === 'session_read') return this.sessionRead(args, signal);
    if (name === 'terminal_read') return this.terminalRead(args);
    return { error: `알 수 없는 도구: ${name}` };
  }

  private async towerApi(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    let target: ApiTarget;
    try { target = apiTarget(String(args.method), String(args.path), typeof args.node === 'string' && args.node ? args.node : undefined, this.options.refused); }
    catch (error) { return { error: (error as Error).message }; }
    const elsewhere = this.options.elsewhere?.(target);
    if (elsewhere) return { error: elsewhere };
    const body = target.method === 'POST' ? (args.body && typeof args.body === 'object' && !Array.isArray(args.body) ? { ...args.body as Record<string, unknown> } : {}) : undefined;
    if (!target.write) return answer(await this.options.tower.call(target.method, target.path, body, { write: false, signal })
      .catch((error: unknown): TowerResponse => ({ status: 0, body: { error: error instanceof Error ? error.message : String(error) }, state: 'failed' })));
    if (target.node) await this.paceRemote(target.node, signal);
    // Out of time before anything went out: nothing was sent.
    if (signal.aborted) return { error: '시간이 오래 걸려 보내지 않았습니다. 다시 시도하세요.' };
    // A joined computer runs a new request at most once by its ID; an Auto Prompt needs its own.
    const headers: Record<string, string> = target.node ? { 'X-Tower-Request-Id': uuidv7() } : {};
    if (target.local === '/api/auto-prompts' && body && !body.requestId) body.requestId = randomUUID();
    // Past the deadline a change still waiting for the web does not go; one on its way is not cut off.
    const response = await this.options.tower.call('POST', target.path, body, { write: true, headers, beforeSend: signal })
      .catch((error: unknown): TowerResponse => ({ status: 0, body: { error: error instanceof Error ? error.message : String(error) }, state: 'uncertain' }));
    if (response.state === 'succeeded') await this.options.started(target, body, response.body).catch(() => {});
    const result = answer(response);
    return response.state === 'uncertain' ? { ...result, note: '결과를 알 수 없습니다. 다시 보내지 말고 상태를 확인하세요.' } : result;
  }

  /**
   * A joined computer counts changes per controlling computer, shared with the owner's pages there; these tools keep
   * to part of that budget so the pages always have room.
   */
  private async paceRemote(node: string, signal: AbortSignal): Promise<void> {
    const window = 60_000;
    const recent = (this.remoteWrites.get(node) ?? []).filter(at => Date.now() - at < window);
    if (recent.length >= REMOTE_WRITES_PER_MINUTE) await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, window - (Date.now() - recent[0]) + 10);
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    if (signal.aborted) return;
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


  private async sessionRead(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const id = typeof args.sessionId === 'string' ? args.sessionId : '';
    if (!id) return { error: 'sessionId가 필요합니다.' };
    const limit = typeof args.limit === 'number' ? Math.min(Math.max(Math.floor(args.limit), 1), 60) : 20;
    let target: ApiTarget;
    try { target = apiTarget('GET', `/api/sessions/${encodeURIComponent(id)}?limit=${limit}`, typeof args.node === 'string' && args.node ? args.node : undefined); }
    catch (error) { return { error: (error as Error).message }; }
    const response = await this.options.tower.call('GET', target.path, undefined, { write: false, signal })
      .catch((error: unknown): TowerResponse => ({ status: 0, body: { error: error instanceof Error ? error.message : String(error) }, state: 'failed' }));
    if (response.state !== 'succeeded') return answer(response);
    const detail = response.body as SessionDetail;
    return answer({ ...response, body: {
      session: { id: detail.session?.id, title: detail.session?.customTitle || detail.session?.title, cwd: detail.session?.cwd, status: detail.session?.status, provider: detail.session?.provider },
      messages: (detail.messages ?? []).filter(message => message.role === 'user' || message.role === 'assistant').map(message => ({ role: message.role, at: message.timestamp, text: truncate(message.text, 2000) })),
      hasMore: detail.hasMore,
    } });
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

export function truncate(text: string, length: number): string { return text.length > length ? `${text.slice(0, length)}…` : text; }

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

/** A terminal's output as plain text: escape sequences removed, carriage returns as line ends. */
function plainTerminal(output: string): string {
  return output
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r+\n/g, '\n').replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}
