import type { AutoUpdateStatus, RemoteNode } from './link.js';
import type { RepositoryStatus } from './repositories.js';
import type { TriggerOverview } from './triggers.js';
export type Provider = 'claude' | 'codex';
/** Who reviews Codex approval requests. Absent keeps Codex's own configured reviewer. */
export type CodexApprovalsReviewer = 'user' | 'auto_review';
export type SessionStatus = 'working' | 'idle' | 'completed' | 'error';
/** How a conversation's last turn left things for the owner. `progress`: the agent said it carries on by itself. */
export type SessionOutcome = 'done' | 'needsOwner' | 'blocked' | 'progress';
export interface Session {
  id: string;
  /** Set only in a controller's page, for an item of a joined computer: that computer's id. Servers never send it. */
  node?: string;
  nativeId: string;
  provider: Provider;
  title: string;
  customTitle?: string;
  closed?: boolean;
  creationPending?: boolean;
  /** Stable starting project directory, not the agent shell's latest directory. */
  cwd: string;
  project: string;
  parentId?: string;
  /** Correlated shell-launched child; native parent metadata remains authoritative. */
  parentLink?: 'exec';
  /**
   * A non-interactive run (`codex exec`, `codex review`) that another agent or script started.
   * It is that agent's work, not a user conversation: it never appears as its own canvas session.
   */
  launchedByAgent?: boolean;
  /**
   * The master agent's own conversation (or one of its subagents): run in the master's folder and used only through the
   * master's chat and voice, so it is never listed as a session, counted, or shown on the canvas.
   */
  master?: boolean;
  /** Created by a trigger. Like agent-launched work, it leaves the canvas once its work is done. */
  launchedBy?: { kind: 'trigger'; triggerId: string };
  agentName?: string;
  model?: string;
  contextUsage?: SessionContextUsage;
  status: SessionStatus;
  statusReason: string;
  createdAt: string;
  updatedAt: string;
  lastRequestAt?: string;
  lastCompletedAt?: string;
  lastMessage: string;
  messageCount: number;
  /** Snapshot change marker calculated before provider output is omitted. */
  readRevision?: string;
  isSubagent: boolean;
  resumable: boolean;
  activeProcess?: boolean;
  filePath?: string;
  /** When a continuation the agent scheduled for itself resumes this conversation. */
  scheduledAt?: string;
  /** A fast judgment of how its last turn ended; only while it is not working and that turn is still its last. */
  outcome?: SessionOutcome;
}
export interface SessionContextUsage {
  usedTokens: number;
  contextWindow?: number;
  usedPercent?: number;
  updatedAt?: string;
  capacitySource?: 'model-default';
}
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  timestamp: string;
  images?: { source: string; name: string; url: string }[];
  toolName?: string;
  /** For a tool call and its result: the id they share (Codex gives them different ids of their own). */
  callId?: string;
  isError?: boolean;
}
export interface SessionDetail {
  session: Session;
  messages: ChatMessage[];
  hasMore: boolean;
  nextBefore?: number;
  /** Your last message before this page, which the page's first messages answer; only when there is earlier history. */
  previousUser?: ChatMessage;
  /** Records on this page that could not be read (too large or malformed) and are left out. */
  skipped?: number;
  /** Worktrees this conversation made that Tower removed, or kept and why, after its work was over. */
  worktrees?: WorktreeCleanup[];
}
/** Why Tower kept a worktree a finished conversation made. */
export type WorktreeKeptReason = 'openSession' | 'reserved' | 'process' | 'processesUnknown' | 'locked' | 'nested' | 'ignoredWork' | 'changes' | 'unpushed' | 'unpublished' | 'failed';
export interface WorktreeCleanup {
  path: string;
  state: 'removed' | 'kept';
  reason?: WorktreeKeptReason;
  /** The open session using it, the branch with unpushed commits, the number of changes, or git's message. */
  detail?: string;
  /** Where the files git ignored in it (notes, review records, local settings) were moved before it was removed. */
  archive?: string;
  at: string;
}
export interface ProviderHealth {
  provider: Provider;
  available: boolean;
  executable?: string;
  sessionCount: number;
  error?: string;
  usage?: ProviderUsage;
  models?: ModelOption[];
  defaultModel?: string;
  /** Effort levels for models outside the catalog, such as a session's observed full model ID. */
  efforts?: EffortOption[];
  /** The native configuration's effort, used whenever a request does not choose one. */
  defaultEffort?: string;
}
export interface UsageWindow {
  id: string;
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: string;
}
export interface ProviderUsage {
  status: 'loading' | 'available' | 'unavailable' | 'error';
  windows: UsageWindow[];
  updatedAt?: string;
  reason?: string;
  stale?: boolean;
}
export interface ModelOption {
  id: string;
  label: string;
  description?: string;
  /** Reasoning effort levels the model accepts. An empty list means the model has no effort control. */
  efforts?: EffortOption[];
  defaultEffort?: string;
}
export interface EffortOption {
  id: string;
  description?: string;
}
/**
 * Who started a run. Tower decides tools, owner-chat approval and steering from this record,
 * never from request fields. Records written before origins existed have none.
 */
