import type { Provider } from './types.js';

export interface SlackRule {
  id: string;
  name: string;
  enabled: boolean;
  condition: string;
  instructions: string;
  replyInstructions: string;
  provider: Provider;
  model?: string;
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
  mode?: 'conversation';
  conversationClaimed?: boolean;
  delegatedTasks?: Array<{ requestKey: string; requestId: string; prompt: string; provider: Provider; model?: string; cwd?: string; submitted?: boolean; submissionError?: string; delegatedRunId?: string; createdSessionId?: string; delegatedFinished?: boolean; notificationClaimed?: boolean; notifiedRunId?: string; notificationError?: string }>;
  replies?: Array<{ requestKey: string; text: string; status: 'proposed' | 'sending' | 'sent' | 'uncertain'; approvedAt?: string; ts?: string }>;
  ownerConditionalReply?: { requestId: string; requestKey: string; text: string; status: 'pending' | 'sent' | 'blocked' | 'cancelled' | 'uncertain'; authorizedAt: string; evidence?: string };
  ownerReplySelection?: { requestKey: string; text: string };
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
  tone?: SlackToneGuide;
  language?: 'ko' | 'en';
  allowSelfMentions?: boolean;
  connected: boolean;
  enabled: boolean;
  status: string;
  account?: { teamId: string; userId: string; teamName?: string; userName?: string };
  error?: string;
  rules: SlackRule[];
  events: SlackWorkflow[];
}

export interface SlackToneGuide { guide: string; enabled: boolean; status: 'idle' | 'collecting' | 'ready' | 'error'; sampleCount?: number; updatedAt?: string; error?: string }
