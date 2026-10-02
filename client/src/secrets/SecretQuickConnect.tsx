import { useEffect, useRef, useState } from 'react';
import { Check, FileKey, Search } from 'lucide-react';
import { MAX_SECRET_BYTES, MIN_VAULT_PASSWORD, type SecretOverview } from '../../../shared/secrets';
import { useI18n } from '../i18n/i18n';
import type { SecretChange } from './SecretAccess';
import { isRemoteSecret, quickSecretKind, quickSecretPayload, savedSecretMatches, type QuickSecretFormat } from './secrets-client';

export function SecretQuickConnect({ overview, busy, change, onConnected, onManage }: { overview: SecretOverview; busy: boolean; change: SecretChange; onConnected: () => void; onManage: () => void }) {
  const { t } = useI18n();
  const [raw, setRaw] = useState(''); const [name, setName] = useState(''); const [format, setFormat] = useState<QuickSecretFormat>('auto');
  const [save, setSave] = useState(false); const [destination, setDestination] = useState('project');
  const [fileName, setFileName] = useState(''); const [reading, setReading] = useState(false); const [submitting, setSubmitting] = useState(false);
  const [password, setPassword] = useState(''); const [confirmation, setConfirmation] = useState(''); const [query, setQuery] = useState(''); const [error, setError] = useState('');
  const generation = useRef(0); const sending = useRef(false);
  useEffect(() => () => { generation.current++; }, []);
  const needsAccess = overview.status.locked || !overview.status.initialized; const setup = !overview.status.initialized;
  const disabled = busy || submitting || reading;
  const kind = quickSecretKind(raw, format);
  const saved = overview.secrets.filter(secret => savedSecretMatches(overview, secret, query));
  const groups = overview.groups.filter(group => group.scope !== 'task' && (group.scope !== 'project' || group.projectId === (overview.target?.projectId ?? overview.currentProjectId)) && !overview.secrets.some(secret => secret.groupId === group.id && isRemoteSecret(secret, overview.device?.id)));
  const hasInput = format === 'file' ? !!fileName : raw.length > 0;
  const accessReady = !!password && (!setup || (password.length >= MIN_VAULT_PASSWORD && password === confirmation));
  const clearValue = () => { generation.current++; setRaw(''); setFileName(''); };
  const submit = async () => {
    if (sending.current || disabled || (!hasInput && !needsAccess) || (needsAccess && !accessReady)) return;
    sending.current = true; setSubmitting(true); setError('');
    const payload = hasInput ? quickSecretPayload(overview, raw, format, name, save ? destination : 'task', fileName) : undefined;
    const accessPassword = password;
    clearValue(); setPassword(''); setConfirmation('');
    const current = generation.current;
    try {
      if (needsAccess && !await change(setup ? 'initialize' : 'unlock', { password: accessPassword })) return;
      if (payload && await change('create', payload) && current === generation.current) onConnected();
    } finally { sending.current = false; if (current === generation.current) setSubmitting(false); }
  };
  return <div className="secret-quick">
    <form className="secret-form secret-quick-form" onSubmit={event => { event.preventDefault(); event.stopPropagation(); void submit(); }}>
      <label className="secret-paste-label">{t('시크릿 붙여넣기')}
        {format === 'file' ? <input autoFocus type="file" disabled={disabled} onChange={async event => {
          const file = event.target.files?.[0]; event.currentTarget.value = ''; clearValue(); setError(''); if (!file) return;
          if (file.size > MAX_SECRET_BYTES) { setError(t('파일은 1 MiB 이하여야 합니다.')); return; }
          const current = generation.current; setReading(true);
          try { const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); if (current === generation.current) { setRaw(btoa(binary)); setFileName(file.name); } }
          catch { if (current === generation.current) setError(t('파일을 읽지 못했습니다.')); }
          finally { if (current === generation.current) setReading(false); }
        }} /> : <textarea autoFocus rows={5} value={raw} disabled={disabled} autoComplete="off" spellCheck={false} placeholder={t('비밀번호, API 키 또는 .env 내용을 붙여넣으세요.')} onChange={event => { setRaw(event.target.value); setError(''); }} />}
      </label>
      <div className="secret-quick-format"><span>{fileName || t(kind === 'env' ? '.env로 연결합니다' : kind === 'file' ? '비공개 파일로 연결합니다' : '단일 값으로 연결합니다')}</span><label>{t('입력 형식')}<select value={format} disabled={disabled} onChange={event => { const next = event.target.value as QuickSecretFormat; if (format === 'file' || next === 'file') clearValue(); setFormat(next); }}><option value="auto">{t('자동 감지')}</option><option value="scalar">{t('단일 값')}</option><option value="env">.env</option><option value="file">{t('파일')}</option></select></label></div>
      <p className="secret-quick-note">{t('확인하면 이 작업에서 바로 사용할 수 있습니다. 값은 대화에 남지 않습니다.')}</p>
      <label className="secret-check secret-save-check"><input type="checkbox" checked={save} disabled={disabled} onChange={event => setSave(event.target.checked)} />{t('다음에도 쓰도록 저장')}</label>
      {save ? <div className="secret-save-options"><label>{t('저장할 보관함')}<select value={destination} disabled={disabled} onChange={event => setDestination(event.target.value)}><option value="project">{t('현재 프로젝트 보관함')}</option><option value="global">{t('전역 보관함')}</option>{groups.map(group => <option key={group.id} value={`group:${group.id}`}>{t(group.scope === 'global' ? '전역' : '프로젝트')} / {group.name}</option>)}</select></label><label>{t('이름 (선택)')}<input value={name} maxLength={128} disabled={disabled} placeholder={kind === 'file' ? fileName : 'SESSION_SECRET'} onChange={event => setName(event.target.value)} /></label><p>{t('다른 세션에서는 저장 목록에서 직접 연결하세요. 자동 연결은 설정에서 정할 수 있습니다.')}</p></div>
        : <details className="secret-quick-details"><summary>{t('이름 지정')}</summary><label>{t('이름 (선택)')}<input value={name} maxLength={128} disabled={disabled} placeholder="SESSION_SECRET" onChange={event => setName(event.target.value)} /></label></details>}
      {needsAccess && <div className="secret-inline-access"><strong>{t(setup ? '처음 한 번, 보관함 비밀번호를 정하세요' : '보관함 잠금 해제')}</strong><p>{t(setup ? '이번 작업의 값도 비밀번호로 암호화합니다. 12자 이상 입력하세요.' : '비밀번호를 입력하면 붙여넣은 값과 저장 목록을 사용할 수 있습니다.')}</p><label>{t('비밀번호')}<input type="password" autoComplete={setup ? 'new-password' : 'current-password'} value={password} required minLength={setup ? MIN_VAULT_PASSWORD : undefined} disabled={disabled} onChange={event => setPassword(event.target.value)} /></label>{setup && <label>{t('비밀번호 확인')}<input type="password" autoComplete="new-password" required value={confirmation} disabled={disabled} onChange={event => setConfirmation(event.target.value)} /></label>}</div>}
      {error && <p role="alert" className="secret-error">{error}</p>}
      <button type="submit" className="secret-primary" disabled={disabled || (!hasInput && !needsAccess) || (needsAccess && !accessReady)}>{t(submitting ? '연결 중…' : hasInput || !needsAccess ? '확인' : setup ? '보관함 만들기' : '잠금 해제')}</button>
    </form>
    <section className="secret-saved"><div className="secret-section-head"><h3>{t('저장된 시크릿')}</h3><button type="button" onClick={onManage}>{t('보관함 설정')}</button></div>
      {!needsAccess && <><label className="secret-search"><Search size={15} aria-hidden="true" /><input type="search" aria-label={t('저장된 시크릿 검색')} placeholder={t('이름, 보관함, 환경 변수 검색')} value={query} onChange={event => setQuery(event.target.value)} /></label>
        {saved.length ? <ul>{saved.map(secret => { const connected = overview.connected.includes(secret.id); const remote = isRemoteSecret(secret, overview.device?.id); const group = overview.groups.find(group => group.id === secret.groupId); return <li key={secret.id}><button type="button" className="secret-saved-key" disabled={disabled || connected || remote} onClick={async () => { const current = generation.current; if (await change('connect', { secretIds: [secret.id], notifySession: true }) && current === generation.current) onConnected(); }}>
          <FileKey size={18} aria-hidden="true" /><span><strong>{secret.name}</strong><small>{t(group?.scope === 'project' ? '프로젝트' : '전역')} / {group?.name}{secret.fields?.length ? ` · ${secret.fields.join(', ')}` : ''}</small></span><em>{connected ? <><Check size={14} />{t('연결됨')}</> : t(remote ? '원본에서 관리' : '연결')}</em>
        </button></li>; })}</ul> : <p className="secret-empty">{t(query ? '검색 결과가 없습니다.' : '저장한 시크릿이 없습니다. 위에서 저장하면 다음에도 다시 연결할 수 있습니다.')}</p>}
      </>}
      {needsAccess && <p className="secret-empty">{t('잠금을 해제하면 저장된 시크릿이 보입니다.')}</p>}
    </section>
  </div>;
}
