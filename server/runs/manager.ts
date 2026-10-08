import { resolveRetentionLineage } from '../sessions/retention/ancestry.js';
import type { RetentionMember } from '../../shared/retention.js';
import { MAX_ATTACHMENTS } from '../../shared/attachments.js';
import type { PermissionRequest } from '../../shared/permissions.js';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { CreateSessionRequest, MessageAttachments, Provider, Run, RunApprovalResponse, RunInstructions, RunOrigin, Session, SteerBlock } from '../../shared/types.js';
import { attachmentPrompt, AttachmentStore, claudeImageBlocks, imagePaths } from '../stores/attachments.js';
import { normalizeSessionTitle } from '../stores/session-titles.js';
import type { CodexBridgeRun, CodexBridgeOptions } from './codex-bridge.js';
import { requestedEffort, requestedModel } from '../providers/models.js';
import { SteeringError } from './steering.js';
import { ClaudeControl } from './claude-control.js';
import type { CodexStdioOptions, CodexStdioRun } from './codex-stdio.js';
import { withNativeContext } from '../sessions/context.js';
import { defaultStateDir } from '../state-dir.js';
import { findExecutable, PROVIDERS } from '../providers/discovery.js';
import { UUID, type CreatedSession } from './saved-state.js';
import { checkClaudeSubscription, markMaster, subscriptionOnly } from './subscription.js';
import { NO_RUN_TOOLS, type RunTools } from './session-mcp.js';
import { automatedOrigin, sameOrigin, type SessionOrigin } from './origin.js';
import type { Wakeup } from './wakeup.js';
import { TOWER_NOTICE } from '../../shared/task-notification.js';
import { creationReviewer } from './approval-policy.js';
import { OwnerAnswers } from './owner-answers.js';
import { checkedInstructions, TurnNotes } from './turn-notes.js';
import { sessionEnv, type LaunchMarks } from './turn-env.js';
import { ToolNotices } from './tool-notices.js';
import { errorMessage, FINISHED, finishedTime, MAX_OUTPUT, MAX_PROMPT, notAdmitted, RunError, shown } from './run-records.js';
import { MAX_RUNS, RunHistory, SCHEDULED_OUTPUT } from './run-history.js';
import { PermissionContinuations, retainedReceipts } from './permission-continuation.js';
import { inheritedRunFields } from './continuations.js';
import { CreatedSessionRegistry } from './session-registry.js';
import { UPDATE_WAIT, UpdateDrain } from './update-drain.js';
import { prepareClaudeTurn } from './claude-turn.js';
import { prepareCodexTurn } from './codex-turn.js';
import { prepareBridgeTurn } from './bridge-turn.js';
import type { OwnedProcess, TurnExit, TurnHost } from './turn-host.js';

