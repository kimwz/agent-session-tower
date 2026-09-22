import { translate as t, translateMessage, useI18n } from '../i18n/i18n';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Check, ChevronDown, Copy, Folder, GitBranch, LoaderCircle, MessageSquare, Paperclip, RefreshCw, Send, Terminal, TriangleAlert, X } from 'lucide-react';
import type { ChatMessage, ProviderHealth, Run, Session, SessionDetail } from '../../../shared/types';
import { ProviderIcon } from '../common/Icons';
import { WorkspaceActions } from '../workspace/WorkspaceActions';
import { SessionTitleEditor } from '../sessions/SessionTitleEditor';
import { SessionFamilyNav } from '../sessions/SessionFamilyNav';
import { ResumeCommandButton } from '../sessions/ResumeCommandButton';
import { resumeCommand } from '../sessions/resume-command';
import { absoluteTime, api, copyText, providerLabels, statusLabels } from '../common/lib';
import { mergeLatestPage, prependOlderPage, type ChatHistory } from './chat-history';
import { ChatTranscript } from './ChatTranscript';
import { RunControl } from './RunControl';
import { DraftAttachments } from './ChatAttachments';
import { addDraftFiles, formatAttachmentSize, prepareDraftAttachments } from './chat-attachments';
import { MAX_ATTACHMENTS, MAX_TOTAL_ATTACHMENT_BYTES } from '../../../shared/attachments';
import { draftFromRun, finishComposerSend, getComposerState, markComposerSending, setComposerDraft, setComposerError, startComposerSend, subscribeComposer, type ChatDraft } from './chat-drafts';
import { matchChatRuns } from './chat-runs';
import { ModelPicker } from './ModelPicker';
import { useChatAppearance } from './chat-appearance';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';

const emptyMessages: readonly ChatMessage[] = [];

