import { translate as t, useI18n } from '../i18n/i18n';
import { memo, useMemo, useRef, useState } from 'react';
import { ChevronDown, TriangleAlert } from 'lucide-react';
import type { ChatMessage, Provider } from '../../../shared/types';
import { isTaskNotification, taskNotice, TASK_NOTICE } from '../../../shared/task-notification';
import { groupConsecutiveTools, type ToolGroup } from './chat-tool-groups';
import { ChatImages } from './ChatImages';
import { Message } from './Message';
import type { ChatRunMatch } from './chat-runs';

export const ToolMessageGroup = memo(function ToolMessageGroup({ group }: { group: ToolGroup }) {
  useI18n();
  const [expanded, setExpanded] = useState(false);
  const summary = useRef<HTMLElement>(null);
  const notices = group.messages.every(message => message.toolName === TASK_NOTICE);
  return <><ChatImages images={group.messages.flatMap(message => message.images ?? [])} /><details className={`tool-group ${group.errorCount ? 'tool-group-error' : ''}`} open={expanded} onToggle={event => {
    if (event.target === event.currentTarget) setExpanded(event.currentTarget.open);
  }}>
    <summary ref={summary}><strong>{group.workCount ? t("{0}개의 작업", { 0: group.workCount }) : notices ? t("백그라운드 작업") : t("세션 정보")}</strong>{group.errorCount > 0 && <span className="tool-group-errors"><TriangleAlert size={10} aria-hidden="true" />{t("오류")}{' '}{group.errorCount}{t("건")}</span>}<ChevronDown size={11} aria-hidden="true" /></summary>
    {expanded && <div className="tool-group-content">{group.messages.map(message => <Message key={message.id} message={{ ...message, images: undefined }} />)}<button className="tool-group-collapse" onClick={() => { setExpanded(false); summary.current?.focus(); }}>{group.workCount ? t("작업 접기") : notices ? t("백그라운드 작업 접기") : t("세션 정보 접기")}<ChevronDown size={11} aria-hidden="true" /></button></div>}
  </details></>;
});

/**
 * A background task's notice that an older worker or computer still sends as your message reads as the notice it is.
 * Only Claude Code writes these; a Codex message that happens to start like one is what you wrote.
 */
export function readableNotice(message: ChatMessage, provider?: Provider): ChatMessage {
  if (provider !== 'claude' || message.role !== 'user' || !isTaskNotification(message.text)) return message;
  const notice = taskNotice(message.text);
  return { ...message, role: 'system', toolName: TASK_NOTICE, text: notice.text, ...(notice.failed ? { isError: true } : {}) };
}

export const ChatTranscript = memo(function ChatTranscript({ messages, runMatches, provider }: { messages: readonly ChatMessage[]; runMatches?: ReadonlyMap<string, ChatRunMatch>; provider?: Provider }) {
  const entries = useMemo(() => groupConsecutiveTools(messages.map(message => readableNotice(message, provider))), [messages, provider]);
  return <>{entries.map(entry => entry.kind === 'tools' ? <ToolMessageGroup key={`tools:${entry.id}`} group={entry} /> : <Message key={`message:${entry.message.id}`} message={entry.message} runMatch={runMatches?.get(entry.message.id)} />)}</>;
});
