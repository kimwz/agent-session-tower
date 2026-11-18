import { useCallback, useContext, useEffect, useState, type FormEvent } from 'react';
import { Check, Copy, KeyRound, LoaderCircle, Trash2 } from 'lucide-react';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { REMOTE_MCP_KEY_HEADER, type RemoteMcpCreated, type RemoteMcpOverview, type RemoteMcpScope } from '../../../shared/remote-mcp';
import { api, copyText } from '../common/lib';
import { locale, translateMessage, useI18n } from '../i18n/i18n';
import { SettingsFrameContext, SettingsPane } from '../settings/SettingsPane';

const post = <T,>(path: string, token: string, body: unknown) =>
  api<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token }, body: JSON.stringify(body) });

/** How to add the endpoint to Claude Code and Codex, with the key shown once. */
export function clientSetup(endpoint: string, key: string): { claude: string; codex: string; codexEnv: string } {
  return {
    claude: `claude mcp add --transport http --scope user tower-remote ${endpoint} --header "${REMOTE_MCP_KEY_HEADER}: ${key}"`,
    codex: `[mcp_servers.tower-remote]\nurl = "${endpoint}"\nenv_http_headers = { "${REMOTE_MCP_KEY_HEADER}" = "TOWER_MCP_KEY" }`,
    // Kept out of the settings file: the key goes in the environment Codex starts from.
    codexEnv: `export TOWER_MCP_KEY=${key}`,
  };
}

