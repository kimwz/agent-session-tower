import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Slack, GripHorizontal, ArrowUpRight, Radio } from 'lucide-react';
import type { SlackWorkflow } from '../../../shared/slack';
import { translate as t, useI18n } from '../i18n/i18n';
import { relativeTime } from '../common/lib';
import { slackWorkflowWorking, slackWorkflowLabel, slackMentionTitle } from '../slack/slack-monitor';
export type SlackMonitorData = { name: string; enabled: boolean; status: string; error?: string; count: number; active: number; onSelect?: (id: string | null) => void; remaining: number; onMore: () => void };
export type SlackMentionData = { event: SlackWorkflow; selected: boolean; onSelect?: (id: string | null) => void };
export const SlackMonitorNode = memo(function SlackMonitorNode({ data }: NodeProps<Node<SlackMonitorData>>) {
  useI18n();
  const connectionLabel = !data.enabled ? t('멘션 감시 꺼짐') : data.error || data.status === 'error' ? t('Slack 연결 오류') : data.status === 'connected' ? t('멘션을 기다리는 중') : t('Slack 연결 중');
  const unhealthy = data.enabled && (Boolean(data.error) || data.status !== 'connected');
  return <div className={`slack-monitor-lane ${data.active ? 'working' : ''}`}>
    {data.active > 0 && <span className="agent-activity-border" aria-hidden="true" />}
    <Handle type="target" position={Position.Top} />
    <button className="slack-monitor-drag-handle" onClick={() => data.onSelect?.(null)} aria-label={t('Slack 모니터 열기')}>
      <Slack size={25} /><div><strong>{t('Slack 모니터')}</strong><span>{data.name}</span></div><GripHorizontal size={17} />
    </button>
    <div className={`slack-monitor-status ${unhealthy ? 'connection-warning' : ''}`} title={data.error}><span className="slack-monitor-connection">{data.active > 0 && <><Radio size={12} />{t('{0}개 작업 중', { 0: data.active })}{(unhealthy || !data.enabled) && ' · '}</>}{(!data.active || unhealthy || !data.enabled) && connectionLabel}</span><span>{t('{0}개 멘션', { 0: data.count })}</span></div>
    {!data.count && <button className="slack-monitor-empty nodrag nopan" onClick={() => data.onSelect?.(null)}>{t('새 멘션이 오면 여기에 표시됩니다.')}</button>}
    {data.remaining > 0 && <button className="slack-monitor-more nodrag nopan" onClick={data.onMore}>{t('더 표시')} ({data.remaining})</button>}
  </div>;
});
export const SlackMentionNode = memo(function SlackMentionNode({ data }: NodeProps<Node<SlackMentionData>>) {
  useI18n(); const event = data.event; const working = slackWorkflowWorking(event);
  return <button className={`agent-card slack-mention-card ${working ? 'working' : ''} ${data.selected ? 'selected' : ''}`} onClick={() => data.onSelect?.(event.id)} title={event.error || undefined} aria-label={`${slackMentionTitle(event)}: ${slackWorkflowLabel(event)}`}>
    {working && <span className="agent-activity-border" aria-hidden="true" />}
    <div className="slack-mention-top"><Slack size={12} /><span>{slackWorkflowLabel(event)}</span><time dateTime={event.createdAt}>{relativeTime(event.createdAt)}</time><ArrowUpRight size={11} /></div>
    <div className="agent-card-title" title={slackMentionTitle(event)}>{slackMentionTitle(event)}</div>
  </button>;
});
