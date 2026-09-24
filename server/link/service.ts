import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, cp, lstat, mkdir, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { defaultStateDir } from '../state-dir.js';
import { releasePackage } from './join-code.js';
import { APP_VERSION } from '../../shared/app-identity.js';

const run = promisify(execFile);
export const REPOSITORY = 'github:kimwz/agent-session-tower';

/** Where versions of Tower installed for the background service live, and which one is current. */
export function runtimePaths(stateDir: string) {
  const root = join(stateDir, 'runtime');
  return { root, versions: join(root, 'versions'), current: join(root, 'current'), logs: join(stateDir, 'logs') };
}
export function versionDirectory(stateDir: string, version: string): string { return join(runtimePaths(stateDir).versions, version); }
export function entryPoint(directory: string): string { return join(directory, 'node_modules', 'agent-session-tower', 'bin', 'agent-session-tower.mjs'); }

/** How long an update waits for its release's package to be published before it builds the version from source. */
export const RELEASE_WAIT_MS = 15 * 60_000;

/**
 * Installs one released version beside the others; nothing that is running is touched. When this command
 * itself runs from an installed package of that version (for example through npx), that package and its
 * dependencies are copied instead of downloading and building it again. Otherwise the release's built package is
 * installed; one not published yet is waited for (`waitMs`), and then the version is built from its source.
 */
export async function installVersion(stateDir: string, version: string, log: (line: string) => void = () => {}, running?: string,
  options: { waitMs?: number; sleep?: (ms: number) => Promise<void>; npm?: (args: string[]) => Promise<unknown> } = {}): Promise<string> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Not a released version: ${version}`);
  const directory = versionDirectory(stateDir, version);
  if (await access(entryPoint(directory), constants.R_OK).then(() => true, () => false)) return directory;
  const staging = `${directory}.installing-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    const source = running && await installedPackage(running, version);
    if (source) {
      log(`Copying Agent Session Tower ${version}…`);
      await cp(source, join(staging, 'node_modules'), { recursive: true, verbatimSymlinks: true });
    } else {
      log(`Installing Agent Session Tower ${version}…`);
      const npm = options.npm ?? (args => run('npm', args, { timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024 }));
      const install = (source: string) => npm(['install', '--prefix', staging, '--no-audit', '--no-fund', '--loglevel=error', source]);
      const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
      const deadline = Date.now() + (options.waitMs ?? 0);
      for (;;) {
        const failure = await install(releasePackage(version)).then(() => undefined, error => error as Error);
        if (!failure) break;
        const output = `${(failure as { stderr?: unknown }).stderr ?? ''} ${failure.message}`;
        const unpublished = /\b404\b/.test(output) && output.includes(releasePackage(version));
        if (unpublished && Date.now() < deadline) { await sleep(30_000); continue; }
        log(`The release's package could not be installed; building ${version} from its source (this takes a few minutes)…`);
        await install(`${REPOSITORY}#v${version}`);
        break;
      }
    }
    await access(entryPoint(staging), constants.R_OK);
    await rm(directory, { recursive: true, force: true });
    await rename(staging, directory);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw new Error(`Installing ${version} failed: ${(error as Error).message.split('\n')[0]}`);
  }
  return directory;
}

/**
 * The `node_modules` folder holding the package at `root`, if it is npx's own install of `version`. Other installs
 * (global, or inside a project) share their folder with unrelated packages and are not copied.
 */
async function installedPackage(root: string, version: string): Promise<string | undefined> {
  const parent = dirname(root);
  if (basename(root) !== 'agent-session-tower' || basename(parent) !== 'node_modules' || !parent.split(sep).includes('_npx')) return undefined;
  const manifest = await readFile(join(root, 'package.json'), 'utf8').then(text => JSON.parse(text) as { version?: string }, () => undefined);
  if (manifest?.version !== version) return undefined;
  const built = await access(join(root, 'dist', 'server', 'index.js'), constants.R_OK).then(() => true, () => false);
  return built ? parent : undefined;
}

/** Whether released version `a` is newer than `b`. */
export function newerVersion(a: string, b: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(a) || !/^\d+\.\d+\.\d+$/.test(b)) return false;
  const [x, y] = [a, b].map(value => value.split('.').map(Number));
  for (let index = 0; index < 3; index++) if (x[index] !== y[index]) return x[index] > y[index];
  return false;
}

