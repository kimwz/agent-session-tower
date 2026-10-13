import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ClipboardPaste, KeyRound, ListChecks, X } from 'lucide-react';
import type { SecretSessionView } from '../../../shared/secrets';
import { useI18n } from '../i18n/i18n';
import { openSettings } from '../settings/settings-open';
import type { SecretChange } from './SecretAccess';
import { SecretPaste } from './SecretPaste';
import { SecretAvailable, SecretSessionState } from './SecretAvailable';
import { SecretSessionPoller } from './session-poller';
import { failureCode, postSecret, readSecretSession, secretFailure, secretLoadFailure, secretSession, sessionBlocked, usedSecrets } from './secrets-client';

/** Actions on this session's task; their answer is the session view. Vault setup and unlocks answer with the settings view. */
const SESSION_ACTIONS = new Set(['create', 'session-connect', 'session-disconnect', 'session-reallow']);

/** One session's secret view, read by `SecretSessionPoller`; nothing here connects anything until a button asks. */
function useSecretSession(token: string, sessionId: string, open: boolean) {
  const { t } = useI18n();
  const [view, setView] = useState<SecretSessionView>(); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const poller = useRef<SecretSessionPoller | undefined>(undefined); const mutating = useRef(false);
  const latest = useRef({ open, t }); latest.current = { open, t };
  useEffect(() => {
    setView(undefined); setError(''); setBusy(false); mutating.current = false;
    if (!token) return;
    const current = new SecretSessionPoller({ open: latest.current.open, load: signal => readSecretSession(sessionId, signal),
      onView: next => { setView(next); setError(''); }, onError: failure => setError(secretLoadFailure(failure, latest.current.t)) });
    poller.current = current; current.start();
    const focus = () => current.wake();
    window.addEventListener('focus', focus);
    return () => { current.stop(); window.removeEventListener('focus', focus); if (poller.current === current) poller.current = undefined; };
  }, [token, sessionId]);
  useEffect(() => { poller.current?.setOpen(open); }, [open]);
  const change: SecretChange = useCallback(async (action, body, refused) => {
    const current = poller.current;
    if (mutating.current || !current) return false;
    mutating.current = true; setBusy(true); setError(''); current.hold();
    try {
      if (SESSION_ACTIONS.has(action)) {
        const next = await postSecret<SecretSessionView>(action, token, { ...body as Record<string, unknown>, ...secretSession(sessionId) });
        if (poller.current === current) current.apply(next);
      } else {
        await postSecret<unknown>(action, token, body);
        if (poller.current === current) current.release(true);
      }
      return poller.current === current;
    } catch (failure) {
      if (poller.current === current) {
        const code = failureCode(failure);
        if (!code || !refused?.(code)) setError(secretFailure(failure, latest.current.t));
        current.release();
      }
      return false;
    } finally { if (poller.current === current) { mutating.current = false; setBusy(false); } }
  }, [token, sessionId]);
  const reload = useCallback(() => { setError(''); poller.current?.wake(); }, []);
  return { view, error, busy, change, reload };
}

export type SecretTab = 'paste' | 'available';
interface ComposerSecrets extends ReturnType<typeof useSecretSession> {
  token: string; sessionId: string; cwd?: string; tab?: SecretTab; show(tab: SecretTab): void; close(): void;
}
const SecretComposerContext = createContext<ComposerSecrets | null>(null);
/** Shares one session view between the composer's chips and its secret dialog. */
export function SecretComposerProvider({ token, sessionId, cwd, children }: { token: string; sessionId: string; cwd?: string; children: ReactNode }) {
  const [tab, setTab] = useState<SecretTab>();
  useEffect(() => { setTab(undefined); }, [sessionId]);
  const state = useSecretSession(token, sessionId, !!tab);
  const close = useCallback(() => setTab(undefined), []);
  const value = useMemo(() => ({ ...state, token, sessionId, cwd, tab, show: setTab, close }), [state.view, state.error, state.busy, state.change, state.reload, token, sessionId, cwd, tab, close]);
  return <SecretComposerContext.Provider value={value}>{children}</SecretComposerContext.Provider>;
}
function useComposerSecrets(): ComposerSecrets {
  const state = useContext(SecretComposerContext);
  if (!state) throw new Error('Secret composer context is missing');
  return state;
}

