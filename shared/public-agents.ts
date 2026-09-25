import { z } from 'zod';

/**
 * Public agents: a page the owner publishes where outside visitors talk with a scoped intake agent. The intake agent
 * has no tools and knows only the owner's scope; a request it hands over is reviewed, run in one fixed folder, and
 * only a reviewed public summary of the result goes back to the visitor.
 */

const text = (max: number) => z.string().trim().min(1).max(max);
const absolutePath = z.string().min(1).max(4096).refine(value => value.startsWith('/') && !value.includes('\0'), 'An absolute folder path is required.');

export const PUBLIC_AGENT_PASSWORD_MIN = 8;
export const PublicAgentInputSchema = z.object({
  name: text(120),
  /** Shown to visitors at the top of the page. */
  description: z.string().trim().max(2000).default(''),
  /** What visitors may ask for. The intake agent and both reviewers read it as the owner's trusted rule. */
  scope: text(8000),
  /** Extra guidance for the project agent that does the work; visitors never see it. */
  workInstructions: z.string().trim().max(8000).default(''),
  /** The one folder its work runs in. */
  cwd: absolutePath,
  /** The project agent that does the work. */
  provider: z.enum(['claude', 'codex']),
  model: text(200).optional(),
  effort: text(40).optional(),
  /** The model family that talks with visitors and reviews requests and results. It never has tools. */
  intakeProvider: z.enum(['claude', 'codex']).default('claude'),
  /** `shared`: every visitor sees one conversation. `visitor`: each browser gets its own. */
  conversation: z.enum(['shared', 'visitor']).default('visitor'),
  enabled: z.boolean().default(true),
}).strict();
export type PublicAgentInput = z.infer<typeof PublicAgentInputSchema>;

/** What the owner sees; the password itself is never stored or returned. */
export interface PublicAgent extends PublicAgentInput {
  id: string;
  /** The unguessable part of the public address. */
  slug: string;
  passwordSet: boolean;
  createdAt: string;
  updatedAt: string;
}

export type PublicMessageRole = 'visitor' | 'agent' | 'notice';
export interface PublicMessage {
  id: string;
  role: PublicMessageRole;
  text: string;
  at: string;
  /** Shared conversations: a short tag telling visitors apart, never their identity. */
  visitor?: string;
}

/**
 * `reviewing`: the request reviewer is checking it. `queued`: approved, waiting for a free slot. `running`: the project
 * agent works on it. `summarizing`: the result is being reviewed before visitors see it.
 */
export type PublicRequestStatus = 'reviewing' | 'rejected' | 'queued' | 'dispatching' | 'running' | 'summarizing' | 'completed' | 'failed';
export interface PublicRequestView {
  id: string;
  request: string;
  status: PublicRequestStatus;
  createdAt: string;
  updatedAt: string;
  /** Why the reviewer refused it, written for the visitor. */
  reason?: string;
  /** The reviewed result the visitor sees. */
  result?: string;
}
/** The owner also sees where the work ran. */
export interface PublicRequest extends PublicRequestView {
  agentId: string;
  conversationId: string;
  runId?: string;
  sessionId?: string;
  error?: string;
}

export interface PublicConversationView {
  id: string;
  messages: PublicMessage[];
  requests: PublicRequestView[];
  /** The agent is writing its answer. */
  busy: boolean;
  /** How full the intake agent's context is; it is compacted at 50%. */
  contextPercent: number;
  compactedAt?: string;
}
export interface PublicConversationSummary {
  id: string;
  mode: 'shared' | 'visitor';
  messageCount: number;
  lastMessage?: string;
  updatedAt: string;
  busy: boolean;
  contextPercent: number;
  error?: string;
}

/** What a visitor's page shows. */
export interface PublicVisitorState {
  agent: { name: string; description: string; conversation: 'shared' | 'visitor'; passwordRequired: boolean };
  /** `password`: the visitor must sign in first; nothing else is shown. */
  access: 'open' | 'password';
  conversation?: PublicConversationView;
  /** Only a visitor's own conversation can be started over by them. */
  canReset: boolean;
}

export interface PublicAgentOverview {
  agents: Array<PublicAgent & { conversations: PublicConversationSummary[]; requests: PublicRequest[] }>;
  listener: PublicListenerStatus;
  storageError?: string;
}

/** Where the public pages are served. The port listens on this computer only; a tunnel publishes it. */
export const PublicListenerSettingsSchema = z.object({
  /** 0 turns the public pages off. */
  port: z.number().int().min(0).max(65535),
  /** The address visitors use, for example https://agents.example.com. Links are shown with it. */
  publicUrl: z.string().trim().max(400).refine(value => value === '' || (() => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && url.origin === value.replace(/\/$/, ''); } catch { return false; } })(),
    'Use an origin such as https://agents.example.com, without a path.').transform(value => value.replace(/\/$/, '')),
}).strict();
export type PublicListenerSettings = z.infer<typeof PublicListenerSettingsSchema>;
export interface PublicListenerStatus extends PublicListenerSettings { listening: boolean; error?: string }

export const PUBLIC_MESSAGE_MAX = 4000;
export const PUBLIC_SLUG = /^[A-Za-z0-9_-]{22}$/;
