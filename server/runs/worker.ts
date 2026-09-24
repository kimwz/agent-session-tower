import { finishedAutomationSessionIds } from '../../shared/automation-sessions.js';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import type { AutoPromptRequest, CreateSessionRequest, MessageAttachments, RunApprovalResponse, Snapshot } from '../../shared/types.js';
import { APP_VERSION } from '../../shared/app-identity.js';
import { AutoPromptManager } from '../auto-prompt/manager.js';
import { SlackService } from '../slack/service.js';
import { acquireStateLock, lockedPorts, MonitorAlreadyRunning } from '../instance/state-lock.js';
import { getProviderHealth } from '../providers/discovery.js';
import { trustWorkspace } from '../providers/workspace-trust.js';
import { SessionService } from '../sessions/service.js';
import { projectSessionStates } from '../sessions/snapshot.js';
import { ClosedSessionStore } from '../stores/closed-sessions.js';
import { ProjectGroupStore } from '../stores/project-groups.js';
import { WorkspaceTerminals } from '../workspace-terminals.js';
import { SessionTitleStore } from '../stores/session-titles.js';
import { openCodexBridgeRun } from './codex-bridge.js';
import { RunManager, type RunAdmission } from './manager.js';
import { parseRunOrigin } from './origin.js';
import { parseSuccessor, spawnSuccessor, writeHandoff, type SuccessorCommand } from './handoff.js';
import { REMOTE_FOLDER_REFUSED, TriggerService } from '../triggers/service.js';
import { GitHubCoordinator } from '../triggers/github-coordinator.js';
import { TowerApi } from '../api/tower-api.js';
import { CapabilityRegistry, handleMcpRequest } from '../api/mcp.js';
import { runToolResolver } from '../api/run-tools.js';
import { RemoteExclusionStore } from '../remote/exclusions.js';
import { remoteTriggerLaunch } from '../remote/visibility.js';
import { RemoteRequestLedger, type RemoteResult } from '../remote/request-ledger.js';
import { MAX_RPC_BYTES, RUNNER_CAPABILITIES, RUNNER_PROTOCOL, runnerPaths, type RunnerReply, type RunnerSnapshot, type SessionHistoryPage } from './runner-protocol.js';

const SNAPSHOT_FREE_OPERATIONS = new Set(['terminalInput', 'terminalResize', 'terminalCreate', 'terminalClose', 'attachment', 'sessionHistory']);

export interface RunnerHostOptions {
  stateDir: string;
  runs: RunManager;
  sessions: SessionService;
  autoPrompts?: AutoPromptManager;
  slack?: SlackService;
  /** Coordinator conversations for GitHub issue events. */
  github?: GitHubCoordinator;
  triggers?: TriggerService;
  api?: TowerApi;
  terminals?: WorkspaceTerminals;
  idleMs?: number;
  onIdle?: () => void | Promise<void>;
  /** Startup owns this lock before loading any engine state. */
  releaseStateLock?: () => Promise<void>;
  /** Work accepted outside runs, such as a Slack mention being processed, that must finish before a handoff. */
  inFlight?: () => boolean;
  /** Stops automatic intake from starting new work when a handoff has waited too long for a quiet moment. */
  holdIntake?: () => void;
  /** Pauses automatic intake and saves pending writes at a quiet moment. Nothing is cancelled or closed. */
  quiesce?: () => Promise<void>;
  /** Undoes quiesce when the handoff cannot be recorded, so the worker stays fully in service. */
  resume?: () => void;
  startSuccessor?: (command: SuccessorCommand, nonce: string) => void;
  onHandedOff?: () => void;
  handoffHoldMs?: number;
  /** The proof a predecessor gave this worker when it started it. */
  handoffNonce?: string;
  capabilities?: CapabilityRegistry;
  /** Makes a remote controller's retried request run once. */
  ledger?: RemoteRequestLedger;
  /** The remote-sharing exclusion list the web process saves; reloaded with every refresh. */
  exclusions?: RemoteExclusionStore;
}

