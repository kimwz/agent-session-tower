import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { ArrowUpRight, CalendarClock, CircleDot, Globe, GripHorizontal, Play, Radio, Zap } from 'lucide-react';
import type { TriggerEvent } from '../../../shared/triggers';
import { translate as t, useI18n } from '../i18n/i18n';
import { relativeTime } from '../common/lib';
import { eventStatusLabel } from '../triggers/trigger-helpers';
import { triggerEventWorking } from '../triggers/trigger-monitor';

export type TriggerMonitorData = {
  /** Present while Slack is connected; its connection state shows in the lane. */
  slack?: { name: string; enabled: boolean; status: string; error?: string };
  enabledTriggers: number;
  count: number;
  active: number;
  remaining: number;
  /** Older runs can still be loaded from trigger history. */
  more: boolean;
  onMore: () => void;
  onSelect?: () => void;
};
export type TriggerEventData = { event: TriggerEvent; unread?: boolean; selected: boolean; onSelect?: (id: string) => void };

export const TriggerMonitorNode = memo(function TriggerMonitorNode({ data }: NodeProps<Node<TriggerMonitorData>>) {
  useI18n();
  const slack = data.slack;
  const slackLabel = !slack ? '' : !slack.enabled ? t('멘션 감시 꺼짐') : slack.error || slack.status === 'error' ? t('Slack 연결 오류') : slack.status === 'connected' ? t('멘션을 기다리는 중') : t('Slack 연결 중');
  const unhealthy = !!slack?.enabled && (Boolean(slack.error) || slack.status !== 'connected');
  const waiting = slack ? slackLabel : t('다음 실행을 기다리는 중');
  const subtitle = [slack ? `Slack · ${slack.name}` : '', t('트리거 {0}개 켜짐', { 0: data.enabledTriggers })].filter(Boolean).join(' · ');
  return <div className={`slack-monitor-lane trigger-monitor-lane ${data.active ? 'working' : ''}`}>
    {data.active > 0 && <span className="agent-activity-border" aria-hidden="true" />}
    <Handle type="target" position={Position.Top} />
    <button className="slack-monitor-drag-handle" onClick={() => data.onSelect?.()} aria-label={t('트리거 모니터 열기')}>
      <Zap size={25} /><div><strong>{t('트리거 모니터')}</strong><span>{subtitle}</span></div><GripHorizontal size={17} />
    </button>
    <div className={`slack-monitor-status ${unhealthy ? 'connection-warning' : ''}`} title={slack?.error}>
      <span className="slack-monitor-connection">{data.active > 0 && <><Radio size={12} />{t('{0}개 작업 중', { 0: data.active })}{(unhealthy || (slack && !slack.enabled)) && ' · '}</>}{(!data.active || unhealthy || (slack && !slack.enabled)) && waiting}</span>
      <span>{t('최근 {0}개', { 0: data.count })}</span>
    </div>
    {!data.count && <button className="slack-monitor-empty nodrag nopan" onClick={() => data.onSelect?.()}>{t('트리거가 실행되거나 새 멘션이 오면 여기에 표시됩니다.')}</button>}
    {(data.remaining > 0 || data.more) && <button className="slack-monitor-more nodrag nopan" onClick={data.onMore}>{t('더 표시')}{data.remaining > 0 ? ` (${data.remaining})` : ''}</button>}
  </div>;
});

export const TriggerEventNode = memo(function TriggerEventNode({ data }: NodeProps<Node<TriggerEventData>>) {
  useI18n();
  const event = data.event;
  const working = triggerEventWorking(event);
  const failed = event.status === 'error' || event.status === 'uncertain' || event.status === 'cancelled';
  const state = working ? 'working' : data.unread ? 'unread' : failed ? 'failed' : event.status === 'completed' ? 'replied' : '';
  const label = state === 'unread' ? t('읽지 않음') : eventStatusLabel(event.status, t);
  const Icon = event.kind === 'http' ? Globe : event.kind === 'github' ? CircleDot : event.kind === 'manual' ? Play : CalendarClock;
  return <button className={`agent-card slack-mention-card trigger-event-card ${state} ${data.selected ? 'selected' : ''}`} onClick={() => data.onSelect?.(event.id)}
    title={event.error || event.reason || event.summary} aria-label={`${event.triggerName}: ${label}`}>
    {working && <span className="agent-activity-border" aria-hidden="true" />}
    <div className="slack-mention-top"><Icon size={12} /><span>{label}</span><time dateTime={event.receivedAt}>{relativeTime(event.receivedAt)}</time><ArrowUpRight size={11} /></div>
    <div className="agent-card-title" title={event.summary}>{event.kind === 'github' ? event.summary : event.triggerName}</div>
  </button>;
});
