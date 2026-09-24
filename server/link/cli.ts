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
import { installService, installVersion, serviceStatus, uninstallService, useVersion } from './service.js';

const USAGE = `Usage:
  agent-session-tower join <code> [--state-dir <path>] [--port <number>] [--no-service]
  agent-session-tower service install|uninstall|status [--state-dir <path>] [--port <number>]

join     Connects this computer to the Tower that made the code. Tower is installed and kept running in the
         background (at login and after a crash) unless it already runs here or --no-service is given.
service  Sets up, removes or shows the background service without joining anything.`;

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
  if (running && !await get(running.base, '/api/link').then(() => true, () => false)) {
    throw new Error(`Tower ${running.version} is running here but cannot join other computers yet. Quit it, then run this command again.`);
  }
  if (!running && (!service || process.platform !== 'darwin')) {
    throw new Error(!service ? 'Tower is not running here. Start it (agent-session-tower --no-open) and run this command again, or leave out --no-service.'
      : 'Tower is not running here. On this system, start it with your service manager (agent-session-tower --no-open) and run this command again.');
  }
  if (!running && !await portFree(port)) throw new Error(`Port ${port} is used by another program on this computer. Run this command again with --port ${port + 1} (or another free port).`);
  // Coming back after a logout or restart without anyone at this computer needs the background service.
  if (service && process.platform === 'darwin' && !(await serviceStatus(stateDir)).installed) {
    await installVersion(stateDir, code.version, line => console.log(line), packageRoot());
    await useVersion(stateDir, code.version);
    await installService(stateDir, { port: running?.port ?? port });
    console.log(running ? `Tower ${code.version} will start in the background from your next login. The Tower running now keeps serving until then.`
      : `Tower ${code.version} now starts in the background whenever you log in. Waiting for it to start…`);
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
  console.log('Tower runs while you are logged in to this computer. To keep it reachable, let it log in automatically and keep it from sleeping (System Settings → Energy).');
}

async function runService(action: string | undefined, stateDir: string, port: number): Promise<void> {
  if (action === 'install') {
    await installVersion(stateDir, APP_VERSION, line => console.log(line), packageRoot());
    await useVersion(stateDir, APP_VERSION);
    await installService(stateDir, { port });
    console.log(`Tower ${APP_VERSION} now starts in the background whenever you log in.`);
  } else if (action === 'uninstall') {
    await uninstallService(stateDir);
    console.log('The background service was removed. Running work continues; start Tower yourself to use it again.');
  } else if (action === 'status') {
    const status = await serviceStatus(stateDir);
    console.log(status.installed ? `Installed (${status.loaded ? 'running' : 'not loaded'}), version ${status.version ?? 'unknown'}: ${status.plist}` : 'The background service is not installed.');
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
