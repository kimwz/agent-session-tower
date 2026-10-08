import { execFile, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { link, readdir, readFile, realpath, rm, stat, statfs, utimes, writeFile } from 'node:fs/promises';
import { isSea } from 'node:sea';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { UpdateFailure, UpdateStage, UpdateStatus } from '../../shared/link.js';
import { writePrivateJson } from '../stores/private-json.js';
import { processStart } from '../instance/process-start.js';
import { HoldError, observeHold, removeHold, writeHold, type HoldGeneration } from './storage-hold.js';
import { TransitionLockError } from './storage-transition-lock.js';
import { currentVersion, entryPoint, installVersion, newerVersion, pointUpdate, RELEASE_WAIT_MS, restartService, runtimePaths, versionDirectory } from './service.js';
import {
  alive, pinnedVersion, preparationCheck, probeInstalledArtifact, readCurrentPointer, readHelperLock, readHold, readRollbackRecord, readUpdateRecord, rollbackActive, storageKeptVersions,
  updateActive, updatePaths, type ArtifactRead, type HelperRead, type SavedUpdate,
} from './storage-update.js';

export { updateActive, updatePaths, type SavedUpdate } from './storage-update.js';

const run = promisify(execFile);
/** A new version that does not answer by then is given up on, and the previous one is started again. */
const START_MS = 120_000;
/** A restarted Tower dials its controllers at once; one that reaches none of them by then is given up on too. */
const LINK_MS = 90_000;
/**
 * A hold left by an update that never finished stops holding anything back after this long, once no helper runs.
 * A hold or helper lock that cannot be read keeps holding, however long.
 */
const HOLD_MS = 15 * 60_000;
/** A new version is kept only after answering this long as the same process: longer than launchd waits to restart it. */
const STABLE_MS = 60_000;
/** Space an install needs, besides what the running work may still write. */
const MIN_FREE_BYTES = 2 * 1024 ** 3;

/** A helper that has not taken its lock this long after it was asked for did not start. */
const STARTING_MS = 30_000;
const RELEASE = /^\d+\.\d+\.\d+$/;

/**
 * The last update, when its record can be read and is one this build understands; undefined otherwise. Deciding
 * anything about storage takes readUpdateRecord instead, which tells a missing record from one that cannot be read.
 */
export async function readUpdateStatus(stateDir: string): Promise<SavedUpdate | undefined> {
  const read = await readUpdateRecord(stateDir);
  return read.state === 'active' || read.state === 'terminal' ? read.update : undefined;
}
async function saveUpdateStatus(stateDir: string, status: SavedUpdate): Promise<void> {
  await writePrivateJson(updatePaths(stateDir).status, JSON.stringify(status));
}
/** The part of an update a controller is told. */
export function publicUpdate({ controllers: _, ...status }: SavedUpdate): UpdateStatus { return status; }

/** The error last logged for each hold that could not be read, so a poll every second logs it once. */
const unreadableHolds = new Map<string, string>();

/** What last kept an expired hold in place, per hold, so a poll every second logs it once. */
const keptHolds = new Map<string, string>();
const keep = (hold: string, reason: string) => {
  if (keptHolds.get(hold) !== reason) console.error(`The update hold is kept: ${reason}`);
  keptHolds.set(hold, reason);
  return true;
};

/**
 * While an update is being tried, the new web must not hand the worker over: until the update is kept, going back
 * to the previous version has to find the previous worker. A hold nobody released in time holds nothing: once it is
 * that old and no helper can be running (the helper lock gone or absent; one that runs, names no process or cannot be
 * read keeps holding, whichever release wrote it), the very generation judged old is removed, in the transition turn.
 * A hold refreshed or replaced meanwhile is another generation: it stays, and holds. Without a hold, a helper lock
 * that names no process or cannot be read still holds (HelperLockUnknownError), whatever the update record says: a
 * helper may be at work whose hold could not be written or was removed (by a released web, for example). Rejects when
 * the hold or the helper lock cannot be read, or the turn cannot be taken: whether to hold cannot be told then, and
 * nothing is removed. The web calls this while it holds the state directory's instance lock, so no other web (a
 * JSON-only one, which removes holds without the turn, included) runs on it meanwhile.
 */
export async function handoffHeld(stateDir: string, now = Date.now()): Promise<boolean> {
  const { hold } = updatePaths(stateDir);
  let present = false;
  /** The generation judged expired: the only one removed. */
  let expired: HoldGeneration | undefined;
  let helper: Awaited<ReturnType<typeof readHelperLock>> | undefined;
  try {
    // Read as it is: a link (even one to nowhere) or anything but a file is not a missing hold.
    const found = await readHold(stateDir, now);
    if (found.state === 'unreadable') throw found.error;
    // No hold: nothing to remove, and one a helper writes meanwhile must stay.
    present = found.state === 'present';
    if (found.state === 'present' && found.ageMs >= HOLD_MS) {
      const observed = await observeHold(stateDir, now);
      present = observed.state === 'present';
      if (observed.state === 'present' && observed.ageMs >= HOLD_MS) {
        expired = observed.generation;
        helper = await readHelperLock(stateDir, startedAt);
        if (helper.state === 'unreadable') throw new HelperLockUnknownError(stateDir, helper);
      }
    }
    if (!present) {
      const owner = await readHelperLock(stateDir, startedAt);
      if (owner.state === 'invalid' || owner.state === 'unreadable') throw new HelperLockUnknownError(stateDir, owner);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (unreadableHolds.get(hold) !== message) {
      console.error(error instanceof HelperLockUnknownError ? `${message} The worker is not handed over until it can be told.`
        : `The update hold could not be read (${message}); the worker is not handed over until it can.`);
    }
    unreadableHolds.set(hold, message);
    throw error;
  }
  if (unreadableHolds.delete(hold)) console.log('The update hold can be read again.');
  if (!present) return false;
  if (!expired || !helper || helper.state === 'running') return true;
  if (helper.state === 'invalid') return keep(hold, `${helper.reason} A helper may still own the hold; the owner inspects ${updatePaths(stateDir).lock}.`);
  try { await removeHold(stateDir, { generation: expired }); } catch (error) {
    if (error instanceof HoldError) return keep(hold, error.message);
    throw error;
  }
  keptHolds.delete(hold);
  return false;
}

/**
 * The previous version's entry point while an update is tried, for a worker that has to be started then. Undefined
 * when nothing holds the handoff (or a known hold names no previous version installed here). When whether to hold
 * cannot be told and no previous version can be chosen, it rejects with why: undefined would be taken for nothing held.
 */
export async function heldWorkerEntry(stateDir: string): Promise<string | undefined> {
  // A hold or helper that cannot be told counts as held: the previous version's worker is the safe one to start.
  let unknown: { error: unknown } | undefined;
  if (!await handoffHeld(stateDir).catch(error => { unknown = { error }; return true; })) return undefined;
  const status = await readUpdateStatus(stateDir);
  const entry = status && updateActive(status) ? entryPoint(versionDirectory(stateDir, status.previous)) : undefined;
  const found = entry && await stat(entry).then(() => entry, () => undefined);
  if (found || !unknown) return found;
  throw unknown.error;
}

/** Whether this web is the background service's own install, which is what an update replaces. */
export async function managedByService(stateDir: string, entry: string | undefined, started: boolean): Promise<boolean> {
  if (!started || !entry) return false;
  const [actual, versions] = await Promise.all([realpath(entry).catch(() => ''), realpath(runtimePaths(stateDir).versions).catch(() => '')]);
  return Boolean(actual && versions && actual.startsWith(versions + sep));
}

const startedAt = processStart;

/**
 * A helper lock that names no process it can have (`invalid`, code `helper-lock-invalid`), cannot be read, or whose
 * owner cannot be observed (`unreadable`, code and cause the read's or the observation's own error): a helper may
 * still own it, so it is never taken for no helper. Nothing is written, removed, taken over or started on it; the
 * owner inspects the lock.
 */
export class HelperLockUnknownError extends Error {
  readonly code: string;
  readonly helper: 'invalid' | 'unreadable';
  readonly reason: string;
  constructor(stateDir: string, read: Extract<HelperRead, { state: 'invalid' | 'unreadable' }>) {
    const { lock } = updatePaths(stateDir);
    const code = read.state === 'invalid' ? 'helper-lock-invalid' : String((read.error as NodeJS.ErrnoException)?.code ?? 'EUNKNOWN');
    super(read.state === 'invalid' ? `${read.reason} A helper may still own ${lock}; the owner inspects it.`
      : read.pid !== undefined ? `${read.reason} (${code}) A helper may still own ${lock}; the owner inspects it.`
        : `The update helper lock ${lock} cannot be read (${code}: ${read.reason}); a helper may still own it.`, read.state === 'unreadable' ? { cause: read.error } : undefined);
    this.name = 'HelperLockUnknownError';
    this.code = code;
    this.helper = read.state;
    this.reason = read.reason;
  }
}

/**
 * Whether a helper may be at work, as every decision here takes it: the lock's owner, its pid as the process that
 * started then, still runs. However long the computer slept, a live helper still owns it. No lock, or one whose owner
 * is gone, means no helper; a lock that names no process, cannot be read or whose owner cannot be observed rejects
 * (HelperLockUnknownError).
 */
export async function helperRunning(stateDir: string): Promise<boolean> {
  const owner = await readHelperLock(stateDir, startedAt);
  if (owner.state === 'invalid' || owner.state === 'unreadable') throw new HelperLockUnknownError(stateDir, owner);
  return owner.state === 'running';
}
/**
 * Takes the helper lock. It is published whole, with its owner's pid and start time in it, so another helper never
 * sees it empty; a lock whose owner is gone is taken over, one that names no process or cannot be read never is (it
 * rejects, and only this helper's own temporary goes). Two helpers taking over the same stale lock at once can both
 * publish; the one whose lock is no longer there a moment later stands down.
 */
async function takeLock(stateDir: string): Promise<boolean> {
  const { lock } = updatePaths(stateDir);
  const temporary = `${lock}.${process.pid}`;
  const mine = `${process.pid} ${await startedAt(process.pid) ?? ''}`.trim();
  // Created new, never through whatever a link left at that name points to.
  await rm(temporary, { force: true });
  await writeFile(temporary, mine, { mode: 0o600, flag: 'wx' });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await link(temporary, lock);
        await new Promise(resolve => setTimeout(resolve, 200));
        return (await readFile(lock, 'utf8').catch(() => '')) === mine;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await helperRunning(stateDir)) return false;
        await rm(lock, { force: true });
      }
    }
    return false;
  } finally { await rm(temporary, { force: true }); }
}

