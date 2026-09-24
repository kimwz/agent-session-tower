import { useEffect, useState, type CSSProperties } from 'react';
import { ArrowLeft, CalendarClock, CircleDot, ExternalLink, Globe, Play, X, Zap } from 'lucide-react';
import type { SlackPublicStatus } from '../../../shared/slack';
import type { TriggerEvent } from '../../../shared/triggers';
import type { AutoPromptJob } from '../../../shared/types';
import { useChatAppearance } from '../chat/chat-appearance';
import { SessionTail } from '../chat/SessionTail';
import { absoluteTime } from '../common/lib';
import { translateMessage, useI18n } from '../i18n/i18n';
import { SlackMentionDetail, SlackOverview } from '../slack/SlackMonitorPanel';
import { eventStatusLabel, towerOperation } from './trigger-helpers';
import { triggerEventWorking } from './trigger-monitor';

/**
 * The side panel for the canvas trigger monitor. Without a selection it lists recent trigger runs and
 * Slack; a selected run or mention shows what happened and the conversation that did the work.
 */
export function TriggerMonitorPanel({ token, slack, slackError, mentionId, jobs, slackUnreadIds, onSlackRead, events, eventId, triggerUnreadIds, onTriggerRead, hasMore, onMore, onEventUpdate, onClose, onSelectMention, onSelectEvent, onNavigate }: {
  token: string; slack: SlackPublicStatus | null; slackError: string; mentionId: string | null | undefined; jobs: AutoPromptJob[];
  slackUnreadIds?: ReadonlySet<string>; onSlackRead?: () => void;
  events: TriggerEvent[]; eventId: string | null; triggerUnreadIds?: ReadonlySet<string>; onTriggerRead?: (event: TriggerEvent) => void;
  hasMore: boolean; onMore: () => void; onEventUpdate: (event: TriggerEvent) => void;
  onClose: () => void; onSelectMention: (id: string | null) => void; onSelectEvent: (id: string) => void; onNavigate: (id: string) => void;
}) {
  const { t } = useI18n();
  const appearance = useChatAppearance();
  const event = eventId ? events.find(item => item.id === eventId) : undefined;
  const workflow = mentionId ? slack?.events.find(item => item.id === mentionId) : undefined;
  const job = jobs.find(item => item.id === workflow?.autoPromptId);
  const overview = !eventId && !mentionId;
  const [shown, setShown] = useState(PANEL_PAGE);
  return <><div className="chat-panel-spacer" aria-hidden="true" style={{ width: appearance.width, flexBasis: appearance.width }} /><aside className="chat-panel slack-monitor-panel trigger-monitor-panel" aria-label={t('트리거 모니터')} style={{ '--chat-font-size': `${appearance.fontSize}px`, '--chat-width': `${appearance.width}px` } as CSSProperties}>
    <div className="chat-resize-handle" role="separator" tabIndex={0} aria-label={t('대화창 너비 조절')} aria-orientation="vertical" aria-valuemin={320} aria-valuemax={appearance.maxWidth} aria-valuenow={appearance.width} onPointerDown={appearance.startResize} onPointerMove={appearance.resize} onPointerUp={appearance.stopResize} onPointerCancel={appearance.stopResize} onLostPointerCapture={appearance.stopResize} onKeyDown={key => { if (key.key === 'ArrowLeft' || key.key === 'ArrowRight') { key.preventDefault(); appearance.changeWidth(appearance.width + (key.key === 'ArrowLeft' ? 20 : -20)); } }} />
    <header className="chat-header"><div className="chat-heading-line"><Zap size={20} /><h2>{t('트리거 모니터')}</h2><div className="chat-header-actions"><button className="icon-button" onClick={onClose} aria-label={t('닫기')}><X size={18} /></button></div></div></header>
    <div className="slack-monitor-content">
      {slackError && <p role="alert">{translateMessage(slackError)}</p>}
      {!overview && <button className="slack-monitor-back" onClick={() => onSelectMention(null)}><ArrowLeft size={14} />{t('전체 보기')}</button>}
      {eventId ? <TriggerEventDetail key={eventId} eventId={eventId} initial={event} token={token} onRead={onTriggerRead} onUpdate={onEventUpdate} onNavigate={onNavigate} />
        : mentionId ? workflow ? <SlackMentionDetail workflow={workflow} job={job} token={token} onRead={onSlackRead} onNavigate={onNavigate} /> : <p>{t('이 멘션 기록을 찾을 수 없습니다.')}</p>
        : <>
          <section><h3>{t('트리거 실행')}</h3>
            {events.length ? events.slice(0, shown).map(item => <button key={item.id} className={`slack-monitor-entry ${triggerEventWorking(item) ? 'working' : triggerUnreadIds?.has(item.id) ? 'unread' : ''}`} onClick={() => onSelectEvent(item.id)}>
              <strong>{item.triggerName}</strong><span>{eventStatusLabel(item.status, t)} · {item.summary}</span><time>{new Date(item.receivedAt).toLocaleString()}</time></button>)
              : <p>{t('아직 트리거가 실행되지 않았습니다. 트리거는 상단의 번개 버튼에서 만듭니다.')}</p>}
            {(events.length > shown || hasMore) && <button className="slack-monitor-back" onClick={() => { setShown(value => value + PANEL_PAGE); if (shown + PANEL_PAGE > events.length) onMore(); }}>{t('실행 더 보기')}</button>}
          </section>
          <section><h3>Slack</h3><SlackOverview slack={slack} token={token} unreadIds={slackUnreadIds} onSelectMention={onSelectMention} /></section>
        </>}
    </div>
  </aside></>;
}

