import { translate as t, translateMessage, useI18n } from './i18n';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Check, ChevronDown, ChevronLeft, Copy, Folder, GitBranch, LoaderCircle, MessageSquare, Paperclip, RefreshCw, Send, Square, Terminal, Trash2, TriangleAlert, X } from 'lucide-react';
import type { ChatMessage, ProviderHealth, Run, Session, SessionDetail } from '../../shared/types';
import { ProviderIcon } from './Icons';
import { SessionTitleEditor } from './SessionTitleEditor';
import { SessionFamilyNav } from './SessionFamilyNav';
import { absoluteTime, api, cleanPreview, copyText, providerLabels, statusLabels } from './lib';
import { mergeLatestPage, prependOlderPage, type ChatHistory } from './chat-history';
import { groupConsecutiveTools, type ToolGroup } from './chat-tool-groups';
import { DraftAttachments, SavedAttachments } from './ChatAttachments';
import { addDraftFiles, formatAttachmentSize, prepareDraftAttachments } from './chat-attachments';
import { MAX_ATTACHMENTS, MAX_TOTAL_ATTACHMENT_BYTES } from '../../shared/attachments';
import { draftFromRun, finishComposerSend, getComposerState, markComposerSending, setComposerDraft, setComposerError, startComposerSend, subscribeComposer, type ChatDraft } from './chat-drafts';
import { matchChatRuns, type ChatRunMatch } from './chat-runs';
import { ModelPicker } from './ModelPicker';

const emptyMessages: readonly ChatMessage[] = [];

function CodeBlock({ children, ...props }: ComponentPropsWithoutRef<'pre'>) {
  useI18n();
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  return <div className="code-block"><button aria-label={t("코드 복사")} onClick={() => { void copyText(ref.current?.textContent || '').then(success => { setCopied(success); window.setTimeout(() => setCopied(false), 1500); }); }}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? t("복사됨") : t("복사")}</button><pre {...props} ref={ref}>{children}</pre></div>;
}
const Markdown = memo(function Markdown({ children }: { children: string }) {
  useI18n();
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock, a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener">{children}</a>, img: ({ alt }) => <span className="attachment-label">{t("[이미지:")}{' '}{alt || t("첨부 파일")}]</span> }}>{children}</ReactMarkdown></div>;
});

export const Message = memo(function Message({ message, runMatch }: { message: ChatMessage; runMatch?: ChatRunMatch }) {
  useI18n();
  const [expanded, setExpanded] = useState(false);
  if (message.role === 'tool' || message.role === 'system') return <details className={`tool-message ${message.isError ? 'tool-error' : ''}`} open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}><summary><Terminal size={13} /><strong>{message.toolName || (message.role === 'system' ? t("세션 정보") : t("도구 실행"))}</strong><span>{cleanPreview(message.text, 110)}</span><ChevronDown size={13} /></summary>{expanded && <div><Markdown>{message.text}</Markdown></div>}</details>;
  const text = runMatch?.text ?? message.text;
  const long = message.role === 'user' && text.length > 2400;
  return <article className={`chat-message ${message.role} ${message.isError ? 'message-error' : ''}`}>
    <div className="message-meta"><span>{message.role === 'user' ? t("나") : t("에이전트")}</span><time dateTime={message.timestamp}>{absoluteTime(message.timestamp)}</time></div>
    <div className="message-content">{text && <div className={long && !expanded ? 'message-truncated' : undefined}><Markdown>{long && !expanded ? `${text.slice(0, 2100)}…` : text}</Markdown></div>}{!!runMatch?.attachments?.length && <SavedAttachments attachments={runMatch.attachments} />}</div>
    {long && <button className="text-button message-expand" onClick={() => setExpanded(!expanded)}>{expanded ? t("간략히 보기") : t("메시지 전체 보기")}<ChevronDown size={12} className={expanded ? 'rotate' : ''} /></button>}
  </article>;
});

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