/** Points `current` at a version atomically. A newer version already in use is kept: the service never goes back. */
export async function useVersion(stateDir: string, version: string): Promise<void> {
  const current = await currentVersion(stateDir);
  if (current && newerVersion(current, version)) return;
  await pointCurrent(stateDir, version);
}
/** Points `current` at an installed version atomically, older or not; only an update going back uses that. */
export async function pointCurrent(stateDir: string, version: string): Promise<void> {
  const paths = runtimePaths(stateDir);
  const temporary = `${paths.current}.${process.pid}`;
  await rm(temporary, { force: true });
  await symlink(join('versions', version), temporary);
  await rename(temporary, paths.current);
}
export async function currentVersion(stateDir: string): Promise<string | undefined> {
  try { return (await readlink(runtimePaths(stateDir).current)).split('/').at(-1); } catch { return undefined; }
}

/**
 * How this computer keeps Tower running in the background: launchd on macOS; systemd on Linux, for the whole computer
 * when run as root (it starts at boot) or for this user otherwise. Undefined where neither is in charge.
 */
export type ServiceManager = 'launchd' | 'systemd-system' | 'systemd-user';
export async function serviceManager(): Promise<ServiceManager | undefined> {
  if (process.platform === 'darwin') return 'launchd';
  if (process.platform !== 'linux') return undefined;
  // systemd runs this computer, not merely installed: it keeps this folder while it does.
  if (!await access('/run/systemd/system', constants.F_OK).then(() => true, () => false)) return undefined;
  return process.getuid?.() === 0 ? 'systemd-system' : 'systemd-user';
}

export function serviceLabel(stateDir: string): string {
  return stateDir === defaultStateDir() ? 'io.github.kimwz.agent-session-tower' : `io.github.kimwz.agent-session-tower.${createHash('sha256').update(stateDir).digest('hex').slice(0, 8)}`;
}
export function servicePlist(stateDir: string): string { return join(homedir(), 'Library', 'LaunchAgents', `${serviceLabel(stateDir)}.plist`); }
/** The systemd unit's name; like the launchd label, each state folder has its own. */
export function serviceUnit(stateDir: string): string {
  return stateDir === defaultStateDir() ? 'agent-session-tower.service' : `agent-session-tower-${createHash('sha256').update(stateDir).digest('hex').slice(0, 8)}.service`;
}
export function serviceFile(stateDir: string, manager: ServiceManager): string {
  if (manager === 'launchd') return servicePlist(stateDir);
  if (manager === 'systemd-system') return join('/etc/systemd/system', serviceUnit(stateDir));
  return join(homedir(), '.config', 'systemd', 'user', serviceUnit(stateDir));
}

const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** npx and npm put their own and every parent folder's node_modules/.bin first; the service keeps the user's own PATH. */
const userPath = (path = '/usr/bin:/bin') => path.split(':').filter(entry => entry.startsWith('/') && !/(^|\/)node_modules\/\.bin$|node-gyp-bin|\/_npx\//.test(entry));

/**
 * What the service starts, and with which environment: the user's PATH without npx's folders (only absolute folders),
 * who the user is (a service started by systemd has no login shell or name of its own), and Tower's own variables.
 */
function serviceCommand(stateDir: string, options: { port: number; node?: string; environment?: NodeJS.ProcessEnv }) {
  const paths = runtimePaths(stateDir);
  const env = options.environment ?? process.env;
  const path = userPath(env.PATH).join(':');
  const variables: Record<string, string> = { PATH: path || '/usr/bin:/bin', HOME: env.HOME ?? homedir(), TOWER_SERVICE_LOG: join(paths.logs, 'tower.log') };
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'LANG', 'SHELL', 'USER', 'LOGNAME']) if (env[key]) variables[key] = env[key]!;
  const argumentsList = [options.node ?? process.execPath, entryPoint(paths.current), 'run', '--no-open', '--port', String(options.port), '--state-dir', stateDir];
  return { argumentsList, variables, log: join(paths.logs, 'tower.log') };
}

