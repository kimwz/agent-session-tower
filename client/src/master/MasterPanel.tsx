import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AlertTriangle, ArrowUp, Bot, Check, ChevronDown, ChevronRight, CircleDashed, ExternalLink, LoaderCircle, Settings, Square, X } from 'lucide-react';
import type { MasterEntry, MasterOverview } from '../../../shared/master';
import { Markdown } from '../chat/Markdown';
import { scopedId, splitScopedId } from '../remote/scope';
import type { RoomState } from './room-stream';
import { MasterSettingsView } from './MasterSettings';
import { useWords } from './strings';
import { post } from './api';


interface Props {
  token: string;
  room: RoomState;
  tabId: string;
  sessionId: string | null;
  /** Where the page header ends, so the panel sits right under it. */
  top?: number;
  onClose(): void;
  onEarlier(): Promise<void>;
  onOpenSession(id: string): void;
}

/** The master's one conversation: what the owner asked, what the master did and said, and the work it handed out. */
/** The last message whose sending was not confirmed (it may or may not have arrived), for as long as this tab lives. */
let unconfirmed: { id: string; text: string } | undefined;

export function MasterPanel({ token, room, tabId, sessionId, top, onClose, onEarlier, onOpenSession }: Props) {
  const words = useWords();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [settings, setSettings] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const overview = room.overview;
  const thinking = overview?.state === 'thinking';

  useEffect(() => { if (!settings) input.current?.focus(); }, [settings]);
  useEffect(() => {
    const element = scroller.current;
    if (element && element.scrollHeight - element.scrollTop - element.clientHeight < 160) element.scrollTop = element.scrollHeight;
  }, [room.entries.length, room.draft?.text]);
  // Escape inside the panel closes the panel only (not the conversation behind it), and never while composing text.
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (!(event.target instanceof Node) || !panel.current?.contains(event.target)) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const send = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true); setError('');
    const { node, id } = sessionId ? splitScopedId(sessionId) : { node: undefined, id: undefined };
    // Sent again after its answer was lost, the same message keeps its id, so the master takes it once.
    const messageId = unconfirmed?.text === value ? unconfirmed.id : crypto.randomUUID();
    unconfirmed = { id: messageId, text: value };
    try {
      await post('/api/master/messages', token, { clientMessageId: messageId, text: value, viewContext: { tabId, ...(id ? { sessionId: id } : {}), ...(node ? { node } : {}) } });
      // Only this message's own id is let go: another may have been sent from a panel opened meanwhile.
      if (unconfirmed?.id === messageId) unconfirmed = undefined;
      setText('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSending(false); }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); }
  };
  const stop = () => { void post('/api/master/stop', token, {}).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))); };

  const configured = overview?.configured;
  const disabled = overview?.settings.enabled === false;
  return <aside ref={panel} className="master-panel" role="dialog" aria-label={words('마스터 에이전트', 'Master agent')} style={top !== undefined ? { '--master-top': `${top}px` } as React.CSSProperties : undefined}>
    <header className="master-header">
      <Bot size={17} />
      <h2>{words('마스터', 'Master')}</h2>
      <span className={`master-state ${overview?.state ?? ''}`}>{stateLabel(overview, words)}</span>
      <button className={`icon-button ${settings ? 'active' : ''}`} onClick={() => setSettings(value => !value)} aria-label={words('마스터 설정', 'Master settings')} title={words('마스터 설정', 'Master settings')}><Settings size={16} /></button>
      <button className="icon-button" onClick={onClose} aria-label={words('닫기', 'Close')} title={words('닫기', 'Close')}><X size={16} /></button>
    </header>
    {settings || (overview && !configured) ? <MasterSettingsView token={token} overview={overview} onDone={() => setSettings(false)} /> : <>
      <div className="master-timeline" ref={scroller}>
        {room.hasMore && <button className="master-earlier" onClick={() => void onEarlier()}>{words('이전 대화 보기', 'Show earlier')}</button>}
        {!room.entries.length && !room.draft && <div className="master-empty"><Bot size={26} /><p>{words('Tower에서 하던 일을 말로 시켜 보세요. 예: "지금 작업 중인 세션 알려줘", "monitor에 세션 열어서 로그인 버그 고쳐줘".', 'Ask Tower in plain words. For example: "What is working right now?", "Open a session in monitor and fix the login bug."')}</p></div>}
        <Timeline entries={room.entries} onOpenSession={onOpenSession} />
        {room.draft?.text && <div className="master-message master"><Markdown>{room.draft.text}</Markdown><span className="master-cursor" /></div>}
        {thinking && !room.draft?.text && <div className="master-thinking"><LoaderCircle size={14} className="spin" />{words('생각하는 중', 'Thinking')}</div>}
      </div>
      {(error || room.error) && <div className="master-error" role="alert"><AlertTriangle size={13} />{error || room.error}</div>}
      <div className="master-composer">
        <textarea ref={input} value={text} rows={2} maxLength={32_000} disabled={disabled} placeholder={disabled ? words('마스터가 꺼져 있습니다', 'The master is turned off') : words('마스터에게 시킬 일', 'What should Tower do?')} onChange={event => setText(event.target.value)} onKeyDown={onKeyDown} aria-label={words('마스터에게 보낼 메시지', 'Message to the master')} />
        {thinking ? <button className="master-stop" onClick={stop} title={words('생각 멈추기 (보낸 작업은 계속됩니다)', 'Stop thinking (work already sent continues)')}><Square size={14} />{words('생각 멈춤', 'Stop')}</button>
          : <button className="master-send" onClick={() => void send()} disabled={!text.trim() || sending || disabled} aria-label={words('보내기', 'Send')}>{sending ? <LoaderCircle size={15} className="spin" /> : <ArrowUp size={16} />}</button>}
      </div>
    </>}
  </aside>;
}

