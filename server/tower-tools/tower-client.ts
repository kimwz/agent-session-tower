import { request, type IncomingMessage } from 'node:http';
import { REQUEST_TOKEN_HEADER } from '../../shared/app-identity.js';
import { fromStatus, TowerError } from '../../shared/errors.js';

/** What the web hands the master host so it can call Tower's API like the owner's own page. */
export interface WebCredentials { port: number; token: string; callerSecret: string }
export const MASTER_CALLER_HEADER = 'X-Tower-Master';
/** Says a call comes from an agent of the owner's on this computer, so it counts apart from the owner's pages. */
export const LOCAL_AGENT_HEADER = 'X-Tower-Agent';
/** Headers that say who calls: the master's own secret unless the client is told otherwise. */
export type CallerHeaders = (credentials: WebCredentials) => Record<string, string>;
const masterCaller: CallerHeaders = credentials => ({ [MASTER_CALLER_HEADER]: credentials.callerSecret });

/** Whether a call ran: `uncertain` may have, `not-admitted` surely did not. */
export type CallState = 'succeeded' | 'failed' | 'uncertain' | 'not-admitted';
export interface TowerResponse { status: number; body: unknown; state: CallState }

/** A failure Tower answered: its status when it gave one, otherwise `fallback`. For callers that do not read statuses. */
export function replyError(message: string, response: Pick<TowerResponse, 'status'>, fallback: 'upstream' | 'unavailable'): TowerError {
  return response.status ? fromStatus(response.status, message) : new TowerError(fallback, message);
}

const MAX_RESPONSE = 8 * 1024 * 1024;
const WAIT_FOR_WEB_MS = 60_000;
const disposition = (body: unknown) => body && typeof body === 'object' ? (body as { disposition?: unknown }).disposition : undefined;

/**
 * How a finished call is filed. The server's `disposition` comes first: a local worker, a joined computer's request
 * ledger and the link proxy all use it to say whether the request may have run, whatever the HTTP status.
 */
export function classify(status: number, body: unknown): CallState {
  const said = disposition(body);
  if (said === 'uncertain') return 'uncertain';
  if (said === 'not-admitted' || said === 'handoff') return status === 503 ? 'not-admitted' : 'failed';
  if (status >= 200 && status < 300) return 'succeeded';
  if (status >= 400 && status < 500) return 'failed';
  return 'uncertain';
}

/** A request the web never received: safe to send again once a web is there. */
class NotSent extends Error {}

/**
 * Calls this Tower's HTTP API over loopback, exactly as a page of the owner on this computer does. Between web
 * restarts it waits for new credentials; a request that may have reached the server is never sent twice.
 */
export class TowerClient {
  private credentials?: WebCredentials;
  private waiters: Array<() => void> = [];
  private changedAt = 0;

  constructor(private readonly waitForWebMs = WAIT_FOR_WEB_MS, private readonly caller: CallerHeaders = masterCaller) {}

  setCredentials(credentials: WebCredentials): void {
    const known = this.credentials;
    // The same web saying hello again changes nothing.
    if (!known || known.port !== credentials.port || known.token !== credentials.token || known.callerSecret !== credentials.callerSecret) {
      this.credentials = credentials;
      this.changedAt = Date.now();
    }
    for (const wake of this.waiters.splice(0)) wake();
  }
  hasCredentials(): boolean { return Boolean(this.credentials); }
  /** When a web (a new one, or the same one again after it was lost) last handed over its credentials. */
  connectedSince(): number { return this.changedAt; }

