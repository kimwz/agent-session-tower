import { execFile } from 'node:child_process';
import { hostname, networkInterfaces } from 'node:os';
import { isIPv4 } from 'node:net';

import type { LinkAddress } from '../../shared/link.js';

let tailscaleName: string | undefined;
let tailscaleCheckedAt = 0;
/** The Tailscale machine name stays the same wherever the computer goes; looked up in the background. */
function refreshTailscaleName(): void {
  if (Date.now() - tailscaleCheckedAt < 5 * 60_000) return;
  tailscaleCheckedAt = Date.now();
  const candidates = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', 'tailscale'];
  const attempt = (index: number) => {
    if (index >= candidates.length) return;
    execFile(candidates[index], ['status', '--json', '--self=true', '--peers=false'], { timeout: 2000, maxBuffer: 256 * 1024 }, (error, stdout) => {
      if (error) { attempt(index + 1); return; }
      try {
        const name = (JSON.parse(stdout) as { Self?: { DNSName?: unknown } }).Self?.DNSName;
        tailscaleName = typeof name === 'string' && /^[a-z0-9.-]+\.$/i.test(name) ? name.slice(0, -1) : undefined;
      } catch { tailscaleName = undefined; }
    });
  };
  attempt(0);
}

const tailscaleRange = (address: string) => { const [a, b] = address.split('.').map(Number); return a === 100 && b >= 64 && b <= 127; };

/**
 * Where other computers can reach this link port, most stable first: addresses the owner entered, the
 * Tailscale name and address, this computer's .local name, then its LAN addresses.
 */
export function advertisedAddresses(port: number, custom: readonly string[] = []): LinkAddress[] {
  refreshTailscaleName();
  const url = (host: string) => `ws://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}/tower-link`;
  const addresses: LinkAddress[] = custom.map(value => ({ url: value, kind: 'custom' as const }));
  const ipv4 = Object.values(networkInterfaces()).flatMap(entries => entries ?? []).filter(entry => entry.family === 'IPv4' && !entry.internal && isIPv4(entry.address)).map(entry => entry.address);
  if (tailscaleName) addresses.push({ url: url(tailscaleName), kind: 'tailscale' });
  for (const address of ipv4.filter(tailscaleRange)) addresses.push({ url: url(address), kind: 'tailscale' });
  const name = hostname().replace(/\.local$/i, '');
  if (/^[a-z0-9-]+$/i.test(name)) addresses.push({ url: url(`${name}.local`), kind: 'local-name' });
  for (const address of ipv4.filter(address => !tailscaleRange(address))) addresses.push({ url: url(address), kind: 'lan' });
  return [...new Map(addresses.map(item => [item.url, item])).values()];
}
