import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { APP_VERSION, HEALTH_APPLICATION_ID } from '../../shared/app-identity.js';
import type { LinkOverview } from '../../shared/link.js';
import { lockOwners } from '../instance/state-lock.js';
import { defaultStateDir } from '../state-dir.js';
import { decodeJoinCode } from './join-code.js';
import { displayFingerprint, linkId } from './identity.js';
import { currentVersion, installService, installVersion, newerVersion, serviceManager, serviceStatus, START_YOURSELF, uninstallService, useVersion, type ServiceManager } from './service.js';

const USAGE = `Usage:
  agent-session-tower join <code> [--state-dir <path>] [--port <number>] [--no-service]
  agent-session-tower service install|uninstall|status [--state-dir <path>] [--port <number>]

join     Connects this computer to the Tower that made the code. Tower is installed and kept running in the
         background (on macOS from login, on Linux with systemd from boot, and again after a crash) unless it
         already runs here or --no-service is given.
service  Sets up, removes or shows the background service without joining anything.`;

const EVERY_START: Record<ServiceManager, string> = { launchd: 'whenever you log in', 'systemd-system': 'whenever this computer starts', 'systemd-user': 'whenever this computer starts' };
const NEXT_START: Record<ServiceManager, string> = { launchd: 'from your next login', 'systemd-system': 'from the next time this computer starts', 'systemd-user': 'from the next time this computer starts' };

/** The package this command runs from; `join` copies it instead of downloading the same version again. */
const packageRoot = () => fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../..' : '../../..', import.meta.url));