  /**
   * Reads are repeated after a web restart; changes are sent at most once unless the web proves it never ran them.
   * `signal` cancels the whole call (reads). `beforeSend` stops a change only while it has not gone out: waiting for a
   * web, or before sending again what the server did not admit; a change already on its way is never cut off.
   * `gate` is asked right before each send, with the web it would go to known; false keeps the change unsent.
   */
  async call(method: 'GET' | 'POST', path: string, body?: unknown, options: { write: boolean; headers?: Record<string, string>; signal?: AbortSignal; beforeSend?: AbortSignal; gate?: () => Promise<boolean> } = { write: method === 'POST' }): Promise<TowerResponse> {
    const deadline = Date.now() + this.waitForWebMs;
    const waiting = options.signal ?? options.beforeSend;
    const stopped = () => !options.signal?.aborted && Boolean(options.beforeSend?.aborted);
    const unsent = (error: string): TowerResponse => ({ status: 503, body: { error }, state: 'not-admitted' });
    let resentNotAdmitted = false;
    // A read that failed on a server that is up is tried twice more, not for the whole wait for a restarting web.
    let readRetries = 2;
    for (;;) {
      let credentials: WebCredentials;
      try { credentials = await this.waitForCredentials(deadline, waiting); }
      catch (error) {
        if (error instanceof NotSent) return unsent('Tower 웹 서버에 연결하지 못했습니다.');
        if (stopped()) return unsent('중지되어 보내지 않았습니다.');
        throw error;
      }
      if (stopped()) return unsent('중지되어 보내지 않았습니다.');
      if (options.gate) {
        if (!await options.gate()) return unsent('보내기 전 확인을 통과하지 못해 보내지 않았습니다.');
        if (stopped()) return unsent('중지되어 보내지 않았습니다.');
        // The web changed while the gate looked: look again with the new one.
        if (this.credentials !== credentials) continue;
      }
      try {
        const response = await this.send(credentials, method, path, body, options.headers, options.signal);
        // A stale page token means this web never looked at the request: send it to the web that replaced it, whose
        // credentials may already be here.
        if (response.status === 403 && isTokenRefusal(response.body)) {
          if (this.credentials === credentials) this.credentials = undefined;
          if (Date.now() < deadline) continue;
          return { ...response, state: 'not-admitted' };
        }
        if (response.state === 'not-admitted' && !resentNotAdmitted && Date.now() < deadline) {
          resentNotAdmitted = true;
          try { await delay(3000, waiting); }
          catch (error) { if (stopped()) return response; throw error; }
          continue;
        }
        if (!options.write && response.state === 'uncertain' && readRetries-- > 0) { await delay(1000, options.signal); continue; }
        return response;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (error instanceof NotSent) {
          if (this.credentials === credentials) this.credentials = undefined;
          if (Date.now() < deadline) continue;
          return unsent('Tower 웹 서버에 연결하지 못했습니다.');
        }
        if (!options.write && readRetries-- > 0) { await delay(1000, options.signal); continue; }
        return { status: 0, body: { error: error instanceof Error ? error.message : String(error) }, state: options.write ? 'uncertain' : 'failed' };
      }
    }
  }

  /**
   * Opens a long-lived GET stream (the page's live event stream), as a page on this computer would. It waits for a web
   * the way calls do; the caller reads the response and reconnects when it ends.
   */
  async stream(path: string, signal: AbortSignal): Promise<IncomingMessage> {
    const credentials = await this.waitForCredentials(Date.now() + this.waitForWebMs, signal);
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: credentials.port, method: 'GET', path, signal, headers: { ...this.caller(credentials), Accept: 'text/event-stream' } }, res => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error(`Tower stream answered ${res.statusCode}`)); return; }
        resolve(res);
      });
      req.on('error', error => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ECONNREFUSED' && this.credentials === credentials) this.credentials = undefined;
        reject(error);
      });
      req.end();
    });
  }

  private async waitForCredentials(deadline: number, signal?: AbortSignal): Promise<WebCredentials> {
    while (!this.credentials) {
      if (Date.now() >= deadline) throw new NotSent('No Tower web server is connected.');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        this.waiters.push(() => { clearTimeout(timer); resolve(); });
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); }, { once: true });
      });
    }
    return this.credentials;
  }

  private send(credentials: WebCredentials, method: string, path: string, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<TowerResponse> {
    const payload = method === 'POST' ? JSON.stringify(body ?? {}) : undefined;
    return new Promise((resolve, reject) => {
      let connected = false;
      const req = request({
        host: '127.0.0.1', port: credentials.port, method, path, signal,
        headers: {
          ...headers,
          ...this.caller(credentials),
          ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), [REQUEST_TOKEN_HEADER]: credentials.token } : {}),
        },
      }, res => {
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_RESPONSE) res.destroy(new Error('Tower response is too large.')); else chunks.push(chunk); });
        res.on('error', error => reject(error));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown;
          try { parsed = text ? JSON.parse(text) : null; }
          catch {
            // A body that could not be read says nothing about whether a change ran.
            resolve({ status: res.statusCode ?? 0, body: { error: 'Tower 응답을 읽지 못했습니다.' }, state: method === 'POST' ? 'uncertain' : 'failed' });
            return;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, state: classify(res.statusCode ?? 0, parsed) });
        });
      });
      req.on('socket', socket => {
        if (!socket.connecting) connected = true;
        else socket.once('connect', () => { connected = true; });
      });
      req.setTimeout(120_000, () => req.destroy(new Error('Tower did not answer in time.')));
      req.on('error', error => {
        const code = (error as NodeJS.ErrnoException).code;
        // Refused or never connected: the request never reached a server.
        if (!connected && (code === 'ECONNREFUSED' || code === 'ENOENT' || code === 'EADDRNOTAVAIL')) reject(new NotSent(error.message));
        else reject(error);
      });
      req.end(payload);
    });
  }
}

function isTokenRefusal(body: unknown): boolean {
  const message = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  return typeof message === 'string' && message.includes('연결 인증이 만료');
}
const delay = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); }, { once: true });
});