export interface RunOrigin {
  kind: 'owner' | 'agent' | 'trigger' | 'slack' | 'unknown';
  workflowId?: string;
  triggerId?: string;
  eventId?: string;
  /** For an agent origin: the owner run whose tool call started this work. */
  runId?: string;
  /**
   * Set when the work came from a paired controller over a remote link, or from an agent that such work
   * started. Remote work never selects a folder this machine excludes from remote sharing.
   */
  controllerId?: string;
}
export interface Run {
  id: string;
  sessionId: string;
  /** Set only in a controller's page, for an item of a joined computer: that computer's id. Servers never send it. */
  node?: string;
  origin?: RunOrigin;
  /**
   * Trigger work set to approve automatically. Tower's own turns always run in the provider's automatic approval
   * mode; this marks the automated work that does too.
   */
  unattended?: boolean;
  /** For a turn the owner started: whether Tower's tools reached it, and if not, why. */
  towerTools?: 'attached' | 'desktop-app' | 'external-input' | 'not-owner-session' | 'remote';
  prompt: string;
  /**
   * What Tower tells the agent for this turn beside the request: policy, receipts, hints. The provider receives it as
   * system or developer instructions, so the conversation shows only the request. The worker keeps it; pages never
   * receive it. A turn whose instructions are `required` never goes ahead without them.
   */
  instructions?: RunInstructions;
  status: 'queued' | 'running' | 'completed' | 'error' | 'cancelled';
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  output: string;
  error?: string;
  attachments?: Attachment[];
  model?: string;
  effort?: string;
  /** The reviewer a trigger or Slack thread started with. Tower's own turns always use the automatic one. */
  codexApprovalsReviewer?: CodexApprovalsReviewer;
  autoPromptId?: string;
  contextUsage?: SessionContextUsage & { model: string; updatedAt: string };
  approvals?: RunApproval[];
  canSteer?: boolean;
  steering?: { targetRunId: string; state: 'sending' | 'delivered' | 'uncertain'; requestedAt: string; deliveredAt?: string };
  /**
   * A continuation the agent scheduled for itself (Claude's ScheduleWakeup) in the turn `afterRunId`. The native
   * wakeup lives only inside the provider process, which ends with Tower's turn, so Tower keeps the run queued
   * until `at` and then resumes the conversation with the agent's own prompt. Background recovery uses the same
   * queue; its persisted attempt count limits retries after unexpected provider exits.
   */
  /** Tower's own request that a running turn wrap up for a forced worker update; not work of its own. */
  updateWrapUp?: true;
  scheduled?: { at: string; afterRunId: string; backgroundRecoveryAttempt?: number;
    /** Tower's own continuation for a turn a forced worker update ended; watchers of `afterRunId` follow it. */
    resume?: 'update' };
  /**
   * The turn has answered but background work it started (a background command, Monitor or agent) is still running
   * inside the provider process. Tower keeps the turn open so the agent can pick up the results; `since` is when the
   * wait began and `tasks` how many are still running (0 while Claude is about to take a finished one).
   */
  backgroundWait?: { since: string; tasks: number };
  /**
   * The master's turns only: what it writes, text block by text block as it streams, so its words can be read aloud
   * while they are written. Unlike `output`, it holds no tool notes and is never cut at its start.
   */
  replies?: RunReply[];
  /** Replies were dropped or cut to stay small: they no longer hold every word of the turn. */
  repliesTrimmed?: true;
}
/**
 * One text block the agent wrote, in order. `id` is the message's id and the block's place in it (`message:block`), so
 * blocks of one message share the part before the colon. Its text only grows; `done` once the block is complete, `cut`
 * when it grew too long to keep more.
 */
export interface RunReply { id: string; text: string; done?: true; cut?: true }
export interface RunInstructions { text: string; required?: boolean }
export interface RunApproval {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  description?: string;
  scope?: 'turn';
  origin?: { threadId: string; turnId?: string; agentName?: string };
  interaction?:
    | { type: 'questions'; requireAnswers?: boolean; questions: Array<{ id: string; header: string; question: string; isOther: boolean; isSecret: boolean; multiSelect?: boolean; options: Array<{ label: string; description: string }> | null }> }
    | { type: 'mcp-form'; schema: Record<string, unknown>; serverName: string }
    | { type: 'mcp-url'; url: string; serverName: string };
}
export type RunApprovalResponse = 'allow' | 'deny'
  | { answers: Record<string, { answers: string[] }> }
  | { action: 'accept' | 'decline' | 'cancel'; content: Record<string, unknown> | null };