/** Only these read state; every other request is refused while the worker hands off, never half-accepted. */
const READS_DURING_HANDOFF = new Set(['snapshot', 'sessionHistory', 'attachment', 'slackOverview']);

/** Hosts an already-started engine, including one adopted during an in-place upgrade. */
export async function startRunnerHost(options: RunnerHostOptions) {
  const capabilities = options.capabilities ?? new CapabilityRegistry();
  options.runs.setRunToolResolver(runToolResolver({ stateDir: options.stateDir, runs: options.runs, slack: options.slack, github: options.github, capabilities }));
  const paths = await runnerPaths(options.stateDir);
  const release = options.releaseStateLock ?? await acquireStateLock(paths.runtime, 0);
  let context: Awaited<ReturnType<typeof runnerContext>> | undefined;
  try {
    if (options.autoPrompts) { context = await runnerContext(options); options.autoPrompts.updateContext(context); }
  } catch (error) { await release(); throw error; }
  const instance = randomUUID();
  const token = randomBytes(32).toString('hex');
  let revision = 1;
  let lastRequest = Date.now();
  let pending = 0;
  let closing = false;
  let handoff: { successor: SuccessorCommand; requestedAt: number; held?: boolean; retryAt?: number } | undefined;
  let draining = false;
  const changed = () => { revision++; };
  const snapshot = (): RunnerSnapshot => {
    const sessions = options.runs.sessionList(options.sessions.list());
    return { instance, revision: ++revision, runs: options.runs.list(), sessions,
      nativeIds: Object.fromEntries(sessions.map(session => [session.id, options.runs.nativeSessionId(session.id)])),
      settled: [...options.runs.settledRunIds()], autoPrompts: options.autoPrompts?.list() ?? [], version: APP_VERSION,
      capabilities: [...RUNNER_CAPABILITIES], ...(options.handoffNonce ? { handoff: options.handoffNonce } : {}),
      ...(options.triggers ? { triggers: options.triggers.overview() } : {}),
      coordinators: [...new Set([...(options.slack?.coordinatorSessionIds() ?? []), ...(options.github?.coordinatorSessionIds() ?? [])])] };
  };
  const coordinator = (sessionId: string) => Boolean(options.slack?.coordinatorSessionIds().includes(sessionId) || options.github?.sessionWorkflow(sessionId));
  /** A paired controller's request: refused for coordinator conversations, and run once per request ID. */
  const remote = <T>(admitted: RunAdmission, operation: string, content: unknown, sessionId: string | undefined, execute: () => Promise<T>,
    record: (value: T) => RemoteResult, replay: (result: RemoteResult) => T | undefined): Promise<T> => {
    const controllerId = admitted.origin?.controllerId;
    if (!controllerId) return execute();
    if (sessionId && coordinator(options.runs.getSession(sessionId)?.id ?? sessionId)) throw Object.assign(new Error('Not found.'), { statusCode: 404 });
    if (!options.ledger || !admitted.requestId) throw Object.assign(new Error('원격 요청에는 요청 ID가 필요합니다.'), { statusCode: 400 });
    return options.ledger.once(controllerId, operation, admitted.requestId, content, execute, record, replay);
  };
  const findRun = (id: string) => options.runs.list().find(run => run.id === id);
  // Explicit dispatch prevents access to prototype methods or lifecycle controls.
  const dispatch = async (method: string, args: unknown[]) => {
    if (draining && !READS_DURING_HANDOFF.has(method)) {
      throw Object.assign(new Error('Tower is replacing its execution worker right now. Nothing was submitted; retry in a few seconds.'), { statusCode: 503, disposition: 'handoff' });
    }
    switch (method) {
      case 'snapshot': return undefined;
      case 'requestHandoff': {
        // The latest web build wins; the worker leaves only at a moment when nothing is running.
        handoff = { successor: parseSuccessor(args[0], paths.stateDir), requestedAt: handoff?.requestedAt ?? Date.now(), held: handoff?.held, retryAt: handoff?.retryAt };
        return { accepted: true };
      }
      case 'create': {
        const admitted = admission(args[1]);
        return remote(admitted, 'create', args[0], undefined, () => options.runs.create(args[0] as CreateSessionRequest, admitted),
          value => ({ kind: 'session', sessionId: value.session.id, runId: value.run.id }),
          result => {
            if (result.kind !== 'session') return undefined;
            const session = options.runs.getSession(result.sessionId), run = findRun(result.runId);
            return session && run ? { session, run } : undefined;
          });
      }
      case 'enqueue': {
        const admitted = admission(args[3]);
        if (admitted.origin?.controllerId) {
          return remote(admitted, 'enqueue', [args[0], args[1], args[2]], args[0] as string, () => options.runs.enqueue(args[0] as string, args[1] as string, args[2] as MessageAttachments, admitted),
            value => ({ kind: 'run', runId: value.id }), result => result.kind === 'run' ? findRun(result.runId) : undefined);
        }
        // Only the owner's own message may carry Slack send approval; the origin decides, never a correlation ID.
        let prompt = options.slack && admitted.origin?.kind === 'owner'
          ? await options.slack.ownerChat(args[0] as string, args[1] as string) : args[1] as string;
        // The same holds in a GitHub coordinator conversation: only the owner's message can approve a comment.
        if (options.github && admitted.origin?.kind === 'owner') prompt = await options.github.ownerChat(args[0] as string, prompt);
        return options.runs.enqueue(args[0] as string, prompt, args[2] as MessageAttachments, admitted);
      }
      case 'steer': return options.runs.steer(args[0] as string);
      case 'cancel': return options.runs.cancel(args[0] as string);
      case 'respondToApproval': return options.runs.respondToApproval(args[0] as string, args[1] as string, args[2] as RunApprovalResponse);
      case 'sessionHistory': return sessionHistory(options.sessions, args);
      case 'attachment': {
        const attachment = await options.runs.attachment(args[0] as string);
        return { metadata: attachment.metadata, content: attachment.content.toString('base64'), sessionId: attachment.sessionId };
      }
      case 'terminalCreate': if (options.terminals) return options.terminals.create(args[0] as string, args[1], args[2]); break;
      case 'terminalInput': if (options.terminals) return options.terminals.input(args[0] as string, args[1]); break;
      case 'terminalResize': if (options.terminals) return options.terminals.resize(args[0] as string, args[1], args[2]); break;
      case 'terminalClose': if (options.terminals) return options.terminals.close(args[0] as string); break;
      case 'submitAutoPrompt': if (options.autoPrompts) {
        const admitted = admission(args[1]);
        const autoPrompts = options.autoPrompts;
        const request = args[0] as AutoPromptRequest;
        return remote(admitted, 'autoPrompt', request, undefined, async () => { await context?.refresh(); return autoPrompts.submit(request, { origin: admitted.origin }); },
          value => ({ kind: 'autoPrompt', jobId: value.id }), result => result.kind === 'autoPrompt' ? autoPrompts.get(result.jobId) : undefined);
      } break;
      case 'cancelAutoPrompt': if (options.autoPrompts) return options.autoPrompts.cancel(args[0] as string); break;
      case 'slackOverview': if (options.slack) return options.slack.overview(); break;
      case 'slackMutate': if (options.slack) {
        // Read before the change so a disconnect is still recorded under the account it removed.
        const before = options.slack.projection();
        const result = await options.slack.mutate(args[0] as string, args[1] as Record<string, unknown>);
        const projection = options.slack.projection() ?? before;
        if (projection && ['settings', 'rules', 'connect', 'disconnect'].includes(args[0] as string)) await options.triggers?.recordSlack({ kind: 'owner', via: 'ui' }, projection.id, `Slack ${args[0] as string} changed`);
        return result;
      } break;
      case 'api': if (options.api) {
        // The owner here, or the owner at a controlling computer: then it sees and changes only what is shared.
        const admitted = args[2] === undefined ? undefined : admission(args[2]);
        const controllerId = admitted?.origin?.controllerId;
        return options.api.call(args[0], args[1], controllerId ? { kind: 'owner', via: 'remote', controllerId } : { kind: 'owner', via: 'ui' }, admitted?.requestId);
      } break;
      case 'slackTool': if (options.slack) return options.slack.tool(args[0] as string, args[1] as string, args[2] as Record<string, unknown>); break;
    }
    throw Object.assign(new Error('Unknown runner operation.'), { statusCode: 400 });
  };
  const mcp = { api: options.api, capabilities, slackTool: options.slack ? (workflowId: string, name: string, args: Record<string, unknown>) => options.slack!.tool(workflowId, name, args) : undefined,
    githubTool: options.github ? (workflowId: string, name: string, args: Record<string, unknown>) => options.github!.tool(workflowId, name, args) : undefined,
    run: (runId: string) => options.runs.list().find(run => run.id === runId) };
  const server = createServer(async (req, res) => {
    // Tool servers attached to provider turns hold a capability, not the worker credential; it opens only /mcp.
    const capability = req.headers.authorization?.match(/^Capability ([a-f\d]{64})$/)?.[1];
    if (capability) {
      if (closing || draining || req.method !== 'POST' || req.url !== '/mcp') { res.writeHead(closing || draining ? 503 : 404); res.end(); return; }
      pending++; lastRequest = Date.now();
      let reply: { result?: unknown; error?: { message: string } };
      try {
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 1_000_000) throw new Error('Tool request too large.'); chunks.push(chunk); }
        reply = { result: await handleMcpRequest(mcp, capability, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) ?? null };
      } catch (error) { reply = { error: { message: error instanceof Error ? error.message : 'Tool failed.' } }; }
      finally { pending--; }
      if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply)); }
      return;
    }
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (closing || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(403); res.end(); return;
    }
    const terminalMatch = req.url?.match(/^\/terminals\/([0-9a-f-]{36})\/events$/);
    if (req.method === 'GET' && terminalMatch && options.terminals && req.headers['x-runner-instance'] === instance) {
      const cursor = req.headers['last-event-id'];
      try {
        if (Array.isArray(cursor)) throw Object.assign(new Error('Invalid terminal cursor.'), { statusCode: 400 });
        options.terminals.attach(terminalMatch[1], res, cursor);
      } catch (error) { res.writeHead((error as { statusCode?: number }).statusCode || 500); res.end(); }
      return;
    }
    if (req.method !== 'POST' || req.url !== '/rpc') { res.writeHead(404); res.end(); return; }
    lastRequest = Date.now(); pending++;
    const reply: RunnerReply = { protocol: RUNNER_PROTOCOL, stateDir: paths.stateDir, instance };
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_RPC_BYTES) throw Object.assign(new Error('Runner request too large.'), { statusCode: 413 });
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { protocol?: number; method?: string; args?: unknown[]; instance?: string; revision?: number };
      if (input.protocol !== RUNNER_PROTOCOL || typeof input.method !== 'string' || !Array.isArray(input.args) || (input.instance && input.instance !== instance)) {
        throw Object.assign(new Error('Incompatible runner request.'), { statusCode: 409 });
      }
      reply.result = await dispatch(input.method, input.args);
      // Keystrokes, resizes and attachment downloads do not change run state.
      // Keep their replies small; the regular snapshot poll publishes engine changes.
      if (input.method !== 'slackTool' && (input.instance !== instance || (input.method === 'snapshot' ? input.revision !== revision : !SNAPSHOT_FREE_OPERATIONS.has(input.method)))) reply.snapshot = snapshot();
    } catch (error) {
      const value = error as { message?: string; statusCode?: number; disposition?: string };
      reply.error = { message: value.message ?? 'Runner operation failed.', statusCode: value.statusCode ?? 500, ...(value.disposition ? { disposition: value.disposition } : {}) };
      reply.snapshot = snapshot();
    } finally { pending--; }
    if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply)); }
  });
  server.requestTimeout = 65_000;
  options.runs.on('change', changed);
  options.sessions.on('change', changed);
  options.autoPrompts?.on('change', changed);
  options.triggers?.on('change', changed);
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  let handoffTimer: ReturnType<typeof setInterval> | undefined;
  // Status alone is not enough: a cancelled turn may still be closing its provider process.
  const quiet = () => !pending && !options.runs.busy() && !options.autoPrompts?.busy()
    // A continuation scheduled for later is saved and delivered by the successor.
    && !options.runs.hasWorkWithin(5 * 60 * 1000)
    && !options.autoPrompts?.list().some(job => !['completed', 'error', 'cancelled'].includes(job.status))
    && !options.terminals?.hasActive()
    && !options.inFlight?.();
  const handOff = async () => {
    if (!handoff || closing || draining || (handoff.retryAt && Date.now() < handoff.retryAt)) return;
    if (!handoff.held && Date.now() - handoff.requestedAt >= (options.handoffHoldMs ?? 6 * 60 * 60 * 1000)) { handoff.held = true; options.holdIntake?.(); }
    if (!quiet()) return;
    // Refuse new admissions first, then confirm nothing slipped in before this synchronous point.
    draining = true;
    if (!quiet()) { draining = false; return; }
    const successor = handoff.successor;
    const nonce = randomBytes(16).toString('hex');
    let quiesced = false;
    try {
      // Mark first: a quiesce that fails halfway has still paused something and must be undone.
      quiesced = true;
      await options.quiesce?.();
      // Work that slipped in while writes were saved keeps this worker in service.
      if (!quiet()) throw new Error('Work started while the worker was pausing.');
      await writeHandoff(paths.runtime, { previous: instance, successor: nonce, version: APP_VERSION, clean: true, at: new Date().toISOString() });
    } catch (error) {
      if (quiesced) options.resume?.();
      draining = false;
      if (!(error instanceof Error && error.message.startsWith('Work started'))) {
        // A handoff that cannot be recorded is retried later, not every second, so intake is not paused repeatedly.
        handoff.retryAt = Date.now() + 60_000;
        console.error('Execution worker handoff failed; staying in service:', error);
      }
      return;
    }
    // Socket and credential are removed while this worker still holds the lock, so a successor's are never touched.
    await close();
    (options.startSuccessor ?? spawnSuccessor)(successor, nonce);
    options.onHandedOff?.();
  };
  const close = async (idle = false) => {
    if (closing) return;
    closing = true;
    if (idleTimer) clearInterval(idleTimer);
    if (handoffTimer) clearInterval(handoffTimer);
    options.runs.off('change', changed); options.sessions.off('change', changed); options.autoPrompts?.off('change', changed); options.triggers?.off('change', changed);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await unlink(paths.socket).catch(() => {});
    await unlink(paths.token).catch(() => {});
    try { if (idle) await options.onIdle?.(); } finally { await release(); }
  };
  try {
    await unlink(paths.socket).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    await unlink(paths.token).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    await writeFile(paths.token, token, { flag: 'wx', mode: 0o600 });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(paths.socket, () => { server.off('error', reject); resolve(); }); });
    await chmod(paths.socket, 0o600);
    handoffTimer = setInterval(() => { void handOff(); }, 1000);
    handoffTimer.unref();
    if (options.onIdle) {
      idleTimer = setInterval(() => {
        if (closing || pending || Date.now() - lastRequest < (options.idleMs ?? 30_000)) return;
        if (options.runs.list().some(run => run.status === 'running' || run.status === 'queued')) return;
        if (options.autoPrompts?.list().some(job => !['completed', 'error', 'cancelled'].includes(job.status))) return;
        if (options.terminals?.hasActive()) return;
        if (options.slack?.hasActive()) return;
        if (options.github?.hasPending() || options.github?.inFlight()) return;
        if (options.triggers?.hasActive() || options.triggers?.inFlight()) return;
        // Stop accepting requests and finish writes before releasing the worker lock.
        void close(true).catch(error => { console.error('Runner idle cleanup failed:', error); });
      }, 1000);
      idleTimer.unref();
    }
    return { instance, socketPath: paths.socket, close };
  } catch (error) { await close(); throw error; }
}

