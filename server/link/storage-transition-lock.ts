import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { processStart } from '../instance/process-start.js';

/**
 * One turn, for the whole computer, at changing what the background service starts: the `current` pointer, the owner's
 * pin and a rollback's records. The web (an owner's rollback, a pin release), the update helper (its switch) and the
 * CLI (install and join, through useVersion) are separate processes, so the turn is an exclusive file beside `current`.
 * Only short file steps run inside it; nothing waits on a worker or the network there.
 *
 * The lock is published whole (written to a private file, then linked into place), so it is never seen empty. It names
 * its owner (pid and start time) apart from anything else in it. A lock whose owner no longer runs is removed only by
 * the one process holding the breaker, a second file published the same way, after it read the very same lock again:
 * nothing else removes another process's lock, so no new owner's lock is ever removed in its place. A breaker is never
 * removed by anyone but its own process: one left by a process that stopped (or one whose owner cannot be told) beside a
 * stale lock refuses the turn (`transition-lock-stale-breaker`) and both files are kept for the owner's explicit
 * recovery (W0I). A lock or breaker that is not a plain file this build wrote is never removed and fails the turn.
 */

const MAX_LOCK_BYTES = 512;
const WAIT_MS = 30_000;
const POLL_MS = 25;
const OWNER_FORMAT = 'tower-transition-owner';

export const transitionLockPath = (stateDir: string) => join(stateDir, 'runtime', 'storage-transition.lock');
export const transitionBreakerPath = (stateDir: string) => `${transitionLockPath(stateDir)}.break`;
/** The owner's pin (see storage-update.ts): the version the service keeps while it is there. */
export const storagePinPath = (stateDir: string) => join(stateDir, 'runtime', 'storage-pin.json');

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * An owner's file as it is: never followed through a link, never waited on (a FIFO or device is opened without
 * blocking and refused), never chmodded, at most `maxBytes`. Undefined when absent.
 */
export async function readExact(path: string, maxBytes: number): Promise<Buffer | undefined> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) { if (missing(error)) return undefined; throw error; }
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

// ---- Who owns a file: a process told by its pid and start time. ----

/** A process as the system tells it: its pid, and when it started (empty when the system could not say). */
export interface ProcessIdentity { pid: number; start: string }
/** `unknown`: the pid runs, and whether it is the same process cannot be told. Never taken for `gone`. */
export type Liveness = 'running' | 'gone' | 'unknown';

