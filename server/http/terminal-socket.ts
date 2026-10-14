import http2, { type ClientHttp2Session } from 'node:http2';
import { Writable } from 'node:stream';
import type { WebSocket, RawData } from 'ws';
import type { StreamSink } from '../streams/sink.js';
import type { WorkspaceTerminalBackend } from '../workspace-terminals.js';
import { linkRequest } from '../link/transport.js';
import { TowerError, fromStatus, statusOf } from '../../shared/errors.js';

/**
 * One terminal tab's connection: the shell's output, and the keys and sizes the tab sends, on one WebSocket.
 *
 * A browser opens at most six HTTP/1.1 connections to one address and shares them between all its pages there. Each
 * terminal used to hold one of them with its output stream, so a page with a few terminals (and Tower open in another
 * tab) used them all up, and the keys typed next waited for a connection that never came. WebSockets do not count
 * against that limit.
 */

/** Where a socket's shell lives: this computer's terminals, or a joined computer's reached over its link. */
export interface TerminalRelay {
  /** Writes the shell's event stream (server-sent events) into `body` from `cursor` on; rejects when it is not there. */
  events(id: string, body: Writable, cursor: string | undefined): Promise<void>;
  input(id: string, data: unknown): Promise<void>;
  resize(id: string, cols: unknown, rows: unknown): Promise<void>;
}

/** What the page sends: first `hello` with its request token, then keys and sizes. */
type Incoming = { type: 'hello'; token: string; cursor?: string } | { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number };
/** What the page receives: `ready` once listening, the shell's events, and refusals of what it sent. */
export type TerminalSocketMessage =
  | { type: 'ready' }
  | { type: 'output'; data: string; id?: string }
  | { type: 'exit'; exitCode: number }
  | { type: 'error'; status: number; message: string };

/** Close codes a page reads: the shell is gone (closed, exited long ago, or never there), or the hello was refused. */
export const SOCKET_GONE = 4404;
export const SOCKET_REFUSED = 4403;
/** A page sends a key at most 16 KiB at a time, as it did over HTTP. */
export const MAX_SOCKET_MESSAGE = 64 * 1024;
/** Output a page does not read fast enough is not kept without end; the page reconnects from where it got to. */
const MAX_BUFFERED = 4 * 1024 * 1024;
const HELLO_MS = 10_000;
const PING_MS = 25_000;

/** Reads a server-sent event stream into its events, whatever the chunks it arrives in. */
export class SseReader {
  private pending = '';
  push(chunk: string): Array<{ event: string; id?: string; data: string }> {
    this.pending += chunk;
    const events: Array<{ event: string; id?: string; data: string }> = [];
    for (let end = this.pending.indexOf('\n\n'); end >= 0; end = this.pending.indexOf('\n\n')) {
      const block = this.pending.slice(0, end);
      this.pending = this.pending.slice(end + 2);
      let event = 'message'; let id: string | undefined; const data: string[] = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'id') id = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length) events.push({ event, ...(id !== undefined ? { id } : {}), data: data.join('\n') });
    }
    return events;
  }
}

/** A sink for a terminal backend whose body turns its event stream into socket messages. */
function socketSink(body: Writable): StreamSink {
  let opened = false;
  return {
    body,
    get opened() { return opened; },
    open() { opened = true; },
    refuse(kind) { body.destroy(new TowerError(kind, '터미널을 찾을 수 없습니다. 새 터미널을 여세요.')); },
    cutOff() { body.destroy(); },
  };
}

/** The shells of this computer. */
export function localRelay(backend: WorkspaceTerminalBackend): TerminalRelay {
  return {
    events: async (id, body, cursor) => { await backend.attach(id, socketSink(body), cursor); },
    input: async (id, data) => { await backend.input(id, data); },
    resize: async (id, cols, rows) => { await backend.resize(id, cols, rows); },
  };
}

const OFFLINE = '그 컴퓨터에 지금 연결되어 있지 않습니다. 다시 연결되면 다시 시도하세요.';
const QUIET_MS = 60_000;

/** The shells of a joined computer, through the routes it already offers its controllers over the link. */
export function nodeRelay(session: () => ClientHttp2Session | undefined): TerminalRelay {
  const live = () => {
    const current = session();
    if (!current || current.destroyed || current.closed) throw new TowerError('unavailable', OFFLINE);
    return current;
  };
  const post = async (path: string, body: unknown) => {
    const answer = await linkRequest(live(), 'POST', path, body, 30_000).catch(error => { throw Object.assign(new TowerError('unavailable', OFFLINE), { cause: error }); });
    if (answer.status !== 200) throw fromStatus(answer.status, typeof (answer.json as { error?: unknown } | undefined)?.error === 'string' ? (answer.json as { error: string }).error : '그 컴퓨터가 터미널 요청을 거절했습니다.');
  };
  return {
    events: (id, body, cursor) => new Promise((resolve, reject) => {
      const stream = live().request({ ':method': 'GET', ':path': `/api/workspace/terminals/${encodeURIComponent(id)}/events`, accept: 'text/event-stream', ...(cursor ? { 'last-event-id': cursor } : {}) });
      let answered = false;
      // The stream carries a heartbeat every 15 seconds; one silent for longer than this is gone.
      let quiet: ReturnType<typeof setTimeout> | undefined;
      const touch = () => { clearTimeout(quiet); quiet = setTimeout(() => { stop(); body.destroy(); }, QUIET_MS); };
      const stop = () => { clearTimeout(quiet); if (!stream.destroyed) stream.close(http2.constants.NGHTTP2_CANCEL); };
      body.once('close', stop);
      touch();
      stream.on('error', error => { if (!answered) { answered = true; reject(Object.assign(new TowerError('unavailable', OFFLINE), { cause: error })); } else body.destroy(); });
      stream.on('close', () => { clearTimeout(quiet); if (!answered) { answered = true; reject(new TowerError('unavailable', OFFLINE)); } else body.end(); });
      stream.on('response', headers => {
        const status = Number(headers[':status']);
        answered = true;
        if (status !== 200 || !/^text\/event-stream/i.test(String(headers['content-type'] ?? ''))) {
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => { if (chunks.length < 64) chunks.push(chunk); });
          stream.once('end', () => {
            let message = '그 컴퓨터의 터미널에 연결하지 못했습니다.';
            try { const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: unknown }; if (typeof parsed.error === 'string') message = parsed.error; } catch { /* Not JSON. */ }
            reject(fromStatus(status === 401 || status === 403 ? 502 : status, message));
          });
          return;
        }
        stream.setEncoding('utf8');
        stream.on('data', (chunk: string) => { touch(); if (!body.destroyed) body.write(chunk); });
        resolve();
      });
    }),
    input: (id, data) => post(`/api/workspace/terminals/${encodeURIComponent(id)}/input`, { data }),
    resize: (id, cols, rows) => post(`/api/workspace/terminals/${encodeURIComponent(id)}/resize`, { cols, rows }),
  };
}

