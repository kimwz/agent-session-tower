// First: Tower's processes never carry the identity of an agent turn that started them.
import './sessions/launch-env.js';
import { hostname, homedir } from 'node:os';
import { stat, truncate } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { isSea } from 'node:sea';
import { withoutMasterFolder } from './runs/subscription.js';
import { nativeHistory } from './sessions/native-history.js';
import { SessionTitleStore } from './stores/session-titles.js';
import { DismissedRunStore } from './stores/dismissed-runs.js';
import { ClosedSessionStore } from './stores/closed-sessions.js';
import { worktreeCleanupFor } from './worktrees/janitor.js';
import { ProjectGroupStore } from './stores/project-groups.js';
import { DurableRunManager } from './runs/durable-runner.js';
import { runRunnerWorker } from './runs/worker.js';
import { runTerminalHost } from './terminals/host.js';
import { TerminalHostClient } from './terminals/client.js';
import { runMasterHost } from './master/host.js';
import { startMasterMcp } from './master/mcp.js';
import { runMasterQuery } from './master/query-process.js';
import { MasterClient } from './master/client.js';
import { BackupService } from './backup/service.js';
import { masterRoutes } from './master/routes.js';
import { VoiceTurnEnd } from './master/voice-turn-end.js';
import type { WebCredentials } from './tower-tools/tower-client.js';
import { ownerMcpOverHttp, startOwnerMcp } from './owner-mcp/tools.js';
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
import type { SkillBundle, SkillDetail, SkillImportPlan, SkillOverview, SkillSummary } from '../shared/skills.js';
import { startSessionsMcp } from './api/session-tools.js';
import { overlapsRepository } from '../shared/repositories.js';
import { RemoteExclusionStore } from './remote/exclusions.js';
import { createRemoteRouter } from './remote/router.js';
import type { RequestContext } from './http/request-context.js';
import type { Backend } from './http/server.js';
import { loadLinkIdentity } from './link/identity.js';
import { ControllerLinks } from './link/controller.js';
import { NodeLinks } from './link/node.js';
import { runLinkCommand } from './link/cli.js';
import { runModelsCommand } from './models/cli.js';
import { RemoteNodes } from './link/nodes.js';
import { linkRequest } from './link/transport.js';
import { RemoteAudit } from './remote/audit.js';
import { NodeViewStore } from './link/views.js';
import { newerVersion, refreshService } from './link/service.js';
import { releasePackage, releasePublished } from './link/join-code.js';
import { SystemMonitor, systemSources } from './system/status.js';
import { diskFree, handoffHeld, heldWorkerEntry, managedByService, runUpdateHelper, serviceSteps, updateActive, Updates } from './link/update.js';
import { LatestReleases } from './updates/latest.js';
import { TowerAutoUpdate } from './updates/tower.js';
import { autoUpdateEnabled, publicToolUpdates, readToolUpdates, unlessUpdating } from './updates/tools.js';
import type { AutoUpdateStatus } from '../shared/link.js';
import type { ComponentVersions, Snapshot, ProviderHealth, Run } from '../shared/types.js';
import { defaultStateDir } from './state-dir.js';
import { PublicListener } from './public-agents/listener.js';
import { NotificationService } from './notifications/service.js';
import { judgeTurn } from './notifications/attention.js';
import { DecisionService } from './decisions/service.js';
import { SessionOutcomes } from './sessions/outcomes.js';
import { autoPromptSuggestionResponse } from './auto-prompt/suggestion.js';
import { insertIfItBelongs } from './runs/steer-timing.js';
import { APP_TITLE, APP_VERSION, STATE_DIR_NAME } from '../shared/app-identity.js';

/** Every request this web server admits comes from the owner's browser session. */
const OWNER = { kind: 'owner' } as const;

