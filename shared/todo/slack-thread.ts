import { z } from 'zod';
import type { TodoSlackThread } from './types.js';

/**
 * The Slack thread a todo came from (TodoTask.slackThread): the ids alone, checked here, so a stored thread can only
 * ever become a slack.com link.
 */
export const SlackThreadSchema = z.object({
  teamId: z.string().regex(/^[TE][A-Z0-9]{2,30}$/, 'A Slack team id (T…) is required.'),
  channel: z.string().regex(/^[CDG][A-Z0-9]{2,30}$/, 'A Slack channel id (C…, D… or G…) is required.'),
  threadTs: z.string().regex(/^\d{1,12}\.\d{1,9}$/, "The thread's first message ts (1234567890.123456) is required."),
}).strict();

/**
 * Slack's permalink of the thread's first message, which opens the thread. It names no workspace: slack.com keeps the
 * permalink through signing in, and its `/archives/` paths open in the Slack app on phones.
 */
export const slackThreadUrl = (thread: TodoSlackThread) => `https://slack.com/archives/${thread.channel}/p${thread.threadTs.replace('.', '')}`;

/** A stored or sent thread, or undefined when it is not one. */
export function slackThreadOf(value: unknown): TodoSlackThread | undefined {
  const parsed = SlackThreadSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
