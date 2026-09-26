import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronRight, Folder, LoaderCircle, Monitor, Paperclip, Send, Sparkles, Square, TriangleAlert, X, BrainCircuit } from 'lucide-react';
import type { DecisionOverview } from '../../../shared/decisions';
import { suggestionTarget, useAutoPromptSuggestion, type SuggestionState } from './suggestion';
import type { AutoPromptJob, Provider, ProviderHealth, Session } from '../../../shared/types';
import { MAX_ATTACHMENTS, MAX_TOTAL_ATTACHMENT_BYTES } from '../../../shared/attachments';
import { DraftAttachments } from '../chat/ChatAttachments';
import { ProviderIcon } from '../common/Icons';
import { addDraftFiles, formatAttachmentSize, prepareDraftAttachments, type DraftAttachment } from '../chat/chat-attachments';
import { autoPromptPending, createAutoPromptAttempt, newerAutoPromptJob, type AutoPromptAttempt } from './auto-prompt-request';
import { api, providerLabels, sessionTitle } from '../common/lib';
import { translate as t, translateMessage, useI18n } from '../i18n/i18n';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { EffortPicker, ModelPicker, supportedEffort } from '../chat/ModelPicker';
import { hostProblem, type Host } from '../remote/hosts';
import { localPart, nodeOf, pathFor, requestId, scopedId, scopeJob } from '../remote/scope';

interface AutoPromptDialogProps {
  visible: boolean;
  initialCwd?: string;
  /** The joined computer to open on when no folder names it. */
  initialNode?: string;
  providers: ProviderHealth[];
  /** Every computer this page can send work to; without joined computers only this one. */
  hosts?: Host[];
  projects: Array<[string, string]>;
  sessions: Session[];
  jobs: AutoPromptJob[];
  token: string;
  connected: boolean;
  onClose: () => void;
  onNavigate: (id: string) => void;
  onRefresh: () => void;
}

/** A request that names its conversation or asks for a new one goes there without the router. */
const directed = (job: AutoPromptJob) => Boolean(job.sessionMode || job.targetSessionId);

function progressLabel(job: AutoPromptJob) {
  if (job.status === 'queued') return t('요청을 준비하고 있습니다…');
  if (job.status === 'dispatching' || directed(job)) return t('선택한 세션에 요청을 보내고 있습니다…');
  if (job.stage === 'directory') return t('작업할 폴더를 찾고 있습니다…');
  if (job.stage === 'session') return t('작업할 세션을 찾고 있습니다…');
  return t('작업할 폴더와 세션을 찾고 있습니다…');
}

