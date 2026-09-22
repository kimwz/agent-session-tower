import { useRef, useState } from 'react';
import type { SlackWorkflow } from '../../../shared/slack';
import { authPost } from '../auth/AuthGate';
import { useI18n, translateMessage } from '../i18n/i18n';
import { SLACK_CHANGED_EVENT } from './use-slack-monitor';

/** Displays persisted proposals and provides direct approval alongside chat authorization. */
export function SlackReplyProposals({ workflow, token = '' }: { workflow?: SlackWorkflow; token?: string }) {
  const { t } = useI18n();
  const locked = useRef(new Set<string>());
  const [local, setLocal] = useState<Partial<Record<string, 'sending' | 'sent' | 'uncertain'>>>({});
  const [error, setError] = useState('');
  if (!workflow?.replies?.length) return null;
  async function approve(requestKey: string, text: string) {
    if (!workflow || !token || locked.current.has(requestKey)) return;
    locked.current.add(requestKey);
    setLocal(previous => ({ ...previous, [requestKey]: 'sending' }));
    setError('');
    try {
      await authPost('/api/slack/replies/approve', token, { workflowId: workflow.id, requestKey, text });
      setLocal(previous => ({ ...previous, [requestKey]: 'sent' }));
    } catch (cause) {
      setLocal(previous => ({ ...previous, [requestKey]: 'uncertain' }));
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      window.dispatchEvent(new Event(SLACK_CHANGED_EVENT));
    }
  }
  return <section className="slack-reply-proposals" aria-label={t('Slack 답변 제안')}>
    <h3>{t('Slack 답변 제안')}</h3>
    <p>{t(workflow.mode === 'conversation' ? '답변 텍스트를 클릭하면 Slack에 전송됩니다. 채팅에서 “3번 답변을 Slack에 보내주세요” 또는 수정을 요청할 수도 있습니다.' : '답변 텍스트를 클릭하면 Slack에 전송됩니다.')}</p>
    <ol>{workflow.replies.map(reply => {
      const status = reply.status === 'proposed' ? local[reply.requestKey] || reply.status : reply.status;
      return <li key={reply.requestKey}>
        {status === 'proposed' ? <button type="button" className="slack-reply-text" title={t('이 내용으로 Slack에 전송')} disabled={!token} onClick={() => void approve(reply.requestKey, reply.text)}>{reply.text}</button>
          : <><p className="slack-monitor-text">{reply.text}</p><span role="status">{t(status === 'sent' ? 'Slack에 전송됨' : status === 'sending' ? '댓글 전송 중' : '답글 전송 여부를 확인할 수 없습니다. 원본 Slack 스레드를 확인하세요.')}</span></>}
      </li>;
    })}</ol>
    {error && <p role="alert">{translateMessage(error)}</p>}
  </section>;
}
