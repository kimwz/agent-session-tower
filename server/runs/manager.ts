import type { PermissionRequest } from '../../shared/permissions.js';
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { CreateSessionRequest, MessageAttachments, Provider, Run, RunApprovalResponse, RunInstructions, RunOrigin, Session, SteerBlock } from '../../shared/types.js';
import { attachmentMetadata, attachmentPrompt, AttachmentStore, claudeImageBlocks, imagePaths } from '../stores/attachments.js';
import { normalizeSessionTitle } from '../stores/session-titles.js';
import type { CodexBridgeRun, CodexBridgeOptions } from './codex-bridge.js';
import { requestedEffort, requestedModel, validModelId } from '../providers/models.js';
import { SteeringError } from './steering.js';
import { ClaudeControl } from './claude-control.js';
import { openCodexStdioRun, type CodexStdioOptions, type CodexStdioRun } from './codex-stdio.js';
import { claudeInputTokens, contextCapacity, modelContextWindow, nativeContextObservation, withNativeContext } from '../sessions/context.js';
import { defaultStateDir } from '../state-dir.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { findExecutable, PROVIDERS } from '../providers/discovery.js';
import { towerInstructionsBlock } from '../sessions/parser.js';
import { isCreatedSession, isSavedRun, UUID, type CreatedSession } from './saved-state.js';
import { buildCreateArgs, buildResumeArgs } from './claude-args.js';
import { ReplyLog } from './replies.js';
import { checkClaudeSubscription, markMaster, MASTER_TOOL_TIMEOUT_SECONDS, subscriptionOnly } from './subscription.js';
import { awaitToolServers, NO_RUN_TOOLS, privateMcpConfig, type RunTools } from './session-mcp.js';
import { automatedOrigin, ownerOrigin, parseRunOrigin, restoredSessionOrigin, sameOrigin, sessionOriginOf, type SessionOrigin } from './origin.js';
import { WakeupTracker, type Wakeup } from './wakeup.js';
import { TOWER_NOTICE } from '../../shared/task-notification.js';
import { BackgroundTaskTracker, messageText, type FinishedTask } from './background-tasks.js';
import { automaticApprovals, claudeStartMode, codexReviewer, creationReviewer } from './approval-policy.js';
import { OwnerAnswers } from './owner-answers.js';
import { MAX_INSTRUCTIONS, TurnNotes } from './turn-notes.js';
import { sessionEnv, turnEnv, type LaunchMarks } from './turn-env.js';
import { ToolNotices } from './tool-notices.js';
import { errorMessage, FINISHED, finishedTime, notAdmitted, RunError, shown } from './run-records.js';
import { PermissionContinuations, restorePermissionRun, retainedReceipts } from './permission-continuation.js';

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
interface OwnedProcess {
  child: ChildProcessWithoutNullStreams;
  done: Promise<void>;
  killTimer?: ReturnType<typeof setTimeout>;
  claude?: ClaudeControl;
  finishInput?: () => void;
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
}

const MAX_OUTPUT = 64_000;
/** Marks, in runs.json, a turn still to run whose instructions (kept only in memory) it cannot go without. */
const NEEDS_INSTRUCTIONS = 'needsInstructions';
type SteerableAdapter = CodexStdioRun | CodexBridgeRun | ClaudeControl;
/** What the page shows about inserting a queued instruction now: the button, or why not. */
function steerable(steering: { target: Run } | { blocked: SteerBlock } | undefined): Pick<Run, 'canSteer' | 'steerBlocked'> {
  return steering && 'blocked' in steering ? { canSteer: false, steerBlocked: steering.blocked } : { canSteer: Boolean(steering) };
}
function checkedInstructions(value: RunInstructions): RunInstructions {
  if (typeof value?.text !== 'string' || !value.text.trim() || value.text.length > MAX_INSTRUCTIONS) throw new RunError('Tower instructions for this turn are invalid or too long.', 413);
  return { text: value.text, ...(value.required ? { required: true } : {}) };
}
const MAX_PROMPT = 32_000;
/** Finished runs kept; unfinished runs, and runs an automation still has to report, are never dropped for this. */
const MAX_RUNS = 100;
const MAX_RETAINED = 50;
/** A retained finished run keeps what its result notice uses. */
const RETAINED_OUTPUT = 20_000;
const MAX_SAVED_BYTES = 64 * 1024 * 1024;
/** What builds before 1.86.0 read at most. */
const LEGACY_SAVED_BYTES = 11_500_000;
/** Marks, in runs.json, a queued turn accepted while Tower switched workers: a restart keeps it queued. */
const KEEP_QUEUED = 'keepQueued';
/** Marks, in runs.json, a finished run an automation still has to report. */
const RETAIN = 'retain';
const UPDATE_WAIT = 'Waiting: Tower is switching to its new version; this starts right after.';
const UPDATE_RESUME_WAIT = 'Tower resumes this conversation on its new version.';
const WRAP_UP_RETRY_MS = 30_000;
const WRAP_UP_NOTICE = `${TOWER_NOTICE} Tower is about to restart to apply an update. Within the next few minutes bring your work to a safe stopping point: finish or pause the current step, do not start long or risky operations, and do not leave half-applied changes. Then end your turn with a short note of what is done and what remains. Tower resumes this conversation automatically right after the update. Do not report the task as finished unless it is.`;
const RESUME_NOTICE = `${TOWER_NOTICE} Tower was updated while this conversation was working, and the previous turn was ended for the update. Continue the original task. First check the conversation, files and running processes to see what was already done; do not repeat actions with outside effects (deploys, pushes, sent messages) without checking their result. If the task is already complete, say so briefly and stop.`;
const UPDATE_STOPPED = 'Stopped for a Tower update before it finished; Tower resumes the conversation on its new version.';
const DELEGATED_STOPPED = 'Stopped for a Tower update before it finished; it was not resumed automatically.';
const UPDATE_NOT_STARTED = 'Stopped for a Tower update before it started in the Codex app. Send the instruction again.';

/** A running turn a forced update is ending, and Tower's own continuation for it. */
interface UpdateTarget { delegated: boolean; retryAt: number;
  /** A wrap-up request is being inserted right now. */
  sending?: boolean;
  /** A wrap-up request was handed to the turn (it may or may not have taken it). */
  reached?: boolean;
  /** A deadline asked for its stop (kept across forced updates; decides whether it is carried on). */
  stopping?: boolean;
  /** The forced update (its sequence number) whose deadline sent the stop; a later one sends it again. */
  stopSent?: number }
/** `active` while new turns wait; after a give-up, turns already stopped or asked to wrap up are still settled. */
interface UpdateDrain { sequence: number; startedAt: number; deadline: number; delegated: (run: Run) => boolean; active: boolean; targets: Map<string, UpdateTarget>; stoppingBridges: Set<string>; wrapUps: Set<string> }
const MAX_QUEUED = 32;
/** A scheduled continuation Tower was not running for is still delivered this long after its time. */
const SCHEDULE_GRACE_MS = 60 * 60 * 1000;
const BACKGROUND_FOLLOW_UP_MS = 60_000;
const BACKGROUND_WAIT_MAX_MS = 2 * 60 * 60 * 1000;
/** What Tower tells Claude when a finished background task did not start a follow-up turn by itself. */
function backgroundNotice(finished: readonly FinishedTask[]): string {
  const lines = finished.map(task => `- ${task.status}${task.summary ? `: ${task.summary}` : ''}${task.outputFile ? ` (output: ${task.outputFile})` : ''}`);
  return `${TOWER_NOTICE} Background work you started in this conversation has finished${lines.length ? `:\n${lines.join('\n')}` : '.'}\n`
    + 'Continue with what you planned to do once it finished, and report the result.';
}
const due = (run: Run, now = Date.now()) => !run.scheduled || Date.parse(run.scheduled.at) <= now;

export { RunError };

/** Owns only processes launched by this monitor; never signals an external agent. */
export class RunManager extends EventEmitter {
  private readonly options: RunnerOptions;
  private readonly stateFile: string;
  private readonly createdFile: string;
  private readonly attachments: AttachmentStore;
  private readonly createdSessions = new Map<string, CreatedSession>();
  private readonly runs = new Map<string, Run>();
  private readonly answers = new OwnerAnswers();
  private readonly owned = new Map<string, OwnedProcess>();
  private readonly bridged = new Map<string, CodexBridgeRun>();
  private readonly notes = new TurnNotes(() => this.options);
  private readonly stdio = new Map<string, CodexStdioRun>();
  private readonly reservedSessions = new Set<string>();
  /** CLIs being updated: none of their runs start until the update is done. */
  private readonly heldProviders = new Set<Provider>();
  private readonly admissions = new Set<string>();
  private readonly locallySettled = new Map<string, number>();
  private readonly settledRuns = new Set<string>();
  /** Queued runs accepted while Tower switched workers; a restart keeps them queued (see KEEP_QUEUED). */
  private readonly carried = new Set<string>();
  /** Runs the owner asked to stop; a Codex app submission taken back for an update is then not queued again. */
  private readonly ownerStopped = new Set<string>();
  private retained: () => Iterable<string> = () => [];
  /** Runs saved as retained: kept until the automations that know which runs they need are loaded (`markReady`). */
  private readonly restoredRetained = new Set<string>();
  private drain?: UpdateDrain;
  private ready: boolean;
  private readonly instructionsFile: string;
  private pollTimer?: ReturnType<typeof setInterval>;
  private notifyTimer?: ReturnType<typeof setTimeout>;
  private outputPersistTimer?: ReturnType<typeof setTimeout>;
  /** The last content each file holds. Updated only inside the write queue, after a successful write. */
  private readonly saved: { runs?: string; created?: string; instructions?: string } = {};
  private pumping = false;
  private automationLimit = Infinity;
  private launchGate?: (run: Run) => string | undefined;
  private launchPrepare?: (run: Run) => Promise<void>;
  private started = false;
  private stopping = false;
  private writes: Promise<void> = Promise.resolve();
  private persistenceError?: Error;
  /** The last save of required instructions failed: a handoff would lose them, so `flushState` refuses. */
  private instructionsError?: Error;