export const RunControl = memo(function RunControl({ run, onCancel, onRetry, cancelling, onDismiss, dismissing = false, disabled = false, retryDisabled = false, showPrompt = true }: { run: Run; onCancel: (id: string) => void; onRetry: (run: Run) => void; cancelling: boolean; onDismiss?: (id: string) => void; dismissing?: boolean; disabled?: boolean; retryDisabled?: boolean; showPrompt?: boolean }) {
  useI18n();
  if (run.status === 'completed' || run.status === 'cancelled') return null;
  const active = run.status === 'running' || run.status === 'queued';
  const preview = run.prompt || (run.attachments?.length ? run.attachments.map(file => file.name).join(', ') : t("보낸 요청"));
  return <div data-run-id={run.id} className={`run-control ${run.status}`}>
    <div className="run-control-line">
      {active ? <LoaderCircle className="spin" size={12} aria-hidden="true" /> : <TriangleAlert size={12} aria-hidden="true" />}
      <strong>{run.status === 'queued' ? t("전송 대기 중") : run.status === 'running' ? t("작업 중") : t("요청 실패")}</strong>
      {showPrompt && <span className="run-control-preview" title={preview}>{cleanPreview(preview, 140)}</span>}
      <div className="run-control-actions">
        {active && <button type="button" disabled={disabled || cancelling} onClick={() => onCancel(run.id)}><Square size={10} aria-hidden="true" />{cancelling ? t("취소 중…") : run.status === 'queued' ? t("대기 취소") : t("중지")}</button>}
        {run.status === 'error' && <><button type="button" aria-label={t("요청 다시 작성")} disabled={disabled || retryDisabled} onClick={() => onRetry(run)}><RefreshCw size={11} aria-hidden="true" />{t("다시 작성")}</button>{onDismiss && <button type="button" aria-label={t("실패 내역 지우기")} disabled={disabled || dismissing} onClick={() => onDismiss(run.id)}>{dismissing ? <LoaderCircle className="spin" size={11} aria-hidden="true" /> : <Trash2 size={11} aria-hidden="true" />}{t("지우기")}</button>}</>}
      </div>
    </div>
    {run.status === 'error' && run.error && <p className="run-control-error">{translateMessage(run.error)}</p>}
  </div>;
});

