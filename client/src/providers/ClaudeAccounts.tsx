import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, Plus, RefreshCw, X } from 'lucide-react';
import type { ClaudeAccountSummary, ClaudeAccountsAnswer, ClaudeLoginStatus } from '../../../shared/types';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { api, relativeTime } from '../common/lib';
import { useI18n } from '../i18n/i18n';
import { usagePercent, usageUnavailableReason, usageWindowLabel } from './provider-usage';

const post = (token: string, path: string, body: Record<string, unknown> = {}) => api<ClaudeAccountsAnswer>(path, { method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token }, body: JSON.stringify(body) });
const LOGIN_ACTIVE: ClaudeLoginStatus['state'][] = ['starting', 'waiting_code', 'verifying'];

/** The Claude accounts saved on this computer, inside the Claude usage tooltip: usage at a glance, one click to switch. */
export function ClaudeAccounts({ token, onAddAccount }: { token: string; onAddAccount: () => void }) {
  const { t } = useI18n();
  const [answer, setAnswer] = useState<ClaudeAccountsAnswer>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try { setAnswer(await api<ClaudeAccountsAnswer>('/api/claude-accounts')); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 20_000);
    return () => clearInterval(timer);
  }, [load]);
  const act = async (key: string, work: () => Promise<ClaudeAccountsAnswer>) => {
    setBusy(key); setError(undefined);
    try { setAnswer(await work()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(undefined); }
  };
  if (answer && !answer.available) return <p className="claude-accounts-note">{answer.reason ?? t('이 컴퓨터의 Claude는 환경 변수의 로그인을 써서 계정을 전환할 수 없습니다.')}</p>;
  const accounts = answer?.accounts ?? [];
  return <section className="claude-accounts" aria-label={t('Claude 계정')}>
    <header><strong>{t('Claude 계정')}</strong><button type="button" className="claude-account-add" onClick={onAddAccount}><Plus size={12} aria-hidden="true" />{t('계정 추가')}</button></header>
    {!answer && !error && <p className="claude-accounts-note">{t('계정 목록을 불러오는 중')}</p>}
    {answer && !accounts.length && <p className="claude-accounts-note">{t('저장된 계정이 없습니다. 지금 로그인된 계정은 곧 자동으로 저장됩니다.')}</p>}
    <ul>{accounts.map(account => <ClaudeAccountRow key={account.id} account={account} busy={busy} onSwitch={() => act(`switch:${account.id}`, () => post(token, '/api/claude-accounts/switch', { id: account.id }))}
      onRemove={() => act(`remove:${account.id}`, () => post(token, '/api/claude-accounts/remove', { id: account.id }))} onSignIn={onAddAccount} />)}</ul>
    {error && <p className="claude-accounts-error" role="alert">{error}</p>}
    {accounts.length > 1 && <p className="claude-accounts-note">{t('전환하면 새로 시작하는 Claude 실행부터 그 계정을 씁니다. 진행 중인 작업은 끊기지 않습니다.')}</p>}
  </section>;
}

function ClaudeAccountRow({ account, busy, onSwitch, onRemove, onSignIn }: { account: ClaudeAccountSummary; busy?: string; onSwitch: () => void; onRemove: () => void; onSignIn: () => void }) {
  const { t } = useI18n();
  const windows = (account.usage?.windows ?? []).filter(window => window.id === 'five_hour' || window.id === 'seven_day' || window.windowMinutes === 300 || window.windowMinutes === 10080)
    .sort((a, b) => (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0)).slice(0, 2);
  const plan = account.plan?.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  return <li className={`claude-account${account.active ? ' active' : ''}${account.problem ? ' problem' : ''}`}>
    <div className="claude-account-head">
      <span className="claude-account-name"><i aria-hidden="true" />{account.email}</span>
      {account.active ? <em>{t('사용 중')}</em> : account.problem
        ? <button type="button" onClick={onSignIn}>{t('다시 로그인')}</button>
        : <button type="button" disabled={!!busy} onClick={onSwitch}>{busy === `switch:${account.id}` ? <RefreshCw size={11} className="spin" aria-hidden="true" /> : null}{t('전환')}</button>}
      {!account.active && <button type="button" className="claude-account-remove" aria-label={t('{0} 목록에서 지우기', { 0: account.email })} title={t('목록에서 지우기')} disabled={!!busy} onClick={onRemove}><X size={11} aria-hidden="true" /></button>}
    </div>
    <small>{[account.organizationName, plan].filter(Boolean).join(' · ')}</small>
    {windows.length ? <div className="claude-account-usage">{windows.map(window => <span key={window.id} title={window.resetsAt ? t('초기화: {0}', { 0: new Date(window.resetsAt).toLocaleString() }) : undefined}>
      <b>{usageWindowLabel(window)}</b><span className="usage-bar"><i><b style={{ width: `${Math.min(100, window.usedPercent)}%` }} /></i></span><em>{usagePercent(window.usedPercent)}</em>
    </span>)}</div> : <small className="claude-account-empty">{account.problem ? t('로그인이 만료되어 사용량을 읽을 수 없습니다.') : t('사용량 정보가 아직 없습니다.')}</small>}
    {account.usage?.updatedAt && <small className={account.stale ? 'claude-account-stale' : undefined}>{t('확인: {0}', { 0: relativeTime(account.usage.updatedAt) })}{account.stale ? ` · ${usageUnavailableReason({ status: 'error', windows: [], reason: account.reason })}` : ''}</small>}
  </li>;
}

