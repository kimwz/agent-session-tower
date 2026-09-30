import { installLaunchShims, launchMarksDir } from '../sessions/launch-marks.js';
import { finishedAutomationSessionIds } from '../../shared/automation-sessions.js';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, hostname } from 'node:os';
import type { AutoPromptRequest, ChatMessage, CreateSessionRequest, MessageAttachments, Run, RunApprovalResponse, Snapshot } from '../../shared/types.js';
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
import { WorktreeJanitor } from '../worktrees/janitor.js';
import { openCodexBridgeRun } from './codex-bridge.js';
import { RunManager, type RunAdmission } from './manager.js';
import { withoutMasterFolder } from './subscription.js';
import { parseRunOrigin } from './origin.js';
import { autoUpdateEnabled, ToolUpdates } from '../updates/tools.js';
import { defaultStateDir } from '../state-dir.js';
import { join, resolve } from 'node:path';
import { parseSuccessor, spawnSuccessor, writeHandoff, type SuccessorCommand } from './handoff.js';
import { REMOTE_FOLDER_REFUSED, TriggerService } from '../triggers/service.js';
import { GitHubCoordinator } from '../triggers/github-coordinator.js';
import { PUBLIC_TRIGGER_PREFIX, PublicAgentService } from '../public-agents/service.js';
import { TowerApi } from '../api/tower-api.js';
import { CapabilityRegistry, handleMcpRequest } from '../api/mcp.js';
import { sessionToolsKey } from '../api/session-tools.js';
import { DecisionService } from '../decisions/service.js';
import { relatedSessionNotes } from '../sessions/related.js';
import { runToolResolver } from '../api/run-tools.js';
import { RemoteExclusionStore } from '../remote/exclusions.js';
import { remoteTriggerLaunch } from '../remote/visibility.js';
import { RemoteRequestLedger, type RemoteResult } from '../remote/request-ledger.js';
import { SkillService } from '../skills/service.js';
import { installAgentGuidance } from '../agent-guidance/install.js';
import { PermissionService } from '../permissions/service.js';
import { PermissionReviewer } from '../permissions/reviewer.js';
import { PermissionRunner } from '../permissions/runner.js';
import { TOWER_NOTICE } from '../../shared/task-notification.js';
import { MAX_RUN_SECONDS, ruleGuards, type PermissionRequest } from '../../shared/permissions.js';
import { skillHomes } from '../skills/files.js';
import { runAutoPromptModel } from '../auto-prompt/native.js';
import { keepEndpoint } from './endpoint-keeper.js';
import { FORCE_UPDATE_DEADLINE_MS, FORCE_UPDATE_GIVE_UP_MS, MAX_RPC_BYTES, RUNNER_CAPABILITIES, RUNNER_PROTOCOL, runnerPaths, type RunnerReply, type RunnerSnapshot, type SessionHistoryPage } from './runner-protocol.js';

const SNAPSHOT_FREE_OPERATIONS = new Set(['terminalInput', 'terminalResize', 'terminalCreate', 'terminalClose', 'attachment', 'sessionHistory', 'publicVisit', 'publicAgentsOverview', 'publicAgentsConversation', 'skillsOverview', 'skillsDetail', 'skillsSummary', 'skillsExport', 'skillsImportPlan']);

