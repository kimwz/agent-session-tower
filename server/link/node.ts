import { EventEmitter } from 'node:events';
import type { Http2ServerRequest, Http2ServerResponse, Http2Server } from 'node:http2';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import { WebSocket, createWebSocketStream } from 'ws';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { readJson } from '../http/requests.js';
import { displayFingerprint, linkDirectory, linkId, type LinkIdentity } from './identity.js';
import { decodeJoinCode } from './join-code.js';
import { LINK_PROTOCOL, MAX_FRAME_BYTES, REMOVED_CLOSE_CODE, openNodeEnd, pairingProof } from './transport.js';
import type { ControllerStatus, ControllerSummary, NodeReport } from '../../shared/link.js';

const CLAIM_GRACE_MS = 10 * 60_000;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;
const MISMATCH_RETRY_MS = 5 * 60_000;
const DIAL_MS = 10_000;
/** A controller that stops answering (asleep, or its network changed) is dropped and dialed again. */
const PING_MS = 30_000;

interface ControllerRecord {
  id: string; pin: string; name: string; addresses: string[];
  /** `removed`: the controller removed this computer; it is not dialed until joined again. */
  state: 'claiming' | 'paired' | 'expired' | 'removed';
  inviteId?: string; secret?: string; expiresAt?: number;
  pairedAt?: string; lastConnectedAt?: string; lastAddress?: string;
}
interface Live { ws: WebSocket; secure: TLSSocket; server: Http2Server; ping: ReturnType<typeof setInterval> }

export interface NodeLinkOptions {
  stateDir: string;
  identity: LinkIdentity;
  version: string;
  hostname: () => string;
  /** What this computer can do for a controller right now, from the worker and terminal host it runs with. */
  features: () => string[];
  /** Serves a paired controller's requests. */
  handle: (req: Http2ServerRequest, res: Http2ServerResponse, principal: { controllerId: string }) => void | Promise<void>;
  /** A controller asking this computer to move to a newer version, and what it reports about itself. */
  update?: {
    request(version: unknown): Promise<{ status: number; body: unknown }>;
    report(): Promise<NodeReport>;
  };
  now?: () => number;
  pingMs?: number;
}

/** What the owner reads when a link could not be set up; the details stay in the error's cause. */
function linkFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /[가-힣]/.test(message) ? message : '다른 컴퓨터와 연결을 설정하지 못했습니다.';
}

/**
 * This computer as a remote host: it keeps one outgoing link to every controller that invited it and
 * answers their requests. It never listens for connections itself.
 */
