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
    <p>{t(workflow.mode === 'conversation' ? '아래 채팅에서 “3번 답변을 Slack에 보내주세요”처럼 요청하거나 전송 버튼을 누르세요. 답변 수정도 채팅에서 요청할 수 있습니다.' : '원하는 답변을 골라 전송을 승인하세요.')}</p>
    <ol>{workflow.replies.map(reply => {
      const status = reply.status === 'proposed' ? local[reply.requestKey] || reply.status : reply.status;
      return <li key={reply.requestKey}>
        <p className="slack-monitor-text">{reply.text}</p>
        {status === 'proposed' ? <button type="button" className="primary-button" disabled={!token} onClick={() => void approve(reply.requestKey, reply.text)}>{t('이 내용으로 Slack에 전송')}</button>
          : <span role="status">{t(status === 'sent' ? 'Slack에 전송됨' : status === 'sending' ? '댓글 전송 중' : '답글 전송 여부를 확인할 수 없습니다. 원본 Slack 스레드를 확인하세요.')}</span>}
      </li>;
    })}</ol>
    {error && <p role="alert">{translateMessage(error)}</p>}
  </section>;
}