/** The launchd job that runs the installed `current` version with this state directory. */
export function renderServicePlist(stateDir: string, options: { port: number; node?: string; environment?: NodeJS.ProcessEnv }): string {
  const { argumentsList, variables, log } = serviceCommand(stateDir, options);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(serviceLabel(stateDir))}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsList.map(value => `    <string>${xml(value)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(variables).map(([key, value]) => `    <key>${xml(key)}</key><string>${xml(value)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

/** One value in a unit file, quoted: systemd reads `%` as a specifier, and `\\` and `"` as escapes. */
const unitValue = (value: string) => {
  if (/[\n\r]/.test(value)) throw new Error(`A line break cannot be part of a service setting: ${JSON.stringify(value)}`);
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
};
/** An argument of ExecStart, where `$` also starts a variable (in Environment it does not). */
const unitArgument = (value: string) => unitValue(value).replace(/\$/g, '$$$$');

/**
 * The systemd unit that runs the installed `current` version with this state directory. Stopping or restarting it
 * ends only the web process: the worker, terminal host and their agents and shells go on, as they do under launchd.
 */
export function renderServiceUnit(stateDir: string, manager: 'systemd-system' | 'systemd-user', options: { port: number; node?: string; environment?: NodeJS.ProcessEnv }): string {
  const { argumentsList, variables, log } = serviceCommand(stateDir, options);
  // A file named with spaces cannot be written to directly; its output then goes to the journal.
  const output = /\s/.test(log) ? 'journal' : `append:${log.replace(/%/g, '%%')}`;
  return `[Unit]
Description=Agent Session Tower
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${argumentsList.map(unitArgument).join(' ')}
${Object.entries(variables).map(([key, value]) => `Environment=${unitValue(`${key}=${value}`)}`).join('\n')}
WorkingDirectory=-${variables.HOME.replace(/%/g, '%%')}
Restart=on-failure
RestartSec=10
KillMode=process
OOMPolicy=continue
StandardOutput=${output}
StandardError=${output}

[Install]
WantedBy=${manager === 'systemd-system' ? 'multi-user.target' : 'default.target'}
`;
}

/**
 * systemctl for the service's manager. A user's manager is found through the runtime folder a login sets up; a shell
 * reached through su or sudo has none set, so the folder systemd keeps for that user is used.
 */
const systemctl = async (manager: 'systemd-system' | 'systemd-user', ...args: string[]) => run('systemctl', [...manager === 'systemd-user' ? ['--user'] : [], ...args], { timeout: 60_000,
  env: manager === 'systemd-user' ? { ...process.env, XDG_RUNTIME_DIR: await userRuntime() } : process.env });
/** This user's runtime folder: the one set, if it is this user's (su without a dash keeps the previous user's), or systemd's own. */
async function userRuntime(): Promise<string> {
  const set = process.env.XDG_RUNTIME_DIR;
  if (set && await stat(set).then(info => info.uid === process.getuid?.(), () => false)) return set;
  return `/run/user/${process.getuid?.()}`;
}
const detail = (error: unknown) => String((error as { stderr?: unknown }).stderr || (error as Error).message).trim().split('\n')[0];

/**
 * Keeps Tower running in the background: on macOS it starts at login, on Linux at boot; either way again if it stops
 * unexpectedly. The web process it starts brings up the worker and terminal host as usual. `start: false` only sets it
 * up, for a computer where Tower already runs and keeps serving until the next start.
 */
export async function installService(stateDir: string, options: { port: number; node?: string; environment?: NodeJS.ProcessEnv; start?: boolean; warn?: (line: string) => void }): Promise<ServiceManager> {
  const manager = await serviceManager();
  if (!manager) throw new Error(process.platform === 'linux' ? `This computer does not run systemd, so Tower cannot keep itself running here. ${START_YOURSELF}`
    : `The background service is available on macOS and on Linux with systemd. ${START_YOURSELF}`);
  await mkdir(runtimePaths(stateDir).logs, { recursive: true, mode: 0o700 });
  const node = options.node ?? await stableNode();
  const environment = await serviceEnvironment(manager, options.environment ?? process.env, node, options.warn ?? (line => console.log(line)));
  const file = serviceFile(stateDir, manager);
  // Kept, so a later version can write the same service again with what it knows then (see refreshService).
  await writeFile(join(runtimePaths(stateDir).root, 'service.json'), JSON.stringify({ manager, port: options.port, node, environment }), { mode: 0o600 });
  if (manager === 'launchd') {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, renderServicePlist(stateDir, { port: options.port, node, environment }), { mode: 0o644 });
    const domain = `gui/${process.getuid?.() ?? 501}`;
    await run('launchctl', ['bootout', domain, file]).catch(() => {});
    if (options.start === false) return manager;
    await run('launchctl', ['bootstrap', domain, file]).catch(error => {
      // Without a desktop login (for example over SSH after a restart) there is no session to start it in yet.
      throw new Error(`The background service is set up, but macOS did not start it (${detail(error)}). If no one is logged in to this Mac's desktop, log in there (or turn on automatic login), then run this command again.`);
    });
    return manager;
  }
  // A user's services stop when the user logs out unless systemd keeps that user's manager running.
  if (manager === 'systemd-user') await keepUserServices();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, renderServiceUnit(stateDir, manager, { port: options.port, node, environment }), { mode: 0o644 });
  const status = `${manager === 'systemd-user' ? 'systemctl --user' : 'systemctl'} status ${serviceUnit(stateDir)}`;
  try {
    await systemctl(manager, 'daemon-reload');
    await systemctl(manager, 'enable', serviceUnit(stateDir));
    if (options.start !== false) await systemctl(manager, 'restart', serviceUnit(stateDir));
  } catch (error) {
    throw new Error(`The background service is set up, but systemd did not start it (${detail(error)}). See \`${status}\` and \`journalctl ${manager === 'systemd-user' ? '--user ' : ''}-u ${serviceUnit(stateDir)}\`.${manager === 'systemd-user' ? ' If you reached this account through su or sudo, log in to it directly and run this command again, or run it as root.' : ''}`);
  }
  return manager;
}

