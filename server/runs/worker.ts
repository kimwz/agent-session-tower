import { OPERATIONS, type OperationName } from '../../shared/api/operations.js';
import { storageControl } from './storage-control.js';
import type { RollbackFence } from '../link/storage-update.js';
import type { WorkerStorageStatus } from '../../shared/storage.js';
import { captureStorageBundle, storageBuildContext, preflightStorage, openStorage, adoptSnapshot, reconcileRecovery, readRecoveryBarrier, StorageCommandError, type StorageClient } from '../storage/index.js';
import { evaluateStorageUpdate, storageHealth, bootstrapPrepareCommandId, readRollbackRecord, databaseSupported, recordPreparationEvidence, recordUpdateRecoveryReceipt, type RecoveryReceiptKind } from '../link/storage-update.js';
import { managedByService } from '../link/update.js';
import type { HeartbeatAdmission } from '../../shared/master.js';
import { newWorkerSession } from '../models/worker.js';
import { latestNativeUserMessage } from './native-user-message.js';
import { heartbeatRunProtected } from './continuations.js';
import { installLaunchShims, launchMarksDir } from '../sessions/launch-marks.js';
import { finishedAutomationSessionIds } from '../../shared/automation-sessions.js';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, hostname } from 'node:os';
import type { AutoPromptInput, ChatMessage, NewSessionInput, MessageAttachments, Run, RunApprovalResponse, Session, Snapshot } from '../../shared/types.js';
import { APP_VERSION } from '../../shared/app-identity.js';
import { AutoPromptManager } from '../auto-prompt/manager.js';
import { SlackService } from '../slack/service.js';
import { takeWorkerRestore } from '../backup/restore-files.js';
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
import { inMasterFolder, withoutMasterFolder } from './subscription.js';
import { parseRunOrigin } from './origin.js';
import { autoUpdateEnabled, ToolUpdates } from '../updates/tools.js';
import { defaultStateDir } from '../state-dir.js';
import { join, resolve } from 'node:path';
import { parseSuccessor, readHandoff, readHandoffCarry, spawnSuccessor, writeHandoff, type SuccessorCommand } from './handoff.js';
import { REMOTE_FOLDER_REFUSED, TriggerService } from '../triggers/service.js';
import { GitHubCoordinator } from '../triggers/github-coordinator.js';
import { PUBLIC_TRIGGER_PREFIX, PublicAgentService } from '../public-agents/service.js';
import { TowerApi } from '../api/tower-api.js';
import { callerDelegation, CapabilityRegistry, handleMcpRequest } from '../api/mcp.js';
import { sessionToolsKey } from '../api/session-tools.js';
import { DecisionService } from '../decisions/service.js';
import { relatedSessionNotes } from '../sessions/related.js';
import { runToolResolver, sessionBrowsers, thisBuild } from '../api/run-tools.js';
import { browserNote } from '../browser/tools.js';
import { RemoteExclusionStore } from '../remote/exclusions.js';
import { remoteSessionIds, remoteTriggerLaunch } from '../remote/visibility.js';
import { RemoteRequestLedger, type RemoteResult } from '../remote/request-ledger.js';
import { SkillService } from '../skills/service.js';
import { SessionTasks } from '../sessions/tasks.js';
import { SessionCompactions } from '../sessions/compaction/service.js';
import { SecretService } from '../secrets/service.js';
import { SecretRuntime, SECRET_TOOLS } from '../secrets/runtime.js';
import { SECRET_CONNECTION_INSTRUCTIONS } from '../secrets/notices.js';
import { SecretStore } from '../triggers/secrets.js';
import { listPendingSecretImports, importPendingSecret } from '../secrets/imports.js';
import { openLegacyImport } from '../backup/secrets.js';
import type { SecretTarget } from '../../shared/secrets.js';
import type { Capability } from '../api/mcp.js';
import type { RemoteSecretRequest, RemoteSecretResponse } from '../secrets/remote.js';
import { installAgentGuidance } from '../agent-guidance/install.js';
import { PermissionService } from '../permissions/service.js';
import { PermissionReviewer } from '../permissions/reviewer.js';
import { PermissionRunner } from '../permissions/runner.js';
import { TOWER_NOTICE } from '../../shared/task-notification.js';
import { MAX_RUN_SECONDS, ruleGuards, type PermissionRequest } from '../../shared/permissions.js';
import { skillHomes } from '../skills/files.js';
import { runAutoPromptModel } from '../auto-prompt/native.js';
import { modelRoleNotes } from '../models/notes.js';
import { keepEndpoint } from './endpoint-keeper.js';
import { FORCE_UPDATE_DEADLINE_MS, FORCE_UPDATE_GIVE_UP_MS, MAX_RPC_BYTES, RUNNER_CAPABILITIES, RUNNER_PROTOCOL, runnerPaths, type RunnerReply, type RunnerSnapshot, type SessionHistoryPage } from './runner-protocol.js';
import { TowerError, statusOf } from '../../shared/errors.js';
import { sseSink } from '../http/sinks.js';
import { RetentionService } from '../sessions/retention/service.js';
import { RetentionArchive } from '../sessions/retention/archive.js';
import { RetentionStore } from '../sessions/retention/store.js';
import { permissionRetentionPending, RetentionObserver } from '../sessions/retention/observer.js';
import { createNativeRetentionAdapter } from '../sessions/retention/provider.js';
import { TemporaryCollector, inspectTemporaryProtection } from '../temporary/directories.js';

const SNAPSHOT_FREE_OPERATIONS = new Set(['terminalInput', 'terminalResize', 'terminalCreate', 'terminalClose', 'attachment', 'sessionHistory', 'publicVisit', 'publicAgentsOverview', 'publicAgentsConversation', 'skillsOverview', 'skillsDetail', 'skillsSummary', 'skillsExport', 'skillsImportPlan', 'skillsBackup', 'secretCall', 'compactionGet']);

