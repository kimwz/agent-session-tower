import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import type { SecretContext, SecretDevice, SecretMetadata, SecretPeer } from '../../shared/secrets.js';

/**
 * `available` and `catalog` are reads: they claim nothing on the source and go only to a source whose relay confirmed
 * them (`poll`). `catalog` lists every secret of the host a computer follows, shared with it or not (names only).
 */
export type RemoteSecretOperation = 'list' | 'resolve' | 'close' | 'available' | 'catalog';
const OPERATIONS: readonly RemoteSecretOperation[] = ['list', 'resolve', 'close', 'available', 'catalog'];
const READS: readonly RemoteSecretOperation[] = ['available', 'catalog'];
/**
 * What a source's relay says on its poll: the reads its worker serves, and `locked` from the host a computer follows
 * while that host's vault is locked (it then answers nothing until opened).
 */
export type RemoteSecretFeature = 'available' | 'catalog' | 'locked';
const FEATURES: readonly RemoteSecretFeature[] = ['available', 'catalog', 'locked'];
/** A source's relay confirms its features on every poll; one not confirmed this recently is treated as an older build. */
const FEATURE_TTL = 30_000;
/**
 * Why a source refused, as it tells a computer whose request asked for reasons (`reasons: true` in a list or resolve
 * payload, sent only to the followed host once it confirmed `catalog`). Any other refusal stays SECRET_REMOTE_UNAVAILABLE.
 */
