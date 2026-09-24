import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, cp, mkdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { defaultStateDir } from '../state-dir.js';

const run = promisify(execFile);
export const REPOSITORY = 'github:kimwz/agent-session-tower';

/** Where versions of Tower installed for the background service live, and which one is current. */
export function runtimePaths(stateDir: string) {
  const root = join(stateDir, 'runtime');
  return { root, versions: join(root, 'versions'), current: join(root, 'current'), logs: join(stateDir, 'logs') };
}
export function versionDirectory(stateDir: string, version: string): string { return join(runtimePaths(stateDir).versions, version); }
export function entryPoint(directory: string): string { return join(directory, 'node_modules', 'agent-session-tower', 'bin', 'agent-session-tower.mjs'); }

/**
 * Installs one released version beside the others; nothing that is running is touched. When this command
 * itself runs from an installed package of that version (for example through npx), that package and its
 * dependencies are copied instead of downloading and building it again.
 */
export async function installVersion(stateDir: string, version: string, log: (line: string) => void = () => {}, running?: string): Promise<string> {
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
      log(`Installing Agent Session Tower ${version} (this takes a minute or two)…`);
      await run('npm', ['install', '--prefix', staging, '--no-audit', '--no-fund', '--loglevel=error', `${REPOSITORY}#v${version}`], { timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024 });
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
  const paths = runtimePaths(stateDir);
  const temporary = `${paths.current}.${process.pid}`;
  await rm(temporary, { force: true });
  await symlink(join('versions', version), temporary);
  await rename(temporary, paths.current);
}
export async function currentVersion(stateDir: string): Promise<string | undefined> {
  try { return (await readlink(runtimePaths(stateDir).current)).split('/').at(-1); } catch { return undefined; }
}

export function serviceLabel(stateDir: string): string {
  return stateDir === defaultStateDir() ? 'io.github.kimwz.agent-session-tower' : `io.github.kimwz.agent-session-tower.${createHash('sha256').update(stateDir).digest('hex').slice(0, 8)}`;
}
export function servicePlist(stateDir: string): string { return join(homedir(), 'Library', 'LaunchAgents', `${serviceLabel(stateDir)}.plist`); }

const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The launchd job that runs the installed `current` version with this state directory. */
export function renderServicePlist(stateDir: string, options: { port: number; node?: string; environment?: NodeJS.ProcessEnv }): string {
  const paths = runtimePaths(stateDir);
  const env = options.environment ?? process.env;
  // npx and npm put their own and every parent folder's node_modules/.bin first; the service keeps the user's PATH.
  const path = (env.PATH ?? '/usr/bin:/bin').split(':').filter(entry => entry && !/(^|\/)node_modules\/\.bin$|node-gyp-bin|\/_npx\//.test(entry)).join(':');
  const variables: Record<string, string> = { PATH: path || '/usr/bin:/bin', HOME: env.HOME ?? homedir(), TOWER_SERVICE_LOG: join(paths.logs, 'tower.log') };
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'LANG']) if (env[key]) variables[key] = env[key]!;
  const argumentsList = [options.node ?? process.execPath, entryPoint(paths.current), 'run', '--no-open', '--port', String(options.port), '--state-dir', stateDir];
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
  <key>StandardOutPath</key><string>${xml(join(paths.logs, 'tower.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(paths.logs, 'tower.log'))}</string>
</dict>
</plist>
`;
}

/**
 * Keeps Tower running in the background for this user: it starts at login and again if it stops unexpectedly.
 * The web process it starts brings up the worker and terminal host as usual.
 */
export async function installService(stateDir: string, options: { port: number; node?: string; environment?: NodeJS.ProcessEnv }): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('The background service is available on macOS. Start Tower with your system service manager instead.');
  await mkdir(runtimePaths(stateDir).logs, { recursive: true, mode: 0o700 });
  const plist = renderServicePlist(stateDir, { ...options, node: options.node ?? await stableNode() });
  const file = servicePlist(stateDir);
  await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  await writeFile(file, plist, { mode: 0o644 });
  const domain = `gui/${process.getuid?.() ?? 501}`;
  await run('launchctl', ['bootout', domain, file]).catch(() => {});
  await run('launchctl', ['bootstrap', domain, file]).catch(error => {
    // Without a desktop login (for example over SSH after a restart) there is no session to start it in yet.
    const detail = String((error as { stderr?: unknown }).stderr || (error as Error).message).trim().split('\n')[0];
    throw new Error(`The background service is set up, but macOS did not start it (${detail}). If no one is logged in to this Mac's desktop, log in there (or turn on automatic login), then run this command again.`);
  });
}

/**
 * Package managers install Node under a versioned folder that an upgrade deletes; the service starts Node through
 * the managed link to the same binary when there is one, so it keeps working after the upgrade.
 */
async function stableNode(): Promise<string> {
  const actual = await realpath(process.execPath).catch(() => process.execPath);
  for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    if (await realpath(candidate).then(target => target === actual, () => false)) return candidate;
  }
  return process.execPath;
}

/** Whether the background service is set up, and which version it starts. */
export async function serviceStatus(stateDir: string): Promise<{ installed: boolean; loaded: boolean; version?: string; plist: string }> {
  const plist = servicePlist(stateDir);
  const installed = await access(plist, constants.R_OK).then(() => true, () => false);
  const loaded = installed && await run('launchctl', ['print', `gui/${process.getuid?.() ?? 501}/${serviceLabel(stateDir)}`]).then(() => true, () => false);
  const version = await currentVersion(stateDir);
  return { installed, loaded, ...(version ? { version } : {}), plist };
}

export async function uninstallService(stateDir: string): Promise<void> {
  const file = servicePlist(stateDir);
  await run('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}`, file]).catch(() => {});
  await rm(file, { force: true });
}