export function ChatPanel({ sessionId, session, allSessions, provider, runs, token, connected, onClose, onNavigate, onSnapshotRefresh, onSessionUpdate, onSessionClose, sessionClosed = false, changingClosed = false, readRevision = '', onRead }: { sessionId: string; session?: Session; allSessions: Session[]; provider?: ProviderHealth; runs: Run[]; token: string; connected: boolean; onClose: () => void; onNavigate: (id: string) => void; onSnapshotRefresh: () => void; onSessionUpdate: (session: Session) => void; onSessionClose?: () => void; sessionClosed?: boolean; changingClosed?: boolean; readRevision?: string; onRead?: (id: string, revision: string) => void }) {
  useI18n();
  const [detail, setDetail] = useState<ChatHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const subscribe = useCallback((listener: () => void) => subscribeComposer(sessionId, listener), [sessionId]);
  const readComposer = useCallback(() => getComposerState(sessionId), [sessionId]);
  const { draft, stage, error: sendError } = useSyncExternalStore(subscribe, readComposer, readComposer);
  const { prompt, attachments } = draft;
  const sending = !!stage;
  const setSendError = useCallback((error: string) => setComposerError(sessionId, error), [sessionId]);
  const [dragging, setDragging] = useState(false);
  const [cancelling, setCancelling] = useState('');
  const [dismissing, setDismissing] = useState('');
  const [copied, setCopied] = useState(false);
  const [following, setFollowing] = useState(true);
  const [showMetadata, setShowMetadata] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === 'visible');
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const followRef = useRef(true);
  const sessionRef = useRef(sessionId);
  const latestRun = runs[0];
  const refreshKey = `${session?.updatedAt}:${session?.messageCount}:${latestRun?.status}`;

  useLayoutEffect(() => {
    sessionRef.current = sessionId;
    setDetail(null); setLoading(true); setLoadError(''); setShowMetadata(false);
    setDragging(false);
    followRef.current = true; setFollowing(true);
  }, [sessionId]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timeout: number | undefined;
    const read = () => {
      void api<SessionDetail>(`/api/sessions/${encodeURIComponent(sessionId)}?limit=100`, { signal: controller.signal }).then(next => {
        if (controller.signal.aborted) return;
        setDetail(previous => mergeLatestPage(previous, next));
        setLoading(false); setLoadError('');
      }).catch(error => {
        if (controller.signal.aborted) return;
        setLoadError(error instanceof Error ? error.message : t("대화 기록을 읽지 못했습니다.")); setLoading(false);
      });
    };
    timeout = window.setTimeout(read, detail?.session.id === sessionId ? 450 : 0);
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [sessionId, refreshKey, retry]);

  useLayoutEffect(() => {
    if (followRef.current && scroller.current && !loadingOlder) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [detail?.messages, runs, loadingOlder]);

  useEffect(() => {
    const updateVisibility = () => setPageVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', updateVisibility);
    return () => document.removeEventListener('visibilitychange', updateVisibility);
  }, []);

  useEffect(() => {
    if (!onRead || !readRevision || !pageVisible || !following || loading || loadError || !detail || detail.session.id !== sessionId) return;
    // A selected panel may still be showing an older page while its fetch is
    // pending. Acknowledge only content that reached the latest visible view.
    if (session && (detail.session.messageCount !== session.messageCount || detail.session.lastMessage !== session.lastMessage)) return;
    const frame = requestAnimationFrame(() => onRead(sessionId, readRevision));
    return () => cancelAnimationFrame(frame);
  }, [detail, following, loadError, loading, onRead, pageVisible, readRevision, session, sessionId]);

  const current = session || detail?.session;
  const currentRuns = useMemo(() => runs.filter(run => run.sessionId === sessionId), [runs, sessionId]);
  const controlRuns = useMemo(() => currentRuns.filter(run => run.status === 'running' || run.status === 'queued' || run.status === 'error'), [currentRuns]);
  const runProjection = useMemo(() => matchChatRuns(detail?.messages || emptyMessages, currentRuns, sessionId), [detail?.messages, currentRuns, sessionId]);
  const scrollToBottom = useCallback(() => { followRef.current = true; setFollowing(true); scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' }); }, []);

  async function loadOlder() {
    if (!detail?.hasMore || detail.nextBefore === undefined || loadingOlder) return;
    setLoadingOlder(true);
    const oldHeight = scroller.current?.scrollHeight || 0;
    const oldTop = scroller.current?.scrollTop || 0;
    const id = sessionId;
    const requestedBefore = detail.nextBefore;
    try {
      const older = await api<SessionDetail>(`/api/sessions/${encodeURIComponent(sessionId)}?limit=100&before=${requestedBefore}`);
      if (sessionRef.current !== id) return;
      followRef.current = false; setFollowing(false);
      setDetail(previous => prependOlderPage(previous, older, requestedBefore));
      requestAnimationFrame(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight - oldHeight + oldTop; });
    } catch (error) { setLoadError(error instanceof Error ? error.message : t("이전 대화를 불러오지 못했습니다.")); }
    finally { setLoadingOlder(false); }
  }

  function updateDraft(next: ChatDraft) {
    setComposerDraft(sessionId, next);
  }

  function addFiles(files: File[]) {
    if (!files.length || disabled || getComposerState(sessionId).stage) return;
    try {
      const currentDraft = getComposerState(sessionId).draft;
      updateDraft({ ...currentDraft, attachments: addDraftFiles(currentDraft.attachments, files) });
      setSendError('');
    } catch (error) { setSendError(error instanceof Error ? error.message : t("파일을 첨부하지 못했습니다.")); }
  }

  async function sendPrompt() {
    const id = sessionId;
    const candidate = getComposerState(id).draft;
    const message = candidate.prompt.trim();
    if ((!message && !candidate.attachments.length) || !token || !connected || !current?.resumable || !provider?.available) return;
    const submitted = startComposerSend(id);
    if (!submitted) return;
    try {
      const prepared = await prepareDraftAttachments(submitted.attachments);
      markComposerSending(id);
      await api<{ run: Run }>(`/api/sessions/${encodeURIComponent(id)}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token }, body: JSON.stringify({ prompt: message, ...prepared, ...(submitted.model ? { model: submitted.model } : {}) }) });
      finishComposerSend(id, submitted);
      if (mounted.current && sessionRef.current === id) { followRef.current = true; setFollowing(true); }
      onSnapshotRefresh();
    } catch (error) { finishComposerSend(id, submitted, error instanceof Error ? error.message : t("요청을 보내지 못했습니다.")); }
  }

  const cancelRun = useCallback(async (id: string) => {
    if (!token || !connected) return;
    setCancelling(id); setSendError('');
    try { await api(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token }, body: '{}' }); onSnapshotRefresh(); }
    catch (error) { setSendError(error instanceof Error ? error.message : t("작업을 중지하지 못했습니다.")); }
    finally { setCancelling(''); }
  }, [connected, onSnapshotRefresh, setSendError, token]);
  const dismissRun = useCallback(async (id: string) => {
    if (!token || !connected) return;
    const requestedSession = sessionRef.current;
    setDismissing(id); setSendError('');
    try {
      await api(`/api/runs/${encodeURIComponent(id)}/dismiss`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token }, body: '{}' });
      onSnapshotRefresh();
    } catch (error) { if (sessionRef.current === requestedSession) setSendError(error instanceof Error ? error.message : t("실패 내역을 지우지 못했습니다.")); }
    finally { setDismissing(''); }
  }, [connected, onSnapshotRefresh, setSendError, token]);
  const retryPrompt = useCallback((run: Run) => {
    if (getComposerState(sessionId).stage) return;
    const next = draftFromRun(run);
    setComposerDraft(sessionId, next); setComposerError(sessionId, ''); composer.current?.focus();
  }, [sessionId]);

  let composerHint: ReactNode = <><kbd>⌘</kbd><kbd>Enter</kbd><span>{t("전송")}</span></>;
  if (!connected) composerHint = t("서버에 다시 연결되면 요청을 보낼 수 있습니다.");
  else if (current?.creationPending) composerHint = t("새 세션을 시작하고 있습니다.");
  else if (current && !current.resumable) composerHint = t("이 세션은 대화 기록만 확인할 수 있습니다.");
  else if (provider && !provider.available) composerHint = t("{0} CLI를 설치하면 이어서 작업할 수 있습니다.", { 0: current ? providerLabels[current.provider] : t("에이전트") });
  else if (!token) composerHint = t("연결을 준비하는 중…");
  const disabled = !connected || !current?.resumable || !provider?.available || !token;
  const sendingLabel = stage === 'preparing' ? t("파일 준비 중") : t("보내는 중");

  return <aside className="chat-panel" aria-label={t("세션 대화")} onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) onClose(); }}>
    <header className="chat-header"><div className="chat-heading-line"><button className="icon-button mobile-back" onClick={onClose} aria-label={t("그래프로 돌아가기")}><ChevronLeft size={20} /></button>{current && <span className={`provider-square ${current.provider} ${current.status}`}><ProviderIcon provider={current.provider} /></span>}<span>{current ? providerLabels[current.provider] : t("세션 대화")}</span>{current && <span className={`status-badge ${current.status}`} title={translateMessage(current.statusReason)}><i />{statusLabels[current.status]}</span>}{onSessionClose && <button className="icon-button session-close-button" aria-label={sessionClosed ? t("세션 다시 열기") : t("세션 종료")} title={sessionClosed ? t("그래프에 다시 표시") : t("그래프에서 숨기기 · 실행 중인 작업은 계속됩니다")} disabled={changingClosed || !connected || !token} onClick={() => { setSendError(''); void Promise.resolve(onSessionClose()).catch(error => setSendError(error instanceof Error ? error.message : t("세션 상태를 저장하지 못했습니다."))); }}>{changingClosed ? <LoaderCircle className="spin" size={15} /> : sessionClosed ? <ArchiveRestore size={16} /> : <Archive size={16} />}</button>}<button className="icon-button close-chat" onClick={onClose} aria-label={t("대화 닫기")} title={t("닫기 (Esc)")}><X size={18} /></button></div>{current ? <SessionTitleEditor key={current.id} session={current} token={token} connected={connected} onSaved={updated => { onSessionUpdate(updated); setDetail(previous => previous ? { ...previous, session: { ...previous.session, customTitle: updated.customTitle } } : previous); onSnapshotRefresh(); }} /> : <h2>{t("대화 불러오는 중")}</h2>}<div className="chat-context-row"><button className="chat-project" onClick={() => setShowMetadata(!showMetadata)} aria-expanded={showMetadata}><Folder size={12} /><span className="folder-tail" title={current?.cwd || current?.project || t("세션 정보")}><bdi dir="ltr">{current?.project || t("세션 정보")}</bdi></span>{current?.isSubagent && <><GitBranch size={12} /><span>{t("하위 에이전트")}</span></>}<ChevronDown size={12} className={showMetadata ? 'rotate' : ''} /></button><SessionFamilyNav sessions={allSessions} selectedId={sessionId} onNavigate={onNavigate} /></div>{showMetadata && current && <dl className="session-metadata"><div><dt>{t("작업 폴더")}</dt><dd>{current.cwd || t("정보 없음")}</dd></div>{current.model && <div><dt>{t("모델")}</dt><dd>{current.model}</dd></div>}<div><dt>{t("세션 ID")}</dt><dd>{current.nativeId}<button className="icon-button" title={t("세션 ID 복사")} aria-label={t("세션 ID 복사")} onClick={() => { void copyText(current.nativeId).then(success => { setCopied(success); window.setTimeout(() => setCopied(false), 1500); }); }}>{copied ? <Check size={12} /> : <Copy size={12} />}</button></dd></div><div><dt>{t("상태 판단")}</dt><dd>{translateMessage(current.statusReason)}</dd></div><div><dt>{t("시작")}</dt><dd>{absoluteTime(current.createdAt)}</dd></div></dl>}</header>
    <div className="chat-scroll" ref={scroller} onScroll={() => { const el = scroller.current; if (!el) return; const near = el.scrollHeight - el.scrollTop - el.clientHeight < 100; followRef.current = near; setFollowing(near); }}>
      {loading && !detail ? <div className="chat-loading"><LoaderCircle className="spin" size={22} /><span>{t("대화 기록을 불러오는 중")}</span></div> : <>
        {loadError && <div className="chat-load-error"><TriangleAlert size={18} /><p>{translateMessage(loadError)}</p><button className="secondary-button" onClick={() => setRetry(value => value + 1)}><RefreshCw size={13} />{t("다시 불러오기")}</button></div>}
        {detail?.hasMore && <button className="load-older" onClick={() => { void loadOlder(); }} disabled={loadingOlder}>{loadingOlder ? <LoaderCircle className="spin" size={13} /> : <ArrowUp size={13} />}{loadingOlder ? t("불러오는 중…") : t("이전 대화 불러오기")}</button>}
        {detail?.resetToLatest && <p className="muted" role="status">{t("대화가 갱신되어 최근 내용부터 표시합니다.")}{detail.hasMore && t(" 앞선 내용은 ‘이전 대화 불러오기’에서 확인할 수 있습니다.")}</p>}
        {detail && !detail.hasMore && detail.messages.length > 0 && <div className="conversation-start"><span>{t("세션 시작")}</span><time>{absoluteTime(detail.session.createdAt)}</time></div>}
        {detail && <ChatTranscript key={sessionId} messages={detail.messages} runMatches={runProjection.matches} />}
        {detail && detail.messages.length === 0 && !loadError && <div className="empty-chat"><MessageSquare size={27} /><h3>{t("대화가 시작될 자리")}</h3><p>{t("이 세션에 첫 요청을 보내거나")}<br />{t("에이전트의 활동을 기다리세요.")}</p></div>}
      </>}
    </div>
    {!following && <button className="jump-latest" onClick={scrollToBottom}><ArrowDown size={13} />{t("최신 대화")}</button>}
    <div className="composer-section">
      {current?.resumable === false && current.parentId && <button className="parent-session-link" onClick={() => onNavigate(current.parentId!)}><GitBranch size={14} /><span>{t("부모 세션에서 이어가기")}</span><ArrowUp size={13} /></button>}
      {sendError && <div className="inline-error" role="alert"><TriangleAlert size={15} /><span>{translateMessage(sendError)}</span><button aria-label={t("오류 메시지 닫기")} onClick={() => setSendError('')}><X size={13} /></button></div>}
      {controlRuns.length > 0 && <div className="run-controls" aria-label={t("진행 중이거나 실패한 요청")}>{controlRuns.map(run => <RunControl key={run.id} run={run} onCancel={cancelRun} onRetry={retryPrompt} onDismiss={dismissRun} cancelling={cancelling === run.id} dismissing={dismissing === run.id} disabled={!connected || !token || !!cancelling || !!dismissing} retryDisabled={disabled || sending} showPrompt={!runProjection.matchedRunIds.has(run.id)} />)}</div>}
      <form className={`composer ${disabled ? 'disabled' : ''} ${dragging ? 'composer-dragging' : ''}`} onSubmit={event => { event.preventDefault(); void sendPrompt(); }}
        onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = disabled || sending ? 'none' : 'copy'; if (!disabled && !sending) setDragging(true); } }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); addFiles(Array.from(event.dataTransfer.files)); } setDragging(false); }}>
        <input ref={fileInput} className="attachment-file-input" type="file" multiple aria-label={t("첨부할 파일 선택")} disabled={disabled || sending} onChange={event => { addFiles(Array.from(event.currentTarget.files || [])); event.currentTarget.value = ''; }} />
        {!!attachments.length && <DraftAttachments attachments={attachments} disabled={disabled || sending} onRemove={key => updateDraft({ ...draft, attachments: attachments.filter(file => file.key !== key) })} />}
        {dragging && <div className="attachment-drop-hint" aria-live="polite"><Paperclip size={14} />{t("파일을 놓아 첨부하기")}</div>}
        <textarea ref={composer} aria-label={t("에이전트에게 보낼 요청")} placeholder={current?.resumable === false ? t("이 세션은 읽기 전용입니다") : t("이 세션에서 이어서 작업하기…")} value={prompt} disabled={disabled || sending} rows={3} maxLength={32000}
          onChange={event => updateDraft({ ...getComposerState(sessionId).draft, prompt: event.target.value })}
          onPaste={event => {
            const files = Array.from(event.clipboardData.files);
            if (!files.length) return;
            // A clipboard can contain both image bytes and ordinary text; retain the text paste.
            if (!event.clipboardData.getData('text/plain')) event.preventDefault();
            addFiles(files);
          }}
          onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void sendPrompt(); } }} />
        <div className="composer-bottom">
          <button className="attach-button" type="button" aria-label={t("파일 첨부")} title={t("파일 첨부 · 최대 {0}개, 합계 {1} · 이미지 붙여넣기 가능", { 0: MAX_ATTACHMENTS, 1: formatAttachmentSize(MAX_TOTAL_ATTACHMENT_BYTES) })} disabled={disabled || sending} onClick={() => fileInput.current?.click()}><Paperclip size={16} aria-hidden="true" /></button>
          <span className="composer-hint">{sending ? <span role="status">{sendingLabel}…</span> : prompt.length > 24000 ? t("{0} / 32,000자", { 0: prompt.length.toLocaleString() }) : composerHint}</span>
          <ModelPicker provider={provider} observedModel={current?.model} value={draft.model} disabled={disabled || sending} onChange={model => updateDraft({ ...getComposerState(sessionId).draft, model })} />
          <button className="send-button" type="submit" disabled={disabled || (!prompt.trim() && !attachments.length) || sending} aria-label={sending ? t("요청 보내는 중") : t("요청 보내기")}>{sending ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}<span>{sending ? sendingLabel : t("보내기")}</span></button>
        </div>
      </form>
      <p className="composer-note"><Terminal size={11} />{t("이 기기의 {0}에서 기존 대화를 이어갑니다.", { 0: current ? providerLabels[current.provider] : t("에이전트") })}</p>
    </div>
  </aside>;
}
