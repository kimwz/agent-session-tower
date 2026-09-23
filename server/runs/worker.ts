import { finishedAutomationSessionIds } from '../../shared/automation-sessions.js';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import type { AutoPromptRequest, CreateSessionRequest, MessageAttachments, RunApprovalResponse, Snapshot } from '../../shared/types.js';
import { APP_VERSION } from '../../shared/app-identity.js';
import { AutoPromptManager } from '../auto-prompt/manager.js';
import { SlackService } from '../slack/service.js';
import { acquireStateLock, MonitorAlreadyRunning } from '../instance/state-lock.js';
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
import { TriggerService } from '../triggers/service.js';
import { TowerApi } from '../api/tower-api.js';
import { CapabilityRegistry, handleMcpRequest } from '../api/mcp.js';
import { runToolResolver } from '../api/run-tools.js';
import { MAX_RPC_BYTES, RUNNER_CAPABILITIES, RUNNER_PROTOCOL, runnerPaths, type RunnerReply, type RunnerSnapshot, type SessionHistoryPage } from './runner-protocol.js';

const SNAPSHOT_FREE_OPERATIONS = new Set(['terminalInput', 'terminalResize', 'terminalCreate', 'terminalClose', 'attachment', 'sessionHistory']);

export interface RunnerHostOptions {
  stateDir: string;
  runs: RunManager;
  sessions: SessionService;
  autoPrompts?: AutoPromptManager;
  slack?: SlackService;
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
}

/** Only these read state; every other request is refused while the worker hands off, never half-accepted. */
const READS_DURING_HANDOFF = new Set(['snapshot', 'sessionHistory', 'attachment', 'slackOverview']);

/** Hosts an already-started engine, including one adopted during an in-place upgrade. */
export async function startRunnerHost(options: RunnerHostOptions) {
  const capabilities = options.capabilities ?? new CapabilityRegistry();
  options.runs.setRunToolResolver(runToolResolver({ stateDir: options.stateDir, runs: options.runs, slack: options.slack, capabilities }));
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
      ...(options.triggers ? { triggers: options.triggers.overview() } : {}) };
  };
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
      case 'create': return options.runs.create(args[0] as CreateSessionRequest, admission(args[1]));
      case 'enqueue': {
        const admitted = admission(args[3]);
        // Only the owner's own message may carry Slack send approval; the origin decides, never a correlation ID.
        const prompt = options.slack && admitted.origin?.kind === 'owner'
          ? await options.slack.ownerChat(args[0] as string, args[1] as string) : args[1] as string;
        return options.runs.enqueue(args[0] as string, prompt, args[2] as MessageAttachments, admitted);
      }
      case 'steer': return options.runs.steer(args[0] as string);
      case 'cancel': return options.runs.cancel(args[0] as string);
      case 'respondToApproval': return options.runs.respondToApproval(args[0] as string, args[1] as string, args[2] as RunApprovalResponse);
      case 'sessionHistory': return sessionHistory(options.sessions, args);
      case 'attachment': {
        const attachment = await options.runs.attachment(args[0] as string);
        return { metadata: attachment.metadata, content: attachment.content.toString('base64') };
      }
      case 'terminalCreate': if (options.terminals) return options.terminals.create(args[0] as string, args[1], args[2]); break;
      case 'terminalInput': if (options.terminals) return options.terminals.input(args[0] as string, args[1]); break;
      case 'terminalResize': if (options.terminals) return options.terminals.resize(args[0] as string, args[1], args[2]); break;
      case 'terminalClose': if (options.terminals) return options.terminals.close(args[0] as string); break;
      case 'submitAutoPrompt': if (options.autoPrompts) { await context?.refresh(); return options.autoPrompts.submit(args[0] as AutoPromptRequest, { origin: admission(args[1]).origin }); } break;
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
      case 'api': if (options.api) return options.api.call(args[0], args[1], { kind: 'owner', via: 'ui' }); break;
      case 'slackTool': if (options.slack) return options.slack.tool(args[0] as string, args[1] as string, args[2] as Record<string, unknown>); break;
    }
    throw Object.assign(new Error('Unknown runner operation.'), { statusCode: 400 });
  };
  const mcp = { api: options.api, capabilities, slackTool: options.slack ? (workflowId: string, name: string, args: Record<string, unknown>) => options.slack!.tool(workflowId, name, args) : undefined,
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
    && !options.runs.list().some(run => run.status === 'running' || run.status === 'queued')
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
        if (options.triggers?.hasActive()) return;
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
  return { messages: history.messages, hasMore: history.hasMore, ...(history.nextBefore !== undefined ? { nextBefore: history.nextBefore } : {}) };
}

