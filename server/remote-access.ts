import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isIPv4 } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { resolve } from 'node:path';

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

export function accessPasswordPath(stateDir: string): string {
  return resolve(stateDir, 'access-password');
}

/** Call only while holding the state-directory lock. Never log the returned secret. */
export async function loadAccessPassword(stateDir: string): Promise<string> {
  const path = accessPasswordPath(stateDir);
  let created;
  try { created = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (created) {
    const password = randomBytes(32).toString('base64url');
    try { await created.writeFile(`${password}\n`); }
    finally { await created.close(); }
    return password;
  }
  const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await existing.stat();
    if (!stat.isFile() || stat.size > 128) throw new Error(`Invalid access password file: ${path}. Remove it while the monitor is stopped to generate a new password.`);
    await existing.chmod(0o600);
    const password = (await existing.readFile('utf8')).trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(password)) throw new Error(`Invalid access password file: ${path}. Remove it while the monitor is stopped to generate a new password.`);
    return password;
  } finally { await existing.close(); }
}
