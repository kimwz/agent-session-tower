import { SlackTonePanel } from './SlackTonePanel';
import { slackCardState } from './slack-read-state';
import { useEffect, useState } from 'react';
import type { SlackPublicStatus, SlackWorkflow } from '../../../shared/slack';
import type { AutoPromptJob } from '../../../shared/types';
import { SessionTail } from '../chat/SessionTail';
import { SLACK_PAGE_SIZE, visibleSlackMentions } from '../graph/slack-graph';
import { useI18n, translateMessage } from '../i18n/i18n';
import { SlackReplyProposals } from './SlackReplyProposals';
import { slackMentionTitle, slackWorkflowLabel, slackWorkflowWorking } from './slack-monitor';

/** Slack's part of the trigger monitor: the connection, reply tone and received mentions. */
export function SlackOverview({ slack, token, unreadIds, onSelectMention }: { slack: SlackPublicStatus | null; token: string; unreadIds?: ReadonlySet<string>; onSelectMention: (id: string) => void }) {
  const { t } = useI18n();
  const [mentionLimit, setMentionLimit] = useState(SLACK_PAGE_SIZE);
  return <>
    {slack?.connected && <SlackTonePanel key={`${slack.account?.teamId}:${slack.account?.userId}`} slack={slack} token={token} />}
    {slack?.account && <p>{slack.account.teamName} · {slack.account.userName}</p>}
    <p>{slack?.connected ? slack.enabled ? t('멘션 감시 중') : t('멘션 감시 꺼짐') : t('Slack 연결 없음')}</p>
    {slack?.error && <p role="alert">{translateMessage(slack.error)}</p>}
    {!slack?.events.length && <p>{t('아직 받은 멘션이 없습니다.')}</p>}
    {visibleSlackMentions(slack?.events || [], mentionLimit).map(event => <button key={event.id} className={`slack-monitor-entry ${slackCardState(event, !!unreadIds?.has(event.id))}`} onClick={() => onSelectMention(event.id)}><strong>{slackMentionTitle(event)}</strong><span>{slackWorkflowLabel(event.status)}</span><time>{new Date(event.createdAt).toLocaleString()}</time></button>)}
    {slack && slack.events.length > mentionLimit && <button className="slack-monitor-back" onClick={() => setMentionLimit(limit => limit + SLACK_PAGE_SIZE)}>{t('멘션 더 보기')} ({slack.events.length - mentionLimit})</button>}
  </>;
}

/** One Slack mention: what came in, what the agent decided, and the conversation that did the work. */
export function SlackMentionDetail({ workflow, job, token, onRead, onNavigate }: { workflow: SlackWorkflow; job?: AutoPromptJob; token: string; onRead?: () => void; onNavigate: (id: string) => void }) {
  const { t } = useI18n();
  useEffect(() => { onRead?.(); }, [workflow, onRead]);
  const sessionId = workflow.sessionId || job?.sessionId;
  return <>
    <SlackWorkflowSummary token={token} workflow={workflow} job={job} />
    {sessionId ? <SessionTail sessionId={sessionId} selection={workflow.id} onNavigate={onNavigate} /> : <p>{t('아직 실행 세션이 생성되지 않았습니다.')}</p>}
  </>;
}

export function SlackWorkflowSummary({ workflow, job, token = '' }: { workflow: SlackWorkflow; job?: AutoPromptJob; token?: string }) {
  const { t } = useI18n();
  const routeLabels: Record<AutoPromptJob['status'], string> = { queued: t('대기 중'), routing: t('라우팅 중'), dispatching: t('작업 준비 중'), completed: t('라우팅 완료'), error: t('오류'), cancelled: t('취소됨') };
  return <>
    <div className={`slack-monitor-state ${slackWorkflowWorking(workflow.status) ? 'working' : ''}`} role="status">{slackWorkflowLabel(workflow.status)}</div>
    <section><h3>{t('받은 멘션')}</h3><p className="slack-monitor-muted">{workflow.mention.user} · {workflow.mention.channel} · {new Date(workflow.createdAt).toLocaleString()}</p><p className="slack-monitor-text">{workflow.mention.text}</p>{workflow.thread && <details><summary>{t('원본 스레드')} ({workflow.thread.length})</summary>{workflow.thread.map(message => <div key={message.ts} className="slack-monitor-thread-message"><small>{message.user}</small><p className="slack-monitor-text">{message.text}</p></div>)}</details>}</section>
    <section><h3>{t('에이전트 판단')}</h3>{workflow.rule && <><strong>{workflow.rule.name}</strong><p className="slack-monitor-text">{workflow.rule.instructions}</p></> }<p className="slack-monitor-text">{workflow.reason || t('아직 판단 결과가 없습니다.')}</p>{workflow.prompt && <details><summary>{t('전달한 작업 지침')}</summary><p className="slack-monitor-text">{workflow.prompt}</p></details>}</section>
    {job && <section><h3>Auto Prompt</h3><p>{t('라우팅 상태')}: {routeLabels[job.status]}</p>{job.decision && <><p>{job.decision.action === 'resume' ? t('기존 세션 이어서 실행') : t('새 세션 생성')} · {job.decision.cwd}</p><p className="slack-monitor-text">{job.decision.reason}</p></>}{job.error && <p role="alert">{translateMessage(job.error)}</p>}</section>}
    {workflow.error && <p role="alert">{translateMessage(workflow.error)}</p>}
    <SlackReplyProposals token={token} key={workflow.id} workflow={workflow} />
    {!workflow.replies?.length && workflow.reply && <section><h3>{workflow.replyTs ? t('Slack에 보낸 답글') : t('작성된 답글')}</h3><p className="slack-monitor-text">{workflow.reply}</p></section>}
    {workflow.status === 'reply-uncertain' && <p role="alert">{t('답글 전송 여부를 확인할 수 없습니다. 원본 Slack 스레드를 확인하세요.')}</p>}
  </>;
}