function stateLabel(overview: MasterOverview | undefined, words: (ko: string, en: string) => string): string {
  if (!overview) return words('연결 중', 'Connecting');
  if (overview.state === 'disabled') return words('꺼짐', 'Off');
  if (overview.state === 'unconfigured') return words('키 필요', 'Key needed');
  if (overview.state === 'thinking') return words('생각 중', 'Thinking');
  return overview.activeTasks ? words(`맡긴 일 ${overview.activeTasks}개 진행 중`, `${overview.activeTasks} delegated running`) : words('대기', 'Ready');
}

/** Consecutive calls of one turn fold into one line; everything else is shown as it came. */
function Timeline({ entries, onOpenSession }: { entries: MasterEntry[]; onOpenSession(id: string): void }) {
  const groups: Array<MasterEntry | MasterEntry[]> = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (entry.data.kind === 'action' && Array.isArray(last) && last[0].data.kind === 'action' && last[0].data.turnId === entry.data.turnId) last.push(entry);
    else groups.push(entry.data.kind === 'action' ? [entry] : entry);
  }
  return <>{groups.map(group => Array.isArray(group) ? <Actions key={group[0].id} entries={group} /> : <Entry key={group.id} entry={group} onOpenSession={onOpenSession} />)}</>;
}

function Actions({ entries }: { entries: MasterEntry[] }) {
  const words = useWords();
  const [open, setOpen] = useState(false);
  const writes = entries.filter(entry => entry.data.kind === 'action' && entry.data.write);
  const pending = entries.some(entry => entry.data.kind === 'action' && entry.data.state === 'sending');
  const problems = entries.filter(entry => entry.data.kind === 'action' && (entry.data.state === 'failed' || entry.data.state === 'uncertain'));
  return <div className={`master-actions ${problems.length ? 'problem' : ''}`}>
    <button onClick={() => setOpen(value => !value)} aria-expanded={open}>
      {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      {pending ? <LoaderCircle size={12} className="spin" /> : problems.length ? <AlertTriangle size={12} /> : <Check size={12} />}
      <span>{writes.length ? words(`작업 ${writes.length}개 실행`, `${writes.length} change${writes.length > 1 ? 's' : ''}`) : words(`조회 ${entries.length}개`, `${entries.length} lookup${entries.length > 1 ? 's' : ''}`)}{problems.length ? words(` · 확인 필요 ${problems.length}`, ` · ${problems.length} need a look`) : ''}</span>
    </button>
    {open && <ul>{entries.map(entry => entry.data.kind === 'action' && <li key={entry.id} className={entry.data.state}>
      <code>{entry.data.method} {entry.data.path}</code>
      <span>{actionLabel(entry.data.state, words)}{entry.data.summary ? ` · ${entry.data.summary}` : ''}</span>
    </li>)}</ul>}
  </div>;
}

function actionLabel(state: string, words: (ko: string, en: string) => string): string {
  return state === 'sending' ? words('보내는 중', 'Sending') : state === 'succeeded' ? words('완료', 'Done') : state === 'failed' ? words('거절됨', 'Refused')
    : state === 'uncertain' ? words('결과 불명', 'Outcome unknown') : words('처리 안 됨', 'Not run');
}

function Entry({ entry, onOpenSession }: { entry: MasterEntry; onOpenSession(id: string): void }) {
  const words = useWords();
  const data = entry.data;
  if (data.kind === 'owner') return <div className="master-message owner">{showSecrets(data.text)}</div>;
  if (data.kind === 'master') return <div className="master-message master"><Markdown>{showSecrets(data.text)}</Markdown></div>;
  if (data.kind === 'event') return <div className="master-event">{data.text}</div>;
  if (data.kind === 'error') return <div className="master-event error"><AlertTriangle size={12} />{data.text}</div>;
  if (data.kind === 'task') {
    const session = data.sessionId ? scopedId(data.node, data.sessionId) : undefined;
    return <div className={`master-task ${data.state}`}>
      <div className="master-task-head">{data.state === 'running' ? <CircleDashed size={13} className="spin-slow" /> : data.state === 'completed' ? <Check size={13} /> : <AlertTriangle size={13} />}<b>{data.title}</b></div>
      <div className="master-task-meta">{taskLabel(data.state, words)}{session && <button onClick={() => onOpenSession(session)}><ExternalLink size={12} />{words('세션 열기', 'Open session')}</button>}</div>
      {data.answer && <p>{data.answer}</p>}
    </div>;
  }
  return null;
}

function taskLabel(state: string, words: (ko: string, en: string) => string): string {
  return state === 'running' ? words('맡긴 일 진행 중', 'Delegated · running') : state === 'completed' ? words('끝남', 'Finished') : state === 'cancelled' ? words('멈춤', 'Stopped')
    : state === 'error' ? words('오류', 'Error') : words('상태 모름', 'Unknown');
}

/** Secret references read as a lock, never as the value. */
function showSecrets(text: string): string { return text.replace(/\{\{secret:[a-f0-9]{16}\}\}/g, '🔒'); }