export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}
export interface AttachmentInput {
  name: string;
  mimeType: string;
  data: string;
}
export interface MessageAttachments {
  attachments?: AttachmentInput[];
  attachmentIds?: string[];
  model?: string;
  effort?: string;
}
export interface CreateSessionRequest {
  provider: Provider;
  cwd: string;
  prompt: string;
  title?: string;
  model?: string;
  effort?: string;
  /** Kept for triggers and Slack. Tower's own turns always use Codex's automatic reviewer, whatever a page sends. */
  codexApprovalsReviewer?: CodexApprovalsReviewer;
  attachments?: AttachmentInput[];
}
export interface AutoPromptRequest {
  sessionMode?: 'new';
  /** Continue this conversation in `cwd` without asking the router (the owner accepted a suggestion). */
  targetSessionId?: string;
  routingContext?: string;
  model?: string;
  effort?: string;
  requestId: string;
  provider: Provider;
  cwd?: string;
  prompt: string;
  /** Kept for triggers and Slack. Tower's own turns always use Codex's automatic reviewer, whatever a page sends. */
  codexApprovalsReviewer?: CodexApprovalsReviewer;
  attachments?: AttachmentInput[];
}
export interface AutoPromptDecision {
  action: 'resume' | 'create';
  cwd: string;
  sessionId?: string;
  reason: string;
}
export interface AutoPromptJob {
  /** Set only in a controller's page, for an item of a joined computer: that computer's id. Servers never send it. */
  node?: string;
  origin?: RunOrigin;
  /** For remote work: the remote-sharing exclusion revision its candidates were filtered with. */
  exclusionRevision?: number;
  unattended?: boolean;
  /** The request carries external content, so it may only start a new session. */
  untrustedInput?: boolean;
  sessionMode?: 'new';
  targetSessionId?: string;
  routingContext?: string;
  model?: string;
  effort?: string;
  id: string;
  provider: Provider;
  cwd?: string;
  prompt: string;
  /** The reviewer a trigger or Slack thread started with. Tower's own turns always use the automatic one. */
  codexApprovalsReviewer?: CodexApprovalsReviewer;
  /** The router's model from the `autoPrompt.router` role when the job was accepted; empty for the CLI default. */
  routerModel: string;
  /** Set when the router runs on another provider than the work. */
  routerProvider?: Provider;
  routerEffort?: string;
  status: 'queued' | 'routing' | 'dispatching' | 'completed' | 'error' | 'cancelled';
  stage?: 'directory' | 'session';
  createdAt: string;
  updatedAt: string;
  attachments?: Array<Pick<Attachment, 'name' | 'mimeType' | 'size'>>;
  decision?: AutoPromptDecision;
  sessionId?: string;
  runId?: string;
  error?: string;
}
export interface ProjectGroup {
  cwd: string;
  title: string;
  pinned: boolean;
  hidden?: boolean;
}
export interface ProjectGroupPatch {
  cwd: string;
  title?: string;
  pinned?: boolean;
  hidden?: boolean;
}
/** How busy the computer running a Tower is, measured every few seconds. Numbers only. */
export interface SystemStatus {
  /** Busy share of all cores since the previous sample, 0–100; absent on the first sample. */
  cpu?: number;
  cores: number;
  /** 1, 5 and 15-minute load averages (zero on Windows). */
  load: [number, number, number];
  /** Bytes. */
  memory: { total: number; used: number };
  /** Bytes on the volume that holds Tower's state directory. */
  disk?: { total: number; free: number };
  sampledAt: string;
}
/** The versions of Tower's own processes besides the web server and the worker. */
export interface ComponentVersions { terminalHost?: string | null; master?: string | null }

export interface Snapshot {
  sessions: Session[];
  /** Branch sync state of recently used project folders that are git repositories. */
  repositories?: RepositoryStatus[];
  providers: ProviderHealth[];
  runs: Run[];
  scanning: boolean;
  updatedAt: string;
  hostname: string;
  version: string;
  /** Version of the execution worker that runs requests; 'legacy' for workers too old to report it. */
  runnerVersion?: string;
  /** Tower's other processes on this computer, as last asked: null when one is not running. */
  componentVersions?: ComponentVersions;
  groups?: ProjectGroup[];
  autoPrompts?: AutoPromptJob[];
  /** Absent while the execution worker predates triggers. */
  triggers?: TriggerOverview;
  /** While the worker runs another build: whether it will hand over by itself. */
  runnerUpdate?: 'automatic' | 'manual';
  /** The owner asked to update now: running turns are wrapping up until `deadline`, then the worker switches. */
  updateDrain?: { startedAt: string; deadline: string; running: number };
  /** The attached worker can switch on request ("update now"). */
  runnerForceUpdate?: boolean;
  /** Names of the other Towers controlling this computer right now. */
  controlledBy?: string[];
  /** The latest computer that started controlling this one, for a notice here. */
  controllerJoined?: { name: string; at: string };
  /** Computers joined to this Tower; each one's own snapshot arrives on the same event stream. */
  nodes?: RemoteNode[];
  /** How this Tower keeps itself, Claude Code and Codex current. */
  autoUpdate?: AutoUpdateStatus;
  /** CPU, memory and disk of the computer running this Tower. */
  system?: SystemStatus;
}
