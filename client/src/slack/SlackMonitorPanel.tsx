import { useEffect, useState, type CSSProperties } from 'react';
import { ArrowLeft, ExternalLink, MessageSquare, X } from 'lucide-react';
import type { SlackPublicStatus, SlackWorkflow } from '../../../shared/slack';
import type { AutoPromptJob, SessionDetail } from '../../../shared/types';
import { api } from '../common/lib';
import { SLACK_PAGE_SIZE, visibleSlackMentions } from '../graph/slack-graph';
import { useI18n, translateMessage } from '../i18n/i18n';
import { useChatAppearance } from '../chat/chat-appearance';
import { ChatTranscript } from '../chat/ChatTranscript';
import { slackMentionTitle, slackWorkflowLabel, slackWorkflowWorking } from './slack-monitor';

export function SlackMonitorPanel({ slack, error, mentionId, jobs, onClose, onSelectMention, onNavigate }: {
  slack: SlackPublicStatus | null; error: string; mentionId: string | null; jobs: AutoPromptJob[];
  onClose: () => void; onSelectMention: (id: string | null) => void; onNavigate: (id: string) => void;
}) {
  const { t } = useI18n();
  const appearance = useChatAppearance();
  const workflow = slack?.events.find(event => event.id === mentionId);
  const job = jobs.find(item => item.id === workflow?.autoPromptId);
  const sessionId = workflow?.sessionId || job?.sessionId;
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [sessionError, setSessionError] = useState('');
  const [mentionLimit, setMentionLimit] = useState(SLACK_PAGE_SIZE);
  useEffect(() => {
    setDetail(null); setSessionError('');
    if (!sessionId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function poll() {
      try {
        const next = await api<SessionDetail>(`/api/sessions/${encodeURIComponent(sessionId!)}?limit=100`, { signal: controller.signal });
        if (!disposed) { setDetail(next); setSessionError(''); }
      } catch (cause) { if (!disposed) setSessionError(cause instanceof Error ? cause.message : String(cause)); }
      if (!disposed) timer = setTimeout(() => void poll(), 3000);
    }
    void poll();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, [sessionId, mentionId]);
  // A changed selection must never show the previous session while its effect resets.
  const currentDetail = detail?.session.id === sessionId ? detail : null;
  return <><div className="chat-panel-spacer" aria-hidden="true" style={{ width: appearance.width, flexBasis: appearance.width }} /><aside className="chat-panel slack-monitor-panel" aria-label={t('Slack 모니터')} style={{ '--chat-font-size': `${appearance.fontSize}px`, '--chat-width': `${appearance.width}px` } as CSSProperties}>
    <div className="chat-resize-handle" role="separator" tabIndex={0} aria-label={t('대화창 너비 조절')} aria-orientation="vertical" aria-valuemin={320} aria-valuemax={appearance.maxWidth} aria-valuenow={appearance.width} onPointerDown={appearance.startResize} onPointerMove={appearance.resize} onPointerUp={appearance.stopResize} onPointerCancel={appearance.stopResize} onLostPointerCapture={appearance.stopResize} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); appearance.changeWidth(appearance.width + (event.key === 'ArrowLeft' ? 20 : -20)); } }} />
    <header className="chat-header"><div className="chat-heading-line"><MessageSquare size={20} /><h2>{t('Slack 모니터')}</h2><div className="chat-header-actions"><button className="icon-button" onClick={onClose} aria-label={t('닫기')}><X size={18} /></button></div></div></header>
    <div className="slack-monitor-content">
      {error && <p role="alert">{translateMessage(error)}</p>}
      {mentionId !== null && <button className="slack-monitor-back" onClick={() => onSelectMention(null)}><ArrowLeft size={14} />{t('전체 멘션')}</button>}
      {mentionId === null ? <><p>{slack?.account?.teamName} · {slack?.account?.userName}</p><p>{slack?.connected ? slack.enabled ? t('멘션 감시 중') : t('멘션 감시 꺼짐') : t('Slack 연결 없음')}</p>{slack?.error && <p role="alert">{translateMessage(slack.error)}</p>}{!slack?.events.length && <p>{t('아직 받은 멘션이 없습니다.')}</p>}{visibleSlackMentions(slack?.events || [], mentionLimit).map(event => <button key={event.id} className="slack-monitor-entry" onClick={() => onSelectMention(event.id)}><strong>{slackMentionTitle(event)}</strong><span>{slackWorkflowLabel(event.status)}</span><time>{new Date(event.createdAt).toLocaleString()}</time></button>)}{slack && slack.events.length > mentionLimit && <button className="slack-monitor-back" onClick={() => setMentionLimit(limit => limit + SLACK_PAGE_SIZE)}>{t('멘션 더 보기')} ({slack.events.length - mentionLimit})</button>}</> : workflow ? <>
        <SlackWorkflowSummary workflow={workflow} job={job} />
        {sessionId && <section><h3>{t('에이전트 응답')}</h3><button className="slack-monitor-back" onClick={() => onNavigate(sessionId)}><ExternalLink size={14} />{t('실행 세션 열기')}</button>{sessionError && <p role="alert">{translateMessage(sessionError)}</p>}{currentDetail ? <><p className="slack-monitor-muted">{t('실행 세션의 최근 대화입니다. 전체 기록은 실행 세션에서 확인하세요.')}</p><ChatTranscript messages={currentDetail.messages} /></> : !sessionError && <p>{t('대화를 여는 중')}</p>}</section>}
        {!sessionId && <p>{t('아직 실행 세션이 생성되지 않았습니다.')}</p>}
      </> : <p>{t('이 멘션 기록을 찾을 수 없습니다.')}</p>}
    </div>
  </aside></>;
}