/** How to run Tower without a service, in the form that works where it was started through npx. */
export const START_YOURSELF = `Start Tower yourself (npx --yes ${releasePackage(APP_VERSION)} --no-open, or agent-session-tower --no-open if it is installed), keep it running, and run this command again.`;

/**
 * The environment the service is given. Who the user is comes from the system, not from variables sudo -E may have
 * carried over. A service for the whole computer runs as root, so its PATH leaves out folders others may write to;
 * the folder of the Node it runs stays, for npm.
 */
async function serviceEnvironment(manager: ServiceManager, env: NodeJS.ProcessEnv, node: string, warn: (line: string) => void): Promise<NodeJS.ProcessEnv> {
  const me = userInfo();
  // Only what the service uses is kept (it is saved for refreshService): no tokens or keys the shell happens to hold.
  const own: NodeJS.ProcessEnv = { PATH: userPath(env.PATH).join(':'), HOME: me.homedir, USER: me.username, LOGNAME: me.username, ...(me.shell ? { SHELL: me.shell } : {}) };
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'LANG']) if (env[key]) own[key] = env[key];
  if (manager !== 'systemd-system') return own;
  const kept: string[] = [];
  for (const folder of userPath(env.PATH)) if (await rootOnly(folder)) kept.push(folder);
  // Node and npm, and what npm installs globally, are wherever this Node is; root runs that Node already, so it stays,
  // and whoever else can change it is named.
  if (!kept.includes(dirname(node))) kept.push(dirname(node));
  const real = await realpath(node).catch(() => node);
  if (!await rootOnly(dirname(real)) || !await stat(real).then(info => info.uid === 0 && (info.mode & 0o022) === 0, () => false)) {
    warn(`Warning: ${real}, or a folder it is in, can be changed by an account other than root, and Tower runs it as root. Anyone with that account could then control this computer; a Node only root can change (from your distribution's packages, for example) avoids this.`);
  }
  return { ...own, PATH: kept.join(':') };
}

/**
 * Whether only root can change this folder: every part of it as written (a link there could be pointed elsewhere) and
 * every folder where it really is, up to /.
 */
async function rootOnly(folder: string): Promise<boolean> {
  const real = await realpath(folder).catch(() => undefined);
  if (!real) return false;
  const guarded = async (path: string, look: typeof stat) => {
    for (let current = path; ; current = dirname(current)) {
      // A link is changed only by replacing it in its folder, which the next step checks.
      if (!await look(current).then(info => info.uid === 0 && (info.isSymbolicLink() || (info.isDirectory() && (info.mode & 0o022) === 0)), () => false)) return false;
      if (dirname(current) === current) return true;
    }
  };
  return await guarded(folder, lstat) && await guarded(real, stat);
}

/**
 * Writes the installed service again with what this version knows about running it, when that differs; it takes effect
 * the next time the service starts. Started as the service, a new version keeps the service up to date this way.
 */
