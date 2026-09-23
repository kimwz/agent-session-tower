import { translate as t, translateMessage, useI18n } from '../i18n/i18n';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, Folder, LoaderCircle, X } from 'lucide-react';
import type { Provider, ProviderHealth, Run, Session } from '../../../shared/types';
import { ProviderIcon } from '../common/Icons';
import { api, providerLabels } from '../common/lib';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { codexApprovalsRequest, readCodexApprovalsChoice, type CodexApprovalsChoice } from './codex-approvals-preference';
import { CodexApprovalsSelect } from './CodexApprovalsSelect';
import { EffortPicker, ModelPicker, supportedEffort } from '../chat/ModelPicker';

interface NewSessionDialogProps {
  providers: ProviderHealth[];
  projects: Array<[string, string]>;
  initialCwd?: string;
  token: string;
  connected: boolean;
  onClose: () => void;
  onCreated: (session: Session, run: Run) => void;
}

export function NewSessionDialog({ providers, projects, initialCwd, token, connected, onClose, onCreated }: NewSessionDialogProps) {
  useI18n();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const inFlight = useRef(false);
  const [provider, setProvider] = useState<Provider>(() => providers.find(item => item.available)?.provider || 'claude');
  const [cwd, setCwd] = useState(initialCwd || projects[0]?.[0] || '');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<string>();
  const [effort, setEffort] = useState<string>();
  const [approvals, setApprovals] = useState<CodexApprovalsChoice>(readCodexApprovalsChoice);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [folderError, setFolderError] = useState('');
  const providerAvailable = providers.some(item => item.provider === provider && item.available);
  const providerHealth = providers.find(item => item.provider === provider);
  const unavailable = !connected || !token || !providerAvailable;
  const uniqueProjects = [...new Map(projects).entries()];

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current;
    element?.showModal();
    if (folderInput.current?.value.trim()) promptInput.current?.focus();
    else folderInput.current?.focus();
    return () => {
      element?.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || unavailable || !prompt.trim() || !cwd.trim()) return;
    if (!/^(\/|~(\/|$))/.test(cwd.trim())) {
      setFolderError(t("/로 시작하는 전체 폴더 경로를 입력해 주세요."));
      folderInput.current?.focus();
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    setError('');
    setFolderError('');
    dialog.current?.focus();
    try {
      const result = await api<{ session: Session; run: Run }>('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token },
        body: JSON.stringify({ provider, cwd: cwd.trim(), prompt: prompt.trim(), ...(title.trim() ? { title: title.trim() } : {}),
          ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...codexApprovalsRequest(provider, approvals) }),
      });
      onCreated(result.session, result.run);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error && !(cause instanceof TypeError) ? cause.message : t("연결을 확인하지 못했습니다. 그래프에서 새 세션이 시작되었는지 확인해 주세요."));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  const connectionMessage = !connected ? t("다시 연결되면 세션을 시작할 수 있습니다.")
    : !token ? t("연결을 확인하고 있습니다.")
      : !providerAvailable ? t("{0}를 현재 사용할 수 없습니다.", { 0: providerLabels[provider] }) : '';

  return createPortal(<dialog
    ref={dialog}
    className="new-session-dialog"
    aria-labelledby={`${id}-heading`}
    aria-describedby={`${id}-description`}
    tabIndex={-1}
    onCancel={event => { event.preventDefault(); if (!inFlight.current) onClose(); }}
    onKeyDown={event => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || inFlight.current) event.preventDefault();
      }
    }}
    onClick={event => {
      if (event.target !== event.currentTarget || inFlight.current) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}
  >
    <form className="new-session-form" onSubmit={event => { void submit(event); }} onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) {
        if (event.key === 'Enter') event.preventDefault();
        return;
      }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        event.currentTarget.requestSubmit();
      }
    }} aria-busy={submitting}>
      <header className="new-session-heading">
        <div>
          <h2 id={`${id}-heading`}>{t("새 세션")}</h2>
          <p id={`${id}-description`}>{t("폴더와 첫 요청을 정하면 바로 작업을 시작합니다.")}</p>
        </div>
        <button type="button" className="icon-button" aria-label={t("새 세션 창 닫기")} disabled={submitting} onClick={onClose}><X size={19} /></button>
      </header>

      <fieldset className="new-session-provider-field" disabled={submitting}>
        <legend>{t("도구")}</legend>
        <div className="new-session-providers">
          {(['claude', 'codex'] as const).map(value => {
            const available = providers.some(item => item.provider === value && item.available);
            return <label key={value} className={`new-session-provider ${provider === value ? 'selected' : ''} ${!available ? 'unavailable' : ''}`}>
              <ProviderIcon provider={value} size={21} />
              <span><strong>{providerLabels[value]}</strong><small>{available ? t("사용 가능") : t("사용할 수 없음")}</small></span>
              <input type="radio" name={`${id}-provider`} value={value} checked={provider === value} disabled={!available} onChange={() => { setProvider(value); setModel(undefined); setEffort(undefined); }} />
            </label>;
          })}
        </div>
      </fieldset>

      <div className="new-session-field">
        <label htmlFor={`${id}-folder`}>{t("작업 폴더")}</label>
        <div className="new-session-folder-input">
          <Folder size={16} aria-hidden="true" />
          <input ref={folderInput} id={`${id}-folder`} list={`${id}-projects`} value={cwd} placeholder={t("/Users/…/프로젝트")} required disabled={submitting} autoComplete="off" spellCheck={false} aria-describedby={`${id}-folder-help${folderError ? ` ${id}-folder-error` : ''}`} aria-invalid={!!folderError} onChange={event => { setCwd(event.target.value); setFolderError(''); }} />
        </div>
        <datalist id={`${id}-projects`}>{uniqueProjects.map(([path, label]) => <option key={path} value={path}>{label}</option>)}</datalist>
        <p id={`${id}-folder-help`} className="new-session-help">{t("이 Mac의 폴더 경로. 없는 폴더는 새로 만듭니다.")}</p>
        {folderError && <p id={`${id}-folder-error`} className="new-session-error" role="alert">{translateMessage(folderError)}</p>}
      </div>

      <div className="new-session-field">
        <span className="new-session-label" id={`${id}-model`}>{t("모델 · 추론 수준")}</span>
        <div className="new-session-model-row" role="group" aria-labelledby={`${id}-model`}>
          <ModelPicker provider={providerHealth} value={model} disabled={submitting} onChange={next => { setModel(next); setEffort(value => supportedEffort(providerHealth, next || providerHealth?.defaultModel, value)); }} />
          <EffortPicker provider={providerHealth} model={model || providerHealth?.defaultModel} value={effort} disabled={submitting} onChange={setEffort} />
        </div>
      </div>

      {provider === 'codex' && <div className="new-session-field">
        <label htmlFor={`${id}-approvals`}>{t("승인 검토")}</label>
        <CodexApprovalsSelect id={`${id}-approvals`} value={approvals} disabled={submitting} onChange={setApprovals} />
        <p className="new-session-help">{t("이 선택은 새 대화와 함께 저장되며 나중에 Codex에서 바꿀 수 있습니다.")}</p>
      </div>}

      <div className="new-session-field">
        <label htmlFor={`${id}-title`}>{t("세션 이름")}{' '}<span>{t("선택")}</span></label>
        <input id={`${id}-title`} value={title} maxLength={120} placeholder={t("비워두면 첫 요청으로 정해집니다")} disabled={submitting} autoComplete="off" onChange={event => setTitle(event.target.value)} />
      </div>

      <div className="new-session-field new-session-prompt-field">
        <label htmlFor={`${id}-prompt`}>{t("첫 요청")}</label>
        <textarea ref={promptInput} id={`${id}-prompt`} value={prompt} maxLength={32000} rows={5} placeholder={t("어떤 작업을 시작할까요?")} required disabled={submitting} onChange={event => setPrompt(event.target.value)} />
      </div>

      {error && <p className="new-session-error new-session-request-error" role="alert">{translateMessage(error)}</p>}
      <footer className="new-session-footer">
        <p role="status">{submitting ? t("새 세션을 시작하고 있습니다.") : connectionMessage}</p>
        <button type="submit" className="new-session-submit" disabled={submitting || unavailable || !cwd.trim() || !prompt.trim()}>
          {submitting ? <LoaderCircle size={16} className="spin" /> : <ArrowUpRight size={16} />}
          {submitting ? t("시작 중…") : t("세션 시작")}
        </button>
      </footer>
    </form>
  </dialog>, document.body);
}