/** Keys for the owner's MCP clients outside this computer, which reach Tower at its public HTTPS address. */
export function RemoteMcpPanel({ token }: { token: string }) {
  const { t } = useI18n();
  const [overview, setOverview] = useState<RemoteMcpOverview | null>(null);
  const [created, setCreated] = useState<RemoteMcpCreated | null>(null);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<RemoteMcpScope>('read');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');
  const { active } = useContext(SettingsFrameContext);
  const load = useCallback(async () => setOverview(await api<RemoteMcpOverview>('/api/remote-mcp')), []);
  useEffect(() => { if (active) void load().catch(error => setError(error instanceof Error ? error.message : String(error))); }, [load, active]);
  // The key is shown once: leaving the section forgets it.
  useEffect(() => { if (!active) { setCreated(null); setPassword(''); } }, [active]);

  async function act<T extends RemoteMcpOverview>(action: () => Promise<T>): Promise<T | undefined> {
    if (busy) return undefined;
    setBusy(true); setError('');
    try { const next = await action(); setOverview(next); return next; }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); return undefined; }
    finally { setBusy(false); }
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    const made = await act(() => post<RemoteMcpCreated>('/api/remote-mcp/create', token, { name, scope, ...(overview?.passwordRequired ? { password } : {}) }));
    setPassword('');
    if (made) { setCreated(made); setName(''); }
  }
  async function copy(id: string, text: string) { if (await copyText(text)) { setCopied(id); setTimeout(() => setCopied(value => value === id ? '' : value), 1500); } }
  const date = (at?: string) => at ? new Date(at).toLocaleString(locale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : t('없음');
  const endpoint = overview?.endpoints[0];
  const setup = created && endpoint ? clientSetup(endpoint, created.key) : undefined;

  return <SettingsPane title={t('외부 MCP')} scope="auth-panel remote-mcp-scope" description={t('다른 컴퓨터의 Claude Code·Codex에서 Tower를 MCP로 쓰기')}>
    <p className="auth-hint">{t('Cloudflare Access 로그인을 통과한 MCP 클라이언트가 여기서 만든 키를 함께 보내야 연결됩니다. 키는 소유자의 원격 화면 권한으로 동작하며, 백업·복구·시크릿 보관함·계정·업데이트는 쓸 수 없습니다.')}</p>
    {error && <p className="auth-error" role="alert">{translateMessage(error)}</p>}
    {!overview ? !error && <LoaderCircle className="spin" aria-label={t('연결 중')} /> : <>
      {overview.error && <p className="auth-error">{translateMessage(overview.error)}</p>}
      <section><h3>{t('주소')}</h3>
        {endpoint ? <div className="remote-mcp-copy"><code>{endpoint}</code>
          <button type="button" className="icon-button" title={t('복사')} aria-label={t('주소 복사')} onClick={() => void copy('endpoint', endpoint)}>{copied === 'endpoint' ? <Check size={15} /> : <Copy size={15} />}</button></div>
          : <p className="auth-hint">{t('HTTPS 공개 주소가 설정되지 않아 외부 MCP를 쓸 수 없습니다.')}</p>}
      </section>
      {created && <section className="remote-mcp-created" aria-live="polite"><h3>{t('새 키 · 지금 한 번만 보입니다')}</h3>
        <div className="remote-mcp-copy"><code>{created.key}</code>
          <button type="button" className="icon-button" title={t('복사')} aria-label={t('키 복사')} onClick={() => void copy('key', created.key)}>{copied === 'key' ? <Check size={15} /> : <Copy size={15} />}</button></div>
        {setup && <>
          <p className="auth-hint">{t('Claude Code')}</p>
          <div className="remote-mcp-copy"><pre>{setup.claude}</pre>
            <button type="button" className="icon-button" title={t('복사')} aria-label={t('Claude Code 명령 복사')} onClick={() => void copy('claude', setup.claude)}>{copied === 'claude' ? <Check size={15} /> : <Copy size={15} />}</button></div>
          <p className="auth-hint">{t('Codex (~/.codex/config.toml)')}</p>
          <div className="remote-mcp-copy"><pre>{setup.codex}</pre>
            <button type="button" className="icon-button" title={t('복사')} aria-label={t('Codex 설정 복사')} onClick={() => void copy('codex', setup.codex)}>{copied === 'codex' ? <Check size={15} /> : <Copy size={15} />}</button></div>
          <p className="auth-hint">{t('Codex를 실행하는 셸의 환경 변수 (설정 파일에 넣지 마세요)')}</p>
          <div className="remote-mcp-copy"><pre>{setup.codexEnv}</pre>
            <button type="button" className="icon-button" title={t('복사')} aria-label={t('Codex 환경 변수 복사')} onClick={() => void copy('codex-env', setup.codexEnv)}>{copied === 'codex-env' ? <Check size={15} /> : <Copy size={15} />}</button></div>
          <p className="auth-hint">{t('처음 연결할 때 Cloudflare Access 로그인 창이 열립니다(Claude Code는 /mcp, Codex는 codex mcp login tower-remote).')}</p>
        </>}
        <button type="button" className="secondary-button" onClick={() => setCreated(null)}>{t('닫기')}</button>
      </section>}
      <section><h3>{t('키')} <span className="auth-count">{overview.keys.length}</span></h3>
        {overview.keys.length ? <ul className="notification-devices">{overview.keys.map(key => <li key={key.id}>
          <div><strong><KeyRound size={13} /> {key.name}</strong><small>{key.scope === 'write' ? t('읽기·쓰기') : t('읽기 전용')} · …{key.hint} · {t('만듦 {0}', { 0: date(key.createdAt) })} · {t('마지막 사용 {0}', { 0: date(key.lastUsedAt) })}</small></div>
          <button className="icon-button" title={t('폐기')} aria-label={t('{0} 폐기', { 0: key.name })} disabled={busy}
            onClick={() => void act(() => post<RemoteMcpOverview>('/api/remote-mcp/revoke', token, { id: key.id }))}><Trash2 size={15} /></button>
        </li>)}</ul> : <p className="auth-hint">{t('만든 키가 없습니다.')}</p>}
      </section>
      <section><h3>{t('새 키 만들기')}</h3>
        <form className="remote-mcp-form" onSubmit={event => void create(event)}>
          <label>{t('이름')}<input value={name} maxLength={60} required placeholder={t('예: 노트북 Claude Code')} onChange={event => setName(event.target.value)} /></label>
          <fieldset><legend>{t('권한')}</legend>
            <label><input type="radio" name="remote-mcp-scope" checked={scope === 'read'} onChange={() => setScope('read')} />{t('읽기 전용')}<small>{t('조회만 합니다. 바꾸는 요청은 거절합니다.')}</small></label>
            <label><input type="radio" name="remote-mcp-scope" checked={scope === 'write'} onChange={() => setScope('write')} />{t('읽기·쓰기')}<small>{t('세션 시작, 메시지, 트리거, 터미널 입력처럼 바꾸는 요청도 합니다.')}</small></label>
          </fieldset>
          {overview.passwordRequired && <label>{t('Tower 비밀번호')}<input type="password" autoComplete="current-password" value={password} required onChange={event => setPassword(event.target.value)} /></label>}
          <button type="submit" className="secondary-button" disabled={busy || !name.trim() || (overview.passwordRequired && !password)}>{busy ? <LoaderCircle className="spin" size={14} /> : <KeyRound size={14} />}{t('키 만들기')}</button>
        </form>
      </section>
    </>}
  </SettingsPane>;
}
