import { translate as t, useI18n } from '../i18n/i18n';
import { TASK_NOTICE } from '../../../shared/task-notification';
import { memo, useState } from 'react';
import { ChevronDown, Terminal } from 'lucide-react';
import type { ChatMessage } from '../../../shared/types';
import { absoluteTime, cleanPreview } from '../common/lib';
import { SavedAttachments } from './ChatAttachments';
import { Markdown } from './Markdown';
import type { ChatRunMatch } from './chat-runs';

export const Message = memo(function Message({ message, runMatch }: { message: ChatMessage; runMatch?: ChatRunMatch }) {
  useI18n();
  const [expanded, setExpanded] = useState(false);
  if (message.role === 'tool' || message.role === 'system') return <details className={`tool-message ${message.isError ? 'tool-error' : ''}`} open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}><summary><Terminal size={13} /><strong>{message.toolName === TASK_NOTICE ? t("백그라운드 작업") : message.toolName || (message.role === 'system' ? t("세션 정보") : t("도구 실행"))}</strong><span>{cleanPreview(message.text, 110)}</span><ChevronDown size={13} /></summary>{expanded && <div><Markdown>{message.text}</Markdown></div>}</details>;
  const text = runMatch?.text ?? message.text;
  const long = message.role === 'user' && text.length > 2400;
  // Marked so the chat can keep the latest of your messages in view while you read what followed it.
  return <article className={`chat-message ${message.role} ${message.isError ? 'message-error' : ''}`} {...message.role === 'user' ? { 'data-user-message': message.id } : {}}>
    <div className="message-meta"><span>{message.role === 'user' ? t("나") : t("에이전트")}</span><time dateTime={message.timestamp}>{absoluteTime(message.timestamp)}</time></div>
    <div className="message-content">{text && <div className={long && !expanded ? 'message-truncated' : undefined}><Markdown>{long && !expanded ? `${text.slice(0, 2100)}…` : text}</Markdown></div>}{!!runMatch?.attachments?.length && <SavedAttachments attachments={runMatch.attachments} />}</div>
    {long && <button className="text-button message-expand" onClick={() => setExpanded(!expanded)}>{expanded ? t("간략히 보기") : t("메시지 전체 보기")}<ChevronDown size={12} className={expanded ? 'rotate' : ''} /></button>}
  </article>;
});
