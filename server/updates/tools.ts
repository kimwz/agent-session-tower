import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, appendFile, link, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, join, sep } from 'node:path';
import { promisify } from 'node:util';
import { isSea } from 'node:sea';
import type { Provider } from '../../shared/types.js';
import type { ToolUpdate, ToolUpdateReason } from '../../shared/link.js';
import { findExecutable, providerDirectories, PROVIDERS } from '../providers/discovery.js';
import { newerVersion, rootOnly, runtimePaths } from '../link/service.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { failedAgain, parseRetry, retryDue, type RetryRecord } from './schedule.js';

const run = promisify(execFile);
const PACKAGES: Record<Provider, string> = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex' };
const VERSION = /(\d+\.\d+\.\d+)/;
const MINUTE = 60_000;
/** First look after the worker starts, then how often; a CLI busy in Tower is looked at again sooner. */
const FIRST_MS = 10 * MINUTE;
const EVERY_MS = 3 * 60 * MINUTE;
const BUSY_MS = 10 * MINUTE;
/** Claude Code's own installer swaps a link at the end, so stopping it leaves the previous version in place. */
const NATIVE_TIMEOUT_MS = 30 * MINUTE;
/** npm replaces files as it goes: it is never stopped, only reported as stuck after this long. */
const NPM_STUCK_MS = 60 * MINUTE;
/** A capability probe that started before an update claimed the CLI is waited for this long. */
const PROBE_WAIT_MS = 2 * MINUTE;

const AGENT_SESSION_ENV = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_CI', 'CODEX_THREAD_ID'];

/** Turned off only for development and fixture instances; the product keeps everything current. */
export function autoUpdateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !['off', '0', 'false', 'no'].includes((env.TOWER_AUTO_UPDATE ?? '').trim().toLowerCase());
}

export function toolUpdatePaths(stateDir: string) {
  const { root, logs } = runtimePaths(stateDir);
  return { status: join(root, 'tool-updates.json'), flags: join(root, 'tool-updates'), log: join(logs, 'tool-update.log') };
}

/** What this computer keeps about each CLI; the retry record stays here, and the fix is shown only on its own page. */
export interface SavedToolUpdate extends ToolUpdate { retry?: RetryRecord }
export type SavedToolUpdates = Partial<Record<Provider, SavedToolUpdate>>;

const STATES = new Set(['current', 'updating', 'waiting', 'failed', 'broken', 'unsupported']);
const METHODS = new Set(['native', 'npm', 'unsupported']);
const REASONS = new Set(['not-updated', 'command-failed', 'stuck', 'install-method', 'not-root-only', 'no-npm', 'unreadable-version']);
const release = (value: unknown) => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) ? value : undefined;
const time = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;

export function parseToolUpdate(value: unknown): SavedToolUpdate | undefined {
  const item = value as Partial<SavedToolUpdate> | undefined;
  if (!item || typeof item !== 'object' || !METHODS.has(item.method as string) || !STATES.has(item.state as string) || !time(item.checkedAt)) return undefined;
  const retry = parseRetry(item.retry);
  return { method: item.method!, state: item.state!, checkedAt: item.checkedAt!,
    ...(release(item.version) ? { version: item.version } : {}), ...(release(item.target) ? { target: item.target } : {}),
    ...(time(item.updatedAt) ? { updatedAt: item.updatedAt } : {}), ...(time(item.nextAt) ? { nextAt: item.nextAt } : {}),
    ...(REASONS.has(item.reason as string) ? { reason: item.reason } : {}), ...(retry ? { retry } : {}),
    ...(typeof item.fix === 'string' && item.fix.length <= 2000 ? { fix: item.fix } : {}) };
}

export async function readToolUpdates(stateDir: string): Promise<SavedToolUpdates> {
  const value = await readPrivateJson(toolUpdatePaths(stateDir).status).catch(() => undefined) as Record<string, unknown> | undefined;
  const saved: SavedToolUpdates = {};
  for (const provider of PROVIDERS) { const item = parseToolUpdate(value?.[provider]); if (item) saved[provider] = item; }
  return saved;
}

/** The part the page is told: no retry bookkeeping. The command that fixes a CLI by hand (a path) stays on this computer. */
export function publicToolUpdates(saved: SavedToolUpdates, local = false): Partial<Record<Provider, ToolUpdate>> {
  const shown: Partial<Record<Provider, ToolUpdate>> = {};
  for (const provider of PROVIDERS) { const item = saved[provider]; if (item) { const { retry: _, fix, ...rest } = item; shown[provider] = local && fix ? { ...rest, fix } : rest; } }
  return shown;
}

