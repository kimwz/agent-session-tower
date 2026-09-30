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
  /** Owner pre-authorization: delegating with this rule permits one truthful result reply. Slack replies and reactions need no authorization; this binds the report to the task. */
  autoReply?: boolean;
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
  /** GitHub: a pull request that asked for a review; replies are posted as reviews, with the verdicts allowed then. */
  review?: { verdicts: 'comment' | 'any' };
}
/**
 * A later message in the thread of a conversation that already began. A message that mentions the owner is followed
 * as it is; any other is followed when a fast judgment finds it asks something of the owner.
 */
export interface SlackFollowUp {
  ts: string;
  user: string;
  text: string;
  mentioned?: boolean;
  /** received: waiting for a judgment; pending: waiting to reach the conversation; delivering: claimed before handing it over. */
  status: 'received' | 'pending' | 'delivering' | 'delivered' | 'skipped' | 'error';
  receivedAt: string;
  /** How likely the judgment found it is for the owner, 0–1. */
  addressed?: number;
  /** Why it was skipped or failed. */
  reason?: string;
  runId?: string;
  deliveredAt?: string;
}
export type SlackWorkflowState = 'received' | 'matching' | 'ignored' | 'dispatching' | 'running' | 'composing' | 'sending' | 'completed' | 'error' | 'reply-uncertain';
export interface SlackWorkflow {
  id: string;
  mode?: 'conversation';
  /** How work this conversation delegates is approved, fixed when it began (GitHub coordinators). */
  approvals?: 'auto' | 'owner';
  conversationClaimed?: boolean;
  delegatedTasks?: Array<{ requestKey: string; requestId: string; prompt: string; provider: Provider; model?: string; cwd?: string; submitted?: boolean; submissionError?: string; delegatedRunId?: string; createdSessionId?: string; delegatedFinished?: boolean; notificationClaimed?: boolean; notifiedRunId?: string; notificationError?: string }>;
  /** `sendKey` names the slack_send call an owner permission's reply went out for. */
  replies?: Array<{ requestKey: string; text: string; status: 'proposed' | 'sending' | 'sent' | 'uncertain'; approvedAt?: string; ts?: string; sendKey?: string }>;
  ownerConditionalReply?: { mode?: 'composed'; ruleId?: string; requestIds?: string[]; instruction?: string; requestId: string; requestKey: string; text: string; status: 'pending' | 'sent' | 'blocked' | 'cancelled' | 'uncertain'; authorizedAt: string; evidence?: string };
  ownerReplySelection?: { requestKey: string; text: string };
  /** The owner told Tower not to send: no reply goes out, nor does a rule's automatic report, until the owner allows it again. */
  repliesHeld?: true;
  /** `ts` names a later thread message the reaction went on; the request message otherwise. */
  reactions?: Array<{ name: string; action: 'add' | 'remove'; at: string; ts?: string }>;
  /**
   * Tower's own working reaction on the request and on later messages it took up (Slack conversations only).
   * add: to put on, or whether it went on is uncertain; on: put on, or putting it on failed; off: taken off, or the
   * attempt failed (error).
   */
  workingMarks?: Array<{ ts: string; name: string; state: 'add' | 'on' | 'off'; error?: string }>;
  /** Later thread messages, oldest first (Slack conversations only). */
  followUps?: SlackFollowUp[];
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
  /** The emoji Tower puts on a message while working on it; unset turns it off. */
  workingReaction?: string;
  connected: boolean;
  enabled: boolean;
  status: string;
  account?: { teamId: string; userId: string; teamName?: string; userName?: string };
  error?: string;
  rules: SlackRule[];
  events: SlackWorkflow[];
}

export interface SlackToneGuide { guide: string; enabled: boolean; status: 'idle' | 'collecting' | 'ready' | 'error'; sampleCount?: number; updatedAt?: string; error?: string }
