import { cachedPreset, loadModelSettings, pickFor } from '../models/model-settings';
import { translate as t, translateMessage, useI18n } from '../i18n/i18n';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { CircleDot, Folder, LoaderCircle, X } from 'lucide-react';
import type { Provider, ProviderHealth, Run, Session } from '../../../shared/types';
import { MAX_ISSUE_TEXT, issueRequest } from '../../../shared/issues';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { ProviderIcon } from '../common/Icons';
import { api, providerLabels } from '../common/lib';
import { hostProblem, type Host } from '../remote/hosts';
import { localPart, nodeHeaders, nodeOf, nodePath, scopeRun, scopeSession, settleRequest } from '../remote/scope';

/** The name of the session that registers an issue: its first line, shortened. */
export function issueSessionTitle(text: string): string {
  const line = text.trim().split('\n')[0]!.trim();
  const short = [...line].length > 40 ? `${[...line].slice(0, 40).join('')}…` : line;
  return t("이슈 등록: {0}", { 0: short });
}

/** What starts the session that registers the issue, for the folder's own computer. */
export function issueSessionBody(provider: Provider, cwd: string, text: string, pick: { model?: string; effort?: string } = {}): string {
  return JSON.stringify({ provider, cwd: localPart(cwd), prompt: issueRequest(text), title: issueSessionTitle(text), ...(pick.model ? { model: pick.model } : {}), ...(pick.effort ? { effort: pick.effort } : {}) });
}

interface IssueDialogProps {
  /** The folder, scoped to its computer when it is on a joined one. */
  cwd: string;
  providers: ProviderHealth[];
  hosts?: Host[];
  token: string;
  connected: boolean;
  onClose: () => void;
  onCreated: (session: Session, run: Run) => void;
}

/**
 * A short form for an issue in the folder's repository. Sending it starts a session in the folder that analyses the
 * request and registers the issue, following the owner's register-issue skill.
 */
export function IssueDialog({ cwd, providers: localProviders, hosts = [], token, connected, onClose, onCreated }: IssueDialogProps) {
  useI18n();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const inFlight = useRef(false);
  const machine = nodeOf(cwd);
  const host = hosts.find(item => item.node === machine);
  const providers = machine ? host?.providers ?? [] : localProviders;
  const [provider, setProvider] = useState<Provider>(() => cachedPreset(machine, 'issues.register', providers)?.provider || providers.find(item => item.available)?.provider || 'claude');
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const providerAvailable = providers.some(item => item.provider === provider && item.available);
  const unavailable = !connected || !token || !providerAvailable || (machine !== undefined && !host?.canWork);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current;
    element?.showModal();
    input.current?.focus();
    return () => { element?.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || unavailable || !text.trim()) return;
    inFlight.current = true;
    setSubmitting(true);
    setError('');
    try {
      // The model and effort of Settings › Models' "issue registration" role on that computer, for the provider chosen here.
      const settings = await loadModelSettings(token, machine).catch(() => undefined);
      const body = issueSessionBody(provider, cwd, text, pickFor(settings, 'issues.register', provider));
      // Sending the same issue again after an unknown outcome reuses its request ID, so it starts at most once.
      const result = await api<{ session: Session; run: Run }>(nodePath(machine, '/api/sessions'), {
        method: 'POST', headers: nodeHeaders(machine, { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token }, 'new-issue', body), body,
      }).catch(error => { settleRequest(machine, 'new-issue', error); throw error; });
      settleRequest(machine, 'new-issue');
      onCreated(machine ? scopeSession(machine, result.session) : result.session, machine ? scopeRun(machine, result.run) : result.run);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error && !(cause instanceof TypeError) ? cause.message : t("연결을 확인하지 못했습니다. 그래프에서 새 세션이 시작되었는지 확인해 주세요."));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  const status = submitting ? t("이슈 등록 세션을 시작하고 있습니다.")
    : !connected ? t("다시 연결되면 세션을 시작할 수 있습니다.")
      : !token ? t("연결을 확인하고 있습니다.")
        : machine !== undefined && !host ? t("그 컴퓨터는 더 이상 연결되어 있지 않습니다.")
        : machine !== undefined && host && hostProblem(host) ? hostProblem(host)!
          : !providerAvailable ? t("{0}를 현재 사용할 수 없습니다.", { 0: providerLabels[provider] }) : '';

  return createPortal(<dialog ref={dialog} className="new-session-dialog issue-dialog" aria-labelledby={`${id}-heading`} aria-describedby={`${id}-description`} tabIndex={-1}
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
    }}>
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
          <h2 id={`${id}-heading`}>{t("이슈 등록")}</h2>
          <p id={`${id}-description`}>{t("간단히 적으면 에이전트가 코드를 살펴 정리한 뒤 이 폴더의 저장소에 이슈로 등록합니다.")}</p>
        </div>
        <button type="button" className="icon-button" aria-label={t("이슈 등록 창 닫기")} disabled={submitting} onClick={onClose}><X size={19} /></button>
      </header>

      <p className="issue-dialog-folder"><Folder size={15} aria-hidden="true" /><span className="folder-tail" title={localPart(cwd)}><bdi dir="ltr">{localPart(cwd)}</bdi></span>{machine && host && <span className="issue-dialog-machine">{host.name}</span>}</p>

      <fieldset className="new-session-provider-field" disabled={submitting}>
        <legend>{t("도구")}</legend>
        <div className="new-session-providers">
          {(['claude', 'codex'] as const).map(value => {
            const available = providers.some(item => item.provider === value && item.available);
            return <label key={value} className={`new-session-provider ${provider === value ? 'selected' : ''} ${!available ? 'unavailable' : ''}`}>
              <ProviderIcon provider={value} size={21} />
              <span><strong>{providerLabels[value]}</strong><small>{available ? t("사용 가능") : t("사용할 수 없음")}</small></span>
              <input type="radio" name={`${id}-provider`} value={value} checked={provider === value} disabled={!available} onChange={() => setProvider(value)} />
            </label>;
          })}
        </div>
      </fieldset>

      <div className="new-session-field new-session-prompt-field">
        <label htmlFor={`${id}-text`}>{t("이슈 내용")}</label>
        <textarea ref={input} id={`${id}-text`} value={text} maxLength={MAX_ISSUE_TEXT} rows={6} placeholder={t("버그, 기능, 작업을 간단히 적어 주세요.")} required disabled={submitting} onChange={event => setText(event.target.value)} />
      </div>

      {error && <p className="new-session-error new-session-request-error" role="alert">{translateMessage(error)}</p>}
      <footer className="new-session-footer">
        <p role="status">{status}</p>
        <button type="submit" className="new-session-submit" disabled={submitting || unavailable || !text.trim()}>
          {submitting ? <LoaderCircle size={16} className="spin" /> : <CircleDot size={16} />}
          {submitting ? t("시작 중…") : t("이슈 등록")}
        </button>
      </footer>
    </form>
  </dialog>, document.body);
}
