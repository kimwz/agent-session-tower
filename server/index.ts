import { hostname, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { isSea } from 'node:sea';
import { SessionService } from './sessions.js';
import { SessionTitleStore } from './session-titles.js';
import { DismissedRunStore } from './dismissed-runs.js';
import { ClosedSessionStore } from './closed-sessions.js';
import { ProjectGroupStore } from './project-groups.js';
import { RunManager, getProviderHealth } from './runner.js';
import { AutoPromptManager } from './auto-prompts.js';
import { createMonitorServer } from './http.js';
import { acquireStateLock, MonitorAlreadyRunning } from './state-lock.js';
import { existingServerUrl } from './existing-server.js';
import { accessPasswordPath, loadAccessPassword, networkAccess } from './remote-access.js';
import { readWebAsset } from './web-assets.js';
import { projectSessionStates } from './snapshot.js';
import { openCodexBridgeRun } from './codex-app-server.js';
import { ProviderCapabilities } from './provider-capabilities.js';
import { trustWorkspace } from './workspace-trust.js';
import type { Snapshot, ProviderHealth } from '../shared/types.js';
import { defaultStateDir } from './state-dir.js';
import { APP_TITLE, APP_VERSION, STATE_DIR_NAME } from '../shared/app-identity.js';

const HELP = `${APP_TITLE} ${APP_VERSION}

Usage: agent-session-tower [run] [options]

  run                  Start the local session monitor (default)
  doctor               Check local CLI availability
  --port <number>      Listening port (default: 8000)
  --host <IPv4>        Bind address (default: 127.0.0.1; 0.0.0.0 for remote access)
  --no-open            Do not open the browser automatically
  --state-dir <path>   Managed task state (default: ~/${STATE_DIR_NAME})
  --help               Show this help
  --version            Print version

Non-loopback bindings require username monitor and a generated password.
The password is stored in <state-dir>/access-password with private permissions.
Uses existing Claude Code and Codex sign-ins.
Native histories are read directly; tasks use the existing Codex app server or CLI.
`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return; }
  if (args.includes('--version')) { console.log(APP_VERSION); return; }
  let port = 8000;
  let host = '127.0.0.1';
  let open = true;
  let stateDir = defaultStateDir();
  let command = 'run';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === 'run' || arg === 'doctor') command = arg;
    else if (arg === '--no-open') open = false;
    else if (arg === '--port') { if (!args[i + 1]) throw new Error('--port requires a number.'); port = Number(args[++i]); }
    else if (arg === '--host') { if (!args[i + 1]) throw new Error('--host requires an IPv4 address.'); host = args[++i]; }
    else if (arg === '--state-dir') { if (!args[i + 1]) throw new Error('--state-dir requires a path.'); stateDir = resolve(args[++i]); }
    else throw new Error(`Unknown option: ${arg}. Run with --help for usage.`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
  const access = networkAccess(host, port);
  const providers: ProviderHealth[] = await getProviderHealth();
  if (command === 'doctor') {
    for (const provider of providers) console.log(`${provider.available ? '✓' : '✗'} ${provider.provider}: ${provider.executable || provider.error || 'CLI not found'}`);
    console.log(`Session roots: ${process.env.CODEX_HOME || join(homedir(), '.codex')}, ${process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')}`);
    return;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const clientDir = isSea() ? here : here.includes(`${join('dist', 'server')}`) ? resolve(here, '../client') : resolve(here, '../dist/client');
  if (!await readWebAsset(clientDir, '/')) throw new Error('Web UI is unavailable. Rebuild or replace this installation.');
  let releaseLock: () => Promise<void>;
  try { releaseLock = await acquireStateLock(stateDir, port); }
  catch (error) {
    if (error instanceof MonitorAlreadyRunning) {
      const url = await existingServerUrl(error, { bindHost: host, remoteAccess: access.remote, probeHosts: access.probeHosts });
      if (url) {
        console.log(`Agent Session Tower is already running.\n${url}`);
        printRemoteAccess(host, error.owner.port, stateDir);
        if (open) openBrowser(url);
        return;
      }
    }
    throw error;
  }
  let password: string | undefined;
  try { if (access.remote) password = await loadAccessPassword(stateDir); }
  catch (error) { await releaseLock(); throw error; }
  const sessions = new SessionService();
  const titles = new SessionTitleStore(stateDir);
  const dismissedRuns = new DismissedRunStore(stateDir);
  const closedSessions = new ClosedSessionStore(stateDir);
  const groups = new ProjectGroupStore(stateDir);
  const runs = new RunManager({ getSession: id => sessions.get(id), refreshSessions: () => sessions.refresh(true), stateDir,
    openCodexBridge: options => openCodexBridgeRun({ ...options, codexHome: sessions.codexHome }), trustWorkspace,
  });
  // Load persisted history before shutdown or an HTTP request can touch the runner.
  try { await titles.start(); await dismissedRuns.start(); await closedSessions.start(); await groups.start(); await runs.start(); } catch (error) { await releaseLock(); throw error; }
  let scanning = true;
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of listeners) listener(); };
  const capabilities = new ProviderCapabilities(providers, { health: getProviderHealth, onChange: changed });
  sessions.on('change', changed);
  runs.on('change', changed);
  let autoPrompts: AutoPromptManager | undefined;
  const snapshot = (): Snapshot => {
    const all = runs.sessionList(sessions.list());
    const managed = runs.list();
    return {
      sessions: projectSessionStates(all, managed, runs.settledRunIds()).map(session => closedSessions.apply(titles.apply(session))),
      groups: groups.list(),
      providers: capabilities.list().map(provider => ({ ...provider, sessionCount: all.filter(session => session.provider === provider.provider).length })),
      runs: dismissedRuns.visible(managed), autoPrompts: autoPrompts?.list() || [], scanning, hostname: hostname(), version: APP_VERSION, updatedAt: new Date().toISOString(),
    };
  };
  const detail = async (id: string, before?: number, limit?: number) => {
    const session = runs.getSession(id);
    if (!session) return undefined;
    const history = await sessions.detail(runs.nativeSessionId(id), before, limit);
    return { ...(history || { messages: [], hasMore: false }), session: closedSessions.apply(titles.apply(session)) };
  };
  autoPrompts = new AutoPromptManager({ stateDir, snapshot, detail, refresh: () => sessions.refresh(true), runs });
  autoPrompts.on('change', changed);
  try { await autoPrompts.start(); }
  catch (error) { try { await runs.close(); } finally { await releaseLock(); } throw error; }
  const { server, dispose } = createMonitorServer({ port, clientDir,
    remote: password ? { password, origins: access.origins } : undefined, backend: {
    snapshot, detail,
    setTitle: async (id, title) => {
      const session = runs.getSession(id);
      if (!session) return undefined;
      const updated = await titles.set(session, title);
      changed();
      return closedSessions.apply(updated);
    },
    setClosed: async (id, closed) => {
      const session = runs.getSession(id);
      if (!session) return undefined;
      const updated = await closedSessions.set(session, closed);
      changed();
      return titles.apply(updated);
    },
    createSession: input => runs.create(input),
    startAutoPrompt: input => autoPrompts!.submit(input),
    getAutoPrompt: id => autoPrompts!.get(id),
    cancelAutoPrompt: id => autoPrompts!.cancel(id),
    setGroup: async patch => { const group = await groups.set(patch); changed(); return group; },
    enqueue: (id, prompt, attachments) => runs.enqueue(id, prompt, attachments),
    attachment: id => runs.attachment(id), cancel: id => runs.cancel(id), steerRun: id => runs.steer(id),
    respondToApproval: (runId, approvalId, decision) => runs.respondToApproval(runId, approvalId, decision),
    dismiss: async id => {
      await dismissedRuns.dismiss(id, runs.list().find(run => run.id === id));
      changed();
    },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  } });
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); accept(); });
  }).catch(async error => {
    dispose();
    try { await finishCleanup([autoPrompts!.close(), titles.flush(), dismissedRuns.flush(), closedSessions.flush(), groups.flush(), runs.close()]); } finally { await releaseLock(); }
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error(`Port ${port} is already in use. Open http://localhost:${port} if Agent Session Tower is already running, or choose --port 8001.`);
    throw error;
  });
  console.log(`\n  Agent Session Tower\n  ${access.browserUrl}\n`);
  printRemoteAccess(host, port, stateDir);
  console.log('  Reading local Claude Code and Codex sessions…\n  Press Ctrl+C to stop.\n');
  if (open) openBrowser(access.browserUrl);
  let closing = false;
  capabilities.start();
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    const stoppingAutoPrompts = autoPrompts!.close();
    const stoppingCapabilities = capabilities.stop();
    sessions.stop();
    dispose();
    server.closeAllConnections();
    server.close();
    try { await finishCleanup([stoppingAutoPrompts, stoppingCapabilities, titles.flush(), dismissedRuns.flush(), closedSessions.flush(), groups.flush(), runs.close()]); } finally { await releaseLock(); }
  };
  const onSignal = () => { void shutdown().catch(error => { console.error(`Agent Session Tower shutdown: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    await sessions.start();
    if (closing) { sessions.stop(); return; }
    scanning = false;
    changed();
    console.log(`  Ready: ${sessions.list().length} sessions discovered.\n`);
  } catch (error) { await shutdown(); throw error; }
}

async function finishCleanup(operations: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(operations);
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
  if (errors.length) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('; '));
}

function printRemoteAccess(host: string, port: number, stateDir: string) {
  const access = networkAccess(host, port);
  if (!access.remote) return;
  console.log(`  Remote URLs:\n${access.urls.map(url => `  ${url}`).join('\n')}\n  Username: monitor\n  Password file: ${accessPasswordPath(stateDir)}\n`);
}

function openBrowser(url: string) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  const child = spawn(opener, [url], { stdio: 'ignore', detached: true });
  child.on('error', () => console.log(`Open ${url} in your browser.`));
  child.unref();
}

main().catch(error => {
  console.error(`Agent Session Tower: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
