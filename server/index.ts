import { hostname, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { isSea } from 'node:sea';
import { nativeHistory } from './sessions/native-history.js';
import { SessionTitleStore } from './stores/session-titles.js';
import { DismissedRunStore } from './stores/dismissed-runs.js';
import { ClosedSessionStore } from './stores/closed-sessions.js';
import { ProjectGroupStore } from './stores/project-groups.js';
import { DurableRunManager } from './runs/durable-runner.js';
import { runRunnerWorker } from './runs/worker.js';
import { runTerminalHost } from './terminals/host.js';
import { TerminalHostClient } from './terminals/client.js';
import { startSlackMcp, startTowerMcp } from './slack/mcp-bridge.js';
import { getProviderHealth } from './providers/discovery.js';
import { createMonitorServer } from './http/server.js';
import { acquireStateLock, MonitorAlreadyRunning } from './instance/state-lock.js';
import { existingServerUrl } from './instance/existing-server.js';
import { networkAccess } from './http/remote-access.js';
import { AuthStore } from './auth/store.js';
import { readWebAsset } from './http/web-assets.js';
import { projectSessionStates } from './sessions/snapshot.js';
import { ProviderCapabilities } from './providers/capabilities.js';
import { RepositoryMonitor, watchedRepositoryPaths } from './repositories/monitor.js';
import { installAgentGuidance } from './agent-guidance/install.js';
import { overlapsRepository } from '../shared/repositories.js';
import type { Snapshot, ProviderHealth } from '../shared/types.js';
import { defaultStateDir } from './state-dir.js';
import { APP_TITLE, APP_VERSION, STATE_DIR_NAME } from '../shared/app-identity.js';

/** Every request this web server admits comes from the owner's browser session. */
const OWNER = { kind: 'owner' } as const;

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

Direct localhost access requires no login. Set a remote account in local Account management.
Remote access requires login; 5 failed attempts permanently block that IP until locally unblocked.
Only salted password hashes are stored in <state-dir>/auth.json.
Uses existing Claude Code and Codex sign-ins.
Native histories are read directly; tasks use the existing Codex app server or CLI.
`;

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--slack-mcp') {
    if (args.length !== 3) throw new Error('Slack MCP requires a state directory and workflow ID.');
    await startSlackMcp(resolve(args[1]), args[2]);
    return;
  }
  if (args[0] === '--tower-mcp') {
    if (args.length !== 2) throw new Error('Tower MCP requires a state directory.');
    await startTowerMcp(resolve(args[1]));
    return;
  }
  if (args[0] === '--runner-worker') {
    if (args.length !== 2 || !args[1]) throw new Error('Runner worker requires a state directory.');
    await runRunnerWorker(resolve(args[1]));
    return;
  }
  if (args[0] === '--terminal-host') {
    if (args.length !== 2 || !args[1]) throw new Error('Terminal host requires a state directory.');
    await runTerminalHost(resolve(args[1]));
    return;
  }
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
  const auth = new AuthStore(stateDir);
  try { await auth.start(); }
  catch (error) { auth.close(); await releaseLock(); throw error; }
  if (!auth.configured() && access.remote && host !== '0.0.0.0') {
    auth.close(); await releaseLock();
    throw new Error('Configure an account first: start with --host 127.0.0.1 or --host 0.0.0.0, then open local Account management.');
  }
  // Only the owner's own Tower (default state directory) points their global instructions at itself.
  if (stateDir === defaultStateDir()) {
    await installAgentGuidance({ stateDir, claudeHome: process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), codexHome: process.env.CODEX_HOME || join(homedir(), '.codex') })
      .catch(error => console.error(`Agent guidance was not updated: ${error instanceof Error ? error.message : String(error)}`));
  }
  const titles = new SessionTitleStore(stateDir);
  const dismissedRuns = new DismissedRunStore(stateDir);
  const closedSessions = new ClosedSessionStore(stateDir);
  const groups = new ProjectGroupStore(stateDir);
  const runs = new DurableRunManager({ stateDir });
  // Load persisted history before shutdown or an HTTP request can touch the runner.
  try { await titles.start(); await dismissedRuns.start(); await closedSessions.start(); await groups.start(); await runs.start(); } catch (error) { auth.close(); await releaseLock(); throw error; }
  // The worker has indexed native sessions before it answers, so the session list is complete here.
  const history = nativeHistory(runs);
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of listeners) listener(); };
  const capabilities = new ProviderCapabilities(providers, { health: getProviderHealth, onChange: changed });
  runs.on('change', changed);
  const repositories = new RepositoryMonitor({
    watched: () => watchedRepositoryPaths(runs.sessionList(), groups.list()),
    busy: status => runs.sessionList().some(session => session.status === 'working' && overlapsRepository(status, session.cwd))
      || runs.list().some(run => (run.status === 'running' || run.status === 'queued') && overlapsRepository(status, runs.getSession(run.sessionId)?.cwd ?? '')),
    onChange: changed,
  });
  const snapshot = (): Snapshot => {
    const all = runs.sessionList();
    const managed = runs.list();
    return {
      sessions: projectSessionStates(all, managed, runs.settledRunIds()).map(session => closedSessions.apply(titles.apply(session))),
      groups: groups.list(),
      repositories: repositories.list(),
      providers: capabilities.list().map(provider => ({ ...provider, sessionCount: all.filter(session => session.provider === provider.provider).length })),
      runs: dismissedRuns.visible(managed), autoPrompts: runs.autoPromptList(), scanning: history.indexing, hostname: hostname(), version: APP_VERSION,
      ...(runs.triggerOverview() ? { triggers: runs.triggerOverview() } : {}),
      ...(runs.runnerVersion() ? { runnerVersion: runs.runnerVersion() } : {}),
      ...(runs.runnerVersion() && runs.runnerVersion() !== APP_VERSION ? { runnerUpdate: runs.supports('handoff') ? 'automatic' as const : 'manual' as const } : {}),
      updatedAt: new Date().toISOString(),
    };
  };
  const detail = async (id: string, before?: number, limit?: number) => {
    const session = runs.getSession(id);
    if (!session) return undefined;
    const page = await history.read(runs.nativeSessionId(id), before, limit);
    return { ...(page || { messages: [], hasMore: false }), session: closedSessions.apply(titles.apply(session)) };
  };
  const { server, dispose } = createMonitorServer({ port, clientDir,
    auth, workspaceTerminals: new TerminalHostClient({ stateDir, legacy: runs.terminals }), remote: access.remote ? { origins: access.origins } : undefined, backend: {
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
    createSession: async input => { await repositories.prepareRun(input.cwd); return runs.create(input, { origin: OWNER }); },
    startAutoPrompt: input => runs.submitAutoPrompt(input, { origin: OWNER }),
    getAutoPrompt: id => runs.getAutoPrompt(id),
    cancelAutoPrompt: id => runs.cancelAutoPrompt(id),
    slackOverview: () => runs.slackOverview(),
    api: (operation, input) => runs.api(operation, input),
    slackMutate: (action, body) => runs.slackMutate(action, body),
    setGroup: async patch => { const group = await groups.set(patch); changed(); return group; },
    enqueue: async (id, prompt, attachments) => {
      const cwd = runs.getSession(id)?.cwd;
      if (cwd) await repositories.prepareRun(cwd);
      return runs.enqueue(id, prompt, attachments, { origin: OWNER });
    },
    repositoryAction: (cwd, action) => repositories.act(cwd, action),
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
    auth.close();
    try { await finishCleanup([auth.flush(), titles.flush(), dismissedRuns.flush(), closedSessions.flush(), groups.flush(), runs.close()]); } finally { await releaseLock(); }
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error(`Port ${port} is already in use. Open http://localhost:${port} if Agent Session Tower is already running, or choose --port 8001.`);
    throw error;
  });
  console.log(`\n  Agent Session Tower\n  ${access.browserUrl}\n`);
  printRemoteAccess(host, port, stateDir);
  if (!auth.configured()) console.log(`  Remote account not configured. Open http://localhost:${port} and select Account management in the expanded navigation.\n`);
  console.log('  Reading local Claude Code and Codex sessions…\n  Press Ctrl+C to stop the web server. Agent work continues independently.\n');
  if (open) openBrowser(access.browserUrl);
  let closing = false;
  capabilities.start();
  repositories.start();
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    const stoppingCapabilities = capabilities.stop();
    const stoppingRepositories = repositories.stop();
    history.stop();
    auth.close();
    dispose();
    server.closeAllConnections();
    server.close();
    try { await finishCleanup([auth.flush(), stoppingCapabilities, stoppingRepositories, titles.flush(), dismissedRuns.flush(), closedSessions.flush(), groups.flush(), runs.close()]); } finally { await releaseLock(); }
  };
  const onSignal = () => { void shutdown().catch(error => { console.error(`Agent Session Tower shutdown: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    await history.start();
    if (closing) { history.stop(); return; }
    changed();
    console.log(`  Ready: ${runs.sessionList().length} sessions discovered.\n`);
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
  console.log(`  Remote URLs:\n${access.urls.map(url => `  ${url}`).join('\n')}\n  Remote login: account configured in local Account management\n  Account state: ${join(stateDir, 'auth.json')}\n  ${host === '0.0.0.0' ? 'Direct localhost access does not require login.' : 'For local account management, stop and restart with --host 127.0.0.1 using the same state directory.'}\n`);
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
