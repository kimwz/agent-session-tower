import { hostname, homedir } from 'node:os';
import { stat, truncate } from 'node:fs/promises';
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
import { RemoteExclusionStore } from './remote/exclusions.js';
import { createRemoteRouter } from './remote/router.js';
import type { RequestContext } from './http/request-context.js';
import type { Backend } from './http/server.js';
import { loadLinkIdentity } from './link/identity.js';
import { ControllerLinks } from './link/controller.js';
import { NodeLinks } from './link/node.js';
import { runLinkCommand } from './link/cli.js';
import { RemoteNodes } from './link/nodes.js';
import { RemoteAudit } from './remote/audit.js';
import { NodeViewStore } from './link/views.js';
import { newerVersion } from './link/service.js';
import { releasePublished } from './link/join-code.js';
import { diskFree, handoffHeld, heldWorkerEntry, managedByService, runUpdateHelper, serviceSteps, Updates } from './link/update.js';
import type { Snapshot, ProviderHealth } from '../shared/types.js';
import { defaultStateDir } from './state-dir.js';
import { APP_TITLE, APP_VERSION, STATE_DIR_NAME } from '../shared/app-identity.js';

/** Every request this web server admits comes from the owner's browser session. */
const OWNER = { kind: 'owner' } as const;

const HELP = `${APP_TITLE} ${APP_VERSION}

Usage: agent-session-tower [run] [options]

  run                  Start the local session monitor (default)
  doctor               Check local CLI availability
  join <code>          Let another Tower control this computer (the code comes from its Remote computers panel)
  service <action>     install | uninstall | status: keep Tower running in the background (macOS)
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
  if (args[0] === '--update-helper') {
    if (args.length !== 4 && !(args.length === 5 && args[4] === '--resume')) throw new Error('The update helper requires a state directory, a version and a port.');
    await runUpdateHelper(resolve(args[1]), args[2], serviceSteps(resolve(args[1]), Number(args[3])), args[4] === '--resume');
    return;
  }
  if (args[0] === 'join' || args[0] === 'service') {
    await runLinkCommand(args);
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
  // The background service appends to one log file; it is started over when it grows large.
  const serviceLog = process.env.TOWER_SERVICE_LOG;
  // Only this process reads it; the worker, shells and agents it starts do not inherit it.
  delete process.env.TOWER_SERVICE_LOG;
  if (serviceLog) await stat(serviceLog).then(info => info.size > 10 * 1024 * 1024 ? truncate(serviceLog, 0) : undefined).catch(() => {});
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
  const exclusions = new RemoteExclusionStore(stateDir);
  // Only the background service's own install is replaced by an update; an update left unfinished is settled first.
  const updates = new Updates({ stateDir, version: APP_VERSION, port, managed: await managedByService(stateDir, process.argv[1], Boolean(serviceLog)) });
  await updates.recover().catch(error => console.error(`The last update could not be settled: ${error instanceof Error ? error.message : String(error)}`));
  // While an update is tried, the worker stays the previous version's, and one that is needed is started from it.
  const runs = new DurableRunManager({ stateDir, handoffHeld: () => handoffHeld(stateDir), heldWorkerEntry: () => heldWorkerEntry(stateDir) });
  // Load persisted history before shutdown or an HTTP request can touch the runner.
  try { await titles.start(); await dismissedRuns.start(); await closedSessions.start(); await groups.start(); await exclusions.start(); await runs.start(); } catch (error) { auth.close(); await releaseLock(); throw error; }
  /** Local browser requests are the owner's; a remote controller's carry its own origin and request ID. */
  const admit = (context?: RequestContext) => ({ origin: context?.origin ?? OWNER, ...(context?.requestId ? { requestId: context.requestId } : {}) });
  // The worker has indexed native sessions before it answers, so the session list is complete here.
  const history = nativeHistory(runs);
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of listeners) listener(); };
  const capabilities = new ProviderCapabilities(providers, { health: getProviderHealth, onChange: changed });
  runs.on('change', changed);
  const repositories = new RepositoryMonitor({
    watched: () => watchedRepositoryPaths(runs.sessionList(), groups.list()),
    busy: status => runs.sessionList().some(session => session.status === 'working' && overlapsRepository(status, session.cwd))
      || runs.list().some(run => (run.status === 'running' || (run.status === 'queued' && !(run.scheduled && Date.parse(run.scheduled.at) > Date.now()))) && overlapsRepository(status, runs.getSession(run.sessionId)?.cwd ?? '')),
    onChange: changed,
  });
  let controlledBy = (): string[] => [];
  let controllerJoined = (): { name: string; at: string } | undefined => undefined;
  let remoteNodes: RemoteNodes | undefined;
  const snapshot = (): Snapshot => {
    const all = runs.sessionList();
    const controllers = controlledBy();
    const joined = controllerJoined();
    const nodes = remoteNodes?.list() ?? [];
    const managed = runs.list();
    return {
      sessions: projectSessionStates(all, managed, runs.settledRunIds()).map(session => closedSessions.apply(titles.apply(session))),
      groups: groups.list(),
      repositories: repositories.list(),
      providers: capabilities.list().map(provider => ({ ...provider, sessionCount: all.filter(session => session.provider === provider.provider).length })),
      runs: dismissedRuns.visible(managed), autoPrompts: runs.autoPromptList(), scanning: history.indexing, hostname: hostname(), version: APP_VERSION,
      ...(runs.triggerOverview() ? { triggers: runs.triggerOverview() } : {}),
      ...(runs.runnerVersion() ? { runnerVersion: runs.runnerVersion() } : {}),
      // Only an older worker is waiting to be replaced; a newer one left by an update that was undone stays as it is.
      ...(runs.runnerVersion() && (runs.runnerVersion() === 'legacy' || newerVersion(APP_VERSION, runs.runnerVersion()!)) ? { runnerUpdate: runs.supports('handoff') ? 'automatic' as const : 'manual' as const } : {}),
      ...(controllers.length ? { controlledBy: controllers } : {}),
      ...(joined ? { controllerJoined: joined } : {}),
      ...(remoteNodes?.ready ? { nodes } : {}),
      updatedAt: new Date().toISOString(),
    };
  };
  const detail = async (id: string, before?: number, limit?: number) => {
    const session = runs.getSession(id);
    if (!session) return undefined;
    const page = await history.read(runs.nativeSessionId(id), before, limit);
    return { ...(page || { messages: [], hasMore: false }), session: closedSessions.apply(titles.apply(session)) };
  };
  const backend: Backend = {
    snapshot, detail,
    session: id => { const found = runs.getSession(id); return found && closedSessions.apply(titles.apply(found)); },
    coordinators: () => runs.coordinators(),
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
      // Closing a conversation also stops what its agent planned to do in it later.
      if (closed) for (const run of runs.list()) if (run.sessionId === session.id && run.status === 'queued' && run.scheduled) await runs.cancel(run.id).catch(() => {});
      changed();
      return titles.apply(updated);
    },
    createSession: async (input, context) => { await repositories.prepareRun(input.cwd); return runs.create(input, admit(context)); },
    startAutoPrompt: (input, context) => runs.submitAutoPrompt(input, admit(context)),
    getAutoPrompt: id => runs.getAutoPrompt(id),
    cancelAutoPrompt: id => runs.cancelAutoPrompt(id),
    slackOverview: () => runs.slackOverview(),
    api: (operation, input, context) => runs.api(operation, input, context && admit(context)),
    slackMutate: (action, body) => runs.slackMutate(action, body),
    setGroup: async patch => { const group = await groups.set(patch); changed(); return group; },
    enqueue: async (id, prompt, attachments, context) => {
      const cwd = runs.getSession(id)?.cwd;
      if (cwd) await repositories.prepareRun(cwd);
      return runs.enqueue(id, prompt, attachments, admit(context));
    },
    repositoryAction: (cwd, action) => repositories.act(cwd, action),
    attachment: id => runs.attachment(id), cancel: id => runs.cancel(id), steerRun: id => runs.steer(id),
    respondToApproval: (runId, approvalId, decision) => runs.respondToApproval(runId, approvalId, decision),
    dismiss: async id => {
      await dismissedRuns.dismiss(id, runs.list().find(run => run.id === id));
      changed();
    },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  // Other computers: those this one controls, those that control it, and what it answers them with.
  // Without a usable identity only remote computers are unavailable; everything else runs as usual.
  let linkError = '';
  const identity = await loadLinkIdentity(stateDir).catch(error => {
    linkError = `원격 컴퓨터를 사용할 수 없습니다: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`Remote computers are unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  });
  const workspaceTerminals = new TerminalHostClient({ stateDir, legacy: runs.terminals });
  // What controlling computers change here is kept for this computer's owner to read, with each one's name then.
  let controllerName = (_id: string): string | undefined => undefined;
  const remoteChanges = new RemoteAudit(stateDir, { name: id => controllerName(id) });
  await remoteChanges.start();
  const remoteRouter = createRemoteRouter({ backend, exclusions, terminals: workspaceTerminals, audit: remoteChanges });
  const controllerLinks = identity && new ControllerLinks({ stateDir, identity, version: APP_VERSION, hostname, published: releasePublished });
  const nodeLinks = identity && new NodeLinks({ stateDir, identity, version: APP_VERSION, hostname,
    // What this computer can do for a controller depends on the worker it runs with right now; reporting on itself
    // and updating do not.
    features: () => [...runs.coordinators() ? ['read', 'workspace', ...(runs.supports('remoteOrigins') ? ['work'] : []), ...(runs.supports('remoteTriggers') ? ['triggers'] : [])] : [], 'status', ...updates.managed ? ['update'] : []],
    handle: (req, res, principal) => remoteRouter.handle(req, res, principal),
    update: {
      request: version => updates.request(version),
      report: async () => {
        const [update, free, terminalHost] = await Promise.all([updates.status(), diskFree(stateDir), workspaceTerminals.hostVersion().catch(() => undefined)]);
        const worker = runs.runnerVersion();
        return { versions: { web: APP_VERSION, ...(worker ? { worker } : {}), ...(terminalHost ? { terminalHost } : {}) }, service: updates.managed,
          ...(update ? { update } : {}), ...(free !== undefined ? { diskFree: free } : {}) };
      },
    } });
  if (nodeLinks) {
    nodeLinks.on('disconnected', (controllerId: string) => remoteRouter.disconnect(controllerId));
    controlledBy = () => nodeLinks.list().filter(item => item.status === 'connected').map(item => item.name);
    nodeLinks.on('change', changed);
    controllerName = id => nodeLinks.list().find(item => item.id === id)?.name;
    nodeLinks.on('paired', (controllerId: string) => { remoteChanges.record({ controllerId, action: 'joined' }); changed(); });
    // Asked again while the same update is under way, it is the same update.
    nodeLinks.on('update', (controllerId: string, update: { version: string; startedAt: string }) => remoteChanges.record({ controllerId, action: 'update', detail: update.version }, `update:${update.startedAt}`));
    // Only while that computer still controls this one.
    controllerJoined = () => {
      const joined = remoteChanges.lastJoin();
      const controller = joined && nodeLinks.list().find(item => item.id === joined.controllerId);
      return joined && controller?.state === 'paired' ? { name: controller.name, at: joined.at } : undefined;
    };
  }
  const nodeViews = new NodeViewStore(stateDir);
  await nodeViews.start().catch(error => console.error(`Remote folder views were not loaded: ${error instanceof Error ? error.message : String(error)}`));
  if (controllerLinks) {
    remoteNodes = new RemoteNodes(controllerLinks, nodeViews);
    remoteNodes.on('summary', changed);
  }
  const { server, dispose } = createMonitorServer({ port, clientDir, backend, nodes: remoteNodes,
    auth, exclusions, links: identity && controllerLinks && nodeLinks ? { identity, hostname, controller: controllerLinks, node: nodeLinks, exclusions, changes: remoteChanges,
      sessionNames: () => new Map(runs.sessionList().map(session => { const titled = titles.apply(session); return [session.id, titled.customTitle || titled.title]; })) } : { error: linkError },
    workspaceTerminals, remote: access.remote ? { origins: access.origins } : undefined });
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
  // Versions an update left behind go once neither the worker nor the terminal host runs them.
  // A version is in use while the worker or terminal host runs it; when either cannot be asked, nothing is removed.
  const prune = async () => {
    const worker = runs.runnerVersion();
    if (!worker || worker === 'legacy') return;
    await updates.prune(async () => [worker, await workspaceTerminals.hostVersion()]);
  };
  const pruneLater = () => { void prune().catch(error => console.error(`Old versions were not removed: ${error instanceof Error ? error.message : String(error)}`)); };
  const pruning = [setTimeout(pruneLater, 60_000), setInterval(pruneLater, 60 * 60_000)];
  for (const timer of pruning) timer.unref();
  capabilities.start();
  repositories.start();
  // Links come up after the web server, so a joining computer never reaches a half-started Tower.
  await Promise.all([controllerLinks?.start(), nodeLinks?.start()]).catch(error => console.error(`Remote computers are unavailable: ${error instanceof Error ? error.message : String(error)}`));
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    for (const timer of pruning) clearTimeout(timer);
    remoteNodes?.close();
    const stoppingLinks = Promise.all([nodeLinks?.close(), controllerLinks?.close()]).then(() => { remoteRouter.dispose(); return nodeViews.flush(); });
    const stoppingCapabilities = capabilities.stop();
    const stoppingRepositories = repositories.stop();
    history.stop();
    auth.close();
    dispose();
    server.closeAllConnections();
    server.close();
    try { await finishCleanup([auth.flush(), stoppingLinks, stoppingCapabilities, stoppingRepositories, titles.flush(), dismissedRuns.flush(), closedSessions.flush(), groups.flush(), exclusions.flush(), remoteChanges.flush(), runs.close()]); } finally { await releaseLock(); }
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