const PANEL_PAGE = 50;
const KIND_LABELS: Record<TriggerEvent['kind'], string> = { schedule: '예약 실행', http: 'HTTP 응답', github: 'GitHub 이슈', manual: '지금 실행' };

/**
 * One trigger run: when and why it ran, what it saw, and the conversation that did the work. The run itself
 * is read by id, so it stays open and current even after newer runs push it out of the list or its trigger
 * is deleted, and it is followed until it finishes.
 */
export function TriggerEventDetail({ eventId, initial, token, onRead, onUpdate, onNavigate }: { eventId: string; initial?: TriggerEvent; token: string; onRead?: (event: TriggerEvent) => void; onUpdate?: (event: TriggerEvent) => void; onNavigate: (id: string) => void }) {
  const { t } = useI18n();
  const [full, setFull] = useState<TriggerEvent | undefined>();
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!token) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const next = (await towerOperation<{ event: TriggerEvent }>(token, 'triggers.event', { id: eventId })).event;
        if (disposed) return;
        setFull(next); setLoadError(''); onUpdate?.(next);
        if (triggerEventWorking(next)) timer = setTimeout(() => void load(), 5000);
      } catch (cause) {
        if (disposed) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        setLoadError(message);
        // A worker from before this view cannot answer until it is updated; asking again would not help.
        if (!/Unknown Tower operation/.test(message)) timer = setTimeout(() => void load(), 15_000);
      }
    };
    void load();
    return () => { disposed = true; clearTimeout(timer); };
  }, [token, eventId, attempt]);
  const unsupported = /Unknown Tower operation/.test(loadError);
  const retry = unsupported && <button className="slack-monitor-back" onClick={() => setAttempt(value => value + 1)}>{t('다시 불러오기')}</button>;
  const current = full && (!initial || full.updatedAt >= initial.updatedAt) ? full : initial;
  useEffect(() => { if (current) onRead?.(current); }, [current?.status, current?.updatedAt, onRead]);
  if (!current) return loadError ? <><p role="alert">{unsupported ? t('실행 워커가 새 버전으로 교체되면 볼 수 있습니다.') : translateMessage(loadError)}</p>{retry}</> : <p>{t('불러오는 중')}</p>;
  const Icon = current.kind === 'http' ? Globe : current.kind === 'github' ? CircleDot : current.kind === 'manual' ? Play : CalendarClock;
  const link = current.payload && typeof current.payload === 'object' && typeof (current.payload as { url?: unknown }).url === 'string' && /^https:\/\/github\.com\//.test((current.payload as { url: string }).url) ? (current.payload as { url: string }).url : undefined;
  const sessionId = current.dispatch?.sessionId;
  const instructions = full?.input.instructions || initial?.input.instructions;
  const payload = full?.payload ?? initial?.payload;
  return <>
    <div className={`slack-monitor-state ${triggerEventWorking(current) ? 'working' : ''}`} role="status">{eventStatusLabel(current.status, t)}</div>
    {loadError && <p role="alert">{unsupported ? t('실행 워커가 새 버전으로 교체되면 자세한 내용을 볼 수 있습니다.') : `${t('실행 기록을 불러오지 못했습니다. 잠시 뒤 다시 시도합니다.')} ${translateMessage(loadError)}`}</p>}{retry}
    <section><h3><Icon size={13} /> {current.triggerName}</h3>
      <p className="slack-monitor-muted">{t(KIND_LABELS[current.kind])} · {absoluteTime(current.occurredAt)}</p>
      <p className="slack-monitor-text">{current.summary}</p>
      {link && <a className="slack-monitor-back" href={link} target="_blank" rel="noreferrer noopener"><ExternalLink size={14} />{t('GitHub에서 보기')}</a>}
      {current.reason && <p className="slack-monitor-text">{translateMessage(current.reason)}</p>}
      {current.error && <p role="alert">{translateMessage(current.error)}</p>}
      {instructions && <details><summary>{t('전달한 지시')}</summary><p className="slack-monitor-text">{instructions}</p></details>}
      {payload !== undefined && <details><summary>{link ? t('받은 이슈') : t('받은 응답')}</summary><pre className="slack-monitor-text">{JSON.stringify(payload, null, 2)}</pre></details>}
    </section>
    {sessionId ? <SessionTail sessionId={sessionId} selection={current.id} onNavigate={onNavigate} />
      : triggerEventWorking(current) && <p>{t('아직 실행 세션이 생성되지 않았습니다.')}</p>}
  </>;
}
