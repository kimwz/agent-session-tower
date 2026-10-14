import { translate as t, useI18n } from '../i18n/i18n';
import { TASK_NOTICE } from '../../../shared/task-notification';
import { memo, useState } from 'react';
import { Bot, ChevronDown, Terminal } from 'lucide-react';
import type { ChatMessage } from '../../../shared/types';
import { absoluteTime, cleanPreview } from '../common/lib';
import { SavedAttachments } from './ChatAttachments';
import { ChatImages } from './ChatImages';
import { Markdown } from './Markdown';
import type { ChatRunMatch } from './chat-runs';

export const Message = memo(function Message({ message, runMatch }: { message: ChatMessage; runMatch?: ChatRunMatch }) {
  useI18n();
  const [expanded, setExpanded] = useState(false);
  if (message.role === 'tool' || message.role === 'system') return <><ChatImages images={message.images} /><details className={`tool-message ${message.isError ? 'tool-error' : ''}`} open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}><summary><Terminal size={13} /><strong>{message.toolName === TASK_NOTICE ? t("백그라운드 작업") : message.toolName || (message.role === 'system' ? t("세션 정보") : t("도구 실행"))}</strong><span>{cleanPreview(message.text, 110)}</span><ChevronDown size={13} /></summary>{expanded && <div><Markdown>{message.text}</Markdown></div>}</details></>;
  const text = runMatch?.text ?? message.text;
  const long = message.role === 'user' && text.length > 2400;
  // Marked so the chat can keep the latest of your messages in view while you read what followed it.
  // What the master agent wrote says so; the owner's own messages stay "나".
  const fromMaster = message.role === 'user' && runMatch?.sender === 'master';
  return <article className={`chat-message ${message.role} ${fromMaster ? 'from-master' : ''} ${message.isError ? 'message-error' : ''}`} {...message.role === 'user' ? { 'data-user-message': message.id } : {}}>
    <div className="message-meta"><span>{fromMaster ? <><Bot size={12} aria-hidden />{t("마스터 에이전트")}</> : message.role === 'user' ? t("나") : t("에이전트")}</span><time dateTime={message.timestamp}>{absoluteTime(message.timestamp)}</time></div>
    <div className="message-content">{text && <div className={long && !expanded ? 'message-truncated' : undefined}><Markdown images={message.images} lineBreaks={fromMaster}>{long && !expanded ? `${text.slice(0, 2100)}…` : text}</Markdown></div>}<ChatImages images={message.images?.filter(image => ![...text.matchAll(/!\[[^\]]*\]\(<?([^>\n]*?)>?\)/g)].some(match => match[1] === image.source))} />{!!runMatch?.attachments?.length && <SavedAttachments attachments={runMatch.attachments} />}</div>
    {long && <button className="text-button message-expand" onClick={() => setExpanded(!expanded)}>{expanded ? t("간략히 보기") : t("메시지 전체 보기")}<ChevronDown size={12} className={expanded ? 'rotate' : ''} /></button>}
  </article>;
});