export class NodeLinks extends EventEmitter {
  private records: ControllerRecord[] = [];
  private readonly path: string;
  private readonly live = new Map<string, Live>();
  private readonly dialing = new Map<string, ReturnType<typeof setTimeout>>();
  /** Controllers being dialed right now; one attempt at a time each. */
  private readonly connecting = new Set<string>();
  /** Set when the saved list could not be read: nothing is saved over it until the owner looks. */
  private broken?: string;
  /** Sockets still setting up a link; closed with everything else. */
  private readonly opening = new Set<WebSocket>();
  private readonly failures = new Map<string, { attempts: number; error?: string; refused?: boolean }>();
  private writes: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: NodeLinkOptions) {
    super();
    this.path = join(linkDirectory(options.stateDir), 'controllers.json');
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }

  async start(): Promise<void> {
    try {
      const saved = await readPrivateJson(this.path);
      if (!Array.isArray(saved)) throw new Error('invalid');
      this.records = saved as ControllerRecord[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.broken = `${this.path} 파일을 읽을 수 없어 이 컴퓨터를 제어하는 컴퓨터를 관리할 수 없습니다. 파일을 확인하거나 옮긴 뒤 Tower를 다시 시작하세요.`;
      return;
    }
    for (const record of this.records) this.schedule(record.id, 0);
  }

  /** Why controllers cannot be managed right now, if they cannot. */
  get error(): string | undefined { return this.broken; }

  list(): ControllerSummary[] {
    return this.records.map(record => {
      const failure = this.failures.get(record.id);
      const status: ControllerStatus = record.state === 'expired' ? 'expired' : record.state === 'removed' ? 'removed' : this.live.has(record.id) ? 'connected'
        : failure?.refused ? 'refused' : failure?.attempts ? 'offline' : 'connecting';
      return { id: record.id, name: record.name, fingerprint: displayFingerprint(record.pin), state: record.state, status,
        ...(record.pairedAt ? { pairedAt: record.pairedAt } : {}), ...(record.lastConnectedAt ? { lastConnectedAt: record.lastConnectedAt } : {}),
        ...(failure?.error ? { error: failure.error } : {}) };
    });
  }

  /** Starts connecting to the controller that made this code. */
  async join(text: unknown): Promise<ControllerSummary> {
    const code = decodeJoinCode(text);
    if (code.expiresAt <= this.now()) throw Object.assign(new Error('연결 코드가 만료되었습니다. 다른 컴퓨터에서 새로 만드세요.'), { statusCode: 410 });
    if (code.pin === this.options.identity.pin) throw Object.assign(new Error('이 컴퓨터에서 만든 코드입니다. 연결할 다른 컴퓨터에서 사용하세요.'), { statusCode: 400 });
    const id = linkId(code.pin);
    const existing = this.records.find(record => record.id === id);
    if (existing?.state === 'paired') {
      // Already joined. The controller may have removed this computer while it was away, so the new invitation is
      // offered on a fresh connection; a controller that still knows this computer confirms it and spends the code.
      await this.save(this.records.map(record => record.id === id ? { ...record, addresses: code.addresses, inviteId: code.inviteId, secret: code.secret, expiresAt: code.expiresAt } : record));
      this.stop(id);
    } else {
      const record: ControllerRecord = { id, pin: code.pin, name: code.name, addresses: code.addresses, state: 'claiming', inviteId: code.inviteId, secret: code.secret, expiresAt: code.expiresAt };
      await this.save([...this.records.filter(item => item.id !== id), record]);
    }
    this.failures.delete(id);
    // A new code is tried now, not after the wait from earlier failures.
    const waiting = this.dialing.get(id);
    if (waiting) { clearTimeout(waiting); this.dialing.delete(id); }
    this.schedule(id, 0);
    this.emit('change');
    return this.list().find(item => item.id === id)!;
  }

  /** Stops trusting a controller. If it is connected it is told why, and it can no longer reach this computer. */
  async remove(id: string): Promise<void> {
    if (!this.records.some(record => record.id === id)) return;
    await this.save(this.records.filter(record => record.id !== id));
    this.stop(id, REMOVED_CLOSE_CODE);
    this.failures.delete(id);
    this.emit('change');
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.dialing.values()) clearTimeout(timer);
    this.dialing.clear();
    for (const id of [...this.live.keys()]) this.stop(id);
    for (const ws of this.opening) ws.terminate();
    this.opening.clear();
    await this.writes.catch(() => {});
  }

  private record(id: string) { return this.records.find(item => item.id === id); }

  private schedule(id: string, delay: number): void {
    if (this.closed || this.dialing.has(id) || this.connecting.has(id) || this.live.has(id)) return;
    this.dialing.set(id, setTimeout(() => {
      this.dialing.delete(id);
      this.connecting.add(id);
      this.connect(id).catch(error => { if (this.record(id)) this.retry(id, linkFailure(error)); })
        .finally(() => { this.connecting.delete(id); });
    }, delay));
  }

  private retry(id: string, error: string, refused = false, longWait = refused): void {
    // This attempt is over; the next one is scheduled below.
    this.connecting.delete(id);
    const failure = this.failures.get(id) ?? { attempts: 0 };
    failure.attempts++;
    failure.error = error;
    failure.refused = refused;
    this.failures.set(id, failure);
    this.emit('change');
    const base = longWait ? MISMATCH_RETRY_MS : Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(failure.attempts - 1, 5));
    this.schedule(id, base + Math.floor(Math.random() * base * 0.2));
  }

  private async connect(id: string): Promise<void> {
    const record = this.record(id);
    if (!record || this.closed || record.state === 'expired' || record.state === 'removed') return;
    if (record.secret && (record.expiresAt ?? 0) + CLAIM_GRACE_MS <= this.now()) {
      // Too late to finish joining; a new code is needed. A computer that had joined before keeps its link.
      const { inviteId: _, secret: __, expiresAt: ___, ...kept } = record;
      await this.save(this.records.map(item => item.id === id ? (record.state === 'claiming' ? { id: item.id, pin: item.pin, name: item.name, addresses: item.addresses, state: 'expired' as const } : kept) : item));
      this.emit('change');
      if (record.state === 'claiming') return;
    }
    const addresses = record.lastAddress && record.addresses.includes(record.lastAddress) ? [record.lastAddress, ...record.addresses.filter(item => item !== record.lastAddress)] : record.addresses;
    let lastError = '다른 컴퓨터에 연결할 수 없습니다.';
    let mismatches = 0;
    for (const address of addresses) {
      if (this.closed || !this.record(id)) return;
      const opened = await dial(address, ws => { this.opening.add(ws); ws.once('close', () => this.opening.delete(ws)); }).catch(error => { lastError = (error as Error).message; return undefined; });
      if (!opened) continue;
      const { ws, pipe } = opened;
      // A peer that accepts the socket but never sets up TLS is dropped like one that does not answer.
      const deadline = setTimeout(() => ws.terminate(), DIAL_MS);
      try {
        if (this.closed) throw new Error('Closing.');
        const end = await openNodeEnd(pipe, this.options.identity, {
          accept: pin => pin === this.record(id)?.pin,
          handle: (req, res, link) => { void this.serve(id, req, res, link.exporter); },
        });
        clearTimeout(deadline);
        this.opening.delete(ws);
        if (this.closed) { ws.terminate(); return; }
        let waiting = false;
        const ping = setInterval(() => {
          if (waiting || ws.readyState !== WebSocket.OPEN) { ws.terminate(); return; }
          waiting = true;
          ws.ping();
        }, this.options.pingMs ?? PING_MS);
        ws.on('pong', () => { waiting = false; });
        this.live.set(id, { ws, secure: end.secure, server: end.server, ping });
        this.failures.delete(id);
        end.secure.once('close', () => ws.terminate());
        ws.once('close', () => {
          clearInterval(ping);
          end.secure.destroy();
          const current = this.live.get(id);
          if (current?.ws !== ws) return;
          this.live.delete(id);
          end.server.close();
          this.emit('change');
          this.emit('disconnected', id);
          if (this.record(id)) this.retry(id, '연결이 끊겼습니다.');
        });
        const updated = this.records.map(item => item.id === id ? { ...item, lastAddress: address, lastConnectedAt: new Date(this.now()).toISOString() } : item);
        await this.save(updated);
        this.emit('change');
        return;
      } catch (error) {
        clearTimeout(deadline);
        this.opening.delete(ws);
        ws.terminate();
        if (this.closed) return;
        // Another computer at one address (for example a reassigned LAN address) does not stop the others being tried.
        if ((error as { code?: string }).code === 'PIN_MISMATCH') { mismatches++; lastError = '이 주소에서 다른 컴퓨터가 응답했습니다.'; continue; }
        lastError = linkFailure(error);
      }
    }
    // Only when every address answered as another computer is it worth waiting long before trying again.
    this.retry(id, mismatches ? '이 주소에서 다른 컴퓨터가 응답했습니다.' : lastError, mismatches > 0, mismatches === addresses.length);
  }

  private stop(id: string, code?: number): void {
    const timer = this.dialing.get(id);
    if (timer) { clearTimeout(timer); this.dialing.delete(id); }
    const live = this.live.get(id);
    if (!live) return;
    this.live.delete(id);
    clearInterval(live.ping);
    live.server.close();
    if (code) live.ws.close(code, 'removed'); else live.ws.terminate();
    setTimeout(() => live.ws.terminate(), 1000).unref();
    this.emit('change');
    this.emit('disconnected', id);
  }

  private async serve(id: string, req: Http2ServerRequest, res: Http2ServerResponse, exporter: Buffer): Promise<void> {
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const record = this.record(id);
    if (!record) return json(404, { error: 'Not found.' });
    try {
      if (req.method === 'GET' && req.url === '/link/hello') {
        const claiming = record.state !== 'expired' && record.inviteId && record.secret;
        return json(200, { protocol: LINK_PROTOCOL, name: this.options.hostname(), version: this.options.version, features: this.options.features(),
          ...(claiming ? { pairing: { inviteId: record.inviteId, proof: pairingProof(record.secret!, exporter, { inviteId: record.inviteId!, controllerPin: record.pin, nodePin: this.options.identity.pin }) } } : {}) });
      }
      if (req.method === 'POST' && req.url === '/link/paired') {
        const body = await readJson(req, 4096);
        const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 100) : record.name;
        await this.save(this.records.map(item => item.id === id ? { id: item.id, pin: item.pin, name, addresses: item.addresses, state: 'paired' as const,
          pairedAt: item.pairedAt ?? new Date(this.now()).toISOString(), ...(item.lastConnectedAt ? { lastConnectedAt: item.lastConnectedAt } : {}), ...(item.lastAddress ? { lastAddress: item.lastAddress } : {}) } : item));
        this.emit('change');
        this.emit('paired', id);
        return json(200, { ok: true });
      }
      if (req.method === 'POST' && req.url === '/link/revoke') {
        // The controller removed this computer. It is kept, marked, so the owner here can see why it stopped.
        json(200, { ok: true });
        await this.save(this.records.map(item => item.id === id ? { id: item.id, pin: item.pin, name: item.name, addresses: item.addresses, state: 'removed' as const,
          ...(item.pairedAt ? { pairedAt: item.pairedAt } : {}), ...(item.lastConnectedAt ? { lastConnectedAt: item.lastConnectedAt } : {}) } : item));
        this.stop(id);
        this.emit('change');
        return;
      }
      if (record.state !== 'paired') return json(404, { error: 'Not found.' });
      // Controllers are the owner's own computers: keeping this one up to date is theirs to ask for.
      if (req.method === 'GET' && req.url === '/link/status' && this.options.update) return json(200, await this.options.update.report());
      if (req.method === 'POST' && req.url === '/link/update' && this.options.update) {
        const body = await readJson(req, 4096);
        const answer = await this.options.update.request(body.version);
        return json(answer.status, answer.body);
      }
      await this.options.handle(req, res, { controllerId: id });
    } catch {
      if (!res.headersSent) json(500, { error: 'The request failed.' }); else res.end();
    }
  }

  private save(records: ControllerRecord[]): Promise<void> {
    if (this.broken) return Promise.reject(Object.assign(new Error(this.broken), { statusCode: 503 }));
    this.records = records;
    const data = JSON.stringify(records);
    const write = this.writes.then(() => writePrivateJson(this.path, data));
    this.writes = write.catch(() => {});
    return write;
  }
}

function dial(url: string, opening: (ws: WebSocket) => void): Promise<{ ws: WebSocket; pipe: Duplex }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: DIAL_MS, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
    opening(ws);
    // The controller starts TLS the moment the socket opens: read from it before anything else can run.
    ws.once('open', () => resolve({ ws, pipe: createWebSocketStream(ws) }));
    // Before it opens an error means the address did not answer; after, the socket closes and 'close' handles it.
    ws.on('error', error => { reject(Object.assign(new Error(`${new URL(url).host}에 연결할 수 없습니다.`), { cause: error })); ws.terminate(); });
  });
}
