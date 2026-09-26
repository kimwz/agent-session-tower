import { createHmac, timingSafeEqual, type X509Certificate } from 'node:crypto';
import http2, { type ClientHttp2Session, type Http2Server, type Http2ServerRequest, type Http2ServerResponse } from 'node:http2';
import { Duplex } from 'node:stream';
import tls, { type TLSSocket } from 'node:tls';
import { certificatePin } from './certificate.js';
import type { LinkIdentity } from './identity.js';

/** Bumped only for changes an older Tower cannot speak; peers on another protocol stay connected but idle. */
export const LINK_PROTOCOL = 1;
const EXPORTER_LABEL = 'EXPORTER-agent-session-tower-link';
export const LINK_PATH = '/tower-link';
export const MAX_FRAME_BYTES = 1024 * 1024;
/** Sent when a computer stops trusting its controller, so the controller can say so. */
export const REMOVED_CLOSE_CODE = 4001;

const peerPin = (socket: TLSSocket): string | undefined => {
  const certificate = socket.getPeerX509Certificate();
  return certificate ? certificatePin(certificate as X509Certificate) : undefined;
};
const field = (value: string) => { const bytes = Buffer.from(value); const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length); return Buffer.concat([size, bytes]); };

/**
 * Proof that the joining computer holds the code's secret, bound to this TLS session and both pinned keys:
 * nothing between the two computers can replay it on another connection.
 */
export function pairingProof(secret: string, exporter: Buffer, parts: { inviteId: string; controllerPin: string; nodePin: string }): string {
  return createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(Buffer.concat([field(exporter.toString('base64url')), field(parts.inviteId), field(parts.controllerPin), field(parts.nodePin), field('node'), field(String(LINK_PROTOCOL))]))
    .digest('base64url');
}
export function proofMatches(expected: string, supplied: unknown): boolean {
  if (typeof supplied !== 'string') return false;
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The controller's end. Whoever dialed, the controller is the TLS and HTTP/2 client: it asks, the other
 * computer answers. Resolves once TLS is up, with the peer's pin and this session's exporter.
 */
export function openControllerEnd(pipe: Duplex, identity: LinkIdentity): Promise<{ secure: TLSSocket; session: ClientHttp2Session; pin: string; exporter: Buffer }> {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket: pipe, key: identity.key, cert: identity.cert, rejectUnauthorized: false, checkServerIdentity: () => undefined,
      minVersion: 'TLSv1.3', ALPNProtocols: ['h2'] });
    const session = http2.connect('http://tower-node.invalid', { createConnection: () => secure, settings: { enablePush: false } });
    let settled = false;
    const fail = (error: Error) => { session.destroy(); secure.destroy(); if (!settled) { settled = true; reject(error); } };
    // A link can break at any layer at any time; each layer then closes instead of throwing.
    // The WebSocket pipe only reports its end; the link is never half-open, so either one tears TLS down.
    pipe.on('error', () => secure.destroy());
    for (const event of ['end', 'close']) pipe.once(event, () => secure.destroy());
    session.on('error', fail);
    secure.on('error', fail);
    secure.once('close', () => fail(new Error('The link closed before it was set up.')));
    secure.once('secureConnect', () => {
      const pin = peerPin(secure);
      if (!pin || secure.alpnProtocol !== 'h2') { fail(new Error('The other computer did not present a link identity.')); return; }
      settled = true;
      resolve({ secure, session, pin, exporter: secure.exportKeyingMaterial(32, EXPORTER_LABEL, Buffer.alloc(0)) });
    });
  });
}

/**
 * The node's end: TLS server with a required client certificate, then an HTTP/2 server for the controller's
 * requests. `accept` decides from the controller's pin whether this connection may continue.
 */