/** Where a CLI is installed, from the file its command resolves to. Only installs whose update is known are kept current. */
export type Install = { method: 'native' } | { method: 'npm'; prefix: string } | { method: 'unsupported' };
export function classifyInstall(provider: Provider, real: string): Install {
  // Claude Code's installer keeps each version as its own file and points the command at one.
  if (provider === 'claude' && /[/\\]claude[/\\]versions[/\\]\d+\.\d+\.\d+[^/\\]*$/.test(real)) return { method: 'native' };
  const marker = `${sep}lib${sep}node_modules${sep}${PACKAGES[provider].split('/').join(sep)}${sep}`;
  const at = real.indexOf(marker);
  return at > 0 ? { method: 'npm', prefix: real.slice(0, at) } : { method: 'unsupported' };
}

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** The processes a flag names: the worker that took it, and the installer it started. Any of them alive keeps it. */
async function held(file: string): Promise<boolean> {
  return (await readFile(file, 'utf8').catch(() => '')).split(/\s+/).some(pid => alive(Number(pid)));
}

/**
 * A CLI update and anything else of Tower's that starts the same CLI (a capability probe, an Auto Prompt or Slack
 * routing call) never run at once. Each side leaves its own file first and only then looks for the other's, so they
 * cannot both go ahead. Files of processes that are gone count for nothing, but an installer outliving its worker still
 * holds the CLI.
 */
async function claimUpdate(flags: string, provider: Provider): Promise<{ release: () => Promise<void>; add: (pid: number) => Promise<void> } | undefined> {
  await mkdir(flags, { recursive: true, mode: 0o700 });
  const file = join(flags, `${provider}.update`);
  // Written aside and linked into place, so the file never exists without the process that holds it.
  const staged = join(flags, `${provider}.update-${process.pid}-${randomUUID()}`);
  await writeFile(staged, String(process.pid), { mode: 0o600, flag: 'wx' });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await link(staged, file);
        return { release: () => rm(file, { force: true }), add: pid => writeFile(file, `${process.pid} ${pid}`, { mode: 0o600 }) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (await held(file)) return undefined;
        await rm(file, { force: true });
      }
    }
    return undefined;
  } finally { await rm(staged, { force: true }); }
}

async function probing(flags: string, provider: Provider): Promise<boolean> {
  const names = await readdir(flags).catch(() => [] as string[]);
  return names.some(name => { const pid = Number(new RegExp(`^${provider}\\.probe-(\\d+)-`).exec(name)?.[1]); return pid > 0 && alive(pid); });
}

/** Runs a probe of `provider` unless its CLI is being updated right now; then there is nothing to read. */
export async function unlessUpdating<T>(stateDir: string, provider: Provider, read: () => Promise<T>): Promise<T | undefined> {
  const { flags } = toolUpdatePaths(stateDir);
  await mkdir(flags, { recursive: true, mode: 0o700 });
  const mine = join(flags, `${provider}.probe-${process.pid}-${randomUUID()}`);
  await writeFile(mine, '', { mode: 0o600, flag: 'wx' });
  try {
    if (await held(join(flags, `${provider}.update`))) return undefined;
    return await read();
  } finally { await rm(mine, { force: true }); }
}

/**
 * Runs `use` of `provider`'s CLI once no update of it is under way, waiting for one that is: a routing call started
 * mid-install would find the CLI half replaced. Cancelled with `signal` while it waits.
 */
export async function afterUpdating<T>(stateDir: string, provider: Provider, signal: AbortSignal, use: () => Promise<T>, pauseMs = 1000): Promise<T> {
  const { flags } = toolUpdatePaths(stateDir);
  await mkdir(flags, { recursive: true, mode: 0o700 });
  for (;;) {
    const mine = join(flags, `${provider}.probe-${process.pid}-${randomUUID()}`);
    await writeFile(mine, '', { mode: 0o600, flag: 'wx' });
    let waiting = false;
    try {
      if (!await held(join(flags, `${provider}.update`))) return await use();
      waiting = true;
    } finally { await rm(mine, { force: true }); }
    if (waiting) {
      if (signal.aborted) throw signal.reason ?? new Error('Cancelled.');
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, pauseMs); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
    }
  }
}