type SpawnProcess = (file: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
interface RunnerOptions {
  /**
   * Resolve trusted tools for the turn a run starts. Tools follow the run's recorded origin and its session;
   * a credential inside them may be bound to the run itself.
   */
  resolveRunTools?: (run: Run, session: Session) => RunTools;
  /** True when a ledger outside the run registry links any of these IDs of one session to external content. */
  isExternallyLinked?: (sessionIds: readonly string[]) => boolean;
  getSession: (id: string) => Session | undefined;
  refreshSessions: () => Promise<void>;
  /** Latest native user record, read afresh for permission admission; never inferred from activity timestamps. */
  latestUserMessage?: (sessionId: string) => Promise<{ text: string; timestamp: string } | undefined>;
  stateDir?: string;
  /** How the master's Claude sign-in is checked before its turn (tests replace it). */
  checkClaudeSubscription?: typeof checkClaudeSubscription;
  env?: NodeJS.ProcessEnv;
  /** The launch shims put first in every turn's PATH (see turn-env.ts). */
  launchMarks?: LaunchMarks;
  spawnProcess?: SpawnProcess;
  findExecutable?: (provider: Provider) => Promise<string | undefined>;
  maxConcurrent?: number;
  pollMs?: number;
  openCodexBridge?: (options: Omit<CodexBridgeOptions, 'codexHome'>) => Promise<CodexBridgeRun | undefined>;
  openCodexStdio?: (options: CodexStdioOptions) => Promise<CodexStdioRun>;
  /**
   * Notes for the first turn of a new conversation, such as earlier sessions that may be related. Asked just before
   * the provider starts; whatever it cannot answer quickly is left out.
   */
  firstTurnNotes?: (run: Run, session: Session) => Promise<string | undefined>;
  /** Notes for every turn, such as the owner's pinned skills; asked and limited like `firstTurnNotes`. */
  turnNotes?: (run: Run, session: Session) => Promise<string | undefined>;
  /** What other parts of the worker add to every listed session, such as its task summaries. */
  sessionOverlay?: (session: Session) => Session;
  /** Settings for every Claude Code turn Tower starts: the owner's allow rules for its folder. */
  claudeSettings?: (cwd: string, sessionId: string) => string | undefined;
  /** Pre-accepts the native folder trust prompt for a newly created session. */
  trustWorkspace?: (provider: Provider, cwd: string, env: NodeJS.ProcessEnv) => Promise<void>;
  /** Streamed output alone is saved at most this often; state changes are saved at once. */
  outputPersistMs?: number;
  /** How long Claude may take to pick up a finished background task on its own before Tower hands it the notice. */
  backgroundFollowUpMs?: number;
  /** How long a turn that has answered stays open for background work still running before its input is closed. */
  backgroundWaitMaxMs?: number;
  /** Delay before resuming a provider that exited with unfinished background work. */
  backgroundRecoveryMs?: number;
  /** Queued runs wait until `markReady()`: a worker first sets up everything a launch asks (tools, gates, limits). */
  holdUntilReady?: boolean;
}
/** Internal admission data is never accepted from the public message endpoint. */
export interface RunAdmission {
  autoPromptId?: string;
  validate?: () => void;
  /** Recorded on the run; absent means unknown, which never gains owner privileges. */
  origin?: RunOrigin;
  /** Validated reporting links; never supplied by a public request body. */
  delegation?: Run['delegation'];
  /** Transient credential forwarded to the worker, never saved on a run. */
  callerCapability?: string;
  /** The prompt carries Slack, GitHub or HTTP content. Only a session Tower creates for it may receive it. */
  untrustedInput?: boolean;
  /** No one is watching: Claude runs in its automatic permission mode (Codex uses its auto review reviewer). */
  unattended?: boolean;
  /** Triggers never create a missing folder. */
  createFolder?: boolean;
  /** Pre-answer the native folder trust prompt. Only for folders the owner chose. */
  trustWorkspace?: boolean;
  /** A remote controller's ID for this request; the worker runs a retry with the same ID only once. */
  requestId?: string;
  /** Hidden instructions for this turn (see Run.instructions). */
  instructions?: RunInstructions;
  /**
   * Reads again what `validate` judges, right before it: `create` awaits it after its own preparation, so nothing
   * waits between it, `validate` and registering the conversation.
   */
  refresh?: () => Promise<void>;
}

type SteerableAdapter = CodexStdioRun | CodexBridgeRun | ClaudeControl;
/** What the page shows about inserting a queued instruction now: the button, or why not. */
function steerable(steering: { target: Run } | { blocked: SteerBlock } | undefined): Pick<Run, 'canSteer' | 'steerBlocked'> {
  return steering && 'blocked' in steering ? { canSteer: false, steerBlocked: steering.blocked } : { canSteer: Boolean(steering) };
}
const MAX_QUEUED = 32;
const due = (run: Run, now = Date.now()) => !run.scheduled || Date.parse(run.scheduled.at) <= now;

export { RunError };

/** Owns only processes launched by this monitor; never signals an external agent. */
export class RunManager extends EventEmitter {
  private readonly options: RunnerOptions;
  private readonly history: RunHistory;
  private readonly attachments: AttachmentStore;
  private readonly autoAttachments: AttachmentStore;
  private readonly registry = new CreatedSessionRegistry({ native: id => this.options.getSession(id), persist: () => this.persist() });
  private readonly runs = new Map<string, Run>();
  private readonly answers = new OwnerAnswers();
  private readonly owned = new Map<string, OwnedProcess>();
  private readonly bridged = new Map<string, CodexBridgeRun>();
  private readonly notes = new TurnNotes(() => this.options);
  private readonly stdio = new Map<string, CodexStdioRun>();
  private readonly reservedSessions = new Set<string>();
  private readonly retentionReservations = new Set<string>();
  private readonly retentionWaiters = new Set<() => void>();
  private retentionMembers: readonly RetentionMember[] = [];
  private retentionLaunchers: ReadonlyMap<string, readonly string[]> = new Map();
  setRetentionLineage(members: readonly RetentionMember[], launchers: ReadonlyMap<string, readonly string[]> = new Map()): void {
    this.retentionMembers=structuredClone(members); this.retentionLaunchers=new Map(launchers);
  }
  private coldSessionIds: ReadonlySet<string> = new Set();
  private restoreCold?: (id: string) => Promise<void>;
  setColdSessions(ids: Iterable<string>, restore?: (id: string) => Promise<void>): void {
    this.coldSessionIds = new Set([...ids].map(id => this.nativeSessionId(id))); this.restoreCold = restore;
  }
  reserveRetention(ids: readonly string[]): (() => void) | undefined {
    const keys = new Set(ids.map(id => this.nativeSessionId(id)));
    const metadata = new Map<string, RetentionMember>();
    const provenParents = new Map<string, Set<string>>();
    const edge = (id:string,parent:string) => { const values=provenParents.get(id)||new Set<string>();values.add(parent);provenParents.set(id,values); };
    for(const member of this.retentionMembers) {
      for(const alias of [member.sessionId,`${member.provider}:${member.nativeId}`]) {
        if(member.state==='cold') metadata.set(alias,member);
        if(member.parentId) edge(alias,member.parentId);
      }
      for(const relation of member.relationships || []) for(const alias of [relation.id,`${relation.provider}:${relation.nativeId}`]) edge(alias,relation.parentId);
    }
    const pending=[...keys],seenIds=new Set<string>(),hotById=new Map<string,Session>();
    while(pending.length) {
      const id=pending.pop()!;if(seenIds.has(id))continue;seenIds.add(id);
      const hot=this.getSession(id),cold=metadata.get(id),node=hot||cold;
      if(hot)hotById.set(hot.id,hot);
      if(node?.provider!=='claude')continue;
      if(node.parentId)pending.push(node.parentId);
      for(const alias of [id,hot?.id,cold?.sessionId,`${node.provider}:${node.nativeId}`]) if(alias) {
        pending.push(...provenParents.get(alias)||[],...this.retentionLaunchers.get(alias)||[]);
      }
    }
    const hot=[...hotById.values()];
    const lineage=resolveRetentionLineage(hot,this.retentionMembers,this.retentionLaunchers);
    const nodeFor=(id:string)=>lineage.nodes.get(lineage.aliases.get(id)??id);
    // A lost hot exec edge and each cold intermediate use the same policy-only proof.
    // Reserve every reachable Claude ancestor even when its historical role is unknown.
    for (const id of [...keys]) {
      const seen = new Set<string>(); let node = nodeFor(id);
      while (node?.provider === 'claude' && node.parentId && !seen.has(node.parentId)) {
        seen.add(node.parentId); keys.add(this.nativeSessionId(node.parentId)); node = nodeFor(node.parentId);
      }
    }
    if ([...keys].some(id => this.retentionReservations.has(id))) return undefined;
    if ([...this.reservedSessions].some(id => keys.has(this.nativeSessionId(id)))) return undefined;
    if ([...this.runs.values()].some(run => keys.has(this.nativeSessionId(run.sessionId)) &&
      (run.status === 'queued' || run.status === 'running' || run.approvals?.length || run.backgroundWait || !this.settledRuns.has(run.id)))) return undefined;
    for (const id of keys) this.retentionReservations.add(id);
    let released = false;
    return () => { if (released) return; released = true; for (const id of keys) this.retentionReservations.delete(id); for (const notify of this.retentionWaiters) notify(); void this.pump(); };
  }
  retentionReservedIds(): ReadonlySet<string> { return new Set(this.retentionReservations); }
  private retentionHeld(id: string): boolean { return this.retentionReservations.has(this.nativeSessionId(id)); }
  private assertRetentionAdmission(id: string): void {
    if (this.retentionHeld(id)) throw notAdmitted(new RunError('Session cold storage maintenance has not finished; retry after it finishes.', 'unavailable'));
  }
  private async awaitRetentionAdmission(id: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (this.retentionHeld(id) || this.coldSessionIds.has(this.nativeSessionId(id))) {
      if (!this.started || this.stopping) throw notAdmitted(new RunError('The task runner is not accepting instructions.', 'unavailable'));
      if (this.retentionHeld(id)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) this.assertRetentionAdmission(id);
        await new Promise<void>((resolve, reject) => {
          const notify = () => { clearTimeout(timer); this.retentionWaiters.delete(notify); resolve(); };
          const timer = setTimeout(() => { this.retentionWaiters.delete(notify); reject(notAdmitted(new RunError('Session cold storage maintenance has not finished; retry after it finishes.', 'unavailable'))); }, remaining);
          this.retentionWaiters.add(notify);
        });
      } else {
        await this.restoreCold?.(id);
        if (this.coldSessionIds.has(this.nativeSessionId(id)) && !this.retentionHeld(id)) throw notAdmitted(new RunError('Session cold storage restore did not complete.', 'unavailable'));
      }
    }
  }
  private retentionWait(run: Run): boolean {
    if (!this.retentionHeld(run.sessionId)) return false;
    run.output = 'Waiting for session cold storage maintenance.'; this.changed(); return true;
  }

  /** CLIs being updated: none of their runs start until the update is done. */
  private readonly heldProviders = new Set<Provider>();
  private readonly admissions = new Set<string>();
  private readonly incomingAttachments = new Set<ReadonlyArray<string>>();
  private readonly locallySettled = new Map<string, number>();
  private readonly settledRuns = new Set<string>();
  /** Runs the owner asked to stop; a Codex app submission taken back for an update is then not queued again. */
  private readonly ownerStopped = new Set<string>();
  private readonly drain = new UpdateDrain({
    runs: this.runs, bridged: this.bridged, ownerStopped: id => this.ownerStopped.has(id), stopping: () => this.stopping,
    steer: (runId, options) => this.steer(runId, options), cancel: (runId, reason) => this.cancel(runId, reason),
    changed: () => this.changed(), pump: () => { void this.pump(); },
    mergePermission: (run, notice, wait) => this.permissions.mergeIntoUpdate(run, notice, wait),
  });
  private ready: boolean;
  private pollTimer?: ReturnType<typeof setInterval>;
  private notifyTimer?: ReturnType<typeof setTimeout>;
  private outputPersistTimer?: ReturnType<typeof setTimeout>;
  private pumping = false;
  private automationLimit = Infinity;
  private launchGate?: (run: Run) => string | undefined;
  private launchPrepare?: (run: Run) => Promise<void>;
  private started = false;
  private stopping = false;
  private attachmentCleanupPaused = true;
  private attachmentCleanupTimer?: ReturnType<typeof setInterval>;
  private attachmentCleanup?: Promise<void>;


  /** What the turn modules use of this manager (see turn-host.ts). */
  private readonly turnHost: TurnHost;

  constructor(options: RunnerOptions) {
    super();
    this.options = options;
    this.history = new RunHistory(options.stateDir ?? defaultStateDir());
    this.ready = !options.holdUntilReady;
    this.attachments = new AttachmentStore(options.stateDir ?? defaultStateDir());
    this.autoAttachments = new AttachmentStore(join(options.stateDir ?? defaultStateDir(), 'auto-prompt-staging'));
    const manager = this;
    this.turnHost = {
      get options() { return manager.options; }, registry: this.registry, attachments: this.attachments, notes: this.notes,
      changed: () => this.changed(), append: (run, text) => this.append(run, text), notifyOutput: () => this.notifyOutput(), flush: () => this.flush(),
      stopping: () => this.stopping, updating: () => this.updating, stop: (id, owned) => this.stopOwned(id, owned),
      prepareLaunch: run => this.prepareLaunch(run), refusedAtLaunch: (run, session) => this.refusedAtLaunch(run, session),
      release: sessionId => { this.reservedSessions.delete(sessionId); }, exited: exit => this.exited(exit),
      runTools: (run, session) => this.runTools(run, session), executable: provider => this.executable(provider),
      getSession: id => this.getSession(id), isWorking: session => this.isWorking(session),
      validateSession: session => this.validateSession(session), masterSession: session => this.masterSession(session),
    };
  }

  /** Slack and trigger work together start at most this many provider turns at once; the rest wait in the queue. */
  setAutomationLimit(limit: number): void { this.automationLimit = limit; void this.pump(); }

  /**
   * Asked right before a queued run starts. A reason means it never starts and ends as cancelled. `prepare` looks again
   * at what the gate needs, after the last asynchronous step before a provider starts; the gate then answers at once.
   */
  setLaunchGate(gate: (run: Run) => string | undefined, prepare?: (run: Run) => Promise<void>): void { this.launchGate = gate; this.launchPrepare = prepare; }
  /** The environment a command run for a conversation gets (see sessionEnv). */
  launchEnv(sessionId: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return sessionEnv(env, this.getSession(sessionId), this.options.launchMarks);
  }

  private async prepareLaunch(run: Run): Promise<void> {
    // A look that fails leaves the gate with what it knows; a folder it cannot tell about counts as private.
    if (run.status === 'queued') await this.launchPrepare?.(run).catch(() => {});
    await this.permissions.verifyBeforeLaunch(run);
  }

  /** Checked again at the last moment before a provider is started, after every asynchronous step. */
  private refusedAtLaunch(run: Run, session: Session): boolean {
    if (this.retentionWait(run)) { this.reservedSessions.delete(session.id); return true; }
    // A switch to the new worker began while this turn was being prepared: it waits for the new worker.
    if (this.updating && run.status === 'queued') {
      if (run.output !== UPDATE_WAIT) run.output = UPDATE_WAIT;
      this.reservedSessions.delete(session.id);
      this.changed();
      return true;
    }
    const reason = run.status === 'queued' ? this.launchGate?.(run) : undefined;
    if (!reason) return false;
    run.status = 'cancelled'; run.error = reason; run.finishedAt = new Date().toISOString();
    this.reservedSessions.delete(session.id);
    this.changed();
    return true;
  }

  setFirstTurnNotes(notes: NonNullable<RunnerOptions['firstTurnNotes']>): void { this.options.firstTurnNotes = notes; }
  setTurnNotes(notes: NonNullable<RunnerOptions['turnNotes']>): void { this.options.turnNotes = notes; }
  setSessionOverlay(overlay: NonNullable<RunnerOptions['sessionOverlay']>): void { this.options.sessionOverlay = overlay; }
  /**
   * What the owner answered the agent's questions in a conversation, kept from the moment it is sent: native history
   * may not have it yet when Tower's permission reviewer reads the owner's words.
   */
  ownerAnswers(sessionId: string): { at: string; question: string; answer: string }[] { return this.answers.list(this.monitorSessionId(sessionId)); }
  setClaudeSettings(settings: NonNullable<RunnerOptions['claudeSettings']>): void { this.options.claudeSettings = settings; }
  setRunToolResolver(resolver: NonNullable<RunnerOptions['resolveRunTools']>): void {
    this.options.resolveRunTools = resolver;
  }

  setExternalLinkResolver(resolver: NonNullable<RunnerOptions['isExternallyLinked']>): void {
    this.options.isExternallyLinked = resolver;
  }

  private runTools(run: Run, session: Session): RunTools {
    return this.options.resolveRunTools?.(run, session) ?? NO_RUN_TOOLS;
  }

  private readonly permissions = new PermissionContinuations({
    runs: this.runs, events: this, getSession: id => this.getSession(id), supersede: (run, reason) => this.supersede(run, reason),
    steer: (runId, options) => this.steer(runId, options), changed: () => this.changed(), flush: () => this.flush(), pump: () => { void this.pump(); },
    stopping: () => this.stopping, admit: id => { this.admissions.add(id); }, unadmit: id => { this.admissions.delete(id); },
    latestUserMessage: id => this.options.latestUserMessage?.(id), shown,
  });

  /** Records the owner's decision about an agent's permission request (see permission-continuation.ts). */
  permissionDecision(request: PermissionRequest, prompt: string, options: { closed?: boolean } = {}): Promise<Run> { return this.permissions.decide(request, prompt, options); }

  private readonly toolNotices = new ToolNotices({
    runs: () => this.runs.values(), run: id => this.runs.get(id), getSession: id => this.getSession(id), runTools: (run, session) => this.runTools(run, session),
    stopping: () => this.stopping, updating: () => this.updating,
    admitting: run => this.admissions.has(run.id) || run.steering?.state === 'sending',
    writer: id => this.stdio.get(id) ?? this.owned.get(id)?.claude,
    finishInput: id => this.owned.get(id)?.finishInput?.(),
  });

  /** An explicit owner connection targets one session; never creates or resumes a provider turn. */
  notifyToolChange(instructions: string, sessionId: string): void { this.toolNotices.notify(instructions, sessionId); }

  private flushToolNotices(): void { this.toolNotices.flush(); }

  /**
   * Provenance of a session Tower created. Native sessions the owner opened elsewhere return undefined.
   * A ledger link to external content always wins over the stored record.
   */
  sessionOrigin(id: string): SessionOrigin | undefined {
    id = this.monitorSessionId(id);
    return this.registry.origin(id, this.options.isExternallyLinked?.([id, this.nativeSessionId(id)]) === true);
  }

  /** Fills provenance for sessions created before it was recorded (see CreatedSessionRegistry.backfill). */
  backfillSessionOrigins(links: { sessionIds: ReadonlySet<string>; requestIds: ReadonlySet<string> }): number {
    return this.registry.backfill(links, id => this.runs.get(id));
  }

  async start(): Promise<void> {
    if (this.started) return;
    await mkdir(this.options.stateDir ?? defaultStateDir(), { recursive: true, mode: 0o700 });
    await this.attachments.start();
    const saved = await this.history.readCreated();
    if (saved !== undefined) this.history.noteCreated(this.registry.load(saved));
    for (const run of await this.history.restore()) {
      this.runs.set(run.id, run);
      // No transport from the predecessor remains for an already terminal history item.
      // Unread results and approvals have their own retention protection; native activity is checked separately.
      if (FINISHED.has(run.status) && !run.approvals?.length && !run.backgroundWait) this.settledRuns.add(run.id);
    }
    this.started = true;
    // Without a worker to load the automations later, the retained runs are whatever they report from now on.
    if (this.ready) this.history.restoredRetained.clear();
    this.changed();
    await this.flush();
    this.pollTimer = setInterval(() => { void this.pump(); }, this.options.pollMs ?? 1500);
    this.pollTimer.unref();
    this.resumeAttachmentCleanup();
  }

  /** Starts queued runs once everything a launch asks for is in place (see `holdUntilReady`). */
  markReady(): void { if (this.ready) return; this.ready = true; this.history.restoredRetained.clear(); void this.pump(); }

  /** Runs an automation still has to report: kept through pruning and restarts. */
  setRetained(retained: () => Iterable<string>): void { this.history.setRetained(retained); }

  private retainedIds(): Set<string> { return this.history.retainedIds(this.runs, retainedReceipts(this.runs.values())); }

  list(): Run[] { return [...this.runs.values()].map((run) => ({ ...shown(run), ...steerable(this.steering(run)), ...(run.steering ? { steering: { ...run.steering } } : {}), ...(run.attachments ? { attachments: run.attachments.map(item => ({ ...item })) } : {}),
    ...(run.contextUsage ? { contextUsage: { ...run.contextUsage } } : {}),
    ...(run.approvals ? { approvals: structuredClone(run.approvals) } : {}) })); }
  async attachment(id: string) {
    const { metadata, content, sessionId } = await this.attachments.readLegacyDownload(id);
    return { metadata, content, sessionId };
  }
  settledRunIds(): ReadonlySet<string> { return new Set(this.settledRuns); }

  private sessionWithContext(session: Session): Session {
    let latest: Run['contextUsage'];
    let scheduledAt: string | undefined;
    for (const run of this.runs.values()) {
      if (run.sessionId !== session.id) continue;
      if (run.contextUsage && (!latest || run.contextUsage.updatedAt > latest.updatedAt)) latest = run.contextUsage;
      if (run.status === 'queued' && run.scheduled) scheduledAt = run.scheduled.at;
    }
    const current = withNativeContext(session, latest);
    return scheduledAt ? { ...current, scheduledAt } : current;
  }

  /** Stable monitor IDs keep layout, titles and closure attached after native discovery. */
  nativeSessionId(id: string): string { return this.registry.nativeId(id); }

  getSession(id: string): Session | undefined {
    id = this.monitorSessionId(id);
    if (this.coldSessionIds.has(this.nativeSessionId(id))) return undefined;
    if (this.registry.has(id)) return this.registry.view(id, runId => this.runs.get(runId), session => this.sessionWithContext(session));
    const native = this.options.getSession(id);
    if (!native) return undefined;
    return this.sessionWithContext(native.parentId ? { ...native, parentId: this.monitorSessionId(native.parentId) } : native);
  }

  private monitorSessionId(id: string): string { return this.registry.monitorId(id); }

  /** The records of created conversations, for tests that reach them directly; only the registry changes them. */
  private get createdSessions(): Map<string, CreatedSession> { return this.registry.records; }

  sessionList(nativeSessions: readonly Session[]): Session[] {
    const listed = markMaster(this.registry.list(nativeSessions, id => this.getSession(id)).filter(session => !this.coldSessionIds.has(this.nativeSessionId(session.id))).map(session => this.sessionWithContext(session)), this.options.stateDir ?? defaultStateDir());
    const overlay = this.options.sessionOverlay;
    return overlay ? listed.map(overlay) : listed;
  }

  async create(input: CreateSessionRequest, internal: RunAdmission = {}): Promise<{ session: Session; run: Run }> {
    const incoming = Array.isArray(input.attachmentIds) ? input.attachmentIds.filter(id => typeof id === 'string') : [];
    this.incomingAttachments.add(incoming);
    try {
      this.validateCorrelation(internal.autoPromptId);
      if (input.attachmentIds?.length && !internal.autoPromptId) throw new RunError('새 세션의 첨부 파일은 Auto Prompt로 보내세요.');
      this.validateAdmission(input.prompt, Boolean(input.attachments?.length || input.attachmentIds?.length));
      if (!PROVIDERS.includes(input.provider)) throw new RunError('Claude 또는 Codex를 선택하세요.');
      const model = requestedModel(input.model);
      const effort = requestedEffort(input.effort, input.provider);
      const approvalsReviewer = creationReviewer(input, internal.origin);
      if (typeof input.cwd !== 'string' || input.cwd.includes('\0') || input.cwd.length > 4096) throw new RunError('작업 폴더의 절대 경로를 입력하세요.');
      const cwd = input.cwd === '~' || input.cwd.startsWith('~/') ? join(homedir(), input.cwd.slice(1)) : input.cwd;
      if (!isAbsolute(cwd)) throw new RunError('작업 폴더의 절대 경로를 입력하세요.');
      input = { ...input, cwd };
      const title = input.title === undefined ? '' : normalizeSessionTitle(input.title);
      if (!(await this.executable(input.provider))) throw new RunError(`Install the ${input.provider} CLI and ensure it is in PATH before creating a session.`, 'unavailable');
      if (internal.createFolder === false) {
        if (!(await stat(cwd).then(info => info.isDirectory(), () => false))) throw new RunError('The working folder does not exist. It was not created.', 'not-found');
      } else {
        // A folder that does not exist yet is created, like `mkdir -p` before starting the CLI there.
        try { await mkdir(cwd, { recursive: true }); if (!(await stat(cwd)).isDirectory()) throw new Error(); }
        catch { throw new RunError('작업 폴더를 만들 수 없습니다. 경로와 권한을 확인하세요.'); }
      }
      const uuid = randomUUID();
      const id = `${input.provider}:${input.provider === 'codex' ? 'monitor-' : ''}${uuid}`;
      const prepared = await this.prepareAttachments(id, input, internal.autoPromptId);
      try {
        await internal.refresh?.();
        this.validateAdmission(input.prompt, prepared.attachments.length > 0);
        this.validateCorrelation(internal.autoPromptId);
        internal.validate?.();
      } catch (error) { await this.attachments.rollback(prepared.createdIds); throw error; }
      const createdAt = new Date().toISOString();
      const origin = internal.origin ?? { kind: 'unknown' as const };
      const run: Run = { id: randomUUID(), sessionId: id, origin, ...(internal.delegation ? { delegation: { ...internal.delegation } } : {}), prompt: input.prompt, status: 'queued', createdAt, output: 'Queued — preparing to create this conversation.', ...(model ? { model } : {}), ...(effort ? { effort } : {}),
        ...(internal.unattended ? { unattended: true } : {}), ...(internal.instructions ? { instructions: checkedInstructions(internal.instructions) } : {}),
        ...(approvalsReviewer ? { codexApprovalsReviewer: approvalsReviewer } : {}),
        ...(prepared.attachments.length ? { attachments: prepared.attachments } : {}), ...(internal.autoPromptId ? { autoPromptId: internal.autoPromptId } : {}) };
      // Provenance commits with the session identity, before any provider starts.
      this.registry.add(input, id, input.provider === 'claude' ? uuid : '', run, title, origin, internal.untrustedInput === true);
      this.runs.set(run.id, run);
      this.admissions.add(run.id);
      this.prune();
      this.changed();
      try {
        // The run is already registered, so a concurrent request with the same ID is refused while this waits.
        // Only an admitted request answers the native trust prompt; a refused one leaves settings untouched.
        if (internal.trustWorkspace !== false) await this.options.trustWorkspace?.(input.provider, cwd, { ...process.env, ...this.options.env }).catch(() => {});
        await this.flush();
      }
      catch (error) {
        // No provider starts until both records commit. Keep failure visible; never
        // leave an unacknowledged request queued for a later polling cycle.
        this.fail(run, error);
        await this.flush().catch(() => {});
        await this.attachments.rollback(prepared.createdIds);
        throw error;
      } finally { this.admissions.delete(run.id); }
      await this.retainAttachments(run);
      void this.pump();
      return { session: this.getSession(id)!, run: shown(run) };
    } finally { this.incomingAttachments.delete(incoming); }
  }

  private async prepareAttachments(sessionId: string, request: MessageAttachments, autoPromptId?: string) {
    if (!autoPromptId || !request.attachmentIds?.length) return this.attachments.prepare(sessionId, request);
    if (!Array.isArray(request.attachmentIds) || !Array.isArray(request.attachments ?? []) || request.attachmentIds.length + (request.attachments?.length ?? 0) > MAX_ATTACHMENTS) throw new RunError(`첨부 파일은 최대 ${MAX_ATTACHMENTS}개까지 보낼 수 있습니다.`);
    const imported = await this.attachments.import(sessionId, this.autoAttachments, autoPromptId, request.attachmentIds);
    try {
      const prepared = await this.attachments.prepare(sessionId, { attachments: request.attachments, attachmentIds: imported.attachments.map(item => item.id) });
      return { attachments: prepared.attachments, createdIds: [...imported.createdIds, ...prepared.createdIds] };
    } catch (error) { await this.attachments.rollback(imported.createdIds); throw error; }
  }

  private async retainAttachments(run: Run): Promise<void> {
    try { await this.attachments.retain(run.attachments?.map(item => item.id) ?? []); }
    catch { console.error('Accepted run attachment retention failed; durable references protect the files until the next sweep.'); }
  }

  private validateAdmission(prompt: string, hasAttachments = false): void {
    if (!this.started || this.stopping) throw notAdmitted(new RunError('The task runner is not accepting instructions.', 'unavailable'));
    if (typeof prompt !== 'string' || (!prompt.trim() && !hasAttachments)) throw new RunError('Enter an instruction or attach a file first.');
    if (prompt.length > MAX_PROMPT) throw new RunError(`Instructions must be at most ${MAX_PROMPT.toLocaleString()} characters.`, 'too-large');
    if ([...this.runs.values()].filter((run) => run.status === 'queued' && !run.scheduled).length >= MAX_QUEUED) throw notAdmitted(new RunError('The task queue is full. Wait for a task to finish.', 'rate-limited'));
  }

  /** External content only enters conversations Tower created and can keep marked. */
  private admitUntrusted(sessionId: string): void {
    if (!this.registry.has(sessionId)) throw new RunError('External trigger content can only continue a conversation Tower created for it.', 'conflict');
  }

  private validateCorrelation(id: string | undefined): void {
    if (id === undefined) return;
    if (!UUID.test(id)) throw new RunError('Invalid Auto Prompt request ID.');
    if ([...this.runs.values()].some(run => run.autoPromptId === id)) throw new RunError('This Auto Prompt already has an execution task.', 'conflict');
  }

  async enqueue(sessionId: string, prompt: string, request: MessageAttachments = {}, internal: RunAdmission = {}): Promise<Run> {
    const incoming = Array.isArray(request.attachmentIds) ? request.attachmentIds.filter(id => typeof id === 'string') : [];
    this.incomingAttachments.add(incoming);
    try {
      this.validateCorrelation(internal.autoPromptId);
      sessionId = this.monitorSessionId(sessionId);
      while (this.retentionHeld(sessionId) || this.coldSessionIds.has(this.nativeSessionId(sessionId))) await this.awaitRetentionAdmission(sessionId);
      this.assertRetentionAdmission(sessionId);
      const hasAttachments = Boolean(request.attachments?.length || request.attachmentIds?.length);
      this.validateAdmission(prompt, hasAttachments);
      const session = this.getSession(sessionId);
      this.validateSession(session);
      if (internal.untrustedInput) this.admitUntrusted(sessionId);
      const model = requestedModel(request.model);
      const effort = requestedEffort(request.effort, session.provider);
      if (!(await this.executable(session.provider))) throw new RunError(`Install the ${session.provider} CLI and ensure it is in PATH before sending instructions.`, 'unavailable');
      const prepared = await this.prepareAttachments(sessionId, request, internal.autoPromptId);
      // File writes yield; recheck admission immediately before inserting the run.
      try {
        // Maintenance may have started while executable/attachment preparation yielded.
        while (this.retentionHeld(sessionId) || this.coldSessionIds.has(this.nativeSessionId(sessionId))) await this.awaitRetentionAdmission(sessionId);
        this.assertRetentionAdmission(sessionId); this.validateAdmission(prompt, prepared.attachments.length > 0); this.validateSession(this.getSession(sessionId)); this.validateCorrelation(internal.autoPromptId); internal.validate?.(); }
      catch (error) { await this.attachments.rollback(prepared.createdIds); throw error; }
      if (internal.untrustedInput) {
        // Recorded before the run exists: once external content is queued, the session stays marked.
        this.registry.markUntrusted(sessionId);
      }
      const run: Run = { id: randomUUID(), sessionId, origin: internal.origin ?? { kind: 'unknown' }, ...(internal.delegation ? { delegation: { ...internal.delegation } } : {}), prompt, status: 'queued', createdAt: new Date().toISOString(), output: this.waitReason(session),
        ...(internal.unattended ? { unattended: true } : {}), ...(internal.instructions ? { instructions: checkedInstructions(internal.instructions) } : {}),
        ...(model ? { model } : {}), ...(effort ? { effort } : {}),
        ...(internal.autoPromptId ? { autoPromptId: internal.autoPromptId } : {}),
        ...(prepared.attachments.length ? { attachments: prepared.attachments } : {}) };
      this.admissions.add(run.id);
      this.runs.set(run.id, run);
      this.prune();
      this.changed();
      try { await this.flush(); } // An accepted instruction is durable before launching the provider.
      catch (error) { this.runs.delete(run.id); this.changed(); await this.attachments.rollback(prepared.createdIds); throw error; }
      finally { this.admissions.delete(run.id); }
      await this.retainAttachments(run);
      // An accepted instruction replaces the continuation the agent planned; its next turn can schedule again.
      // Tower's own continuation after an update is not the agent's plan: it runs first, then this instruction.
      for (const other of this.runs.values()) if (other.sessionId === sessionId && other.status === 'queued' && other.scheduled && (other.scheduled.resume !== 'update' || other.permissionRequestIds?.length)) this.supersede(other, 'A newer instruction was sent before the scheduled time.');
      void this.pump();
      return shown(run);
    } finally { this.incomingAttachments.delete(incoming); }
  }

  private steeringTarget(run: Run) {
    const steering = this.steering(run);
    return steering && 'target' in steering ? steering : undefined;
  }

  /**
   * The running turn a queued instruction can go into now, or why it cannot while one runs in its session. Nothing is
   * said when no turn runs there or the instruction is not one the owner could insert (scheduled, being admitted).
   */
  private steering(run: Run): { target: Run; adapter: SteerableAdapter } | { blocked: SteerBlock } | undefined {
    if (this.retentionHeld(run.sessionId) || this.permissions.noticeBlocked(run)) return undefined;
    if (this.stopping || run.status !== 'queued' || run.steering || run.scheduled || this.admissions.has(run.id) || this.bridged.has(run.id)) return undefined;
    const target = [...this.runs.values()].find(item => item.sessionId === run.sessionId && item.status === 'running' && !item.steering);
    if (!target) return undefined;
    // Inserted text reaches the running turn alone: instructions it must not go without would be lost.
    if (run.instructions?.required) return { blocked: 'instructions' };
    if (run.model && run.model !== (target.model ?? this.getSession(run.sessionId)?.model)) return { blocked: 'model' };
    if (run.effort && run.effort !== target.effort) return { blocked: 'effort' };
    // An inserted instruction runs with the active turn's tools and approvals. Tools follow origin and
    // session alone, so the same origin in the same session is exactly the same authority.
    if (!sameOrigin(run.origin, target.origin)) return { blocked: 'origin' };
    const adapter = this.stdio.get(target.id) ?? this.bridged.get(target.id) ?? this.owned.get(target.id)?.claude;
    return adapter?.canSteer?.() && adapter.steer ? { target, adapter } : { blocked: 'starting' };
  }

  /** `targetRunId` inserts only into that turn: a decision made about one turn never lands in the next. */
  async steer(runId: string, options: { whileWaiting?: boolean; targetRunId?: string } = {}): Promise<Run> {
    const run = this.runs.get(runId);
    if (!run) throw new RunError('Task not found.', 'not-found');
    if (run.steering) return this.list().find(item => item.id === runId)!;
    const selected = this.steeringTarget(run);
    if (!selected) throw new RunError('This queued instruction cannot be inserted into an active Tower turn.', 'conflict');
    if (options.targetRunId !== undefined && selected.target.id !== options.targetRunId) throw new SteeringError('The active turn changed before delivery.', 'rejected');
    // Reserve synchronously before attachment reads so duplicate clicks cannot submit twice.
    this.admissions.add(run.id);
    let submitted = false;
    try {
      const attachments = await this.attachments.resolve(run.sessionId, run.attachments);
      this.admissions.delete(run.id);
      const current = this.steeringTarget(run);
      this.admissions.add(run.id);
      if (!current || current.target !== selected.target || current.adapter !== selected.adapter || (options.whileWaiting && !current.target.backgroundWait)) throw new SteeringError('The active turn changed before delivery.', 'rejected');
      run.status = 'running'; run.startedAt = new Date().toISOString(); run.output = '';
      run.steering = { targetRunId: selected.target.id, state: 'sending', requestedAt: run.startedAt };
      this.changed();
      await this.flush();
      if (this.stopping || selected.target.status !== 'running' || !selected.adapter.canSteer?.()) throw new SteeringError('The active turn finished before delivery.', 'rejected');
      // Saving yielded; an automatic insert goes only while the turn is still just waiting.
      if (options.whileWaiting && !selected.target.backgroundWait) throw new SteeringError('The waiting turn resumed before delivery.', 'rejected');
      const prompt = attachmentPrompt(run.prompt, attachments);
      submitted = true;
      this.drain.noteHandedOver(run);
      if (selected.adapter instanceof ClaudeControl) {
        const delivery = selected.adapter.steer({ type: 'user', uuid: run.id, session_id: this.getSession(run.sessionId)!.nativeId, parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'text', text: prompt }, ...claudeImageBlocks(attachments)] } });
        // Claude confirms only when it takes the instruction at its next step, which can be minutes away, so the
        // answer is that it was handed over and the run records how it ends.
        this.admissions.delete(run.id);
        void delivery.then(() => this.settleSteer(run, selected.target.id), error => this.settleSteer(run, selected.target.id, error)).catch(() => {});
        return this.list().find(item => item.id === runId)!;
      }
      const sending = selected.adapter.steer!({ id: run.id, prompt, imagePaths: imagePaths(attachments) });
      // Codex takes one insert at a time: other queued instructions show they wait for this one. Its outcome is
      // recorded even if telling the page fails.
      try { this.changed(); } finally { await sending; }
      await this.settleSteer(run, selected.target.id);
      return this.list().find(item => item.id === runId)!;
    } catch (error) {
      await this.settleSteer(run, selected.target.id, error, !submitted);
      throw error;
    }
  }

  /** Records how an instruction for a running turn ended, then lets that turn close if it has nothing left. */
  private async settleSteer(run: Run, targetRunId: string, error?: unknown, unsent = false): Promise<void> {
    this.admissions.delete(run.id);
    if (!run.steering) { this.owned.get(targetRunId)?.finishInput?.(); return; }
    if (error === undefined) { run.steering.state = 'delivered'; run.steering.deliveredAt = new Date().toISOString(); }
    else if (unsent || (error instanceof SteeringError && error.disposition === 'rejected')) { delete run.steering; delete run.startedAt; run.status = 'queued'; }
    else {
      run.steering.state = 'uncertain'; run.status = 'error'; run.finishedAt = new Date().toISOString();
      run.error = `Delivery could not be confirmed. Check the conversation before sending again. ${errorMessage(error)}`;
    }
    this.changed();
    try { await this.flush(); } finally { this.owned.get(targetRunId)?.finishInput?.(); }
  }

  /** `reason` is recorded on the cancelled run (a forced update says why it stopped). */
  async cancel(runId: string, reason?: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new RunError('Task not found.', 'not-found');
    if (FINISHED.has(run.status)) return;
    if (run.steering) throw new RunError('An inserted instruction belongs to the active turn. Stop the active turn instead.', 'conflict');
    const noted = () => { if (reason && run.status === 'cancelled' && run.error !== reason) { run.error = reason; this.changed(); } };
    // Stopped by the owner, not by the update's deadline: the update does not bring the work back.
    if (!reason) { this.ownerStopped.add(runId); run.ownerStopped = true; this.changed(); }
    const bridge = this.bridged.get(runId);
    if (bridge) {
      // The shared server owns the process. Interrupt only our correlated turn.
      try { await bridge.cancel(); } finally { noted(); }
      await this.flush();
      return;
    }
    const stdio = this.stdio.get(runId);
    if (stdio) {
      try { await stdio.cancel(); } finally { noted(); }
      await this.flush();
      return;
    }
    run.status = 'cancelled';
    run.finishedAt = new Date().toISOString();
    if (reason) run.error = reason;
    const owned = this.owned.get(runId);
    owned?.claude?.close();
    if (owned) this.stopOwned(runId, owned);
    this.changed();
    await this.flush();
  }

  async respondToApproval(runId: string, approvalId: string, decision: RunApprovalResponse): Promise<Run> {
    const run = this.runs.get(runId);
    if (!run) throw new RunError('Task not found.', 'not-found');
    const owned = this.owned.get(runId);
    const stdio = this.stdio.get(runId);
    if (this.stopping || run.status !== 'running' || (!owned?.claude && !stdio) || !run.approvals?.some(approval => approval.id === approvalId)) {
      throw new RunError('This permission request is no longer pending. Refresh the conversation.', 'conflict');
    }
    // The owner's own words to the agent, kept whole with what was asked, before they go (see ownerAnswers).
    this.answers.record(run.sessionId, run.approvals!.find(approval => approval.id === approvalId)!, decision);
    if (stdio) await stdio.respondToApproval(approvalId, decision);
    else {
      await owned!.claude!.respond(approvalId, decision);
    }
    return this.list().find(item => item.id === runId)!;
  }


  /** The state lock cannot be released while this store still deletes published originals. */
  async pauseAttachmentCleanup(): Promise<void> {
    this.attachmentCleanupPaused = true;
    if (this.attachmentCleanupTimer) clearInterval(this.attachmentCleanupTimer);
    this.attachmentCleanupTimer = undefined;
    await this.attachmentCleanup;
  }

  resumeAttachmentCleanup(): void {
    if (!this.started || this.stopping || this.attachmentCleanupTimer) return;
    this.attachmentCleanupPaused = false;
    this.attachmentCleanupTimer = setInterval(() => { void this.cleanupAttachments(); }, 60_000);
    this.attachmentCleanupTimer.unref();
  }

  private cleanupAttachments(): Promise<void> {
    if (this.attachmentCleanupPaused) return Promise.resolve();
    if (this.attachmentCleanup) return this.attachmentCleanup;
    const pending = this.sweepAttachments().catch(error => console.error('Run attachment cleanup failed:', error));
    this.attachmentCleanup = pending;
    void pending.then(() => { if (this.attachmentCleanup === pending) this.attachmentCleanup = undefined; });
    return pending;
  }

  private sweepAttachments(): Promise<void> {
    const protectedIDs = new Set([...this.runs.values()].filter(run => !this.admissions.has(run.id)).flatMap(run => run.attachments?.map(item => item.id) ?? []));
    return this.attachments.sweepPending(protectedIDs, new Set(), { isProtected: id =>
      [...this.runs.values()].some(run => run.attachments?.some(item => item.id === id))
      || [...this.incomingAttachments].some(ids => ids.includes(id)) });
  }

  async close(): Promise<void> {
    await this.pauseAttachmentCleanup();
    if (this.stopping) return;
    this.stopping = true;
    this.toolNotices.clear();
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.notifyTimer) { clearTimeout(this.notifyTimer); this.notifyTimer = undefined; }
    this.cancelOutputPersist();
    for (const run of this.runs.values()) {
      // A continuation that has not started stays saved; the next worker delivers it.
      if (run.status === 'queued' && run.scheduled) continue;
      if ((run.status === 'queued' || run.status === 'running') && !this.bridged.has(run.id) && !this.stdio.has(run.id)) {
        run.status = 'cancelled';
        run.finishedAt = new Date().toISOString();
        run.error = 'Stopped when Agent Session Tower shut down. This task will not restart automatically.';
      }
    }
    const processes = [...this.owned.entries()];
    const bridges = [...this.bridged.entries()];
    const stdio = [...this.stdio.values()];
    for (const [id, owned] of processes) this.stopOwned(id, owned);
    await Promise.all([
      ...processes.map(([, owned]) => owned.done),
      ...stdio.map(async owned => { try { await owned.cancel(); } catch { /* The adapter records unconfirmed cancellation as an error. */ } finally { owned.close(); await owned.done; } }),
      ...bridges.map(async ([id, bridge]) => {
        try { await bridge.cancel(); }
        catch {
          const run = this.runs.get(id);
          if (run) { run.status = 'error'; run.error = 'Codex 앱과 연결이 끊어져 중지 여부를 확인하지 못했습니다. 원래 앱에서 작업 상태를 확인하세요. 이 요청은 자동 재전송하지 않습니다.'; }
        } finally { bridge.close(); }
      }),
    ]);
    this.persist();
    await this.flush();
  }

  private validateSession(session: Session | undefined): asserts session is Session {
    if (!session) throw new RunError('Session no longer exists. Refresh and select another session.', 'not-found');
    if (!session.resumable) throw new RunError('This session cannot be resumed by its provider.');
    if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(session.nativeId)) throw new RunError('The native session ID is invalid.');
    if (!isAbsolute(session.cwd)) throw new RunError('The session has no valid working directory.');
  }

  private executable(provider: Provider): Promise<string | undefined> {
    return this.options.findExecutable?.(provider) ?? findExecutable(provider, this.options.env);
  }

  private waitReason(session: Session): string {
    if (this.isWorking(session)) return 'Waiting for the current turn to finish before resuming this conversation.';
    if (session.provider === 'codex' && session.activeProcess) return 'Codex 앱이 이 세션의 쓰기 권한을 보유하고 있습니다. 기존 앱 서버에 연결할 수 있을 때 전달하거나, 원래 세션의 연결이 종료되면 재개합니다.';
    if (this.reservedSessions.has(session.id)) return 'Waiting for the previous instruction in this conversation.';
    return 'Queued — preparing to resume this conversation.';
  }

  private isWorking(session: Session): boolean {
    if (session.status !== 'working') return false;
    const settledAt = this.locallySettled.get(session.id);
    return settledAt === undefined || Date.parse(session.updatedAt) > settledAt;
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.stopping || !this.started || !this.ready) return;
    this.pumping = true;
    try {
      this.flushToolNotices();
      if (![...this.runs.values()].some((run) => run.status === 'queued' && due(run))) return;
      await this.options.refreshSessions();
      // While Tower switches workers an owner message does not extend a turn that is being wrapped up.
      if (!this.updating) this.insertIntoWaitingTurns();
      // Tower's continuation after an update resumes the interrupted turn before any message queued behind that turn.
      const ordered = [...this.runs.values()].sort((a, b) => Number(b.scheduled?.resume === 'update') - Number(a.scheduled?.resume === 'update'));
      for (const run of ordered) {
        if (this.stopping) break;
        // Independent conversations can run immediately. Only callers that
        // explicitly configure a worker limit impose a global queue.
        if (this.options.maxConcurrent !== undefined && this.owned.size + this.bridged.size + this.stdio.size >= this.options.maxConcurrent) break;
        if (run.status !== 'queued' || this.admissions.has(run.id) || !due(run) || run.permissionNotice) continue;
        if (this.retentionWait(run)) continue;
        if (!this.permissions.launchable(run)) continue;
        // Someone continued the conversation outside Tower after the agent scheduled this.
        // Tower's continuation after an update follows its own wrap-up message, which counts as a request.
        const requested = run.scheduled && run.scheduled.resume !== 'update' && run.scheduled.resume !== 'permission' && this.getSession(run.sessionId)?.lastRequestAt;
        if (requested && Date.parse(requested) > Date.parse(run.createdAt)) { this.supersede(run, 'The conversation continued before the scheduled time.'); continue; }
        // Each run's own look, taken now: an earlier run's start may have taken a while.
        await this.prepareLaunch(run);
        if (run.status !== 'queued' || this.admissions.has(run.id) || this.stopping || this.retentionWait(run)) continue;
        const refused = this.launchGate?.(run);
        if (refused) {
          run.status = 'cancelled'; run.error = refused; run.finishedAt = new Date().toISOString(); this.changed();
          continue;
        }
        if (automated(run) && [...this.runs.values()].filter(item => item.status === 'running' && automated(item)).length >= this.automationLimit) {
          const reason = 'Waiting: Slack and trigger work is already running at the limit set in Triggers.';
          if (run.output !== reason) { run.output = reason; this.changed(); }
          continue;
        }
        const session = this.getSession(run.sessionId);
        const creating = this.registry.creationRun(run.sessionId) === run.id;
        try {
          if (!session) throw new RunError('Session no longer exists.', 'not-found');
          if (!creating) this.validateSession(session);
          if (this.isWorking(session) || this.reservedSessions.has(session.id)) {
            const reason = this.waitReason(session);
            if (run.output !== reason) { run.output = reason; this.changed(); }
            continue;
          }
          // Looked at in the same step as the reservation below, so a switch to a new worker and a launch never cross.
          if (this.updating) {
            if (run.output !== UPDATE_WAIT) { run.output = UPDATE_WAIT; this.changed(); }
            continue;
          }
          // Looked at in the same step as the reservation below, so an update's hold and a launch never cross.
          if (this.heldProviders.has(session.provider)) {
            const reason = `Waiting: ${session.provider === 'claude' ? 'Claude Code' : 'Codex'} is being updated to its latest version; this starts right after.`;
            if (run.output !== reason) { run.output = reason; this.changed(); }
            continue;
          }
          this.reservedSessions.add(session.id);
          try {
            // The master talks through Tower's own Codex, never a desktop app with its own sign-in.
            if (!creating && session.provider === 'codex' && !this.masterSession(session) && await this.launchBridge(run, session)) continue;
            if (!creating && session.provider === 'codex' && this.getSession(session.id)?.activeProcess) {
              this.reservedSessions.delete(session.id);
              const reason = this.waitReason(session);
              if (run.output !== reason) { run.output = reason; this.changed(); }
              continue;
            }
            await this.launch(run, session, creating);
          }
          catch (error) { this.reservedSessions.delete(session.id); throw error; }
        } catch (error) { this.fail(run, error); }
      }
    } catch (error) {
      // A failed refresh must never allow a write based on stale activity data.
      for (const run of this.runs.values()) if (run.status === 'queued') {
        run.output = `Waiting for session activity to refresh: ${errorMessage(error)}`;
      }
      this.changed();
    } finally { this.pumping = false; }
  }

  /**
   * A turn that has answered and only waits for its background work takes the owner's next message at once instead
   * of holding it until that work ends. Only a session's oldest queued message goes, exactly like an explicit insert.
   */
  private insertIntoWaitingTurns(): void {
    const seen = new Set<string>();
    for (const run of this.runs.values()) {
      if (run.status !== 'queued' || seen.has(run.sessionId)) continue;
      seen.add(run.sessionId);
      if (run.permissionNotice || run.origin?.kind !== 'owner' || run.scheduled || !this.steeringTarget(run)?.target.backgroundWait) continue;
      // steer reserves the run synchronously, so a later pass cannot insert it twice.
      void this.steer(run.id, { whileWaiting: true }).catch(() => {});
    }
  }

  /**
   * Hands a turn to the Codex app holding the conversation open; false when the app cannot take it. The submission is
   * awaited only after it was registered and started in one step, so a run occupies the loop exactly as long as before.
   */
  private async launchBridge(run: Run, session: Session): Promise<boolean> {
    const prepared = await prepareBridgeTurn(this.turnHost, run, session);
    if (prepared.kind === 'unsupported') return false;
    if (prepared.kind === 'refused') return true;
    // The last look, in the same step as the start: nothing can land between them. A look that throws frees the adapter.
    let refused: boolean;
    try { refused = run.status !== 'queued' || this.stopping || this.refusedAtLaunch(run, session); }
    catch (error) { await prepared.dispose({ heldForUpdate: false }); throw error; }
    if (refused) {
      await prepared.dispose({ heldForUpdate: run.status === 'queued' && this.updating });
      this.reservedSessions.delete(session.id);
      return true;
    }
    this.bridged.set(run.id, prepared.handle);
    const submitted = prepared.start();
    await submitted;
    return true;
  }

  /** The master's session talks only through a subscription sign-in (see subscription.ts). */
  private masterSession(session: Session): boolean { return subscriptionOnly(this.options.stateDir ?? defaultStateDir(), session.cwd); }

  private async launchCodex(run: Run, session: Session, creating: boolean): Promise<void> {
    const prepared = await prepareCodexTurn(this.turnHost, run, session, creating);
    if (prepared.kind !== 'ready') return;
    // The last look, in the same step as the start: nothing can land between them. A look that throws frees the adapter.
    let refused: boolean;
    try {
      const current = this.getSession(session.id);
      refused = run.status !== 'queued' || this.stopping || Boolean(current && (this.isWorking(current) || current.activeProcess)) || this.refusedAtLaunch(run, session);
    } catch (error) { await prepared.dispose(); throw error; }
    if (refused) {
      await prepared.dispose();
      this.reservedSessions.delete(session.id);
      return;
    }
    this.stdio.set(run.id, prepared.handle);
    prepared.start();
    // Initialization is independently cancellable and does not block unrelated sessions.
    void prepared.handle.start().catch(() => { prepared.handle.close(); });
  }

  private async launch(run: Run, session: Session, creating = false): Promise<void> {
    if (session.provider === 'codex') return this.launchCodex(run, session, creating);
    const prepared = await prepareClaudeTurn(this.turnHost, run, session, creating);
    if (prepared.kind !== 'ready') return;
    // The last look, in the same step as the start: nothing can land between them.
    let refused: boolean;
    try {
      const latest = this.getSession(session.id);
      refused = run.status !== 'queued' || this.stopping || Boolean(latest && (this.isWorking(latest) || (latest.provider === 'codex' && latest.activeProcess))) || this.refusedAtLaunch(run, session);
      if (!refused) {
        if (!creating) this.validateSession(latest);
        else if (!latest) throw new RunError('Session no longer exists.', 'not-found');
      }
    } catch (error) { await prepared.dispose(); throw error; }
    if (refused) { await prepared.dispose(); this.reservedSessions.delete(session.id); return; }
    const owned = prepared.handle();
    this.owned.set(run.id, owned);
    prepared.start();
  }

  /** The only place a turn's end is decided: it leaves the live turns, frees its conversation, and gets its outcome. */
  private exited(exit: TurnExit): void {
    const { run, session } = exit;
    if (exit.kind === 'claude') {
      const { owned, summary } = exit;
      if (owned.killTimer) clearTimeout(owned.killTimer);
      this.owned.delete(run.id);
      this.reservedSessions.delete(session.id);
      this.settledRuns.add(run.id);
      this.locallySettled.delete(session.id);
      this.locallySettled.set(session.id, Date.now());
      if (this.locallySettled.size > 1000) this.locallySettled.delete(this.locallySettled.keys().next().value!);
      const { code, signal, sawCompletion, sawSessionId, waitTimedOut, outstanding, noticePending } = summary;
      let streamError = summary.streamError;
      if (run.status !== 'cancelled') {
        const recover = !streamError && !waitTimedOut && sawSessionId && (outstanding > 0 || noticePending)
          && !summary.pendingApproval && !summary.pendingSteer && !this.stopping && run.origin?.kind === 'owner';
        if (outstanding || noticePending) this.append(run, `\n[Tower] Provider exit: code=${code ?? 'none'}, signal=${signal ?? 'none'}, result=${sawCompletion}, inputClosedByTower=${summary.inputClosedByTower}, runningTasks=${summary.runningTasks}, unreadTasks=${summary.unreadTasks}.\n`);
        if (!streamError && code === 0 && (!sawCompletion || !sawSessionId)) streamError = 'The provider exited without confirming completion in the requested conversation.';
        if (!streamError && waitTimedOut) streamError = 'The turn answered, but its background work did not finish within the time Tower waits; the work was ended with the turn.';
        else if (!streamError && (outstanding || noticePending)) streamError = 'Claude Code exited before it took the results of background work it started in this turn.';
        if (streamError || code !== 0) {
          const detail = `The provider exited ${signal ? `with signal ${signal}` : `with code ${code ?? 'unknown'}`}.`;
          this.fail(run, [streamError, detail, summary.stderr.trim()].filter(Boolean).join('\n'));
          if (recover) {
            const attempt = (run.scheduled?.backgroundRecoveryAttempt ?? 0) + 1;
            if (attempt <= 3) {
              this.scheduleContinuation(run, { at: Date.now() + (this.options.backgroundRecoveryMs ?? 15_000) * attempt,
                prompt: `${TOWER_NOTICE} The previous Claude process exited while background work still had pending results. Resume the unfinished work in this conversation. First inspect existing output files, task records, and running processes: the delegated work may still be running or may already have finished. Do not start it again or repeat completed actions without checking. Continue through the result and report it. If work is still running, wait using a foreground blocking tool call instead of ending with a promise to return.` }, attempt);
            } else this.append(run, '\n[Tower] Automatic background recovery stopped after three attempts.\n');
          }
        }
        else {
          run.status = 'completed'; run.finishedAt = new Date().toISOString();
          if (summary.wakeup && !this.stopping) this.scheduleContinuation(run, summary.wakeup);
          this.changed();
        }
      } else this.changed();
      exit.finish();
      if (!this.stopping) void this.options.refreshSessions().catch(() => {}).finally(() => this.pump());
    } else if (exit.kind === 'codex') {
      const { result, started } = exit;
      this.stdio.delete(run.id); this.reservedSessions.delete(session.id); delete run.approvals;
      if (started) {
        this.settledRuns.add(run.id); this.locallySettled.delete(session.id); this.locallySettled.set(session.id, Date.now());
        if (this.locallySettled.size > 1000) this.locallySettled.delete(this.locallySettled.keys().next().value!);
      }
      if (!FINISHED.has(run.status)) {
        run.status = result.status; run.error = result.error; run.finishedAt = result.finishedAt ?? new Date().toISOString();
      }
      this.changed();
      if (!this.stopping) void this.options.refreshSessions().catch(() => {}).finally(() => this.pump());
    } else if (exit.kind === 'bridge') {
      const { result, started } = exit;
      this.bridged.delete(run.id);
      this.reservedSessions.delete(session.id);
      // Taken back out of the app's queue before it started: it waits in Tower's queue for the new worker.
      if ((result.withdrawn || exit.heldForUpdate) && !started && run.status === 'queued' && !this.ownerStopped.has(run.id)) {
        run.output = UPDATE_WAIT; delete run.towerTools;
        this.changed();
        return;
      }
      // A lost shared connection does not prove the native turn stopped.
      if (started && result.status === 'completed') {
        this.settledRuns.add(run.id);
        this.locallySettled.set(session.id, Date.now());
      }
      if (!FINISHED.has(run.status)) {
        run.status = result.status; run.error = result.error; run.finishedAt = new Date().toISOString();
        this.changed();
      }
      if (!this.stopping) void this.options.refreshSessions().catch(() => {}).finally(() => this.pump());
    } else {
      this.bridged.delete(run.id); this.reservedSessions.delete(session.id);
      exit.handle.close();
      // Once a shared-server submission was attempted, never fall back to a new
      // writer: a lost acknowledgement must not duplicate the user's instruction.
      this.fail(run, exit.error);
    }
  }

  /**
   * Queues the agent's own continuation with the authority of the turn that scheduled it. Slack and trigger
   * work follows its event's lifecycle, so an agent there does not schedule more of it.
   */
  private scheduleContinuation(after: Run, wakeup: Wakeup, backgroundRecoveryAttempt?: number): void {
    if (automated(after)) return;
    // Tower's continuation after a forced update already resumes this conversation.
    if ([...this.runs.values()].some(run => run.status === 'queued' && run.scheduled?.resume === 'update' && run.scheduled.afterRunId === after.id)) return;
    const live = [...this.runs.values()].filter(run => run.status === 'queued' || run.status === 'running');
    // An instruction inserted into the finished turn still mirrors it until the next change; it is part of that turn.
    if (live.some(run => run.sessionId === after.sessionId && run.steering?.targetRunId !== after.id)
      || live.filter(run => run.scheduled && run.scheduled.resume !== 'update').length >= MAX_QUEUED) return;
    // Instructions the turn could not go without (receipts, policy) go on with it; a first turn's notes do not.
    const run: Run = { id: randomUUID(), sessionId: after.sessionId, ...inheritedRunFields(after), prompt: wakeup.prompt, status: 'queued',
      createdAt: new Date().toISOString(), output: SCHEDULED_OUTPUT, scheduled: { at: new Date(wakeup.at).toISOString(), afterRunId: after.id, ...(backgroundRecoveryAttempt ? { backgroundRecoveryAttempt } : {}) } };
    if (backgroundRecoveryAttempt) {
      run.output = 'Tower will resume unfinished background work after an unexpected provider exit.';
      this.append(after, `\n[Tower] Scheduled background recovery ${backgroundRecoveryAttempt}/3.\n`);
    }
    this.runs.set(run.id, run);
    this.prune();
    this.changed();
  }

  /** The owner asked Tower to switch to its new version now (see UpdateDrain). */
  beginUpdateDrain(deadline: number, delegated: (run: Run) => boolean): void { this.drain.begin(deadline, delegated); }

  /** While a forced update holds new turns back. */
  private get updating(): boolean { return this.drain.active; }

  /** Gives up a forced update that could not hand off: queued turns start again here and nothing is cancelled. */
  endUpdateDrain(): void { this.drain.end(); }

  /** Shown while a forced update waits for running turns to wrap up. */
  updateDrainStatus(): { startedAt: string; deadline: string; running: number } | undefined { return this.drain.status(); }

  /** Called about once a second while a forced update waits: wrap-up requests, Codex app submissions, the deadline. */
  driveUpdateDrain(now = Date.now()): void { this.drain.drive(now); }

  private supersede(run: Run, reason: string): void {
    run.status = 'cancelled'; run.finishedAt = new Date().toISOString(); run.output = `Scheduled continuation not started: ${reason}`;
    this.changed();
  }

  /** Work that is live, or will start within `withinMs`. A continuation due later waits in saved state for any worker. */
  hasWorkWithin(withinMs: number): boolean {
    const until = Date.now() + withinMs;
    return [...this.runs.values()].some(run => run.status === 'running' || (run.status === 'queued' && due(run, until)));
  }

  private stopOwned(id: string, owned: OwnedProcess): void {
    owned.claude?.close();
    const signal = (name: NodeJS.Signals): void => {
      if (this.owned.get(id) !== owned) return;
      try {
        if (owned.child.pid && process.platform !== 'win32') process.kill(-owned.child.pid, name);
        else if (owned.child.exitCode === null) owned.child.kill(name);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH' && owned.child.exitCode === null) owned.child.kill(name); }
    };
    signal('SIGTERM');
    if (!owned.killTimer) {
      owned.killTimer = setTimeout(() => { signal('SIGKILL'); }, 3000);
      owned.killTimer.unref();
    }
  }

  private fail(run: Run, error: unknown): void {
    if (run.status === 'cancelled') return;
    run.status = 'error'; run.error = errorMessage(error); run.finishedAt = new Date().toISOString(); this.changed();
  }

  private append(run: Run, value: string): void {
    run.output = (run.output + value).slice(-MAX_OUTPUT);
    this.notifyOutput();
  }

  /** What a run shows changed: told at most every 200 ms. */
  private notifyOutput(): void {
    if (!this.notifyTimer) {
      this.notifyTimer = setTimeout(() => { this.notifyTimer = undefined; this.outputChanged(); }, 200);
      this.notifyTimer.unref();
    }
  }

  /**
   * Output is shown at once but saved on a slower cadence: a restored in-progress run is marked
   * interrupted anyway, and every state change saves the latest output with it.
   */
  private outputChanged(): void {
    this.emit('change');
    if (this.outputPersistTimer || this.stopping) return;
    this.outputPersistTimer = setTimeout(() => { this.outputPersistTimer = undefined; this.persist(); }, this.options.outputPersistMs ?? 2000);
    this.outputPersistTimer.unref();
  }

  private cancelOutputPersist(): void {
    if (this.outputPersistTimer) clearTimeout(this.outputPersistTimer);
    this.outputPersistTimer = undefined;
  }

  private changed(): void {
    for (const run of this.runs.values()) {
      if (run.status !== 'running' || run.steering?.state !== 'delivered') continue;
      const target = this.runs.get(run.steering.targetRunId);
      if (target && FINISHED.has(target.status)) {
        run.status = target.status; run.finishedAt = target.finishedAt; run.error = target.error;
        this.settledRuns.add(run.id);
      }
    }
    this.drain.track();
    this.permissions.sweep();
    const retained = this.retainedIds();
    this.prune(retained);
    this.persist(retained); this.emit('change');
  }

  private prune(retained = this.retainedIds()): void {
    // The runs that finished longest ago go first: a long turn that just finished is still read by its watchers.
    const finished = [...this.runs.values()].filter(run => FINISHED.has(run.status) && !retained.has(run.id)).sort((a, b) => finishedTime(a) - finishedTime(b));
    for (const run of finished.slice(0, Math.max(0, finished.length - MAX_RUNS))) { this.runs.delete(run.id); this.settledRuns.delete(run.id); }
    for (const id of this.ownerStopped) if (!this.runs.has(id) || FINISHED.has(this.runs.get(id)!.status)) this.ownerStopped.delete(id);
  }

  private persist(retained = this.retainedIds()): void {
    // This save includes any streamed output that was waiting for its slower cadence.
    this.cancelOutputPersist();
    // A wrap-up request is never carried: after a restart it would start as a turn of its own.
    if (this.updating) for (const run of this.runs.values()) if (run.status === 'queued' && !run.scheduled && !this.drain.isWrapUp(run.id)) this.history.carried.add(run.id);
    this.history.save(this.runs, this.list(), this.registry.serialize(), retained);
  }

  /** Waits for every accepted change to reach disk, without stopping or cancelling anything. */
  async flushState(): Promise<void> {
    this.persist(); await this.flush();
    this.history.checkInstructionsSaved();
  }

  /**
   * Holds new launches of `provider` while its CLI is updated, but only when none of its runs is starting or running;
   * undefined when one is. Synchronous, so nothing launches between the look and the hold. Releasing it starts what
   * waited.
   */
  holdProvider(provider: Provider): (() => void) | undefined {
    const of = (sessionId: string) => (this.getSession(sessionId) ?? this.registry.created(sessionId))?.provider ?? sessionId.split(':')[0];
    const inFlight = [...this.reservedSessions].some(id => of(id) === provider)
      || [...this.runs.values()].some(run => run.status === 'running' && of(run.sessionId) === provider);
    if (inFlight || this.heldProviders.has(provider)) return undefined;
    this.heldProviders.add(provider);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.heldProviders.delete(provider);
      void this.pump();
    };
  }

  /** True while any provider process, desktop turn or admission is still live, whatever the run status says. */
  busy(): boolean { return this.owned.size + this.bridged.size + this.stdio.size + this.admissions.size + this.reservedSessions.size + this.toolNotices.sending > 0 || this.pumping; }

  private flush(): Promise<void> { return this.history.flush(); }
}

function automated(run: Run): boolean { return automatedOrigin(run.origin); }
