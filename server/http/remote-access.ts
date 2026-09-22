import { isIPv4 } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

export function networkAccess(host: string, port: number, interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()) {
  if (!isIPv4(host)) throw new Error('--host requires an IPv4 address, such as 127.0.0.1 or 0.0.0.0.');
  const remote = !host.startsWith('127.');
  const addresses = host === '0.0.0.0'
    ? [...new Set(Object.values(interfaces).flatMap(entries => entries || [])
      .filter(entry => entry.family === 'IPv4' && !entry.internal && isIPv4(entry.address))
      .map(entry => entry.address))]
    : [host];
  const urls = addresses.map(address => new URL(`http://${address}:${port}`).origin);
  const browserUrl = host === '0.0.0.0' || host === '127.0.0.1' ? `http://localhost:${port}` : urls[0];
  return { remote, origins: new Set(urls), browserUrl, urls: remote ? urls : [], probeHosts: ['127.0.0.1', ...addresses] };
}
