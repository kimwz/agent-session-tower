import type { SlackWorkflow } from '../../../shared/slack';
import { slackWorkflowWorking } from './slack-monitor';

export const SLACK_READ_KEY = 'tower.slack-read.v1';
export type SlackReadState = Record<string, string>;
// Run identity changes on each completed coordinator turn; incidental setting/selection saves do not.
export function slackCompletionRevision(event: SlackWorkflow): string {
  const content = JSON.stringify([event.runId || event.createdAt, event.reason || '', event.replies?.length ? '' : event.reply || '', (event.replies || []).map(reply => [reply.requestKey, reply.text])]);
  let hash = 2166136261;
  for (let i = 0; i < content.length; i++) hash = Math.imul(hash ^ content.charCodeAt(i), 16777619);
  return event.status === 'completed' ? `${event.runId || event.createdAt}:${hash >>> 0}` : '';
}
export function slackCardState(event: SlackWorkflow, unread: boolean): 'working' | 'unread' | 'replied' | '' {
  if (slackWorkflowWorking(event)) return 'working';
  if (unread) return 'unread';
  if (event.replyTs || event.replies?.some(reply => reply.status === 'sent')) return 'replied';
  return '';
}
export function readSlackState(value: string | null): SlackReadState {
  try {
    const parsed: unknown = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed).filter(([, revision]) => typeof revision === 'string')) : {};
  } catch { return {}; }
}
