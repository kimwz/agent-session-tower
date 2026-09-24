import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { canonicalIp, isLoopbackAddress } from '../auth/store.js';

export const SESSION_COOKIE = 'tower_session';

/** Only a direct loopback connection addressed to loopback may bypass login. */
export function requestIdentity(req: IncomingMessage): { ip: string; local: boolean } {
  const ip = canonicalIp(req.socket.remoteAddress || '');
  let hostname = '';
  try { hostname = new URL(`http://${req.headers.host}`).hostname; } catch { /* Deny bypass. */ }
  const forwarded = Object.keys(req.headers).some(name => name === 'forwarded' || name.startsWith('x-forwarded-') || name === 'x-real-ip');
  const localHost = hostname === 'localhost' || isLoopbackAddress(hostname.replace(/^\[|\]$/g, ''));
  return { ip, local: isLoopbackAddress(ip) && localHost && !forwarded };
}

/**
 * A local request (see `requestIdentity`) made by the user this server runs as. On Linux, where one computer often has
 * several accounts and Tower may run as root, a connection from another account is not local: it signs in like any other.
 */
export async function ownerIdentity(req: IncomingMessage): Promise<{ ip: string; local: boolean }> {
  const identity = requestIdentity(req);
  if (!identity.local || process.platform !== 'linux' || typeof process.getuid !== 'function') return identity;
  return await loopbackPeer(req.socket) === process.getuid() ? identity : { ...identity, local: false };
}

const peers = new WeakMap<Socket, Promise<number | undefined>>();
/** Which user opened a loopback connection, once per connection. */
function loopbackPeer(socket: Socket): Promise<number | undefined> {
  let known = peers.get(socket);
  if (!known) {
    const { remotePort, localPort } = socket;
    known = Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map(table => readFile(table, 'utf8').catch(() => '')))
      .then(tables => remotePort && localPort ? socketOwner(tables, remotePort, localPort) : undefined);
    peers.set(socket, known);
  }
  return known;
}

/**
 * The owner of the socket whose own end is `peerPort` and whose other end is `ownPort`, from the kernel's socket tables
 * (/proc/net/tcp and tcp6: local address, remote address, ..., uid in the eighth column). Undefined when none matches.
 */
export function socketOwner(tables: readonly string[], peerPort: number, ownPort: number): number | undefined {
  const port = (value: number) => `:${value.toString(16).toUpperCase().padStart(4, '0')}`;
  for (const table of tables) {
    for (const line of table.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length >= 8 && fields[1].endsWith(port(peerPort)) && fields[2].endsWith(port(ownPort)) && /^\d+$/.test(fields[7])) return Number(fields[7]);
    }
  }
  return undefined;
}

export function sessionCookie(req: IncomingMessage): string {
  const values = (req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${SESSION_COOKIE}=`));
  if (values.length !== 1) return '';
  const value = values[0].slice(SESSION_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{32,128}$/.test(value) ? value : '';
}

export function setSessionCookie(req: IncomingMessage, res: ServerResponse, sessionId: string, secureOrigin: boolean): void {
  const secure = ('encrypted' in req.socket && req.socket.encrypted) || secureOrigin;
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionId ? 12 * 60 * 60 : 0}${secure ? '; Secure' : ''}`);
}