export interface RunnerHostOptions {
  stateDir: string;
  runs: RunManager;
  sessions: SessionService;
  autoPrompts?: AutoPromptManager;
  slack?: SlackService;
  /** Coordinator conversations for GitHub issue events. */
  github?: GitHubCoordinator;
  triggers?: TriggerService;
  /** Pages the owner published for outside visitors. */
  publicAgents?: PublicAgentService;
  /** The owner's skills and the advisor that proposes new ones. */
  skills?: SkillService;
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
  /** Undoes `holdIntake` when a forced update gives up and this worker stays in service. */
  releaseIntake?: () => void;
  /** Only work underway this instant; a forced update waits for this instead of `inFlight`. */
  transient?: () => boolean;
  /** Delegated work of a Slack or GitHub workflow: a forced update neither wraps it up nor resumes it. */
  delegated?: (run: Run) => boolean;
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

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Only these read state; every other request is refused while the worker hands off, never half-accepted. */
const READS_DURING_HANDOFF = new Set(['snapshot', 'sessionHistory', 'attachment', 'slackOverview', 'skillsOverview', 'skillsDetail', 'skillsSummary']);

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
  /** The owner asked to switch now: running turns wrap up until this time, then stop. */
  let forced: { deadline: number } | undefined;
  const changed = () => { revision++; };
  const snapshot = (): RunnerSnapshot => {
    const sessions = options.runs.sessionList(options.sessions.list());
    return { instance, revision: ++revision, runs: options.runs.list(), sessions,
      nativeIds: Object.fromEntries(sessions.map(session => [session.id, options.runs.nativeSessionId(session.id)])),
      settled: [...options.runs.settledRunIds()], autoPrompts: options.autoPrompts?.list() ?? [], version: APP_VERSION,
      capabilities: [...RUNNER_CAPABILITIES], ...(options.handoffNonce ? { handoff: options.handoffNonce } : {}),
      ...(options.triggers ? { triggers: options.triggers.overview() } : {}),
      coordinators: [...new Set([...(options.slack?.coordinatorSessionIds() ?? []), ...(options.github?.coordinatorSessionIds() ?? [])])],
      ...(forced ? { updateDrain: options.runs.updateDrainStatus() } : {}) };
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
      case 'forceHandoff': {
        // The owner's explicit request: no new turn starts, running turns wrap up, and at the deadline the rest stop.
        const successor = parseSuccessor(args[0], paths.stateDir);
        const input = record(args[1]);
        const deadlineMs = input.deadlineMs === undefined ? FORCE_UPDATE_DEADLINE_MS : input.deadlineMs;
        if (typeof deadlineMs !== 'number' || !Number.isInteger(deadlineMs) || deadlineMs < 0 || deadlineMs > 60 * 60 * 1000) throw Object.assign(new Error('Invalid wrap-up time.'), { statusCode: 400 });
        handoff = { successor, requestedAt: handoff?.requestedAt ?? Date.now(), held: true, retryAt: undefined };
        if (!forced) {
          forced = { deadline: Date.now() + deadlineMs };
          options.holdIntake?.();
          options.runs.beginUpdateDrain(forced.deadline, options.delegated ?? (() => false));
          changed();
        }
        return { accepted: true, deadline: new Date(forced.deadline).toISOString() };
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
        const owner = admitted.origin?.kind === 'owner';
        const slackTurn = options.slack && owner ? await options.slack.ownerChat(args[0] as string, args[1] as string) : { prompt: args[1] as string };
        // The same holds in a GitHub coordinator conversation: only the owner's message can approve a comment.
        const turn = options.github && owner ? await options.github.ownerChat(args[0] as string, slackTurn.prompt) : slackTurn;
        // The receipts Tower adds reach the agent as instructions the conversation does not show, and never without them.
        const instructions = [slackTurn.instructions, turn === slackTurn ? undefined : turn.instructions].filter(Boolean).join('\n\n');
        return options.runs.enqueue(args[0] as string, turn.prompt, args[2] as MessageAttachments, { ...admitted, ...(instructions ? { instructions: { text: instructions, required: true } } : {}) });
      }
      case 'steer': {
        const target = (args[1] as { targetRunId?: unknown } | undefined)?.targetRunId;
        if (target !== undefined && (typeof target !== 'string' || !target || target.length > 200)) throw Object.assign(new Error('Invalid target turn.'), { statusCode: 400 });
        return options.runs.steer(args[0] as string, target === undefined ? {} : { targetRunId: target });
      }
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
      case 'skillsOverview': if (options.skills) return options.skills.overview(record(args[0])); break;
      case 'skillsDetail': if (options.skills) return options.skills.detail(record(args[0])); break;
      case 'skillsSummary': if (options.skills) return options.skills.summary(); break;
      case 'skillsMutate': if (options.skills) return options.skills.mutate(String(args[0]), record(args[1])); break;
      case 'skillsExport': if (options.skills) return options.skills.exportBundle(record(args[0])); break;
      case 'skillsImportPlan': if (options.skills) return options.skills.importPlan(args[0]); break;
      case 'publicAgentsOverview': if (options.publicAgents) return options.publicAgents.overview(); break;
      case 'publicAgentsConversation': if (options.publicAgents) return options.publicAgents.conversation(args[0] as string, args[1] as string); break;
      case 'publicAgentsMutate': if (options.publicAgents) return options.publicAgents.mutate(args[0] as string, args[1] as Record<string, unknown>); break;
      // A visitor's request, passed on by the public listener: the slug, the visitor's cookie token and address.
      case 'publicVisit': if (options.publicAgents) {
        const action = args[0];
        if (action !== 'state' && action !== 'login' && action !== 'message' && action !== 'reset') break;
        const input = args[2] && typeof args[2] === 'object' ? args[2] as Record<string, unknown> : {};
        return options.publicAgents.visit(action, String(args[1]), { ip: typeof input.ip === 'string' ? input.ip : 'unknown', token: typeof input.token === 'string' ? input.token : undefined, password: input.password, text: input.text });
      } break;
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
  options.publicAgents?.on('change', changed);
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  let handoffTimer: ReturnType<typeof setInterval> | undefined;
  let stopKeeping: (() => Promise<void>) | undefined;
  // Status alone is not enough: a cancelled turn may still be closing its provider process.
  const quiet = () => !pending && !options.runs.busy() && !options.autoPrompts?.busy()
    && !options.autoPrompts?.list().some(job => !['completed', 'error', 'cancelled'].includes(job.status))
    && !options.terminals?.hasActive()
    // A forced update hands queued turns and the workflows waiting on them to the successor; otherwise a continuation
    // scheduled for later is saved and delivered by the successor, but nothing due soon or underway may be left behind.
    && (forced ? !(options.transient ?? options.inFlight)?.() : !options.runs.hasWorkWithin(5 * 60 * 1000) && !options.inFlight?.());
  const handOff = async () => {
    if (forced && !closing && !draining) {
      options.runs.driveUpdateDrain();
      // A switch that still cannot happen well after the deadline must not keep new work waiting for good.
      if (Date.now() > forced.deadline + FORCE_UPDATE_GIVE_UP_MS) {
        console.error('The forced update could not hand off; new turns start again on this worker.');
        forced = undefined;
        options.runs.endUpdateDrain();
        options.releaseIntake?.();
        // The ordinary handoff goes on waiting for a quiet moment, its long hold counted from now.
        if (handoff) { handoff.held = false; handoff.requestedAt = Date.now(); }
        changed();
      }
    }
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
    await stopKeeping?.();
    if (idleTimer) clearInterval(idleTimer);
    if (handoffTimer) clearInterval(handoffTimer);
    options.runs.off('change', changed); options.sessions.off('change', changed); options.autoPrompts?.off('change', changed); options.triggers?.off('change', changed); options.publicAgents?.off('change', changed);
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
    stopKeeping = keepEndpoint({ socket: paths.socket, token: paths.token, value: token });
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
        if (options.publicAgents?.hasActive() || options.publicAgents?.inFlight()) return;
        // A Claude Code or Codex update keeps the worker: closing would hold its lock until npm ends, keeping a new web out.
        if (options.inFlight?.()) return;
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
  return { ...(input.autoPromptId !== undefined ? { autoPromptId: input.autoPromptId } : {}), origin,
    ...(typeof input.requestId === 'string' ? { requestId: input.requestId.toLowerCase() } : {}) };
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
  const projectedSessions = () => projectSessionStates(runs.sessionList(sessions.list()), runs.list(), runs.settledRunIds());
  const visibleSessions = () => {
    const projected = projectedSessions();
    const finished = finishedAutomationSessionIds(slack?.automation.list() ?? [], projected, runs.list());
    return projected.filter(session => !finished.has(session.id) && !slack?.coordinatorSessionIds().includes(session.id)).map(session => closed.apply(titles.apply(session)));
  };
  /** Every conversation, also those the canvas leaves out once their work is done (Slack coordinators and the work they delegated). */
  const allSessions = () => projectedSessions().map(session => closed.apply(titles.apply(session)));
  const snapshot = (): Snapshot => ({ sessions: visibleSessions(),
    runs: runs.list(), groups: withoutMasterFolder(groups.list(), stateDir), providers, scanning: false, hostname: hostname(), version: APP_VERSION, updatedAt: new Date().toISOString() });
  return { snapshot, allSessions,
    refresh: async () => { await Promise.all([sessions.refresh(true), metadata(), exclusions?.reload()]); },
    detail: async (id: string) => { const session = runs.getSession(id); if (!session) return undefined; const history = await sessions.detail(runs.nativeSessionId(id)); return { ...(history ?? { messages: [], hasMore: false }), session: closed.apply(titles.apply(session)) }; },
  };
}

export async function runRunnerWorker(stateDir: string): Promise<void> {
  const paths = await runnerPaths(stateDir);
  let release: () => Promise<void>;
  try { release = await acquireStateLock(paths.runtime, 0); }
  catch (error) { if (error instanceof MonitorAlreadyRunning) return; throw error; }
  const sessions = new SessionService({ launchProofs: join(stateDir, 'agent-launches.json'), launchMarks: launchMarksDir(stateDir) });
  // Without the shims a helper's launcher is proven only while the process tree shows it; the worker still starts.
  const shims = await installLaunchShims(stateDir).catch(error => { console.error(`Launch shims were not installed: ${error instanceof Error ? error.message : String(error)}`); return undefined; });
  const terminals = new WorkspaceTerminals({ keepAliveOnDisconnect: true });
  const runs = new RunManager({ stateDir, ...(shims ? { launchMarks: { shims, marks: launchMarksDir(stateDir) } } : {}), getSession: id => sessions.get(id), refreshSessions: () => sessions.refresh(true),
    openCodexBridge: options => openCodexBridgeRun({ ...options, codexHome: sessions.codexHome }), trustWorkspace,
    // Restored turns wait until tools, gates and limits below are set up.
    holdUntilReady: true });
  // Only the Tower on the account's own state folder keeps its Claude Code and Codex current, so two never update one install.
  // It is there even with automatic updates off: an install a previous worker left running is still waited for.
  const tools = resolve(stateDir) === resolve(defaultStateDir()) ? new ToolUpdates({ stateDir, env: process.env,
    // npm replaces files as it goes: then no session of that CLI may be working anywhere, in Tower's terminals included.
    hold: (provider, quiet) => quiet && sessions.list().some(session => session.provider === provider && session.status === 'working') ? undefined : runs.holdProvider(provider) }) : undefined;
  try {
    await sessions.start();
    // Before any turn can start: a CLI still being replaced by an installer from before is held first.
    await tools?.start(autoUpdateEnabled());
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
    // The owner's fast-judgment settings are read again each time, so a change on the settings page applies at once.
    const decisions = new DecisionService(stateDir);
    const slack = new SlackService({ stateDir, runs, autoPrompts, refresh: context.refresh,
      followUpEngine: async () => { await decisions.start(); return decisions.engine('slackFollowUps'); } });
    // GitHub coordinators use a trigger's credentials; the trigger engine starts right after.
    let triggerEngine: TriggerService | undefined;
    const github = new GitHubCoordinator({ stateDir, runs, autoPrompts, refresh: context.refresh, language: () => slack.language(),
      github: (triggerId, fresh) => { if (!triggerEngine) throw new Error('Triggers are still starting.'); return triggerEngine.githubClient(triggerId, fresh); } });
    coordinators = () => new Set([...slack.coordinatorSessionIds(), ...github.coordinatorSessionIds()]);
    // A delegated task's run stays until its coordinator has finished with it, across pruning and restarts.
    runs.setRetained(() => [...slack.automation.retainedRuns(), ...github.automation.retainedRuns()]);
    const capabilities = new CapabilityRegistry(capability => capability.kind !== 'owner-run'
      || runs.list().some(run => run.id === capability.runId && (run.status === 'running' || run.status === 'queued')));
    capabilities.grant(await sessionToolsKey(stateDir), { kind: 'session-reader' });
    runs.setRunToolResolver(runToolResolver({ stateDir, runs, slack, github, capabilities }));
    const visible = await runnerContext({ stateDir, runs, sessions, slack, exclusions });
    autoPrompts.updateContext(visible);
    runs.setFirstTurnNotes(async (run, session) => {
      await decisions.start();
      return relatedSessionNotes(decisions.engine('relatedSessions'), run, session, visible.allSessions(), id => sessions.recentRequests(runs.nativeSessionId(id)));
    });
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
    const publicAgents = new PublicAgentService({ stateDir, runs });
    await publicAgents.start();
    // Skill files live in the account's home; only the Tower on its own state folder proposes new ones.
    const skills = new SkillService({ stateDir, homes: skillHomes(stateDir), sessions: () => visible.allSessions(), runs: () => runs.list(), origin: id => runs.sessionOrigin(id),
      projects: () => (visible.snapshot().groups ?? []).map(group => group.cwd),
      history: async (session, limit) => (await sessions.detail(runs.nativeSessionId(session.id), undefined, limit))?.messages,
      model: (request, options) => runAutoPromptModel(request, { stateDir, ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) }),
      advise: resolve(stateDir) === resolve(defaultStateDir()), seed: resolve(stateDir) === resolve(defaultStateDir()),
      // Only the Tower on the account's own state folder points the agents' global instructions at itself.
      ...(resolve(stateDir) === resolve(defaultStateDir()) ? { installGuidance: async () => { await installAgentGuidance({ stateDir, claudeHome: process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), codexHome: process.env.CODEX_HOME || join(homedir(), '.codex') }); } } : {}) });
    // Skills never keep the worker from starting.
    await skills.start().catch(error => console.error(`Skills did not start: ${error instanceof Error ? error.message : String(error)}`));
    // Made just below; the permission service only calls it once requests arrive.
    let reviewer!: PermissionReviewer;
    // One-shot runs: the command runs in this worker; the conversation hears its end unless it already read the result.
    const runner: PermissionRunner = new PermissionRunner({ stateDir, update: (id, run): Promise<void> => permissions.updateRun(id, run) });
    let stopping = false;
    let paused = false;
    // Read from the web's saved file each time: the owner may close a conversation at any moment.
    const closedNow = async (sessionId: string) => { const saved = new ClosedSessionStore(stateDir); await saved.start(); return saved.closedIds().has(sessionId); };
    /** Tells a finished run's result, once its conversation is quiet; 'later' when it should be tried again. */
    const tellRun = async (request: PermissionRequest): Promise<'done' | 'later'> => {
      const now = permissions.overview().requests.find(item => item.id === request.id);
      if (!now?.run || now.run.delivered || !now.run.notify) return 'done';
      // The result reaches the conversation as the work it already was; a turn that can no longer be found is not guessed at.
      const run = request.runId ? runs.list().find(item => item.id === request.runId) : undefined;
      const origin = run?.origin;
      // Nobody left to tell, or the owner closed the conversation: nothing is sent, and it is not tried again.
      if (!origin || !runs.getSession(request.sessionId) || await closedNow(request.sessionId)) { await permissions.markTold(request.id); return 'done'; }
      // Sent only once the conversation has nothing running or waiting, so a close meanwhile is seen before it starts a turn.
      if (runs.list().some(item => item.sessionId === request.sessionId && (item.status === 'queued' || item.status === 'running'))) return 'later';
      const result = now.run.status === 'failed' ? `실패: ${now.run.error ?? '알 수 없는 이유'}` : now.run.timedOut ? '시간 제한으로 중단됨' : `종료 코드 ${now.run.exitCode ?? now.run.signal ?? '?'}${now.run.error ? `, ${now.run.error}` : ''}`;
      await runs.enqueue(request.sessionId, `${TOWER_NOTICE} 한 번 실행을 요청한 명령이 끝났습니다 (${result}). permissions_runResult에 id "${request.id}"를 주면 출력을 받습니다.`, {},
        { origin, ...(run?.unattended ? { unattended: true } : {}) });
      await permissions.markTold(request.id);
      return 'done';
    };
    // Only an attempt under way counts as work for a handoff; one waiting to try again is picked up by the next worker.
    const runNotices = new Set<ReturnType<typeof setTimeout>>();
    const runWaits = new Set<ReturnType<typeof setTimeout>>();
    const runFinished = (request: PermissionRequest, delay = 5_000) => {
      const timer = setTimeout(() => {
        runWaits.delete(timer);
        // A worker handing off or pausing sends nothing more; the next one tells what is left.
        if (stopping) return;
        if (paused) { runFinished(request, 30_000); return; }
        runNotices.add(timer);
        void tellRun(request).catch(error => { console.error(`A run's result could not reach its conversation: ${error instanceof Error ? error.message : String(error)}`); return 'later' as const; })
          .then(next => { runNotices.delete(timer); if (next === 'later' && !stopping) runFinished(request, 30_000); });
      }, delay);
      timer.unref();
      runWaits.add(timer);
    };
    const stopTelling = () => { stopping = true; for (const timer of runWaits) clearTimeout(timer); runWaits.clear(); };
    const permissions: PermissionService = new PermissionService({ stateDir, session: id => runs.getSession(id), globalCodex: resolve(stateDir) === resolve(defaultStateDir()),
      resume: async (sessionId, prompt) => { await runs.enqueue(sessionId, prompt, {}, { origin: { kind: 'owner' } }); },
      // A public agent's requests always wait for the owner: its conversations carry outsiders' words.
      autoReviewSkip: request => {
        const origin = runs.sessionOrigin(request.sessionId);
        const run = request.runId ? runs.list().find(item => item.id === request.runId) : undefined;
        if ([origin?.triggerId, run?.origin?.triggerId].some(id => id?.startsWith(PUBLIC_TRIGGER_PREFIX))) return '공개 에이전트의 요청은 소유자가 정합니다.';
        return undefined;
      },
      onReviewQueued: () => reviewer?.wake(),
      startRun: request => runner.start(request.id, request.rule.value, request.cwd, request.timeoutSeconds ?? MAX_RUN_SECONDS, request.sessionId),
      onRunFinished: runFinished,
      runOutput: id => runner.output(id),
      forgetRun: id => runner.forget(id),
      onAutoReviewChange: settings => { if (!settings.enabled) reviewer?.abort(); } });
    await permissions.start().catch(error => console.error(`Permission rules did not start: ${error instanceof Error ? error.message : String(error)}`));
    // Runs a previous worker left: allowed ones start now; ones it left running are stopped only when provably its own.
    // Nothing new runs, and the worker is not handed off, until that is done.
    const left = permissions.unfinishedRuns();
    runner.hold(Promise.all(left.running.map(async request => { await permissions.updateRun(request.id, await runner.recover(request.run!)); }))
      .catch(error => console.error(`Permission runs did not recover: ${error instanceof Error ? error.message : String(error)}`)));
    // Results a stopped worker never told their conversation are told now.
    for (const request of permissions.untoldRuns()) runFinished(request);
    for (const request of left.start) runner.start(request.id, request.rule.value, request.cwd, request.timeoutSeconds ?? MAX_RUN_SECONDS, request.sessionId);
    // Rules for one conversation go when it is closed or gone, or after their time.
    const expireRules = async () => { const saved = new ClosedSessionStore(stateDir); await saved.start(); await permissions.expire(saved.closedIds()); };
    void expireRules().catch(() => {});
    const expiryTimer = setInterval(() => { void expireRules().catch(() => {}); }, 10 * 60 * 1000);
    expiryTimer.unref();
    reviewer = new PermissionReviewer({ service: permissions,
      model: (request, options) => runAutoPromptModel(request, { stateDir, timeoutMs: options.timeoutMs }),
      sources: {
        runs: () => runs.list(),
        outsideInput: sessionId => runs.sessionOrigin(sessionId)?.untrustedInput === true,
        sessionTrigger: sessionId => { const origin = runs.sessionOrigin(sessionId); return origin?.kind === 'trigger' ? origin.triggerId : undefined; },
        trigger: id => {
          // A trigger deleted since (or a public agent's, which is no trigger here) has no instructions to read.
          let kept: ReturnType<TriggerService['get']> | undefined;
          try { kept = triggerEngine?.get(id); } catch { return undefined; }
          if (!kept?.trigger) return undefined;
          const trigger = kept.trigger;
          return { name: trigger.name, instructions: trigger.handler.kind === 'task' ? trigger.handler.instructions : trigger.handler.rules.map(rule => `${rule.name}: ${rule.condition}\n${rule.instructions}`).join('\n\n') };
        },
        authority: cwd => skills.authority(cwd),
        // The whole conversation, page by page back to its start; incomplete when that cannot be done.
        conversation: async sessionId => {
          const session = runs.getSession(sessionId);
          // A child conversation's history leaves out what it inherited from its parent: not all of the owner's words.
          if (!session || session.parentId) return { messages: [], complete: false };
          const pages: ChatMessage[][] = [];
          let before: number | undefined;
          for (let page = 0; page < 50; page += 1) {
            const detail = await sessions.detail(runs.nativeSessionId(sessionId), before, 200, { previousUser: false });
            if (!detail || detail.skipped) return { messages: pages.reverse().flat(), complete: false };
            pages.push(detail.messages);
            if (!detail.hasMore) return { messages: pages.reverse().flat(), complete: true };
            before = detail.nextBefore;
          }
          return { messages: pages.reverse().flat(), complete: false };
        },
        answers: sessionId => runs.ownerAnswers(sessionId),
        rules: cwd => permissions.overview(cwd).rules,
        guards: rule => ruleGuards(rule),
        requests: sessionId => permissions.overview().requests.filter(item => item.sessionId === sessionId).reverse(),
      },
      // The decision reaches the conversation as the work it already was: the requesting turn's origin and approvals.
      reachable: request => Boolean(request.runId && runs.list().find(item => item.id === request.runId)?.origin),
      notify: async (request, message) => {
        const run = request.runId ? runs.list().find(item => item.id === request.runId) : undefined;
        // Gone since: the reviewer hands the request back to the owner.
        if (!run?.origin) throw new Error('The requesting conversation can no longer be reached.');
        await runs.enqueue(request.sessionId, `${TOWER_NOTICE} ${message}`, {}, { origin: run.origin, ...(run.unattended ? { unattended: true } : {}) });
      } });

    runs.setClaudeSettings((cwd, sessionId) => permissions.claudeSettings(cwd, sessionId));
    runs.setTurnNotes((_run, session) => skills.turnNotes(session));
    runs.on('change', () => skills.recordRuns());
    // Worktrees a conversation made are removed once the owner closes it or automation finishes it.
    const worktrees = new WorktreeJanitor({ stateDir, sessions: () => visible.allSessions(), runs: () => runs.list(),
      closedIds: async () => { const saved = new ClosedSessionStore(stateDir); await saved.start(); return saved.closedIds(); },
      finishedAutomation: () => finishedAutomationSessionIds(slack.automation.list(), visible.allSessions(), runs.list()),
      // Folders a trigger works in, and projects the owner pinned, are in use even with no conversation open there.
      // Pins are read from the web's saved file each time: this worker's copy is only read when it starts.
      reserved: async () => { const groups = new ProjectGroupStore(stateDir); await groups.start();
        const triggers = triggerEngine?.list() ?? [];
        // A trigger that continues a conversation works where that conversation does.
        const continued = sessionTargets(triggers).flatMap(id => { const cwd = runs.getSession(id)?.cwd; return cwd ? [cwd] : []; });
        return [...folderSettings(triggers), ...continued, ...groups.list().filter(group => group.pinned).map(group => group.cwd)]; } });
    await worktrees.start().catch(error => console.error(`Worktree cleanup did not start: ${error instanceof Error ? error.message : String(error)}`));
    const triggers = new TriggerService({ stateDir, slack: () => slack.projection(), publicAgents: () => publicAgents.projection(), ownPorts,
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
    // Reviews waiting from before this worker started (or queued while the last one handed over) go on, once the
    // triggers whose instructions they read are in place.
    reviewer.wake();
    await github.start();
    // Slack and triggers share one limit on provider turns running at once.
    runs.setAutomationLimit(triggers.settings().maxConcurrentRuns);
    triggers.on('settings', (settings: { maxConcurrentRuns: number }) => runs.setAutomationLimit(settings.maxConcurrentRuns));
    // A run still waiting when its trigger is turned off or deleted never starts.
    // A coordinator conversation already under way continues, like an accepted Slack conversation; only its first turn waits on the trigger.
    const remoteLaunch = remoteTriggerLaunch(exclusions, runs);
    runs.setLaunchGate(run => {
      if (run.origin?.kind !== 'trigger' || !run.origin.triggerId) return undefined;
      // A public agent's work starts only while that agent still exists and is on.
      if (run.origin.triggerId.startsWith(PUBLIC_TRIGGER_PREFIX)) return publicAgents.launchAllowed(run.origin.triggerId.slice(PUBLIC_TRIGGER_PREFIX.length)) ? undefined : 'The public agent was turned off or deleted before this run started, so it did not run.';
      if (!(run.origin.workflowId && run.autoPromptId !== run.origin.workflowId) && !triggers.launchAllowed(run.origin.triggerId, run.origin.eventId)) return 'The trigger was turned off before this run started, so it did not run.';
      // Once more as the provider is about to start: a trigger set up remotely never works in a folder kept from sharing.
      return remoteLaunch.refused(run) ? REMOTE_FOLDER_REFUSED : undefined;
    }, run => remoteLaunch.prepareRun(run));
    const api = new TowerApi({ stateDir, triggers, runs, github, permissions,
      remote: async paths => { await exclusions.reload(); await exclusions.prepare(paths, { fresh: true }); return { matcher: exclusions.matcher(), coordinators: coordinators() }; },
      projects: () => {
        const snapshot = visible.snapshot();
        const titles = new Map((snapshot.groups ?? []).map(group => [group.cwd, group]));
        const counts = new Map<string, number>();
        for (const session of snapshot.sessions) if (!session.isSubagent && !session.launchedByAgent && !session.master && session.cwd) counts.set(session.cwd, (counts.get(session.cwd) ?? 0) + 1);
        for (const group of snapshot.groups ?? []) if (group.pinned && !counts.has(group.cwd)) counts.set(group.cwd, 0);
        return [...counts].map(([cwd, sessions]) => ({ cwd, title: titles.get(cwd)?.title || cwd.split('/').filter(Boolean).at(-1) || cwd, sessions, pinned: titles.get(cwd)?.pinned === true }))
          .sort((a, b) => b.sessions - a.sessions);
      },
      // Local lookups reach every conversation: past work the canvas no longer shows is often the context an agent needs.
      sessions: { list: () => visible.snapshot().sessions, all: () => visible.allSessions(),
        read: async (id, limit, before) => runs.getSession(id) ? (await sessions.detail(runs.nativeSessionId(id), before, limit)) ?? { messages: [], hasMore: false } : undefined,
        search: async (id, query) => runs.getSession(id) ? (await sessions.search(runs.nativeSessionId(id), query)) ?? { count: 0, matches: [], bytes: 0 } : undefined },
      autoPrompts: { submit: async (request, internal) => { await context.refresh(); return autoPrompts.submit(request, internal); }, get: id => autoPrompts.get(id) } });
    await startRunnerHost({ stateDir, sessions, runs, autoPrompts, terminals, slack, github, triggers, publicAgents, skills, api, capabilities, ledger, exclusions, releaseStateLock: release, handoffNonce,
      onIdle: async () => { stopTelling(); await tools?.stop(); triggers.close(); await triggers.settle(); github.close(); slack.close(); publicAgents.close(); await publicAgents.flush(); skills.close(); await skills.flush(); worktrees.close(); await worktrees.flush(); reviewer.close(); await reviewer.flush(); await runner.flush(); clearInterval(expiryTimer); permissions.close(); await permissions.flush(); await sessions.quiesce().catch(() => {}); sessions.stop(); terminals.dispose(); await autoPrompts.close(); await runs.close(); },
      inFlight: () => slack.hasInFlight() || triggers.inFlight() || github.inFlight() || publicAgents.inFlight() || skills.inFlight() || worktrees.inFlight() || reviewer.inFlight() || runner.inFlight() || runNotices.size > 0 || Boolean(tools?.busy()),
      transient: () => slack.hasTransient() || triggers.inFlight() || github.automation.transient() || publicAgents.inFlight() || skills.inFlight() || worktrees.inFlight() || reviewer.inFlight() || runner.inFlight() || runNotices.size > 0 || Boolean(tools?.busy()),
      // Work a Slack or GitHub coordinator delegated: its coordinator hears how it ended and decides what follows.
      delegated: run => Boolean(run.origin?.workflowId) && !coordinators().has(run.sessionId),
      releaseIntake: () => { slack.releaseNewWork(); triggers.release(); github.release(); publicAgents.release(); skills.resume(); worktrees.resume(); reviewer.release(); },
      holdIntake: () => { slack.holdNewWork(); triggers.hold(); github.hold(); publicAgents.hold(); skills.pause(); worktrees.pause(); reviewer.hold(); },
      quiesce: async () => { paused = true; tools?.pause(); slack.pause(); triggers.pause(); github.pause(); publicAgents.pause(); skills.pause(); worktrees.pause(); reviewer.hold(); await reviewer.flush(); permissions.pause(); await Promise.all([worktrees.flush(), permissions.flush(), slack.flush(), triggers.flush(), github.flush(), publicAgents.flush(), skills.flush(), runs.flushState(), autoPrompts.flush(), ledger.flush(), sessions.quiesce()]); },
      resume: () => { paused = false; tools?.resume(); slack.resume(); triggers.resume(); github.resume(); publicAgents.resume(); skills.resume(); worktrees.resume(); permissions.resume(); reviewer.release(); sessions.resume(); },
      // Nothing is running, so nothing is cancelled; the successor owns the state from here.
      onHandedOff: () => { stopTelling(); void tools?.stop(); triggers.close(); github.close(); slack.close(); publicAgents.close(); skills.close(); worktrees.close(); reviewer.close(); clearInterval(expiryTimer); permissions.close(); sessions.stop(); setTimeout(() => process.exit(0), 2000); } });
    runs.markReady();
    // A parent terminal or Tower shutdown must not interrupt provider work.
    process.on('SIGINT', () => {});
    process.on('SIGTERM', () => {});
  } catch (error) { void tools?.stop(); sessions.stop(); await release(); throw error; }
}

/** Every `cwd` a setting names, at any depth: the folders triggers and their rules work in. */
function folderSettings(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) folderSettings(item, found);
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    if (key === 'cwd' && typeof item === 'string' && item.startsWith('/')) found.push(item);
    else folderSettings(item, found);
  }
  return found;
}

/** The conversations triggers continue (`target: { mode: 'session', sessionId }`). */
function sessionTargets(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) sessionTargets(item, found);
  else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.mode === 'session' && typeof record.sessionId === 'string') found.push(record.sessionId);
    for (const item of Object.values(record)) sessionTargets(item, found);
  }
  return found;
}