export interface RunnerHostOptions {
  storage?: () => WorkerStorageStatus;
  retryStorage?: () => Promise<WorkerStorageStatus>;
  storageControl?: (action: string, input: Record<string, unknown>, host: { quiet(): boolean; handoff(command: SuccessorCommand, fence: RollbackFence): void }) => Promise<unknown>;
  storageRecovery?: (action: string, input: Record<string, unknown>) => Promise<unknown>;
  /** Must finish the thread close/exit before any path releases the runtime lock. */
  closeStorage?: () => Promise<void>;
  onCloseFailure?: (error: unknown) => void;
  stateDir: string;
  runs: RunManager;
  sessions: SessionService;
  closedSessions?: ClosedSessionStore;
  retention?: { service: RetentionService; archive: RetentionArchive; temporary?: TemporaryCollector };
  retentionUnavailable?: string;
  autoPrompts?: AutoPromptManager;
  slack?: SlackService;
  /** Coordinator conversations for GitHub issue events. */
  github?: GitHubCoordinator;
  triggers?: TriggerService;
  /** Pages the owner published for outside visitors. */
  publicAgents?: PublicAgentService;
  /** The owner's skills and the advisor that proposes new ones. */
  skills?: SkillService;
  /** Task summaries put on the listed sessions; a new summary is a new snapshot. */
  sessionTasks?: SessionTasks;
  /** Compactions the owner asked for: a conversation summarized into a new session. */
  compactions?: SessionCompactions;
  api?: TowerApi;
  secrets?: SecretRuntime;
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
  /** Storage patient handoffs also wait for helpers already accepted before the hold. */
  storageBusy?: () => boolean;
  /** Delegated work of a Slack or GitHub workflow: a forced update neither wraps it up nor resumes it. */
  delegated?: (run: Run) => boolean;
  /** Pauses automatic intake and saves pending writes at a quiet moment. Nothing is cancelled or closed. */
  quiesce?: () => Promise<void>;
  /** Undoes quiesce when the handoff cannot be recorded, so the worker stays fully in service. */
  resume?: () => void;
  startSuccessor?: (command: SuccessorCommand, nonce: string, carry?: Buffer) => void;
  /** State only the successor may receive (the open vault key), taken right before it is started. */
  handoffCarry?: () => Buffer | undefined;
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
const STORAGE_READS = new Set(['snapshot', 'requestHandoff', 'sessionHistory', 'attachment', 'cancel', 'respondToApproval', 'terminalInput', 'terminalResize', 'terminalClose', 'compactionGet']);
const READS_DURING_HANDOFF = new Set(['snapshot', 'sessionHistory', 'attachment', 'slackOverview', 'skillsOverview', 'skillsDetail', 'skillsSummary', 'compactionGet']);

/** Hosts an already-started engine, including one adopted during an in-place upgrade. */
export async function startRunnerHost(options: RunnerHostOptions) {
  let capabilities = options.capabilities ?? new CapabilityRegistry();
  options.runs.setRunToolResolver(runToolResolver({ stateDir: options.stateDir, runs: options.runs, slack: options.slack, github: options.github, capabilities, secrets: options.secrets }));
  const paths = await runnerPaths(options.stateDir);
  const release = options.releaseStateLock ?? await acquireStateLock(paths.runtime, 0);
  let context: Awaited<ReturnType<typeof runnerContext>> | undefined;
  try {
    if (options.autoPrompts) { context = await runnerContext(options); options.autoPrompts.updateContext(context); }
  } catch (error) { await Promise.all([options.runs.pauseAttachmentCleanup(), options.autoPrompts?.pauseAttachmentCleanup()]); await options.closeStorage?.(); await release(); throw error; }
  const instance = randomUUID();
  const token = randomBytes(32).toString('hex');
  let revision = 1;
  let lastRequest = Date.now();
  let pending = 0;
  let closing = false;
  /** `patient`: only asked so a new worker reads its settings again (a restore); it never holds new work back to force a quiet moment. */
  let handoff: { successor: SuccessorCommand; requestedAt: number; held?: boolean; retryAt?: number; patient?: boolean; rollbackFence?: RollbackFence } | undefined;
  let draining = false;
  /** The owner asked to switch now: running turns wrap up until this time, then stop. */
  let forced: { deadline: number } | undefined;
  const changed = () => { revision++; };
  const snapshot = (): RunnerSnapshot => {
    const sessions = options.runs.sessionList(options.sessions.list());
    return { instance, revision: ++revision, runs: options.runs.list(), sessions,
      nativeIds: Object.fromEntries(sessions.map(session => [session.id, options.runs.nativeSessionId(session.id)])),
      settled: [...options.runs.settledRunIds()], autoPrompts: options.autoPrompts?.list() ?? [], version: APP_VERSION,
      capabilities: RUNNER_CAPABILITIES.filter(capability => capability !== 'workerClosed' || !!options.closedSessions).filter(capability => capability !== 'retention' || !!options.retention),
      ...(options.storage ? { storage: options.storage() } : {}),
      ...(options.closedSessions ? { closedIds: [...options.closedSessions.closedIds()] } : {}),
      ...(options.handoffNonce ? { handoff: options.handoffNonce } : {}),
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
    if (sessionId && coordinator(options.runs.getSession(sessionId)?.id ?? sessionId)) throw new TowerError('not-found', 'Not found.');
    if (!options.ledger || !admitted.requestId) throw new TowerError('invalid', '원격 요청에는 요청 ID가 필요합니다.');
    return options.ledger.once(controllerId, operation, admitted.requestId, content, execute, record, replay);
  };
  const findRun = (id: string) => options.runs.list().find(run => run.id === id);
  let temporaryFailure: string | undefined;
  const temporaryOverview = () => {
    const overview = options.retention?.temporary?.overview();
    return overview && temporaryFailure ? { ...overview, failed: Math.max(overview.failed, 1), issues: [...overview.issues, temporaryFailure] } : overview;
  };
  let closureReady: Promise<void> | undefined;
  const admit = (value: unknown, targetSessionId?: string): RunAdmission => {
    const admitted = admission(value);
    const token = record(value).callerCapability;
    const heartbeatValidate = () => {
      if (admitted.heartbeat && (!options.api || options.api.heartbeatBlocked(admitted.heartbeat.sessionIds))) throw new TowerError('conflict', 'Heartbeat permission preconditions changed.', { disposition: 'not-admitted' });
    };
    if (token === undefined) return { ...admitted, ...(admitted.heartbeat ? { validate: heartbeatValidate } : {}) };
    if (typeof token !== 'string' || admitted.origin?.controllerId) throw new TowerError('forbidden', 'Invalid local calling-turn credential.');
    const caller = capabilities.resolve(token);
    const callingRun = caller?.kind === 'caller-run' ? findRun(caller.runId) : undefined;
    const corrective = callingRun?.heartbeat;
    const validate = () => {
      heartbeatValidate(); callerDelegation(capabilities, findRun, token);
      if (corrective) {
        const current = findRun(callingRun!.id);
        const target = targetSessionId && options.runs.getSession(targetSessionId);
        const turns = target ? options.runs.list().filter(run => run.sessionId === target.id) : [];
        const latest = [...turns].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
        const selected = corrective.targets?.find(item => !item.node && item.sessionId === targetSessionId);
        if (!target || !current || current.origin?.kind !== 'agent' || current.origin.controllerId || current.ownerStopped || current.approvals?.length
          || !selected || latest?.id !== selected.latestRunId || target.lastRequestAt !== selected.lastRequestAt
          || heartbeatRunProtected(turns, latest) || turns.some(run => (run.status === 'running' || run.status === 'queued') && run.approvals?.length)
          || !options.api || options.api.heartbeatBlocked([current.sessionId, target.id])) {
          throw new TowerError('forbidden', 'Heartbeat corrective target is unavailable or protected.', { disposition: 'not-admitted' });
        }
      }
    };
    validate();
    return { ...admitted, ...(corrective ? { origin: { kind: 'agent' as const } } : {}), delegation: callerDelegation(capabilities, findRun, token), validate };
  };
  // Explicit dispatch prevents access to prototype methods or lifecycle controls.
  const dispatch = async (method: string, args: unknown[]) => {
    if (method === 'storageControl') {
      if (draining || !options.storageControl || typeof args[0] !== 'string') throw new TowerError('unavailable', 'Storage control is unavailable.');
      return options.storageControl(args[0], record(args[1]), {
        quiet: () => quiet(1),
        handoff: (successor, rollbackFence) => { handoff = { successor, rollbackFence, patient: true, requestedAt: Date.now() }; },
      });
    }
    if (method === 'storageStatus') return options.storage?.();
    if (method === 'storageRecovery') {
      if (draining) throw new TowerError('unavailable', 'Worker handoff is underway.');
      if (typeof args[0] !== 'string' || !options.storageRecovery) throw new TowerError('invalid', 'Unknown storage recovery action.');
      return options.storageRecovery(args[0], record(args[1]));
    }
    if (method === 'storageRetry') { if (draining) throw new TowerError('unavailable', 'Worker handoff is underway.'); return options.retryStorage?.(); }
    const storage = options.storage?.();
    const typedRead = method === 'api' && typeof args[0] === 'string' && Object.hasOwn(OPERATIONS, args[0]) && OPERATIONS[args[0] as OperationName].write === false;
    if (storage && !storage.admissionOpen && (!STORAGE_READS.has(method) && !typedRead || typedRead && !storage.sessionsAvailable && (args[0] as string).startsWith('sessions.'))) {
      throw new TowerError('unavailable', storage.reason, { disposition: 'not-admitted' });
    }
    if (storage && !storage.sessionsAvailable && method === 'sessionHistory') throw new TowerError('unavailable', storage.reason);
    if (options.closedSessions) {
      // The predecessor's web may have completed a legacy closure write during startup.
      closureReady ??= options.closedSessions.start().then(() => { changed(); }).catch(error => {
        closureReady = undefined;
        console.error(`Session closure reload failed; execution controls remain available and the next request will retry: ${error instanceof Error ? error.message : String(error)}`);
      });
      await closureReady;
    }
    if (draining && !READS_DURING_HANDOFF.has(method)) {
      throw new TowerError('unavailable', 'Tower is replacing its execution worker right now. Nothing was submitted; retry in a few seconds.', { disposition: 'handoff' });
    }
    switch (method) {
      case 'snapshot': return undefined;
      case 'retention': {
        if (!options.retention) throw new TowerError('unavailable', options.retentionUnavailable || '세션 보관 정책은 실행 워커 업데이트 후 사용할 수 있습니다.');
        const [action, value, extra] = args;
        const service = options.retention.service;
        if (action === 'overview') return { ...service.overview(), temporary: temporaryOverview(), targets: options.runs.sessionList(options.sessions.list()).filter(session => !session.master && (session.isSubagent || session.launchedByAgent && session.parentId)).map(session => ({ id: session.id, title: session.customTitle || session.title })) };
        if (action === 'check') {
          try { await options.retention.temporary?.cycle(); temporaryFailure = undefined; }
          catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            temporaryFailure = `Temporary cleanup failed: ${typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : 'unknown error'}`;
          }
          return { ...await service.cycle(), temporary: temporaryOverview() };
        }
        if (typeof value !== 'string' || !value || value.length > 4096) throw new TowerError('invalid', 'Invalid retention target.');
        if (action === 'archive') return service.archiveSession(value);
        if (action === 'backup') return service.backup(value);
        if (action === 'manifest') return options.retention.archive.manifest(value);
        if (action === 'read' && typeof extra === 'string') return options.retention.archive.read(value, extra);
        if (action === 'restore') { await service.restore(value); return service.overview(); }
        if (action === 'export' && typeof extra === 'string') { await service.exportBundle(value, extra); return { exported: true }; }
        if (action === 'import') { await service.importBundle(value); return service.overview(); }
        throw new TowerError('invalid', 'Unknown retention operation.');
      }
      case 'setClosed': {
        if (!options.closedSessions) throw new TowerError('unavailable', 'Session closure is unavailable.');
        if (typeof args[0] !== 'string' || typeof args[1] !== 'boolean') throw new TowerError('invalid', 'Invalid session closure request.');
        if (!args[1] && options.retention) await options.retention.service.restoreSession(args[0]);
        const session = options.runs.getSession(args[0]);
        if (!session) return undefined;
        if (!args[1]) {
          if (options.retention) await options.retention.service.cancelArchiveRequest(session.id);
          else if (options.retentionUnavailable) throw new TowerError('unavailable', options.retentionUnavailable);
        }
        const updated = await options.closedSessions.set(session, args[1]);
        changed();
        return updated;
      }
      case 'requestHandoff': {
        // The latest web build wins; the worker leaves only at a moment when nothing is running.
        const patient = record(args[1]).patient === true && (!handoff || handoff.patient === true);
        // An ordinary handoff waits its own long hold from when it is asked, not from an earlier patient one.
        const since = handoff && !handoff.patient ? handoff.requestedAt : Date.now();
        handoff = { successor: parseSuccessor(args[0], paths.stateDir), requestedAt: patient && handoff ? handoff.requestedAt : since, held: handoff?.held, retryAt: handoff?.retryAt, ...(patient ? { patient } : {}) };
        return { accepted: true };
      }
      case 'forceHandoff': {
        // The owner's explicit request: no new turn starts, running turns wrap up, and at the deadline the rest stop.
        const successor = parseSuccessor(args[0], paths.stateDir);
        const input = record(args[1]);
        const deadlineMs = input.deadlineMs === undefined ? FORCE_UPDATE_DEADLINE_MS : input.deadlineMs;
        if (typeof deadlineMs !== 'number' || !Number.isInteger(deadlineMs) || deadlineMs < 0 || deadlineMs > 60 * 60 * 1000) throw new TowerError('invalid', 'Invalid wrap-up time.');
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
        const admitted = admit(args[1]);
        return remote(admitted, 'create', args[0], undefined, async () => options.runs.create(await newWorkerSession(options.stateDir, args[0] as NewSessionInput), admitted),
          value => ({ kind: 'session', sessionId: value.session.id, runId: value.run.id }),
          result => {
            if (result.kind !== 'session') return undefined;
            const session = options.runs.getSession(result.sessionId), run = findRun(result.runId);
            return session && run ? { session, run } : undefined;
          });
      }
      case 'enqueue': {
        const admitted = admit(args[3], String(args[0]));
        if (admitted.origin?.controllerId) {
          return remote(admitted, 'enqueue', [args[0], args[1], args[2]], args[0] as string, () => options.runs.enqueue(args[0] as string, args[1] as string, args[2] as MessageAttachments, admitted),
            value => ({ kind: 'run', runId: value.id }), result => result.kind === 'run' ? findRun(result.runId) : undefined);
        }
        // Only the owner's own message may carry Slack send approval; the origin decides, never a correlation ID.
        const owner = admitted.origin?.kind === 'owner' && !admitted.delegation;
        const slackTurn = options.slack && owner ? await options.slack.ownerChat(args[0] as string, args[1] as string) : { prompt: args[1] as string };
        // The same holds in a GitHub coordinator conversation: only the owner's message can approve a comment.
        const turn = options.github && owner ? await options.github.ownerChat(args[0] as string, slackTurn.prompt) : slackTurn;
        // The receipts Tower adds reach the agent as instructions the conversation does not show, and never without them.
        const instructions = [slackTurn.instructions, turn === slackTurn ? undefined : turn.instructions].filter(Boolean).join('\n\n');
        return options.runs.enqueue(args[0] as string, turn.prompt, args[2] as MessageAttachments, { ...admitted, ...(instructions ? { instructions: { text: instructions, required: true } } : {}) });
      }
      case 'steer': {
        const target = (args[1] as { targetRunId?: unknown } | undefined)?.targetRunId;
        if (target !== undefined && (typeof target !== 'string' || !target || target.length > 200)) throw new TowerError('invalid', 'Invalid target turn.');
        return options.runs.steer(args[0] as string, target === undefined ? {} : { targetRunId: target });
      }
      case 'cancel': return options.runs.cancel(args[0] as string);
      case 'respondToApproval': return options.runs.respondToApproval(args[0] as string, args[1] as string, args[2] as RunApprovalResponse);
      case 'sessionHistory': return sessionHistory(options.sessions, args);
      case 'compactionStart': case 'compactionGet': case 'compactionCancel': {
        const compactions = options.compactions;
        if (!compactions) break;
        if (typeof args[0] !== 'string' || !args[0] || args[0].length > 512) throw new TowerError('invalid', 'Invalid session.');
        if (method === 'compactionGet') return compactions.get(args[0]) ?? null;
        if (method === 'compactionCancel') return compactions.cancel(args[0]);
        const admitted = admit(args[2]);
        // The owner's button only: never work an agent's turn asks for.
        if (admitted.delegation) throw new TowerError('forbidden', '세션 압축은 소유자만 할 수 있습니다.');
        const id = args[0];
        const input = record(args[1]);
        const title = typeof input.title === 'string' && input.title.length <= 200 ? input.title : undefined;
        // A controller's request runs once per request ID, however late it is sent again (and never for a coordinator
        // conversation); a retry answers with that compaction while it is still the conversation's latest.
        return remote(admitted, 'compaction', { sessionId: id }, id, async () => compactions.start(id, title ? { title } : {}, admitted),
          value => ({ kind: 'compaction', sessionId: value.sessionId, jobId: value.id }),
          result => { if (result.kind !== 'compaction') return undefined; const job = compactions.get(result.sessionId); return job?.id === result.jobId ? job : undefined; });
      }
      case 'attachment': {
        const attachment = await options.runs.attachment(args[0] as string);
        return { metadata: attachment.metadata, content: attachment.content.toString('base64'), sessionId: attachment.sessionId };
      }
      case 'terminalCreate': if (options.terminals) return options.terminals.create(args[0] as string, args[1], args[2]); break;
      case 'terminalInput': if (options.terminals) return options.terminals.input(args[0] as string, args[1]); break;
      case 'terminalResize': if (options.terminals) return options.terminals.resize(args[0] as string, args[1], args[2]); break;
      case 'terminalClose': if (options.terminals) return options.terminals.close(args[0] as string); break;
      case 'submitAutoPrompt': if (options.autoPrompts) {
        const admitted = admit(args[1]);
        const autoPrompts = options.autoPrompts;
        const request = args[0] as AutoPromptInput;
        return remote(admitted, 'autoPrompt', request, undefined, async () => { context ??= await runnerContext(options); await context.refresh(); return autoPrompts.submit(request, { origin: admitted.origin, ...(admitted.delegation ? { delegation: admitted.delegation, validate: admitted.validate } : {}) }); },
          value => ({ kind: 'autoPrompt', jobId: value.id }), result => result.kind === 'autoPrompt' ? autoPrompts.get(result.jobId) : undefined);
      } break;
      case 'cancelAutoPrompt': if (options.autoPrompts) return options.autoPrompts.cancel(args[0] as string); break;
      case 'secretCall': {
        const secrets = options.secrets; if (!secrets) break;
        const operation = args[0];
        if (operation === 'control') return secrets.control(String(args[1]), record(args[2]), args[3] as SecretTarget | undefined, args[4] === true);
        if (operation === 'peers') return secrets.peers();
        if (operation === 'device') return secrets.device();
        if (operation === 'poll') return { requests: secrets.poll(String(args[1])) };
        if (operation === 'answer') return secrets.answer(String(args[1]), args[2] as RemoteSecretRequest);
        if (operation === 'deliver') { secrets.deliver(String(args[1]), args[2] as RemoteSecretResponse); return { delivered: true }; }
        if (operation === 'target' || operation === 'connection-notice') {
          const session = options.runs.getSession(String(args[1]));
          if (!session || coordinator(session.id)) throw new TowerError('not-found', 'Not found.');
          await options.exclusions?.reload();
          if (options.exclusions && await options.exclusions.excludesNow(session.cwd)) throw new TowerError('not-found', 'Not found.');
          if (operation === 'connection-notice') {
            const target = await secrets.peekTarget(session.id);
            if (!target || target.taskId !== args[2]) throw new TowerError('forbidden', 'Secret task no longer matches.');
            secrets.notifyConnection(target);
            return { notified: true };
          }
          return secrets.remoteTarget(session.id, args[2] !== false);
        }
        if (operation === 'close-session') { await secrets.endSession(String(args[1])); return { closed: true }; }
        break;
      }
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
        const admitted = args[2] === undefined ? undefined : admit(args[2]);
        const controllerId = admitted?.origin?.controllerId;
        const operation = args[0] as OperationName;
        if (!Object.hasOwn(OPERATIONS, operation)) throw new TowerError('not-found', 'Unknown API operation.');
        const validate = () => { admitted?.validate?.(); const storage = options.storage?.(); if (OPERATIONS[operation].write && storage && !storage.admissionOpen) throw new TowerError('unavailable', storage.reason, { disposition: 'not-admitted' }); };
        validate();
        return options.api.call(args[0], args[1], controllerId ? { kind: 'owner', via: 'remote', controllerId } : { kind: 'owner', via: 'ui' }, admitted?.requestId, { delegation: admitted?.delegation, validate });
      } break;
      case 'slackTool': if (options.slack) return options.slack.tool(args[0] as string, args[1] as string, args[2] as Record<string, unknown>); break;
      case 'skillsOverview': if (options.skills) return options.skills.overview(record(args[0])); break;
      case 'skillsDetail': if (options.skills) return options.skills.detail(record(args[0])); break;
      case 'skillsSummary': if (options.skills) return options.skills.summary(); break;
      case 'skillsMutate': if (options.skills) return options.skills.mutate(String(args[0]), record(args[1])); break;
      case 'skillsExport': if (options.skills) return options.skills.exportBundle(record(args[0])); break;
      case 'skillsImportPlan': if (options.skills) return options.skills.importPlan(args[0]); break;
      case 'skillsBackup': if (options.skills) return options.skills.backup(); break;
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
    throw new TowerError('invalid', 'Unknown runner operation.');
  };
  const mcpApi = () => options.api && new Proxy(options.api, { get(target, property, receiver) {
    if (property !== 'call') return Reflect.get(target, property, receiver);
    return (...args: Parameters<TowerApi['call']>) => {
      const operation = args[0] as OperationName;
      if (typeof operation !== 'string' || !Object.hasOwn(OPERATIONS, operation)) throw new TowerError('invalid', 'Unknown API operation.');
      const previous = args[4];
      const validate = () => { previous?.validate?.(); const storage = options.storage?.(); if (OPERATIONS[operation].write && storage && !storage.admissionOpen) throw new TowerError('unavailable', storage.reason, { disposition: 'not-admitted' }); };
      validate();
      return target.call(args[0], args[1], args[2], args[3], { ...previous, validate });
    };
  } });
  const mcp = { api: mcpApi(), capabilities, secretTools: options.secrets ? SECRET_TOOLS : undefined, secretTool: options.secrets ? (capability: Extract<Capability, { kind: 'secret-run' }>, name: string, args: Record<string, unknown>) => options.secrets!.tool(capability, name, args) : undefined, slackTool: options.slack ? (workflowId: string, name: string, args: Record<string, unknown>) => options.slack!.tool(workflowId, name, args) : undefined,
    githubTool: options.github ? (workflowId: string, name: string, args: Record<string, unknown>) => options.github!.tool(workflowId, name, args) : undefined,
    heartbeatAllowed: (run: Run) => { const origin = options.runs.sessionOrigin(run.sessionId); return !origin?.untrustedInput && (!origin || origin.kind === 'owner'); },
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
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { method?: unknown; name?: unknown; arguments?: unknown };
        const storage = options.storage?.();
        if (storage && !storage.admissionOpen && body.method !== 'tools/list') {
          const operation = typeof body.name === 'string' ? (Object.keys(OPERATIONS) as OperationName[]).find(name => name.replace('.', '_') === body.name) : undefined;
          if (!operation || OPERATIONS[operation].write || !storage.sessionsAvailable && operation.startsWith('sessions.')) throw new TowerError('unavailable', storage.reason, { disposition: 'not-admitted' });
        }
        reply = { result: await handleMcpRequest(mcp, capability, body) ?? null };
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
        if (Array.isArray(cursor)) throw new TowerError('invalid', 'Invalid terminal cursor.');
        options.terminals.attach(terminalMatch[1], sseSink(res), cursor);
      } catch (error) { res.writeHead(statusOf(error) || 500); res.end(); }
      return;
    }
    if (req.method !== 'POST' || req.url !== '/rpc') { res.writeHead(404); res.end(); return; }
    lastRequest = Date.now(); pending++;
    const reply: RunnerReply = { protocol: RUNNER_PROTOCOL, stateDir: paths.stateDir, instance };
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_RPC_BYTES) throw new TowerError('too-large', 'Runner request too large.');
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { protocol?: number; method?: string; args?: unknown[]; instance?: string; revision?: number };
      if (input.protocol !== RUNNER_PROTOCOL || typeof input.method !== 'string' || !Array.isArray(input.args) || (input.instance && input.instance !== instance)) {
        throw new TowerError('conflict', 'Incompatible runner request.');
      }
      reply.result = await dispatch(input.method, input.args);
      // Keystrokes, resizes and attachment downloads do not change run state.
      // Keep their replies small; the regular snapshot poll publishes engine changes.
      if (input.method !== 'slackTool' && (input.instance !== instance || (input.method === 'snapshot' ? input.revision !== revision : !SNAPSHOT_FREE_OPERATIONS.has(input.method)))) reply.snapshot = snapshot();
    } catch (error) {
      const value = error as { message?: string; disposition?: string };
      reply.error = { message: value.message ?? 'Runner operation failed.', statusCode: statusOf(error) ?? 500, ...(value.disposition ? { disposition: value.disposition } : {}) };
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
  options.sessionTasks?.on('change', changed);
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  let handoffTimer: ReturnType<typeof setInterval> | undefined;
  let stopKeeping: (() => Promise<void>) | undefined;
  // Status alone is not enough: a cancelled turn may still be closing its provider process.
  const quiet = (ownedControlRequests = 0) => pending === ownedControlRequests && !options.runs.busy() && !options.autoPrompts?.busy()
    && (options.storage && !options.storage().admissionOpen || !options.autoPrompts?.list().some(job => !['completed', 'error', 'cancelled'].includes(job.status)))
    && !options.terminals?.hasActive()
    // A forced update hands queued turns and the workflows waiting on them to the successor; otherwise a continuation
    // scheduled for later is saved and delivered by the successor, but nothing due soon or underway may be left behind.
    && (options.storage && !options.storage().admissionOpen ? !(options.storageBusy ?? options.transient ?? options.inFlight)?.() && !options.runs.list().some(run => run.status === 'running' || run.approvals?.length) : forced ? !(options.transient ?? options.inFlight)?.() : !options.runs.hasWorkWithin(5 * 60 * 1000) && !options.inFlight?.());
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
    if (!handoff.held && !handoff.patient && Date.now() - handoff.requestedAt >= (options.handoffHoldMs ?? 6 * 60 * 60 * 1000)) { handoff.held = true; options.holdIntake?.(); }
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
      const handoffRecord = { previous: instance, successor: nonce, version: APP_VERSION, clean: true as const, at: new Date().toISOString(), ...(options.storage && !options.storage().admissionOpen ? { storageTransition: true } : {}), ...(handoff.rollbackFence ? { rollbackFence: handoff.rollbackFence } : {}) };
      await writeHandoff(paths.runtime, handoffRecord);
      await options.closeStorage?.();
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
    let carry: Buffer | undefined;
    // State the successor may do without never stands in the way of starting it.
    try { carry = options.handoffCarry?.(); } catch { console.error('The open vault could not be handed to the successor; it starts locked.'); }
    (options.startSuccessor ?? spawnSuccessor)(successor, nonce, carry);
    options.onHandedOff?.();
  };
  const close = async (idle = false) => {
    if (closing) return;
    closing = true;
    try {
      await Promise.all([options.runs.pauseAttachmentCleanup(), options.autoPrompts?.pauseAttachmentCleanup()]);
      if (idle) await options.onIdle?.();
      // Keep the authenticated diagnosis and lock until the database has acknowledged close or actually exited.
      await options.closeStorage?.();
      await stopKeeping?.();
      if (idleTimer) clearInterval(idleTimer);
      if (handoffTimer) clearInterval(handoffTimer);
      options.runs.off('change', changed); options.sessions.off('change', changed); options.autoPrompts?.off('change', changed); options.triggers?.off('change', changed); options.publicAgents?.off('change', changed);
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await unlink(paths.socket).catch(() => {});
      await unlink(paths.token).catch(() => {});
      await release();
    } catch (error) {
      closing = false;
      options.onCloseFailure?.(error);
      options.resume?.();
      throw error;
    }
  };
  try {
    await unlink(paths.socket).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    await unlink(paths.token).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    await writeFile(paths.token, token, { flag: 'wx', mode: 0o600 });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(paths.socket, () => { server.off('error', reject); resolve(); }); });
    await chmod(paths.socket, 0o600);
    stopKeeping = keepEndpoint({ socket: paths.socket, token: paths.token, value: token });
    handoffTimer = setInterval(() => { void handOff().catch(error => console.error('Worker handoff remains held:', error)); }, 1000);
    handoffTimer.unref();
    {
      idleTimer = setInterval(() => {
        // A handoff past its quiet check owns shutdown until it hands off or resumes: the state stays locked meanwhile.
        if (!options.onIdle || closing || draining || pending || Date.now() - lastRequest < (options.idleMs ?? 30_000)) return;
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
    // An adopted engine keeps running after its previous host closes, which paused these timers.
    if (!options.storage || options.storage().admissionOpen) {
      options.runs.resumeAttachmentCleanup();
      options.autoPrompts?.resumeAttachmentCleanup();
    }
    return { instance, socketPath: paths.socket, close, activate: (next: RunnerHostOptions) => {
      Object.assign(options, next);
      capabilities = options.capabilities ?? capabilities;
      Object.assign(mcp, { api: mcpApi(), capabilities, secretTools: options.secrets ? SECRET_TOOLS : undefined,
        secretTool: options.secrets ? (capability: Extract<Capability, { kind: 'secret-run' }>, name: string, args: Record<string, unknown>) => options.secrets!.tool(capability, name, args) : undefined,
        slackTool: options.slack ? (workflowId: string, name: string, args: Record<string, unknown>) => options.slack!.tool(workflowId, name, args) : undefined,
        githubTool: options.github ? (workflowId: string, name: string, args: Record<string, unknown>) => options.github!.tool(workflowId, name, args) : undefined });
      options.runs.setRunToolResolver(runToolResolver({ stateDir: options.stateDir, runs: options.runs, slack: options.slack, github: options.github, capabilities, secrets: options.secrets }));
      options.autoPrompts?.on('change', changed); options.triggers?.on('change', changed); options.publicAgents?.on('change', changed);
      changed();
    } };
  } catch (error) { await close(); throw error; }
}

/** Only the page fields leave the worker; the native file path stays private. */
async function sessionHistory(sessions: SessionService, [nativeId, before, limit]: unknown[]): Promise<SessionHistoryPage | undefined> {
  if (typeof nativeId !== 'string' || !nativeId || nativeId.length > 512) throw new TowerError('invalid', 'Invalid session history request.');
  const page = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const history = await sessions.detail(nativeId, page(before), page(limit));
  if (!history) return undefined;
  return { messages: history.messages, hasMore: history.hasMore, ...(history.nextBefore !== undefined ? { nextBefore: history.nextBefore } : {}), ...(history.previousUser ? { previousUser: history.previousUser } : {}), ...(history.skipped !== undefined ? { skipped: history.skipped } : {}) };
}

/**
 * The web connection is the only RPC caller. It admits the owner's own requests, or work an owner
 * turn's agent asked for. Trigger and Slack origins are assigned inside the worker, never over RPC.
 */
function admission(value: unknown): RunAdmission {
  const input = value && typeof value === 'object' ? value as { autoPromptId?: string; origin?: unknown; requestId?: unknown; heartbeat?: unknown } : {};
  const origin = input.origin === undefined ? { kind: 'owner' as const } : parseRunOrigin(input.origin);
  if (!origin || (origin.kind !== 'owner' && origin.kind !== 'agent')) throw new TowerError('invalid', 'The web connection can only admit owner or agent work.');
  if (input.requestId !== undefined && (typeof input.requestId !== 'string' || !/^[a-f\d-]{36}$/i.test(input.requestId))) throw new TowerError('invalid', 'Invalid request ID.');
  let heartbeat: HeartbeatAdmission | undefined;
  if (input.heartbeat !== undefined) {
    const value = record(input.heartbeat);
    if (origin.kind !== 'agent' || origin.controllerId || Object.keys(value).some(key => !['targets', 'checkId', 'sessionIds', 'latestRunId', 'updatedAt', 'lastRequestAt'].includes(key))
      || (value.targets !== undefined && (!Array.isArray(value.targets) || !value.targets.length || value.targets.length > 6 || value.targets.some(entry => {
        const target = record(entry);
        return Object.keys(target).some(key => !['taskId', 'sessionId', 'node', 'nativeRequestId', 'latestRunId', 'lastRequestAt'].includes(key)) || typeof target.taskId !== 'string' || !target.taskId || target.taskId.length > 200
          || (target.nativeRequestId !== undefined && (typeof target.nativeRequestId !== 'string' || !target.nativeRequestId || target.nativeRequestId.length > 200))
          || (target.latestRunId !== undefined && (typeof target.latestRunId !== 'string' || !target.latestRunId || target.latestRunId.length > 200))
          || (target.lastRequestAt !== undefined && (typeof target.lastRequestAt !== 'string' || !Number.isFinite(Date.parse(target.lastRequestAt))))
          || typeof target.sessionId !== 'string' || !target.sessionId || target.sessionId.length > 200 || (target.node !== undefined && (typeof target.node !== 'string' || !/^[a-f\d]{32}$/i.test(target.node)));
      })))
      || !Array.isArray(value.sessionIds) || !value.sessionIds.length || value.sessionIds.length > 7 || value.sessionIds.some(id => typeof id !== 'string' || id.length > 200)
      || typeof value.checkId !== 'string' || !/^[a-f\d-]{36}$/i.test(value.checkId)
      || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
      || (value.latestRunId !== undefined && (typeof value.latestRunId !== 'string' || value.latestRunId.length > 200))
      || (value.lastRequestAt !== undefined && (typeof value.lastRequestAt !== 'string' || !Number.isFinite(Date.parse(value.lastRequestAt))))) throw new TowerError('invalid', 'Invalid heartbeat admission.');
    heartbeat = value as unknown as HeartbeatAdmission;
  }
  return { ...(heartbeat ? { heartbeat } : {}), ...(input.autoPromptId !== undefined ? { autoPromptId: input.autoPromptId } : {}), origin,
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
    const coordinators = new Set(slack?.coordinatorSessionIds() ?? []);
    return projected.filter(session => !finished.has(session.id) && !coordinators.has(session.id)).map(session => closed.apply(titles.apply(session)));
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
  // Read once, before anything is started: children of this worker must inherit neither the proof nor its stdin.
  const handoffNonce = process.env.TOWER_HANDOFF && /^[a-f\d]{32}$/.test(process.env.TOWER_HANDOFF) ? process.env.TOWER_HANDOFF : undefined;
  delete process.env.TOWER_HANDOFF;
  let carry = handoffNonce ? await readHandoffCarry(process.stdin) : undefined;
  let release: () => Promise<void>;
  try { release = await acquireStateLock(paths.runtime, 0); }
  catch (error) { carry?.fill(0); if (error instanceof MonitorAlreadyRunning) return; throw error; }
  const bundle = await captureStorageBundle();
  const build = storageBuildContext(bundle);
  let preflight = await preflightStorage({ bundle, stateDir });
  const managed = await managedByService(stateDir, process.argv[1], true);
  const evaluate = () => evaluateStorageUpdate({ stateDir, managed,
    build: { version: APP_VERSION, preflight, ...(build.ok ? { manifest: build.manifest } : {}) } });
  let evaluation = await evaluate();
  let storageStatus: WorkerStorageStatus = { state: 'starting', code: 'starting', reason: 'Storage is starting.', admissionOpen: false, sessionsAvailable: false, healthStatus: 200,
    ...(build.ok ? { identity: build.identity } : {}) };
  let database: StorageClient | undefined;
  let storageEffects: (() => Promise<void>) | undefined;
  let maintenanceHeld: Promise<void> = Promise.resolve();
  let storageHoldGeneration = 0;
  const sessions = new SessionService({ launchProofs: join(stateDir, 'agent-launches.json'), launchMarks: launchMarksDir(stateDir) });
  await sessions.quiesce();
  const terminals = new WorkspaceTerminals({ keepAliveOnDisconnect: true });
  const runOptions: ConstructorParameters<typeof RunManager>[0] = { stateDir, getSession: id => sessions.get(id), refreshSessions: () => sessions.refresh(true),
    latestUserMessage: id => latestNativeUserMessage(runs, id, nativeId => sessions.detail(nativeId, undefined, 200)),
    openCodexBridge: options => openCodexBridgeRun({ ...options, codexHome: sessions.codexHome }), trustWorkspace, holdUntilReady: true };
  const runs: RunManager = new RunManager(runOptions);
  runs.holdStorage();
  const startupHolds: Array<() => void | Promise<void>> = [];
  const startupBusy: Array<() => boolean> = [];
  let republishCold: (() => void) | undefined;
  const startupResumes: Array<() => void> = [];
  const registerStorageHold = (hold: () => void | Promise<void>, resume: () => void, busy?: () => boolean) => { if (busy) startupBusy.push(busy); startupHolds.push(hold); startupResumes.push(resume); if (storageStatus.state !== 'ready') { const held = hold(); maintenanceHeld = Promise.all([maintenanceHeld, held]).then(() => undefined); } };
  const unavailable = (reported?: ReturnType<StorageClient['status']>) => {
    storageHoldGeneration += 1;
    const status = reported ?? database?.status();
    storageStatus = { ...storageStatus, state: 'unavailable', code: status?.failure?.code ?? 'not-ready',
      reason: status?.failure?.message ?? 'Storage is unavailable.', admissionOpen: false, healthStatus: 503,
      ...(status?.failure ? { failure: { ...status.failure, ...(['thread-exited', 'deadline-exceeded'].includes(status.failure.code) ? { disposition: 'unknown' as const } : {}) } } : {}) };
    runs.holdStorage();
    const held = startupHolds.map(hold => hold());
    maintenanceHeld = Promise.all([maintenanceHeld, ...held, storageEffects?.()]).then(() => undefined);
    void maintenanceHeld.catch(error => console.error('Storage hold has unfinished maintenance:', error));
  };
  let heldRollbackFence: RollbackFence | undefined;
  let rollbackPrepareRefusal: { code: 'migration-required'; disposition: 'not-committed' } | undefined;
  const releaseAllowed = async (generation: number, fence: RollbackFence | undefined): Promise<boolean> => {
    if (fence) {
      const read = await readRollbackRecord(stateDir);
      if (read.state !== 'present' || read.record.id !== fence.id || read.record.attempt?.n !== fence.attempt || read.record.held || !['completed', 'failed', 'withdrawn'].includes(read.record.state)) return false;
    }
    return generation === storageHoldGeneration;
  };
  const attempt = async (reopen = false): Promise<boolean> => {
    const generation = storageHoldGeneration, fence = heldRollbackFence;
    if (!await releaseAllowed(generation, fence) || generation !== storageHoldGeneration) return false;
    const nextPreflight = await preflightStorage({ bundle, stateDir });
    if (generation !== storageHoldGeneration) return false;
    preflight = nextPreflight;
    const nextEvaluation = await evaluate();
    if (generation !== storageHoldGeneration) return false;
    evaluation = nextEvaluation;
    const health = storageHealth(evaluation);
    storageStatus = { ...storageStatus, state: evaluation.verdict === 'refused' ? 'unavailable' : evaluation.verdict === 'ready' ? 'starting' : evaluation.verdict,
      code: evaluation.code, reason: evaluation.reason, healthStatus: health.status, admissionOpen: false };
    if (!evaluation.importAllowed) {
      const read = await readRollbackRecord(stateDir);
      if (generation !== storageHoldGeneration) return false;
      // A fenced target may inspect and claim existing storage, but must never create its schema while held.
      if (build.ok && evaluation.code === 'rollback-handoff' && read.state === 'present' && read.record.target === build.identity.appVersion && read.record.sourceHash === build.identity.sourceHash && read.record.held && read.record.switched) {
        try {
          if (!database) database = await openStorage({ stateDir, bundle, onUnavailable: unavailable });
          else if (reopen && database.status().state !== 'ready') await database.reopen();
          const inspection = await database.inspect();
          if (!databaseSupported({ format: 'tower-artifact-storage-contract', version: 1, appVersion: build.identity.appVersion, identity: build.identity, manifest: build.manifest, supported: preflight.supported }, inspection).ok) return false;
          try { if (database.status().ownerEpoch === undefined) await database.prepare({ allowMigration: false }); }
          catch (error) { if (inspection.schema.kind === 'empty' && error instanceof StorageCommandError && error.code === 'migration-required' && error.disposition === 'not-committed') rollbackPrepareRefusal = { code: 'migration-required', disposition: 'not-committed' }; else throw error; }
        } catch (error) { if (generation === storageHoldGeneration) unavailable(); console.error('Rollback target diagnosis remains held:', error); }
      }
      return false;
    }
    try {
      if (!database) database = await openStorage({ stateDir, bundle, onUnavailable: unavailable });
      else if (reopen && database.status().state !== 'ready') await database.reopen();
      if (generation !== storageHoldGeneration) return false;
      if (database.status().state !== 'ready') { unavailable(); return false; }
      const commandId = bootstrapPrepareCommandId(await readRollbackRecord(stateDir), (await database.inspect()).schema.kind, build.ok ? build.identity : { appVersion: APP_VERSION, sourceHash: '' });
      if (generation !== storageHoldGeneration) return false;
      const prepared = await database.prepare({ allowMigration: !reopen || Boolean(commandId), ...(commandId ? { commandId } : {}) });
      const gate = await database.gate('core');
      if (generation !== storageHoldGeneration) return false;
      if (!gate.open) {
        storageStatus = { ...storageStatus, state: 'recovery-required', code: 'storage-gate-held', reason: gate.reasons.join(', '), healthStatus: 200 };
        return false;
      }
      if (build.ok) await recordPreparationEvidence(stateDir, { context: build, preflight, prepared, gate });
      if (generation !== storageHoldGeneration) return false;
      const finalGate = await database.gate('core');
      if (!await releaseAllowed(generation, fence) || generation !== storageHoldGeneration) return false;
      if (!finalGate.open || database.status().state !== 'ready') { unavailable(); return false; }
      rollbackPrepareRefusal = undefined;
      storageStatus = { ...storageStatus, state: 'ready', code: 'ready', reason: 'Storage is ready.', healthStatus: 200 };
      heldRollbackFence = undefined;
      delete storageStatus.failure;
      return true;
    } catch (error) {
      if (generation !== storageHoldGeneration) return false;
      unavailable();
      if (error instanceof StorageCommandError) storageStatus = { ...storageStatus, code: error.code, reason: error.message, failure: { phase: error.phase, code: error.code, message: error.message, retryable: error.retryable, sourcePreserved: database?.status().failure?.sourcePreserved ?? storageStatus.failure?.sourcePreserved ?? false, at: new Date().toISOString(), disposition: error.disposition } };
      console.error('Storage preparation remains held:', error); return false;
    }
  };
  const closeStorage = async () => { try { await database?.close(); } catch (error) { unavailable(); throw error; } };
  let recoveryBusy = false;
  const storageRecovery: NonNullable<RunnerHostOptions['storageRecovery']> = async (action, input) => {
    if (!build.ok) throw new TowerError('unavailable', build.failure.message);
    if (action === 'barrier') return readRecoveryBarrier(stateDir);
    if (recoveryBusy) throw new TowerError('conflict', 'A storage recovery command is underway.');
    if (!['snapshot', 'adopt', 'reconcile', 'verify-update'].includes(action)) throw new TowerError('invalid', 'Unknown storage recovery action.');
    recoveryBusy = true;
    try {
      if (action === 'verify-update') {
        if (!['overwritten-done', 'own-failed', 'stale-active'].includes(String(input.kind)) || typeof input.by !== 'string' || typeof input.evidence !== 'string') throw new TowerError('invalid', 'Update verification needs a valid kind, owner and evidence.');
        preflight = await preflightStorage({ bundle, stateDir });
        let cutoverMarkers: 'absent' | 'present' | 'unknown' = 'unknown';
        const domains = build.manifest.domains.filter(domain => domain.cutover);
        if (domains.length && preflight.supported && preflight.state?.database === 'present' && !preflight.state.problem) {
          // Inspection claims neither ownership nor schema; a missing known DB is never opened to prove absence.
          if (!database) database = await openStorage({ stateDir, bundle, onUnavailable: unavailable });
          else if (database.status().state !== 'ready') await database.reopen();
          const inspection = await database.inspect();
          if (databaseSupported({ format: 'tower-artifact-storage-contract', version: 1, appVersion: APP_VERSION, identity: build.identity, manifest: build.manifest, supported: preflight.supported }, inspection).ok) cutoverMarkers = inspection.authority.some(marker => domains.some(domain => domain.scope === marker.domain)) ? 'present' : 'absent';
        }
        return await recordUpdateRecoveryReceipt({ stateDir, managed, cutoverMarkers, build: { version: APP_VERSION, preflight, manifest: build.manifest }, kind: input.kind as RecoveryReceiptKind, by: input.by, evidence: input.evidence });
      }
      if (action === 'snapshot') {
        if (!database || !storageStatus.admissionOpen) throw new TowerError('unavailable', 'Storage is held.');
        return await database.snapshot();
      }
      if (action === 'adopt' && (typeof input.snapshotId !== 'string' || typeof input.reason !== 'string')) throw new TowerError('invalid', 'Snapshot adoption needs an ID and reason.');
      if (action === 'reconcile' && (typeof input.barrierId !== 'string' || !Array.isArray(input.scopes) || !input.scopes.every(scope => typeof scope === 'string') || typeof input.by !== 'string' || typeof input.evidence !== 'string')) throw new TowerError('invalid', 'Recovery reconciliation needs named scopes, owner and evidence.');
      storageHoldGeneration += 1;
      runs.holdStorage(); storageStatus.admissionOpen = false;
      storageStatus = { ...storageStatus, state: 'recovery-required', code: 'owner-recovery', reason: 'Owner recovery holds durable effects.' };
      maintenanceHeld = Promise.all([maintenanceHeld, ...startupHolds.map(hold => hold()), storageEffects?.()]).then(() => undefined);
      await maintenanceHeld;
      if (action === 'adopt') {
        await closeStorage();
        return await adoptSnapshot(stateDir, { snapshotId: input.snapshotId as string, reason: input.reason as string, context: build });
      }
      return await reconcileRecovery(stateDir, { barrierId: input.barrierId as string, scopes: input.scopes as string[], by: input.by as string, evidence: input.evidence as string, context: build });
    } finally { recoveryBusy = false; }
  };
  let ready = await attempt();
  let diagnosticHost: Awaited<ReturnType<typeof startRunnerHost>> | undefined;
  const previousHandoff = handoffNonce ? await readHandoff(paths.runtime) : undefined;
  const diagnosticTransition = !ready || (previousHandoff?.successor === handoffNonce && previousHandoff?.storageTransition === true);
  let retryNormal: (() => Promise<WorkerStorageStatus>) | undefined;
  let retryRuntime: (() => Promise<WorkerStorageStatus>) | undefined;
  let releaseRequested: RollbackFence | undefined;
  let acceptedHandoff: RollbackFence | undefined;
  const control: NonNullable<RunnerHostOptions['storageControl']> = (action, input, host) => storageControl({ stateDir, client: () => database,
    hold: async reason => { storageHoldGeneration += 1; const fence = input.fence as RollbackFence; heldRollbackFence = { id: fence.id, attempt: fence.attempt }; releaseRequested = undefined; runs.holdStorage(); storageStatus = { ...storageStatus, admissionOpen: false, state: 'recovery-required', code: 'rollback-held', reason }; maintenanceHeld = Promise.all([maintenanceHeld, ...startupHolds.map(hold => hold()), storageEffects?.()]).then(() => undefined); await maintenanceHeld; },
    release: async () => { storageHoldGeneration += 1; const fence = input.fence as RollbackFence; heldRollbackFence = { id: fence.id, attempt: fence.attempt }; releaseRequested = { ...heldRollbackFence }; },
    quiet: host.quiet, handoff: (command, fence) => { host.handoff(command, fence); acceptedHandoff = fence; }, acceptedFence: () => acceptedHandoff, prepareRefusal: rollbackPrepareRefusal,
    ...(previousHandoff && previousHandoff.successor === handoffNonce && previousHandoff.rollbackFence ? { successorFence: previousHandoff.rollbackFence } : {}),
  })(action, input);
  const releaseCommitted = async () => {
    const fence = releaseRequested;
    if (!fence) return false;
    const read = await readRollbackRecord(stateDir);
    return read.state === 'present' && read.record.id === fence.id && read.record.attempt?.n === fence.attempt && !read.record.held && ['completed', 'failed', 'withdrawn'].includes(read.record.state);
  };
  if (!ready) {
    let wake: (() => void) | undefined;
    let trying = false;
    const retry = async () => {
      if (retryNormal) return retryNormal();
      if (trying || recoveryBusy) return storageStatus;
      trying = true;
      try { ready = await attempt(Boolean(database)); if (ready) wake?.(); return storageStatus; }
      finally { trying = false; }
    };
    diagnosticHost = await startRunnerHost({ stateDir, sessions, runs, terminals, releaseStateLock: release, handoffNonce,
      storageBusy: () => recoveryBusy || startupBusy.some(busy => busy()), storage: () => storageStatus, retryStorage: retry, storageRecovery, storageControl: control, closeStorage, onCloseFailure: () => unavailable(), quiesce: () => sessions.quiesce(),
      onHandedOff: () => { carry?.fill(0); sessions.stop(); setTimeout(() => process.exit(0), 100); } });
    // Only verification completion is polled. A DB/runtime failure never retries itself.
    const timer = setInterval(() => { void (async () => {
      if (storageStatus.state === 'update-held') { await retry(); return; }
      if (!await releaseCommitted()) return;
      const fence = releaseRequested;
      try { await retry(); } finally { if (releaseRequested === fence) releaseRequested = undefined; }
    })().catch(error => console.error('Storage update diagnosis:', error)); }, 1000);
    try { await new Promise<void>(resolve => { wake = resolve; if (ready) resolve(); }); }
    finally { clearInterval(timer); }
  }
  const requireEffects = async () => {
    if (storageStatus.state !== 'ready' || !database || !(await database.gate('core')).open || storageStatus.state !== 'ready') throw new TowerError('unavailable', storageStatus.reason, { disposition: 'not-admitted' });
  };
  const startupGate = async () => {
    const generation = storageHoldGeneration;
    // Park at this await, before the next startup effect. Retrying the whole startup would replay restores
    // and services already running; only this continuation may resume after the owner's successful retry.
    try {
      if (storageStatus.state === 'ready' && database) {
        const gate = await database.gate('core');
        if (gate.open && storageStatus.state === 'ready' && generation === storageHoldGeneration) return;
        if (storageStatus.state === 'ready') storageStatus = { ...storageStatus, state: 'recovery-required', code: 'storage-gate-held', reason: gate.reasons.join(', '), admissionOpen: false };
      }
    } catch (error) {
      // This catch covers only the actual storage await, never unrelated service initialization.
      unavailable(); storageStatus.reason = error instanceof Error ? error.message : String(error);
      if (error instanceof StorageCommandError) storageStatus = { ...storageStatus, code: error.code, failure: { phase: error.phase, code: error.code, message: error.message, retryable: error.retryable, sourcePreserved: database?.status().failure?.sourcePreserved ?? false, at: new Date().toISOString(), disposition: error.disposition } };
      console.error('Startup storage gate remains held:', error);
    }
    runs.holdStorage();
    maintenanceHeld = Promise.all([maintenanceHeld, ...startupHolds.map(hold => hold())]).then(() => undefined);
    const previousRetry = retryNormal;
    const resumed = new Promise<void>(resolve => {
      let retrying = false;
      retryNormal = async () => {
        if (retrying || recoveryBusy) return storageStatus;
        retrying = true;
        try {
          if (previousRetry && previousRetry === retryRuntime) {
            const status = await previousRetry();
            if (status.admissionOpen) resolve();
            return status;
          }
          const generation = storageHoldGeneration, fence = heldRollbackFence;
          if (await attempt(Boolean(database))) { await maintenanceHeld; if (!await releaseAllowed(generation, fence) || generation !== storageHoldGeneration) return storageStatus; for (const resume of startupResumes) resume(); resolve(); }
          return storageStatus;
        }
        finally { retrying = false; }
      };
    });
    if (!diagnosticHost) diagnosticHost = await startRunnerHost({ stateDir, sessions, runs, terminals, releaseStateLock: release, handoffNonce, storage: () => storageStatus, retryStorage: () => retryNormal!(), storageRecovery, storageControl: control, closeStorage, onCloseFailure: () => unavailable(),
      storageBusy: () => recoveryBusy || startupBusy.some(busy => busy()),
      quiesce: async () => { await maintenanceHeld; await sessions.quiesce(); await runs.flushState(); }, resume: () => { if (storageStatus.sessionsAvailable) sessions.resume(); }, onHandedOff: () => { sessions.stop(); setTimeout(() => process.exit(0), 100); } });
    republishCold?.(); if (storageStatus.sessionsAvailable) sessions.resume();
    await resumed;
    // The last startup gates run after the full runtime retry handler has been installed.
    if (previousRetry) retryNormal = previousRetry;
  };
  // Gate(core), not prepare's claim, precedes every restore and startup effect.
  await startupGate();
  const restoring = await takeWorkerRestore(stateDir).catch(error => { console.error(`A waiting restore was not applied: ${error instanceof Error ? error.message : String(error)}`); return undefined; });
  // Only the Tower on the account's own state folder keeps its Claude Code and Codex current, so two never update one install.
  // It is there even with automatic updates off: an install a previous worker left running is still waited for.
  const tools = resolve(stateDir) === resolve(defaultStateDir()) ? new ToolUpdates({ stateDir, env: process.env,
    // npm replaces files as it goes: then no session of that CLI may be working anywhere, in Tower's terminals included.
    hold: (provider, quiet) => quiet && sessions.list().some(session => session.provider === provider && session.status === 'working') ? undefined : runs.holdProvider(provider) }) : undefined;
  let initializedAutoPrompts: AutoPromptManager | undefined;
  let initializedRetention: RetentionService | undefined;
  let retentionBootstrapError: unknown;
  let retentionBootstrapIssues: string[] = [];
  const nativeRoots = { claude: [join(sessions.claudeHome, 'projects')], codex: [join(sessions.codexHome, 'sessions'), join(sessions.codexHome, 'archived_sessions')] };
  const retentionStore = new RetentionStore(join(stateDir, 'retention'), { storage: database });
  const retentionArchive = new RetentionArchive(join(stateDir, 'retention-cold'), [...nativeRoots.claude, ...nativeRoots.codex], [join(stateDir, 'retention-originals')]);
  const nativeRetention = createNativeRetentionAdapter(nativeRoots, { coldRoot: join(stateDir, 'retention-originals'), codexHome: sessions.codexHome, claudeHome: sessions.claudeHome });
  let publishedMembers: ReturnType<RetentionStore['list']>[number]['members'] = [];
  const publishCold = () => {
    let allMembers = retentionStore.list().flatMap(entry => entry.members || []);
    if (storageStatus.state !== 'ready') {
      const retained = new Map((publishedMembers || []).map(member => [`${member.operationId}:${member.sessionId}`, member]));
      for (const member of allMembers) if (member.state === 'cold' || !retained.has(`${member.operationId}:${member.sessionId}`)) retained.set(`${member.operationId}:${member.sessionId}`, member);
      allMembers = [...retained.values()];
    }
    publishedMembers = allMembers;
    runs.setRetentionLineage(allMembers,sessions.retentionRecords().launchers);
    const members = allMembers.filter(member => member.state === 'cold');
    sessions.setColdRegistry(members.flatMap(member => [member.originalPath, ...(member.coldPath ? [member.coldPath] : [])]), allMembers.filter(member => member.state !== 'restored').map(member => `${member.provider}:${member.nativeId}`), async () => { if (storageStatus.state !== 'ready') return { complete: false, issues: ['storage-held'] }; await initializedRetention?.reconcileCold(); const issues = initializedRetention?.coldInspectionIssues() || (retentionBootstrapError ? ['cold-registry-bootstrap-failed'] : retentionBootstrapIssues); return { complete: !issues.length, issues }; });
    runs.setColdSessions(members.map(member => member.sessionId), id => initializedRetention ? initializedRetention.restoreSession(id) : Promise.reject(new Error('Retention is not ready.')));
  };
  republishCold = publishCold;
  let temporaryReferences = (): string[] => [];
  const temporary = new TemporaryCollector({ protection: async () => {
    const inspected = await inspectTemporaryProtection();
    return { complete: inspected.complete && !sessions.scanning,
    issues: [...inspected.issues, ...(sessions.scanning ? ['session-scan-in-progress'] : [])], openedPaths: inspected.openedPaths, paths: [...inspected.paths, ...temporaryReferences(), stateDir, paths.directory,
      ...runs.sessionList(sessions.list()).filter(session => session.activeProcess || session.status === 'working' || session.scheduledAt || session.creationPending || runs.list().some(run => run.sessionId === session.id && ['queued', 'running'].includes(run.status))).map(session => session.cwd)] }; } });
  try {
    const closedSessions = new ClosedSessionStore(stateDir);
    await closedSessions.start();
    try {
      await retentionStore.start();
    } catch (error) {
      retentionBootstrapError = error;
      // The SDK routes physical SQLite failures through onUnavailable. Only a
      // healthy shared core may quarantine malformed retention metadata alone.
      if (database?.status().state === 'unavailable') unavailable(database.status());
      console.error(`Cold journal unavailable: ${String(error)}`);
    }
    if (!retentionBootstrapError) try {
      const entries = retentionStore.list();
      const members = entries.flatMap(entry => entry.members || []).filter(member => member.state !== 'restored');
      if (members.length) {
        const inspected = await nativeRetention.inspectCold(members);
        retentionBootstrapIssues = inspected.complete ? [] : inspected.issues;
        const updates = new Map(inspected.members.map(member => [`${member.operationId}:${member.sessionId}`, member]));
        const changed = entries.map(entry => ({ ...entry, members: entry.members?.map(member => updates.get(`${member.operationId}:${member.sessionId}`) || member) })).filter((entry, index) => JSON.stringify(entry) !== JSON.stringify(entries[index]));
        if (changed.length) { await startupGate(); await retentionStore.putMany(changed); }
      }
    } catch (error) { retentionBootstrapIssues = ['cold-inspection-failed']; console.error(`Cold inspection unavailable: ${String(error)}`); }
    if (diagnosticTransition && retentionBootstrapError) {
      storageStatus = { ...storageStatus, state: 'unavailable', code: 'cold-journal-unavailable', reason: String(retentionBootstrapError), healthStatus: 503 };
      if (!diagnosticHost) diagnosticHost = await startRunnerHost({ stateDir, sessions, runs, terminals, releaseStateLock: release, handoffNonce, storageBusy: () => recoveryBusy || startupBusy.some(busy => busy()), storage: () => storageStatus, retryStorage: () => retryNormal!(), storageRecovery, storageControl: control, closeStorage, onCloseFailure: () => unavailable(), quiesce: () => sessions.quiesce(), onHandedOff: () => { carry?.fill(0); sessions.stop(); setTimeout(() => process.exit(0), 100); } });
      await new Promise<void>(resolve => {
        retryNormal = async () => {
          try {
            if (!await attempt(Boolean(database))) return storageStatus;
            await retentionStore.start(); retentionBootstrapError = undefined; resolve();
          }
          catch (error) { storageStatus.reason = String(error); }
          return storageStatus;
        };
      });
    }
    await startupGate();
    publishCold();
    sessions.resume();
    await sessions.start();
    publishCold();
    storageStatus.sessionsAvailable = true;
    await startupGate();
    const shims = await installLaunchShims(stateDir).catch(error => { console.error(`Launch shims were not installed: ${error instanceof Error ? error.message : String(error)}`); return undefined; });
    if (shims) runOptions.launchMarks = { shims, marks: launchMarksDir(stateDir) };

    // Before any turn can start: a CLI still being replaced by an installer from before is held first.
    await startupGate();
    await tools?.start(autoUpdateEnabled());
    await startupGate();
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
    initializedAutoPrompts = autoPrompts;
    autoPrompts.holdStorage();
    registerStorageHold(() => autoPrompts.holdStorage(), () => { if (storageStatus.admissionOpen) autoPrompts.releaseStorage(); });
    await startupGate();
    await autoPrompts.start();
    // The owner's fast-judgment settings are read again each time, so a change on the settings page applies at once.
    const decisions = new DecisionService(stateDir);
    const slack = new SlackService({ stateDir, runs, autoPrompts, refresh: context.refresh,
      followUpEngine: async () => { await decisions.start(); return decisions.engine('slackFollowUps'); } });
    // GitHub coordinators use a trigger's credentials; the trigger engine starts right after.
    let triggerEngine: TriggerService | undefined;
    const github = new GitHubCoordinator({ stateDir, runs, autoPrompts, refresh: context.refresh, language: () => slack.language(),
      github: (triggerId, fresh) => { if (!triggerEngine) throw new Error('Triggers are still starting.'); return triggerEngine.githubClient(triggerId, fresh); } });
    registerStorageHold(() => { github.hold(); }, () => { github.release(); }, () => github.inFlight());
    coordinators = () => new Set([...slack.coordinatorSessionIds(), ...github.coordinatorSessionIds()]);
    // A delegated task's run stays until its coordinator has finished with it, across pruning and restarts.
    runs.setRetained(() => [...slack.automation.retainedRuns(), ...github.automation.retainedRuns()]);
    const capabilities = new CapabilityRegistry(capability => (capability.kind !== 'owner-run' && capability.kind !== 'caller-run' && capability.kind !== 'secret-run')
      || runs.list().some(run => run.id === capability.runId && (run.status === 'running' || run.status === 'queued')));
    capabilities.grant(await sessionToolsKey(stateDir), { kind: 'session-reader' });
    const secretService = new SecretService({ stateDir });
    await secretService.start();
    const secretStore = new SecretStore(stateDir, { vault: secretService });
    const secrets = new SecretRuntime({ stateDir, service: secretService, runs,
      onConnect: sessionId => runs.notifyToolChange(SECRET_CONNECTION_INSTRUCTIONS, sessionId),
      isClosed: async id => { const saved = new ClosedSessionStore(stateDir); await saved.start(); return saved.closedIds().has(id); },
      migrate: () => secretStore.migrate(), pendingImports: () => listPendingSecretImports(stateDir),
      importPending: (id, password) => importPendingSecret(stateDir, id, password, secretService, { openLegacy: openLegacyImport, restoreTriggers: async backup => { if (!triggerEngine) throw new Error('Triggers are still starting.'); await triggerEngine.restoreBackup(backup); } }) });
    runs.setRunToolResolver(runToolResolver({ stateDir, runs, slack, github, capabilities, secrets }));
    // The previous worker's open vault: turns restored below find it as the owner left it.
    if (carry) await secrets.adopt(carry).catch(() => { console.error('The vault handed over by the previous worker did not open; it stays locked until unlocked.'); }).finally(() => { carry?.fill(0); carry = undefined; });
    const secretExpiry = setInterval(() => { void secrets.sweep().catch(() => { console.error('Secret expiry cleanup failed; the vault remains unavailable until unlocked.'); }); }, 60_000); secretExpiry.unref();
    const visible = await runnerContext({ stateDir, runs, sessions, slack, exclusions });
    autoPrompts.updateContext(visible);
    runs.setFirstTurnNotes(async (run, session) => {
      await decisions.start();
      return relatedSessionNotes(decisions.engine('relatedSessions'), run, session, visible.allSessions(), id => sessions.recentRequests(runs.nativeSessionId(id)));
    });
    await startupGate();
    registerStorageHold(() => { slack.holdNewWork(); }, () => { slack.releaseNewWork(); }, () => slack.hasTransient());
    await slack.start();
    // Sessions created before provenance existed are classified once from surviving ledger links.
    runs.setExternalLinkResolver(ids => { const linked = slack.linkedSessions().sessionIds; return ids.some(id => linked.has(id)); });
    runs.backfillSessionOrigins(slack.linkedSessions());
    // Ports seen once stay blocked, so a web restart never opens a moment when Tower can call itself.
    const towerPorts = new Set<number>();
    const ownPorts = async () => { for (const port of await lockedPorts(stateDir)) towerPorts.add(port); return [...towerPorts]; };
    const publicAgents = new PublicAgentService({ stateDir, runs });
    await startupGate();
    registerStorageHold(() => { publicAgents.hold(); }, () => { publicAgents.release(); }, () => publicAgents.inFlight());
    await publicAgents.start();
    // Skill files live in the account's home; only the Tower on its own state folder proposes new ones.
    const skills = new SkillService({ stateDir, homes: skillHomes(stateDir), sessions: () => visible.allSessions(), runs: () => runs.list(), origin: id => runs.sessionOrigin(id),
      projects: () => (visible.snapshot().groups ?? []).map(group => group.cwd),
      history: async (session, limit) => (await sessions.detail(runs.nativeSessionId(session.id), undefined, limit))?.messages,
      model: async (request, options) => { await requireEffects(); return runAutoPromptModel(request, { stateDir, ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) }); },
      advise: resolve(stateDir) === resolve(defaultStateDir()), seed: resolve(stateDir) === resolve(defaultStateDir()),
      // Only the Tower on the account's own state folder points the agents' global instructions at itself.
      ...(resolve(stateDir) === resolve(defaultStateDir()) ? { installGuidance: async () => { await installAgentGuidance({ stateDir, claudeHome: process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), codexHome: process.env.CODEX_HOME || join(homedir(), '.codex') }); } } : {}) });
    // Skills never keep the worker from starting.
    await startupGate();
    registerStorageHold(() => { skills.pause(); }, () => { skills.resume(); }, () => skills.inFlight());
    await skills.start().catch(error => console.error(`Skills did not start: ${error instanceof Error ? error.message : String(error)}`));
    // What each conversation works on, summarized after its turns.
    const tasks = new SessionTasks({ stateDir, sessions: () => visible.allSessions(),
      history: (session, limit, before) => sessions.detail(runs.nativeSessionId(session.id), before, limit),
      model: async (request, options) => { await requireEffects(); return runAutoPromptModel(request, { stateDir, timeoutMs: options.timeoutMs }); } });
    await startupGate();
    registerStorageHold(() => { tasks.pause(); }, () => { tasks.resume(); }, () => tasks.inFlight());
    await tasks.start().catch(error => console.error(`Session tasks did not start: ${error instanceof Error ? error.message : String(error)}`));
    runs.setSessionOverlay(session => tasks.apply(session));
    runs.on('change', () => tasks.changed());
    sessions.on('change', () => tasks.changed());
    tasks.changed();
    // A conversation compacted on the owner's request into a new session of the same model and effort.
    // The master's conversation is looked up here without its mark; marked, the shared rule refuses it.
    const compactions = new SessionCompactions({ stateDir, session: id => { const found = runs.getSession(id); return found && inMasterFolder(stateDir, found.cwd) ? { ...found, master: true } : found; }, runs: () => runs.list(),
      history: (session, before, limit) => sessions.detail(runs.nativeSessionId(session.id), before, limit, { previousUser: false, fullText: true }),
      model: async (request, options) => { await requireEffects(); return runAutoPromptModel(request, { stateDir, timeoutMs: options.timeoutMs }); },
      create: (input, admission) => runs.create(input, admission),
      refuse: session => coordinators().has(session.id) ? 'Slack·GitHub 코디네이터 대화는 압축할 수 없습니다.' : undefined,
      untrusted: session => runs.sessionOrigin(session.id)?.untrustedInput === true,
      // The list as the web saved it now, the folders of the conversation and its parents looked at again (as Auto Prompt
      // and the remote router do), and the one sharing rule for a controller's view.
      remote: {
        prepare: async session => {
          await exclusions.reload();
          const chain: string[] = [];
          for (let current: Session | undefined = session, depth = 0; current && depth < 32; current = current.parentId ? runs.getSession(current.parentId) : undefined, depth++) chain.push(current.cwd);
          await exclusions.prepare(chain, { fresh: true });
        },
        visible: session => remoteSessionIds(visible.allSessions(), { matcher: exclusions.matcher(), coordinators: coordinators() }).has(session.id),
      } });
    await compactions.load();
    // Made just below; the permission service only calls it once requests arrive.
    let reviewer!: PermissionReviewer;
    // One-shot runs: the command runs in this worker; the conversation hears its end unless it already read the result.
    // A claude or codex a run starts counts as the requesting conversation's own run, never as one the owner started.
    const runner: PermissionRunner = new PermissionRunner({ stateDir, update: (id, run): Promise<void> => permissions.updateRun(id, run), env: (sessionId, env) => { if (storageStatus.state !== 'ready') throw new TowerError('unavailable', storageStatus.reason); return runs.launchEnv(sessionId, env); },
      beforeStart: async id => {
        const approved = () => permissions.overview().requests.some(request => request.id === id && request.status === 'approved' && request.run?.status === 'waiting');
        const gate = async () => {
          try { await requireEffects(); return true; }
          catch (error) { if (error instanceof TowerError && error.disposition === 'not-admitted') return false; throw error; }
        };
        if (!approved()) return false;
        if (!await gate()) return approved() ? 'defer' : false;
        if (!approved()) return false;
        // confirmReviewed itself uses the same effect gate; only that explicit refusal may defer.
        let reviewed: boolean;
        try { reviewed = await permissions.confirmReviewed(id); }
        catch (error) { if (error instanceof TowerError && error.disposition === 'not-admitted') return approved() ? 'defer' : false; throw error; }
        if (!reviewed || !approved()) return false;
        if (!await gate()) return approved() ? 'defer' : false;
        return approved();
      } });
    registerStorageHold(() => runner.holdStorage(), () => runner.releaseStorage(), () => runner.active());
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
      const own = runs.list().filter(item => item.sessionId === request.sessionId);
      if (own.some(item => item.status === 'running' || (item.status === 'queued' && !item.scheduled))) return 'later';
      // A conversation that set itself a wakeup comes back on its own and reads the result then: a message now would
      // replace that wakeup, so none is sent.
      if (own.some(item => item.status === 'queued' && item.scheduled)) { await permissions.markTold(request.id); return 'done'; }
      const result = now.run.status === 'failed' ? `실패: ${now.run.error ?? '알 수 없는 이유'}` : now.run.timedOut ? '시간 제한으로 중단됨' : `종료 코드 ${now.run.exitCode ?? now.run.signal ?? '?'}${now.run.error ? `, ${now.run.error}` : ''}`;
      await runs.enqueue(request.sessionId, `${TOWER_NOTICE} 한 번 실행을 요청한 명령이 끝났습니다 (${result}). permissions_runResult에 id "${request.id}"를 주면 출력을 받습니다.`, {},
        { origin, ...(run?.unattended ? { unattended: true } : {}) });
      await permissions.markTold(request.id);
      return 'done';
    };
    // Only an attempt under way counts as work for a handoff; one waiting to try again is picked up by the next worker.
    const runNotices = new Set<ReturnType<typeof setTimeout>>();
    const runWaits = new Set<ReturnType<typeof setTimeout>>();
    // After about an hour of failures to send, the conversation reads the result with permissions_runResult instead.
    const MAX_TELLS = 120;
    const runFinished = (request: PermissionRequest, delay = 5_000, attempt = 0) => {
      const timer = setTimeout(() => {
        runWaits.delete(timer);
        // A worker handing off or pausing sends nothing more; the next one tells what is left.
        if (stopping) return;
        if (paused) { runFinished(request, 30_000, attempt); return; }
        runNotices.add(timer);
        void tellRun(request).catch(error => { console.error(`A run's result could not reach its conversation: ${error instanceof Error ? error.message : String(error)}`); return 'failed' as const; })
          .then(async next => {
            runNotices.delete(timer);
            if (next === 'done' || stopping) return;
            // Only failures count toward giving up; a conversation that is just busy is waited for.
            const failures = next === 'failed' ? attempt + 1 : attempt;
            if (failures >= MAX_TELLS) { await permissions.markTold(request.id).catch(() => {}); return; }
            runFinished(request, 30_000, failures);
          });
      }, delay);
      timer.unref();
      runWaits.add(timer);
    };
    const stopTelling = () => { stopping = true; for (const timer of runWaits) clearTimeout(timer); runWaits.clear(); };
    const permissions: PermissionService = new PermissionService({ stateDir, effectGate: requireEffects, session: id => runs.getSession(id), globalCodex: resolve(stateDir) === resolve(defaultStateDir()),
      decision: async (request, prompt) => runs.permissionDecision(request, prompt, { closed: await closedNow(request.sessionId) }),
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
    await startupGate();
    registerStorageHold(() => { permissions.pauseForStorage(); }, () => { permissions.resume(); });
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
      model: async (request, options) => { await requireEffects(); return runAutoPromptModel(request, { stateDir, timeoutMs: options.timeoutMs }); },
      files: { stateDir, server: scope => { const build = thisBuild(); return { command: build.command, args: [...build.args, '--review-files-mcp', scope] }; } },
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
      notify: (request, message) => runs.permissionDecision(request, `${TOWER_NOTICE} ${message}`).then(() => undefined) });
    registerStorageHold(() => { reviewer.hold(); }, () => { reviewer.release(); }, () => reviewer.inFlight());
    // Nothing is reviewed before the triggers are in place (released below), not even a recovered run sent back to review.
    reviewer.hold();

    runs.setClaudeSettings((cwd, sessionId) => permissions.claudeSettings(cwd, sessionId));
    runs.setTurnNotes(async (_run, session) => {
      const notes = await Promise.all([skills.turnNotes(session), modelRoleNotes(stateDir).catch(() => undefined), browserNote(sessionBrowsers(stateDir, runs, session))]);
      return notes.filter(Boolean).join('\n\n') || undefined;
    });
    runs.on('change', () => skills.recordRuns());
    // Worktrees a conversation made are removed once the owner closes it or automation finishes it.
    const worktrees = new WorktreeJanitor({ stateDir, sessions: () => visible.allSessions(), runs: () => runs.list(),
      closedIds: async () => { const saved = new ClosedSessionStore(stateDir); await saved.start(); return saved.closedIds(); },
      finishedAutomation: () => finishedAutomationSessionIds(slack.automation.list(), visible.allSessions(), runs.list()),
      // Folders a trigger works in, and projects the owner pinned, are in use even with no conversation open there.
      // Pins are read from the web's saved file each time: this worker's copy is only read when it starts.
      reserved: async () => { const groups = new ProjectGroupStore(stateDir); await groups.start();
        const triggers = triggerEngine?.list({ includeArchived: true }) ?? [];
        // A trigger that continues a conversation works where that conversation does.
        const continued = sessionTargets(triggers).flatMap(id => { const cwd = runs.getSession(id)?.cwd; return cwd ? [cwd] : []; });
        return [...folderSettings(triggers), ...continued, ...groups.list().filter(group => group.pinned).map(group => group.cwd)]; } });
    await startupGate();
    registerStorageHold(() => { worktrees.pause(); }, () => { worktrees.resume(); }, () => worktrees.inFlight());
    await worktrees.start().catch(error => console.error(`Worktree cleanup did not start: ${error instanceof Error ? error.message : String(error)}`));
    const triggers = new TriggerService({ stateDir, secretStore, slack: () => slack.projection(), publicAgents: () => publicAgents.projection(), ownPorts,
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
    registerStorageHold(() => { triggers.hold(); }, () => { triggers.release(); }, () => triggers.inFlight());
    triggerEngine = triggers;
    await startupGate();
    const restoredTriggers = await triggers.start(restoring?.restore.triggers ? { restore: restoring.restore.triggers } : {});
    await restoring?.applied({ parts: restoring.restore.triggers ? ['triggers'] : [], errors: restoredTriggers.errors })
      .catch(error => console.error(`The restore's progress was not recorded: ${error instanceof Error ? error.message : String(error)}`));
    // Reviews waiting from before this worker started (or queued while the last one handed over, or sent back by a run
    // recovered above) go on, once the triggers whose instructions they read are in place.
    await startupGate();
    reviewer.release();
    await startupGate();
    await github.start();
    // Slack and triggers share one limit on provider turns running at once.
    runs.setAutomationLimit(triggers.settings().maxConcurrentRuns);
    triggers.on('settings', (settings: { maxConcurrentRuns: number }) => runs.setAutomationLimit(settings.maxConcurrentRuns));
    // A run still waiting when its trigger is turned off or deleted never starts.
    // A coordinator conversation already under way continues, like an accepted Slack conversation; only its first turn waits on the trigger.
    const remoteLaunch = remoteTriggerLaunch(exclusions, runs);
    runs.setLaunchGate(run => {
      if (run.permissionRequestIds?.length) {
        const applicationError = permissions.ruleApplicationError(runs.getSession(run.sessionId)?.cwd ?? '');
        if (applicationError) return `Permission rules were not applied: ${applicationError}`;
      }
      if (run.permissionRequestIds?.length && visible.allSessions().some(session => session.id === run.sessionId && session.closed)) return 'The owner closed the conversation before permission continuation.';
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
    const observer = new RetentionObserver({ stateDir, storage: database, journalMembers: () => retentionStore.list().flatMap(entry=>entry.members || []), snapshot: () => sessions.completedRetentionRecords(),
      reconcile: native => runs.sessionList(native), runs: () => runs.list(), settled: () => runs.settledRunIds(),
      protectedIds: () => {
        const ids = new Set(coordinators());
        const jobs = new Map(autoPrompts.list().map(job => [job.id, job]));
        for (const job of jobs.values()) if (!['completed', 'error', 'cancelled'].includes(job.status)) {
          if (job.sessionId) ids.add(job.sessionId); if (job.targetSessionId) ids.add(job.targetSessionId);
        }
        for (const workflow of [...slack.automation.list(), ...github.automation.list()]) {
          const pending = !['completed', 'ignored', 'error'].includes(workflow.status);
          if (pending && workflow.sessionId) ids.add(workflow.sessionId);
          for (const task of workflow.delegatedTasks ?? []) if (!task.delegatedFinished || !task.notifiedRunId) {
            const id = task.createdSessionId ?? jobs.get(task.requestId)?.sessionId; if (id) ids.add(id);
          }
        }
        for (const id of sessionTargets(triggers.list().filter(trigger => trigger.enabled))) ids.add(id);
        const triggerOverview = triggers.overview();
        for (const event of [...triggerOverview.recent, ...triggerOverview.updated ?? []]) if (!['completed', 'error', 'cancelled', 'skipped', 'coalesced'].includes(event.status)) {
          for (const id of [event.dispatch?.sessionId, event.dispatch?.createdSessionId,
            event.input.target.mode === 'session' ? event.input.target.sessionId : undefined]) if (id) ids.add(id);
        }

        for (const request of permissions.overview().requests) if (permissionRetentionPending(request)) ids.add(request.sessionId);
        return ids;
      } });
    temporaryReferences = () => {
      const ids = new Set([...coordinators(), ...runs.retentionReservedIds(), ...sessionTargets(triggers.list().filter(trigger => trigger.enabled))]);
      return [...ids].map(id => runs.getSession(id)?.cwd || sessions.get(runs.nativeSessionId(id))?.cwd).filter((cwd): cwd is string => Boolean(cwd));
    };
    const retentionService = new RetentionService({ store: retentionStore, archive: retentionArchive,
      adapter: nativeRetention, observe: () => observer.observe(), reserveAdmission: ids => runs.reserveRetention(ids),
      onColdChanged: () => publishCold(), refresh: () => sessions.refresh(true),
      onError: error => console.error(`Session retention: ${error instanceof Error ? error.message : String(error)}`) });
    let retention: RunnerHostOptions['retention'];
    let retentionUnavailable: string | undefined;
    try {
      if (retentionBootstrapError) throw retentionBootstrapError;
      await startupGate();
    await observer.start();
      await startupGate();
    await retentionService.start();
      initializedRetention = retentionService;
      registerStorageHold(async () => { await retentionService.quiesce(); await temporary.quiesce(); }, () => { retentionService.resume(); temporary.resume(); });
      await startupGate(); publishCold(); temporary.start();
      retention = { service: retentionService, archive: retentionArchive, temporary };
    } catch (error) {
      retentionService.stop();
      retentionUnavailable = `세션 보관 정책 초기화가 보류되었습니다. 기존 세션은 유지됩니다: ${error instanceof Error ? error.message : String(error)}`;
      console.error(retentionUnavailable);
    }
    // A restore's skills are still being written (below): the worker hands over only after them.
    let restoringSkills = Boolean(restoring);
    storageEffects = () => {
      paused = true;
      autoPrompts.holdStorage(); runner.holdStorage();
      slack.holdNewWork(); triggers.hold(); github.hold(); publicAgents.hold(); skills.pause(); tasks.pause(); worktrees.pause(); reviewer.hold(); permissions.pauseForStorage();
      return (async () => {
        try {
          await initializedRetention?.quiesce(); await temporary.quiesce();
          await Promise.all([runs.pauseAttachmentCleanup(), autoPrompts.pauseAttachmentCleanup()]);
        } finally { publishCold(); sessions.resume(); }
      })();
    };
    let retrying: Promise<WorkerStorageStatus> | undefined;
    retryNormal = retryRuntime = () => recoveryBusy ? Promise.reject(new TowerError('conflict', 'A recovery command is underway.')) : retrying ??= (async () => {
      const generation = storageHoldGeneration, fence = heldRollbackFence;
      runs.holdStorage(); storageStatus.admissionOpen = false; if (storageEffects) maintenanceHeld = storageEffects();
      sessions.resume();
      try {
        await maintenanceHeld;
        if (releaseRequested && !await releaseCommitted()) return storageStatus;
        if (!await attempt(true)) return storageStatus;
        await requireEffects();
        if (!await releaseAllowed(generation, fence) || generation !== storageHoldGeneration) return storageStatus;
        storageStatus.admissionOpen = true; runs.releaseStorage(); autoPrompts.releaseStorage();
        paused = false; initializedRetention?.resume(); temporary.resume(); runs.resumeAttachmentCleanup(); autoPrompts.resumeAttachmentCleanup();
        slack.releaseNewWork(); triggers.release(); github.release(); publicAgents.release(); skills.resume(); tasks.resume(); compactions.release(); worktrees.resume(); permissions.resume(); reviewer.release(); runner.releaseStorage();
        return storageStatus;
      } finally { retrying = undefined; }
    })();
    const releaseTimer = setInterval(() => { void (async () => {
      if (!await releaseCommitted()) return;
      const fence = releaseRequested;
      try { await retryNormal!(); } finally { if (releaseRequested === fence) releaseRequested = undefined; }
    })().catch(error => console.error('Storage rollback release:', error)); }, 1000);
    releaseTimer.unref();
    const hostOptions: RunnerHostOptions = { stateDir, sessions, runs, closedSessions, retention, retentionUnavailable, autoPrompts, terminals, slack, github, triggers, publicAgents, skills, sessionTasks: tasks, compactions, api, secrets, capabilities, ledger, exclusions, releaseStateLock: release, handoffNonce, storage: () => storageStatus, retryStorage: () => retryNormal!(), storageRecovery, storageControl: control, closeStorage, onCloseFailure: () => unavailable(), handoffCarry: () => secrets.handoff(),
      onIdle: async () => { clearInterval(releaseTimer); await retention?.service.quiesce(); await temporary.quiesce(); await Promise.all([runs.pauseAttachmentCleanup(), autoPrompts.pauseAttachmentCleanup()]); clearInterval(secretExpiry); secrets.close(); stopTelling(); await tools?.stop(); triggers.close(); await triggers.settle(); github.close(); slack.close(); publicAgents.close(); await publicAgents.flush(); skills.close(); await skills.flush(); await tasks.close(); await compactions.close(); worktrees.close(); await worktrees.flush(); reviewer.close(); await reviewer.flush(); await runner.flush(); clearInterval(expiryTimer); permissions.close(); await permissions.flush(); await sessions.quiesce().catch(() => {}); sessions.stop(); terminals.dispose(); await autoPrompts.close(); await runs.close(); },
      inFlight: () => secrets.inFlight() || restoringSkills || slack.hasInFlight() || triggers.inFlight() || github.inFlight() || publicAgents.inFlight() || skills.inFlight() || tasks.inFlight() || compactions.inFlight() || worktrees.inFlight() || reviewer.inFlight() || runner.inFlight() || runNotices.size > 0 || Boolean(tools?.busy()),
      // A forced update waits only for a compaction creating its session; one still reading or summarizing stops with the worker.
      storageBusy: () => recoveryBusy || secrets.inFlight() || restoringSkills || slack.hasTransient() || triggers.inFlight() || github.automation.transient() || publicAgents.inFlight() || skills.inFlight() || tasks.inFlight() || compactions.inFlight() || worktrees.inFlight() || reviewer.inFlight() || runner.active() || runNotices.size > 0 || Boolean(tools?.busy()),
      transient: () => secrets.inFlight() || restoringSkills || slack.hasTransient() || triggers.inFlight() || github.automation.transient() || publicAgents.inFlight() || skills.inFlight() || tasks.inFlight() || compactions.creating() || worktrees.inFlight() || reviewer.inFlight() || runner.inFlight() || runNotices.size > 0 || Boolean(tools?.busy()),
      // Work a Slack or GitHub coordinator delegated: its coordinator hears how it ended and decides what follows.
      delegated: run => Boolean(run.origin?.workflowId) && !coordinators().has(run.sessionId),
      releaseIntake: () => { slack.releaseNewWork(); triggers.release(); github.release(); publicAgents.release(); skills.resume(); tasks.resume(); compactions.release(); worktrees.resume(); reviewer.release(); },
      holdIntake: () => { slack.holdNewWork(); triggers.hold(); github.hold(); publicAgents.hold(); skills.pause(); tasks.pause(); compactions.hold(); worktrees.pause(); reviewer.hold(); },
      quiesce: async () => { compactions.pause(); await retention?.service.quiesce(); await temporary.quiesce(); await Promise.all([runs.pauseAttachmentCleanup(), autoPrompts.pauseAttachmentCleanup()]); paused = true; secrets.pause(); tools?.pause(); slack.pause(); triggers.pause(); github.pause(); publicAgents.pause(); skills.pause(); tasks.pause(); worktrees.pause(); reviewer.hold(); await reviewer.flush(); permissions.pause(); await Promise.all([secrets.flush(), worktrees.flush(), tasks.flush(), compactions.flush(), permissions.flush(), slack.flush(), triggers.flush(), github.flush(), publicAgents.flush(), skills.flush(), runs.flushState(), autoPrompts.flush(), ledger.flush(), sessions.quiesce()]); },
      resume: () => { publishCold(); sessions.resume(); if (!storageStatus.admissionOpen) return; compactions.resume(); retention?.service.resume(); temporary.resume(); runs.resumeAttachmentCleanup(); autoPrompts.resumeAttachmentCleanup(); paused = false; secrets.resume(); tools?.resume(); slack.resume(); triggers.resume(); github.resume(); publicAgents.resume(); skills.resume(); tasks.resume(); worktrees.resume(); permissions.resume(); reviewer.release(); sessions.resume(); },
      // Nothing is running, so nothing is cancelled; the successor owns the state from here.
      onHandedOff: () => { retention?.service.stop(); void temporary.close(); clearInterval(secretExpiry); secrets.close(); stopTelling(); void tools?.stop(); triggers.close(); github.close(); slack.close(); publicAgents.close(); skills.close(); void tasks.close(); void compactions.close(); worktrees.close(); reviewer.close(); clearInterval(expiryTimer); permissions.close(); sessions.stop(); setTimeout(() => process.exit(0), 2000); } };
    if (diagnosticHost) diagnosticHost.activate(hostOptions); else diagnosticHost = await startRunnerHost(hostOptions);
    await startupGate();
    await permissions.reconcileNotifications().catch(error => console.error(`Permission decisions did not recover: ${error instanceof Error ? error.message : String(error)}`));
    let admissionGeneration: number;
    do { admissionGeneration = storageHoldGeneration; await startupGate(); }
    while (admissionGeneration !== storageHoldGeneration || storageStatus.state !== 'ready');
    storageStatus.admissionOpen = true;
    runs.releaseStorage();
    autoPrompts.releaseStorage();
    runner.releaseStorage();
    runs.markReady();
    void retention?.service.cycle().catch(error => console.error(`Session retention: ${error instanceof Error ? error.message : String(error)}`));
    // A restore's skills are written once the worker serves: linking into project folders (on a slow volume, say) never
    // keeps it from starting. The restore is recorded as done after them; a worker that stops first leaves it to the next.
    if (restoring) void (async () => {
      const restoredSkills = restoring.restore.skills ? await skills.restore(restoring.restore.skills).catch(error => ({ restored: [], skipped: [{ name: '스킬', reason: error instanceof Error ? error.message : String(error) }] })) : undefined;
      await restoring.finish({ parts: restoredSkills ? ['skills'] : [], errors: [], ...(restoredSkills ? { skills: restoredSkills } : {}) });
    })().catch(error => console.error(`The restore's outcome was not recorded: ${error instanceof Error ? error.message : String(error)}`)).finally(() => { restoringSkills = false; });
    // A parent terminal or Tower shutdown must not interrupt provider work.
    process.on('SIGINT', () => {});
    process.on('SIGTERM', () => {});
  } catch (error) {
    if (error instanceof StorageCommandError || database?.status().state === 'unavailable' || runs.busy() || startupBusy.some(busy => busy())) {
      // A startup failure is not permission to terminate accepted work or hand its lock to a second writer.
      unavailable(); storageStatus.reason = error instanceof Error ? error.message : String(error);
      republishCold?.(); if (storageStatus.sessionsAvailable) sessions.resume();
      if (!diagnosticHost) diagnosticHost = await startRunnerHost({ stateDir, sessions, runs, terminals, releaseStateLock: release, handoffNonce,
        storage: () => storageStatus, storageRecovery, storageControl: control, closeStorage, onCloseFailure: () => unavailable(),
        storageBusy: () => recoveryBusy || startupBusy.some(busy => busy()),
        retryStorage: async () => storageStatus,
        quiesce: async () => { await maintenanceHeld; await sessions.quiesce(); await runs.flushState(); },
        resume: () => { republishCold?.(); if (storageStatus.sessionsAvailable) sessions.resume(); },
        onHandedOff: () => { sessions.stop(); setTimeout(() => process.exit(0), 100); } });
      console.error('Startup continuation remains diagnostic; accepted work is preserved:', error);
      return;
    }
    try { await initializedRetention?.quiesce(); await temporary.quiesce(); await Promise.all([runs.pauseAttachmentCleanup(), initializedAutoPrompts?.pauseAttachmentCleanup()]); carry?.fill(0); void tools?.stop(); sessions.stop(); }
    finally { await closeStorage(); await release(); }
    throw error;
  }
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
