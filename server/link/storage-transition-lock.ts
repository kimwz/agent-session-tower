import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { processStart } from '../instance/process-start.js';

/**
 * One turn, for the whole computer, at changing what the background service starts: the `current` pointer, the owner's
 * pin and a rollback's switch. The web (an owner's rollback, a pin release), the update helper (its switch) and the CLI
 * (install and join, through useVersion) are separate processes, so the turn is an exclusive file beside `current`.
 * Only short file steps run inside it; nothing waits on a worker or the network there.
 *
 * The lock is published whole (written to a private file, then linked into place), so it is never seen empty. One whose
 * owner no longer runs is broken under a second, equally exclusive breaker file; a lock or breaker that is not a plain
 * file this build wrote is never broken and fails the turn.
 */

const MAX_LOCK_BYTES = 256;
const WAIT_MS = 30_000;
const POLL_MS = 25;

export const transitionLockPath = (stateDir: string) => join(stateDir, 'runtime', 'storage-transition.lock');
/** The owner's pin (see storage-update.ts): the version the service keeps while it is there. */
export const storagePinPath = (stateDir: string) => join(stateDir, 'runtime', 'storage-pin.json');

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

/** An owner's file as it is: never followed through a link, never chmodded, at most `maxBytes`. Undefined when absent. */
export async function readExact(path: string, maxBytes: number): Promise<Buffer | undefined> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error) { if (missing(error)) return undefined; throw error; }
  try {
    const info = await file.stat();
    if (!info.isFile()) throw Object.assign(new Error(`${path} is not a regular file.`), { code: info.isDirectory() ? 'EISDIR' : 'ENOTFILE' });
    if (info.size > maxBytes) throw Object.assign(new Error(`${path} is too large.`), { code: 'EFBIG' });
    return await file.readFile();
  } finally { await file.close(); }
}

/** Keeps the service on one version: no update, scheduler, controller or install moves it, and pruning keeps its artifact. */
export interface StoragePin {
  format: 'tower-storage-pin';
  version: 1;
  pinned: string;
  sourceHash: string;
  manifestDigest: string;
  /** sha256 of the artifact's entry point when it was validated. */
  entrySha256: string;
  /** The rollback that wrote it; only that rollback's record releases it. */
  rollbackId: string;
  by: string;
  reason: string;
  at: string;
}
export type PinRead = { state: 'absent' } | { state: 'present'; pin: StoragePin } | { state: 'invalid'; reason: string } | { state: 'unreadable'; reason: string };

const RELEASE = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const isText = (value: unknown, maximum: number) => typeof value === 'string' && !!value.trim() && value.length <= maximum;

export async function readStoragePin(stateDir: string): Promise<PinRead> {
  let bytes: Buffer | undefined;
  try { bytes = await readExact(storagePinPath(stateDir), 64 * 1024); } catch (error) { return { state: 'unreadable', reason: messageOf(error) }; }
  if (!bytes) return { state: 'absent' };
  let value: Record<string, unknown>;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { return { state: 'invalid', reason: 'The version pin is not JSON.' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.format !== 'tower-storage-pin' || value.version !== 1 || typeof value.pinned !== 'string' || !RELEASE.test(value.pinned)
    || !SHA256.test(String(value.sourceHash)) || !SHA256.test(String(value.manifestDigest)) || !SHA256.test(String(value.entrySha256))
    || !isText(value.rollbackId, 64) || !isText(value.by, 200) || typeof value.reason !== 'string' || value.reason.length > 2000 || typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at))) {
    return { state: 'invalid', reason: 'The version pin has an unknown format.' };
  }
  return { state: 'present', pin: value as unknown as StoragePin };
}

