import type { IncomingMessage, ServerResponse } from 'node:http';
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