export interface UpdateRequestResult { status: number; body: { update?: UpdateStatus; current?: true; error?: string; code?: string; prepare?: string } }

/**
 * This computer's side of updates: a controller asks for a newer version, and a separate helper process installs
 * it, restarts the service into it and keeps it only if it comes up and reconnects. The helper outlives this web.
 */
export class Updates {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: {
    stateDir: string; version: string; port: number;
    /** Runs as the background service's own install; otherwise nothing is replaced from here. */
    managed: boolean;
    spawnHelper?: (version: string, resume: boolean) => void;
    now?: () => number;
  }) {}

  get managed(): boolean { return this.options.managed; }

  request(version: unknown): Promise<UpdateRequestResult> {
    return this.exclusive(() => this.start(version));
  }

  /** Runs `work` in turn with requests and pruning: the owner's rollback pins its target this way. */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }

  /** Where the last update stands; one whose helper is gone is reported as interrupted, one whose helper cannot be told is not. */
  async status(): Promise<UpdateStatus | undefined> {
    const status = await readUpdateStatus(this.options.stateDir);
    if (!status) return undefined;
    if (!updateActive(status) || await this.busy(status)) return publicUpdate(status);
    return { ...publicUpdate(status), stage: 'failed', code: 'interrupted', failedStage: status.stage };
  }

  private async busy(status: UpdateStatus): Promise<boolean> {
    return await helperRunning(this.options.stateDir).catch(() => true) || (this.options.now?.() ?? Date.now()) - Date.parse(status.updatedAt) < STARTING_MS;
  }

  private async start(version: unknown): Promise<UpdateRequestResult> {
    if (typeof version !== 'string' || !RELEASE.test(version)) return { status: 400, body: { code: 'invalid-version', error: 'Not a released version.' } };
    const { stateDir } = this.options;
    const read = await readUpdateRecord(stateDir);
    const current = read.state === 'active' || read.state === 'terminal' ? read.update : undefined;
    if (!newerVersion(version, this.options.version)) return { status: 200, body: { current: true, ...(current ? { update: publicUpdate(current) } : {}) } };
    if (!this.options.managed) return { status: 409, body: { code: 'not-service', error: 'This computer does not run Tower as its background service.' } };
    // The owner's pin keeps this version, whoever asks (the owner, the scheduler, a controller).
    const pin = await pinnedVersion(stateDir);
    if (pin.state === 'unknown') return { status: 409, body: { code: 'pin-unreadable', error: `The version pin cannot be read: ${pin.reason}` } };
    if (pin.state === 'pinned' && pin.version !== version) return { status: 409, body: { code: 'pinned', error: `The owner pinned this computer to ${pin.version}; release the pin to update it.` } };
    // An owner's rollback under way (or one whose record cannot be read) is settled first. Its reservation is taken in
    // turn with requests (Updates.exclusive), so it sees an update asked for meanwhile and the other way around.
    const rollback = await readRollbackRecord(stateDir);
    if (rollback.state === 'unreadable' || rollback.state === 'invalid') return { status: 409, body: { code: 'rollback-unreadable', error: `The owner's rollback record cannot be read: ${rollback.reason}` } };
    if (rollback.state === 'present' && rollbackActive(rollback.record)) return { status: 409, body: { code: 'rollback-under-way', error: `The owner's rollback to ${rollback.record.target} is under way.` } };
    // A record that cannot be read may be an update under way; one this build does not understand is replaced only
    // when no helper or hold is left that could belong to it.
    if (read.state === 'unreadable') return { status: 409, body: { code: 'update-status-unreadable', error: `The last update cannot be read: ${read.reason}` } };
    if (read.state === 'invalid') {
      const helper = await helperRunning(stateDir).catch((error: unknown) => error);
      if (helper instanceof HelperLockUnknownError) return { status: 409, body: { code: 'busy', error: `The last update is not one this version understands, and whether its helper still runs cannot be told: ${helper.message}` } };
      if (helper !== false || (await readHold(stateDir)).state !== 'absent') {
        return { status: 409, body: { code: 'busy', error: 'The last update is not one this version understands, and its helper or hold is still there.' } };
      }
    }
    // The target needs its preparation release first (or cannot take over at all), and nothing here changed since it
    // said so: asked again, it is not installed again. Installing that release (or a newer one) first is what moves on.
    const refusal = current?.storage?.code;
    if (current?.stage === 'failed' && current.version === version && current.previous === this.options.version && (refusal === 'prerequisite-required' || refusal === 'previous-incompatible')) {
      return { status: 409, body: { code: refusal, ...(current.storage!.prepare ? { prepare: current.storage!.prepare } : {}), update: publicUpdate(current),
        error: refusal === 'prerequisite-required' ? `${version} needs ${current.storage!.prepare ?? 'its preparation release'} to run here first.` : `${this.options.version} cannot take ${version}'s storage over; the owner decides how to move on.` } };
    }
    if (updateActive(current) && await this.busy(current!)) {
      // The newest version asked for wins; it is asked for again once this update has finished.
      return current!.version === version ? { status: 202, body: { update: publicUpdate(current!) } } : { status: 409, body: { code: 'busy', update: publicUpdate(current!) } };
    }
    // Nothing is recorded or started beside a helper lock that cannot be told, whatever the last update says: the record,
    // its notes and the hold stay as they are for the owner.
    const helper = await helperRunning(stateDir).catch((error: unknown) => error);
    if (helper instanceof HelperLockUnknownError) return { status: 409, body: { code: 'helper-lock-unknown', error: helper.message } };
    if (helper !== false && helper !== true) throw helper;
    const at = new Date(this.options.now?.() ?? Date.now()).toISOString();
    const update: UpdateStatus = { version, previous: this.options.version, stage: 'installing', startedAt: at, updatedAt: at };
    await saveUpdateStatus(this.options.stateDir, update);
    this.spawn(version, false);
    return { status: 202, body: { update } };
  }

  private spawn(version: string, resume: boolean): void {
    (this.options.spawnHelper ?? ((target, again) => spawnUpdateHelper(this.options.stateDir, target, this.options.port, again)))(version, resume);
  }

  /**
   * Settles an update whose helper is gone (the computer restarted, for example) when Tower starts. The new version
   * running is not proof it works: a helper checks it again, then keeps it or goes back. The previous version
   * running means the update never came to run, and it may be asked for again.
   */
  async recover(): Promise<void> {
    const { stateDir, version } = this.options;
    const read = await readUpdateRecord(stateDir);
    if (!this.options.managed || (read.state !== 'active' && read.state !== 'terminal')) return;
    const status = read.update;
    const resumes = updateActive(status) && status.version === version;
    // Whether a helper still runs cannot be told: it rejects, and nothing is written, removed, settled or started. The
    // worker stays held by that judgment itself (handoffHeld rejects on it too), not by a hold written for it.
    if (await helperRunning(stateDir)) return;
    if (resumes) {
      // Held anew before the helper starts: however long the computer was off, this web must not take the worker. A
      // hold that is not this update's own plain file is left as it is, and no helper starts (writeHold rejects).
      await writeHold(stateDir, version);
      this.spawn(version, true);
      return;
    }
    // The previous version runs again: the hold its update left is not needed by it. Anything else there is left, and
    // so is the hold once another update is recorded than the one judged here (it may be that update's own).
    if (status.previous === version) {
      await removeHold(stateDir, { version: status.version, update: read.sha256 }).catch(error => {
        if (!(error instanceof HoldError) && !(error instanceof TransitionLockError)) throw error;
        console.error(`The update hold is kept: ${error.message}`);
      });
    }
    if (!updateActive(status)) return;
    const at = new Date(this.options.now?.() ?? Date.now()).toISOString();
    // Going back had brought the previous version up: the update failed for the reason already found.
    const back = status.stage === 'rolling-back' && status.previous === version && status.code;
    await saveUpdateStatus(stateDir, { ...status, stage: 'failed', code: back || 'interrupted', failedStage: status.failedStage ?? status.stage, updatedAt: at });
  }

  /**
   * Versions nothing runs anymore are removed; the previous one stays for going back by hand. Taken in turn with
   * requests, and never while an update is under way, so it cannot remove what an update just installed.
   */
  prune(inUse: () => Promise<Array<string | null | undefined>>): Promise<void> {
    return this.exclusive(async () => {
      if (!this.options.managed) return;
      const { stateDir } = this.options;
      // What the last update, the current link or the owner's pin and rollback keep must be known before anything goes.
      const read = await readUpdateRecord(stateDir);
      if (read.state === 'unreadable' || read.state === 'invalid') return;
      const status = read.state === 'absent' ? undefined : read.update;
      if (updateActive(status) || await helperRunning(stateDir)) return;
      const [current, storage] = await Promise.all([readCurrentPointer(stateDir), storageKeptVersions(stateDir)]);
      if (current.state === 'unreadable' || current.state === 'invalid' || 'unknown' in storage) return;
      const keep = new Set([this.options.version, current.state === 'version' ? current.version : undefined, status?.previous, ...storage.keep, ...await inUse()].filter(Boolean));
      const installed = await readdir(runtimePaths(stateDir).versions).catch(() => [] as string[]);
      // An install cut short leaves its staging folder behind; no helper runs now to finish it.
      // An install still under way (by a join or service command run by hand) keeps its staging folder.
      const staging = (name: string) => { const pid = Number(/^\d+\.\d+\.\d+\.installing-(\d+)$/.exec(name)?.[1]); return pid > 0 && !alive(pid); };
      for (const name of installed) if ((RELEASE.test(name) && !keep.has(name)) || staging(name)) await rm(versionDirectory(stateDir, name), { recursive: true, force: true });
    });
  }
}