/** Only the page fields leave the worker; the native file path stays private. */
async function sessionHistory(sessions: SessionService, [nativeId, before, limit]: unknown[]): Promise<SessionHistoryPage | undefined> {
  if (typeof nativeId !== 'string' || !nativeId || nativeId.length > 512) throw Object.assign(new Error('Invalid session history request.'), { statusCode: 400 });
  const page = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const history = await sessions.detail(nativeId, page(before), page(limit));
  if (!history) return undefined;
  return { messages: history.messages, hasMore: history.hasMore, ...(history.nextBefore !== undefined ? { nextBefore: history.nextBefore } : {}), ...(history.previousUser ? { previousUser: history.previousUser } : {}) };
}

/**
 * The web connection is the only RPC caller. It admits the owner's own requests, or work an owner
 * turn's agent asked for. Trigger and Slack origins are assigned inside the worker, never over RPC.
 */
function admission(value: unknown): RunAdmission {
  const input = value && typeof value === 'object' ? value as { autoPromptId?: string; origin?: unknown; requestId?: unknown } : {};
  const origin = input.origin === undefined ? { kind: 'owner' as const } : parseRunOrigin(input.origin);
  if (!origin || (origin.kind !== 'owner' && origin.kind !== 'agent')) throw Object.assign(new Error('The web connection can only admit owner or agent work.'), { statusCode: 400 });
  if (input.requestId !== undefined && (typeof input.requestId !== 'string' || !/^[a-f\d-]{36}$/i.test(input.requestId))) throw Object.assign(new Error('Invalid request ID.'), { statusCode: 400 });
  return { ...(input.autoPromptId !== undefined ? { autoPromptId: input.autoPromptId } : {}), origin, ...(typeof input.requestId === 'string' ? { requestId: input.requestId.toLowerCase() } : {}) };
}



