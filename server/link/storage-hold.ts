import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, rm, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runtimePaths } from './service.js';

/**
 * The only writer and remover of the update's handoff hold (`runtime/handoff-hold`, read by readHold). A hold is a plain
 * file holding `{"version":"x.y.z"}`, the version whose update wrote it: that version, with the update record that
 * names it, owns it. Every JSON-only release writes it the same way, so a hold left by one is read and owned the same.
 *
 * Nothing here follows a link or writes into anything but a plain file it opened itself: a hold is created by linking a
 * fully written private file into place (which fails on anything already there, a link to nowhere included), and
 * refreshed through the very file it opened without following links, checked again to still be the one at the path.
 * Anything else at the path (a link, a folder, a hold another version wrote, one that changed meanwhile) is refused
 * with HoldError and left exactly as it is.
 */

const MAX_HOLD_BYTES = 4096;
const RELEASE = /^\d+\.\d+\.\d+$/;

export const holdPath = (stateDir: string) => join(runtimePaths(stateDir).root, 'handoff-hold');

export class HoldError extends Error {
  /** `hold-not-a-file`: a link, folder or special file; `hold-owned-elsewhere`: another version's hold, or one this build cannot read as any; `hold-replaced`: it changed while it was written or removed. */
  constructor(readonly code: 'hold-not-a-file' | 'hold-owned-elsewhere' | 'hold-replaced', message: string) { super(message); }
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const holdText = (version: string) => JSON.stringify({ version });

/** The hold's owning version, read through a descriptor that never followed a link; the descriptor is the caller's to close. */
async function openOwned(path: string): Promise<{ file: Awaited<ReturnType<typeof open>>; version: string | undefined; ino: number; dev: number } | undefined> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) {
    if (missing(error)) return undefined;
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new HoldError('hold-not-a-file', `${path} is a link; it is left as it is.`);
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new HoldError('hold-not-a-file', `${path} is not a regular file; it is left as it is.`);
    let version: string | undefined;
    if (info.size <= MAX_HOLD_BYTES) {
      try { const value = JSON.parse((await file.readFile()).toString('utf8')) as { version?: unknown }; if (typeof value?.version === 'string' && RELEASE.test(value.version)) version = value.version; } catch { version = undefined; }
    }
    return { file, version, ino: info.ino, dev: info.dev };
  } catch (error) { await file.close(); throw error; }
}
/** Whether `path` names, right now, the very file `opened` is (no link: lstat). */
async function stillThere(path: string, opened: { ino: number; dev: number }): Promise<boolean> {
  const info = await lstat(path).catch(() => undefined);
  return !!info && info.isFile() && info.ino === opened.ino && info.dev === opened.dev;
}
async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

/**
 * Holds the handoff for `version`'s update: creates the hold whole, or refreshes (its time) the one `version` already
 * owns, so a hold of any age counts as new. Answers what it did. Rejects (HoldError) for anything else at the path.
 */
export async function writeHold(stateDir: string, version: string): Promise<'created' | 'refreshed'> {
  if (!RELEASE.test(version)) throw new Error(`Not a released version: ${version}`);
  const path = holdPath(stateDir);
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(holdText(version)); await file.sync(); } finally { await file.close(); }
  try {
    try {
      await link(temporary, path);
      await syncDirectory(dirname(path));
      return 'created';
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  } finally { await rm(temporary, { force: true }); }
  const owned = await openOwned(path);
  if (!owned) throw new HoldError('hold-replaced', `${path} was removed while it was written; ask again.`);
  try {
    if (owned.version !== version) throw new HoldError('hold-owned-elsewhere', `${path} holds ${owned.version ?? 'something this build does not read as a hold'}, not ${version}; it is left as it is.`);
    const now = new Date();
    await owned.file.utimes(now, now);
  } finally { await owned.file.close(); }
  if (!await stillThere(path, owned)) throw new HoldError('hold-replaced', `${path} changed while it was refreshed; it is left as it is.`);
  return 'refreshed';
}

/**
 * Removes the hold `owner` names: `{ version }` only the hold that version owns; `{ expired: true }` the plain file
 * found there whatever version wrote it (a hold nobody released in time). Answers whether one was removed; nothing
 * there is not an error. A link, a folder or another version's hold rejects (HoldError) and is left as it is.
 */
export async function removeHold(stateDir: string, owner: { version: string } | { expired: true }): Promise<boolean> {
  const path = holdPath(stateDir);
  const owned = await openOwned(path);
  if (!owned) return false;
  try {
    if ('version' in owner && owned.version !== owner.version) throw new HoldError('hold-owned-elsewhere', `${path} holds ${owned.version ?? 'something this build does not read as a hold'}, not ${owner.version}; it is left as it is.`);
  } finally { await owned.file.close(); }
  // The very file judged, still at the path: unlink never follows a link, so at worst a file put there in this instant goes.
  if (!await stillThere(path, owned)) throw new HoldError('hold-replaced', `${path} changed while it was removed; it is left as it is.`);
  await unlink(path).catch(error => { if (!missing(error)) throw error; });
  return true;
}