export function SlackWorkflowSummary({ workflow, job }: { workflow: SlackWorkflow; job?: AutoPromptJob }) {
  const { t } = useI18n();
  const routeLabels: Record<AutoPromptJob['status'], string> = { queued: t('대기 중'), routing: t('라우팅 중'), dispatching: t('작업 준비 중'), completed: t('라우팅 완료'), error: t('오류'), cancelled: t('취소됨') };
  return <>
    <div className={`slack-monitor-state ${slackWorkflowWorking(workflow.status) ? 'working' : ''}`} role="status">{slackWorkflowLabel(workflow.status)}</div>
    <section><h3>{t('받은 멘션')}</h3><p className="slack-monitor-muted">{workflow.mention.user} · {workflow.mention.channel} · {new Date(workflow.createdAt).toLocaleString()}</p><p className="slack-monitor-text">{workflow.mention.text}</p>{workflow.thread && <details><summary>{t('원본 스레드')} ({workflow.thread.length})</summary>{workflow.thread.map(message => <div key={message.ts} className="slack-monitor-thread-message"><small>{message.user}</small><p className="slack-monitor-text">{message.text}</p></div>)}</details>}</section>
    <section><h3>{t('에이전트 판단')}</h3>{workflow.rule && <><strong>{workflow.rule.name}</strong><p className="slack-monitor-text">{workflow.rule.instructions}</p></> }<p className="slack-monitor-text">{workflow.reason || t('아직 판단 결과가 없습니다.')}</p>{workflow.prompt && <details><summary>{t('전달한 작업 지침')}</summary><p className="slack-monitor-text">{workflow.prompt}</p></details>}</section>
    {job && <section><h3>Auto Prompt</h3><p>{t('라우팅 상태')}: {routeLabels[job.status]}</p>{job.decision && <><p>{job.decision.action === 'resume' ? t('기존 세션 이어서 실행') : t('새 세션 생성')} · {job.decision.cwd}</p><p className="slack-monitor-text">{job.decision.reason}</p></>}{job.error && <p role="alert">{translateMessage(job.error)}</p>}</section>}
    {workflow.error && <p role="alert">{translateMessage(workflow.error)}</p>}
    {workflow.reply && <section><h3>{workflow.replyTs ? t('Slack에 보낸 답글') : t('작성된 답글')}</h3><p className="slack-monitor-text">{workflow.reply}</p></section>}
    {workflow.status === 'reply-uncertain' && <p role="alert">{t('답글 전송 여부를 확인할 수 없습니다. 원본 Slack 스레드를 확인하세요.')}</p>}
  </>;
}
