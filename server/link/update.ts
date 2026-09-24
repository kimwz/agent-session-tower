import { execFile, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { open, readdir, readFile, realpath, rm, stat, statfs, writeFile } from 'node:fs/promises';
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
/** A hold left by an update that never finished stops holding anything back after this long. */
const HOLD_MS = 15 * 60_000;
const ACTIVE: ReadonlySet<UpdateStage> = new Set(['installing', 'checking', 'switching', 'verifying', 'rolling-back']);
/** A helper that has not taken its lock this long after it was asked for did not start. */
const STARTING_MS = 30_000;
const RELEASE = /^\d+\.\d+\.\d+$/;

export function updatePaths(stateDir: string) {
  const { root, logs } = runtimePaths(stateDir);
  return { status: join(root, 'update.json'), lock: join(root, 'update.lock'), hold: join(root, 'handoff-hold'), log: join(logs, 'update.log') };
}

export async function readUpdateStatus(stateDir: string): Promise<UpdateStatus | undefined> {
  const value = await readPrivateJson(updatePaths(stateDir).status).catch(() => undefined) as Partial<UpdateStatus> | undefined;
  if (!value || typeof value.version !== 'string' || !RELEASE.test(value.version) || typeof value.previous !== 'string' || typeof value.stage !== 'string') return undefined;
  return value as UpdateStatus;
}
async function saveUpdateStatus(stateDir: string, status: UpdateStatus): Promise<void> {
  await writePrivateJson(updatePaths(stateDir).status, JSON.stringify(status));
}
export const updateActive = (status: UpdateStatus | undefined): boolean => Boolean(status && ACTIVE.has(status.stage));

/**
 * While an update is being tried, the new web must not hand the worker over: until the update is kept, going back
 * to the previous version has to find the previous worker. A hold nobody released in time holds nothing.
 */
export async function handoffHeld(stateDir: string, now = Date.now()): Promise<boolean> {
  const { hold } = updatePaths(stateDir);
  const info = await stat(hold).catch(() => undefined);
  if (!info) return false;
  if (now - info.mtimeMs < HOLD_MS) return true;
  await rm(hold, { force: true });
  return false;
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
async function helperRunning(stateDir: string): Promise<boolean> {
  const pid = Number(await readFile(updatePaths(stateDir).lock, 'utf8').catch(() => ''));
  return Number.isInteger(pid) && pid > 0 && alive(pid);
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
    spawnHelper?: (version: string) => void;
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
    if (!updateActive(status) || await this.busy(status!)) return status;
    return { ...status!, stage: 'failed', code: 'interrupted', failedStage: status!.stage };
  }

  private async busy(status: UpdateStatus): Promise<boolean> {
    return await helperRunning(this.options.stateDir) || (this.options.now?.() ?? Date.now()) - Date.parse(status.updatedAt) < STARTING_MS;
  }

  private async start(version: unknown): Promise<UpdateRequestResult> {
    if (typeof version !== 'string' || !RELEASE.test(version)) return { status: 400, body: { code: 'invalid-version', error: 'Not a released version.' } };
    const current = await readUpdateStatus(this.options.stateDir);
    if (!newerVersion(version, this.options.version)) return { status: 200, body: { current: true, ...(current ? { update: current } : {}) } };
    if (!this.options.managed) return { status: 409, body: { code: 'not-service', error: 'This computer does not run Tower as its background service.' } };
    if (updateActive(current) && await this.busy(current!)) {
      // The newest version asked for wins; it is asked for again once this update has finished.
      return current!.version === version ? { status: 202, body: { update: current } } : { status: 409, body: { code: 'busy', update: current } };
    }
    const at = new Date(this.options.now?.() ?? Date.now()).toISOString();
    const update: UpdateStatus = { version, previous: this.options.version, stage: 'installing', startedAt: at, updatedAt: at };
    await saveUpdateStatus(this.options.stateDir, update);
    (this.options.spawnHelper ?? (target => spawnUpdateHelper(this.options.stateDir, target, this.options.port)))(version);
    return { status: 202, body: { update } };
  }

  /**
   * An update whose helper is gone (the computer restarted, for example) is settled when Tower starts: if this is
   * the new version, it came up and is kept; otherwise it failed and the previous version runs.
   */
  async recover(): Promise<void> {
    const { stateDir, version } = this.options;
    const status = await readUpdateStatus(stateDir);
    if (!updateActive(status) || await helperRunning(stateDir)) return;
    await rm(updatePaths(stateDir).hold, { force: true });
    const at = new Date(this.options.now?.() ?? Date.now()).toISOString();
    await saveUpdateStatus(stateDir, status!.version === version ? { ...status!, stage: 'done', updatedAt: at }
      : { ...status!, stage: 'failed', code: 'interrupted', failedStage: status!.stage, updatedAt: at });
  }

  /** Versions nothing runs anymore are removed; the previous one stays for going back by hand. */
  async prune(inUse: Array<string | undefined>): Promise<void> {
    if (!this.options.managed) return;
    const { stateDir } = this.options;
    if (updateActive(await readUpdateStatus(stateDir))) return;
    const keep = new Set([this.options.version, await currentVersion(stateDir), (await readUpdateStatus(stateDir))?.previous, ...inUse].filter(Boolean));
    const installed = await readdir(runtimePaths(stateDir).versions).catch(() => [] as string[]);
    for (const name of installed) if (RELEASE.test(name) && !keep.has(name)) await rm(versionDirectory(stateDir, name), { recursive: true, force: true });
  }
}

/** Free space where versions are installed, for diagnostics. */
export async function diskFree(stateDir: string): Promise<number | undefined> {
  const info = await statfs(runtimePaths(stateDir).root).catch(() => undefined);
  return info ? info.bavail * info.bsize : undefined;
}

/** Starts the helper as its own process group, so restarting the service does not stop it. It keeps its own log. */
export function spawnUpdateHelper(stateDir: string, version: string, port: number): void {
  const entry = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../index.ts' : '../index.js', import.meta.url));
  const args = isSea() ? ['--update-helper', stateDir, version, String(port)]
    : [...process.execArgv.filter(arg => !/^--inspect(?:-brk|-port|-publish-uid)?(?:=|$)/.test(arg)), entry, '--update-helper', stateDir, version, String(port)];
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
    install: version => installVersion(stateDir, version, line => console.log(line)),
    check: async (directory, version) => {
      const { stdout } = await run(process.execPath, [entryPoint(directory), '--version'], { timeout: 60_000 });
      if (stdout.trim() !== version) throw new Error(`The installed version reports ${stdout.trim().slice(0, 40) || 'nothing'}.`);
    },
    point: version => pointCurrent(stateDir, version),
    restart: async () => { await run('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? 501}/${serviceLabel(stateDir)}`], { timeout: 30_000 }); },
    health: () => read<{ version: string; pid: number }>('/api/health'),
    controllers: async () => (await read<{ controllers: Array<{ id: string; status: string }> }>('/api/link'))?.controllers.filter(item => item.status === 'connected').map(item => item.id),
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
export async function runUpdateHelper(stateDir: string, version: string, steps: UpdateHelperSteps): Promise<UpdateStatus | undefined> {
  const paths = updatePaths(stateDir);
  let lock;
  try { lock = await open(paths.lock, 'wx', 0o600); }
  catch {
    if (await helperRunning(stateDir)) return undefined;
    await rm(paths.lock, { force: true });
    lock = await open(paths.lock, 'wx', 0o600);
  }
  await lock.writeFile(String(process.pid));
  await lock.close();
  let status = await readUpdateStatus(stateDir);
  try {
    if (!status || status.version !== version || !updateActive(status)) return status;
    const previous = status.previous;
    const set = async (stage: UpdateStage, extra: Partial<UpdateStatus> = {}) => {
      status = { ...status!, ...extra, stage, updatedAt: new Date(steps.now()).toISOString() };
      await saveUpdateStatus(stateDir, status);
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
    const back = async (code: UpdateFailure, failedStage: UpdateStage) => {
      await set('rolling-back', { code, failedStage });
      try {
        await steps.point(previous);
        await rm(paths.hold, { force: true });
        await restart();
        const up = await wait(async () => (await steps.health())?.version === previous, START_MS);
        await set('failed', up ? { code, failedStage } : { code: 'rollback-failed', failedStage });
      } catch (error) {
        steps.log(`rolling back failed: ${(error as Error).message}`);
        await set('failed', { code: 'rollback-failed', failedStage });
      }
      return status;
    };
    await set('installing');
    let directory: string;
    try { directory = await steps.install(version); }
    catch (error) { steps.log((error as Error).message); await set('failed', { code: 'install-failed', failedStage: 'installing' }); return status; }
    await set('checking');
    try { await steps.check(directory, version); }
    catch (error) { steps.log((error as Error).message); await set('failed', { code: 'check-failed', failedStage: 'checking' }); return status; }
    const before = await steps.health();
    const linked = await steps.controllers() ?? [];
    await set('switching');
    try {
      await writeFile(paths.hold, JSON.stringify({ version }), { mode: 0o600 });
      await steps.point(version);
    } catch (error) { steps.log((error as Error).message); return await back('switch-failed', 'switching'); }
    await restart();
    await set('verifying');
    const started = await wait(async () => { const health = await steps.health(); return health?.version === version && health.pid !== before?.pid; }, START_MS);
    if (!started) return await back('start-failed', 'verifying');
    // It came up; it must also reach a controller it was linked with, or no one could reach it to fix it.
    if (linked.length && !await wait(async () => (await steps.controllers())?.some(id => linked.includes(id)), LINK_MS)) return await back('link-failed', 'verifying');
    await rm(paths.hold, { force: true });
    await set('done');
    return status;
  } finally {
    await rm(paths.lock, { force: true });
  }
}