export function openNodeEnd(pipe: Duplex, identity: LinkIdentity, options: {
  accept: (pin: string) => boolean;
  handle: (req: Http2ServerRequest, res: Http2ServerResponse, link: { exporter: Buffer; pin: string }) => void;
  maxStreams?: number;
}): Promise<{ secure: TLSSocket; server: Http2Server; pin: string; exporter: Buffer }> {
  return new Promise((resolve, reject) => {
    const secure = new tls.TLSSocket(pipe, { isServer: true, key: identity.key, cert: identity.cert, requestCert: true, rejectUnauthorized: false,
      minVersion: 'TLSv1.3', ALPNProtocols: ['h2'] });
    let settled = false;
    const fail = (error: Error) => { secure.destroy(); if (!settled) { settled = true; reject(error); } };
    // The WebSocket pipe only reports its end; the link is never half-open, so either one tears TLS down.
    pipe.on('error', () => secure.destroy());
    for (const event of ['end', 'close']) pipe.once(event, () => secure.destroy());
    secure.on('error', fail);
    secure.once('close', () => fail(new Error('The link closed before it was set up.')));
    secure.once('secure', () => {
      const pin = peerPin(secure);
      if (!pin || !options.accept(pin)) { fail(Object.assign(new Error('The controller is not the one this computer trusts.'), { code: 'PIN_MISMATCH' })); return; }
      const exporter = secure.exportKeyingMaterial(32, EXPORTER_LABEL, Buffer.alloc(0));
      const server = http2.createServer({ settings: { maxConcurrentStreams: options.maxStreams ?? 64, enablePush: false }, maxSessionMemory: 64, maxHeaderListPairs: 64 },
        (req, res) => options.handle(req, res, { exporter, pin }));
      server.on('sessionError', () => secure.destroy());
      settled = true;
      // A server-side TLS socket over a JavaScript stream never reports itself connected to http2; hand it a plain stream.
      server.emit('connection', plain(secure));
      resolve({ secure, server, pin, exporter });
    });
  });
}

function plain(socket: TLSSocket): Duplex {
  const duplex = new Duplex({
    read() { socket.resume(); },
    write(chunk, encoding, callback) { socket.write(chunk, encoding, callback); },
    final(callback) { socket.end(); callback(); },
    destroy(error, callback) { socket.destroy(); callback(error); },
  });
  duplex.on('error', () => socket.destroy());
  socket.on('data', chunk => { if (!duplex.push(chunk)) socket.pause(); });
  socket.on('end', () => duplex.push(null));
  socket.on('close', () => duplex.destroy());
  return duplex;
}

/** A request over an established link, with a deadline for the answer; the body is read whole. */
export function linkRequest(session: ClientHttp2Session, method: string, path: string, body?: unknown, timeoutMs = 10_000, options: { maxBytes?: number; signal?: AbortSignal } = {}): Promise<{ status: number; json: unknown }> {
  const maxBytes = options.maxBytes ?? 1_000_000;
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    if (session.destroyed || session.closed) { reject(new Error('The link is closed.')); return; }
    if (options.signal?.aborted) { reject(new Error('The request was cancelled.')); return; }
    const stream = session.request({ ':method': method, ':path': path, ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) });
    let settled = false;
    const fail = (error: Error) => { if (settled) return; settled = true; clearTimeout(timer); reject(error); };
    const timer = setTimeout(() => { fail(new Error('The other computer did not answer in time.')); stream.close(http2.constants.NGHTTP2_CANCEL); }, timeoutMs);
    let status = 0;
    const chunks: Buffer[] = []; let size = 0;
    stream.on('response', headers => { status = Number(headers[':status']); });
    stream.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) { fail(new Error('The answer was too large.')); stream.close(http2.constants.NGHTTP2_CANCEL); } else chunks.push(chunk); });
    options.signal?.addEventListener('abort', () => { fail(new Error('The request was cancelled.')); stream.close(http2.constants.NGHTTP2_CANCEL); }, { once: true });
    stream.on('error', fail);
    stream.on('close', () => fail(new Error('The link closed before the answer arrived.')));
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let json: unknown;
      try { json = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined; } catch { json = undefined; }
      resolve({ status, json });
    });
    stream.end(payload);
  });
}
