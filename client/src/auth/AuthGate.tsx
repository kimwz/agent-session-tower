import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { LoaderCircle, LockKeyhole } from 'lucide-react';
import type { AuthStatus } from '../../../shared/auth';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { api, AUTH_REQUIRED_EVENT } from '../common/lib';
import { translateMessage, useI18n } from '../i18n/i18n';

export function authPost<T>(path: string, token: string, body: unknown) {
  return api<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token }, body: JSON.stringify(body) });
}
const AuthContext = createContext<{ status: AuthStatus; refresh: () => Promise<void> } | null>(null);
export function useAuth() { return useContext(AuthContext); }

export function AuthGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      const next = await api<AuthStatus>('/api/auth/status');
      if (request === generation.current) { setStatus(next); setError(''); }
    } catch (error) { if (request === generation.current) setError(error instanceof Error ? error.message : String(error)); }
  }, []);
  useEffect(() => {
    void refresh();
    const required = () => { ++generation.current; setStatus(previous => previous?.local ? previous : previous ? { ...previous, authenticated: false } : null); void refresh(); };
    const visible = () => { if (!document.hidden) void refresh(); };
    window.addEventListener(AUTH_REQUIRED_EVENT, required);
    document.addEventListener('visibilitychange', visible);
    const timer = window.setInterval(visible, 30_000);
    return () => { ++generation.current; window.clearInterval(timer); window.removeEventListener(AUTH_REQUIRED_EVENT, required); document.removeEventListener('visibilitychange', visible); };
  }, [refresh]);
  if (status && (status.local || status.authenticated)) return <AuthContext.Provider value={{ status, refresh }}>{children}</AuthContext.Provider>;
  return <main className="auth-screen"><section className="auth-card"><LockKeyhole size={26} /><h1>Agent Session Tower</h1>{!status ? <>{error ? <><p role="alert">{translateMessage(error)}</p><button className="secondary-button" onClick={() => void refresh()}>{t('다시 확인')}</button></> : <LoaderCircle className="spin" aria-label={t('연결 중')} />}</> : status.configured ? <LoginForm status={status} onLogin={next => { ++generation.current; setStatus(next); }} /> : <><h2>{t('계정 설정이 필요합니다')}</h2><p>{t('서버 컴퓨터에서 Tower를 열고 계정 관리에서 ID와 비밀번호를 설정하세요.')}</p><button className="secondary-button" onClick={() => void refresh()}>{t('다시 확인')}</button></>}</section></main>;
}
export function LoginForm({ status, onLogin }: { status: AuthStatus; onLogin: (status: AuthStatus) => void }) {
  const { t } = useI18n();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try { onLogin(await authPost<AuthStatus>('/api/auth/login', status.token, { username, password })); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); setPassword(''); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <form className="auth-form" onSubmit={submit}><h2>{t('로그인')}</h2><label>{t('아이디')}<input autoFocus autoComplete="username" required maxLength={64} value={username} onChange={event => setUsername(event.target.value)} /></label><label>{t('비밀번호')}<input type="password" maxLength={256} autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /></label>{error && <p className="auth-error" role="alert">{translateMessage(error)}</p>}<button className="primary-button" disabled={busy}>{busy && <LoaderCircle className="spin" size={15} />}{t('로그인')}</button><p className="auth-hint">{t('같은 IP에서 5회 실패하면 관리자가 해제할 때까지 차단됩니다.')}</p></form>;
}