function parse(raw: RawData, binary: boolean): Incoming | undefined {
  if (binary) return undefined;
  try {
    const value = JSON.parse(raw.toString()) as Record<string, unknown>;
    const keys = Object.keys(value ?? {});
    if (value?.type === 'hello' && typeof value.token === 'string' && (value.cursor === undefined || (typeof value.cursor === 'string' && /^\d{1,12}$/.test(value.cursor)))
      && keys.every(key => ['type', 'token', 'cursor'].includes(key))) return value as Incoming;
    if (value?.type === 'input' && typeof value.data === 'string' && keys.every(key => ['type', 'data'].includes(key))) return value as Incoming;
    if (value?.type === 'resize' && keys.every(key => ['type', 'cols', 'rows'].includes(key))) return value as Incoming;
  } catch { /* Refused below. */ }
  return undefined;
}

const failure = (error: unknown): { status: number; message: string } => ({ status: statusOf(error) ?? 500, message: error instanceof Error ? error.message : '터미널 요청을 처리하지 못했습니다.' });

/**
 * Serves one terminal tab's socket. The first message must carry the page's request token, as every change over HTTP
 * does; keys and sizes are then passed on in the order they came, one at a time.
 */
export function serveTerminalSocket(ws: WebSocket, id: string, relay: TerminalRelay, tokenValid: (token: string) => boolean): void {
  let greeted = false;
  let closed = false;
  let queue = Promise.resolve();
  const send = (message: TerminalSocketMessage) => {
    if (closed || ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED) { ws.close(1013, 'Output not read'); return; }
    ws.send(JSON.stringify(message));
  };
  const hello = setTimeout(() => { if (!greeted) ws.close(SOCKET_REFUSED, 'No hello'); }, HELLO_MS);
  let alive = true;
  const ping = setInterval(() => {
    if (!alive) { ws.terminate(); return; }
    alive = false;
    try { ws.ping(); } catch { /* Closing. */ }
  }, PING_MS);
  ping.unref?.();
  ws.on('pong', () => { alive = true; });
  const reader = new SseReader();
  const decoder = new TextDecoder();
  const body = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      for (const event of reader.push(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }))) {
        let data: unknown;
        try { data = JSON.parse(event.data); } catch { continue; }
        if (event.event === 'output' && typeof (data as { data?: unknown }).data === 'string') send({ type: 'output', data: (data as { data: string }).data, ...(event.id !== undefined ? { id: event.id } : {}) });
        else if (event.event === 'exit') send({ type: 'exit', exitCode: Number((data as { exitCode?: unknown }).exitCode) || 0 });
      }
      callback();
    },
    final(callback) { if (!closed) ws.close(1000, 'Stream ended'); callback(); },
  });
  // However the shell's stream ends (the terminal host or the link to a joined computer gone, a reader too slow),
  // the socket ends with it, so the page reconnects rather than wait on a socket that hears nothing.
  let attached = false;
  body.on('error', () => { if (!closed) ws.close(1011, 'Stream failed'); });
  body.on('close', () => { if (attached && !closed) ws.close(1011, 'Stream ended'); });
  const finish = () => {
    if (closed) return;
    closed = true;
    clearTimeout(hello); clearInterval(ping);
    body.destroy();
  };
  ws.on('close', finish);
  ws.on('error', finish);
  ws.on('message', (raw, binary) => {
    const message = parse(raw, binary);
    if (!greeted) {
      if (message?.type !== 'hello' || !tokenValid(message.token)) { ws.close(SOCKET_REFUSED, 'Refused'); return; }
      greeted = true;
      clearTimeout(hello);
      relay.events(id, body, message.cursor).then(() => {
        attached = true;
        if (body.destroyed) { if (!closed) ws.close(1011, 'Stream ended'); return; }
        send({ type: 'ready' });
      }, error => {
        const { status, message: text } = failure(error);
        send({ type: 'error', status, message: text });
        ws.close([404, 409, 410].includes(status) ? SOCKET_GONE : 1011, 'Not attached');
      });
      return;
    }
    if (!message || message.type === 'hello') { send({ type: 'error', status: 400, message: '터미널 요청 형식이 올바르지 않습니다.' }); return; }
    queue = queue.then(async () => {
      if (closed) return;
      try {
        if (message.type === 'input') await relay.input(id, message.data);
        else await relay.resize(id, message.cols, message.rows);
      } catch (error) { send({ type: 'error', ...failure(error) }); }
    });
  });
}
