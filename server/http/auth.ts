import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { endianness } from 'node:os';
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
    const { remoteAddress, remotePort, localAddress, localPort } = socket;
    known = !remoteAddress || !remotePort || !localAddress || !localPort ? Promise.resolve(undefined) : (async () => {
      // The kernel lists its sockets while they change, so a busy computer can leave one out of a reading; read again.
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, 20 * attempt));
        const table = await readFile(remoteAddress.includes(':') ? '/proc/net/tcp6' : '/proc/net/tcp', 'utf8').catch(() => undefined);
        if (table === undefined) return undefined;
        const owner = socketOwner(table, { address: remoteAddress, port: remotePort }, { address: localAddress, port: localPort });
        if (owner !== undefined) return owner;
      }
      return undefined;
    })();
    peers.set(socket, known);
  }
  return known;
}

/** An address and port as the kernel's socket tables print them: in this computer's byte order (`order`). */
export function tableEndpoint(address: string, port: number, order: 'LE' | 'BE' = endianness()): string | undefined {
  const hex = (bytes: number[]) => bytes.map(byte => byte.toString(16).toUpperCase().padStart(2, '0')).join('');
  const tail = `:${port.toString(16).toUpperCase().padStart(4, '0')}`;
  if (!address.includes(':')) {
    const bytes = address.split('.').map(Number);
    if (bytes.length !== 4 || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) return undefined;
    return hex(order === 'LE' ? [...bytes].reverse() : bytes) + tail;
  }
  const bytes = ipv6Bytes(address);
  if (!bytes) return undefined;
  // Four 32-bit words, each in the computer's own byte order.
  const words = [0, 4, 8, 12].map(at => bytes.slice(at, at + 4));
  return hex(order === 'LE' ? words.flatMap(word => [...word].reverse()) : bytes) + tail;
}
function ipv6Bytes(address: string): number[] | undefined {
  let text = address.replace(/%.*$/, '');
  const embedded = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (embedded) {
    const [a, b, c, d] = embedded.slice(1).map(Number);
    text = `${text.slice(0, -embedded[0].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail, extra] = text.split('::');
  if (extra !== undefined) return undefined;
  const groups = (part: string) => part ? part.split(':') : [];
  const all = tail === undefined ? groups(head) : [...groups(head), ...Array(8 - groups(head).length - groups(tail).length).fill('0'), ...groups(tail)];
  if (all.length !== 8 || all.some(group => !/^[0-9a-f]{1,4}$/i.test(group))) return undefined;
  return all.flatMap(group => { const value = parseInt(group, 16); return [value >> 8, value & 255]; });
}

/**
 * The owner of the one live connection from `peer` to `own`, from a kernel socket table (/proc/net/tcp or tcp6: local
 * address, remote address, state, ..., uid in the eighth column, inode in the tenth). Rows no process holds (waiting to
 * close, listening, or without an inode) are not owners; when no single connection matches, the owner is unknown.
 */
export function socketOwner(table: string, peer: { address: string; port: number }, own: { address: string; port: number }, order: 'LE' | 'BE' = endianness()): number | undefined {
  const from = tableEndpoint(peer.address, peer.port, order);
  const to = tableEndpoint(own.address, own.port, order);
  if (!from || !to) return undefined;
  const rows = table.split('\n').slice(1).map(line => line.trim().split(/\s+/))
    .filter(fields => fields.length >= 10 && fields[1] === from && fields[2] === to && fields[3] !== '06' && fields[3] !== '0A' && fields[9] !== '0' && /^\d+$/.test(fields[7]));
  // A socket listed twice by one reading is still one socket.
  const sockets = new Map(rows.map(fields => [fields[9], Number(fields[7])]));
  return sockets.size === 1 ? [...sockets.values()][0] : undefined;
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
