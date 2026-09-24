import { createContext, useContext } from 'react';

/**
 * Set while a joined computer's conversation is shown. Its links to that computer's own addresses (localhost, a
 * LAN or link-local address) would open something on this computer instead, so they are shown as text there.
 */
export const RemoteContent = createContext<string | undefined>(undefined);
export const useRemoteContent = () => useContext(RemoteContent);

/** Whether a link from another computer points at an address that only means something on that computer. */
export function localOnlyAddress(href: string | undefined): boolean {
  if (!href) return false;
  let host: string;
  try { host = new URL(href).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return false; }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '0.0.0.0' || host === '::' || host === '::1') return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
  if (v4) {
    const [a, b] = v4;
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  return /^(fc|fd|fe80:)/.test(host) || host.startsWith('::ffff:');
}
