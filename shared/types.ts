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
}
export interface CreateSessionRequest {
  provider: Provider;
  cwd: string;
  prompt: string;
  title?: string;
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
}
