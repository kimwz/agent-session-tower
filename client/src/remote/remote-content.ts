import { createContext, useContext } from 'react';

/**
 * Set while a joined computer's conversation is shown. Its links to that computer's own addresses (localhost, a
 * LAN or link-local address) would open something on this computer instead, so they are shown as text there.
 */
export const RemoteContent = createContext<string | undefined>(undefined);
export const useRemoteContent = () => useContext(RemoteContent);

/** Whether a link from another computer points at an address that only means something on that computer. */
const BASE = 'https://link-base.invalid/';
export function localOnlyAddress(href: string | undefined): boolean {
  if (!href) return false;
  let url: URL;
  // Resolved the way the browser would, so `//localhost:3000` and `/path` are seen for what they open.
  try { url = new URL(href, BASE); } catch { return true; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.origin === new URL(BASE).origin) return true;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.') && !host.includes(':')) return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
  if (v4) {
    const [a, b] = v4;
    return a === 0 || a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (!host.includes(':')) return false;
  return host === '::' || host === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host) || host.startsWith('::ffff:');
}
