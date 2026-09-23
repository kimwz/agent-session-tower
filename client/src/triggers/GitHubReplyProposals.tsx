import { useEffect, useRef, useState } from 'react';
import type { SlackWorkflow } from '../../../shared/slack';
import { translateMessage, useI18n } from '../i18n/i18n';
import { towerOperation } from './TriggerPanel';

interface Conversation { id: string; status: string; repository: string; issue: number; replies: NonNullable<SlackWorkflow['replies']>; error?: string }

/**
 * Comment proposals of a GitHub coordinator conversation, above its chat. Clicking one posts exactly that text
 * to the issue; the owner can also approve or ask for changes in the chat.
 */
export function GitHubReplyProposals({ token, sessionId, enabled }: { token: string; sessionId: string; enabled: boolean }) {
  const { t } = useI18n();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [local, setLocal] = useState<Partial<Record<string, 'sending' | 'sent' | 'uncertain'>>>({});
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(true);
  const locked = useRef(new Set<string>());
  const [reload, setReload] = useState(0);
  useEffect(() => {
    setConversation(null);
    if (!enabled || !token) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const next = (await towerOperation<{ conversation: Conversation }>(token, 'github.conversation', { sessionId })).conversation;
        if (disposed) return;
        setConversation(next);
        timer = setTimeout(() => void load(), 4000);
      } catch (cause) {
        if (disposed) return;
        // Not a coordinator conversation, or a worker without them: nothing to show or ask again. Anything else is tried again.
        if (/not a GitHub coordinator conversation|Unknown Tower operation/.test(String(cause))) setConversation(null);
        else timer = setTimeout(() => void load(), 8000);
      }
    };
    void load();
    return () => { disposed = true; clearTimeout(timer); };
  }, [token, sessionId, enabled, reload]);
  if (!conversation?.replies.length) return null;
  const approve = async (requestKey: string, text: string) => {
    if (!conversation || locked.current.has(requestKey)) return;
    locked.current.add(requestKey);
    setLocal(previous => ({ ...previous, [requestKey]: 'sending' }));
    setError('');
    try {
      await towerOperation(token, 'github.approveReply', { workflowId: conversation.id, requestKey, text });
      setLocal(previous => ({ ...previous, [requestKey]: 'sent' }));
    } catch (cause) {
      // What happened is the server's to say: a comment that was never sent can be approved again, an uncertain one cannot.
      setLocal(previous => { const next = { ...previous }; delete next[requestKey]; return next; });
      locked.current.delete(requestKey);
      setError(cause instanceof Error ? cause.message : String(cause));
      setReload(value => value + 1);
    }
  };
  return <details className="slack-reply-proposals" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>{t('GitHub 댓글 제안')} <span className="slack-reply-count">({conversation.replies.length}) · {conversation.repository}#{conversation.issue}</span></summary>
    <p>{t('댓글 텍스트를 클릭하면 GitHub 이슈에 게시됩니다. 채팅에서 “2번 댓글을 GitHub에 보내주세요” 또는 수정을 요청할 수도 있습니다.')}</p>
    <ol>{conversation.replies.map(reply => {
      const status = reply.status === 'proposed' ? local[reply.requestKey] || reply.status : reply.status;
      return <li key={reply.requestKey}>
        {status === 'proposed' ? <button type="button" className="slack-reply-text" title={t('이 내용으로 GitHub에 게시')} onClick={() => void approve(reply.requestKey, reply.text)}>{reply.text}</button>
          : <><p className="slack-monitor-text">{reply.text}</p><span role="status">{t(status === 'sent' ? 'GitHub에 게시됨' : status === 'sending' ? '댓글 게시 중' : '게시 여부를 확인할 수 없습니다. GitHub 이슈를 확인하세요.')}</span></>}
      </li>;
    })}</ol>
    {error && <p role="alert">{translateMessage(error)}</p>}
  </details>;
}