/** Adding an account: starts Tower's sign-in on open, follows it, and cancels it when closed before it ends. */
export function ClaudeLoginDialog({ token, onClose }: { token: string; onClose: () => void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [login, setLogin] = useState<ClaudeLoginStatus>();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const active = !login || LOGIN_ACTIVE.includes(login.state);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  useEffect(() => {
    post(token, '/api/claude-accounts/login/start').then(answer => setLogin(answer.login)).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);
  // The sign-in finishes on the server; follow it while it runs.
  useEffect(() => {
    if (!active || error) return;
    // best-effort: a missed reading is followed by the next one.
    const timer = setInterval(() => { void api<ClaudeAccountsAnswer>('/api/claude-accounts').then(answer => setLogin(answer.login)).catch(() => {}); }, 1500);
    return () => clearInterval(timer);
  }, [active, error]);
  const close = () => {
    // best-effort: an uncancelled sign-in ends by itself after ten minutes.
    if (login && LOGIN_ACTIVE.includes(login.state)) void post(token, '/api/claude-accounts/login/cancel').catch(() => {});
    onClose();
  };
  const submit = async () => {
    setSending(true); setError(undefined);
    try { setLogin((await post(token, '/api/claude-accounts/login/code', { code })).login); setCode(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSending(false); }
  };
  const state = login?.state ?? 'starting';
  return createPortal(<dialog ref={dialog} className="claude-login-dialog" aria-labelledby={title} onCancel={event => { event.preventDefault(); close(); }}>
    <header><strong id={title}>{t('Claude 계정 추가')}</strong><button type="button" aria-label={t('닫기')} onClick={close}><X size={14} aria-hidden="true" /></button></header>
    {state === 'starting' && !error && <p>{t('로그인을 준비하는 중입니다…')}</p>}
    {(state === 'waiting_code' || state === 'verifying') && login?.url && <>
      <ol>
        <li>{t('아래 링크를 열어 추가할 Claude 계정으로 로그인하세요. 어느 기기에서 열어도 됩니다.')}<br /><a href={login.url} target="_blank" rel="noreferrer noopener"><ExternalLink size={12} aria-hidden="true" />{t('Claude 로그인 페이지 열기')}</a></li>
        <li>{t('로그인을 마치면 나오는 코드를 복사해 여기에 붙여넣으세요.')}</li>
      </ol>
      <form onSubmit={event => { event.preventDefault(); void submit(); }}>
        <input value={code} onChange={event => setCode(event.target.value)} placeholder={t('코드 붙여넣기')} aria-label={t('로그인 코드')} autoComplete="off" spellCheck={false} disabled={state === 'verifying' || sending} />
        <button type="submit" disabled={!code.trim() || state === 'verifying' || sending}>{state === 'verifying' ? t('확인 중…') : t('확인')}</button>
      </form>
    </>}
    {state === 'done' && <p className="claude-login-done">{t('{0} 계정을 저장했습니다. 계정 목록에서 전환할 수 있습니다.', { 0: login?.account?.email ?? '' })}</p>}
    {state === 'failed' && <p className="claude-accounts-error" role="alert">{login?.error || t('로그인하지 못했습니다.')}</p>}
    {error && <p className="claude-accounts-error" role="alert">{error}</p>}
    <footer><button type="button" onClick={close}>{active && !error ? t('취소') : t('닫기')}</button></footer>
  </dialog>, document.body);
}
