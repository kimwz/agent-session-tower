import { execFile, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { link, readdir, readFile, realpath, rm, stat, statfs, utimes, writeFile } from 'node:fs/promises';
import { isSea } from 'node:sea';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { UpdateFailure, UpdateStage, UpdateStatus } from '../../shared/link.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { currentVersion, entryPoint, installVersion, newerVersion, pointCurrent, runtimePaths, serviceLabel, versionDirectory } from './service.js';

const run = promisify(execFile);
/** A new version that does not answer by then is given up on, and the previous one is started again. */
const START_MS = 120_000;
/** A restarted Tower dials its controllers at once; one that reaches none of them by then is given up on too. */
const LINK_MS = 90_000;
/** A hold left by an update that never finished stops holding anything back after this long, once no helper runs. */
const HOLD_MS = 15 * 60_000;
/** A new version is kept only after answering this long as the same process: longer than launchd waits to restart it. */
const STABLE_MS = 60_000;
/** Space an install needs, besides what the running work may still write. */
const MIN_FREE_BYTES = 2 * 1024 ** 3;

const ACTIVE: ReadonlySet<UpdateStage> = new Set(['installing', 'checking', 'switching', 'verifying', 'rolling-back']);
/** A helper that has not taken its lock this long after it was asked for did not start. */
const STARTING_MS = 30_000;
const RELEASE = /^\d+\.\d+\.\d+$/;

export function updatePaths(stateDir: string) {
  const { root, logs } = runtimePaths(stateDir);
  return { status: join(root, 'update.json'), lock: join(root, 'update.lock'), hold: join(root, 'handoff-hold'), log: join(logs, 'update.log') };
}

/** What this computer keeps about its update; `controllers` (linked when it switched) stays here. */
export interface SavedUpdate extends UpdateStatus { controllers?: string[] }

export async function readUpdateStatus(stateDir: string): Promise<SavedUpdate | undefined> {
  const value = await readPrivateJson(updatePaths(stateDir).status).catch(() => undefined) as Partial<SavedUpdate> | undefined;
  if (!value || typeof value.version !== 'string' || !RELEASE.test(value.version) || typeof value.previous !== 'string' || typeof value.stage !== 'string') return undefined;
  return value as SavedUpdate;
}
async function saveUpdateStatus(stateDir: string, status: SavedUpdate): Promise<void> {
  await writePrivateJson(updatePaths(stateDir).status, JSON.stringify(status));
}
/** The part of an update a controller is told. */
export function publicUpdate({ controllers: _, ...status }: SavedUpdate): UpdateStatus { return status; }
export const updateActive = (status: UpdateStatus | undefined): boolean => Boolean(status && ACTIVE.has(status.stage));

/**
 * While an update is being tried, the new web must not hand the worker over: until the update is kept, going back
 * to the previous version has to find the previous worker. A hold nobody released in time holds nothing.
 */
export async function handoffHeld(stateDir: string, now = Date.now()): Promise<boolean> {
  const { hold } = updatePaths(stateDir);
  const info = await stat(hold).catch(() => undefined);
  if (!info) return false;
  if (now - info.mtimeMs < HOLD_MS || await helperRunning(stateDir)) return true;
  await rm(hold, { force: true });
  return false;
}

/** The previous version's entry point while an update is tried, for a worker that has to be started then. */
export async function heldWorkerEntry(stateDir: string): Promise<string | undefined> {
  if (!await handoffHeld(stateDir)) return undefined;
  const status = await readUpdateStatus(stateDir);
  if (!status || !updateActive(status)) return undefined;
  const entry = entryPoint(versionDirectory(stateDir, status.previous));
  return await stat(entry).then(() => entry, () => undefined);
}

/** Whether this web is the background service's own install, which is what an update replaces. */
export async function managedByService(stateDir: string, entry: string | undefined, started: boolean): Promise<boolean> {
  if (!started || !entry) return false;
  const [actual, versions] = await Promise.all([realpath(entry).catch(() => ''), realpath(runtimePaths(stateDir).versions).catch(() => '')]);
  return Boolean(actual && versions && actual.startsWith(versions + sep));
}

/** Whether a process is still running. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
/** When a process started, as the system tells it; a pid given to another process later starts at another time. */
async function startedAt(pid: number): Promise<string | undefined> {
  try { return (await run('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 5000 })).stdout.trim() || undefined; } catch { return undefined; }
}
/** The lock's owner: its pid and when it started. However long the computer slept, a live helper still owns it. */
async function lockOwner(stateDir: string): Promise<{ pid: number; started?: string } | undefined> {
  const [pid, ...started] = (await readFile(updatePaths(stateDir).lock, 'utf8').catch(() => '')).split(' ');
  return Number(pid) > 0 && Number.isInteger(Number(pid)) ? { pid: Number(pid), ...(started.length ? { started: started.join(' ') } : {}) } : undefined;
}
async function helperRunning(stateDir: string): Promise<boolean> {
  const owner = await lockOwner(stateDir);
  if (!owner || !alive(owner.pid)) return false;
  if (!owner.started) return true;
  const now = await startedAt(owner.pid);
  return now === undefined || now === owner.started;
}
/**
 * Takes the helper lock. It is published whole, with its owner's pid and start time in it, so another helper never
 * sees it empty; a lock whose owner is gone is taken over. Two helpers taking over the same stale lock at once
 * can both publish; the one whose lock is no longer there a moment later stands down.
 */
async function takeLock(stateDir: string): Promise<boolean> {
  const { lock } = updatePaths(stateDir);
  const temporary = `${lock}.${process.pid}`;
  const mine = `${process.pid} ${await startedAt(process.pid) ?? ''}`.trim();
  await writeFile(temporary, mine, { mode: 0o600 });
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

export interface UpdateRequestResult { status: number; body: { update?: UpdateStatus; current?: true; error?: string; code?: string } }

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
    const next = this.queue.then(() => this.start(version));
    this.queue = next.catch(() => {});
    return next;
  }

  /** Where the last update stands; one whose helper is gone is reported as interrupted. */
  async status(): Promise<UpdateStatus | undefined> {
    const status = await readUpdateStatus(this.options.stateDir);
    if (!status) return undefined;
    if (!updateActive(status) || await this.busy(status)) return publicUpdate(status);
    return { ...publicUpdate(status), stage: 'failed', code: 'interrupted', failedStage: status.stage };
  }

  private async busy(status: UpdateStatus): Promise<boolean> {
    return await helperRunning(this.options.stateDir) || (this.options.now?.() ?? Date.now()) - Date.parse(status.updatedAt) < STARTING_MS;
  }

  private async start(version: unknown): Promise<UpdateRequestResult> {
    if (typeof version !== 'string' || !RELEASE.test(version)) return { status: 400, body: { code: 'invalid-version', error: 'Not a released version.' } };
    const current = await readUpdateStatus(this.options.stateDir);
    if (!newerVersion(version, this.options.version)) return { status: 200, body: { current: true, ...(current ? { update: publicUpdate(current) } : {}) } };
    if (!this.options.managed) return { status: 409, body: { code: 'not-service', error: 'This computer does not run Tower as its background service.' } };
    if (updateActive(current) && await this.busy(current!)) {
      // The newest version asked for wins; it is asked for again once this update has finished.
      return current!.version === version ? { status: 202, body: { update: publicUpdate(current!) } } : { status: 409, body: { code: 'busy', update: publicUpdate(current!) } };
    }
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
    const status = await readUpdateStatus(stateDir);
    if (!this.options.managed || !status || await helperRunning(stateDir)) return;
    if (updateActive(status) && status.version === version) {
      // Held anew before the helper starts: however long the computer was off, this web must not take the worker.
      await writeFile(updatePaths(stateDir).hold, JSON.stringify({ version }), { mode: 0o600 });
      this.spawn(version, true);
      return;
    }
    // The previous version runs again: a hold left for an update is not needed by it.
    if (status.previous === version) await rm(updatePaths(stateDir).hold, { force: true });
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
    const next = this.queue.then(async () => {
      if (!this.options.managed) return;
      const { stateDir } = this.options;
      const status = await readUpdateStatus(stateDir);
      if (updateActive(status) || await helperRunning(stateDir)) return;
      const keep = new Set([this.options.version, await currentVersion(stateDir), status?.previous, ...await inUse()].filter(Boolean));
      const installed = await readdir(runtimePaths(stateDir).versions).catch(() => [] as string[]);
      // An install cut short leaves its staging folder behind; no helper runs now to finish it.
      // An install still under way (by a join or service command run by hand) keeps its staging folder.
      const staging = (name: string) => { const pid = Number(/^\d+\.\d+\.\d+\.installing-(\d+)$/.exec(name)?.[1]); return pid > 0 && !alive(pid); };
      for (const name of installed) if ((RELEASE.test(name) && !keep.has(name)) || staging(name)) await rm(versionDirectory(stateDir, name), { recursive: true, force: true });
    });
    this.queue = next.catch(() => {});
    return next;
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
    install: version => installVersion(stateDir, version, line => console.log(line)),
    check: async (directory, version) => {
      const { stdout } = await run(process.execPath, [entryPoint(directory), '--version'], { timeout: 60_000 });
      if (stdout.trim() !== version) throw new Error(`The installed version reports ${stdout.trim().slice(0, 40) || 'nothing'}.`);
    },
    point: version => pointCurrent(stateDir, version),
    restart: async () => { await run('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? 501}/${serviceLabel(stateDir)}`], { timeout: 30_000 }); },
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
    // The hold stays until the previous version answers again: until then the new web may still be running, and it
    // must not hand the worker over. A previous version that never comes back releases it itself when it starts.
    const back = async (code: UpdateFailure, failedStage: UpdateStage) => {
      await set('rolling-back', { code, failedStage });
      try {
        await steps.point(previous);
        await restart();
        const up = await wait(async () => (await steps.health())?.version === previous, START_MS);
        if (up) await rm(paths.hold, { force: true });
        await set('failed', up ? { code, failedStage } : { code: 'rollback-failed', failedStage });
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
      if (await same() === false) return await back('start-failed', 'verifying');
      // Kept before the hold goes: stopped in between, the hold only runs out, and nothing is checked again unheld.
      await set('done');
      await rm(paths.hold, { force: true });
      return status;
    };
    // Started again by the new version after the helper was stopped: carry on from where it was.
    if (resume) {
      if (status.stage === 'rolling-back') return await back(status.code ?? 'interrupted', status.failedStage ?? 'verifying');
      if (status.stage === 'switching' || status.stage === 'verifying') return await verify(undefined, status.controllers ?? []);
      await set('failed', { code: 'interrupted', failedStage: status.stage });
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
    const before = await steps.health();
    const linked = await steps.controllers() ?? [];
    await set('switching', { controllers: linked });
    try {
      await writeFile(paths.hold, JSON.stringify({ version }), { mode: 0o600 });
      await steps.point(version);
    } catch (error) {
      steps.log((error as Error).message);
      // Nothing changed if the service still starts the previous version: it keeps running untouched.
      if (await currentVersion(stateDir) === previous) { await rm(paths.hold, { force: true }); await set('failed', { code: 'switch-failed', failedStage: 'switching' }); return status; }
      return await back('switch-failed', 'switching');
    }
    await restart();
    return await verify(before?.pid, linked);
  } finally {
    await rm(paths.lock, { force: true });
  }
}
