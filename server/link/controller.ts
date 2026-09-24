import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { ClientHttp2Session } from 'node:http2';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { WebSocketServer, createWebSocketStream, type WebSocket } from 'ws';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { displayFingerprint, linkDirectory, linkId, type LinkIdentity } from './identity.js';
import { joinCommand, encodeJoinCode, type JoinCode } from './join-code.js';
import { LINK_PATH, LINK_PROTOCOL, MAX_FRAME_BYTES, REMOVED_CLOSE_CODE, linkRequest, openControllerEnd, pairingProof, proofMatches } from './transport.js';
import { advertisedAddresses } from './addresses.js';
import type { HubStatus, NodeStatus, NodeSummary } from '../../shared/link.js';

export const DEFAULT_LINK_PORT = 8765;
const INVITE_MS = 10 * 60_000;
const CLAIM_GRACE_MS = 10 * 60_000;
const HELLO_MS = 10_000;
const MAX_UNAUTHENTICATED = 16;
const MAX_UNAUTHENTICATED_PER_ADDRESS = 4;
/** Connections that have not yet asked for the link, in total and from one address. */
const MAX_WAITING = 32;
const MAX_WAITING_PER_ADDRESS = 4;
const ATTEMPTS_PER_MINUTE = 30;
const PING_MS = 20_000;
/** A joined computer's worker can be replaced by a newer one; what it can do is asked again this often. */
const HELLO_REFRESH_MS = 60_000;

export interface HubSettings { enabled: boolean; port: number; bind: string; custom: string[] }
interface NodeRecord {
  id: string; pin: string; name: string; label?: string; pairedAt: string; lastSeenAt?: string; version?: string;
  /** The computer stopped trusting this controller; shown until it joins again or is removed here. */
  left?: true;
  /** The last code it joined with, so the page that showed the code can tell it was used. */
  invite?: string;
}
interface InviteRecord { id: string; secret: string; expiresAt: number; claimedBy?: string }
interface State { version: 1; settings: HubSettings; nodes: NodeRecord[]; removed: Array<{ pin: string; at: string }>; invites: InviteRecord[] }

interface Hello { protocol: number; name: string; version: string; features: string[]; pairing?: { inviteId: string; proof: string } }
interface Connected { session: ClientHttp2Session; ws: WebSocket; hello: Hello; ping?: ReturnType<typeof setInterval>; refresh?: ReturnType<typeof setInterval>; gone?: () => void }

/**
 * This computer as a controller: it opens the link port, hands out join codes, and keeps one authenticated
 * session per joined computer. Nothing it learns from a joined computer is trusted beyond that computer.
 */
export class ControllerLinks extends EventEmitter {
  private state: State = { version: 1, settings: { enabled: false, port: DEFAULT_LINK_PORT, bind: '0.0.0.0', custom: [] }, nodes: [], removed: [], invites: [] };
  private readonly path: string;
  private listener?: { server: Server; wss: WebSocketServer; port: number };
  private listenError?: string;
  private readonly connected = new Map<string, Connected>();
  private unauthenticated = 0;
  private readonly unauthenticatedFrom = new Map<string, number>();
  /** Set when the saved state could not be read: nothing is saved over it until the owner looks. */
  private broken?: string;
  private readonly attempts = new Map<string, { count: number; at: number }>();
  private writes: Promise<unknown> = Promise.resolve();
  private closed = false;
  private loaded = false;

