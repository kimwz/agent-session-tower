import type { AutoUpdateStatus, RemoteNode } from './link.js';
import type { RepositoryStatus } from './repositories.js';
import type { TriggerOverview } from './triggers.js';
export type Provider = 'claude' | 'codex';
/** Who reviews Codex approval requests. Absent keeps Codex's own configured reviewer. */
export type CodexApprovalsReviewer = 'user' | 'auto_review';
export type SessionStatus = 'working' | 'idle' | 'completed' | 'error';
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
  isError?: boolean;
}
export interface SessionDetail {
  session: Session;
  messages: ChatMessage[];
  hasMore: boolean;
  nextBefore?: number;
  /** Your last message before this page, which the page's first messages answer; only when there is earlier history. */
  previousUser?: ChatMessage;
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
   * until `at` and then resumes the conversation with the agent's own prompt.
   */
  scheduled?: { at: string; afterRunId: string };
}
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
  routingContext?: string;
  model?: string;
  effort?: string;
  id: string;
  provider: Provider;
  cwd?: string;
  prompt: string;
  /** The reviewer a trigger or Slack thread started with. Tower's own turns always use the automatic one. */
  codexApprovalsReviewer?: CodexApprovalsReviewer;
  routerModel: string;
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
  groups?: ProjectGroup[];
  autoPrompts?: AutoPromptJob[];
  /** Absent while the execution worker predates triggers. */
  triggers?: TriggerOverview;
  /** While the worker runs another build: whether it will hand over by itself. */
  runnerUpdate?: 'automatic' | 'manual';
  /** Names of the other Towers controlling this computer right now. */
  controlledBy?: string[];
  /** The latest computer that started controlling this one, for a notice here. */
  controllerJoined?: { name: string; at: string };
  /** Computers joined to this Tower; each one's own snapshot arrives on the same event stream. */
  nodes?: RemoteNode[];
  /** How this Tower keeps itself, Claude Code and Codex current. */
  autoUpdate?: AutoUpdateStatus;
}
