import { randomBytes } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { readPrivateBytes } from '../stores/private-json.js';

/**
 * The machine key of a computer that follows a host ("호스트 설정 따르기"): 32 random bytes in `<state>/secrets/machine-key`
 * (0600), which open that computer's vault without a password (`SecretVault.machineWrap`). A vault made for it uses the
 * key's base64url text as its vault (recovery) password too, so a build without machine keys still opens it with that
 * text. Besides this file and the worker's memory the key goes only into this computer's passphrase-encrypted backups
 * (`machineKeyOf`), so that vault restores elsewhere: never into logs, argv or environments.
 */
const FILE = 'machine-key';

const path = (stateDir: string) => join(stateDir, 'secrets', FILE);
const parse = (bytes: Buffer): Buffer => {
  let saved: { format?: unknown; key?: unknown } | null;
  try { saved = JSON.parse(bytes.toString('utf8')) as typeof saved; } catch { saved = null; }
  const key = saved?.format === 1 && typeof saved.key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(saved.key) ? Buffer.from(saved.key, 'base64url') : undefined;
  if (!key || key.length !== 32) throw new Error('The machine key file is not one this build reads.');
  return key;
};

/** The saved machine key, or undefined when there is none yet. */
export async function readMachineKey(stateDir: string): Promise<Buffer | undefined> {
  try { return parse(await readPrivateBytes(path(stateDir), 4096)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

/** The saved machine key, made first when there is none; one made at the same moment by another process wins. */
export async function ensureMachineKey(stateDir: string): Promise<Buffer> {
  const existing = await readMachineKey(stateDir);
  if (existing) return existing;
  const directory = join(stateDir, 'secrets');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid vault directory');
  await chmod(directory, 0o700);
  const key = randomBytes(32); const temporary = `${path(stateDir)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ format: 1, key: key.toString('base64url') })); await file.sync(); } finally { await file.close(); }
    // Whole or not at all, and never over a key a vault may already be wrapped with.
    await link(temporary, path(stateDir));
    const folder = await open(directory, 'r');
    try { await folder.sync(); } finally { await folder.close(); }
    return key;
  } catch (error) {
    key.fill(0);
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return (await readMachineKey(stateDir))!;
  } finally { await unlink(temporary).catch(() => {}); } // best-effort: a leftover temporary file holds a key no vault uses
}

/** The vault password of a vault made for the machine key: the key as text. */
export const machinePassword = (key: Buffer) => key.toString('base64url');