/** Only root can change the file a root process would run, or the folders on the way to it. */
async function rootSafe(path: string): Promise<boolean> {
  const real = await realpath(path).catch(() => undefined);
  const info = real && await stat(real).catch(() => undefined);
  return Boolean(real && info && info.isFile() && info.uid === 0 && (info.mode & 0o022) === 0 && await rootOnly(dirname(real)) && await rootOnly(dirname(path)));
}

export interface CommandResult { code: number | null; output: string }
export interface ToolCommands {
  version(executable: string, env: NodeJS.ProcessEnv): Promise<string | undefined>;
  /** Runs an update in its own process group. `limit` either stops it (`kill`) or only reports it as stuck. */
  update(file: string, args: string[], env: NodeJS.ProcessEnv, limit: { ms: number; kill: boolean; stuck?: () => void; started?: (pid: number) => void }): Promise<CommandResult>;
  latest(pkg: string): Promise<string | undefined>;
}

export const nativeCommands: ToolCommands = {
  version: async (executable, env) => {
    try { return VERSION.exec((await run(executable, ['--version'], { env, timeout: 30_000, maxBuffer: 64 * 1024 })).stdout)?.[1]; } catch { return undefined; }
  },
  update: (file, args, env, limit) => new Promise(resolve => {
    const child = spawn(file, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (child.pid) limit.started?.(child.pid);
    let output = '';
    const keep = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-64 * 1024); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    const signal = (name: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, name); } catch { /* Already gone. */ } };
    const timer = setTimeout(() => {
      if (!limit.kill) { limit.stuck?.(); return; }
      signal('SIGTERM');
      setTimeout(() => signal('SIGKILL'), 5000).unref();
    }, limit.ms);
    child.once('error', error => { clearTimeout(timer); resolve({ code: null, output: `${output}\n${error.message}` }); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, output }); });
  }),
  latest: async pkg => {
    const response = await fetch(`https://registry.npmjs.org/-/package/${pkg.replace('/', '%2f')}/dist-tags`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return undefined;
    return release(((await response.json()) as { latest?: unknown }).latest);
  },
};

export interface ToolUpdatesOptions {
  stateDir: string;
  env: NodeJS.ProcessEnv;
  /**
   * Holds new launches of the CLI while none of its runs is starting or running; undefined when one is. `quiet`: npm
   * replaces files as it goes, so no session of the CLI may be working either, in Tower's terminals or anywhere else.
   */
  hold(provider: Provider, quiet: boolean): (() => void) | undefined;
  commands?: ToolCommands;
  find?: (provider: Provider, env: NodeJS.ProcessEnv) => Promise<string | undefined>;
  uid?: number;
  node?: string;
  now?: () => number;
  firstMs?: number;
  everyMs?: number;
  probeWaitMs?: number;
  onChange?: () => void;
}

/**
 * Keeps this account's Claude Code and Codex at their latest release, from the worker that starts their turns. A CLI is
 * updated only while Tower runs nothing of it, with new turns held until it is done; the turns then start with the new
 * version. Only installs whose update is known are touched: Claude Code's own installer, which swaps versions
 * atomically, and a global npm install, which npm replaces and which is never interrupted.
 */
export class ToolUpdates {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private stopped = false;
  private paused = false;
  constructor(private readonly options: ToolUpdatesOptions) {}

  private get commands(): ToolCommands { return this.options.commands ?? nativeCommands; }
  private now(): number { return this.options.now?.() ?? Date.now(); }

  start(): void { this.schedule(this.options.firstMs ?? FIRST_MS); }
  busy(): boolean { return this.running !== undefined; }
  /** While the worker hands off, no update starts; one found running keeps the worker from handing off. */
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  async stop(): Promise<void> { this.stopped = true; clearTimeout(this.timer); await this.running; }

  private schedule(ms: number): void {
    clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(() => { void this.check(); }, Math.max(1000, ms));
    this.timer.unref();
  }

  /** One look at both CLIs; the next look is sooner when one of them waits for Tower to be idle or for a retry. */
  check(): Promise<void> {
    if (this.running || this.stopped || this.paused) return this.running ?? Promise.resolve();
    this.running = (async () => {
      let next = this.options.everyMs ?? EVERY_MS;
      try {
        const saved = await readToolUpdates(this.options.stateDir);
        for (const provider of PROVIDERS) {
          if (this.stopped) break;
          const { status, againMs } = await this.one(provider, saved[provider], async status => {
            saved[provider] = status; await this.save(saved);
          }).catch(error => { this.log(`${provider}: ${(error as Error).message}`); return { status: saved[provider], againMs: undefined }; });
          if (status) saved[provider] = status; else delete saved[provider];
          await this.save(saved);
          if (againMs !== undefined) next = Math.min(next, againMs);
        }
      } finally {
        this.running = undefined;
        this.schedule(next);
      }
    })();
    return this.running;
  }

