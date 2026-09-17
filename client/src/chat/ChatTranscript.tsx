import { translate as t, useI18n } from '../i18n/i18n';
import { memo, useMemo, useRef, useState } from 'react';
import { ChevronDown, TriangleAlert } from 'lucide-react';
import type { ChatMessage } from '../../../shared/types';
import { groupConsecutiveTools, type ToolGroup } from './chat-tool-groups';
import { Message } from './Message';
import type { ChatRunMatch } from './chat-runs';

export const ToolMessageGroup = memo(function ToolMessageGroup({ group }: { group: ToolGroup }) {
  useI18n();
  const [expanded, setExpanded] = useState(false);
  const summary = useRef<HTMLElement>(null);
  return <details className={`tool-group ${group.errorCount ? 'tool-group-error' : ''}`} open={expanded} onToggle={event => {
    if (event.target === event.currentTarget) setExpanded(event.currentTarget.open);
  }}>
    <summary ref={summary}><strong>{group.workCount ? t("{0}개의 작업", { 0: group.workCount }) : t("세션 정보")}</strong>{group.errorCount > 0 && <span className="tool-group-errors"><TriangleAlert size={10} aria-hidden="true" />{t("오류")}{' '}{group.errorCount}{t("건")}</span>}<ChevronDown size={11} aria-hidden="true" /></summary>
    {expanded && <div className="tool-group-content">{group.messages.map(message => <Message key={message.id} message={message} />)}<button className="tool-group-collapse" onClick={() => { setExpanded(false); summary.current?.focus(); }}>{group.workCount ? t("작업 접기") : t("세션 정보 접기")}<ChevronDown size={11} aria-hidden="true" /></button></div>}
  </details>;
});

export const ChatTranscript = memo(function ChatTranscript({ messages, runMatches }: { messages: readonly ChatMessage[]; runMatches?: ReadonlyMap<string, ChatRunMatch> }) {
  const entries = useMemo(() => groupConsecutiveTools(messages), [messages]);
  return <>{entries.map(entry => entry.kind === 'tools' ? <ToolMessageGroup key={`tools:${entry.id}`} group={entry} /> : <Message key={`message:${entry.message.id}`} message={entry.message} runMatch={runMatches?.get(entry.message.id)} />)}</>;
});