export async function refreshService(stateDir: string): Promise<boolean> {
  const saved = await readFile(join(runtimePaths(stateDir).root, 'service.json'), 'utf8').then(text => JSON.parse(text) as { manager: ServiceManager; port: number; node: string; environment: NodeJS.ProcessEnv }, () => undefined);
  if (!saved || saved.manager !== await serviceManager()) return false;
  const file = serviceFile(stateDir, saved.manager);
  const options = { port: saved.port, node: saved.node, environment: saved.environment };
  const wanted = saved.manager === 'launchd' ? renderServicePlist(stateDir, options) : renderServiceUnit(stateDir, saved.manager, options);
  if (await readFile(file, 'utf8').catch(() => undefined) === wanted) return false;
  await writeFile(file, wanted, { mode: 0o644 });
  if (saved.manager !== 'launchd') await systemctl(saved.manager, 'daemon-reload');
  return true;
}

/**
 * Lets this user's services run without anyone logged in, as they must on a computer nobody logs in to. Allowed for
 * oneself, it is done at once; otherwise sudo is asked, with its password prompt when this runs in a terminal.
 */
async function keepUserServices(): Promise<void> {
  const user = userInfo().username;
  const lingering = async () => (await run('loginctl', ['show-user', user, '--property=Linger']).then(result => result.stdout, () => '')).includes('Linger=yes');
  if (!await lingering()) {
    await run('loginctl', ['enable-linger', user]).catch(() => undefined);
    if (!await lingering() && process.stdin.isTTY) {
      console.log(`Tower has to keep running while nobody is logged in. Allowing that for ${user} needs sudo:`);
      await new Promise<void>(resolve => spawn('sudo', ['loginctl', 'enable-linger', user], { stdio: 'inherit' }).once('close', () => resolve()).once('error', () => resolve()));
    }
    if (!await lingering()) throw new Error(`Tower has to keep running while nobody is logged in here. Run \`sudo loginctl enable-linger ${user}\` once (or run this command as root), then run this command again.`);
  }
  // The user's service manager starts a moment after lingering is allowed.
  const bus = join(await userRuntime(), 'systemd', 'private');
  for (let waited = 0; waited < 10_000 && !await access(bus).then(() => true, () => false); waited += 250) await new Promise(resolve => setTimeout(resolve, 250));
}

/**
 * Package managers install Node under a versioned folder that an upgrade deletes; the service starts Node through
 * the managed link to the same binary when there is one, so it keeps working after the upgrade.
 */
async function stableNode(): Promise<string> {
  const actual = await realpath(process.execPath).catch(() => process.execPath);
  // A snap keeps each revision in its own folder and removes old ones; its command stays in place.
  if (/^\/snap\/node\/[^/]+\//.test(actual) && await access('/snap/bin/node').then(() => true, () => false)) return '/snap/bin/node';
  for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
    if (await realpath(candidate).then(target => target === actual, () => false)) return candidate;
  }
  return process.execPath;
}

/** Whether the background service is set up, and which version it starts. */
export async function serviceStatus(stateDir: string): Promise<{ manager?: ServiceManager; installed: boolean; loaded: boolean; version?: string; file?: string }> {
  const manager = await serviceManager();
  const version = await currentVersion(stateDir);
  if (!manager) return { installed: false, loaded: false, ...(version ? { version } : {}) };
  const file = serviceFile(stateDir, manager);
  const installed = await access(file, constants.R_OK).then(() => true, () => false);
  const loaded = installed && (manager === 'launchd'
    ? await run('launchctl', ['print', `gui/${process.getuid?.() ?? 501}/${serviceLabel(stateDir)}`]).then(() => true, () => false)
    : await systemctl(manager, 'is-active', '--quiet', serviceUnit(stateDir)).then(() => true, () => false));
  return { manager, installed, loaded, ...(version ? { version } : {}), file };
}

/** Restarts the web the service runs, as an update does; the worker and terminal host are not restarted. */
export async function restartService(stateDir: string): Promise<void> {
  const manager = await serviceManager();
  if (manager === 'launchd') await run('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? 501}/${serviceLabel(stateDir)}`], { timeout: 30_000 });
  else if (manager) await systemctl(manager, 'restart', serviceUnit(stateDir));
  else throw new Error('No service manager runs Tower here.');
}

export async function uninstallService(stateDir: string): Promise<void> {
  const manager = await serviceManager();
  if (!manager) return;
  const file = serviceFile(stateDir, manager);
  if (manager === 'launchd') await run('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}`, file]).catch(() => {});
  else {
    await systemctl(manager, 'disable', serviceUnit(stateDir)).catch(() => {});
    await systemctl(manager, 'stop', serviceUnit(stateDir)).catch(() => {});
  }
  await rm(file, { force: true });
  if (manager !== 'launchd') await systemctl(manager, 'daemon-reload').catch(() => {});
}