  private async save(saved: SavedToolUpdates): Promise<void> {
    await mkdir(runtimePaths(this.options.stateDir).root, { recursive: true, mode: 0o700 });
    await writePrivateJson(toolUpdatePaths(this.options.stateDir).status, JSON.stringify(saved));
    this.options.onChange?.();
  }

  private log(line: string): void {
    const { log } = toolUpdatePaths(this.options.stateDir);
    void mkdir(dirname(log), { recursive: true, mode: 0o700 }).then(() => appendFile(log, `${new Date(this.now()).toISOString()} ${line}\n`, { mode: 0o600 })).catch(() => {});
  }

  private async one(provider: Provider, previous: SavedToolUpdate | undefined, progress: (status: SavedToolUpdate) => Promise<void>): Promise<{ status?: SavedToolUpdate; againMs?: number }> {
    const env = this.options.env;
    const executable = await (this.options.find ?? findExecutable)(provider, env);
    const now = this.now();
    // A CLI an update left broken stays reported, with its fix, until it starts again: gone or silent, it is not fixed.
    const broken = previous?.state === 'broken' ? { status: { ...previous, checkedAt: new Date(now).toISOString() } } : undefined;
    // Not installed here: nothing is installed for it.
    if (!executable) return broken ?? {};
    const real = await realpath(executable).catch(() => executable);
    const install = classifyInstall(provider, real);
    const node = this.options.node ?? await towerNode(env);
    const root = (this.options.uid ?? process.getuid?.()) === 0;
    const npm = install.method === 'npm' && node ? await npmCli(node, providerDirectories(env)) : undefined;
    const target = await this.commands.latest(PACKAGES[provider]).catch(() => undefined) ?? previous?.target;
    // A process running as root runs nothing another account could have changed, not even to ask its version.
    if (root && !(await rootSafe(executable) && (!node || await rootSafe(node)) && (!npm || await rootSafe(npm)))) {
      return { status: { method: install.method, state: 'unsupported', reason: 'not-root-only', checkedAt: new Date(now).toISOString(), ...(target ? { target } : {}) } };
    }
    // The update and version commands find the Node that runs Tower first: npm and the npm CLIs start with `env node`.
    const folders = [...node ? [dirname(node)] : [], ...providerDirectories(env)];
    const path = root ? (await Promise.all(folders.map(async folder => await rootOnly(folder) ? folder : undefined))).filter(Boolean) as string[] : folders;
    const run: NodeJS.ProcessEnv = { ...env, PATH: [...new Set(path)].join(delimiter), CI: '1', npm_config_update_notifier: 'false' };
    // An agent's own session and sandbox markers, inherited when Tower was started from one, are not the account's.
    for (const key of AGENT_SESSION_ENV) delete run[key];
    const version = await this.commands.version(executable, run);
    if (!version && broken) return broken;
    const base: SavedToolUpdate = { method: install.method, state: 'current', checkedAt: new Date(now).toISOString(),
      ...(version ? { version } : {}), ...(target ? { target } : {}), ...(previous?.updatedAt ? { updatedAt: previous.updatedAt } : {}) };
    const retrying = previous?.retry && target && previous.retry.version === target ? previous.retry : undefined;
    if (!target || (version && !newerVersion(target, version))) return { status: base };
    const refuse = (reason: ToolUpdateReason): { status: SavedToolUpdate } => ({ status: { ...base, state: 'unsupported', reason } });
    if (install.method === 'unsupported') return refuse('install-method');
    if (!version) return { status: { ...base, state: 'failed', reason: 'unreadable-version' } };
    if (!retryDue(retrying, target, now)) return { status: { ...base, state: 'failed', ...(previous?.reason ? { reason: previous.reason } : {}), nextAt: retrying!.nextAt, retry: retrying }, againMs: Date.parse(retrying!.nextAt) - now };
    if (install.method === 'npm' && !npm) return refuse('no-npm');
    const waiting = { status: { ...base, state: 'waiting' as const, ...(retrying ? { retry: retrying } : {}) }, againMs: BUSY_MS };
    // Checked again at the last moment: a worker handing off or stopping starts nothing more.
    const releaseHold = this.stopped || this.paused ? undefined : this.options.hold(provider, install.method === 'npm');
    if (!releaseHold) return waiting;
    let claim: Awaited<ReturnType<typeof claimUpdate>>;
    try {
      const { flags } = toolUpdatePaths(this.options.stateDir);
      claim = await claimUpdate(flags, provider);
      if (!claim) return waiting;
      const started = (pid: number) => { void claim!.add(pid).catch(() => {}); };
      for (const until = Date.now() + (this.options.probeWaitMs ?? PROBE_WAIT_MS); await probing(flags, provider) && Date.now() < until;) await new Promise(resolve => setTimeout(resolve, 200));
      if (await probing(flags, provider)) return waiting;
      const updating: SavedToolUpdate = { ...base, state: 'updating', ...(retrying ? { retry: retrying } : {}) };
      await progress(updating);
      this.log(`${provider}: ${version} -> ${target} (${install.method})`);
      const stuck = () => { this.log(`${provider}: npm is still running after ${NPM_STUCK_MS / MINUTE} minutes`); void progress({ ...updating, reason: 'stuck' }); };
      const result = install.method === 'native'
        ? await this.commands.update(executable, ['update'], run, { ms: NATIVE_TIMEOUT_MS, kill: true, started })
        : await this.commands.update(node!, [npm!, 'install', '-g', '--prefix', (install as { prefix: string }).prefix, `${PACKAGES[provider]}@${target}`, '--no-audit', '--no-fund', '--loglevel=error'], run, { ms: NPM_STUCK_MS, kill: false, stuck, started });
      this.log(`${provider}: exit ${result.code}\n${result.output.trim().slice(-4000)}`);
      let after = await this.commands.version(executable, run);
      const done = this.now();
      if (after && !newerVersion(target, after)) return { status: { ...base, state: 'current', version: after, updatedAt: new Date(done).toISOString() } };
      // A global npm install that no longer starts is put back to the version it had.
      if (!after && install.method === 'npm') {
        this.log(`${provider}: does not start after the update; reinstalling ${version}`);
        const repaired = await this.commands.update(node!, [npm!, 'install', '-g', '--prefix', install.prefix, `${PACKAGES[provider]}@${version}`, '--no-audit', '--no-fund', '--loglevel=error'], run, { ms: NPM_STUCK_MS, kill: false, stuck, started });
        this.log(`${provider}: reinstall exit ${repaired.code}\n${repaired.output.trim().slice(-4000)}`);
        after = await this.commands.version(executable, run);
      }
      const retry = failedAgain(retrying, target, done);
      const fix = fixCommand(provider, install, target);
      if (!after) return { status: { ...base, state: 'broken', reason: 'command-failed', retry, nextAt: retry.nextAt, ...(fix ? { fix } : {}) }, againMs: Date.parse(retry.nextAt) - done };
      return { status: { ...base, version: after, state: 'failed', reason: result.code === 0 ? 'not-updated' : 'command-failed', retry, nextAt: retry.nextAt }, againMs: Date.parse(retry.nextAt) - done };
    } finally {
      await claim?.release();
      releaseHold();
    }
  }
}