  constructor(options: RunnerOptions) {
    super();
    this.options = options;
    this.stateFile = join(options.stateDir ?? defaultStateDir(), 'runs.json');
    this.createdFile = join(options.stateDir ?? defaultStateDir(), 'created-sessions.json');
    // Instructions a queued turn cannot go without, kept apart from runs.json so no older Tower ever shows them.
    this.instructionsFile = join(options.stateDir ?? defaultStateDir(), 'run-instructions.json');
    this.ready = !options.holdUntilReady;
    this.attachments = new AttachmentStore(options.stateDir ?? defaultStateDir());
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
    const created = this.createdSessions.get(id);
    const linked = this.options.isExternallyLinked?.([id, this.nativeSessionId(id)]) === true;
    if (!created) return linked ? { kind: 'unknown', untrustedInput: true } : undefined;
    if (linked && !created.origin?.untrustedInput) {
      // The mark is permanent: record it so a later ledger cleanup cannot clear it.
      created.origin = { ...(created.origin ?? { kind: 'unknown' as const }), untrustedInput: true };
      this.persist();
    }
    return { ...(created.origin ?? { kind: 'unknown' as const, untrustedInput: true }) };
  }

  /**
   * Fills provenance for sessions created before it was recorded. Only evidence that survives in the
   * run registry or in external ledgers is used; anything undecidable stays unknown and untrusted.
   */
  backfillSessionOrigins(links: { sessionIds: ReadonlySet<string>; requestIds: ReadonlySet<string> }): number {
    let changed = 0;
    for (const [id, created] of this.createdSessions) {
      if (created.origin) continue;
      const initial = this.runs.get(created.runId);
      const aliases = [id, this.nativeSessionId(id)];
      if (aliases.some(alias => links.sessionIds.has(alias)) || (initial?.autoPromptId && links.requestIds.has(initial.autoPromptId))) {
        created.origin = { kind: 'slack', untrustedInput: true };
      } else if (initial) created.origin = { kind: 'owner', untrustedInput: false };
      else created.origin = { kind: 'unknown', untrustedInput: true };
      changed++;
    }
    if (changed) this.persist();
    return changed;
  }

  async start(): Promise<void> {
    if (this.started) return;
    await mkdir(this.options.stateDir ?? defaultStateDir(), { recursive: true, mode: 0o700 });
    await this.attachments.start();
    try {
      const saved = await readPrivateJson(this.createdFile);
      if (!Array.isArray(saved) || saved.some(value => !isCreatedSession(value))) throw new Error('Saved created sessions are invalid.');
      for (const value of saved) {
        const origin = restoredSessionOrigin((value as { origin?: unknown }).origin);
        if (origin) value.origin = origin; else delete value.origin;
        this.createdSessions.set(value.session.id, value);
      }
      this.saved.created = JSON.stringify([...this.createdSessions.values()]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Without any created session, the identities file is never created.
      this.saved.created = '[]';
    }
    const kept = await this.savedInstructions();
    try {
      if ((await stat(this.stateFile)).size > MAX_SAVED_BYTES) throw new Error('Saved run history is too large.');
      const saved: unknown = JSON.parse(await readFile(this.stateFile, 'utf8'));
      if (!Array.isArray(saved)) throw new Error('Saved run history is invalid.');
      const valid = saved.slice(-1000).filter(isSavedRun);
      // Every unfinished run and every run an automation still has to report comes back; of the rest, the newest.
      const marked = (value: Run, key: string) => (value as unknown as Record<string, unknown>)[key] === true;
      const finished = valid.filter(value => FINISHED.has(value.status) && !marked(value, RETAIN)).sort((a, b) => finishedTime(a) - finishedTime(b));
      const dropped = new Set(finished.slice(0, Math.max(0, finished.length - MAX_RUNS)));
      for (const value of valid) {
        if (dropped.has(value)) continue;
        const run: Run = { ...value, prompt: value.prompt.slice(0, MAX_PROMPT), output: value.output.slice(-MAX_OUTPUT),
          ...(value.attachments ? { attachments: value.attachments.map(item => attachmentMetadata(item)!) } : {}) };
        // A malformed origin never reads back as owner work.
        if (value.origin !== undefined) run.origin = parseRunOrigin(value.origin) ?? { kind: 'unknown' };
        // A permission request belongs to a live process, never a restored run.
        delete run.approvals;
        delete run.instructions;
        let needsInstructions = marked(value, NEEDS_INSTRUCTIONS);
        const keepQueued = marked(value, KEEP_QUEUED);
        if (marked(value, RETAIN)) this.restoredRetained.add(run.id);
        for (const key of [NEEDS_INSTRUCTIONS, KEEP_QUEUED, RETAIN]) delete (run as unknown as Record<string, unknown>)[key];
        const instructions = needsInstructions && !FINISHED.has(run.status) ? kept.get(run.id) : undefined;
        if (instructions) { run.instructions = instructions; needsInstructions = false; }
        delete run.canSteer; delete run.steerBlocked;
        delete run.backgroundWait;
        if (run.steering?.state === 'sending') run.steering.state = 'uncertain';
        const context = nativeContextObservation(run.contextUsage);
        if (context) run.contextUsage = context; else delete run.contextUsage;
        // A continuation that has not started is only a time and the agent's own prompt; it waits again, unless it needed
        // instructions, which did not survive the restart.
        if (run.status === 'queued' && run.scheduled && needsInstructions) {
          run.status = 'cancelled';
          run.error = 'Agent Session Tower restarted before this continuation, and it would have run without the instructions Tower gave its turn. It was not started; send an instruction to continue.';
          run.finishedAt = new Date().toISOString();
        } else if (restorePermissionRun(run)) { /* A permission notice or continuation (see permission-continuation.ts). */ }
        else if (run.status === 'queued' && run.scheduled?.resume === 'update') run.output = UPDATE_RESUME_WAIT;
        else if (run.status === 'queued' && run.scheduled && Date.parse(run.scheduled.at) > Date.now() - SCHEDULE_GRACE_MS) run.output = scheduledOutput;
        // Accepted while Tower switched to its new version: it runs here, exactly once.
        else if (run.status === 'queued' && keepQueued && !needsInstructions) this.carried.add(run.id);
        else if (run.status === 'running' || run.status === 'queued') {
          const missedSchedule = run.status === 'queued' && run.scheduled;
          run.status = run.status === 'running' ? 'error' : 'cancelled';
          run.error = run.steering
            ? 'Agent Session Tower stopped before this inserted instruction finished. It was not resent. Check the conversation before sending again.'
            : missedSchedule
              ? 'Agent Session Tower was not running when this scheduled continuation was due. It was not started; send an instruction to continue.'
              : 'Agent Session Tower stopped before this task finished. It was not restarted; send the instruction again to continue.';
          run.finishedAt = new Date().toISOString();
        }
        this.runs.set(run.id, run);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.started = true;
    // Without a worker to load the automations later, the retained runs are whatever they report from now on.
    if (this.ready) this.restoredRetained.clear();
    this.changed();
    await this.flush();
    this.pollTimer = setInterval(() => { void this.pump(); }, this.options.pollMs ?? 1500);
    this.pollTimer.unref();
  }

  /** Required instructions of queued turns, saved apart from runs.json. A file that cannot be read keeps none. */
  private async savedInstructions(): Promise<Map<string, RunInstructions>> {
    const kept = new Map<string, RunInstructions>();
    try {
      const saved = await readPrivateJson(this.instructionsFile);
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        for (const [id, value] of Object.entries(saved as Record<string, unknown>)) {
          try { if (UUID.test(id)) kept.set(id, { ...checkedInstructions(value as RunInstructions), required: true }); } catch { /* An invalid entry is left out. */ }
        }
      }
      this.saved.instructions = JSON.stringify(Object.fromEntries(kept));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`Saved turn instructions were not read: ${errorMessage(error)}`);
    }
    return kept;
  }

  /** Starts queued runs once everything a launch asks for is in place (see `holdUntilReady`). */
  markReady(): void { if (this.ready) return; this.ready = true; this.restoredRetained.clear(); void this.pump(); }

  /** Runs an automation still has to report: kept through pruning and restarts. */
  setRetained(retained: () => Iterable<string>): void { this.retained = retained; }

  private retainedIds(): Set<string> {
    const ids = [...new Set([...this.restoredRetained, ...this.retained()])].map(id => this.runs.get(id)).filter((run): run is Run => !!run)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, MAX_RETAINED).map(run => run.id);
    return new Set([...ids, ...retainedReceipts(this.runs.values())]);
  }