/** Whether `owner` still runs: its pid, as the process that started at `start`. */
export async function liveness(owner: ProcessIdentity): Promise<Liveness> {
  try { process.kill(owner.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') return 'gone'; }
  const now = await processStart(owner.pid);
  if (now === undefined || !owner.start) return 'unknown';
  return now === owner.start ? 'running' : 'gone';
}

let ownStart: Promise<string> | undefined;
/** This process, as liveness() tells it. */
export async function thisProcess(): Promise<ProcessIdentity> {
  return { pid: process.pid, start: await (ownStart ??= processStart(process.pid).then(start => start ?? '')) };
}

/** What a lock or breaker file says: its owner, apart from its nonce. */
interface OwnerFile { format: typeof OWNER_FORMAT; version: 1; role: 'lock' | 'breaker'; pid: number; start: string; nonce: string; breaks?: string }
type Owner = { state: 'absent' } | { state: 'held'; text: string; owner: OwnerFile } | { state: 'unreadable'; reason: string };

async function readOwner(path: string, role: OwnerFile['role']): Promise<Owner> {
  let bytes: Buffer | undefined;
  try { bytes = await readExact(path, MAX_LOCK_BYTES); } catch (error) { return { state: 'unreadable', reason: messageOf(error) }; }
  if (!bytes) return { state: 'absent' };
  const text = bytes.toString('utf8');
  let value: Record<string, unknown>;
  try { value = JSON.parse(text); } catch { return { state: 'unreadable', reason: `${path} is not an owner this build wrote.` }; }
  if (!value || typeof value !== 'object' || value.format !== OWNER_FORMAT || value.version !== 1 || value.role !== role || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0
    || typeof value.start !== 'string' || value.start.length > 120 || typeof value.nonce !== 'string' || !/^[0-9a-f]{16,64}$/.test(value.nonce)
    || (value.breaks !== undefined && (typeof value.breaks !== 'string' || !/^[0-9a-f]{16,64}$/.test(value.breaks)))) {
    return { state: 'unreadable', reason: `${path} is not an owner this build wrote.` };
  }
  return { state: 'held', text, owner: value as unknown as OwnerFile };
}

/** Publishes `text` at `path` whole, or answers false when something is already there (a link to nowhere included). */
async function publish(path: string, text: string): Promise<boolean> {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  try { await link(temporary, path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally { await rm(temporary, { force: true }); }
}
const ownerText = async (role: OwnerFile['role'], breaks?: string) => {
  const me = await thisProcess();
  const value: OwnerFile = { format: OWNER_FORMAT, version: 1, role, pid: me.pid, start: me.start, nonce: randomBytes(12).toString('hex'), ...(breaks ? { breaks } : {}) };
  return JSON.stringify(value);
};
/**
 * Removes this process's own `path` (it still holds exactly `text`). Nobody else removes a file this process holds
 * while it runs (a lock is broken only once its owner is gone; a breaker never), so nothing is replaced in between.
 */
async function removeOwn(path: string, role: OwnerFile['role'], text: string): Promise<void> {
  const owner = await readOwner(path, role);
  if (owner.state === 'held' && owner.text === text) await rm(path, { force: true });
}

// ---- Diagnostics, read-only ----

export type OwnerReport =
  | { path: string; state: 'absent' }
  | { path: string; state: 'held'; pid: number; start: string; liveness: Liveness }
  | { path: string; state: 'unreadable'; reason: string };
/** What holds the transition turn, as it is: the lock and the breaker, each with its owner's pid, start and liveness. Changes nothing. */
export interface TransitionDiagnostic { lock: OwnerReport; breaker: OwnerReport }
async function report(path: string, role: OwnerFile['role']): Promise<OwnerReport> {
  const owner = await readOwner(path, role);
  if (owner.state === 'absent') return { path, state: 'absent' };
  if (owner.state === 'unreadable') return { path, state: 'unreadable', reason: owner.reason };
  return { path, state: 'held', pid: owner.owner.pid, start: owner.owner.start, liveness: await liveness(owner.owner) };
}
export async function inspectStorageTransition(stateDir: string): Promise<TransitionDiagnostic> {
  const [lock, breaker] = await Promise.all([report(transitionLockPath(stateDir), 'lock'), report(transitionBreakerPath(stateDir), 'breaker')]);
  return { lock, breaker };
}

/** Why a turn was refused. `transition-lock-stale-breaker` carries the diagnostic: the owner's explicit recovery (W0I) decides. */
export class TransitionLockError extends Error {
  constructor(readonly code: 'transition-busy' | 'transition-lock-unreadable' | 'transition-lock-stale-breaker', message: string, readonly diagnostic?: TransitionDiagnostic) { super(message); }
}

// ---- The turn ----

/** A turn of this process: valid only while its work runs. A promise made in it and run later does not inherit it. */
interface Turn { key: string; open: boolean }
const turns = new AsyncLocalStorage<readonly Turn[]>();

/**
 * Runs `work` in this state directory's transition turn. A nested call from inside `work`, while it runs, runs in the
 * same turn; one made after the turn ended (a promise left behind) takes the lock like any other caller. Rejects with
 * TransitionLockError: `transition-busy` when another process keeps the turn longer than `waitMs`,
 * `transition-lock-unreadable` when the lock or breaker is not a file this build can tell, and
 * `transition-lock-stale-breaker` when a stale lock sits beside a breaker whose owner is gone or cannot be told. Nothing
 * is removed then.
 */
export async function withStorageTransition<T>(stateDir: string, work: () => Promise<T>, options: { waitMs?: number } = {}): Promise<T> {
  const key = resolve(stateDir);
  const held = (turns.getStore() ?? []).filter(turn => turn.open);
  if (held.some(turn => turn.key === key)) return work();
  const path = transitionLockPath(stateDir);
  await mkdir(join(stateDir, 'runtime'), { recursive: true, mode: 0o700 });
  const text = await ownerText('lock');
  const deadline = Date.now() + (options.waitMs ?? WAIT_MS);
  for (;;) {
    if (await publish(path, text)) break;
    const owner = await readOwner(path, 'lock');
    if (owner.state === 'unreadable') throw new TransitionLockError('transition-lock-unreadable', `The storage transition lock cannot be read: ${owner.reason}`, await inspectStorageTransition(stateDir));
    if (owner.state === 'held' && await liveness(owner.owner) === 'gone') {
      const broken = await breakStale(stateDir, owner);
      if (broken === 'broken') continue;
    }
    if (Date.now() >= deadline) throw new TransitionLockError('transition-busy', 'Another Tower process is changing which version the service starts; try again in a moment.');
    await new Promise(done => setTimeout(done, POLL_MS));
  }
  const turn: Turn = { key, open: true };
  try {
    return await turns.run([...held, turn], work);
  } finally {
    turn.open = false;
    await removeOwn(path, 'lock', text);
  }
}

/**
 * Removes a lock whose owner is gone, holding the breaker, and only while it is still that very lock (its whole text):
 * the lock can only change by being removed, and only a breaker holder removes another's. `waiting`: another live
 * process holds the breaker. A breaker whose owner is gone or cannot be told rejects (nothing is removed).
 */
async function breakStale(stateDir: string, stale: Extract<Owner, { state: 'held' }>): Promise<'broken' | 'waiting'> {
  const path = transitionLockPath(stateDir);
  const breaker = transitionBreakerPath(stateDir);
  const text = await ownerText('breaker', stale.owner.nonce);
  if (!await publish(breaker, text)) {
    const owner = await readOwner(breaker, 'breaker');
    if (owner.state === 'absent') return 'waiting';
    if (owner.state === 'unreadable') throw new TransitionLockError('transition-lock-unreadable', `The storage transition breaker cannot be read: ${owner.reason}`, await inspectStorageTransition(stateDir));
    if (await liveness(owner.owner) === 'running') return 'waiting';
    throw new TransitionLockError('transition-lock-stale-breaker', `The storage transition lock is stale and its breaker (process ${owner.owner.pid}) has no running owner; the owner recovers it explicitly.`, await inspectStorageTransition(stateDir));
  }
  try {
    const owner = await readOwner(path, 'lock');
    if (owner.state === 'held' && owner.text === stale.text && await liveness(owner.owner) === 'gone') await rm(path, { force: true });
    return 'broken';
  } finally { await removeOwn(breaker, 'breaker', text); }
}
