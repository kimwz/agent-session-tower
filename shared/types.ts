export type Provider = 'claude' | 'codex';
export type SessionStatus = 'working' | 'idle' | 'completed' | 'error';
export interface Session {
  id: string;
  nativeId: string;
  provider: Provider;
  title: string;
  customTitle?: string;
  closed?: boolean;
  creationPending?: boolean;
  cwd: string;
  project: string;
  parentId?: string;
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
  autoPromptId?: string;
  contextUsage?: SessionContextUsage & { model: string; updatedAt: string };
  approvals?: RunApproval[];
}
export interface RunApproval {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  description?: string;
  scope?: 'turn';
}
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
}
export interface CreateSessionRequest {
  provider: Provider;
  cwd: string;
  prompt: string;
  title?: string;
  model?: string;
  attachments?: AttachmentInput[];
}
export interface AutoPromptRequest {
  requestId: string;
  provider: Provider;
  cwd?: string;
  prompt: string;
  attachments?: AttachmentInput[];
}
export interface AutoPromptDecision {
  action: 'resume' | 'create';
  cwd: string;
  sessionId?: string;
  reason: string;
}
export interface AutoPromptJob {
  id: string;
  provider: Provider;
  cwd?: string;
  prompt: string;
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
}
export interface ProjectGroupPatch {
  cwd: string;
  title?: string;
  pinned?: boolean;
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