  list(): Run[] { return [...this.runs.values()].map((run) => ({ ...shown(run), ...steerable(this.steering(run)), ...(run.steering ? { steering: { ...run.steering } } : {}), ...(run.attachments ? { attachments: run.attachments.map(item => ({ ...item })) } : {}),
    ...(run.contextUsage ? { contextUsage: { ...run.contextUsage } } : {}),
    ...(run.approvals ? { approvals: structuredClone(run.approvals) } : {}) })); }
  async attachment(id: string) {
    const { metadata, content, sessionId } = await this.attachments.read(id);
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
  nativeSessionId(id: string): string {
    id = this.monitorSessionId(id);
    const created = this.createdSessions.get(id);
    return created?.confirmed ? `${created.session.provider}:${created.session.nativeId}` : id;
  }

  getSession(id: string): Session | undefined {
    id = this.monitorSessionId(id);
    const created = this.createdSessions.get(id);
    if (!created) {
      const native = this.options.getSession(id);
      if (!native) return undefined;
      return this.sessionWithContext(native.parentId ? { ...native, parentId: this.monitorSessionId(native.parentId) } : native);
    }
    const native = created.confirmed ? this.options.getSession(this.nativeSessionId(id)) : undefined;
    if (native && !created.seenNative) { created.seenNative = true; this.persist(); }
    const initialRun = this.runs.get(created.runId);
    const launchedBy = created.origin?.kind === 'trigger' && created.origin.triggerId ? { launchedBy: { kind: 'trigger' as const, triggerId: created.origin.triggerId } } : {};
    // The folder explicitly chosen at creation remains the project's identity.
    // Native discovery may observe a later working directory or incomplete metadata.
    if (native) return this.sessionWithContext({ ...native, id, cwd: created.session.cwd, project: created.session.project, ...(native.parentId ? { parentId: this.monitorSessionId(native.parentId) } : {}), ...(created.title ? { customTitle: created.title } : {}), ...launchedBy });
    if (created.seenNative && (!initialRun || FINISHED.has(initialRun.status))) return undefined;
    const live = initialRun?.status === 'queued' || initialRun?.status === 'running';
    return {
      ...created.session,
      ...launchedBy,
      resumable: created.confirmed,
      creationPending: !created.confirmed && live,
      status: initialRun?.status === 'running' ? 'working' : initialRun?.status === 'queued' ? 'idle' : initialRun?.status === 'completed' ? 'completed' : 'error',
      statusReason: live ? '새 세션을 생성하고 있습니다.' : initialRun?.error || (initialRun?.status === 'completed' ? '첫 작업을 완료했습니다.' : '세션 생성이 완료되지 않았습니다. 새 세션으로 다시 시작할 수 있습니다.'),
      updatedAt: initialRun?.finishedAt || initialRun?.startedAt || created.session.updatedAt,
    };
  }

  private monitorSessionId(id: string): string {
    if (this.createdSessions.has(id)) return id;
    for (const [monitorId, created] of this.createdSessions) {
      if (created.confirmed && `${created.session.provider}:${created.session.nativeId}` === id) return monitorId;
    }
    return id;
  }

  sessionList(nativeSessions: readonly Session[]): Session[] {
    const aliases = new Map([...this.createdSessions.keys()].map(id => [this.nativeSessionId(id), id]));
    const sessions = new Map(nativeSessions.filter(session => !aliases.has(session.id)).map(session => [session.id, session]));
    for (const id of this.createdSessions.keys()) {
      const session = this.getSession(id);
      if (session) sessions.set(id, session);
    }
    const listed = markMaster([...sessions.values()].map(session => this.sessionWithContext(session.parentId && aliases.has(session.parentId)
      ? { ...session, parentId: aliases.get(session.parentId) } : session)), this.options.stateDir ?? defaultStateDir());
    const overlay = this.options.sessionOverlay;
    return overlay ? listed.map(overlay) : listed;
  }

  async create(input: CreateSessionRequest, internal: RunAdmission = {}): Promise<{ session: Session; run: Run }> {
    this.validateCorrelation(internal.autoPromptId);
    this.validateAdmission(input.prompt, Boolean(input.attachments?.length));
    if (!PROVIDERS.includes(input.provider)) throw new RunError('Claude 또는 Codex를 선택하세요.');
    const model = requestedModel(input.model);
    const effort = requestedEffort(input.effort, input.provider);
    const approvalsReviewer = creationReviewer(input, internal.origin);
    if (typeof input.cwd !== 'string' || input.cwd.includes('\0') || input.cwd.length > 4096) throw new RunError('작업 폴더의 절대 경로를 입력하세요.');
    const cwd = input.cwd === '~' || input.cwd.startsWith('~/') ? join(homedir(), input.cwd.slice(1)) : input.cwd;
    if (!isAbsolute(cwd)) throw new RunError('작업 폴더의 절대 경로를 입력하세요.');
    input = { ...input, cwd };
    const title = input.title === undefined ? '' : normalizeSessionTitle(input.title);
    if (!(await this.executable(input.provider))) throw new RunError(`Install the ${input.provider} CLI and ensure it is in PATH before creating a session.`, 503);
    if (internal.createFolder === false) {
      if (!(await stat(cwd).then(info => info.isDirectory(), () => false))) throw new RunError('The working folder does not exist. It was not created.', 404);
    } else {
      // A folder that does not exist yet is created, like `mkdir -p` before starting the CLI there.
      try { await mkdir(cwd, { recursive: true }); if (!(await stat(cwd)).isDirectory()) throw new Error(); }
      catch { throw new RunError('작업 폴더를 만들 수 없습니다. 경로와 권한을 확인하세요.'); }
    }
    const uuid = randomUUID();
    const id = `${input.provider}:${input.provider === 'codex' ? 'monitor-' : ''}${uuid}`;
    const prepared = await this.attachments.prepare(id, { attachments: input.attachments });
    try {
      this.validateAdmission(input.prompt, prepared.attachments.length > 0);
      this.validateCorrelation(internal.autoPromptId);
      internal.validate?.();
    } catch (error) { await this.attachments.rollback(prepared.createdIds); throw error; }
    const createdAt = new Date().toISOString();
    const session: Session = {
      id, nativeId: input.provider === 'claude' ? uuid : '', provider: input.provider,
      title: input.prompt.trim().replace(/\s+/g, ' ').slice(0, 120) || '첨부 파일 확인', ...(title ? { customTitle: title } : {}), cwd: input.cwd, project: basename(input.cwd) || input.cwd,
      status: 'idle', statusReason: '새 세션을 생성하고 있습니다.', createdAt, updatedAt: createdAt,
      lastRequestAt: createdAt, lastMessage: input.prompt.trim().slice(0, 512), messageCount: 0, isSubagent: false, resumable: false, creationPending: true,
    };
    const origin = internal.origin ?? { kind: 'unknown' as const };
    const run: Run = { id: randomUUID(), sessionId: id, origin, ...(internal.delegation ? { delegation: { ...internal.delegation } } : {}), prompt: input.prompt, status: 'queued', createdAt, output: 'Queued — preparing to create this conversation.', ...(model ? { model } : {}), ...(effort ? { effort } : {}),
      ...(internal.unattended ? { unattended: true } : {}), ...(internal.instructions ? { instructions: checkedInstructions(internal.instructions) } : {}),
      ...(approvalsReviewer ? { codexApprovalsReviewer: approvalsReviewer } : {}),
      ...(prepared.attachments.length ? { attachments: prepared.attachments } : {}), ...(internal.autoPromptId ? { autoPromptId: internal.autoPromptId } : {}) };
    // Provenance commits with the session identity, before any provider starts.
    this.createdSessions.set(id, { session, runId: run.id, confirmed: false, ...(title ? { title } : {}), origin: sessionOriginOf(origin, internal.untrustedInput === true) });
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
    void this.pump();
    return { session: this.getSession(id)!, run: shown(run) };
  }

  private validateAdmission(prompt: string, hasAttachments = false): void {
    if (!this.started || this.stopping) throw notAdmitted(new RunError('The task runner is not accepting instructions.', 503));
    if (typeof prompt !== 'string' || (!prompt.trim() && !hasAttachments)) throw new RunError('Enter an instruction or attach a file first.');
    if (prompt.length > MAX_PROMPT) throw new RunError(`Instructions must be at most ${MAX_PROMPT.toLocaleString()} characters.`, 413);
    if ([...this.runs.values()].filter((run) => run.status === 'queued' && !run.scheduled).length >= MAX_QUEUED) throw notAdmitted(new RunError('The task queue is full. Wait for a task to finish.', 429));
  }

  /** External content only enters conversations Tower created and can keep marked. */
  private admitUntrusted(sessionId: string): void {
    if (!this.createdSessions.has(sessionId)) throw new RunError('External trigger content can only continue a conversation Tower created for it.', 409);
  }

  private validateCorrelation(id: string | undefined): void {
    if (id === undefined) return;
    if (!UUID.test(id)) throw new RunError('Invalid Auto Prompt request ID.');
    if ([...this.runs.values()].some(run => run.autoPromptId === id)) throw new RunError('This Auto Prompt already has an execution task.', 409);
  }

  async enqueue(sessionId: string, prompt: string, request: MessageAttachments = {}, internal: RunAdmission = {}): Promise<Run> {
    this.validateCorrelation(internal.autoPromptId);
    sessionId = this.monitorSessionId(sessionId);
    const hasAttachments = Boolean(request.attachments?.length || request.attachmentIds?.length);
    this.validateAdmission(prompt, hasAttachments);
    const session = this.getSession(sessionId);
    this.validateSession(session);
    if (internal.untrustedInput) this.admitUntrusted(sessionId);
    const model = requestedModel(request.model);
    const effort = requestedEffort(request.effort, session.provider);
    if (!(await this.executable(session.provider))) throw new RunError(`Install the ${session.provider} CLI and ensure it is in PATH before sending instructions.`, 503);
    const prepared = await this.attachments.prepare(sessionId, request);
    // File writes yield; recheck admission immediately before inserting the run.
    try { this.validateAdmission(prompt, prepared.attachments.length > 0); this.validateSession(this.getSession(sessionId)); this.validateCorrelation(internal.autoPromptId); internal.validate?.(); }
    catch (error) { await this.attachments.rollback(prepared.createdIds); throw error; }
    if (internal.untrustedInput) {
      // Recorded before the run exists: once external content is queued, the session stays marked.
      const created = this.createdSessions.get(sessionId)!;
      if (!created.origin?.untrustedInput) created.origin = { ...(created.origin ?? { kind: 'unknown' as const }), untrustedInput: true };
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
    // An accepted instruction replaces the continuation the agent planned; its next turn can schedule again.
    // Tower's own continuation after an update is not the agent's plan: it runs first, then this instruction.
    for (const other of this.runs.values()) if (other.sessionId === sessionId && other.status === 'queued' && other.scheduled && (other.scheduled.resume !== 'update' || other.permissionRequestIds?.length)) this.supersede(other, 'A newer instruction was sent before the scheduled time.');
    void this.pump();
    return shown(run);
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
    if (this.permissions.noticeBlocked(run)) return undefined;
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
    if (!run) throw new RunError('Task not found.', 404);
    if (run.steering) return this.list().find(item => item.id === runId)!;
    const selected = this.steeringTarget(run);
    if (!selected) throw new RunError('This queued instruction cannot be inserted into an active Tower turn.', 409);
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
      this.noteHandedOver(run);
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
    if (!run) throw new RunError('Task not found.', 404);
    if (FINISHED.has(run.status)) return;
    if (run.steering) throw new RunError('An inserted instruction belongs to the active turn. Stop the active turn instead.', 409);
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
    if (!run) throw new RunError('Task not found.', 404);
    const owned = this.owned.get(runId);
    const stdio = this.stdio.get(runId);
    if (this.stopping || run.status !== 'running' || (!owned?.claude && !stdio) || !run.approvals?.some(approval => approval.id === approvalId)) {
      throw new RunError('This permission request is no longer pending. Refresh the conversation.', 409);
    }
    // The owner's own words to the agent, kept whole with what was asked, before they go (see ownerAnswers).
    this.answers.record(run.sessionId, run.approvals!.find(approval => approval.id === approvalId)!, decision);
    if (stdio) await stdio.respondToApproval(approvalId, decision);
    else {
      await owned!.claude!.respond(approvalId, decision);
    }
    return this.list().find(item => item.id === runId)!;
  }

  async close(): Promise<void> {
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
    if (!session) throw new RunError('Session no longer exists. Refresh and select another session.', 404);
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
        if (!this.permissions.launchable(run)) continue;
        // Someone continued the conversation outside Tower after the agent scheduled this.
        // Tower's continuation after an update follows its own wrap-up message, which counts as a request.
        const requested = run.scheduled && run.scheduled.resume !== 'update' && run.scheduled.resume !== 'permission' && this.getSession(run.sessionId)?.lastRequestAt;
        if (requested && Date.parse(requested) > Date.parse(run.createdAt)) { this.supersede(run, 'The conversation continued before the scheduled time.'); continue; }
        // Each run's own look, taken now: an earlier run's start may have taken a while.
        await this.prepareLaunch(run);
        if (run.status !== 'queued' || this.admissions.has(run.id) || this.stopping) continue;
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
        const creating = this.createdSessions.get(run.sessionId)?.runId === run.id;
        try {
          if (!session) throw new RunError('Session no longer exists.', 404);
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

  private async launchBridge(run: Run, session: Session): Promise<boolean> {
    // The desktop app owns its tools; only turns that can do without Tower's tools are forwarded.
    const tools = this.runTools(run, session);
    if (tools.required || run.instructions?.required) return false;
    if (!this.options.openCodexBridge) return false;
    const attachments = await this.attachments.resolve(run.sessionId, run.attachments);
    let started = false;
    /** Closed before it was sent because Tower is switching workers: the run waits for the new worker. */
    let heldForUpdate = false;
    const bridge = await this.options.openCodexBridge({
      // The desktop app shows every block it is sent: a turn goes there only without instructions it must have, and without
      // its notes.
      threadId: session.nativeId, runId: run.id, prompt: attachmentPrompt(run.prompt, attachments),
      ...(ownerOrigin(run.origin) ? { approvalsReviewer: 'auto_review' as const } : {}),
      ...(run.model ? { model: run.model } : {}), ...(run.effort ? { effort: run.effort } : {}),
      ...(attachments.length ? { imagePaths: imagePaths(attachments) } : {}),
      onStarted: () => {
        if (FINISHED.has(run.status)) return;
        started = true;
        run.status = 'running'; run.startedAt = new Date().toISOString(); run.output = '';
        this.changed();
      },
      onOutput: text => { if (!FINISHED.has(run.status)) this.append(run, text); },
      onFinished: result => {
        this.bridged.delete(run.id);
        this.reservedSessions.delete(session.id);
        // Taken back out of the app's queue before it started: it waits in Tower's queue for the new worker.
        if ((result.withdrawn || heldForUpdate) && !started && run.status === 'queued' && !this.ownerStopped.has(run.id)) {
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
      },
    });
    if (!bridge) return false;
    await this.prepareLaunch(run);
    if (run.status !== 'queued' || this.stopping || this.refusedAtLaunch(run, session)) {
      heldForUpdate = run.status === 'queued' && this.updating;
      bridge.close(); this.reservedSessions.delete(session.id); return true;
    }
    this.bridged.set(run.id, bridge);
    // The desktop app runs the turn with its own tools; Tower's cannot be attached there.
    if (tools.towerTools) run.towerTools = tools.servers ? 'desktop-app' : tools.towerTools;
    run.output = '열려 있는 Codex 앱의 기존 세션으로 요청을 전달하고 있습니다.';
    this.changed();
    try { await bridge.start(); }
    catch (error) {
      this.bridged.delete(run.id); this.reservedSessions.delete(session.id);
      bridge.close();
      // Once a shared-server submission was attempted, never fall back to a new
      // writer: a lost acknowledgement must not duplicate the user's instruction.
      this.fail(run, error);
    }
    return true;
  }

  /** The master's session talks only through a subscription sign-in (see subscription.ts). */
  private masterSession(session: Session): boolean { return subscriptionOnly(this.options.stateDir ?? defaultStateDir(), session.cwd); }

  private async launchCodex(run: Run, session: Session, creating: boolean): Promise<void> {
    const executable = await this.executable('codex');
    if (!executable) throw new Error('Codex CLI is no longer available in PATH.');
    if (!(await stat(session.cwd)).isDirectory()) throw new Error('The session working directory no longer exists.');
    const attachments = await this.attachments.resolve(run.sessionId, run.attachments);
    const latest = this.getSession(session.id);
    if (run.status !== 'queued' || this.stopping || (latest && (this.isWorking(latest) || latest.activeProcess))) {
      this.reservedSessions.delete(session.id);
      return;
    }
    if (!creating) this.validateSession(latest);
    else if (!latest) throw new RunError('Session no longer exists.', 404);
    const master = this.masterSession(session);
    let started = false;
    let registered = false;
    await this.notes.add(run, session, creating);
    const tools = this.runTools(run, session);
    await awaitToolServers(tools);
    if (run.status !== 'queued' || this.stopping) {
      this.reservedSessions.delete(session.id);
      return;
    }
    const env = turnEnv(this.options.env, master, tools, this.options.launchMarks);
    // The master's own tools may take longer than Codex's default minute (see MASTER_TOOL_TIMEOUT_SECONDS).
    const mcpServers = master && tools.servers?.tower_master
      ? { ...tools.servers, tower_master: { ...tools.servers.tower_master, tool_timeout_sec: MASTER_TOOL_TIMEOUT_SECONDS } as typeof tools.servers.tower_master } : tools.servers;
    if (tools.towerTools) run.towerTools = tools.towerTools;
    const codexReplies = master ? new ReplyLog(run, Date.now) : undefined;
    const owned = await (this.options.openCodexStdio ?? openCodexStdioRun)({
      executable, cwd: session.cwd, env, spawnProcess: this.options.spawnProcess,
      mcpServers, ...(master ? { subscriptionOnly: true } : {}),
      ...(!creating ? { threadId: session.nativeId } : {}),
      ...codexReviewer(run, creating, Boolean(mcpServers?.tower_slack)),
      ...(run.model ? { model: run.model } : {}), ...(run.effort ? { effort: run.effort } : {}),
      prompt: attachmentPrompt(run.prompt, attachments),
      ...(run.instructions?.text ? { instructions: run.instructions.text } : {}),
      imagePaths: imagePaths(attachments),
      onSession: async id => {
        if (!UUID.test(id) || (!creating && id !== session.nativeId)) throw new Error('Codex returned a different or invalid conversation ID. No message was submitted.');
        if (run.status !== 'running' || this.stopping) throw new Error('The task stopped before a message was submitted.');
        if (creating) {
          const created = this.createdSessions.get(session.id);
          if (!created || (created.confirmed && created.session.nativeId !== id)) throw new Error('The new conversation identity changed. No message was submitted.');
          created.confirmed = true; created.session.nativeId = id; created.session.creationPending = false; session.nativeId = id;
          this.changed();
          try { await this.flush(); }
          catch (error) { throw new Error(`Cannot save the new conversation identity: ${errorMessage(error)}`); }
        }
      },
      onStarted: (_turnId, startedAt) => {
        if (FINISHED.has(run.status)) return;
        started = true; run.startedAt = startedAt ?? new Date().toISOString(); this.changed();
      },
      onOutput: text => { if (!FINISHED.has(run.status)) this.append(run, text); },
      ...(codexReplies ? { onReply: (id: string, text: string, done: boolean) => { if (!FINISHED.has(run.status) && codexReplies.add(id, text, done)) this.notifyOutput(); } } : {}),
      onApproval: approval => { if (run.status === 'running') { run.approvals = [...(run.approvals || []), approval]; this.changed(); } },
      onApprovalCancelled: id => {
        if (!run.approvals?.some(approval => approval.id === id)) return;
        run.approvals = run.approvals.filter(approval => approval.id !== id);
        if (!run.approvals.length) delete run.approvals;
        this.changed();
      },
      // The adapter reports completion only after its native child has closed.
      onFinished: result => {
        if (!registered) return;
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
      },
    });
    // Opening an adapter does not spawn. Admission can be cancelled during discovery.
    await this.prepareLaunch(run);
    const current = this.getSession(session.id);
    if (run.status !== 'queued' || this.stopping || (current && (this.isWorking(current) || current.activeProcess)) || this.refusedAtLaunch(run, session)) {
      owned.close(); this.reservedSessions.delete(session.id); return;
    }
    registered = true;
    this.stdio.set(run.id, owned);
    run.status = 'running'; run.output = ''; this.changed();
    // Initialization is independently cancellable and does not block unrelated sessions.
    void owned.start().catch(() => { owned.close(); });
  }

  private async launch(run: Run, session: Session, creating = false): Promise<void> {
    if (session.provider === 'codex') return this.launchCodex(run, session, creating);
    const executable = await this.executable(session.provider);
    if (!executable) throw new Error(`${session.provider} CLI is no longer available in PATH.`);
    if (!(await stat(session.cwd)).isDirectory()) throw new Error('The session working directory no longer exists.');
    const attachments = await this.attachments.resolve(run.sessionId, run.attachments);
    await this.notes.add(run, session, creating);
    const args = creating ? buildCreateArgs(session, run.model, run.effort) : buildResumeArgs(session, run.model, run.effort);
    const tools = this.runTools(run, session);
    await awaitToolServers(tools);
    const mcpServers = tools.servers;
    if (tools.towerTools) run.towerTools = tools.towerTools;
    if (automaticApprovals(run)) args.push('--permission-mode', 'auto');
    // The owner's allow rules go to every turn Tower starts, as Codex reads them in every run: the owner also set up the
    // triggers, Slack and GitHub watches and public agents that start work here, and chose what that work may do.
    const settings = this.options.claudeSettings?.(session.cwd, session.id);
    if (settings) args.push('--settings', settings);
    for (const directory of new Set(attachments.map(item => dirname(item.path)))) args.push('--add-dir', directory);
    const prompt = attachmentPrompt(run.prompt, attachments);
    const input = {
      type: 'user', session_id: session.nativeId, parent_tool_use_id: null,
      message: { role: 'user', content: [
        { type: 'text', text: prompt },
        // A block of its own, not the system prompt: Claude keeps a conversation's first system prompt for every later turn.
        ...(run.instructions?.text ? [{ type: 'text', text: towerInstructionsBlock(run.instructions.text) }] : []),
        ...claudeImageBlocks(attachments),
      ] },
    };
    // Recheck after asynchronous filesystem discovery, immediately before creating the writer.
    await this.prepareLaunch(run);
    const latest = this.getSession(session.id);
    if (run.status !== 'queued' || this.stopping || (latest && (this.isWorking(latest) || (latest.provider === 'codex' && latest.activeProcess))) || this.refusedAtLaunch(run, session)) {
      this.reservedSessions.delete(session.id);
      return;
    }
    if (!creating) this.validateSession(latest);
    else if (!latest) throw new RunError('Session no longer exists.', 404);
    const master = this.masterSession(session);
    const env = turnEnv(this.options.env, master, tools, this.options.launchMarks);
    if (master) {
      env.MCP_TOOL_TIMEOUT = String(MASTER_TOOL_TIMEOUT_SECONDS * 1000);
      // Asked the way the turn will start: same program, folder and environment.
      await (this.options.checkClaudeSubscription ?? checkClaudeSubscription)(executable, session.cwd, env);
      await this.prepareLaunch(run);
      if (run.status !== 'queued' || this.stopping || this.refusedAtLaunch(run, session)) { this.reservedSessions.delete(session.id); return; }
    }
    // A capability in a tool server's environment would be visible in the process list as an argument (see privateMcpConfig).
    const privateConfig = mcpServers && Object.values(mcpServers).some(server => server.env) ? await privateMcpConfig(mcpServers) : undefined;
    // Writing the file yielded; nothing may have stopped the run in the meantime.
    if (privateConfig || run.permissionRequestIds?.length) await this.prepareLaunch(run);
    if ((privateConfig || run.permissionRequestIds?.length) && (run.status !== 'queued' || this.stopping || this.refusedAtLaunch(run, session))) {
      privateConfig?.remove(); this.reservedSessions.delete(session.id); return;
    }
    if (mcpServers) args.push('--mcp-config', privateConfig?.path ?? JSON.stringify({ mcpServers }));
    let child: ChildProcessWithoutNullStreams;
    try {
      child = (this.options.spawnProcess ?? spawn)(executable, args, {
        cwd: session.cwd, env, detached: true, stdio: 'pipe', shell: false,
      });
    } catch (error) { privateConfig?.remove(); throw error; }
    if (privateConfig) child.once('close', privateConfig.remove);
    run.status = 'running';
    run.startedAt = new Date().toISOString();
    run.output = '';
    let finish!: () => void;
    const owned: OwnedProcess = { child, done: new Promise<void>((resolve) => { finish = resolve; }) };
    this.owned.set(run.id, owned);
    let buffer = '';
    let stderr = '';
    let streamError: string | undefined;
    let sawCompletion = false;
    let sawSessionId = false;
    let sawPartial = false;
    let messageHasPartial = false;
    // What Claude itself put in the output, apart from Tower's notes: its final result is shown only if nothing was.
    let shown = false;
    const show = (text: string) => { shown = true; this.append(run, text); };
    // The master's words, block by block, so they can be read aloud as they are written.
    const replies = this.masterSession(session) ? new ReplyLog(run) : undefined;
    let replyMessage = '';
    /** Messages whose words came as partial text: their complete form adds nothing. */
    const streamedMessages = new Set<string>();
    const replied = (changed: boolean) => { if (changed) this.notifyOutput(); };
    let modeNoted = false;
    let contextInput: { model: string; usedTokens: number } | undefined;
    let identitySaved: Promise<void> = Promise.resolve();
    const wakeups = new WakeupTracker(MAX_PROMPT);
    // A turn ends at its result, but background work it started keeps running in this process. Input stays open
    // until that work has ended and Claude has taken each notice in a follow-up turn of this same run.
    const tasks = new BackgroundTaskTracker();
    const followUpMs = this.options.backgroundFollowUpMs ?? BACKGROUND_FOLLOW_UP_MS;
    const waitMaxMs = this.options.backgroundWaitMaxMs ?? BACKGROUND_WAIT_MAX_MS;
    let turnActive = true;
    /** Tower handed Claude the notice itself and Claude has not yet replayed it. */
    let noticeId: string | undefined;
    let waitTimedOut = false;
    let followUpTimer: ReturnType<typeof setTimeout> | undefined;
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    let finishTimer: ReturnType<typeof setTimeout> | undefined;
    let inputClosedByTower = false;
    const clearFinishTimer = () => { if (finishTimer) clearTimeout(finishTimer); finishTimer = undefined; };
    const clearWaitTimers = () => {
      if (followUpTimer) clearTimeout(followUpTimer);
      if (waitTimer) clearTimeout(waitTimer);
      followUpTimer = waitTimer = undefined;
    };
    const endWait = () => { if (run.backgroundWait) { delete run.backgroundWait; this.changed(); } };
    const beginTurn = () => {
      if (turnActive) return;
      clearFinishTimer();
      turnActive = true; clearWaitTimers(); endWait(); tasks.observeTurnStart(); owned.claude?.setTurnIdle(false);
      // Each turn reports its own completion and its own reply.
      sawCompletion = false; shown = false; sawPartial = false; messageHasPartial = false;
    };
    owned.claude = new ClaudeControl({
      write: message => new Promise<void>((resolve, reject) => {
        if (run.status !== 'running' || child.exitCode !== null || child.stdin.destroyed || child.stdin.writableEnded) { reject(new Error('Provider input is closed.')); return; }
        child.stdin.write(JSON.stringify(message) + '\n', error => error ? reject(error) : resolve());
      }),
      onApproval: approval => { if (run.status === 'running') { run.approvals = [...(run.approvals || []), approval]; this.changed(); } },
      onCancelled: id => {
        if (!run.approvals?.some(approval => approval.id === id)) return;
        run.approvals = run.approvals.filter(approval => approval.id !== id);
        if (!run.approvals.length) delete run.approvals;
        this.changed();
      },
      onError: error => { streamError = error.message; this.stopOwned(run.id, owned); },
      // Instructions queued behind this turn can be inserted now; the page is told without waiting for output.
      onReady: () => this.changed(),
    });
    const closeInput = () => { inputClosedByTower = true; clearFinishTimer(); clearWaitTimers(); owned.claude?.close(); if (!child.stdin.writableEnded) child.stdin.end(); };
    const idle = () => !turnActive && run.status === 'running' && child.exitCode === null && !child.stdin.writableEnded;
    const arm = (timer: 'followUp' | 'wait', ms: number) => {
      const handle = setTimeout(timer === 'followUp' ? followUp : waitLimit, ms);
      handle.unref();
      if (timer === 'followUp') followUpTimer = handle; else waitTimer = handle;
    };
    // Claude normally takes a finished task's notice by itself. If it has not, Tower hands it over as a message.
    const followUp = () => {
      followUpTimer = undefined;
      if (!idle()) return;
      if (run.approvals?.length) { arm('followUp', followUpMs); return; }
      if (noticeId) { this.append(run, '\n[Tower] Claude has not answered the background work notice yet.\n'); return; }
      const unread = tasks.takeUnread();
      if (!unread.length) { owned.finishInput?.(); return; }
      noticeId = randomUUID();
      this.append(run, '\n[Tower] Background work finished; asking Claude to continue.\n');
      child.stdin.write(JSON.stringify({ type: 'user', uuid: noticeId, session_id: session.nativeId, parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text: backgroundNotice(unread) }] } }) + '\n');
      arm('followUp', followUpMs);
    };
    const waitLimit = () => {
      waitTimer = undefined;
      if (!idle()) return;
      if (run.approvals?.length) { arm('wait', followUpMs); return; }
      // Closing input is how every turn ended before; Claude ends what is left. Never reported as success.
      waitTimedOut = true;
      this.append(run, `\n[Tower] Background work was still running after ${Math.round(waitMaxMs / 60_000)} minutes; closing the turn.\n`);
      closeInput();
    };
    owned.finishInput = () => {
      if (!sawCompletion || turnActive || owned.claude?.hasPendingSteers() || child.stdin.writableEnded) return;
      // A failed turn is not kept open for its background work.
      if (streamError) { endWait(); closeInput(); return; }
      if (!tasks.outstanding && !noticeId) {
        // Task bookends can follow a result, even in the next stdout chunk. Recheck after they drain.
        if (!finishTimer) finishTimer = setTimeout(() => {
          finishTimer = undefined;
          if (!idle() || owned.claude?.hasPendingSteers()) return;
          if (tasks.outstanding || noticeId) { owned.finishInput?.(); return; }
          endWait(); closeInput();
        }, 250);
        return;
      }
      clearFinishTimer();
      if (tasks.unreadCount && !followUpTimer) arm('followUp', followUpMs);
      if (!run.backgroundWait) {
        run.backgroundWait = { since: new Date().toISOString(), tasks: tasks.runningCount };
        this.append(run, tasks.runningCount ? `\n[Tower] Waiting for ${tasks.runningCount} background task${tasks.runningCount === 1 ? '' : 's'} before this turn ends.\n`
          : '\n[Tower] Waiting for Claude to take the finished background work.\n');
        arm('wait', waitMaxMs);
      } else run.backgroundWait.tasks = tasks.runningCount;
      this.changed();
    };
    const parseEventLine = (line: string): void => {
      if (!line.trim()) return;
      let event: Record<string, any>;
      try { event = JSON.parse(line); } catch { show(line + '\n'); return; }
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Expected a provider event object.');
      if (owned.claude?.handle(event)) {
        if (event.type === 'user' && event.isReplay) { beginTurn(); sawCompletion = false; tasks.observeReplay(event); }
        return;
      }
      const actualId = event.type === 'system' && event.subtype === 'init' ? event.session_id : undefined;
      const created = creating ? this.createdSessions.get(session.id) : undefined;
      if (actualId && created && !created.confirmed && typeof actualId === 'string' && UUID.test(actualId)
        && actualId === session.nativeId) {
        created.confirmed = true;
        created.session.nativeId = actualId;
        created.session.creationPending = false;
        session.nativeId = actualId;
        this.changed();
        identitySaved = this.flush().catch(error => {
          streamError = `Cannot save the new conversation identity: ${errorMessage(error)}`;
          this.stopOwned(run.id, owned);
        });
      }
      if (actualId === session.nativeId) sawSessionId = true;
      // Claude reports the mode it actually runs in before doing anything, for example the one it falls back to
      // where automatic mode is not available. An unattended run continues only in automatic mode, or in a mode
      // that asks the owner; any other or missing mode is stopped. The owner's own turns go on and say so.
      const startMode = actualId ? claudeStartMode(run, event.permissionMode) : undefined;
      if (startMode && 'stop' in startMode) {
        streamError = startMode.stop;
        this.stopOwned(run.id, owned);
        return;
      }
      if (startMode) {
        if (!modeNoted) this.append(run, startMode.note);
        modeNoted = true;
      }
      if (actualId && actualId !== session.nativeId) {
        streamError = creating ? 'The provider did not confirm the new conversation ID. The task was stopped.' : 'The provider opened a different conversation instead of resuming the requested session. The task was stopped.';
        this.stopOwned(run.id, owned);
        return;
      }
      const mainContext = event.parent_tool_use_id == null && (event.session_id === undefined || event.session_id === session.nativeId);
      // Anything the main conversation says after a result is a follow-up turn, typically Claude taking a task's notice.
      if (mainContext && ['assistant', 'user', 'stream_event'].includes(event.type)) beginTurn();
      if (mainContext && event.type === 'user' && event.isReplay) {
        // Tower's own notice is taken once Claude replays it; the turn it starts must then reach its result.
        if (noticeId && event.uuid === noticeId) noticeId = undefined;
        else { tasks.observeReplay(event); wakeups.observeReplay(messageText(event)); }
      }
      if ((event.session_id === undefined || event.session_id === session.nativeId) && tasks.observe(event) && !turnActive) owned.finishInput?.();
      if (mainContext && event.type === 'system' && event.subtype === 'compact_boundary') contextInput = undefined;
      if (mainContext) wakeups.observe(event);
      if (mainContext && event.type === 'stream_event' && event.event?.type === 'message_start') tasks.observeReply(event.event.message?.id);
      if (mainContext && event.type === 'assistant' && !event.isMeta && !event.is_meta) {
        const model = event.message?.model;
        if (!String(model || '').includes('synthetic')) {
          tasks.observeReply(event.message?.id);
          contextInput = undefined;
          const usedTokens = claudeInputTokens(event.message?.usage);
          if (validModelId(model) && usedTokens !== undefined) contextInput = { model, usedTokens };
        }
      }
      if (replies && mainContext && event.type === 'stream_event') {
        const part = event.event;
        const block = `${replyMessage}:${Number(part?.index) || 0}`;
        if (part?.type === 'message_start') replyMessage = typeof part.message?.id === 'string' ? part.message.id : randomUUID();
        else if (part?.type === 'content_block_start' && part.content_block?.type === 'text') replied(replies.add(block, typeof part.content_block.text === 'string' ? part.content_block.text : ''));
        else if (part?.type === 'content_block_delta' && part.delta?.type === 'text_delta' && typeof part.delta.text === 'string') { streamedMessages.add(replyMessage); replied(replies.add(block, part.delta.text)); }
        else if (part?.type === 'content_block_stop') replied(replies.finish(block));
      }
      if (event.type === 'stream_event') {
        if (event.event?.type === 'message_start') messageHasPartial = false;
        const delta = event.event?.delta;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          show(delta.text); sawPartial = true; messageHasPartial = true;
        }
        if (event.event?.type === 'message_stop' && messageHasPartial) show('\n\n');
      } else if (event.type === 'assistant') {
        const messageId = typeof event.message?.id === 'string' ? event.message.id : randomUUID();
        for (const [index, block] of (event.message?.content ?? []).entries()) {
          if (block.type === 'text' && replies && mainContext && !streamedMessages.has(messageId)) replied(replies.add(`${messageId}:a${index}`, String(block.text), true));
          if (block.type === 'text' && !messageHasPartial) show(String(block.text) + '\n\n');
          if (block.type === 'tool_use') show(`[${block.name}]\n`);
        }
        messageHasPartial = false;
      } else if (event.type === 'result' && mainContext) {
        const capacity = contextInput && mainContext ? modelContextWindow(event.modelUsage, contextInput.model) : undefined;
        if (contextInput && contextCapacity(capacity) && sawSessionId && !streamError) {
          run.contextUsage = { ...contextInput, contextWindow: capacity, usedPercent: contextInput.usedTokens / capacity * 100,
            updatedAt: new Date().toISOString() };
          this.changed();
        }
        sawCompletion = true;
        turnActive = false;
        owned.claude?.setTurnIdle(true);
        if (event.is_error) streamError = (event.errors ?? [event.result ?? 'Claude Code could not complete this turn.']).join('\n');
        // A denied tool call (by the user or the auto mode classifier) is part of a turn that
        // still finished; Claude's own reply explains it. Only a failed turn is reported.
        if (event.is_error && event.permission_denials?.length) {
          const denied = [...new Set(event.permission_denials.map((denial: any) => denial.tool_name ?? 'tool'))].join(', ');
          streamError = `Permission was denied for: ${denied}. The instruction could not complete with the current permissions.`;
          show(`\n${streamError}\n`);
        }
        if (!sawPartial && !shown && event.result) show(String(event.result));
        owned.finishInput?.();
      }
    };
    const parseLine = (line: string): void => {
      try { parseEventLine(line); }
      catch {
        streamError = 'The provider emitted an invalid output event. The task was stopped.';
        this.stopOwned(run.id, owned);
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); parseLine(line); }
      if (buffer.length > 2_000_000) { streamError = 'Provider emitted an oversized output event.'; buffer = ''; this.stopOwned(run.id, owned); }
    });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8000); });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') streamError = errorMessage(error); });
    child.on('error', (error: Error) => { streamError = errorMessage(error); });
    child.on('close', async (code: number | null, signal: NodeJS.Signals | null) => {
      if (buffer) parseLine(buffer);
      clearFinishTimer(); clearWaitTimers();
      const pendingApproval = !!run.approvals?.length;
      const pendingSteer = owned.claude?.hasPendingSteers();
      delete run.backgroundWait;
      owned.claude?.close();
      // A newly bound UUID must be durable before this turn reports success.
      await identitySaved;
      if (owned.killTimer) clearTimeout(owned.killTimer);
      this.owned.delete(run.id);
      this.reservedSessions.delete(session.id);
      this.settledRuns.add(run.id);
      this.locallySettled.delete(session.id);
      this.locallySettled.set(session.id, Date.now());
      if (this.locallySettled.size > 1000) this.locallySettled.delete(this.locallySettled.keys().next().value!);
      if (run.status !== 'cancelled') {
        const recover = !streamError && !waitTimedOut && sawSessionId && (tasks.outstanding > 0 || !!noticeId)
          && !pendingApproval && !pendingSteer && !this.stopping && run.origin?.kind === 'owner';
        if (tasks.outstanding || noticeId) this.append(run, `\n[Tower] Provider exit: code=${code ?? 'none'}, signal=${signal ?? 'none'}, result=${sawCompletion}, inputClosedByTower=${inputClosedByTower}, runningTasks=${tasks.runningCount}, unreadTasks=${tasks.unreadCount}.\n`);
        if (!streamError && code === 0 && (!sawCompletion || !sawSessionId)) streamError = 'The provider exited without confirming completion in the requested conversation.';
        if (!streamError && waitTimedOut) streamError = 'The turn answered, but its background work did not finish within the time Tower waits; the work was ended with the turn.';
        else if (!streamError && (tasks.outstanding || noticeId)) streamError = 'Claude Code exited before it took the results of background work it started in this turn.';
        if (streamError || code !== 0) {
          const detail = `The provider exited ${signal ? `with signal ${signal}` : `with code ${code ?? 'unknown'}`}.`;
          this.fail(run, [streamError, detail, stderr.trim()].filter(Boolean).join('\n'));
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
          const wakeup = wakeups.pending;
          if (wakeup && !this.stopping) this.scheduleContinuation(run, wakeup);
          this.changed();
        }
      } else this.changed();
      finish();
      if (!this.stopping) void this.options.refreshSessions().catch(() => {}).finally(() => this.pump());
    });
    owned.claude.start(input);
    this.changed();
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
    const run: Run = { id: randomUUID(), sessionId: after.sessionId, origin: after.origin ?? { kind: 'unknown' }, prompt: wakeup.prompt, status: 'queued',
      ...(after.delegation ? { delegation: { ...after.delegation } } : {}),
      ...(after.instructions?.required ? { instructions: { ...after.instructions } } : {}),
      createdAt: new Date().toISOString(), output: scheduledOutput, scheduled: { at: new Date(wakeup.at).toISOString(), afterRunId: after.id, ...(backgroundRecoveryAttempt ? { backgroundRecoveryAttempt } : {}) },
      ...(after.unattended ? { unattended: true } : {}), ...(after.model ? { model: after.model } : {}), ...(after.effort ? { effort: after.effort } : {}) };
    if (backgroundRecoveryAttempt) {
      run.output = 'Tower will resume unfinished background work after an unexpected provider exit.';
      this.append(after, `\n[Tower] Scheduled background recovery ${backgroundRecoveryAttempt}/3.\n`);
    }
    this.runs.set(run.id, run);
    this.prune();
    this.changed();
  }

  /**
   * The owner asked Tower to switch to its new version now. From here no new turn starts, each running turn is asked to
   * wrap up, and at `deadline` the turns still running are stopped. When a turn the update interrupted ends, Tower
   * queues its own continuation in that same step (see settleUpdateTarget). Delegated work of a Slack or GitHub workflow
   * is neither asked nor resumed: its coordinator hears how it ended and decides.
   */
  beginUpdateDrain(deadline: number, delegated: (run: Run) => boolean): void {
    if (this.updating || this.stopping) return;
    // Turns from an earlier forced update that gave up are still followed until they end.
    this.drain = { sequence: (this.drain?.sequence ?? 0) + 1, startedAt: Date.now(), deadline, delegated, active: true, targets: this.drain?.targets ?? new Map(), stoppingBridges: new Set(), wrapUps: this.drain?.wrapUps ?? new Set() };
    this.changed();
  }

  /** While a forced update holds new turns back. */
  private get updating(): boolean { return this.drain?.active === true; }

  /**
   * Gives up a forced update that could not hand off: queued turns start again here and nothing is cancelled. Turns it
   * already stopped or asked to wrap up still get their continuation when they end.
   */
  endUpdateDrain(): void {
    if (!this.drain?.active) return;
    this.drain.active = false;
    this.changed();
    void this.pump();
  }

  /** Shown while a forced update waits for running turns to wrap up. */
  updateDrainStatus(): { startedAt: string; deadline: string; running: number } | undefined {
    const drain = this.drain;
    if (!drain?.active) return undefined;
    const running = [...drain.targets.keys()].filter(id => this.runs.get(id)?.status === 'running').length
      + [...this.bridged.keys()].filter(id => this.runs.get(id)?.status === 'queued').length;
    return { startedAt: new Date(drain.startedAt).toISOString(), deadline: new Date(drain.deadline).toISOString(), running };
  }

  /** Called about once a second while a forced update waits: wrap-up requests, Codex app submissions, the deadline. */
  driveUpdateDrain(now = Date.now()): void {
    const drain = this.drain;
    if (!drain?.active || this.stopping) return;
    for (const [id, bridge] of this.bridged) {
      const run = this.runs.get(id);
      if (run?.status !== 'queued') continue;
      if (now < drain.deadline) void bridge.withdraw?.().catch(() => {});
      else if (!drain.stoppingBridges.has(id)) { drain.stoppingBridges.add(id); void this.cancel(id, UPDATE_NOT_STARTED).catch(() => {}); }
    }
    for (const [id, target] of drain.targets) {
      const run = this.runs.get(id);
      if (run?.status !== 'running') continue;
      if (now >= drain.deadline) {
        if (target.stopSent !== drain.sequence) { target.stopSent = drain.sequence; target.stopping = true; void this.cancel(id, target.delegated ? DELEGATED_STOPPED : UPDATE_STOPPED).catch(() => {}); }
      } else if (!target.delegated && !target.stopping && !target.reached && !target.sending && now >= target.retryAt) this.sendWrapUp(run, target);
    }
  }

  /** Inserts the wrap-up request into a running turn. A request that surely did not reach it is removed and tried again. */
  private sendWrapUp(target: Run, state: UpdateTarget): void {
    const wrapUp: Run = { id: randomUUID(), sessionId: target.sessionId, origin: target.origin ?? { kind: 'unknown' }, prompt: WRAP_UP_NOTICE, status: 'queued',
      createdAt: new Date().toISOString(), updateWrapUp: true,
      output: 'Asking the running turn to wrap up for a Tower update.', ...(target.model ? { model: target.model } : {}), ...(target.effort ? { effort: target.effort } : {}) };
    this.runs.set(wrapUp.id, wrapUp);
    this.drain!.wrapUps.add(wrapUp.id);
    state.sending = true;
    state.retryAt = Date.now() + WRAP_UP_RETRY_MS;
    this.changed();
    void this.steer(wrapUp.id, { targetRunId: target.id }).catch(() => {}).finally(() => {
      state.sending = false;
      // Put back in the queue means it was never handed over; it must not start later as a turn of its own.
      if (wrapUp.status !== 'queued' || wrapUp.steering || this.runs.get(wrapUp.id) !== wrapUp) return;
      this.runs.delete(wrapUp.id);
      state.reached = false;
      // The turn ended meanwhile, counted as asked to wrap up: it was not, so it is not carried on.
      const turn = this.runs.get(target.id);
      if (turn?.status === 'completed') {
        for (const run of [...this.runs.values()]) if (run.status === 'queued' && run.scheduled?.resume === 'update' && run.scheduled.afterRunId === turn.id) this.runs.delete(run.id);
      }
      this.changed();
    });
  }

  /** Called as an inserted instruction is handed to its turn: a wrap-up request that got this far may have reached it. */
  private noteHandedOver(run: Run): void {
    if (!this.drain?.wrapUps.has(run.id) || !run.steering) return;
    const target = this.drain.targets.get(run.steering.targetRunId);
    if (target) target.reached = true;
  }

  /**
   * Registers every turn running during a forced update in the same step as the change that shows it running, and
   * settles each one in the same step as the change that shows it ended.
   */
  private trackUpdateTargets(): void {
    const drain = this.drain;
    if (!drain) return;
    if (drain.active) for (const run of this.runs.values()) {
      if (run.status !== 'running' || run.steering || drain.targets.has(run.id)) continue;
      drain.targets.set(run.id, { delegated: drain.delegated(run), retryAt: 0 });
    }
    for (const [id, target] of drain.targets) {
      const run = this.runs.get(id);
      if (!run) { drain.targets.delete(id); continue; }
      if (!FINISHED.has(run.status)) continue;
      drain.targets.delete(id);
      this.settleUpdateTarget(run, target);
    }
    if (!drain.active && !drain.targets.size) this.drain = undefined;
  }

  /**
   * Only work the update itself interrupted is carried on: a turn the deadline stopped, or one that ended after its
   * wrap-up request reached it. A turn the owner stopped, one stopped in the Codex app, one that failed, and one that
   * finished its own work before any wrap-up reached it end as they are. The continuation is queued in the same step
   * that shows the turn ended, so no watcher sees one without the other; it replaces the agent's own wakeup.
   */
  private settleUpdateTarget(run: Run, target: UpdateTarget): void {
    if (target.delegated || this.ownerStopped.has(run.id)) return;
    // A stop the deadline asked for counts only once confirmed ('cancelled'): an unconfirmed one may still be running there.
    if (!((target.stopping && run.status === 'cancelled') || (run.status === 'completed' && target.reached))) return;
    if (this.permissions.mergeIntoUpdate(run, RESUME_NOTICE, UPDATE_RESUME_WAIT)) return;
    for (const other of [...this.runs.values()]) {
      if (other.status === 'queued' && other.scheduled?.afterRunId === run.id && other.scheduled.resume !== 'update') this.runs.delete(other.id);
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    this.runs.set(id, { id, sessionId: run.sessionId, origin: run.origin ?? { kind: 'unknown' }, prompt: RESUME_NOTICE, status: 'queued',
      ...(run.delegation ? { delegation: { ...run.delegation } } : {}),
      ...(run.instructions?.required ? { instructions: { ...run.instructions } } : {}),
      createdAt: now, output: UPDATE_RESUME_WAIT, scheduled: { at: now, afterRunId: run.id, resume: 'update' },
      ...(run.unattended ? { unattended: true } : {}), ...(run.model ? { model: run.model } : {}), ...(run.effort ? { effort: run.effort } : {}) });
  }

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
    this.trackUpdateTargets();
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
    // Instruction text never reaches disk, where an older Tower could show it. A turn still to run records only that it
    // needs instructions; after a restart it is cancelled rather than started without them.
    for (const id of this.carried) if (this.runs.get(id)?.status !== 'queued') this.carried.delete(id);
    // A wrap-up request is never carried: after a restart it would start as a turn of its own.
    if (this.updating) for (const run of this.runs.values()) if (run.status === 'queued' && !run.scheduled && !this.drain!.wrapUps.has(run.id)) this.carried.add(run.id);
    const serialize = (finishedOutput?: number) => JSON.stringify(this.list().map(({ approvals: _liveApprovals, canSteer: _liveSteering, steerBlocked: _liveBlock, ...run }) => {
      const saved: Record<string, unknown> = { ...run };
      if (finishedOutput !== undefined && FINISHED.has(run.status)) saved.output = run.output.slice(-finishedOutput);
      if (this.runs.get(run.id)?.instructions?.required && !FINISHED.has(run.status)) saved[NEEDS_INSTRUCTIONS] = true;
      if (this.carried.has(run.id)) saved[KEEP_QUEUED] = true;
      if (retained.has(run.id) && FINISHED.has(run.status)) { saved[RETAIN] = true; saved.output = run.output.slice(-RETAINED_OUTPUT); }
      return saved;
    }));
    // Older builds refuse a history over 12 MB, so a rollback could not start: long finished output is shortened first.
    let data = serialize();
    if (Buffer.byteLength(data) > LEGACY_SAVED_BYTES) data = serialize(2_000);
    // Kept only for turns still to run, in a private file older Towers do not read (see instructionsFile).
    const instructions = JSON.stringify(Object.fromEntries([...this.runs.values()]
      .filter(run => run.instructions?.required && !FINISHED.has(run.status)).map(run => [run.id, run.instructions])));
    const created = JSON.stringify([...this.createdSessions.values()]);
    this.writes = this.writes.then(async () => {
      // Compare inside the queue: an earlier queued write may still change what a file holds.
      // Write identities first. A crash between commits may leave an orphaned
      // placeholder, which recovery displays as failed and never submits again.
      if (created !== this.saved.created) { await writePrivateJson(this.createdFile, created); this.saved.created = created; }
      // Instructions before the runs that name them, so a saved marker always finds its text.
      // A failure here costs only those turns' restart (they are cancelled then, as before); runs.json is still saved.
      if (instructions === (this.saved.instructions ?? '{}')) this.instructionsError = undefined;
      else {
        try { await writePrivateJson(this.instructionsFile, instructions); this.saved.instructions = instructions; this.instructionsError = undefined; }
        catch (error) { this.instructionsError = error as Error; console.error(`Turn instructions were not saved: ${errorMessage(error)}`); }
      }
      if (data !== this.saved.runs) { await writePrivateJson(this.stateFile, data); this.saved.runs = data; }
      this.persistenceError = undefined;
    }).catch((error: Error) => { this.persistenceError = error; });
  }

  /** Waits for every accepted change to reach disk, without stopping or cancelling anything. */
  async flushState(): Promise<void> {
    this.persist(); await this.flush();
    if (this.instructionsError) throw new RunError(`Cannot save instructions of turns still to run: ${this.instructionsError.message}`, 503);
  }

  /**
   * Holds new launches of `provider` while its CLI is updated, but only when none of its runs is starting or running;
   * undefined when one is. Synchronous, so nothing launches between the look and the hold. Releasing it starts what
   * waited.
   */
  holdProvider(provider: Provider): (() => void) | undefined {
    const of = (sessionId: string) => (this.getSession(sessionId) ?? this.createdSessions.get(sessionId)?.session)?.provider ?? sessionId.split(':')[0];
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

  private async flush(): Promise<void> {
    await this.writes;
    if (this.persistenceError) throw notAdmitted(new RunError(`Cannot save the instruction queue: ${this.persistenceError.message}`, 503));
  }
}

const scheduledOutput = 'Scheduled by the agent. Tower resumes this conversation at the scheduled time.';
function automated(run: Run): boolean { return automatedOrigin(run.origin); }
