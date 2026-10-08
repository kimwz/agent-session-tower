import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runtimePaths } from './service.js';
import { readExact, withStorageTransition } from './storage-transition-lock.js';

/**
 * The only writer and remover of the update's handoff hold (`runtime/handoff-hold`, read by readHold). A hold is a plain
 * file holding `{"version":"x.y.z"}`, the version whose update wrote it: that version, with the update record that
 * names it, owns it. Every JSON-only release writes it the same way, so a hold left by one is read and owned the same.
 *
 * Every write and removal runs in the computer's transition turn (withStorageTransition), the one the pointer, the pin
 * and a rollback's records change in, taken after Updates.exclusive where a caller is in it: the update helper, the
 * web's recovery and the expired hold's removal never interleave with one another or with a switch. Nothing waits on a
 * worker or the network in it. A removal names what it judged: the version that owns the hold (with the update record
 * it judged, when it has one), or the very generation it found expired (HoldGeneration: its file, bytes and times). A
 * hold written, refreshed or replaced since is another generation and stays.
 *
 * Nothing here follows a link or writes into anything but a plain file it opened itself: a hold is created by linking a
 * fully written private file into place (which fails on anything already there, a link to nowhere included), refreshed
 * through the very file it opened, and removed by moving it aside first and checking that what was moved is the one
 * judged (anything else is put back). Anything else at the path (a link, a folder, a FIFO, a hold another version
 * wrote, one that changed meanwhile) is refused with HoldError and left as it is.
 *
 * A JSON-only release's helper or web writes and removes the hold without the turn. The turn cannot exclude it: a hold
 * that process replaces in the instant between the move and its check is put back, or, when something new stands there
 * by then, kept aside with a HoldError naming where. Whether such a process may still run is the caller's to tell
 * (handoffHeld keeps holding while a helper lock is running or cannot be told; only one web holds a state directory).
 */

const MAX_HOLD_BYTES = 4096;
const RELEASE = /^\d+\.\d+\.\d+$/;

export const holdPath = (stateDir: string) => join(runtimePaths(stateDir).root, 'handoff-hold');
const updateRecordPath = (stateDir: string) => join(runtimePaths(stateDir).root, 'update.json');

export class HoldError extends Error {
  /**
   * `hold-not-a-file`: a link, folder or special file; `hold-owned-elsewhere`: another version's hold, or one this build
   * cannot read as any; `hold-replaced`: it is not the generation judged (written, refreshed or replaced since), or it
   * changed while it was written or removed; `hold-update-changed`: the update record changed since the removal was judged.
   */
  constructor(readonly code: 'hold-not-a-file' | 'hold-owned-elsewhere' | 'hold-replaced' | 'hold-update-changed', message: string) { super(message); }
}

/**
 * One generation of the hold as it was found: its file (device and inode), its size, modification and change times
 * (nanoseconds) and the sha256 of its bytes, with the version it names (none when it names no released version).
 * Writing, refreshing or replacing the hold makes another generation.
 */
export interface HoldGeneration { version?: string; dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string; sha256: string }
export type HoldObservation = { state: 'absent' } | { state: 'present'; generation: HoldGeneration; ageMs: number };

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const holdText = (version: string) => JSON.stringify({ version });
const sameGeneration = (a: HoldGeneration, b: HoldGeneration) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.sha256 === b.sha256 && a.version === b.version;
const describe = (generation: HoldGeneration) => generation.version ?? 'something this build does not read as a hold';

/** The hold at `path` read through a descriptor that never followed a link; undefined when there is none. */
async function observe(path: string, now = Date.now()): Promise<{ generation: HoldGeneration; ageMs: number } | undefined> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) {
    if (missing(error)) return undefined;
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new HoldError('hold-not-a-file', `${path} is a link; it is left as it is.`);
    throw error;
  }
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile()) throw new HoldError('hold-not-a-file', `${path} is not a regular file; it is left as it is.`);
    const bytes = info.size <= MAX_HOLD_BYTES ? await file.readFile() : Buffer.alloc(0);
    let version: string | undefined;
    try { const value = JSON.parse(bytes.toString('utf8')) as { version?: unknown }; if (typeof value?.version === 'string' && RELEASE.test(value.version)) version = value.version; } catch { version = undefined; }
    const generation: HoldGeneration = {
      ...(version ? { version } : {}), dev: String(info.dev), ino: String(info.ino), size: String(info.size), mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs),
      sha256: createHash('sha256').update(info.size <= MAX_HOLD_BYTES ? bytes : `${info.size}`).digest('hex'),
    };
    return { generation, ageMs: Math.max(0, now - Number(info.mtimeMs)) };
  } finally { await file.close(); }
}

/**
 * The hold as it is now, without the turn: its generation and age, for a caller that judges it (an expired hold) and
 * then removes exactly that generation (removeHold). Rejects (HoldError) for anything at the path that is not a plain file.
 */
export async function observeHold(stateDir: string, now = Date.now()): Promise<HoldObservation> {
  const found = await observe(holdPath(stateDir), now);
  return found ? { state: 'present', ...found } : { state: 'absent' };
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}
/** Whether `path` names, right now, the very file `generation` is (no link: lstat). */
async function stillThere(path: string, generation: HoldGeneration): Promise<boolean> {
  // best-effort: An unreadable path cannot prove ownership; writeHold reports hold-replaced.
  const info = await lstat(path, { bigint: true }).catch(() => undefined);
  return !!info && info.isFile() && String(info.ino) === generation.ino && String(info.dev) === generation.dev;
}