const HELP = `${APP_TITLE} ${APP_VERSION}

Usage: agent-session-tower [run] [options]

  run                  Start the local session monitor (default)
  doctor               Check local CLI availability
  join <code>          Let another Tower control this computer (the code comes from its Remote computers panel)
  service <action>     install | uninstall | status: keep Tower running in the background (macOS)
  models <command>     list | get <role> | args <role>: the models Tower's roles use (models --help)
  mcp                  Tower's tools over stdio for your own agents on this computer, with your rights
                       e.g. claude mcp add tower-local -- agent-session-tower mcp
  --port <number>      Listening port (default: 8000)
  --host <IPv4>        Bind address (default: 127.0.0.1; 0.0.0.0 for remote access)
  --public-url <url>   Also accept requests for this origin from a reverse proxy or tunnel (repeatable)
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
  if (args[0] === '--sessions-mcp') {
    if (args.length !== 2) throw new Error('The session tools require a state directory.');
    await startSessionsMcp(resolve(args[1]));
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
  if (args[0] === 'models') { await runModelsCommand(args.slice(1)); return; }
  if (args[0] === 'mcp') {
    if (!(args.length === 1 || (args.length === 3 && args[1] === '--state-dir' && args[2]))) throw new Error('Usage: agent-session-tower mcp [--state-dir <path>]');
    await startOwnerMcp(args.length === 3 ? resolve(args[2]) : defaultStateDir());
    process.exit(0);
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
  if (args[0] === '--master-query') {
    await runMasterQuery();
    return;
  }
  if (args[0] === '--master-mcp') {
    if (args.length !== 2 || !args[1]) throw new Error('The master tools require a state directory.');
    await startMasterMcp(resolve(args[1]));
    return;
  }
  if (args[0] === '--master-host') {
    if (args.length !== 2 || !args[1]) throw new Error('Master host requires a state directory.');
    await runMasterHost(resolve(args[1]));
    return;
  }
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return; }
  if (args.includes('--version')) { console.log(APP_VERSION); return; }
  let port = 8000;
  let host = '127.0.0.1';
  let open = true;
  let stateDir = defaultStateDir();
  let command = 'run';
  const publicUrls: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === 'run' || arg === 'doctor') command = arg;
    else if (arg === '--no-open') open = false;
    else if (arg === '--port') { if (!args[i + 1]) throw new Error('--port requires a number.'); port = Number(args[++i]); }
    else if (arg === '--host') { if (!args[i + 1]) throw new Error('--host requires an IPv4 address.'); host = args[++i]; }
    else if (arg === '--public-url') { if (!args[i + 1]) throw new Error('--public-url requires a URL.'); publicUrls.push(args[++i]); }
    else if (arg === '--state-dir') { if (!args[i + 1]) throw new Error('--state-dir requires a path.'); stateDir = resolve(args[++i]); }
    else throw new Error(`Unknown option: ${arg}. Run with --help for usage.`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
  const access = networkAccess(host, port, undefined, publicUrls);
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
      // Started as the service while a Tower started by hand holds the folder: it ends as a failure, so launchd or
      // systemd start it again later and it takes over once that Tower has stopped.
      if (serviceLog) { console.error(`Another Tower (pid ${error.owner.pid}) is using ${stateDir}; the service tries again shortly.`); process.exitCode = 75; return; }
      const url = await existingServerUrl(error, { bindHost: host, remoteAccess: access.remote, probeHosts: access.probeHosts });
      if (url) {
        console.log(`Agent Session Tower is already running.\n${url}`);
        printRemoteAccess(host, error.owner.port, stateDir, publicUrls);
        if (open) openBrowser(url);
        return;
      }
    }
    throw error;
  }
  const auth = new AuthStore(stateDir);
  try { await auth.start(); }
  catch (error) { auth.close(); await releaseLock(); throw error; }
  // Without a localhost listener, nobody could set the account this remote access needs.
  if (!auth.configured() && access.remote && !host.startsWith('127.') && host !== '0.0.0.0') {
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
  // Started as the background service, this version writes the service the way it runs it best, for its next start;
  // not while an update is being tried, since going back must find the service as it was.
  if (updates.managed) {
    const refresh = async (): Promise<boolean> => {
      if (updateActive(await updates.status())) return false;
      if (await refreshService(stateDir)) console.log('  The background service settings were updated for the next start.');
      return true;
    };
    const retry = setInterval(() => { void refresh().then(done => { if (done) clearInterval(retry); }, () => clearInterval(retry)); }, 60_000);
    retry.unref();
    void refresh().then(done => { if (done) clearInterval(retry); }, error => {
      clearInterval(retry);
      console.error(`The background service settings were not updated: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  await updates.recover().catch(error => console.error(`The last update could not be settled: ${error instanceof Error ? error.message : String(error)}`));
  // While an update is tried, the worker stays the previous version's, and one that is needed is started from it.
  const runs = new DurableRunManager({ stateDir, handoffHeld: () => handoffHeld(stateDir), heldWorkerEntry: () => heldWorkerEntry(stateDir) });
  // Load persisted history before shutdown or an HTTP request can touch the runner.
  try { await titles.start(); await dismissedRuns.start(); await closedSessions.start(); await groups.start(); await exclusions.start(); await runs.start(); } catch (error) { auth.close(); await releaseLock(); throw error; }
  /** Local browser requests are the owner's; a remote controller's carry its own origin and request ID. */
  // `authored` only keeps a 1.89/1.90 worker's permission reviewer working while an update waits for its handoff; newer workers ignore it.
  const forgetConversation = async (sessionId: string) => {
    const closedAt = new Date().toISOString();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try { await runs.api('permissions.forgetConversation', { sessionId, closedAt }); return; } catch (error) {
        if (error instanceof Error && /Unknown Tower operation/.test(error.message)) return;
        await new Promise(resolve => setTimeout(resolve, 15_000).unref());
      }
    }
  };
  const admit = (context?: RequestContext) => ({ origin: context?.origin ?? OWNER, ...(context?.callerCapability ? { callerCapability: context.callerCapability } : {}), ...(context?.requestId ? { requestId: context.requestId } : {}), ...(context?.origin ? {} : { authored: true }) });
  // The worker has indexed native sessions before it answers, so the session list is complete here.
  const history = nativeHistory(runs);
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of listeners) listener(); };
  let componentVersions: ComponentVersions | undefined;
  // CPU, memory and disk of this computer, for the rings on its host node.
  const system = new SystemMonitor(systemSources(stateDir), changed);
  // The Codex probe starts the CLI, so it never runs while this account's Codex is being updated.
  const capabilities = new ProviderCapabilities(providers, { health: getProviderHealth, onChange: changed, stateDir, unlessUpdating: (provider, read) => unlessUpdating(stateDir, provider, read) });
  // This Tower keeps itself current when it runs as the service; its worker keeps Claude Code and Codex current.
  let pairedControllers = (): number => 0;
  const latestReleases = new LatestReleases();
  const towerUpdates = new TowerAutoUpdate({ stateDir, version: APP_VERSION, enabled: autoUpdateEnabled(), updates, controllers: () => pairedControllers(), latest: () => latestReleases.latest(), onChange: changed });
  let toolUpdates: AutoUpdateStatus['tools'] = {};
  const readTools = async () => {
    const next = publicToolUpdates(await readToolUpdates(stateDir), true);
    if (JSON.stringify(next) !== JSON.stringify(toolUpdates)) { toolUpdates = next; changed(); }
  };
  // This computer's own page also gets the commands that make a Tower run by hand keep itself current and that
  // reinstall a broken CLI; controllers do not.
  const autoUpdate = (local = false): AutoUpdateStatus => {
    const tower = towerUpdates.status();
    const serviceCommand = local && tower.kind === 'unmanaged' && tower.latest && newerVersion(tower.latest, APP_VERSION)
      ? `npx --yes ${releasePackage(tower.latest)} service install --port ${port}${stateDir === defaultStateDir() ? '' : ` --state-dir '${stateDir.replace(/'/g, `'\\''`)}'`}` : undefined;
    return { enabled: autoUpdateEnabled(), tower: { ...tower, ...(serviceCommand ? { serviceCommand } : {}) }, tools: local ? toolUpdates : publicToolUpdates(toolUpdates) };
  };
  runs.on('change', changed);
  const repositories = new RepositoryMonitor({
    watched: () => watchedRepositoryPaths(runs.sessionList(), withoutMasterFolder(groups.list(), stateDir)),
    busy: status => runs.sessionList().some(session => session.status === 'working' && overlapsRepository(status, session.cwd))
      || runs.list().some(run => (run.status === 'running' || (run.status === 'queued' && !(run.scheduled && Date.parse(run.scheduled.at) > Date.now()))) && overlapsRepository(status, runs.getSession(run.sessionId)?.cwd ?? '')),
    onChange: changed,
  });
  let controlledBy = (): string[] => [];
  let controllerJoined = (): { name: string; at: string } | undefined => undefined;
  let remoteNodes: RemoteNodes | undefined;
  // Fast multiple-choice judgments (Jev, or whatever replaces it) for the web's own features; off without an API key.
  const decisions = new DecisionService(stateDir);
  await decisions.start().catch(error => console.error(`Fast judgment settings were not loaded: ${error instanceof Error ? error.message : String(error)}`));
  // Sessions as the page sees them, before the judged outcome of their last turn is added.
  const sessionViews = (all = runs.sessionList(), managed = runs.list()) => projectSessionStates(all, managed, runs.settledRunIds()).map(session => closedSessions.apply(titles.apply(session)));
  const outcomes = new SessionOutcomes({
    stateDir, engine: () => decisions.engine('sessionOutcomes'), sessions: () => sessionViews(),
    history: async session => (await history.read(runs.nativeSessionId(session.id), undefined, 60))?.messages,
    project: session => groups.list().find(group => group.cwd === session.cwd)?.title || session.project,
    title: session => session.customTitle || session.title,
    record: entry => decisions.record(entry), onChange: changed,
  });
  runs.on('change', () => outcomes.changed());
  const snapshot = (): Snapshot => {
    const all = runs.sessionList();
    const controllers = controlledBy();
    const joined = controllerJoined();
    const nodes = remoteNodes?.list() ?? [];
    const managed = runs.list();
    return {
      sessions: sessionViews(all, managed).map(session => outcomes.apply(session)),
      groups: withoutMasterFolder(groups.list(), stateDir),
      repositories: repositories.list(),
      providers: capabilities.list().map(provider => ({ ...provider, sessionCount: all.filter(session => session.provider === provider.provider && !session.master).length })),
      runs: dismissedRuns.visible(managed), autoPrompts: runs.autoPromptList(), scanning: history.indexing, hostname: hostname(), version: APP_VERSION,
      ...(runs.triggerOverview() ? { triggers: runs.triggerOverview() } : {}),
      ...(runs.runnerVersion() ? { runnerVersion: runs.runnerVersion() } : {}),
      ...(componentVersions ? { componentVersions } : {}),
      // Only an older worker is waiting to be replaced; a newer one left by an update that was undone stays as it is.
      ...(runs.runnerVersion() && (runs.runnerVersion() === 'legacy' || newerVersion(APP_VERSION, runs.runnerVersion()!)) ? { runnerUpdate: runs.supports('handoff') ? 'automatic' as const : 'manual' as const } : {}),
      ...(runs.runnerVersion() && runs.runnerVersion() !== 'legacy' && newerVersion(APP_VERSION, runs.runnerVersion()!) && runs.supports('forceUpdate') ? { runnerForceUpdate: true } : {}),
      ...(runs.updateDrain() ? { updateDrain: runs.updateDrain() } : {}),
      ...(controllers.length ? { controlledBy: controllers } : {}),
      ...(joined ? { controllerJoined: joined } : {}),
      ...(remoteNodes?.ready ? { nodes } : {}),
      autoUpdate: autoUpdate(true),
      ...(system.status() ? { system: system.status() } : {}),
      updatedAt: new Date().toISOString(),
    };
  };
  const detail = async (id: string, before?: number, limit?: number) => {
    const session = runs.getSession(id);
    if (!session) return undefined;
    const page = await history.read(runs.nativeSessionId(id), before, limit);
    // What became of the worktrees it made, once its work was over; the worker records it. Why one was kept only holds while
    // the conversation stays closed (or its automated work finished).
    let root = session;
    for (let depth = 0; depth < 20 && root.isSubagent && root.parentId; depth++) { const parent = runs.getSession(root.parentId); if (!parent) break; root = parent; }
    const over = closedSessions.closedIds().has(root.id) || Boolean(root.launchedBy);
    const worktrees = before === undefined ? (await worktreeCleanupFor(stateDir, [session.id]).catch(() => [])).filter(item => over || item.state === 'removed') : [];
    return { ...(page || { messages: [], hasMore: false }), session: closedSessions.apply(titles.apply(session)), ...(worktrees.length ? { worktrees } : {}) };
  };
  // A retried request returns the message it already queued; that message is judged once only.
  const judgedMessages = { ids: new Set<string>(), claim(id: string) {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    if (this.ids.size > 500) this.ids.delete(this.ids.values().next().value!);
    return true;
  } };
  // Push notifications are sent from here: the web process sees every run the worker reports.
  const notifications = new NotificationService(stateDir, {
    runs: () => runs.list(),
    session: id => { const found = runs.getSession(id); return found && titles.apply(found); },
    project: session => groups.list().find(group => group.cwd === session.cwd)?.title || session.project,
    trigger: id => runs.triggerOverview()?.triggers.find(item => item.id === id)?.name,
    attention: async (input, signal) => {
      const engine = decisions.engine('attentionNotifications');
      if (!engine) return undefined;
      const started = performance.now();
      const subject = input.conversation || input.request;
      try {
        const judged = await judgeTurn(engine, input, signal);
        decisions.record({ feature: 'attentionNotifications', subject, result: judged.quiet ? 'quiet' : 'notify', probabilities: judged.probabilities, ms: performance.now() - started });
        return judged;
      } catch (error) {
        decisions.record({ feature: 'attentionNotifications', subject, result: 'failed', probabilities: {}, detail: error instanceof Error ? error.message : String(error), ms: performance.now() - started });
        throw error;
      }
    },
  });
  runs.on('change', () => notifications.changed());
  // Visitor pages of public agents, on their own port bound to this computer only; a tunnel publishes them.
  const publicListener = new PublicListener({ stateDir, backend: runs, reservedPorts: () => [port] });
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
      // Its rules for this conversation go now. A worker busy handing off is asked again for a few minutes; one older
      // than 1.92 refuses at once, and its sweep catches the rest.
      if (closed) void forgetConversation(session.id);
      changed();
      return titles.apply(updated);
    },
    acknowledgeOutcome: async id => {
      const session = sessionViews().find(item => item.id === id);
      if (!session) return undefined;
      if (outcomes.acknowledge(session)) changed();
      return outcomes.apply(session);
    },
    createSession: async (input, context) => { await repositories.prepareRun(input.cwd); return runs.create(input, admit(context)); },
    startAutoPrompt: (input, context) => runs.submitAutoPrompt(input, admit(context)),
    getAutoPrompt: id => runs.getAutoPrompt(id),
    cancelAutoPrompt: id => runs.cancelAutoPrompt(id),
    slackOverview: () => runs.slackOverview(),
    api: (operation, input, context) => runs.api(operation, input, context && admit(context)),
    slackMutate: (action, body) => runs.slackMutate(action, body),
    publicAgents: {
      overview: async () => ({ ...await runs.publicAgentsOverview(), listener: publicListener.status() }),
      conversation: (agentId, conversationId) => runs.publicAgentsConversation(agentId, conversationId),
      mutate: async (action, body) => {
        // Where the pages are served belongs to this web process; everything else to the worker.
        if (action === 'listener') { await publicListener.configure(body); return { ...await runs.publicAgentsOverview().catch(() => ({ agents: [] })), listener: publicListener.status() }; }
        return { ...await runs.publicAgentsMutate(action, body), listener: publicListener.status() };
      },
    },
    skills: {
      overview: input => runs.skills('skillsOverview', [input]) as Promise<SkillOverview>,
      detail: input => runs.skills('skillsDetail', [input]) as Promise<SkillDetail>,
      summary: () => runs.skills('skillsSummary', []) as Promise<SkillSummary>,
      // The third value only lets a 1.89/1.90 worker keep its skill confirmations during an update; newer workers ignore it.
      mutate: (action, body) => runs.skills('skillsMutate', [action, body, true]) as Promise<SkillOverview>,
      exportBundle: body => runs.skills('skillsExport', [body]) as Promise<SkillBundle>,
      importPlan: bundle => runs.skills('skillsImportPlan', [bundle]) as Promise<SkillImportPlan>,
    },
    setGroup: async patch => { const group = await groups.set(patch); changed(); return group; },
    enqueue: async (id, prompt, attachments, context) => {
      const cwd = runs.getSession(id)?.cwd;
      if (cwd) await repositories.prepareRun(cwd);
      const run = await runs.enqueue(id, prompt, attachments, admit(context));
      // A message sent from this computer's page while the conversation works may belong to that work; the answer does
      // not wait for the judgment. Requests from a controlling computer (with `context`) are left as they are.
      if (!context?.origin) void insertIfItBelongs({ engine: () => decisions.engine('steerTiming'), canTarget: () => runs.supports('steerTargets'), runs: () => runs.list(),
        steer: (runId, targetRunId) => runs.steer(runId, { targetRunId }), record: entry => decisions.record(entry), claim: runId => judgedMessages.claim(runId) }, run).catch(() => {});
      return run;
    },
    repositoryAction: (cwd, action) => repositories.act(cwd, action),
    attachment: id => runs.attachment(id), cancel: id => runs.cancel(id), steerRun: (id, options) => runs.steer(id, options),
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
    features: () => [...runs.coordinators() ? ['read', 'workspace', ...(runs.supports('remoteOrigins') ? ['work'] : []), ...(runs.supports('remoteTriggers') ? ['triggers'] : []), ...(runs.supports('models') ? ['models'] : [])] : [], 'status', ...updates.managed ? ['update'] : []],
    handle: (req, res, principal) => remoteRouter.handle(req, res, principal),
    update: {
      request: version => updates.request(version),
      report: async () => {
        const [update, free, terminalHost] = await Promise.all([updates.status(), diskFree(stateDir), workspaceTerminals.hostVersion().catch(() => undefined)]);
        const worker = runs.runnerVersion();
        return { versions: { web: APP_VERSION, ...(worker ? { worker } : {}), ...(terminalHost ? { terminalHost } : {}) }, service: updates.managed,
          ...(update ? { update } : {}), ...(free !== undefined ? { diskFree: free } : {}), autoUpdate: autoUpdate() };
      },
    } });
  if (nodeLinks) {
    nodeLinks.on('disconnected', (controllerId: string) => remoteRouter.disconnect(controllerId));
    controlledBy = () => nodeLinks.list().filter(item => item.status === 'connected').map(item => item.name);
    nodeLinks.on('change', changed);
    controllerName = id => nodeLinks.list().find(item => item.id === id)?.name;
    pairedControllers = () => nodeLinks.list().filter(item => item.state === 'paired').length;
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
  // The master agent runs in its own process; this web only starts it, tells it how to reach this API, and relays.
  let webCredentials: WebCredentials | undefined;
  const localMcp = ownerMcpOverHttp(stateDir, () => webCredentials?.port);
  const masterCallerSecret = randomBytes(32).toString('hex');
  const master = new MasterClient({ stateDir, credentials: () => webCredentials });
  // Full backups: the worker gives its skills; restores go through each process's own stores (see BackupService.apply).
  const backups = new BackupService({ stateDir, version: APP_VERSION, skills: () => runs.skillsBackup(), restartWorker: () => runs.restartWorker(),
    unavailable: () => runs.supports('backup') ? undefined : '실행 워커가 아직 새 버전으로 바뀌지 않아 백업을 만들 수 없습니다. 진행 중인 작업이 끝나 워커가 바뀌면 쓸 수 있습니다.',
    stores: { groups, exclusions, decisions }, master: body => master.call('settings', { body }), onChange: () => changed() });
  await backups.start();
  // The terminal and master hosts keep their own code until they restart; what they run is looked at every half
  // minute, never starting one and never keeping one alive (the master host does not count pings as use; the terminal
  // host is asked once per run of it), so the page can show every version Tower runs here.
  // A process that could not be asked is left out (unknown), never shown as not running; one look at a time.
  let asking = false;
  const askComponents = async () => {
    if (asking) return;
    asking = true;
    try {
      const [terminalHost, masterHost] = await Promise.all([workspaceTerminals.displayVersion().catch(() => undefined), master.hostVersion().catch(() => undefined)]);
      const next: ComponentVersions = { ...(terminalHost !== undefined ? { terminalHost } : {}), ...(masterHost !== undefined ? { master: masterHost } : {}) };
      if (JSON.stringify(next) !== JSON.stringify(componentVersions)) { componentVersions = next; changed(); }
    } finally { asking = false; }
  };
  void askComponents();
  const componentTimer = setInterval(() => void askComponents(), 30_000);
  componentTimer.unref();
  // A message this page sends to a joined computer's conversation is judged here, as one sent to a conversation on
  // this computer would be, and inserted there into the turn it was judged against.
  const insertRemote = (nodeId: string, run: Run) => {
    const nodes = remoteNodes;
    if (!nodes || !identity) return;
    void insertIfItBelongs({ engine: () => decisions.engine('steerTiming'), canTarget: () => nodes.known(nodeId),
      runs: () => nodes.snapshot(nodeId)?.runs ?? [],
      steer: async (runId, targetRunId) => {
        const session = nodes.session(nodeId);
        if (!session) throw Object.assign(new Error('The joined computer is not connected.'), { disposition: 'rejected' });
        let answer: { status: number; json: unknown };
        try { answer = await linkRequest(session, 'POST', `/api/runs/${encodeURIComponent(runId)}/steer`, { targetRunId }, 30_000); }
        catch (error) { throw Object.assign(new Error(`The joined computer did not confirm the insert: ${error instanceof Error ? error.message : String(error)}`), { disposition: 'uncertain' }); }
        const body = (answer.json ?? {}) as { run?: Run; error?: string; disposition?: string };
        if (answer.status === 200 && body.run) return body.run;
        // A refusal (an older computer, a changed turn) leaves the message waiting; only a failure after it may have run is uncertain.
        throw Object.assign(new Error(body.error || `The joined computer answered ${answer.status}.`), { disposition: body.disposition === 'uncertain' || (answer.status >= 500 && answer.status !== 503) ? 'uncertain' : 'rejected' });
      },
      record: entry => decisions.record(entry), claim: runId => judgedMessages.claim(`${nodeId}:${runId}`), sentBy: identity.id }, run).catch(() => {});
  };
  const { server, dispose, token: pageToken } = createMonitorServer({ port, clientDir, backend, nodes: remoteNodes, onNodeMessage: insertRemote, master: { callerSecret: masterCallerSecret, handle: masterRoutes(master, { turnEnd: new VoiceTurnEnd({ engine: () => decisions.engine('voiceTurnEnd'),
      known: async session => await master.call('voiceKnown', { session }) === true, record: entry => decisions.record(entry) }) }) },
    auth, exclusions, links: identity && controllerLinks && nodeLinks ? { identity, hostname, controller: controllerLinks, node: nodeLinks, exclusions, changes: remoteChanges,
      sessionNames: () => new Map(runs.sessionList().map(session => { const titled = titles.apply(session); return [session.id, titled.customTitle || titled.title]; })) } : { error: linkError },
    workspaceTerminals, remote: access.remote ? { origins: access.origins } : undefined, service: updates.managed, notifications, backup: backups, localMcp,
    decisions: {
      overview: () => decisions.overview(),
      // Turning the key or the canvas outcomes on or off shows or hides them at once.
      update: async body => { const overview = await decisions.update(body); outcomes.changed(); changed(); return overview; },
      test: () => decisions.test(),
      suggestAutoPrompt: async (input, load, signal) => {
        const started = performance.now();
        const response = await autoPromptSuggestionResponse(decisions.engine('autoPromptSuggestions'), load, input, signal);
        if (response.available && !signal.aborted) {
          const found = response.suggestion;
          decisions.record({ feature: 'autoPromptSuggestions', subject: input.prompt.trim(), result: response.error ? 'failed' : found ? 'suggested' : 'noSuggestion',
            probabilities: found ? { project: found.projectConfidence, conversation: found.sessionConfidence } : {},
            ...(response.error ? { detail: response.error } : found ? { detail: `${found.project} › ${found.sessionTitle ?? 'new'}` } : {}), ms: performance.now() - started });
        }
        return response;
      },
    },
    forceRunnerUpdate: async () => {
      try { const answer = await runs.forceUpdate(); changed(); return { status: 202, body: answer }; }
      catch (error) { return { status: (error as { statusCode?: number }).statusCode ?? 500, body: { error: error instanceof Error ? error.message : 'The update could not start.' } }; }
    },
    towerUpdate: async version => {
      if (!updates.managed) return { status: 409, body: { code: 'not-service', error: 'This Tower does not run as the background service, so it cannot replace itself.' } };
      const answer = await towerUpdates.updateNow(version);
      changed();
      return answer;
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
  const listening = server.address();
  webCredentials = { port: listening && typeof listening === 'object' ? listening.port : port, token: pageToken, callerSecret: masterCallerSecret };
  master.start();
  console.log(`\n  Agent Session Tower\n  ${access.browserUrl}\n`);
  printRemoteAccess(host, port, stateDir, publicUrls);
  if (!auth.configured()) console.log(`  Remote account not configured. Open http://localhost:${port} and select Account management in the expanded navigation.\n`);
  console.log('  Reading local Claude Code and Codex sessions…\n  Press Ctrl+C to stop the web server. Agent work continues independently.\n');
  if (open) openBrowser(access.browserUrl);
  let closing = false;
  // Versions an update left behind go once neither the worker nor the terminal or master host runs them.
  // A version is in use while one of them runs it; when any cannot be asked, nothing is removed.
  const prune = async () => {
    const worker = runs.runnerVersion();
    if (!worker || worker === 'legacy') return;
    await updates.prune(async () => [worker, await workspaceTerminals.hostVersion(), await master.hostVersion()]);
  };
  const pruneLater = () => { void prune().catch(error => console.error(`Old versions were not removed: ${error instanceof Error ? error.message : String(error)}`)); };
  const pruning = [setTimeout(pruneLater, 60_000), setInterval(pruneLater, 60 * 60_000),
    // The worker writes how its CLI updates went; the page and controllers read it from here.
    setInterval(() => { void readTools().catch(() => {}); }, 30_000)];
  for (const timer of pruning) timer.unref();
  void readTools().catch(() => {});
  backups.schedule();
  void towerUpdates.start().catch(error => console.error(`Automatic updates are unavailable: ${error instanceof Error ? error.message : String(error)}`));
  capabilities.start();
  repositories.start();
  system.start();
  await outcomes.start();
  await notifications.start().catch(error => console.error(`Notifications are unavailable: ${error instanceof Error ? error.message : String(error)}`));
  await publicListener.start().catch(error => console.error(`Public agent pages are unavailable: ${error instanceof Error ? error.message : String(error)}`));
  if (publicListener.status().listening) console.log(`  Public agent pages: http://127.0.0.1:${publicListener.status().port}${publicListener.status().publicUrl ? ` (${publicListener.status().publicUrl})` : ''}\n`);
  // Links come up after the web server, so a joining computer never reaches a half-started Tower.
  await Promise.all([controllerLinks?.start(), nodeLinks?.start()]).catch(error => console.error(`Remote computers are unavailable: ${error instanceof Error ? error.message : String(error)}`));
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    for (const timer of pruning) clearTimeout(timer);
    system.close();
    towerUpdates.stop();
    backups.close();
    remoteNodes?.close();
    const stoppingLinks = Promise.all([nodeLinks?.close(), controllerLinks?.close()]).then(() => { remoteRouter.dispose(); return nodeViews.flush(); });
    const stoppingCapabilities = capabilities.stop();
    const stoppingRepositories = repositories.stop();
    const stoppingPublic = publicListener.close();
    history.stop();
    auth.close();
    // The master host keeps running; this web only lets go of it.
    master.dispose();
    localMcp.close();
    dispose();
    server.closeAllConnections();
    server.close();
    try { await finishCleanup([auth.flush(), stoppingLinks, stoppingPublic, stoppingCapabilities, stoppingRepositories, titles.flush(), dismissedRuns.flush(), closedSessions.flush(), groups.flush(), exclusions.flush(), remoteChanges.flush(), backups.flush(), notifications.close(), outcomes.close(), decisions.close(), runs.close()]); } finally { await releaseLock(); }
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

function printRemoteAccess(host: string, port: number, stateDir: string, publicUrls: string[]) {
  const access = networkAccess(host, port, undefined, publicUrls);
  if (!access.remote) return;
  const localhost = host.startsWith('127.') || host === '0.0.0.0';
  console.log(`  Remote URLs:\n${access.urls.map(url => `  ${url}`).join('\n')}\n  Remote login: account configured in local Account management\n  Account state: ${join(stateDir, 'auth.json')}\n  ${localhost ? 'Direct localhost access does not require login.' : 'For local account management, stop and restart with --host 127.0.0.1 using the same state directory.'}\n`);
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
