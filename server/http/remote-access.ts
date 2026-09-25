import { isIPv4 } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

/**
 * `publicUrls` are addresses a reverse proxy or tunnel serves Tower at. They count as remote access even on a loopback
 * bind: the proxy must keep that Host and send forwarding headers, so its requests sign in like any other device.
 */
export function networkAccess(host: string, port: number, interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(), publicUrls: string[] = []) {
  if (!isIPv4(host)) throw new Error('--host requires an IPv4 address, such as 127.0.0.1 or 0.0.0.0.');
  const published = publicUrls.map(publicOrigin);
  const remote = !host.startsWith('127.') || published.length > 0;
  const addresses = host === '0.0.0.0'
    ? [...new Set(Object.values(interfaces).flatMap(entries => entries || [])
      .filter(entry => entry.family === 'IPv4' && !entry.internal && isIPv4(entry.address))
      .map(entry => entry.address))]
    : [host];
  const direct = host.startsWith('127.') ? [] : addresses.map(address => new URL(`http://${address}:${port}`).origin);
  const urls = [...new Set([...direct, ...published])];
  const browserUrl = host === '0.0.0.0' || host === '127.0.0.1' ? `http://localhost:${port}` : host.startsWith('127.') ? `http://${host}:${port}` : direct[0];
  return { remote, origins: new Set(urls), browserUrl, urls, probeHosts: ['127.0.0.1', ...addresses.filter(address => address !== '127.0.0.1')] };
}

function publicOrigin(value: string): string {
  let url: URL | undefined;
  try { url = new URL(value); } catch { /* Reported below. */ }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(`--public-url requires an origin such as https://tower.example.com, not ${value}.`);
  }
  return url.origin;
}