/**
 * Holds the handoff for `version`'s update, in the transition turn: creates the hold whole, or refreshes (its time) the
 * one `version` already owns, so a hold of any age counts as new (and is a new generation). Answers what it did.
 * Rejects (HoldError) for anything else at the path, and (TransitionLockError) when the turn cannot be taken.
 */
export function writeHold(stateDir: string, version: string): Promise<'created' | 'refreshed'> {
  if (!RELEASE.test(version)) return Promise.reject(new Error(`Not a released version: ${version}`));
  return withStorageTransition(stateDir, async () => {
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
    let owned;
    try { owned = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) {
      if (missing(error)) throw new HoldError('hold-replaced', `${path} was removed while it was written; ask again.`);
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new HoldError('hold-not-a-file', `${path} is a link; it is left as it is.`);
      throw error;
    }
    let generation: HoldGeneration;
    try {
      const found = await observe(path);
      const info = await owned.stat({ bigint: true });
      if (!info.isFile()) throw new HoldError('hold-not-a-file', `${path} is not a regular file; it is left as it is.`);
      if (!found || found.generation.ino !== String(info.ino) || found.generation.dev !== String(info.dev)) throw new HoldError('hold-replaced', `${path} changed while it was refreshed; it is left as it is.`);
      generation = found.generation;
      if (generation.version !== version) throw new HoldError('hold-owned-elsewhere', `${path} holds ${describe(generation)}, not ${version}; it is left as it is.`);
      const now = new Date();
      await owned.utimes(now, now);
    } finally { await owned.close(); }
    if (!await stillThere(path, generation)) throw new HoldError('hold-replaced', `${path} changed while it was refreshed; it is left as it is.`);
    return 'refreshed';
  });
}

/** The sha256 of update.json's bytes, null when there is none: what a removal judged on must still be there. */
async function updateSha(stateDir: string): Promise<string | null> {
  const bytes = await readExact(updateRecordPath(stateDir), 1024 * 1024);
  return bytes ? createHash('sha256').update(bytes).digest('hex') : null;
}

/**
 * Removes the hold, in the transition turn, only as `owner` judged it: `{ version }` the hold that version owns (and,
 * with `update`, only while update.json is still the record with that sha256, null for none); `{ generation }` that very
 * generation (an expired hold as observeHold found it), whatever version it names. Answers whether one was removed;
 * nothing there is not an error. Anything else (a link, a folder, another version's hold, another generation, an update
 * recorded since) rejects with HoldError and is left as it is.
 */
export function removeHold(stateDir: string, owner: { version: string; update?: string | null } | { generation: HoldGeneration }): Promise<boolean> {
  return withStorageTransition(stateDir, async () => {
    const path = holdPath(stateDir);
    const found = await observe(path);
    if (!found) return false;
    const judged = found.generation;
    if ('generation' in owner) {
      if (!sameGeneration(judged, owner.generation)) throw new HoldError('hold-replaced', `${path} is not the hold judged (${describe(judged)} now); it is left as it is.`);
    } else {
      if (judged.version !== owner.version) throw new HoldError('hold-owned-elsewhere', `${path} holds ${describe(judged)}, not ${owner.version}; it is left as it is.`);
      if (owner.update !== undefined && await updateSha(stateDir) !== owner.update) throw new HoldError('hold-update-changed', `The update record changed since the hold of ${owner.version} was judged released; it is left as it is.`);
    }
    // Moved aside, then checked: what was moved is the file judged, with the same bytes and modification time (a move
    // may change its change time), or it goes back.
    const aside = `${path}.removing.${process.pid}.${randomBytes(6).toString('hex')}`;
    try { await rename(path, aside); } catch (error) { if (missing(error)) return false; throw error; }
    // best-effort: If the moved hold cannot be verified, restore it or report the preserved aside path.
    const moved = await observe(aside).catch(() => undefined);
    if (!moved || !sameFile(moved.generation, judged)) {
      if (!await putBack(aside, path)) throw new HoldError('hold-replaced', `${path} changed while it was removed; what stood there is kept at ${aside}, and the path is left as it is.`);
      throw new HoldError('hold-replaced', `${path} changed while it was removed; it is put back as it was.`);
    }
    await unlink(aside);
    await syncDirectory(dirname(path));
    return true;
  });
}

const sameFile = (a: HoldGeneration, b: HoldGeneration) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.sha256 === b.sha256 && a.version === b.version;
/**
 * Puts what a removal moved aside back at `path`, never over anything that stands there now: a plain file by linking it
 * (which fails on anything there); a link, folder or special file (which a link cannot recreate as it is) only while
 * nothing stands there. False when it could not go back; it is then kept aside.
 */
async function putBack(aside: string, path: string): Promise<boolean> {
  // best-effort: If the aside cannot be inspected, leave it in place and report restoration failure.
  const info = await lstat(aside).catch(() => undefined);
  if (!info) return false;
  if (info.isFile()) {
    // best-effort: A failed restore link leaves the aside intact; removeHold reports its preserved path.
    try { await link(aside, path); } catch { return false; }
    await rm(aside, { force: true });
    return true;
  }
  if (await lstat(path).then(() => true, error => !missing(error))) return false;
  // best-effort: A failed restore rename leaves the aside intact; removeHold reports its preserved path.
  try { await rename(aside, path); return true; } catch { return false; }
}