export async function runLinkCommand(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  let stateDir = defaultStateDir();
  let port = 8000;
  let service = true;
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === '--state-dir' && rest[index + 1]) stateDir = resolve(rest[++index]);
    else if (arg === '--port' && rest[index + 1]) port = Number(rest[++index]);
    else if (arg === '--no-service') service = false;
    else if (arg === '--help' || arg === '-h') { console.log(USAGE); return; }
    else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}\n\n${USAGE}`);
    else positional.push(arg);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
  if (command === 'service') return runService(positional[0], stateDir, port);
  if (positional.length !== 1) throw new Error(USAGE);
  const code = decodeJoinCode(positional[0]);
  if (code.expiresAt <= Date.now()) throw new Error('This connection code has expired. Make a new one on the other computer.');
  // The name comes from the pasted code; nothing in it may move the cursor or rewrite this terminal.
  const name = code.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  console.log(`Connecting this computer to ${name} (fingerprint ${displayFingerprint(code.pin)}).`);
  let running = await runningTower(stateDir);
  if (running) {
    const links = await fetch(`${running.base}/api/link`).catch(() => undefined);
    if (links?.status === 404) throw new Error(`Tower ${running.version} is running here but cannot join other computers yet. Quit it, then run this command again.`);
    if (!links?.ok) throw new Error(((await links?.json().catch(() => ({})) ?? {}) as { error?: string }).error ?? 'The Tower running here did not answer. Try again in a moment.');
  }
  const manager = service ? await serviceManager() : undefined;
  if (!running && !manager) {
    throw new Error(!service ? `Tower is not running here. ${START_YOURSELF} Or leave out --no-service.`
      : process.platform === 'linux' ? `This computer does not run systemd, so Tower cannot keep itself running here. ${START_YOURSELF}`
      : `Tower is not running here. ${START_YOURSELF}`);
  }
  if (!running && !await portFree(port)) throw new Error(`Port ${port} is used by another program on this computer. Run this command again with --port ${port + 1} (or another free port).`);
  // Coming back after a logout or restart without anyone at this computer needs the background service. When Tower
  // is not running, the service is (re)started with the requested port; a service that already runs is left alone.
  const installed = manager ? await serviceStatus(stateDir) : undefined;
  if (manager && installed && (!installed.installed || !installed.version || !running)) {
    // Never older than what already runs here: an older web would take the worker back a version.
    const version = running && newerVersion(running.version, code.version) ? running.version : code.version;
    await installVersion(stateDir, version, line => console.log(line), packageRoot());
    await useVersion(stateDir, version);
    await installService(stateDir, { port: running?.port ?? port, start: !running });
    const current = await currentVersion(stateDir) ?? version;
    console.log(running ? `Tower ${current} will start in the background ${NEXT_START[manager]}. The Tower running now keeps serving until then. (Use --no-service to leave the service out.)`
      : `Tower ${current} now starts in the background ${EVERY_START[manager]}. Waiting for it to start…`);
  }
  if (!running) {
    running = await waitFor(() => runningTower(stateDir), 180_000);
    if (!running) throw new Error(`Tower did not start. See ${resolve(stateDir, 'logs', 'tower.log')}.`);
  } else if (running.version !== code.version) {
    console.log(`Tower ${running.version} is running here (the other computer runs ${code.version}). Connecting with it.`);
  }
  await post(running.base, '/api/link/join', { code: positional[0] });
  const id = linkId(code.pin);
  const result = await waitFor(async () => {
    const overview = await get<LinkOverview>(running!.base, '/api/link').catch(() => undefined);
    const item = overview?.controllers.find(controller => controller.id === id);
    return item && (item.status === 'connected' && item.state === 'paired' || item.status === 'refused' || item.status === 'expired' || item.status === 'removed') ? item : undefined;
  }, 60_000);
  if (!result) throw new Error(`Still connecting to ${name}. Check that it can be reached at ${code.addresses.map(address => new URL(address).host).join(', ')}; this computer keeps trying.`);
  if (result.status !== 'connected') throw new Error(result.status === 'expired' ? 'The connection code expired before the computers met. Make a new one.'
    : result.status === 'removed' ? `${name} did not accept this computer. Make a new code there and run the new command.`
    : 'Another computer answered at that address. Check the addresses in the code.');
  console.log(`Connected. ${name} can now see and control this computer. Folders you exclude in Tower (Remote computers → Sharing) stay private.`);
  if (process.platform === 'darwin') console.log('Tower runs while you are logged in to this computer. To keep it reachable, let it log in automatically and keep it from sleeping (System Settings → Energy).');
  else if (manager) {
    console.log(`Tower runs in the background from boot (${manager === 'systemd-system' ? 'systemctl status' : 'systemctl --user status'} ${(await serviceStatus(stateDir)).file?.split('/').at(-1) ?? 'agent-session-tower.service'}); its log is ${resolve(stateDir, 'logs', 'tower.log')}.`);
    if (manager === 'systemd-system') console.log(`Tower runs as root here, so ${name} can run anything on this computer as root. To give it less, remove this service and join from a regular account instead.`);
    // WSL stops its Linux when nothing uses it, whatever systemd starts inside.
    if (process.env.WSL_DISTRO_NAME) console.log('This Linux runs in WSL, which Windows stops when it is idle; Tower is reachable only while WSL runs.');
  }
  console.log('Work runs with this computer\'s own Claude Code and Codex sign-ins; sign in to them here if you have not yet.');
}

async function runService(action: string | undefined, stateDir: string, port: number): Promise<void> {
  if (action === 'install') {
    await installVersion(stateDir, APP_VERSION, line => console.log(line), packageRoot());
    await useVersion(stateDir, APP_VERSION);
    await installService(stateDir, { port });
    const manager = await serviceManager();
    console.log(`Tower ${APP_VERSION} now starts in the background ${manager ? EVERY_START[manager] : ''}.`);
  } else if (action === 'uninstall') {
    await uninstallService(stateDir);
    console.log('The background service was removed. Running work continues; start Tower yourself to use it again.');
  } else if (action === 'status') {
    const status = await serviceStatus(stateDir);
    console.log(status.installed ? `Installed (${status.loaded ? 'running' : 'not loaded'}), version ${status.version ?? 'unknown'}: ${status.file}` : 'The background service is not installed.');
  } else throw new Error(USAGE);
}

/** The Tower that holds this state folder, confirmed by its process: another Tower on the same port is never used. */
async function runningTower(stateDir: string): Promise<{ base: string; port: number; version: string } | undefined> {
  for (const owner of await lockOwners(stateDir)) {
    const base = `http://127.0.0.1:${owner.port}`;
    const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) })
      .then(response => response.json() as Promise<{ ok?: boolean; application?: string; pid?: number; version?: string }>).catch(() => undefined);
    if (health?.ok && health.application === HEALTH_APPLICATION_ID && health.pid === owner.pid && health.version) return { base, port: owner.port, version: health.version };
  }
  return undefined;
}
function portFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}
async function get<T>(base: string, path: string): Promise<T> {
  const response = await fetch(`${base}${path}`);
  if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `Request failed (${response.status}).`);
  return response.json() as Promise<T>;
}
async function post(base: string, path: string, body: unknown): Promise<void> {
  const { token } = await get<{ token: string }>(base, '/api/bootstrap');
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `Request failed (${response.status}).`);
}
async function waitFor<T>(read: () => Promise<T | undefined>, timeout: number): Promise<T | undefined> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(1000);
  }
  return undefined;
}
