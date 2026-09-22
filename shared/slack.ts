import type { Provider } from './types.js';

export interface SlackRule {
  id: string;
  name: string;
  enabled: boolean;
  condition: string;
  instructions: string;
  replyInstructions: string;
  provider: Provider;
  cwd?: string;
}
export interface SlackMessage { user: string; text: string; ts: string }
export interface SlackMention {
  id: string;
  teamId: string;
  channel: string;
  user: string;
  ts: string;
  threadTs: string;
  text: string;
}
export type SlackWorkflowState = 'received' | 'matching' | 'ignored' | 'dispatching' | 'running' | 'composing' | 'sending' | 'completed' | 'error' | 'reply-uncertain';
export interface SlackWorkflow {
  id: string;
  mention: SlackMention;
  status: SlackWorkflowState;
  createdAt: string;
  updatedAt: string;
  rules: SlackRule[];
  rule?: SlackRule;
  thread?: SlackMessage[];
  prompt?: string;
  autoPromptId?: string;
  runId?: string;
  sessionId?: string;
  reason?: string;
  reply?: string;
  replyTs?: string;
  error?: string;
}
export interface SlackPublicStatus {
  connected: boolean;
  enabled: boolean;
  status: string;
  account?: { teamId: string; userId: string; teamName?: string; userName?: string };
  error?: string;
  rules: SlackRule[];
  events: SlackWorkflow[];
}
