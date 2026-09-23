import { slackCardState } from '../slack/slack-read-state';
import { memo } from 'react';
import type { Node, NodeProps } from '@xyflow/react';
import { Slack, ArrowUpRight } from 'lucide-react';
import type { SlackWorkflow } from '../../../shared/slack';
import { translate as t, useI18n } from '../i18n/i18n';
import { relativeTime } from '../common/lib';
import { slackWorkflowWorking, slackWorkflowLabel, slackMentionTitle } from '../slack/slack-monitor';
export type SlackMentionData = { event: SlackWorkflow; unread?: boolean; selected: boolean; onSelect?: (id: string | null) => void };
export const SlackMentionNode = memo(function SlackMentionNode({ data }: NodeProps<Node<SlackMentionData>>) {
  useI18n(); const event = data.event; const working = slackWorkflowWorking(event); const state = slackCardState(event, !!data.unread); const stateLabel = state === 'unread' ? t('읽지 않음') : state === 'replied' ? t('Slack에 전송됨') : slackWorkflowLabel(event);
  return <button className={`agent-card slack-mention-card ${state} ${data.selected ? 'selected' : ''}`} onClick={() => data.onSelect?.(event.id)} title={event.error || undefined} aria-label={`${slackMentionTitle(event)}: ${stateLabel}`}>
    {working && <span className="agent-activity-border" aria-hidden="true" />}
    <div className="slack-mention-top"><Slack size={12} /><span>{stateLabel}</span><time dateTime={event.createdAt}>{relativeTime(event.createdAt)}</time><ArrowUpRight size={11} /></div>
    <div className="agent-card-title" title={slackMentionTitle(event)}>{slackMentionTitle(event)}</div>
  </button>;
});
