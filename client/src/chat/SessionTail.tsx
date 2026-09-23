import { ExternalLink } from 'lucide-react';
import { useSessionTail } from '../common/use-session-tail';
import { translateMessage, useI18n } from '../i18n/i18n';
import { ChatTranscript } from './ChatTranscript';

/** The latest messages of the session that did an automation's work, with a way into the full session. */
export function SessionTail({ sessionId, selection, onNavigate }: { sessionId: string; selection: string; onNavigate: (id: string) => void }) {
  const { t } = useI18n();
  const { detail, error } = useSessionTail(sessionId, selection);
  return <section><h3>{t('에이전트 응답')}</h3>
    <button className="slack-monitor-back" onClick={() => onNavigate(sessionId)}><ExternalLink size={14} />{t('실행 세션 열기')}</button>
    {error && <p role="alert">{translateMessage(error)}</p>}
    {detail ? <><p className="slack-monitor-muted">{t('실행 세션의 최근 대화입니다. 전체 기록은 실행 세션에서 확인하세요.')}</p><ChatTranscript messages={detail.messages} /></> : !error && <p>{t('대화를 여는 중')}</p>}
  </section>;
}