/** What the owner runs by hand when Tower could not put a CLI back: its installer, or npm for the same folder. */
function fixCommand(provider: Provider, install: Install, version: string): string | undefined {
  if (install.method === 'npm') return `npm install -g --prefix '${install.prefix.replace(/'/g, `'\\''`)}' ${PACKAGES[provider]}@${version}`;
  return install.method === 'native' ? 'curl -fsSL https://claude.ai/install.sh | bash' : undefined;
}

/**
 * The Node that runs npm and the npm-installed CLIs: the one running Tower, or, when Tower is a single executable (whose
 * own path is not Node), the first Node on the path. Undefined when there is none; only a global npm install needs it.
 */
async function towerNode(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (!isSea()) return process.execPath;
  const own = await realpath(process.execPath).catch(() => process.execPath);
  for (const folder of providerDirectories(env)) {
    const real = await realpath(join(folder, 'node')).catch(() => undefined);
    if (real && real !== own && await access(real, constants.X_OK).then(() => true, () => false) && (await stat(real)).isFile()) return join(folder, 'node');
  }
  return undefined;
}

/** npm's own script, run by Tower's Node: the one beside that Node first, else the first on the path. */
async function npmCli(node: string, folders: string[]): Promise<string | undefined> {
  for (const folder of [dirname(node), ...folders]) {
    const real = await realpath(join(folder, 'npm')).catch(() => undefined);
    if (real && /[/\\]node_modules[/\\]npm[/\\]bin[/\\]npm-cli\.js$/.test(real)) return real;
  }
  return undefined;
}