/** Free space where versions are installed, for diagnostics. */
export async function diskFree(stateDir: string): Promise<number | undefined> {
  const info = await statfs(runtimePaths(stateDir).root).catch(() => undefined);
  return info ? info.bavail * info.bsize : undefined;
}

/** Starts the helper as its own process group, so restarting the service does not stop it. It keeps its own log. */
export function spawnUpdateHelper(stateDir: string, version: string, port: number, resume = false): void {
  const entry = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../index.ts' : '../index.js', import.meta.url));
  const own = ['--update-helper', stateDir, version, String(port), ...resume ? ['--resume'] : []];
  const args = isSea() ? own : [...process.execArgv.filter(arg => !/^--inspect(?:-brk|-port|-publish-uid)?(?:=|$)/.test(arg)), entry, ...own];
  const { log } = updatePaths(stateDir);
  mkdirSync(runtimePaths(stateDir).logs, { recursive: true, mode: 0o700 });
  const output = openSync(log, 'a', 0o600);
  try {
    const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', output, output], env: process.env });
    child.on('error', error => console.error(`The update could not start: ${error.message}`));
    child.unref();
  } finally { closeSync(output); }
}

export interface UpdateHelperSteps {
  /** Free space where versions are installed. */
  free(): Promise<number | undefined>;
  install(version: string): Promise<string>;
  /** Runs the installed version enough to know it starts. */
  check(directory: string, version: string): Promise<void>;
  /**
   * The storage contract an installed version states (`--storage-contract`). With it the helper refuses a target
   * whose storage the version it would go back to cannot take over, before anything switches.
   */
  contract?(directory: string, version: string): Promise<ArtifactRead>;
  point(version: string): Promise<void>;
  restart(): Promise<void>;
  health(): Promise<{ version: string; pid: number } | undefined>;
  /** Controllers the running Tower is linked with now; undefined when it cannot say. */
  controllers(): Promise<string[] | undefined>;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(line: string): void;
}