async function runnerContext({ stateDir, runs, sessions, slack, exclusions }: Pick<RunnerHostOptions, 'stateDir' | 'runs' | 'sessions' | 'slack' | 'exclusions'>) {
  let titles = new SessionTitleStore(stateDir);
  let closed = new ClosedSessionStore(stateDir);
  let groups = new ProjectGroupStore(stateDir);
  const metadata = async () => {
    const nextTitles = new SessionTitleStore(stateDir), nextClosed = new ClosedSessionStore(stateDir), nextGroups = new ProjectGroupStore(stateDir);
    await Promise.all([nextTitles.start(), nextClosed.start(), nextGroups.start()]);
    titles = nextTitles; closed = nextClosed; groups = nextGroups;
  };
  await metadata();
  const providers = await getProviderHealth();
  const visibleSessions = () => {
    const projected = projectSessionStates(runs.sessionList(sessions.list()), runs.list(), runs.settledRunIds());
    const finished = finishedAutomationSessionIds(slack?.automation.list() ?? [], projected, runs.list());
    return projected.filter(session => !finished.has(session.id) && !slack?.coordinatorSessionIds().includes(session.id)).map(session => closed.apply(titles.apply(session)));
  };
  const snapshot = (): Snapshot => ({ sessions: visibleSessions(),
    runs: runs.list(), groups: groups.list(), providers, scanning: false, hostname: hostname(), version: APP_VERSION, updatedAt: new Date().toISOString() });
  return { snapshot,
    refresh: async () => { await Promise.all([sessions.refresh(true), metadata(), exclusions?.reload()]); },
    detail: async (id: string) => { const session = runs.getSession(id); if (!session) return undefined; const history = await sessions.detail(runs.nativeSessionId(id)); return { ...(history ?? { messages: [], hasMore: false }), session: closed.apply(titles.apply(session)) }; },
  };
}