type Owner = { state: 'absent' } | { state: 'held'; text: string; pid: number; start: string } | { state: 'unreadable'; reason: string };
async function readOwner(path: string): Promise<Owner> {
  let bytes: Buffer | undefined;
  try { bytes = await readExact(path, MAX_LOCK_BYTES); } catch (error) { return { state: 'unreadable', reason: messageOf(error) }; }
  if (!bytes) return { state: 'absent' };
  const text = bytes.toString('utf8');
  const [pidText, ...rest] = text.split(' ');
  const pid = Number(pidText);
  if (!(pid > 0) || !Number.isInteger(pid)) return { state: 'unreadable', reason: `${path} names no process.` };
  return { state: 'held', text, pid, start: rest.join(' ') };
}
/** Whether the process that wrote `owner` still runs: its pid, started at the time it wrote (a start that cannot be told counts as running). */
async function running(owner: { pid: number; start: string }): Promise<boolean> {
  try { process.kill(owner.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false; }
  if (!owner.start) return true;
  const now = await processStart(owner.pid);
  return now === undefined || now === owner.start;
}

let ownStart: Promise<string> | undefined;
const me = async () => `${process.pid} ${await (ownStart ??= processStart(process.pid).then(start => start ?? ''))}`.trim();

/** Publishes `text` at `path` whole, or answers false when something is already there. */
async function publish(path: string, text: string): Promise<boolean> {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  try { await link(temporary, path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally { await rm(temporary, { force: true }); }
}
/** Removes `path` only while it still holds `text`. */
async function removeIfStill(path: string, text: string): Promise<void> {
  const owner = await readOwner(path);
  if (owner.state === 'held' && owner.text === text) await rm(path, { force: true });
}

const turns = new AsyncLocalStorage<Set<string>>();

/**
 * Runs `work` in this state directory's transition turn. A nested call from inside `work` runs in the same turn.
 * Rejects (code `transition-busy`) when another live process keeps the turn longer than `waitMs`, and (code
 * `transition-lock-unreadable`) when the lock is not a file this build can tell; nothing is broken then.
 */
export async function withStorageTransition<T>(stateDir: string, work: () => Promise<T>, options: { waitMs?: number } = {}): Promise<T> {
  const key = resolve(stateDir);
  const held = turns.getStore();
  if (held?.has(key)) return work();
  const path = transitionLockPath(stateDir);
  await mkdir(join(stateDir, 'runtime'), { recursive: true, mode: 0o700 });
  const text = await me();
  const deadline = Date.now() + (options.waitMs ?? WAIT_MS);
  for (;;) {
    if (await publish(path, text)) break;
    const owner = await readOwner(path);
    if (owner.state === 'unreadable') throw Object.assign(new Error(`The storage transition lock cannot be read: ${owner.reason}`), { code: 'transition-lock-unreadable' });
    if (owner.state === 'held' && !await running(owner) && await breakStale(path, owner.text)) continue;
    if (Date.now() >= deadline) throw Object.assign(new Error('Another Tower process is changing which version the service starts; try again in a moment.'), { code: 'transition-busy' });
    await new Promise(done => setTimeout(done, POLL_MS));
  }
  try {
    return await turns.run(new Set([...held ?? [], key]), work);
  } finally {
    await removeIfStill(path, text);
  }
}

/**
 * Removes a lock whose owner is gone, under the breaker, and only if it is still that very lock. Answers whether the
 * breaker was taken (the lock is then gone or someone else's); false while another process breaks it.
 */
async function breakStale(path: string, stale: string): Promise<boolean> {
  const breaker = `${path}.break`;
  const text = `${await me()} ${createHash('sha256').update(stale).digest('hex').slice(0, 16)}`;
  if (!await publish(breaker, text)) {
    const owner = await readOwner(breaker);
    if (owner.state === 'unreadable') throw Object.assign(new Error(`The storage transition breaker cannot be read: ${owner.reason}`), { code: 'transition-lock-unreadable' });
    // A breaker left by a process that stopped while breaking: removed only while it is still that one.
    if (owner.state === 'held' && !await running(owner)) await removeIfStill(breaker, owner.text);
    return false;
  }
  try {
    const owner = await readOwner(path);
    if (owner.state === 'held' && owner.text === stale) await rm(path, { force: true });
    return true;
  } finally { await removeIfStill(breaker, text); }
}