/**
 * The web connection is the only RPC caller. It admits the owner's own requests, or work an owner
 * turn's agent asked for. Trigger and Slack origins are assigned inside the worker, never over RPC.
 */
function admission(value: unknown): RunAdmission {
  const input = value && typeof value === 'object' ? value as { autoPromptId?: string; origin?: unknown } : {};
  const origin = input.origin === undefined ? { kind: 'owner' as const } : parseRunOrigin(input.origin);
  if (!origin || (origin.kind !== 'owner' && origin.kind !== 'agent')) throw Object.assign(new Error('The web connection can only admit owner or agent work.'), { statusCode: 400 });
  return { ...(input.autoPromptId !== undefined ? { autoPromptId: input.autoPromptId } : {}), origin };
}



async function runnerContext({ stateDir, runs, sessions, slack }: Pick<RunnerHostOptions, 'stateDir' | 'runs' | 'sessions' | 'slack'>) {
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
    refresh: async () => { await Promise.all([sessions.refresh(true), metadata()]); },
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
    const context = await runnerContext({ stateDir, runs, sessions });
    const autoPrompts = new AutoPromptManager({ stateDir, runs, ...context });
    await autoPrompts.start();
    const slack = new SlackService({ stateDir, runs, autoPrompts, refresh: context.refresh });
    const capabilities = new CapabilityRegistry(capability => capability.kind === 'slack-workflow'
      || runs.list().some(run => run.id === capability.runId && (run.status === 'running' || run.status === 'queued')));
    runs.setRunToolResolver(runToolResolver({ stateDir, runs, slack, capabilities }));
    const visible = await runnerContext({ stateDir, runs, sessions, slack });
    autoPrompts.updateContext(visible);
    await slack.start();
    // Sessions created before provenance existed are classified once from surviving ledger links.
    runs.setExternalLinkResolver(ids => { const linked = slack.linkedSessions().sessionIds; return ids.some(id => linked.has(id)); });
    runs.backfillSessionOrigins(slack.linkedSessions());
    // Read once: children of this worker must not inherit the proof.
    const handoffNonce = process.env.TOWER_HANDOFF && /^[a-f\d]{32}$/.test(process.env.TOWER_HANDOFF) ? process.env.TOWER_HANDOFF : undefined;
    delete process.env.TOWER_HANDOFF;
    const triggers = new TriggerService({ stateDir, slack: () => slack.projection(), executor: {
      submitAutoPrompt: async (request, internal) => { await context.refresh(); return autoPrompts.submit(request, internal); },
      getAutoPrompt: id => autoPrompts.get(id),
      create: (input, internal) => runs.create(input, internal),
      enqueue: (id, prompt, request, internal) => runs.enqueue(id, prompt, request, internal),
      runs: () => runs.list(),
      session: id => runs.getSession(id),
    } });
    await triggers.start();
    // Slack and triggers share one limit on provider turns running at once.
    runs.setAutomationLimit(triggers.settings().maxConcurrentRuns);
    triggers.on('settings', (settings: { maxConcurrentRuns: number }) => runs.setAutomationLimit(settings.maxConcurrentRuns));
    // A run still waiting when its trigger is turned off or deleted never starts.
    runs.setLaunchGate(run => run.origin?.kind === 'trigger' && run.origin.triggerId && !triggers.launchAllowed(run.origin.triggerId, run.origin.eventId)
      ? 'The trigger was turned off before this run started, so it did not run.' : undefined);
    const api = new TowerApi({ stateDir, triggers, runs,
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
    await startRunnerHost({ stateDir, sessions, runs, autoPrompts, terminals, slack, triggers, api, capabilities, releaseStateLock: release, handoffNonce,
      onIdle: async () => { triggers.close(); slack.close(); sessions.stop(); terminals.dispose(); await autoPrompts.close(); await runs.close(); },
      inFlight: () => slack.hasInFlight() || triggers.inFlight(), holdIntake: () => { slack.holdNewWork(); triggers.hold(); },
      quiesce: async () => { slack.pause(); triggers.pause(); await Promise.all([slack.flush(), triggers.flush(), runs.flushState(), autoPrompts.flush()]); },
      resume: () => { slack.resume(); triggers.resume(); },
      // Nothing is running, so nothing is cancelled; the successor owns the state from here.
      onHandedOff: () => { triggers.close(); slack.close(); sessions.stop(); setTimeout(() => process.exit(0), 2000); } });
    // A parent terminal or Tower shutdown must not interrupt provider work.
    process.on('SIGINT', () => {});
    process.on('SIGTERM', () => {});
  } catch (error) { sessions.stop(); await release(); throw error; }
}