  constructor(private readonly options: { stateDir: string; identity: LinkIdentity; version: string; hostname: () => string; now?: () => number; pingMs?: number; refreshMs?: number }) {
    super();
    this.path = join(linkDirectory(options.stateDir), 'controller.json');
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  async start(): Promise<void> {
    try {
      const saved = await readPrivateJson(this.path) as State;
      if (!saved || saved.version !== 1 || !saved.settings || !Array.isArray(saved.nodes) || !Array.isArray(saved.removed) || !Array.isArray(saved.invites)) throw new Error('invalid');
      const now = this.now();
      this.state = { ...saved, invites: saved.invites.filter(item => item.expiresAt + CLAIM_GRACE_MS > now) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.broken = `${join(linkDirectory(this.options.stateDir), 'controller.json')} 파일을 읽을 수 없어 원격 컴퓨터를 관리할 수 없습니다. 파일을 확인하거나 옮긴 뒤 Tower를 다시 시작하세요.`;
        return;
      }
    }
    this.loaded = true;
    this.emit('change');
    if (this.state.settings.enabled) await this.listen();
  }

  /** Why remote computers cannot be managed right now, if they cannot. */
  get error(): string | undefined { return this.broken; }
  /** The saved computers are loaded: the list is the complete one. */
  get ready(): boolean { return this.loaded; }

  hub(): HubStatus {
    const { enabled } = this.state.settings;
    const port = this.listener?.port ?? this.state.settings.port;
    return { enabled, port, listening: Boolean(this.listener), ...(this.listenError ? { error: this.listenError } : {}), addresses: advertisedAddresses(port, this.state.settings.custom) };
  }

  /** `port` 0 takes any free port; `bind` and `custom` addresses are for setups the automatic ones do not cover. */
  async setHub(patch: { enabled?: boolean; port?: number; bind?: string; custom?: string[] }): Promise<HubStatus> {
    const settings = { ...this.state.settings, ...patch };
    if (!Number.isInteger(settings.port) || (settings.port !== 0 && (settings.port < 1024 || settings.port > 65535))) throw Object.assign(new Error('포트는 1024에서 65535 사이여야 합니다.'), { statusCode: 400 });
    const restart = settings.enabled !== this.state.settings.enabled || settings.port !== this.state.settings.port || settings.bind !== this.state.settings.bind;
    await this.save({ ...this.state, settings });
    if (restart) { await this.stopListening(); if (settings.enabled) await this.listen(); }
    this.emit('change');
    return this.hub();
  }

  /** A single-use code valid for ten minutes. Needs the link port open, since the joining computer dials it. */
  async invite(): Promise<{ id: string; code: string; command: string; expiresAt: number }> {
    if (!this.listener) throw Object.assign(new Error('먼저 다른 컴퓨터의 연결 받기를 켜세요.'), { statusCode: 409 });
    const addresses = this.hub().addresses.map(item => item.url);
    if (!addresses.length) throw Object.assign(new Error('다른 컴퓨터가 이 컴퓨터에 닿을 네트워크 주소가 없습니다.'), { statusCode: 409 });
    const invite: InviteRecord = { id: randomUUID(), secret: randomBytes(32).toString('base64url'), expiresAt: this.now() + INVITE_MS };
    const now = this.now();
    await this.save({ ...this.state, invites: [...this.state.invites.filter(item => item.expiresAt + CLAIM_GRACE_MS > now), invite] });
    const code: JoinCode = { v: 1, name: this.options.hostname(), pin: this.options.identity.pin, addresses: addresses.slice(0, 8), inviteId: invite.id, secret: invite.secret, expiresAt: invite.expiresAt, version: this.options.version };
    return { id: invite.id, code: encodeJoinCode(code), command: joinCommand(code), expiresAt: invite.expiresAt };
  }

  list(): NodeSummary[] {
    return this.state.nodes.map(node => {
      const live = this.connected.get(node.id);
      const status: NodeStatus = live ? (live.hello.protocol === LINK_PROTOCOL ? 'connected' : 'update-required') : node.left ? 'removed-by-node' : 'offline';
      return { id: node.id, name: live?.hello.name ?? node.name, ...(node.label ? { label: node.label } : {}), fingerprint: displayFingerprint(node.pin), status,
        ...(live?.hello.version ?? node.version ? { version: live?.hello.version ?? node.version } : {}), features: live?.hello.features ?? [],
        pairedAt: node.pairedAt, ...(node.lastSeenAt ? { lastSeenAt: node.lastSeenAt } : {}), ...(node.invite ? { invite: node.invite } : {}) };
    });
  }

  /** The live session to a joined computer, for requests on the owner's behalf. */
  session(id: string): ClientHttp2Session | undefined {
    const live = this.connected.get(id);
    return live && live.hello.protocol === LINK_PROTOCOL && !live.session.destroyed ? live.session : undefined;
  }

  async rename(id: string, label: string): Promise<void> {
    const trimmed = label.trim().slice(0, 80);
    if (!this.state.nodes.some(node => node.id === id)) throw Object.assign(new Error('연결된 컴퓨터가 아닙니다.'), { statusCode: 404 });
    await this.save({ ...this.state, nodes: this.state.nodes.map(node => node.id === id ? { ...node, ...(trimmed ? { label: trimmed } : { label: undefined }) } : node) });
    this.emit('change');
  }

  /** Forgets a computer. It is told to stop connecting if it is online; if not, it is refused whenever it returns. */
  async remove(id: string): Promise<void> {
    const node = this.state.nodes.find(item => item.id === id);
    if (!node) return;
    // Its claimed invitation goes too, so it cannot finish joining again with the old code.
    await this.save({ ...this.state, nodes: this.state.nodes.filter(item => item.id !== id), invites: this.state.invites.filter(item => item.claimedBy !== node.pin),
      removed: [...this.state.removed.filter(item => item.pin !== node.pin), { pin: node.pin, at: new Date(this.now()).toISOString() }].slice(-200) });
    const live = this.connected.get(id);
    if (live) {
      await linkRequest(live.session, 'POST', '/link/revoke', {}).catch(() => {});
      this.disconnect(id);
    }
    this.emit('change');
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const id of [...this.connected.keys()]) this.disconnect(id);
    await this.stopListening();
    await this.writes.catch(() => {});
  }

