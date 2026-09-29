import { useCallback, useContext, useEffect, useRef, useState, type FormEvent } from 'react';
import { SettingsFrameContext, SettingsPane } from '../settings/SettingsPane';
import { LoaderCircle, LogOut, RefreshCw } from 'lucide-react';
import type { AuthOverview } from '../../../shared/auth';
import { api } from '../common/lib';
import { locale, translateMessage, useI18n } from '../i18n/i18n';
import { authPost, useAuth } from './AuthGate';

/** Account management on a page of this computer itself; elsewhere, signing out. */
export function AccountSection() {
  const { t } = useI18n();
  const auth = useAuth();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!auth) return null;
  if (auth.status.local) return <AccountPanel token={auth.status.token} onChanged={auth.refresh} />;
  async function logout() {
    if (!auth || busy) return;
    setBusy(true); setError('');
    try { await authPost('/api/auth/logout', auth.status.token, {}); await auth.refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <SettingsPane title={t('계정')} scope="auth-panel" description={t('계정 관리는 서버 컴퓨터에서만 가능합니다.')}>
    {error && <p className="auth-error" role="alert">{translateMessage(error)}</p>}
    <div className="settings-group"><div className="settings-row"><span>{t('이 브라우저에서 로그아웃')}</span>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => void logout()}><LogOut size={14} />{t('로그아웃')}</button></div></div>
  </SettingsPane>;
}
export function AccountPanel({ token, onChanged }: { token: string; onChanged: () => Promise<void> }) {
  const { t } = useI18n();
  const [overview, setOverview] = useState<AuthOverview | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const refresh = useCallback(async () => {
    setLoading(true); setError('');
    try { const next = await api<AuthOverview>('/api/auth/overview'); setOverview(next); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  }, []);
  const { active } = useContext(SettingsFrameContext);
  useEffect(() => { if (active) void refresh(); }, [refresh, active]);
  useEffect(() => { if (overview) setUsername(overview.username || ''); }, [overview?.username]);
  async function mutate(path: string, body: unknown) {
    if (inFlight.current) return false;
    inFlight.current = true; setBusy(true); setError(''); setNotice('');
    try { setOverview(await authPost<AuthOverview>(path, token, body)); return true; }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); return false; }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (password !== confirmation) { setError(t('비밀번호가 일치하지 않습니다.')); return; }
    if (await mutate('/api/auth/credentials', { username, password })) { setPassword(''); setConfirmation(''); setNotice(t('계정을 저장했습니다. 기존 원격 로그인은 해제됩니다.')); await onChanged(); }
  }
  return <SettingsPane title={t('계정 관리')} scope="auth-panel" description={t('원격 접속용 아이디와 비밀번호, 차단된 IP')}
    actions={<button className="icon-button" title={t('새로고침')} aria-label={t('새로고침')} disabled={loading || busy} onClick={() => void refresh()}><RefreshCw size={17} className={loading ? 'spin' : ''} /></button>}><p className="auth-hint">{t('로컬 접속은 로그인 없이 사용할 수 있습니다. 계정 관리는 서버 컴퓨터에서만 가능합니다.')}</p>{error && <p className="auth-error" role="alert">{translateMessage(error)}</p>}{notice && <p role="status">{notice}</p>}{!overview ? loading && <LoaderCircle className="spin" aria-label={t('연결 중')} /> : <><section><h3>{overview.configured ? t('계정 변경') : t('계정 설정')}</h3><form className="auth-form auth-credentials" onSubmit={save}><label>{t('아이디')}<input required autoComplete="username" maxLength={64} value={username} onChange={event => setUsername(event.target.value)} /></label><label>{t('새 비밀번호')}<input required type="password" maxLength={256} autoComplete="new-password" minLength={12} value={password} onChange={event => setPassword(event.target.value)} /></label><label>{t('비밀번호 확인')}<input required type="password" maxLength={256} autoComplete="new-password" minLength={12} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label><p className="auth-hint">{t('비밀번호는 12자 이상으로 입력하세요. 검증용 해시만 저장됩니다.')}</p><button className="primary-button" disabled={busy || loading}>{busy && <LoaderCircle className="spin" size={14} />}{t('계정 저장')}</button></form></section><section><h3>{t('차단된 IP')} <span className="auth-count">{overview.blockedIps.length}</span></h3><p className="auth-hint">{t('같은 IP에서 누적 {0}회 실패하면 영구 차단됩니다. 성공해도 실패 횟수는 초기화되지 않습니다.', { 0: overview.attemptLimit })}</p><p className="auth-hint">{t('서버를 재시작해도 차단은 유지됩니다. 차단을 해제하면 해당 IP의 실패 횟수도 초기화됩니다.')}</p><AccountRecords overview={overview} busy={busy || loading} onUnblock={ip => void mutate('/api/auth/unblock', { ip })} /></section></>}</SettingsPane>;
}
export function AccountRecords({ overview, busy, onUnblock }: { overview: AuthOverview; busy: boolean; onUnblock: (ip: string) => void }) {
  const { t } = useI18n();
  const date = (at: string) => new Date(at).toLocaleString(locale());
  const labels = { success: t('성공'), failure: t('실패'), blocked: t('차단') };
  return <>{overview.blockedIps.length ? <div className="auth-table-scroll"><table><thead><tr><th>IP</th><th>{t('차단 시각')}</th><th>{t('실패 횟수')}</th><th>{t('관리')}</th></tr></thead><tbody>{overview.blockedIps.map(item => <tr key={item.ip}><td><code>{item.ip}</code></td><td>{date(item.blockedAt)}</td><td>{item.failures}</td><td><button className="secondary-button" disabled={busy} onClick={() => onUnblock(item.ip)} aria-label={t('{0} 차단 해제', { 0: item.ip })}>{t('차단 해제')}</button></td></tr>)}</tbody></table></div> : <p className="auth-empty">{t('차단된 IP가 없습니다.')}</p>}<h3>{t('로그인 시도 기록')}</h3><p className="auth-hint">{t('최근 {0}건을 최신순으로 표시합니다.', { 0: overview.historyLimit })}</p>{overview.attempts.length ? <div className="auth-table-scroll"><table><thead><tr><th>{t('시각')}</th><th>IP</th><th>{t('아이디')}</th><th>{t('결과')}</th></tr></thead><tbody>{overview.attempts.map(item => <tr key={item.id}><td>{date(item.at)}</td><td><code>{item.ip}</code></td><td>{item.username || '—'}</td><td><span className={`auth-result ${item.result}`}>{labels[item.result]}</span></td></tr>)}</tbody></table></div> : <p className="auth-empty">{t('로그인 시도 기록이 없습니다.')}</p>}</>;
}
