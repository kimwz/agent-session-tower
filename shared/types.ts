export type Provider = 'claude' | 'codex';
/** Who reviews Codex approval requests. Absent keeps Codex's own configured reviewer. */
export type CodexApprovalsReviewer = 'user' | 'auto_review';
export type SessionStatus = 'working' | 'idle' | 'completed' | 'error';
export interface Session {
  id: string;
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
  toolName?: string;
  isError?: boolean;
}
export interface SessionDetail {
  session: Session;
  messages: ChatMessage[];
  hasMore: boolean;
  nextBefore?: number;
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
export interface Run {
  id: string;
  sessionId: string;
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
  codexApprovalsReviewer?: CodexApprovalsReviewer;
  autoPromptId?: string;
  contextUsage?: SessionContextUsage & { model: string; updatedAt: string };
  approvals?: RunApproval[];
  canSteer?: boolean;
  steering?: { targetRunId: string; state: 'sending' | 'delivered' | 'uncertain'; requestedAt: string; deliveredAt?: string };
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
  sessionMode?: 'new';
  routingContext?: string;
  model?: string;
  effort?: string;
  id: string;
  provider: Provider;
  cwd?: string;
  prompt: string;
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
  providers: ProviderHealth[];
  runs: Run[];
  scanning: boolean;
  updatedAt: string;
  hostname: string;
  version: string;
  groups?: ProjectGroup[];
  autoPrompts?: AutoPromptJob[];
}