/** Stays mounted while hidden so an admitted request can never become a fresh submission. */
export function AutoPromptDialog({ visible, initialCwd, initialNode, providers: localProviders, hosts = [], projects: allProjects, sessions, jobs, token, connected, onClose, onNavigate, onRefresh }: AutoPromptDialogProps) {
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
  const [machine, setMachine] = useState<string | undefined>();
  const host = hosts.find(item => item.node === machine);
  const providers = machine ? host?.providers ?? [] : localProviders;
  const projects = allProjects.filter(([key]) => nodeOf(key) === machine).map(([key, label]): [string, string] => [localPart(key), label]);
  const [provider, setProvider] = useState<Provider>('claude');
  const [model, setModel] = useState<string>();
  const [effort, setEffort] = useState<string>();
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
  const [suggestionsOn, setSuggestionsOn] = useState(false);
  const [acceptSuggestion, setAcceptSuggestion] = useState(true);
  // Each new draft gets its own suggestions; nothing suggested for an earlier one comes back.
  const [draft, setDraft] = useState(0);
  const pending = !!job && autoPromptPending(job);
  const locked = !!attemptId || preparing || submitting;
  const providerAvailable = providers.some(item => item.provider === provider && item.available);
  const providerHealth = providers.find(item => item.provider === provider);
  const unavailable = !connected || !token || !providerAvailable || (machine !== undefined && !host?.canWork);
  const suggestion = useAutoPromptSuggestion({ enabled: visible && suggestionsOn && !unavailable, paused: locked, draft, prompt, provider, cwd, machine, token });
  const accepted = acceptSuggestion && suggestion?.suggestion ? suggestion.suggestion : undefined;

  // Whether suggestions are set up is read each time the window opens, so turning them on takes effect at once.
  useEffect(() => {
    if (!visible || !token) return;
    let stopped = false;
    api<DecisionOverview>('/api/decisions').then(overview => { if (!stopped) setSuggestionsOn(overview.configured && overview.features.autoPromptSuggestions); })
      .catch(() => { if (!stopped) setSuggestionsOn(false); });
    return () => { stopped = true; };
  }, [visible, token]);

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
    setDraft(value => value + 1);
    if (clearPrompt) { setPrompt(''); setAttachments([]); setAcceptSuggestion(true); }
  }

  // Defaults are applied only when opening a fresh dialog, never to an unresolved request.
  const opening = useRef({ initialCwd, initialNode, localProviders, hosts });
  opening.current = { initialCwd, initialNode, localProviders, hosts };
  useEffect(() => {
    const element = dialog.current;
    if (!visible || !element) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (currentJob.current && !autoPromptPending(currentJob.current) && seenTerminalId.current === currentJob.current.id && !sending.current) {
      generation.current++;
      attempt.current = undefined; currentJob.current = undefined;
      seenTerminalId.current = '';
      setAttemptId(''); setJob(undefined); setError(''); setUncertain(false);
      setPrompt(''); setAttachments([]); setAcceptSuggestion(true); setDraft(value => value + 1);
    }
    if (!attempt.current && !sending.current) {
      const { initialCwd: folder, initialNode: node, localProviders: here, hosts: machines } = opening.current;
      const chosen = nodeOf(folder) ?? node;
      setMachine(chosen);
      setCwd(folder ? localPart(folder) : '');
      setProvider((chosen ? machines.find(item => item.node === chosen)?.providers ?? [] : here).find(item => item.available)?.provider || 'claude');
      setModel(undefined); setEffort(undefined);
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
        const result = await api<{ job: AutoPromptJob }>(pathFor(attemptId, id => `/api/auto-prompts/${encodeURIComponent(id)}`));
        if (!stopped) receiveJob(nodeOf(attemptId) ? scopeJob(nodeOf(attemptId)!, result.job) : result.job);
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
        // The suggestion shown when sending is fixed into this request, whatever arrives later.
        const place = accepted ? suggestionTarget(accepted) : cwd ? { cwd } : {};
        attempt.current = createAutoPromptAttempt({ requestId: requestId(), provider, ...place, prompt, ...prepared,
          ...(model ? { model } : {}), ...(effort ? { effort } : {}) }, undefined, machine);
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
      const result = await api<{ job: AutoPromptJob }>(pathFor(job.id, id => `/api/auto-prompts/${encodeURIComponent(id)}/cancel`), {
        method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token }, body: '{}',
      });
      receiveJob(job.node ? scopeJob(job.node, result.job) : result.job);
      onRefresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('요청 취소를 확인하지 못했습니다.')); }
    finally { setCancelling(false); }
  }

  const choices = new Map(projects.filter(([path]) => path.startsWith('/')));
  if (cwd && !choices.has(cwd)) choices.set(cwd, cwd.split('/').filter(Boolean).at(-1) || cwd);
  const target = sessions.find(session => session.id === job?.sessionId);
  const statusLabel = preparing ? t('첨부 파일 준비 중…') : job && pending ? progressLabel(job) : submitting ? t('요청 접수를 확인하고 있습니다…') : '';
  const connectionMessage = !connected ? t('서버에 다시 연결되면 요청을 보낼 수 있습니다.')
    : !token ? t('연결을 확인하고 있습니다.')
    : machine !== undefined && host && hostProblem(host) ? hostProblem(host)!
    : !providerAvailable ? t('{0}를 현재 사용할 수 없습니다.', { 0: providerLabels[provider] }) : '';
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
      {hosts.length > 1 && <label className="auto-prompt-directory auto-prompt-machine"><span className="sr-only">{t('컴퓨터')}</span><Monitor size={16} aria-hidden="true" /><select aria-label={t('컴퓨터')} value={machine ?? ''} disabled={locked} onChange={event => {
        const next = event.target.value || undefined;
        setMachine(next); setCwd('');
        setProvider((next ? hosts.find(item => item.node === next)?.providers ?? [] : localProviders).find(item => item.available)?.provider || 'claude');
        setModel(undefined); setEffort(undefined); setError('');
      }}>{hosts.map(item => <option key={item.node ?? ''} value={item.node ?? ''}>{item.node ? item.canWork ? item.name : t('{0} (지금 사용할 수 없음)', { 0: item.name }) : t('{0} (이 컴퓨터)', { 0: item.name })}</option>)}</select><ChevronDown size={13} aria-hidden="true" /></label>}
      <label className="auto-prompt-directory"><span className="sr-only">{t('작업 폴더')}</span><Folder size={16} aria-hidden="true" /><select aria-label={t('작업 폴더')} title={cwd || 'Auto'} value={cwd} disabled={locked} onChange={event => setCwd(event.target.value)}><option value="">Auto</option>{[...choices].map(([path, label]) => <option key={path} value={path}>{label} · {path}</option>)}</select><ChevronDown size={13} aria-hidden="true" /></label>
      <div className="auto-prompt-providers" role="group" aria-label={t('에이전트 종류')}>
        {(['claude', 'codex'] as const).map(value => {
          const available = providers.some(item => item.provider === value && item.available);
          return <button key={value} type="button" className={`auto-prompt-provider-button ${value}`} aria-label={value === 'claude' ? 'Claude' : 'Codex'} aria-pressed={provider === value} title={available ? providerLabels[value] : t('{0}를 현재 사용할 수 없습니다.', { 0: providerLabels[value] })} disabled={locked || !available} onClick={() => { if (value !== provider) { setProvider(value); setModel(undefined); setEffort(undefined); } }}><ProviderIcon provider={value} size={24} /></button>;
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
      <div className="composer-bottom"><button type="button" className="attach-button" aria-label={t('파일 첨부')} title={t('파일 첨부 · 최대 {0}개, 합계 {1} · 이미지 붙여넣기 가능', { 0: MAX_ATTACHMENTS, 1: formatAttachmentSize(MAX_TOTAL_ATTACHMENT_BYTES) })} disabled={locked} onClick={() => fileInput.current?.click()}><Paperclip size={17} aria-hidden="true" /></button><span className="composer-hint">{prompt.length > 24000 ? t('{0} / 32,000자', { 0: prompt.length.toLocaleString() }) : <><kbd>⌘ / Ctrl</kbd><kbd>Enter</kbd><span>{t('전송')}</span></>}</span><ModelPicker provider={providerHealth} value={model} disabled={locked} onChange={next => { setModel(next); setEffort(value => supportedEffort(providerHealth, next || providerHealth?.defaultModel, value)); }} /><EffortPicker provider={providerHealth} model={model || providerHealth?.defaultModel} value={effort} disabled={locked} onChange={setEffort} /><button type="submit" className="send-button" disabled={unavailable || locked || (!prompt.trim() && !attachments.length)} aria-label={submitting || pending ? t('요청 보내는 중') : t('요청 보내기')}>{submitting || pending ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}<span>{t('보내기')}</span></button></div>
    </form>
    {!job && suggestion && <SuggestionRow state={suggestion} accepted={acceptSuggestion} disabled={locked} machine={machine} projects={choices} sessions={sessions} onChange={setAcceptSuggestion} />}
    {statusLabel && <div className="auto-prompt-progress" role="status"><LoaderCircle size={18} className="spin" aria-hidden="true" /><div><strong>{statusLabel}</strong>{job?.status === 'routing' && !directed(job) && <small title={job.routerModel}>{t('{0}가 요청을 살펴보고 있습니다.', { 0: job.provider === 'claude' ? 'Opus' : 'GPT-5.6 Sol' })}</small>}<small>{t('창을 닫아도 요청은 계속됩니다.')}</small></div>{job && ['queued', 'routing'].includes(job.status) && <button type="button" className="auto-prompt-cancel" disabled={cancelling || !connected || !token} onClick={() => { void cancel(); }}>{cancelling ? <LoaderCircle size={12} className="spin" /> : <Square size={11} />}{t('취소')}</button>}</div>}
    {requestError && <div className="auto-prompt-error" role="alert"><TriangleAlert size={16} aria-hidden="true" /><p>{translateMessage(requestError)}</p>{uncertain && <button type="button" disabled={submitting || unavailable} onClick={() => { void submit(); }}>{t('같은 요청 다시 확인')}</button>}</div>}
    {job?.status === 'cancelled' && <p className="auto-prompt-cancelled" role="status">{t('요청을 취소했습니다. 세션에 보내지 않았습니다.')}</p>}
    {job?.status === 'completed' && <section className="auto-prompt-result" aria-label={t('요청을 보낸 세션')}><div className="auto-prompt-result-heading"><Check size={19} aria-hidden="true" /><h3>{job.decision?.action === 'create' ? t('새 세션에 요청을 보냈습니다') : t('기존 세션에 요청을 보냈습니다')}</h3></div><p className="auto-prompt-result-path"><Folder size={14} aria-hidden="true" /><bdi dir="ltr">{job.decision?.cwd || target?.cwd || cwd}</bdi></p><strong className="auto-prompt-result-session">{target ? sessionTitle(target) : job.sessionId}</strong>{job.decision?.reason && <p className="auto-prompt-result-reason">{job.decision.reason}</p>}</section>}
    <footer className="auto-prompt-footer"><p>{!locked && connectionMessage}</p>{job && !pending && <button type="button" className="secondary-button" disabled={submitting || cancelling} onClick={() => resetRequest(job.status === 'completed')}>{job.status === 'completed' ? t('새 요청') : t('요청 다시 작성')}</button>}</footer>
  </dialog>, document.body);
}

/** The suggested project and conversation under the draft; unchecking it sends the request to the router as before. */
export function SuggestionRow({ state, accepted, disabled, machine, projects, sessions, onChange }: {
  state: SuggestionState; accepted: boolean; disabled: boolean; machine: string | undefined; projects: Map<string, string>; sessions: Session[]; onChange: (value: boolean) => void;
}) {
  const label = state.label || 'Jev';
  const found = state.suggestion;
  if (!found) {
    const message = state.loading ? t('{0}가 프로젝트와 세션을 찾고 있습니다…', { 0: label })
      : state.error === 'unauthorized' ? t('{0}가 API 키를 거부해 추천하지 못했습니다. 빠른 판단 설정을 확인하세요.', { 0: label })
      : state.error ? t('지금은 {0} 추천을 받을 수 없습니다.', { 0: label })
      : t('맞는 프로젝트를 찾지 못했습니다. 보내면 평소처럼 폴더와 세션을 찾습니다.');
    return <p className="auto-prompt-suggestion muted" role="status">{state.loading ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : <BrainCircuit size={13} aria-hidden="true" />}<span>{message}</span></p>;
  }
  const session = found.sessionId ? sessions.find(item => item.id === scopedId(machine, found.sessionId!)) : undefined;
  const project = projects.get(found.cwd) || found.project;
  const conversation = found.sessionId ? (session ? sessionTitle(session) : found.sessionTitle || found.sessionId) : t('새 세션');
  const confidence = t('프로젝트 {0}% · 세션 {1}%', { 0: Math.round(found.projectConfidence * 100), 1: Math.round(found.sessionConfidence * 100) });
  return <label className={`auto-prompt-suggestion ${accepted ? '' : 'off'}`} title={`${found.cwd}\n${confidence}`}>
    <input type="checkbox" checked={accepted} disabled={disabled} onChange={event => onChange(event.target.checked)} />
    <span className="auto-prompt-suggestion-label"><BrainCircuit size={13} aria-hidden="true" />{t('{0} 추천', { 0: label })}</span>
    <span className="auto-prompt-suggestion-target"><strong>{project}</strong><ChevronRight size={13} aria-hidden="true" /><span className={found.sessionId ? '' : 'new'}>{conversation}</span></span>
    {state.loading && <LoaderCircle size={12} className="spin" aria-label={t('추천을 새로 고치는 중')} />}
  </label>;
}