const REASONS = ['SECRET_NOT_SHARED'] as const;
/** Refusals of the host a computer follows, told to its agent with what to do (`SecretRefusal`). */
export const HOST_REFUSALS = { SECRET_NOT_SHARED: 'not-shared', SECRET_HOST_LOCKED: 'host-locked', SECRET_HOST_OFFLINE: 'host-offline' } as const;
const reasonOf = (error: unknown) => REASONS.find(code => (error as { code?: unknown } | undefined)?.code === code);
/** Listed metadata in the key set every paired build accepts; anything else, such as why a secret is available, stays local. */
const WIRE_METADATA = ['id', 'name', 'groupId', 'kind', 'version', 'reference', 'fields', 'expiresAt', 'operations', 'sourceHostId'] as const;
export function wireMetadata(item: SecretMetadata): SecretMetadata {
  return Object.fromEntries(WIRE_METADATA.filter(key => item[key] !== undefined).map(key => [key, structuredClone(item[key])])) as unknown as SecretMetadata;
}
export interface RemoteSecretRequest {
  version: 1; id: string; nonce: string; from: string; to: string; createdAt: number; expiresAt: number;
  context: SecretContext; operation: RemoteSecretOperation; payload: unknown; signature: string;
}
export interface RemoteSecretResponse {
  version: 1; id: string; nonce: string; from: string; to: string; expiresAt: number;
  ephemeralKey: string; iv: string; ciphertext: string; tag: string; signature: string;
}
export interface RemoteSecretKeys { signingPrivateKey: string; encryptionPrivateKey: string }
export interface RemoteSecretBrokerOptions {
  device: () => SecretDevice; deviceKeys: () => RemoteSecretKeys; peers: () => SecretPeer[];
  handle: (context: SecretContext, request: { operation: RemoteSecretOperation; payload: unknown; id: string }) => unknown | Promise<unknown>;
  /** Atomically persist a first claim before resolving values. Existing claims, including uncertain ones, return false. */
  begin: (context: SecretContext, id: string, digest: string) => boolean | Promise<boolean>;
  finish?: (context: SecretContext, id: string, digest: string, response: RemoteSecretResponse) => void | Promise<void>;
  /** A refusal told with its reason (`REASONS`), for the owner's notice; called once the response is sealed. */
  refused?: (context: SecretContext, request: { operation: RemoteSecretOperation; payload: unknown }, code: typeof REASONS[number]) => void;
  /** The controller route of the host this computer follows; requests to it fail at once while it is locked or offline. */
  followed?: () => string | undefined;
  now?: () => number; timeoutMs?: number;
}
export const REMOTE_SECRET_MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const MAX_WIRE = REMOTE_SECRET_MAX_RESPONSE_BYTES;
const MAX_PLAINTEXT = 2 * 1024 * 1024;
const MAX_REQUEST = 64 * 1024;
const MAX_TTL = 30_000;
const MAX_PENDING = 64;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (code = 'SECRET_REMOTE_DENIED'): never => { throw Object.assign(new Error(code), { code }); };
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return fail();
}
function signingKey(value: string) { const key = createPublicKey(value); if (key.asymmetricKeyType !== 'ed25519') return fail(); return key; }
function unsigned(value: { signature: string }): Buffer { const { signature: _signature, ...body } = value; return Buffer.from(canonical(body)); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function short(value: unknown, max = 1024): value is string { return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max && !value.includes('\0'); }
function bytes(value: unknown, size?: number): Buffer {
  if (!short(value, MAX_WIRE) || !/^[A-Za-z0-9_-]+$/.test(value)) return fail();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value || (size !== undefined && decoded.length !== size)) return fail();
  return decoded;
}
function wire(value: unknown, limit: number): void { if (Buffer.byteLength(canonical(value)) > limit) fail('SECRET_REMOTE_TOO_LARGE'); }
/** What a request says about its task on the wire; local facts (who is asking) never leave this computer. */
const WIRE_CONTEXT = ['hostId', 'sessionId', 'taskId', 'root', 'projectId', 'runId'] as const;
const wireContext = (context: SecretContext) => Object.fromEntries(WIRE_CONTEXT.filter(key => context[key] !== undefined).map(key => [key, context[key]])) as unknown as SecretContext;
function contextValid(value: unknown): value is SecretContext {
  return record(value) && Object.keys(value).every(k => (WIRE_CONTEXT as readonly string[]).includes(k))
    && ['hostId', 'sessionId', 'taskId', 'root', 'runId'].every(k => short(value[k], k === 'root' ? 8192 : 1024))
    && (value.projectId === undefined || short(value.projectId));
}
function encode(value: unknown): unknown {
  if (value === undefined) return null;
  if (Buffer.isBuffer(value)) return { $secretBytes: value.toString('base64url') };
  if (Array.isArray(value)) return value.map(encode);
  if (record(value)) return { $secretObject: Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, encode(v)]) };
  return value;
}
function decode(value: unknown): unknown {
  if (record(value) && exact(value, ['$secretBytes'])) {
    if (value.$secretBytes === '') return Buffer.alloc(0);
    return bytes(value.$secretBytes);
  }
  if (Array.isArray(value)) return value.map(decode);
  if (record(value)) {
    if (!exact(value, ['$secretObject']) || !Array.isArray(value.$secretObject) || !value.$secretObject.every(entry => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string')) return fail();
    const entries = value.$secretObject as [string, unknown][];
    if (new Set(entries.map(([key]) => key)).size !== entries.length) return fail();
    return Object.fromEntries(entries.map(([key, item]) => [key, decode(item)]));
  }
  return value;
}
function sealKey(privateKey: string, publicKey: string, binding: Buffer): Buffer {
  const privateObject = createPrivateKey(privateKey), publicObject = createPublicKey(publicKey);
  if (privateObject.asymmetricKeyType !== 'x25519' || publicObject.asymmetricKeyType !== 'x25519') return fail();
  const secret = diffieHellman({ privateKey: privateObject, publicKey: publicObject });
  try { return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), binding, 32)); } finally { secret.fill(0); }
}
function binding(r: Pick<RemoteSecretResponse, 'version' | 'id' | 'nonce' | 'from' | 'to' | 'expiresAt'>): Buffer {
  return Buffer.from(canonical({ purpose: 'tower-secret-response-v1', version: r.version, id: r.id, nonce: r.nonce, from: r.from, to: r.to, expiresAt: r.expiresAt }));
}
interface Pending { request: RemoteSecretRequest; peer: SecretPeer; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
const refusal = (code: string) => Object.assign(new Error(code), { code });

/** Private keys and values stay in the execution worker; the web relay handles only signed envelopes. */
export class RemoteSecretBroker {
  private readonly waiting = new Map<string, Pending>();
  private readonly answering = new Set<string>();
  /** Each source's last relay poll, by controller route: when, and what it said its worker serves (nothing from older relays). */
  private readonly polls = new Map<string, { deviceId: string; features: RemoteSecretFeature[]; at: number }>();
  /** Controller routes whose link went away, until their relay polls again. */
  private readonly offline = new Set<string>();
  /** Requests refused because the followed host said it is locked, by route, until its web reads how many. */
  private readonly lockRefusals = new Map<string, number>();
  private readonly now: () => number;
  constructor(private readonly options: RemoteSecretBrokerOptions) { this.now = options.now ?? Date.now; }
  private peer(id: string, route?: { id: string; direction: SecretPeer['direction'] }): SecretPeer {
    const peers = this.options.peers().filter(p => p.enabled && p.device.id === id && (!route || (p.routeId === route.id && p.direction === route.direction)));
    if (peers.length !== 1) return fail();
    return peers[0]!;
  }
  /** This source's relay poll within the last 30 s, for the peer trusted on that route now. */
  private recentPoll(peerId: string) {
    try {
      const peer = this.peer(peerId); const known = this.polls.get(peer.routeId);
      return peer.direction === 'controller' && known && known.deviceId === peer.device.id && this.now() - known.at <= FEATURE_TTL ? known : undefined;
    } catch { return undefined; } // best-effort: without one trusted peer there is no poll to go by
  }
  /** Whether this source's relay confirmed `feature` recently. */
  supports(peerId: string, feature: 'available' | 'catalog'): boolean { return this.recentPoll(peerId)?.features.includes(feature) ?? false; }
  /** Whether this source's relay polled recently without confirming `feature`: it answers, but its build predates it. */
  declines(peerId: string, feature: 'available'): boolean { const poll = this.recentPoll(peerId); return !!poll && !poll.features.includes('locked') && !poll.features.includes(feature); }
  /** The source's link went away: what its relay said no longer holds. */
  forget(controllerRouteId: string): void { this.polls.delete(controllerRouteId); this.offline.add(controllerRouteId); }
  /** Why the followed host cannot answer now: its relay said it is locked, or its link is down. */
  private hostDown(peer: SecretPeer): 'SECRET_HOST_LOCKED' | 'SECRET_HOST_OFFLINE' | undefined {
    if (peer.direction !== 'controller' || peer.routeId !== this.options.followed?.()) return;
    if (this.recentPoll(peer.device.id)?.features.includes('locked')) return 'SECRET_HOST_LOCKED';
    if (this.offline.has(peer.routeId)) return 'SECRET_HOST_OFFLINE';
  }
  /** Requests refused since the last call because the followed host on this route said it is locked. */
  lockedRefusals(controllerRouteId: string): number { const count = this.lockRefusals.get(controllerRouteId) ?? 0; this.lockRefusals.delete(controllerRouteId); return count; }
  request(peerId: string, context: SecretContext, operation: RemoteSecretOperation, payload: unknown = {}, options: { timeoutMs?: number } = {}): Promise<unknown> {
    if (this.waiting.size >= MAX_PENDING) return Promise.reject(refusal('SECRET_REMOTE_BUSY'));
    // An older source refuses an operation it does not know only after its full deadline; never send it one.
    if ((operation === 'available' || operation === 'catalog') && !this.supports(peerId, operation)) return Promise.reject(refusal('SECRET_REMOTE_UNSUPPORTED'));
    try {
      const device = this.options.device(), peer = this.peer(peerId);
      const sent = wireContext(context);
      if (peer.direction !== 'controller' || !contextValid(sent) || sent.hostId !== device.id || !OPERATIONS.includes(operation)) return fail();
      const down = this.hostDown(peer);
      if (down) return Promise.reject(refusal(down));
      // The followed host that serves `catalog` tells why it refuses, when asked.
      if ((operation === 'list' || operation === 'resolve') && peer.routeId === this.options.followed?.() && this.supports(peerId, 'catalog')) payload = { ...payload as Record<string, unknown>, reasons: true };
      const createdAt = this.now();
      const body = { version: 1 as const, id: randomUUID(), nonce: randomUUID(), from: device.id, to: peerId, createdAt,
        expiresAt: createdAt + Math.min(MAX_TTL, Math.max(1, options.timeoutMs ?? this.options.timeoutMs ?? MAX_TTL)), context: sent, operation, payload: encode(payload) };
      wire(body, MAX_REQUEST);
      const request: RemoteSecretRequest = { ...body, signature: sign(null, Buffer.from(canonical(body)), this.options.deviceKeys().signingPrivateKey).toString('base64url') };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.waiting.delete(request.id); reject(refusal('SECRET_REMOTE_OFFLINE')); }, request.expiresAt - createdAt);
        timer.unref(); this.waiting.set(request.id, { request, peer, resolve, reject, timer });
      });
    } catch { return Promise.reject(refusal('SECRET_REMOTE_DENIED')); }
  }
  /** Requests for a source's relay; `features` is what that relay says its worker serves, absent from older relays. */
  poll(controllerRouteId: string, features?: unknown): RemoteSecretRequest[] {
    const peer = this.options.peers().find(peer => peer.enabled && peer.direction === 'controller' && peer.routeId === controllerRouteId);
    const confirmed = Array.isArray(features) ? FEATURES.filter(feature => features.includes(feature)) : [];
    if (peer) this.polls.set(controllerRouteId, { deviceId: peer.device.id, features: confirmed, at: this.now() });
    else this.polls.delete(controllerRouteId);
    this.offline.delete(controllerRouteId);
    // A read queued while this source confirmed reads is refused here once it no longer does, never handed to its relay;
    // anything queued for the followed host is refused once it says it is locked.
    const down = peer && this.hostDown(peer);
    for (const [id, pending] of this.waiting) {
      if (pending.peer.routeId !== controllerRouteId) continue;
      const read = READS.includes(pending.request.operation);
      const code = down ?? (read && !this.supports(pending.peer.device.id, pending.request.operation as 'available' | 'catalog') ? 'SECRET_REMOTE_UNSUPPORTED' : undefined);
      if (!code) continue;
      this.waiting.delete(id); clearTimeout(pending.timer); pending.reject(refusal(code));
      if (code === 'SECRET_HOST_LOCKED') this.lockRefusals.set(controllerRouteId, (this.lockRefusals.get(controllerRouteId) ?? 0) + 1);
    }
    return [...this.waiting.values()].filter(p => p.request.expiresAt > this.now() && this.options.peers().some(peer => peer.enabled && peer.direction === 'controller' && peer.routeId === controllerRouteId && peer.device.id === p.peer.device.id && peer.device.signingKey === p.peer.device.signingKey && peer.device.encryptionKey === p.peer.device.encryptionKey))
      .slice(0, 8).map(p => structuredClone(p.request));
  }
  async answer(nodeRouteId: string, input: unknown): Promise<RemoteSecretResponse> {
    try { return await this.answerVerified(nodeRouteId, input); } catch { return fail(); }
  }
  private async answerVerified(nodeRouteId: string, input: unknown): Promise<RemoteSecretResponse> {
    wire(input, MAX_REQUEST);
    if (!record(input) || !exact(input, ['version', 'id', 'nonce', 'from', 'to', 'createdAt', 'expiresAt', 'context', 'operation', 'payload', 'signature'])) return fail();
    const request = input as unknown as RemoteSecretRequest, device = this.options.device();
    const now = this.now();
    if (request.version !== 1 || !uuid.test(request.id) || !uuid.test(request.nonce) || request.to !== device.id || !contextValid(request.context)
      || request.context.hostId !== request.from || !OPERATIONS.includes(request.operation)
      || !Number.isSafeInteger(request.createdAt) || !Number.isSafeInteger(request.expiresAt) || request.createdAt > now + 1000 || request.expiresAt <= now
      || request.expiresAt - request.createdAt > MAX_TTL || request.expiresAt <= request.createdAt || request.createdAt < now - MAX_TTL) return fail();
    const peer = this.peer(request.from, { id: nodeRouteId, direction: 'node' });
    if (!verify(null, unsigned(request), signingKey(peer.device.signingKey), bytes(request.signature, 64))) return fail();
    const keys = this.options.deviceKeys();
    const digest = createHash('sha256').update(unsigned(request)).digest('hex');
    if (this.answering.has(request.id) || this.answering.size >= MAX_PENDING) return fail('SECRET_REMOTE_UNCERTAIN');
    this.answering.add(request.id);
    // A read is answered again within its deadline rather than claimed: it changes nothing here and only its sender can open it.
    const claimed = !READS.includes(request.operation);
    const payload = decode(request.payload);
    // Only a computer that follows this host asks for reasons; any other one gets today's answers.
    const reasons = (request.operation === 'list' || request.operation === 'resolve') && record(payload) && payload.reasons === true;
    let result: unknown; let reason: typeof REASONS[number] | undefined; let begun = !claimed;
    try {
      try {
        if (claimed && (!await this.options.begin(request.context, `remote-id:${request.from}:${request.id}`, digest)
          || !await this.options.begin(request.context, `remote-nonce:${request.from}:${request.nonce}`, digest))) return fail('SECRET_REMOTE_UNCERTAIN');
        begun = true;
      } catch (error) {
        // A first use in a folder nothing is shared with is told so, instead of going unanswered.
        if (!reasons || !(reason = reasonOf(error))) throw error;
      }
      if (reason) result = { ok: false, code: reason };
      else try {
        // Re-read trust immediately before the policy owner resolves the operation.
        const current = this.peer(request.from, { id: nodeRouteId, direction: 'node' });
        if (current.device.signingKey !== peer.device.signingKey || current.device.encryptionKey !== peer.device.encryptionKey || this.now() >= request.expiresAt) return fail();
        result = { ok: true, value: encode(await this.options.handle(request.context, { operation: request.operation, payload, id: request.id })) };
      } catch (error) { reason = reasons ? reasonOf(error) : undefined; result = { ok: false, code: reason ?? 'SECRET_REMOTE_UNAVAILABLE' }; }
      const stillTrusted = this.peer(request.from, { id: nodeRouteId, direction: 'node' });
      if (stillTrusted.device.signingKey !== peer.device.signingKey || stillTrusted.device.encryptionKey !== peer.device.encryptionKey || this.now() >= request.expiresAt) return fail();
      const ephemeral = generateKeyPairSync('x25519');
      const response = { version: 1 as const, id: request.id, nonce: request.nonce, from: device.id, to: request.from, expiresAt: request.expiresAt,
        ephemeralKey: ephemeral.publicKey.export({ type: 'spki', format: 'pem' }).toString(), iv: randomBytes(12).toString('base64url'), ciphertext: '', tag: '', signature: '' };
      const aad = binding(response);
      const key = sealKey(ephemeral.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), peer.device.encryptionKey, aad);
      try {
        const plaintext = Buffer.from(canonical(result));
        try {
          if (plaintext.length > MAX_PLAINTEXT) return fail('SECRET_REMOTE_TOO_LARGE');
          const cipher = createCipheriv('aes-256-gcm', key, bytes(response.iv, 12)); cipher.setAAD(aad);
          response.ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64url');
          response.tag = cipher.getAuthTag().toString('base64url');
        } finally { plaintext.fill(0); }
      } finally { key.fill(0); }
      response.signature = sign(null, unsigned(response), keys.signingPrivateKey).toString('base64url');
      wire(response, MAX_WIRE);
      // A refusal before the claim has no claim to finish.
      if (claimed && begun) await this.options.finish?.(request.context, `remote-id:${request.from}:${request.id}`, digest, response);
      if (reason) this.options.refused?.(request.context, { operation: request.operation, payload }, reason);
      return response;
    } finally { this.answering.delete(request.id); }
  }
  deliver(controllerRouteId: string, input: unknown): void {
    try { this.deliverVerified(controllerRouteId, input); } catch { return fail(); }
  }
  private deliverVerified(controllerRouteId: string, input: unknown): void {
    wire(input, MAX_WIRE);
    if (!record(input) || !exact(input, ['version', 'id', 'nonce', 'from', 'to', 'expiresAt', 'ephemeralKey', 'iv', 'ciphertext', 'tag', 'signature'])) return fail();
    const response = input as unknown as RemoteSecretResponse, pending = this.waiting.get(response.id);
    if (!pending) return fail();
    const peer = this.peer(response.from, { id: controllerRouteId, direction: 'controller' });
    if (response.version !== 1 || response.to !== this.options.device().id || response.from !== pending.peer.device.id || response.nonce !== pending.request.nonce
      || response.expiresAt !== pending.request.expiresAt || response.expiresAt <= this.now() || peer.device.signingKey !== pending.peer.device.signingKey
      || peer.device.encryptionKey !== pending.peer.device.encryptionKey || !short(response.ephemeralKey, 1024)
      || !verify(null, unsigned(response), signingKey(peer.device.signingKey), bytes(response.signature, 64))) return fail();
    const key = sealKey(this.options.deviceKeys().encryptionPrivateKey, response.ephemeralKey, binding(response));
    let result: unknown;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes(response.iv, 12)); decipher.setAAD(binding(response)); decipher.setAuthTag(bytes(response.tag, 16));
      const plaintext = Buffer.concat([decipher.update(bytes(response.ciphertext)), decipher.final()]);
      try { if (plaintext.length > MAX_PLAINTEXT) return fail(); result = JSON.parse(plaintext.toString('utf8')); } finally { plaintext.fill(0); }
    } catch { return fail(); } finally { key.fill(0); }
    if (!record(result) || typeof result.ok !== 'boolean' || !exact(result, result.ok ? ['ok', 'value'] : ['ok', 'code'])) return fail();
    const resolved = result.ok ? decode(result.value) : undefined;
    this.waiting.delete(response.id); clearTimeout(pending.timer);
    if (result.ok) pending.resolve(resolved);
    else pending.reject(refusal(REASONS.find(code => code === result.code) ?? 'SECRET_REMOTE_UNAVAILABLE'));
  }
  pending(): number { return this.waiting.size; }
  inFlight(): number { return this.answering.size; }
  close(): void {
    for (const pending of this.waiting.values()) { clearTimeout(pending.timer); pending.reject(refusal('SECRET_REMOTE_OFFLINE')); }
    this.waiting.clear();
  }
}
