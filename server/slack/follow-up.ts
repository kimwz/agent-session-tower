/**
 * Whether a later message in a Slack thread Tower already handled asks something of the owner, though it does not
 * mention them: a question to them, a request to follow up, or a moment they should step in. Such a message continues
 * the conversation that handled the thread; the coordinator there still decides what, if anything, to do.
 */
import type { DecisionEngine } from '../decisions/engine.js';
import type { SlackMessage } from '../../shared/slack.js';

/**
 * A message continues the conversation when it is at least this likely to be for the owner. A message followed by
 * mistake costs one coordinator turn that finds nothing to do; one missed is left for the owner to notice in Slack.
 */
export const FOLLOW_UP_ADDRESSED = 0.5;
const RECENT_MESSAGES = 12;

export interface SlackFollowUpInput {
  /** The owner's Slack user ID. */
  owner: string;
  /** The message that first mentioned the owner. */
  request: SlackMessage;
  /** The thread as far as it is known, oldest first. */
  thread: SlackMessage[];
  message: SlackMessage;
}

const clip = (value: string, length: number) => value.length > length ? `${value.slice(0, length - 1)}…` : value;
const line = (owner: string, message: SlackMessage, length: number) => `<@${message.user}>${message.user === owner ? ' (owner)' : ''}: ${clip(message.text.trim(), length)}`;

export async function judgeSlackFollowUp(engine: DecisionEngine, input: SlackFollowUpInput, signal?: AbortSignal, beforeSend?: () => Promise<void>): Promise<{ addressed: number }> {
  const earlier = input.thread.filter(message => message.ts !== input.message.ts && Number(message.ts) < Number(input.message.ts)).slice(-RECENT_MESSAGES);
  const { audience } = await engine.decide({ signal, beforeSend, state: {
    about: `A Slack thread in which someone mentioned the owner (<@${input.owner}>) with a request that the owner's assistant handled. A new message was just posted in the same thread without mentioning the owner.`,
    owner: `<@${input.owner}>`,
    first_request: line(input.owner, input.request, 2000),
    recent_thread: earlier.map(message => line(input.owner, message, 600)),
    new_message: line(input.owner, input.message, 2000),
  }, questions: {
    audience: { type: 'choice', instructions: 'Who is new_message for, given the thread so far?', options: {
      owner: 'The owner: it asks the owner a question (such as whether it can be merged now or whether they checked it), asks the owner to do, check, review again or answer something, tells the owner their earlier request or comment was handled so they can follow up, or otherwise needs the owner to step in now.',
      others: 'Not the owner: it is addressed to someone else or is a conversation between other people, only thanks or acknowledges without asking anything (such as "thanks" or "got it"), or shares information that needs nothing from the owner.',
    } },
  } });
  return { addressed: audience.probabilities.owner ?? 0 };
}