  private async listen(): Promise<void> {
    const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
    // Limits apply from the moment a connection is accepted, before it says anything.
    const waiting = new Map<Socket, string>();
    server.on('connection', (socket: Socket) => {
      const ip = socket.remoteAddress ?? 'unknown';
      let fromAddress = 0;
      for (const address of waiting.values()) if (address === ip) fromAddress++;
      if (waiting.size >= MAX_WAITING || fromAddress >= MAX_WAITING_PER_ADDRESS || !this.admit(ip)) { socket.destroy(); return; }
      waiting.set(socket, ip);
      socket.setTimeout(HELLO_MS, () => socket.destroy());
      socket.once('close', () => waiting.delete(socket));
    });
    server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
      waiting.delete(socket);
      socket.setTimeout(0);
      // Browsers always send Origin on WebSocket upgrades; only another Tower connects here.
      const ip = socket.remoteAddress ?? 'unknown';
      if (req.url !== LINK_PATH || req.headers.origin !== undefined || this.closed || this.unauthenticated >= MAX_UNAUTHENTICATED
        || (this.unauthenticatedFrom.get(ip) ?? 0) >= MAX_UNAUTHENTICATED_PER_ADDRESS) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, ws => { void this.accept(ws, ip); });
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 10_000;
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.state.settings.port, this.state.settings.bind, () => { server.off('error', reject); resolve(); }); });
      this.listener = { server, wss, port: (server.address() as { port: number }).port };
      this.listenError = undefined;
    } catch (error) {
      this.listenError = (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `포트 ${this.state.settings.port}를 다른 프로그램이 쓰고 있습니다.` : (error as Error).message;
      server.close();
    }
    this.emit('change');
  }

  private async stopListening(): Promise<void> {
    const listener = this.listener;
    this.listener = undefined;
    if (!listener) return;
    for (const client of listener.wss.clients) client.terminate();
    listener.wss.close();
    listener.server.closeAllConnections();
    await new Promise<void>(resolve => listener.server.close(() => resolve()));
  }

  private admit(ip: string): boolean {
    if (this.closed) return false;
    const now = this.now();
    if (this.attempts.size > 1000) for (const [key, value] of this.attempts) if (now - value.at > 60_000) this.attempts.delete(key);
    const attempt = this.attempts.get(ip);
    if (!attempt || now - attempt.at > 60_000) { this.attempts.set(ip, { count: 1, at: now }); return true; }
    return ++attempt.count <= ATTEMPTS_PER_MINUTE;
  }

  private async accept(ws: WebSocket, ip: string): Promise<void> {
    this.unauthenticated++;
    this.unauthenticatedFrom.set(ip, (this.unauthenticatedFrom.get(ip) ?? 0) + 1);
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      this.unauthenticated--;
      const left = (this.unauthenticatedFrom.get(ip) ?? 1) - 1;
      if (left > 0) this.unauthenticatedFrom.set(ip, left); else this.unauthenticatedFrom.delete(ip);
    };
    ws.on('error', () => ws.terminate());
    const deadline = setTimeout(() => { done(); ws.terminate(); }, HELLO_MS);
    ws.once('close', () => { clearTimeout(deadline); done(); });
    try {
      const end = await openControllerEnd(createWebSocketStream(ws), this.options.identity);
      const answer = await linkRequest(end.session, 'GET', '/link/hello', undefined, HELLO_MS);
      const hello = parseHello(answer.json);
      if (answer.status !== 200 || !hello) throw new Error('The other computer did not introduce itself.');
      const known = this.state.nodes.find(item => item.pin === end.pin);
      const node = (hello.pairing ? await this.pair(end.pin, end.exporter, hello, known) : undefined) ?? known;
      if (!node) {
        // Removed from this side while it was away, and not joining again with a new code: tell it to stop connecting.
        if (this.state.removed.some(item => item.pin === end.pin)) await linkRequest(end.session, 'POST', '/link/revoke', {}).catch(() => {});
        throw new Error('The other computer did not prove it was invited.');
      }
      clearTimeout(deadline);
      done();
      // The link may have ended while its pairing was being saved, or this Tower may be shutting down.
      if (this.closed || end.session.destroyed || ws.readyState !== ws.OPEN) throw new Error('The link ended.');
      const live: Connected = { session: end.session, ws, hello };
      this.attach(node, live);
      // Until it hears this, the other computer keeps offering its invitation. If it cannot be told, this link
      // starts over so it is told on the next connection.
      if (hello.pairing) await linkRequest(end.session, 'POST', '/link/paired', { name: this.options.hostname(), fingerprint: this.options.identity.fingerprint })
        .then(answer => { if (answer.status !== 200) throw new Error('Not confirmed.'); }).catch(() => live.gone?.());
    } catch {
      clearTimeout(deadline);
      done();
      ws.terminate();
    }
  }

  /** Accepts an unknown computer only with a valid proof for an open (or, after a lost reply, its own claimed) invite. */
  private async pair(pin: string, exporter: Buffer, hello: Hello, known?: NodeRecord): Promise<NodeRecord | undefined> {
    const pairing = hello.pairing;
    if (!pairing) return undefined;
    const now = this.now();
    const invite = this.state.invites.find(item => item.id === pairing.inviteId);
    if (!invite) return undefined;
    const open = !invite.claimedBy && invite.expiresAt > now;
    const resumed = invite.claimedBy === pin && invite.expiresAt + CLAIM_GRACE_MS > now;
    if (!open && !resumed) return undefined;
    if (!proofMatches(pairingProof(invite.secret, exporter, { inviteId: invite.id, controllerPin: this.options.identity.pin, nodePin: pin }), pairing.proof)) return undefined;
    const { left: _, ...kept } = known ?? {} as Partial<NodeRecord>;
    const node: NodeRecord = { ...kept, id: linkId(pin), pin, name: hello.name.slice(0, 100) || 'Computer', pairedAt: known?.pairedAt ?? new Date(now).toISOString(), version: hello.version, invite: invite.id };
    await this.save({ ...this.state,
      invites: this.state.invites.map(item => item.id === invite.id ? { ...item, claimedBy: pin } : item),
      nodes: [...this.state.nodes.filter(item => item.pin !== pin), node],
      removed: this.state.removed.filter(item => item.pin !== pin) });
    if (!known) this.emit('paired', node.id);
    return node;
  }

  private attach(node: NodeRecord, live: Connected): void {
    this.disconnect(node.id);
    this.connected.set(node.id, live);
    const gone = (code?: number) => {
      if (this.connected.get(node.id) !== live) return;
      clearInterval(live.ping);
      clearInterval(live.refresh);
      this.connected.delete(node.id);
      live.session.destroy();
      live.ws.terminate();
      // The other computer removed this controller itself.
      void this.touch(node.id, undefined, code === REMOVED_CLOSE_CODE);
      this.emit('change');
      this.emit('disconnected', node.id);
    };
    live.gone = () => gone();
    // A computer that stops answering (asleep, or its network changed) is dropped at once, not when TCP gives up.
    let answered = this.now();
    const every = this.options.pingMs ?? PING_MS;
    live.ping = setInterval(() => {
      if (live.session.destroyed || live.ws.readyState !== live.ws.OPEN || this.now() - answered > every * 2) { gone(); return; }
      try { live.session.ping(error => { if (!error) answered = this.now(); }); } catch { gone(); }
    }, every);
    live.refresh = setInterval(() => {
      void linkRequest(live.session, 'GET', '/link/hello', undefined, HELLO_MS).then(answer => {
        const hello = parseHello(answer.json);
        if (answer.status !== 200 || !hello || this.connected.get(node.id) !== live) return;
        const { pairing: _, ...current } = hello;
        const changed = JSON.stringify([current.name, current.version, current.features, current.protocol]) !== JSON.stringify([live.hello.name, live.hello.version, live.hello.features, live.hello.protocol]);
        live.hello = current;
        if (changed) { void this.touch(node.id, current.version, false); this.emit('change'); }
      }).catch(() => {});
    }, this.options.refreshMs ?? HELLO_REFRESH_MS);
    live.ws.once('close', code => gone(code));
    live.session.once('close', () => gone());
    void this.touch(node.id, live.hello.version, false);
    this.emit('change');
    this.emit('connected', node.id);
  }

  private disconnect(id: string): void {
    const live = this.connected.get(id);
    if (!live) return;
    this.connected.delete(id);
    clearInterval(live.ping);
    clearInterval(live.refresh);
    live.session.destroy();
    live.ws.terminate();
  }

  private async touch(id: string, version: string | undefined, left: boolean): Promise<void> {
    await this.save({ ...this.state, nodes: this.state.nodes.map(node => {
      if (node.id !== id) return node;
      const { left: _, ...rest } = node;
      return { ...rest, lastSeenAt: new Date(this.now()).toISOString(), ...(version ? { version } : {}), ...(left ? { left: true as const } : {}) };
    }) }).catch(() => {});
  }

  private save(next: State): Promise<void> {
    if (this.broken) return Promise.reject(Object.assign(new Error(this.broken), { statusCode: 503 }));
    // Codes past their grace period, and their secrets, are not kept.
    const now = this.now();
    this.state = next.invites.every(item => item.expiresAt + CLAIM_GRACE_MS > now) ? next : { ...next, invites: next.invites.filter(item => item.expiresAt + CLAIM_GRACE_MS > now) };
    next = this.state;
    const data = JSON.stringify(next);
    const write = this.writes.then(() => writePrivateJson(this.path, data));
    this.writes = write.catch(() => {});
    return write;
  }
}

function parseHello(value: unknown): Hello | undefined {
  const hello = value as Partial<Hello> | undefined;
  if (!hello || typeof hello !== 'object' || !Number.isInteger(hello.protocol) || typeof hello.name !== 'string' || typeof hello.version !== 'string' || !Array.isArray(hello.features)) return undefined;
  const pairing = hello.pairing && typeof hello.pairing.inviteId === 'string' && typeof hello.pairing.proof === 'string' ? { inviteId: hello.pairing.inviteId, proof: hello.pairing.proof } : undefined;
  return { protocol: hello.protocol!, name: hello.name.slice(0, 100), version: hello.version.slice(0, 40), features: hello.features.filter((item): item is string => typeof item === 'string').slice(0, 32), ...(pairing ? { pairing } : {}) };
}
