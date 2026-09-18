import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Folder, LoaderCircle, Paperclip, Send, Sparkles, Square, TriangleAlert, X } from 'lucide-react';
import type { AutoPromptJob, Provider, ProviderHealth, Session } from '../../../shared/types';
import { MAX_ATTACHMENTS, MAX_TOTAL_ATTACHMENT_BYTES } from '../../../shared/attachments';
import { DraftAttachments } from '../chat/ChatAttachments';
import { ProviderIcon } from '../common/Icons';
import { addDraftFiles, formatAttachmentSize, prepareDraftAttachments, type DraftAttachment } from '../chat/chat-attachments';
import { autoPromptPending, createAutoPromptAttempt, newerAutoPromptJob, type AutoPromptAttempt } from './auto-prompt-request';
import { api, providerLabels, sessionTitle } from '../common/lib';
import { translate as t, translateMessage, useI18n } from '../i18n/i18n';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { codexApprovalsRequest, readCodexApprovalsChoice } from '../sessions/codex-approvals-preference';

interface AutoPromptDialogProps {
  visible: boolean;
  initialCwd?: string;
  providers: ProviderHealth[];
  projects: Array<[string, string]>;
  sessions: Session[];
  jobs: AutoPromptJob[];
  token: string;
  connected: boolean;
  onClose: () => void;
  onNavigate: (id: string) => void;
  onRefresh: () => void;
}

function progressLabel(job: AutoPromptJob) {
  if (job.status === 'queued') return t('요청을 준비하고 있습니다…');
  if (job.status === 'dispatching') return t('선택한 세션에 요청을 보내고 있습니다…');
  if (job.stage === 'directory') return t('작업할 폴더를 찾고 있습니다…');
  if (job.stage === 'session') return t('작업할 세션을 찾고 있습니다…');
  return t('작업할 폴더와 세션을 찾고 있습니다…');
}

