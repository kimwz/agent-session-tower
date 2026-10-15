import { createHash } from 'node:crypto';
import { type Stats } from 'node:fs';
import { lstat, readlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { UpdateFailure, UpdateStage, UpdateStatus } from '../../shared/link.js';
import { observeProcess } from './process-owner.js';
import { processStart } from '../instance/process-start.js';
import { runtimePaths } from './service.js';
import { readExact as readExactly } from './storage-transition-lock.js';

export { inspectStorageTransition, TransitionLockError, withStorageTransition, type TransitionDiagnostic } from './storage-transition-lock.js';

/**
 * What an update leaves behind under the service's runtime folder, read strictly: the update record, the handoff
 * hold, the helper lock and the `current` pointer. A file that is there but cannot be read is never taken for one that
 * is missing, and nothing is removed because it is old: whatever cannot be told holds the handoff back.
 */

const RELEASE = /^\d+\.\d+\.\d+$/;
const SCOPE = /^[a-z][a-z0-9-]{0,47}$/;
const MAX_RECORD_BYTES = 1024 * 1024;

export function updatePaths(stateDir: string) {
  const { root, logs } = runtimePaths(stateDir);
  return { status: join(root, 'update.json'), lock: join(root, 'update.lock'), hold: join(root, 'handoff-hold'), log: join(logs, 'update.log') };
}
/**
 * Why a 1.137-or-older helper's storage check stopped an update, as its record keeps it. Nothing writes it any more;
 * a record that carries one is still read.
 */
export type StorageUpdateFailure = 'prerequisite-required' | 'previous-incompatible' | 'contract-unverifiable' | 'target-runtime-unsupported';
/** What this computer keeps about its update; `controllers` (linked when it switched) stays here. */
export interface SavedUpdate extends UpdateStatus {
  controllers?: string[];
  /** Written by 1.137-or-older helpers when the target's storage contract stopped the update; read only. */
  storage?: { code: StorageUpdateFailure; prepare?: string; domains?: string[] };
  /** Set when the helper's release of its handoff hold did not happen (HoldError or TransitionLockError code): the hold stays. */
  hold?: { code: string; reason: string; at: string };
}

const ACTIVE: ReadonlySet<UpdateStage> = new Set(['installing', 'checking', 'switching', 'verifying', 'rolling-back']);
const STAGES: ReadonlySet<string> = new Set([...ACTIVE, 'done', 'failed']);
const FAILURES: ReadonlySet<UpdateFailure> = new Set(['low-disk', 'install-failed', 'check-failed', 'switch-failed', 'start-failed', 'link-failed', 'rollback-failed', 'interrupted']);
const STORAGE_FAILURES: ReadonlySet<string> = new Set(['prerequisite-required', 'previous-incompatible', 'contract-unverifiable', 'target-runtime-unsupported']);
export const updateActive = (status: UpdateStatus | undefined): boolean => Boolean(status && ACTIVE.has(status.stage));

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const isTime = (value: unknown) => typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
const isText = (value: unknown, maximum: number) => typeof value === 'string' && !!value.trim() && value.length <= maximum;
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** An owner's file as it is: never followed through a link, never chmodded, at most `maxBytes`. Undefined when absent. */
const readExact = (path: string, maxBytes = MAX_RECORD_BYTES) => readExactly(path, maxBytes);

// ---- Strict reads of what an update leaves behind. ----

/**
 * update.json as it is. `unreadable`: it is there and could not be read (permissions, I/O, not a file); `invalid`: it
 * was read and is not a record this build understands (an unknown stage or failure included). Neither is missing.
 * Unknown extra fields are kept: older and newer helpers rewrite the record with fields they carry over.
 */
export type UpdateRecordRead =
  | { state: 'absent' }
  | { state: 'unreadable'; reason: string }
  | { state: 'invalid'; reason: string }
  | { state: 'active' | 'terminal'; update: SavedUpdate; sha256: string };

function updateProblem(value: unknown): string | undefined {
  if (!isObject(value)) return 'it is not an object';
  if (typeof value.version !== 'string' || !RELEASE.test(value.version)) return 'its version is not a release';
  if (typeof value.previous !== 'string' || !RELEASE.test(value.previous)) return 'its previous version is not a release';
  if (typeof value.stage !== 'string' || !STAGES.has(value.stage)) return 'its stage is unknown';
  if (!isTime(value.startedAt) || !isTime(value.updatedAt)) return 'its times are invalid';
  if (value.code !== undefined && !FAILURES.has(value.code as UpdateFailure)) return 'its failure is unknown';
  if (value.failedStage !== undefined && !STAGES.has(value.failedStage as string)) return 'its failed stage is unknown';
  if (value.controllers !== undefined && !(Array.isArray(value.controllers) && value.controllers.every(id => typeof id === 'string'))) return 'its controllers are invalid';
  const storage = value.storage;
  if (storage !== undefined && !(isObject(storage) && STORAGE_FAILURES.has(storage.code as string)
    && (storage.prepare === undefined || (typeof storage.prepare === 'string' && RELEASE.test(storage.prepare)))
    && (storage.domains === undefined || (Array.isArray(storage.domains) && storage.domains.every(domain => typeof domain === 'string' && SCOPE.test(domain)))))) return 'its storage failure is invalid';
  const hold = value.hold;
  if (hold !== undefined && !(isObject(hold) && isText(hold.code, 100) && typeof hold.reason === 'string' && hold.reason.length <= 2000 && isTime(hold.at))) return 'its hold note is invalid';
  return undefined;
}

export async function readUpdateRecord(stateDir: string): Promise<UpdateRecordRead> {
  let bytes: Buffer | undefined;
  try { bytes = await readExact(updatePaths(stateDir).status); } catch (error) { return { state: 'unreadable', reason: messageOf(error) }; }
  if (!bytes) return { state: 'absent' };
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { return { state: 'invalid', reason: 'update.json is not JSON.' }; }
  const problem = updateProblem(value);
  if (problem) return { state: 'invalid', reason: `update.json cannot be used: ${problem}.` };
  const update = value as SavedUpdate;
  return { state: ACTIVE.has(update.stage) ? 'active' : 'terminal', update, sha256: sha256(bytes) };
}
/**
 * The handoff hold, without removing it however old it is. Only a plain file there is a hold: a link (even one to
 * nowhere, which looking through it would take for a missing hold) or anything else is `unreadable`, never absent or
 * present. A hold written just after the look found none is answered absent, as it was then; the next look sees it.
 * Its only writer and remover is storage-hold.ts.
 */
export type HoldRead = { state: 'absent' } | { state: 'present'; ageMs: number } | { state: 'unreadable'; reason: string; error: unknown };
export async function readHold(stateDir: string, now = Date.now()): Promise<HoldRead> {
  const path = updatePaths(stateDir).hold;
  const unreadable = (error: unknown): HoldRead => ({ state: 'unreadable', reason: messageOf(error), error });
  const notAHold = (info: Stats) => unreadable(Object.assign(new Error(`${path} is ${info.isSymbolicLink() ? 'a link' : 'not a regular file'}; it is left as it is.`), { code: info.isSymbolicLink() ? 'ELOOP' : 'ENOTFILE' }));
  try { await stat(path); } catch (error) {
    if (!missing(error)) return unreadable(error);
    // Missing through the path: only the path itself tells a missing hold from a link to nowhere.
    const own = await lstat(path).catch((failure: unknown) => failure as NodeJS.ErrnoException);
    if (own instanceof Error) return missing(own) ? { state: 'absent' } : unreadable(own);
    return own.isSymbolicLink() || !own.isFile() ? notAHold(own) : { state: 'absent' };
  }
  let info: Stats;
  try { info = await lstat(path); } catch (error) { return missing(error) ? { state: 'absent' } : unreadable(error); }
  if (!info.isFile()) return notAHold(info);
  return { state: 'present', ageMs: Math.max(0, now - info.mtimeMs) };
}

/**
 * The helper lock's owner: `running` while its pid runs as the process that took it (a pid whose start cannot be told
 * counts as running), `gone` once it does not: only the system saying no such process (ESRCH), or another start time,
 * is gone. `invalid`: a lock without an owner in it, or with a pid no process can have here; `unreadable`: one that is
 * there and cannot be read (a link, even to nowhere, included: it is never followed), or whose owner (`pid`) could not
 * be observed (the error is the observation's own), which may still belong to a helper.
 */
export type HelperRead =
  | { state: 'absent' } | { state: 'running'; pid: number } | { state: 'gone'; pid: number }
  | { state: 'invalid'; reason: string } | { state: 'unreadable'; reason: string; error: unknown; pid?: number };
export async function readHelperLock(stateDir: string, started: (pid: number) => Promise<string | undefined> = processStart, observe: typeof observeProcess = observeProcess): Promise<HelperRead> {
  let text: string;
  try {
    const bytes = await readExact(updatePaths(stateDir).lock, 4096);
    if (!bytes) return { state: 'absent' };
    text = bytes.toString('utf8');
  } catch (error) {
    return { state: 'unreadable', reason: messageOf(error), error };
  }
  const [pidText, ...rest] = text.split(' ');
  const pid = Number(pidText);
  if (!(pid > 0) || !Number.isInteger(pid)) return { state: 'invalid', reason: 'The update helper lock names no process.' };
  const unobserved = (error: unknown): HelperRead => ({ state: 'unreadable', reason: `Whether pid ${pid} still runs cannot be observed: ${messageOf(error)}`, error, pid });
  const observed = observe(pid);
  if (observed.state === 'out-of-range') return { state: 'invalid', reason: `The update helper lock names pid ${pidText.slice(0, 40)}, which no process here can have.` };
  if (observed.state === 'gone') return { state: 'gone', pid };
  if (observed.state === 'unobserved') return unobserved(observed.error);
  if (!rest.length) return { state: 'running', pid };
  let now: string | undefined;
  try { now = await started(pid); } catch (error) { return unobserved(error); }
  return now === undefined || now === rest.join(' ') ? { state: 'running', pid } : { state: 'gone', pid };
}

/** Where `current` points: only `versions/<release>`, as pointCurrent writes it, names a version. */
export type PointerRead = { state: 'absent' } | { state: 'version'; version: string } | { state: 'invalid'; reason: string } | { state: 'unreadable'; reason: string };
export async function readCurrentPointer(stateDir: string): Promise<PointerRead> {
  const { current } = runtimePaths(stateDir);
  let info: Stats;
  try { info = await lstat(current); } catch (error) { return missing(error) ? { state: 'absent' } : { state: 'unreadable', reason: messageOf(error) }; }
  if (!info.isSymbolicLink()) return { state: 'invalid', reason: `${current} is not a link to an installed version.` };
  let target: string;
  try { target = await readlink(current); } catch (error) { return { state: 'unreadable', reason: messageOf(error) }; }
  const version = /^versions\/(\d+\.\d+\.\d+)$/.exec(target)?.[1];
  return version ? { state: 'version', version } : { state: 'invalid', reason: `${current} points at ${target.slice(0, 200)}, not an installed version.` };
}
