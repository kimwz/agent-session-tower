import { request } from 'node:http';
import { REQUEST_TOKEN_HEADER } from '../../shared/app-identity.js';
import type { MasterCallState } from '../../shared/master.js';

/** What the web hands the master host so it can call Tower's API like the owner's own page. */
export interface WebCredentials { port: number; token: string; callerSecret: string }
export const MASTER_CALLER_HEADER = 'X-Tower-Master';

export interface TowerResponse { status: number; body: unknown; state: MasterCallState }

const MAX_RESPONSE = 8 * 1024 * 1024;
const WAIT_FOR_WEB_MS = 60_000;
const disposition = (body: unknown) => body && typeof body === 'object' ? (body as { disposition?: unknown }).disposition : undefined;

/**
 * How a finished call is filed. The server's `disposition` comes first: a local worker, a joined computer's request
 * ledger and the link proxy all use it to say whether the request may have run, whatever the HTTP status.
 */
export function classify(status: number, body: unknown): MasterCallState {
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

  setCredentials(credentials: WebCredentials): void {
    this.credentials = credentials;
    for (const wake of this.waiters.splice(0)) wake();
  }
  hasCredentials(): boolean { return Boolean(this.credentials); }

  /** Reads are repeated after a web restart; changes are sent at most once unless the web proves it never ran them. */
  async call(method: 'GET' | 'POST', path: string, body?: unknown, options: { write: boolean; headers?: Record<string, string>; signal?: AbortSignal } = { write: method === 'POST' }): Promise<TowerResponse> {
    const deadline = Date.now() + WAIT_FOR_WEB_MS;
    let resentNotAdmitted = false;
    // A read that failed on a server that is up is tried twice more, not for the whole wait for a restarting web.
    let readRetries = 2;
    for (;;) {
      const credentials = await this.waitForCredentials(deadline, options.signal);
      try {
        const response = await this.send(credentials, method, path, body, options.headers, options.signal);
        // A stale page token means this web never looked at the request: wait for the web that replaced it.
        if (response.status === 403 && this.credentials === credentials && isTokenRefusal(response.body)) {
          this.credentials = undefined;
          if (Date.now() < deadline) continue;
          return { ...response, state: 'not-admitted' };
        }
        if (response.state === 'not-admitted' && !resentNotAdmitted && Date.now() < deadline) {
          resentNotAdmitted = true;
          await delay(3000, options.signal);
          continue;
        }
        if (!options.write && response.state === 'uncertain' && readRetries-- > 0) { await delay(1000, options.signal); continue; }
        return response;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (error instanceof NotSent) {
          if (this.credentials === credentials) this.credentials = undefined;
          if (Date.now() < deadline) continue;
          return { status: 503, body: { error: 'Tower 웹 서버에 연결하지 못했습니다.' }, state: 'not-admitted' };
        }
        if (!options.write && readRetries-- > 0) { await delay(1000, options.signal); continue; }
        return { status: 0, body: { error: error instanceof Error ? error.message : String(error) }, state: options.write ? 'uncertain' : 'failed' };
      }
    }
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
          [MASTER_CALLER_HEADER]: credentials.callerSecret,
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
