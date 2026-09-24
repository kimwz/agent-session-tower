import { constants } from 'node:fs';
import { chmod, mkdir, open } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { certificatePin, createLinkCertificate } from './certificate.js';

/** This Tower's own identity on links: a key pair whose public key other Towers pin. */
export interface LinkIdentity {
  key: string;
  cert: string;
  /** SHA-256 of the public key, base64url. The only thing peers trust. */
  pin: string;
  /** Short lowercase ID derived from the pin; how other Towers name this one. */
  id: string;
  /** A human-comparable form of the pin, shown next to names. Checks always use the full pin. */
  fingerprint: string;
}

export function linkId(pin: string): string { return Buffer.from(pin, 'base64url').subarray(0, 16).toString('hex'); }
export function displayFingerprint(pin: string): string {
  const digits = Buffer.from(pin, 'base64url').subarray(0, 6).toString('hex').toUpperCase();
  return digits.match(/.{4}/g)!.join('-');
}

export function linkDirectory(stateDir: string): string { return join(stateDir, 'link'); }

/** Loads this Tower's link identity, creating it the first time. The key never leaves the state directory. */
export async function loadLinkIdentity(stateDir: string): Promise<LinkIdentity> {
  const directory = linkDirectory(stateDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = join(directory, 'identity.json');
  let saved: { key?: unknown; cert?: unknown } | undefined;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { saved = JSON.parse(await file.readFile('utf8')); } finally { await file.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (saved && (typeof saved.key !== 'string' || typeof saved.cert !== 'string')) throw new Error('The saved link identity is invalid.');
  const identity = saved as { key: string; cert: string } | undefined ?? createLinkCertificate(`agent-session-tower ${hostname()}`);
  if (!saved) {
    // Written once and never replaced: other Towers pinned this key.
    const file = await open(path, 'wx', 0o600).catch(async error => {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
      throw error;
    });
    if (file) { try { await file.writeFile(JSON.stringify(identity)); await file.sync(); } finally { await file.close(); } }
    else return loadLinkIdentity(stateDir);
  }
  const pin = certificatePin(identity.cert);
  return { key: identity.key, cert: identity.cert, pin, id: linkId(pin), fingerprint: displayFingerprint(pin) };
}