export function serviceSteps(stateDir: string, port: number): UpdateHelperSteps {
  const base = `http://127.0.0.1:${port}`;
  const read = async <T>(path: string): Promise<T | undefined> => {
    try { const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(3000) }); return response.ok ? await response.json() as T : undefined; } catch { return undefined; }
  };
  return {
    free: () => diskFree(stateDir),
    install: version => installVersion(stateDir, version, line => console.log(line), undefined, { waitMs: RELEASE_WAIT_MS }),
    check: async (directory, version) => {
      const { stdout } = await run(process.execPath, [entryPoint(directory), '--version'], { timeout: 60_000 });
      if (stdout.trim() !== version) throw new Error(`The installed version reports ${stdout.trim().slice(0, 40) || 'nothing'}.`);
    },
    contract: probeInstalledArtifact,
    point: version => pointUpdate(stateDir, version),
    restart: () => restartService(stateDir),
    health: () => read<{ version: string; pid: number }>('/api/health'),
    // The new version answers these the way the helper's own version reads them; anything else counts as no answer.
    controllers: async () => {
      const overview = await read<{ controllers?: unknown }>('/api/link');
      return Array.isArray(overview?.controllers) ? overview.controllers.filter(item => item?.status === 'connected' && typeof item.id === 'string').map(item => item.id as string) : undefined;
    },
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => Date.now(),
    log: line => console.log(`${new Date().toISOString()} ${line}`),
  };
}