export async function runRunnerWorker(stateDir: string): Promise<void> {
  const paths = await runnerPaths(stateDir);
  let release: () => Promise<void>;
  try { release = await acquireStateLock(paths.runtime, 0); }
  catch (error) { if (error instanceof MonitorAlreadyRunning) return; throw error; }
  const sessions = new SessionService();
  const terminals = new WorkspaceTerminals({ keepAliveOnDisconnect: true });
  const runs = new RunManager({ stateDir, getSession: id => sessions.get(id), refreshSessions: () => sessions.refresh(true),
    openCodexBridge: options => openCodexBridgeRun({ ...options, codexHome: sessions.codexHome }), trustWorkspace });
  try {
    await sessions.start();
    await runs.start();
    // The web process saves the remote-sharing exclusion list; this copy follows it on every refresh.
    const exclusions = new RemoteExclusionStore(stateDir);
    await exclusions.start();
    const ledger = new RemoteRequestLedger(stateDir);
    await ledger.start();
    const context = await runnerContext({ stateDir, runs, sessions, exclusions });
    // Remote requests route without excluded folders and without any coordinator conversation, Slack or GitHub.
    let coordinators = (): ReadonlySet<string> => new Set();
    const autoPrompts = new AutoPromptManager({ stateDir, runs, remote: { prepare: (paths, options) => exclusions.prepare(paths, options), matcher: () => exclusions.matcher(), coordinators: () => coordinators() }, ...context });
    await autoPrompts.start();
    const slack = new SlackService({ stateDir, runs, autoPrompts, refresh: context.refresh });
    // GitHub coordinators use a trigger's credentials; the trigger engine starts right after.
    let triggerEngine: TriggerService | undefined;
    const github = new GitHubCoordinator({ stateDir, runs, autoPrompts, refresh: context.refresh, language: () => slack.language(),
      github: (triggerId, fresh) => { if (!triggerEngine) throw new Error('Triggers are still starting.'); return triggerEngine.githubClient(triggerId, fresh); } });
    coordinators = () => new Set([...slack.coordinatorSessionIds(), ...github.coordinatorSessionIds()]);
    const capabilities = new CapabilityRegistry(capability => capability.kind === 'slack-workflow' || capability.kind === 'github-workflow'
      || runs.list().some(run => run.id === capability.runId && (run.status === 'running' || run.status === 'queued')));
    runs.setRunToolResolver(runToolResolver({ stateDir, runs, slack, github, capabilities }));
    const visible = await runnerContext({ stateDir, runs, sessions, slack, exclusions });
    autoPrompts.updateContext(visible);
    await slack.start();
    // Sessions created before provenance existed are classified once from surviving ledger links.
    runs.setExternalLinkResolver(ids => { const linked = slack.linkedSessions().sessionIds; return ids.some(id => linked.has(id)); });
    runs.backfillSessionOrigins(slack.linkedSessions());
    // Read once: children of this worker must not inherit the proof.
    const handoffNonce = process.env.TOWER_HANDOFF && /^[a-f\d]{32}$/.test(process.env.TOWER_HANDOFF) ? process.env.TOWER_HANDOFF : undefined;
    delete process.env.TOWER_HANDOFF;
    // Ports seen once stay blocked, so a web restart never opens a moment when Tower can call itself.
    const towerPorts = new Set<number>();
    const ownPorts = async () => { for (const port of await lockedPorts(stateDir)) towerPorts.add(port); return [...towerPorts]; };
    const triggers = new TriggerService({ stateDir, slack: () => slack.projection(), ownPorts,
      // A trigger set up from a controlling computer checks the sharing list as it is when it runs.
      sharing: { check: async path => { await exclusions.reload(); return exclusions.excludesNow(path); }, now: path => exclusions.matcher().excludes(path) }, executor: {
      submitAutoPrompt: async (request, internal) => { await context.refresh(); return autoPrompts.submit(request, internal); },
      getAutoPrompt: id => autoPrompts.get(id),
      create: (input, internal) => runs.create(input, internal),
      enqueue: (id, prompt, request, internal) => runs.enqueue(id, prompt, request, internal),
      runs: () => runs.list(),
      session: id => runs.getSession(id),
      coordinate: event => github.coordinate(event),
      coordination: id => github.coordination(id),
    } });
    triggerEngine = triggers;
    await triggers.start();
    await github.start();
    // Slack and triggers share one limit on provider turns running at once.
    runs.setAutomationLimit(triggers.settings().maxConcurrentRuns);
    triggers.on('settings', (settings: { maxConcurrentRuns: number }) => runs.setAutomationLimit(settings.maxConcurrentRuns));
    // A run still waiting when its trigger is turned off or deleted never starts.
    // A coordinator conversation already under way continues, like an accepted Slack conversation; only its first turn waits on the trigger.
    const remoteLaunch = remoteTriggerLaunch(exclusions, runs);
    runs.setLaunchGate(run => {
      if (run.origin?.kind !== 'trigger' || !run.origin.triggerId) return undefined;
      if (!(run.origin.workflowId && run.autoPromptId !== run.origin.workflowId) && !triggers.launchAllowed(run.origin.triggerId, run.origin.eventId)) return 'The trigger was turned off before this run started, so it did not run.';
      // Once more as the provider is about to start: a trigger set up remotely never works in a folder kept from sharing.
      return remoteLaunch.refused(run) ? REMOTE_FOLDER_REFUSED : undefined;
    }, run => remoteLaunch.prepareRun(run));
    const api = new TowerApi({ stateDir, triggers, runs, github,
      remote: async paths => { await exclusions.reload(); await exclusions.prepare(paths, { fresh: true }); return { matcher: exclusions.matcher(), coordinators: coordinators() }; },
      projects: () => {
        const snapshot = visible.snapshot();
        const titles = new Map((snapshot.groups ?? []).map(group => [group.cwd, group]));
        const counts = new Map<string, number>();
        for (const session of snapshot.sessions) if (!session.isSubagent && !session.launchedByAgent && session.cwd) counts.set(session.cwd, (counts.get(session.cwd) ?? 0) + 1);
        for (const group of snapshot.groups ?? []) if (group.pinned && !counts.has(group.cwd)) counts.set(group.cwd, 0);
        return [...counts].map(([cwd, sessions]) => ({ cwd, title: titles.get(cwd)?.title || cwd.split('/').filter(Boolean).at(-1) || cwd, sessions, pinned: titles.get(cwd)?.pinned === true }))
          .sort((a, b) => b.sessions - a.sessions);
      },
      sessions: { list: () => visible.snapshot().sessions, read: async (id, limit) => runs.getSession(id) ? (await sessions.detail(runs.nativeSessionId(id), undefined, limit))?.messages ?? [] : undefined },
      autoPrompts: { submit: async (request, internal) => { await context.refresh(); return autoPrompts.submit(request, internal); }, get: id => autoPrompts.get(id) } });
    await startRunnerHost({ stateDir, sessions, runs, autoPrompts, terminals, slack, github, triggers, api, capabilities, ledger, exclusions, releaseStateLock: release, handoffNonce,
      onIdle: async () => { triggers.close(); await triggers.settle(); github.close(); slack.close(); sessions.stop(); terminals.dispose(); await autoPrompts.close(); await runs.close(); },
      inFlight: () => slack.hasInFlight() || triggers.inFlight() || github.inFlight(), holdIntake: () => { slack.holdNewWork(); triggers.hold(); github.hold(); },
      quiesce: async () => { slack.pause(); triggers.pause(); github.pause(); await Promise.all([slack.flush(), triggers.flush(), github.flush(), runs.flushState(), autoPrompts.flush(), ledger.flush()]); },
      resume: () => { slack.resume(); triggers.resume(); github.resume(); },
      // Nothing is running, so nothing is cancelled; the successor owns the state from here.
      onHandedOff: () => { triggers.close(); github.close(); slack.close(); sessions.stop(); setTimeout(() => process.exit(0), 2000); } });
    // A parent terminal or Tower shutdown must not interrupt provider work.
    process.on('SIGINT', () => {});
    process.on('SIGTERM', () => {});
  } catch (error) { sessions.stop(); await release(); throw error; }
}