/** Stays mounted while hidden so an admitted request can never become a fresh submission. */
export function AutoPromptDialog({ visible, initialCwd, providers, projects, sessions, jobs, token, connected, onClose, onNavigate, onRefresh }: AutoPromptDialogProps) {
  useI18n();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const attempt = useRef<AutoPromptAttempt | undefined>(undefined);
  const currentJob = useRef<AutoPromptJob | undefined>(undefined);
  const seenTerminalId = useRef('');
  const sending = useRef(false);
  const generation = useRef(0);
  const [provider, setProvider] = useState<Provider>('claude');
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [attemptId, setAttemptId] = useState('');
  const [job, setJob] = useState<AutoPromptJob>();
  const [preparing, setPreparing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const pending = !!job && autoPromptPending(job);
  const locked = !!attemptId || preparing || submitting;
  const providerAvailable = providers.some(item => item.provider === provider && item.available);
  const unavailable = !connected || !token || !providerAvailable;

  const receiveJob = useCallback((incoming: AutoPromptJob) => {
    if (incoming.id !== attempt.current?.id) return;
    const previous = currentJob.current;
    const next = newerAutoPromptJob(previous, incoming);
    currentJob.current = next;
    setJob(next);
    setUncertain(false);
    if (!autoPromptPending(next)) { sending.current = false; setSubmitting(false); }
    if (!previous || next.status !== previous.status || next.updatedAt !== previous.updatedAt) setError('');
  }, []);

  function resetRequest(clearPrompt = false) {
    generation.current++;
    sending.current = false;
    attempt.current = undefined;
    currentJob.current = undefined;
    seenTerminalId.current = '';
    setAttemptId(''); setJob(undefined); setError(''); setUncertain(false);
    if (clearPrompt) { setPrompt(''); setAttachments([]); }
  }

  // Defaults are applied only when opening a fresh dialog, never to an unresolved request.
  const opening = useRef({ initialCwd, providers });
  opening.current = { initialCwd, providers };
  useEffect(() => {
    const element = dialog.current;
    if (!visible || !element) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (currentJob.current && !autoPromptPending(currentJob.current) && seenTerminalId.current === currentJob.current.id && !sending.current) {
      generation.current++;
      attempt.current = undefined; currentJob.current = undefined;
      seenTerminalId.current = '';
      setAttemptId(''); setJob(undefined); setError(''); setUncertain(false);
      setPrompt(''); setAttachments([]);
    }
    if (!attempt.current && !sending.current) {
      setCwd(opening.current.initialCwd || '');
      setProvider(opening.current.providers.find(item => item.available)?.provider || 'claude');
    }
    element.showModal();
    if (attempt.current) element.focus();
    return () => {
      element.close();
      setDragging(false);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [visible]);

  // Focus follows the committed unlocked state, including reopening after a
  // handled result. A frame scheduled while clearing state can still run early.
  useEffect(() => {
    if (visible && !locked && dialog.current?.open) composer.current?.focus({ preventScroll: true });
  }, [visible, locked]);

  // Errors/cancellations stay available until seen. Successful dispatches are
  // consumed once even while hidden, independently of lagging session metadata.
  useEffect(() => {
    if (!job) return;
    const sessionId = attempt.current?.takeCompletedSession(job);
    if (!sessionId) return;
    seenTerminalId.current = job.id;
    onClose();
    onNavigate(sessionId);
  }, [job, onClose, onNavigate]);

  useEffect(() => {
    if (visible && job && !autoPromptPending(job) && currentJob.current?.id === job.id) seenTerminalId.current = job.id;
  }, [visible, job]);

  useEffect(() => {
    const incoming = jobs.find(item => item.id === attemptId);
    if (incoming) receiveJob(incoming);
  }, [attemptId, jobs, receiveJob]);

  // SSE is the primary feed; polling also recovers a lost POST response or reconnection.
  useEffect(() => {
    if (!attemptId || (job && !autoPromptPending(job))) return;
    let stopped = false;
    let timer: number;
    async function check() {
      try {
        const result = await api<{ job: AutoPromptJob }>(`/api/auto-prompts/${encodeURIComponent(attemptId)}`);
        if (!stopped) receiveJob(result.job);
      } catch { /* Keep the same request available for explicit retry if admission is unknown. */ }
      if (!stopped) timer = window.setTimeout(() => { void check(); }, 2500);
    }
    void check();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [attemptId, job?.status, receiveJob]);

  function addFiles(files: File[]) {
    if (!files.length || locked || sending.current) return;
    try { setAttachments(addDraftFiles(attachments, files)); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('파일을 첨부하지 못했습니다.')); }
  }

  async function submit() {
    if (sending.current || unavailable || (currentJob.current && autoPromptPending(currentJob.current)) || (job && !uncertain)) return;
    if (!attempt.current && !prompt.trim() && !attachments.length) return;
    sending.current = true;
    const submittedGeneration = generation.current;
    setSubmitting(true); setError('');
    try {
      if (!attempt.current) {
        setPreparing(true);
        const prepared = await prepareDraftAttachments(attachments);
        seenTerminalId.current = '';
        // Auto Prompt has no approval-review control of its own; a Codex session it
        // creates follows the choice last made in the New Session dialog.
        attempt.current = createAutoPromptAttempt({ requestId: crypto.randomUUID(), provider, ...(cwd ? { cwd } : {}), prompt, ...prepared,
          ...codexApprovalsRequest(provider, readCodexApprovalsChoice()) });
        setAttemptId(attempt.current.id);
        setPreparing(false);
      }
      const result = await attempt.current.send(token);
      if (generation.current !== submittedGeneration) return;
      if ('job' in result) {
        receiveJob(result.job);
        onRefresh();
      } else if (!currentJob.current) {
        setUncertain(result.uncertain);
        setError(result.uncertain ? t('요청 접수를 확인하지 못했습니다. 같은 요청을 다시 확인해 주세요.')
          : result.error instanceof Error ? result.error.message : t('요청을 보내지 못했습니다.'));
        if (!result.uncertain) { attempt.current = undefined; setAttemptId(''); }
      }
    } catch (cause) {
      if (generation.current === submittedGeneration) setError(cause instanceof Error ? cause.message : t('파일을 첨부하지 못했습니다.'));
    } finally {
      if (generation.current === submittedGeneration) {
        sending.current = false;
        setPreparing(false); setSubmitting(false);
      }
    }
  }

  async function cancel() {
    if (!job || !['queued', 'routing'].includes(job.status) || cancelling || !connected || !token) return;
    setCancelling(true); setError('');
    try {
      const result = await api<{ job: AutoPromptJob }>(`/api/auto-prompts/${encodeURIComponent(job.id)}/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token }, body: '{}',
      });
      receiveJob(result.job);
      onRefresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('요청 취소를 확인하지 못했습니다.')); }
    finally { setCancelling(false); }
  }

  const choices = new Map(projects.filter(([path]) => path.startsWith('/')));
  if (cwd && !choices.has(cwd)) choices.set(cwd, cwd.split('/').filter(Boolean).at(-1) || cwd);
  const target = sessions.find(session => session.id === job?.sessionId);
  const statusLabel = preparing ? t('첨부 파일 준비 중…') : job && pending ? progressLabel(job) : submitting ? t('요청 접수를 확인하고 있습니다…') : '';
  const connectionMessage = !connected ? t('서버에 다시 연결되면 요청을 보낼 수 있습니다.')
    : !token ? t('연결을 확인하고 있습니다.') : !providerAvailable ? t('{0}를 현재 사용할 수 없습니다.', { 0: providerLabels[provider] }) : '';
  const requestError = error || (job?.status === 'error' ? job.error || t('요청을 보내지 못했습니다.') : '');

  return createPortal(<dialog ref={dialog} className="auto-prompt-dialog" aria-labelledby={`${id}-heading`} aria-describedby={`${id}-description`} tabIndex={-1}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing || event.keyCode === 229) {
        if (event.key === 'Escape' || event.key === 'Enter') event.preventDefault();
        return;
      }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void submit(); }
    }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <header className="auto-prompt-heading"><div><h2 id={`${id}-heading`}><Sparkles size={22} aria-hidden="true" />Auto Prompt</h2><p id={`${id}-description`}>{t('요청에 맞는 폴더와 세션을 찾아 작업을 보냅니다.')}</p></div><button type="button" className="icon-button" aria-label={t('Auto Prompt 창 닫기')} onClick={onClose}><X size={19} /></button></header>
    <div className="auto-prompt-selectors">
      <label className="auto-prompt-directory"><span className="sr-only">{t('작업 폴더')}</span><Folder size={16} aria-hidden="true" /><select aria-label={t('작업 폴더')} title={cwd || 'Auto'} value={cwd} disabled={locked} onChange={event => setCwd(event.target.value)}><option value="">Auto</option>{[...choices].map(([path, label]) => <option key={path} value={path}>{label} · {path}</option>)}</select><ChevronDown size={13} aria-hidden="true" /></label>
      <div className="auto-prompt-providers" role="group" aria-label={t('에이전트 종류')}>
        {(['claude', 'codex'] as const).map(value => {
          const available = providers.some(item => item.provider === value && item.available);
          return <button key={value} type="button" className={`auto-prompt-provider-button ${value}`} aria-label={value === 'claude' ? 'Claude' : 'Codex'} aria-pressed={provider === value} title={available ? providerLabels[value] : t('{0}를 현재 사용할 수 없습니다.', { 0: providerLabels[value] })} disabled={locked || !available} onClick={() => setProvider(value)}><ProviderIcon provider={value} size={24} /></button>;
        })}
      </div>
    </div>
    <form className={`composer auto-prompt-composer ${locked ? 'disabled' : ''} ${dragging ? 'composer-dragging' : ''}`} aria-busy={preparing || submitting || pending} onSubmit={event => { event.preventDefault(); void submit(); }}
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = locked ? 'none' : 'copy'; if (!locked) setDragging(true); } }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); addFiles(Array.from(event.dataTransfer.files)); } setDragging(false); }}>
      <input ref={fileInput} className="attachment-file-input" type="file" multiple aria-label={t('첨부할 파일 선택')} disabled={locked} onChange={event => { addFiles(Array.from(event.currentTarget.files || [])); event.currentTarget.value = ''; }} />
      {!!attachments.length && <DraftAttachments attachments={attachments} disabled={locked} onRemove={key => setAttachments(files => files.filter(file => file.key !== key))} />}
      {dragging && <div className="attachment-drop-hint" aria-live="polite"><Paperclip size={14} />{t('파일을 놓아 첨부하기')}</div>}
      <textarea ref={composer} aria-label={t('에이전트에게 보낼 요청')} placeholder={t('어떤 작업을 할까요? 폴더와 이어갈 세션은 자동으로 찾습니다.')} value={prompt} disabled={locked} rows={8} maxLength={32000} onChange={event => setPrompt(event.target.value)} onPaste={event => {
        const files = Array.from(event.clipboardData.files);
        if (!files.length) return;
        if (!event.clipboardData.getData('text/plain')) event.preventDefault();
        addFiles(files);
      }} />
      <div className="composer-bottom"><button type="button" className="attach-button" aria-label={t('파일 첨부')} title={t('파일 첨부 · 최대 {0}개, 합계 {1} · 이미지 붙여넣기 가능', { 0: MAX_ATTACHMENTS, 1: formatAttachmentSize(MAX_TOTAL_ATTACHMENT_BYTES) })} disabled={locked} onClick={() => fileInput.current?.click()}><Paperclip size={17} aria-hidden="true" /></button><span className="composer-hint">{prompt.length > 24000 ? t('{0} / 32,000자', { 0: prompt.length.toLocaleString() }) : <><kbd>⌘ / Ctrl</kbd><kbd>Enter</kbd><span>{t('전송')}</span></>}</span><button type="submit" className="send-button" disabled={unavailable || locked || (!prompt.trim() && !attachments.length)} aria-label={submitting || pending ? t('요청 보내는 중') : t('요청 보내기')}>{submitting || pending ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}<span>{t('보내기')}</span></button></div>
    </form>
    {statusLabel && <div className="auto-prompt-progress" role="status"><LoaderCircle size={18} className="spin" aria-hidden="true" /><div><strong>{statusLabel}</strong>{job?.status === 'routing' && <small title={job.routerModel}>{t('{0}가 요청을 살펴보고 있습니다.', { 0: job.provider === 'claude' ? 'Opus' : 'GPT-5.6 Sol' })}</small>}<small>{t('창을 닫아도 요청은 계속됩니다.')}</small></div>{job && ['queued', 'routing'].includes(job.status) && <button type="button" className="auto-prompt-cancel" disabled={cancelling || !connected || !token} onClick={() => { void cancel(); }}>{cancelling ? <LoaderCircle size={12} className="spin" /> : <Square size={11} />}{t('취소')}</button>}</div>}
    {requestError && <div className="auto-prompt-error" role="alert"><TriangleAlert size={16} aria-hidden="true" /><p>{translateMessage(requestError)}</p>{uncertain && <button type="button" disabled={submitting || unavailable} onClick={() => { void submit(); }}>{t('같은 요청 다시 확인')}</button>}</div>}
    {job?.status === 'cancelled' && <p className="auto-prompt-cancelled" role="status">{t('요청을 취소했습니다. 세션에 보내지 않았습니다.')}</p>}
    {job?.status === 'completed' && <section className="auto-prompt-result" aria-label={t('요청을 보낸 세션')}><div className="auto-prompt-result-heading"><Check size={19} aria-hidden="true" /><h3>{job.decision?.action === 'create' ? t('새 세션에 요청을 보냈습니다') : t('기존 세션에 요청을 보냈습니다')}</h3></div><p className="auto-prompt-result-path"><Folder size={14} aria-hidden="true" /><bdi dir="ltr">{job.decision?.cwd || target?.cwd || cwd}</bdi></p><strong className="auto-prompt-result-session">{target ? sessionTitle(target) : job.sessionId}</strong>{job.decision?.reason && <p className="auto-prompt-result-reason">{job.decision.reason}</p>}</section>}
    <footer className="auto-prompt-footer"><p>{!locked && connectionMessage}</p>{job && !pending && <button type="button" className="secondary-button" disabled={submitting || cancelling} onClick={() => resetRequest(job.status === 'completed')}>{job.status === 'completed' ? t('새 요청') : t('요청 다시 작성')}</button>}</footer>
  </dialog>, document.body);
}