/**
 * Moves the background service to `version`: install, check, switch and restart, then keep it only once it answers
 * and reaches a controller again. Any failure before that puts the previous version back and restarts it. The
 * worker and terminal host are never touched; the new web takes the worker over only after the update is kept.
 */
export async function runUpdateHelper(stateDir: string, version: string, steps: UpdateHelperSteps, resume = false): Promise<UpdateStatus | undefined> {
  const paths = updatePaths(stateDir);
  // A lock that cannot be told rejects here, before the try whose end removes the lock: it is left as it is.
  if (!await takeLock(stateDir)) return undefined;
  let status = await readUpdateStatus(stateDir);
  try {
    if (!status || status.version !== version || !updateActive(status)) return status && publicUpdate(status);
    const previous = status.previous;
    const set = async (stage: UpdateStage, extra: Partial<SavedUpdate> = {}) => {
      status = { ...status!, ...extra, stage, updatedAt: new Date(steps.now()).toISOString() };
      await saveUpdateStatus(stateDir, status);
      const touched = new Date();
      await utimes(paths.lock, touched, touched).catch(() => {});
      steps.log(`${version}: ${stage}${extra.code ? ` (${extra.code})` : ''}`);
    };
    const wait = async <T>(read: () => Promise<T | undefined | false>, timeout: number): Promise<T | undefined> => {
      const deadline = steps.now() + timeout;
      for (;;) {
        const value = await read();
        if (value !== undefined && value !== false) return value;
        if (steps.now() >= deadline) return undefined;
        await steps.sleep(1000);
      }
    };
    // launchd starts the service again by itself when it stops unexpectedly, so a restart command that fails
    // (as it can while the service is failing to start) is not the end: whether it comes up decides.
    const restart = () => steps.restart().catch(error => steps.log(`restart: ${(error as Error).message.split('\n')[0]}`));
    /**
     * Removes this update's own hold, in the transition turn; anything else there is left as it is (and keeps holding).
     * A release that did not happen is not taken for one: the update record says why (`hold`), for the owner.
     */
    let kept: SavedUpdate['hold'];
    const release = async () => {
      try { await removeHold(stateDir, { version }); kept = undefined; } catch (error) {
        if (!(error instanceof HoldError) && !(error instanceof TransitionLockError)) throw error;
        steps.log(`hold: ${error.message}`);
        kept = { code: error.code, reason: error.message.slice(0, 2000), at: new Date(steps.now()).toISOString() };
      }
    };
    // The hold stays until the previous version answers again: until then the new web may still be running, and it
    // must not hand the worker over. A previous version that never comes back releases it itself when it starts.
    const back = async (code: UpdateFailure, failedStage: UpdateStage) => {
      await set('rolling-back', { code, failedStage });
      try {
        await steps.point(previous);
        await restart();
        const up = await wait(async () => (await steps.health())?.version === previous, START_MS);
        if (up) await release();
        await set('failed', up ? { code, failedStage, hold: kept } : { code: 'rollback-failed', failedStage });
      } catch (error) {
        steps.log(`rolling back failed: ${(error as Error).message}`);
        await set('failed', { code: 'rollback-failed', failedStage });
      }
      return status;
    };
    // The new version must answer (as a new process, when this helper restarted it) and reach a controller it was
    // linked with, or no one could reach it to fix it.
    const verify = async (before: number | undefined, linked: string[]) => {
      await set('verifying');
      const started = await wait(async () => { const health = await steps.health(); return health?.version === version && health.pid !== before ? health : undefined; }, START_MS);
      if (!started) return await back('start-failed', 'verifying');
      // It must keep running as that same process: one that dies and is started again by launchd is not kept. A
      // busy computer may miss an answer or two; a different process, or a version, is decisive.
      const same = async () => { const health = await steps.health(); return health ? health.version === version && health.pid === started.pid : undefined; };
      const until = steps.now() + STABLE_MS;
      let missed = 0;
      while (steps.now() < until) {
        await steps.sleep(1000);
        const answer = await same();
        if (answer === false || (answer === undefined && ++missed >= 3)) return await back('start-failed', 'verifying');
        if (answer) missed = 0;
      }
      if (linked.length && !await wait(async () => (await steps.controllers())?.some(id => linked.includes(id)), LINK_MS)) return await back('link-failed', 'verifying');
      let final = await same();
      for (let tries = 0; final === undefined && tries < 3; tries++) { await steps.sleep(1000); final = await same(); }
      if (final !== true) return await back('start-failed', 'verifying');
      // Kept before the hold goes: stopped in between, the hold only runs out, and nothing is checked again unheld.
      await set('done');
      await release();
      if (kept) await set('done', { hold: kept });
      return status;
    };
    // Started again by the new version after the helper was stopped: carry on from where it was.
    if (resume) {
      if (status.stage === 'rolling-back') return await back(status.code ?? 'interrupted', status.failedStage ?? 'verifying');
      if (status.stage === 'switching' || status.stage === 'verifying') return await verify(undefined, status.controllers ?? []);
      await set('failed', { code: 'interrupted', failedStage: status.stage });
      await release();
      if (kept) await set('failed', { hold: kept });
      return status;
    }
    await set('installing');
    // Running work keeps writing its history; an install never takes the space it needs.
    const free = await steps.free().catch(() => undefined);
    if (free !== undefined && free < MIN_FREE_BYTES) { steps.log(`${free} bytes free`); await set('failed', { code: 'low-disk', failedStage: 'installing' }); return status; }
    let directory: string;
    try { directory = await steps.install(version); }
    catch (error) { steps.log((error as Error).message); await set('failed', { code: 'install-failed', failedStage: 'installing' }); return status; }
    await set('checking');
    try { await steps.check(directory, version); }
    catch (error) { steps.log((error as Error).message); await set('failed', { code: 'check-failed', failedStage: 'checking' }); return status; }
    if (steps.contract) {
      // A target that imports a domain needs the version it would go back to to read and write that domain first: it
      // is refused here, before the hold, the switch and the restart, and says which release to install first.
      const target = await steps.contract(directory, version).catch(error => ({ state: 'unverifiable' as const, reason: (error as Error).message }));
      const refusal = async (storage: NonNullable<SavedUpdate['storage']>, line: string) => {
        steps.log(line);
        await set('failed', { code: 'check-failed', failedStage: 'checking', storage });
        return status;
      };
      if (target.state === 'missing' || target.state === 'unverifiable') return await refusal({ code: 'contract-unverifiable' }, `storage contract: ${target.state === 'missing' ? 'the installed version has no entry point' : target.reason}`);
      if (target.state === 'contract') {
        if (!target.contract.supported) return await refusal({ code: 'target-runtime-unsupported' }, `storage runtime: ${target.contract.refusal?.message ?? 'unsupported'}`);
        const back = await steps.contract(versionDirectory(stateDir, previous), previous).catch(error => ({ state: 'unverifiable' as const, reason: (error as Error).message }));
        const check = preparationCheck(target.contract.manifest, back);
        if (check.state === 'prerequisite-required' || check.state === 'missing') {
          return await refusal({ code: 'prerequisite-required', ...(check.prepare ? { prepare: check.prepare } : {}), domains: check.domains }, `storage: ${check.reason}`);
        }
        if (check.state === 'incompatible') return await refusal({ code: 'previous-incompatible', domains: check.domains }, `storage: ${check.reason}`);
        if (check.state !== 'not-required' && check.state !== 'satisfied') return await refusal({ code: 'contract-unverifiable', domains: check.domains }, `storage: ${check.reason}`);
      }
    }
    const before = await steps.health();
    const linked = await steps.controllers() ?? [];
    await set('switching', { controllers: linked });
    try { await writeHold(stateDir, version); } catch (error) {
      // A hold that is not this update's own plain file (a link, a folder, another version's) is left as it is, and
      // nothing switches: the previous version keeps running untouched.
      steps.log((error as Error).message);
      if (!(error instanceof HoldError)) await release();
      await set('failed', { code: 'switch-failed', failedStage: 'switching', hold: kept });
      return status;
    }
    try { await steps.point(version); } catch (error) {
      steps.log((error as Error).message);
      // Nothing changed if the service still starts the previous version: it keeps running untouched.
      if (await currentVersion(stateDir) === previous) { await release(); await set('failed', { code: 'switch-failed', failedStage: 'switching', hold: kept }); return status; }
      return await back('switch-failed', 'switching');
    }
    await restart();
    return await verify(before?.pid, linked);
  } finally {
    await rm(paths.lock, { force: true });
  }
}