export function ChatPanel({ sessionId, session, allSessions, provider, runs, token, connected, onClose, onNavigate, onSnapshotRefresh, onSessionUpdate, onSessionClose, sessionClosed = false, changingClosed = false, readRevision = '', onRead, contextBanner }: { contextBanner?: ReactNode; sessionId: string; session?: Session; allSessions: Session[]; provider?: ProviderHealth; runs: Run[]; token: string; connected: boolean; onClose: () => void; onNavigate: (id: string) => void; onSnapshotRefresh: () => void; onSessionUpdate: (session: Session) => void; onSessionClose?: () => void; sessionClosed?: boolean; changingClosed?: boolean; readRevision?: string; onRead?: (id: string, revision: string) => void }) {
  useI18n();
  const appearance = useChatAppearance();
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
  const [steering, setSteering] = useState('');
  const [copied, setCopied] = useState(false);
  const [following, setFollowing] = useState(true);
  const [showMetadata, setShowMetadata] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === 'visible');
  const scroller = useRef<HTMLDivElement>(null);
  const runControls = useRef<HTMLDivElement>(null);
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
  }, [detail?.messages, runs, loadingOlder, appearance.fontSize, appearance.width]);

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
  const controlRuns = useMemo(() => currentRuns.filter(run => run.status === 'running' || run.status === 'queued' || run.status === 'error').sort((a, b) => Number(!!b.approvals?.length) - Number(!!a.approvals?.length)), [currentRuns]);
  const approvalKey = controlRuns.flatMap(run => run.status === 'error' ? [] : run.approvals?.map(approval => `${run.id}:${approval.id}`) || []).join('|');
  useLayoutEffect(() => { if (approvalKey && runControls.current) runControls.current.scrollTop = 0; }, [approvalKey]);
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
      await api<{ run: Run }>(`/api/sessions/${encodeURIComponent(id)}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token }, body: JSON.stringify({ prompt: message, ...prepared, ...(submitted.model ? { model: submitted.model } : {}) }) });
      finishComposerSend(id, submitted);
      if (mounted.current && sessionRef.current === id) { followRef.current = true; setFollowing(true); }
      onSnapshotRefresh();
    } catch (error) { finishComposerSend(id, submitted, error instanceof Error ? error.message : t("요청을 보내지 못했습니다.")); }
  }

  const cancelRun = useCallback(async (id: string) => {
    if (!token || !connected) return;
    setCancelling(id); setSendError('');
    try { await api(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token }, body: '{}' }); onSnapshotRefresh(); }
    catch (error) { setSendError(error instanceof Error ? error.message : t("작업을 중지하지 못했습니다.")); }
    finally { setCancelling(''); }
  }, [connected, onSnapshotRefresh, setSendError, token]);
  const steerRun = useCallback(async (id: string) => {
    if (!token || !connected) return;
    const requestedSession = sessionRef.current;
    setSteering(id); setSendError('');
    try {
      await api(`/api/runs/${encodeURIComponent(id)}/steer`, { method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token }, body: '{}' });
      onSnapshotRefresh();
    } catch (error) {
      if (sessionRef.current === requestedSession) setSendError(error instanceof Error ? error.message : t("요청을 끼워넣지 못했습니다."));
      onSnapshotRefresh();
    } finally { setSteering(''); }
  }, [connected, onSnapshotRefresh, setSendError, token]);
  const dismissRun = useCallback(async (id: string) => {
    if (!token || !connected) return;
    const requestedSession = sessionRef.current;
    setDismissing(id); setSendError('');
    try {
      await api(`/api/runs/${encodeURIComponent(id)}/dismiss`, { method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token }, body: '{}' });
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

  return <><div className="chat-panel-spacer" aria-hidden="true" style={{ width: appearance.width, flexBasis: appearance.width }} /><aside className="chat-panel" style={{ '--chat-font-size': `${appearance.fontSize}px`, '--chat-width': `${appearance.width}px` } as CSSProperties} aria-label={t("세션 대화")}>
    <div className="chat-resize-handle" role="separator" tabIndex={0} aria-label={t("대화창 너비 조절")} aria-orientation="vertical" aria-valuemin={320} aria-valuemax={appearance.maxWidth} aria-valuenow={appearance.width}
      onPointerDown={appearance.startResize} onPointerMove={appearance.resize} onPointerUp={appearance.stopResize} onPointerCancel={appearance.stopResize} onLostPointerCapture={appearance.stopResize}
      onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); appearance.changeWidth(appearance.width + (event.key === 'ArrowLeft' ? 20 : -20)); } }} />
    <header className="chat-header">
      <div className="chat-heading-line">
        {current && <span className={`provider-square ${current.provider} ${current.status}`} role="img" aria-label={providerLabels[current.provider]} title={providerLabels[current.provider]}><ProviderIcon provider={current.provider} /></span>}
        {current ? <SessionTitleEditor key={current.id} session={current} token={token} connected={connected} onSaved={updated => { onSessionUpdate(updated); setDetail(previous => previous ? { ...previous, session: { ...previous.session, customTitle: updated.customTitle } } : previous); onSnapshotRefresh(); }} /> : <h2 className="chat-loading-title">{t("대화 불러오는 중")}</h2>}
        <div className="chat-header-actions">
          {onSessionClose && <button className="icon-button session-close-button" aria-label={sessionClosed ? t("세션 다시 열기") : t("세션 종료")} title={sessionClosed ? t("그래프에 다시 표시") : t("그래프에서 숨기기 · 실행 중인 작업은 계속됩니다")} disabled={changingClosed || !connected || !token} onClick={() => { setSendError(''); void Promise.resolve(onSessionClose()).catch(error => setSendError(error instanceof Error ? error.message : t("세션 상태를 저장하지 못했습니다."))); }}>{changingClosed ? <LoaderCircle className="spin" size={15} /> : sessionClosed ? <ArchiveRestore size={16} /> : <Archive size={16} />}</button>}
          <button className="icon-button close-chat" onClick={onClose} aria-label={t("대화 닫기")} title={t("닫기 (Esc)")}><X size={18} /></button>
        </div>
      </div>
      <div className="chat-context-row">
        {current && <span className={`status-badge ${current.status}`} title={translateMessage(current.statusReason)}><i />{statusLabels[current.status]}</span>}
        <button className="chat-project" onClick={() => setShowMetadata(!showMetadata)} aria-expanded={showMetadata}><Folder size={12} /><span className="folder-tail" title={current?.cwd || current?.project || t("세션 정보")}><bdi dir="ltr">{current?.project || t("세션 정보")}</bdi></span><ChevronDown size={12} className={showMetadata ? 'rotate' : ''} /></button>
        {current?.cwd && <WorkspaceActions key={current.cwd} cwd={current.cwd} token={token} disabled={!connected} />}
        <SessionFamilyNav sessions={allSessions} selectedId={sessionId} onNavigate={onNavigate} />
      </div>
      {showMetadata && current && <dl className="session-metadata"><div><dt>{t("작업 폴더")}</dt><dd>{current.cwd || t("정보 없음")}</dd></div>{current.model && <div><dt>{t("모델")}</dt><dd>{current.model}</dd></div>}<div><dt>{t("세션 ID")}</dt><dd>{current.nativeId}<button className="icon-button" title={t("세션 ID 복사")} aria-label={t("세션 ID 복사")} onClick={() => { void copyText(current.nativeId).then(success => { setCopied(success); window.setTimeout(() => setCopied(false), 1500); }); }}>{copied ? <Check size={12} /> : <Copy size={12} />}</button></dd></div>{resumeCommand(current) && <div><dt>{t("터미널")}</dt><dd><code className="resume-command">{resumeCommand(current)}</code><ResumeCommandButton session={current} size={12} /></dd></div>}<div><dt>{t("상태 판단")}</dt><dd>{translateMessage(current.statusReason)}</dd></div><div><dt>{t("시작")}</dt><dd>{absoluteTime(current.createdAt)}</dd></div></dl>}
      {contextBanner}
    </header>
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
      {controlRuns.length > 0 && <div ref={runControls} className={`run-controls${approvalKey ? ' has-approvals' : ''}`} aria-label={t("진행 중이거나 실패한 요청")}>{controlRuns.map(run => <RunControl key={run.id} run={run} onCancel={cancelRun} onRetry={retryPrompt} onDismiss={dismissRun} onSteer={steerRun} steering={steering === run.id} cancelling={cancelling === run.id} dismissing={dismissing === run.id} disabled={!connected || !token || !!cancelling || !!dismissing || !!steering} retryDisabled={disabled || sending} showPrompt={!runProjection.matchedRunIds.has(run.id)} token={token} onSnapshotRefresh={onSnapshotRefresh} />)}</div>}
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
  </aside></>;
}