/** The composer's key button; the dialog always opens on the paste tab. */
export function SecretComposer() {
  const { t } = useI18n(); const state = useComposerSecrets();
  return <>
    <button className="attach-button secret-composer-button" type="button" disabled={!state.token} aria-label={t('시크릿')} title={t('시크릿')} aria-haspopup="dialog" onClick={() => state.show('paste')}><KeyRound size={16} aria-hidden="true" /></button>
    {state.tab && createPortal(<SecretChatDialog state={state} tab={state.tab} />, document.body)}
  </>;
}

const TABS: { id: SecretTab; label: string }[] = [{ id: 'paste', label: '시크릿 붙여넣기' }, { id: 'available', label: '이 세션에서 사용 가능한 시크릿' }];
export function SecretChatDialog({ state, tab }: { state: ComposerSecrets; tab: SecretTab }) {
  const { t } = useI18n(); const dialog = useRef<HTMLDialogElement>(null); const id = useId(); const [connected, setConnected] = useState(false);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null; const element = dialog.current; element?.showModal();
    return () => { element?.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  // The paste input takes focus on its tab; the other tab focuses its own tab button.
  useEffect(() => {
    const element = dialog.current;
    const target = tab === 'paste' ? element?.querySelector<HTMLElement>('.secret-paste-label textarea, .secret-paste-label input[type=file]') : element?.querySelector<HTMLElement>('[role=tab][aria-selected=true]');
    target?.focus();
  }, [tab]);
  const choose = (next: SecretTab) => { setConnected(false); state.show(next); };
  const moveTab = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    choose(tab === 'paste' ? 'available' : 'paste');
  };
  const manage = (secretId?: string) => { state.close(); openSettings({ section: 'secrets', ...(secretId ? { secretId } : {}) }); };
  const view = state.view;
  return <dialog ref={dialog} className="secret-dialog secret-quick-dialog" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); state.close(); }} onClick={event => { if (event.target === event.currentTarget) state.close(); }}
    // A close queued before the dialog opened again (React's development double mount) is not one.
    onClose={event => { if (event.target === event.currentTarget && !event.currentTarget.open) state.close(); }}>
    <header><h2 id={`${id}-title`}><KeyRound size={18} aria-hidden="true" />{t('시크릿')}</h2><button type="button" className="icon-button" aria-label={t('닫기')} onClick={state.close}><X size={18} /></button></header>
    <div className="secret-tabs" role="tablist" aria-label={t('시크릿')} onKeyDown={moveTab}>
      {TABS.map(item => <button key={item.id} id={`${id}-tab-${item.id}`} type="button" role="tab" aria-selected={tab === item.id} aria-controls={`${id}-panel`} tabIndex={tab === item.id ? 0 : -1} onClick={() => choose(item.id)}>
        {item.id === 'paste' ? <ClipboardPaste size={14} aria-hidden="true" /> : <ListChecks size={14} aria-hidden="true" />}<span>{t(item.label)}</span>
        {item.id === 'available' && !!view?.available.length && <span className="secret-tab-count">{view.available.length}</span>}
      </button>)}
    </div>
    <div className="secret-dialog-body" id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`}>
      {state.error && <p role="alert" className="secret-error">{state.error}<button type="button" onClick={state.reload}>{t('다시 시도')}</button></p>}
      {tab === 'paste' ? <>
        {sessionBlocked(view?.error) && <SecretSessionState error={view?.error} />}
        <SecretPaste view={view} sessionId={state.sessionId} cwd={state.cwd} busy={state.busy} change={state.change} onConnected={() => { setConnected(true); state.show('available'); }} />
      </> : <>
        {connected && <p role="status" className="secret-notice-line">{t('이 세션에 연결했습니다.')}</p>}
        {view ? <SecretAvailable view={view} busy={state.busy} change={state.change} onPaste={() => choose('paste')} onSharing={manage} /> : !state.error && <p role="status">{t('불러오는 중…')}</p>}
      </>}
    </div>
  </dialog>;
}

/** Secrets this session actually used, above the composer (owner decision D2); each opens the dialog's second tab. */
export function SecretChips() {
  const { t } = useI18n(); const state = useComposerSecrets();
  const used = usedSecrets(state.view?.usage ?? []);
  if (!used.length) return null;
  return <div className="secret-chips" aria-label={t('이 세션에서 사용한 시크릿')}>{used.map(use => <button type="button" key={use.secretId} className={use.outcome === 'blocked' ? 'blocked' : ''} title={t('이 세션에서 사용 가능한 시크릿')} onClick={() => state.show('available')}>
    <KeyRound size={12} aria-hidden="true" /><strong>{use.name}</strong>{use.outcome === 'blocked' && <small>{t('차단됨')}</small>}
  </button>)}</div>;
}
