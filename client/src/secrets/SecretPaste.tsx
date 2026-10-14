import { useEffect, useRef, useState } from 'react';
import { MIN_VAULT_PASSWORD, type SecretSessionView } from '../../../shared/secrets';
import { useI18n } from '../i18n/i18n';
import { SecretUnlockFields, type SecretChange } from './SecretAccess';
import { pastePayload, quickSecretKind, readSecretFile, sessionBlocked, suggestedSecretName, unlockMode, unlockReady, unlockRequest, type PasteDestination, type QuickSecretFormat } from './secrets-client';

const kindNotes: Record<string, string> = { scalar: '단일 값으로 연결합니다', env: '.env로 연결합니다', file: '비공개 파일로 연결합니다' };

/**
 * The chat's first tab: paste a value (or pick a file) and connect it to this session. Unless saved, it lives only with
 * this session's task. The vault is set up or unlocked inline when needed; raw input is cleared as soon as it is sent.
 */
export function SecretPaste({ view, sessionId, cwd, busy, change, onConnected }: {
  view?: SecretSessionView; sessionId: string; cwd?: string; busy: boolean; change: SecretChange; onConnected: () => void;
}) {
  const { t } = useI18n();
  const [raw, setRaw] = useState(''); const [name, setName] = useState(''); const [format, setFormat] = useState<QuickSecretFormat>('auto');
  const [save, setSave] = useState(false); const [destination, setDestination] = useState<Exclude<PasteDestination, 'session'>>('none');
  const [fileName, setFileName] = useState(''); const [reading, setReading] = useState(false); const [submitting, setSubmitting] = useState(false);
  const [password, setPassword] = useState(''); const [confirmation, setConfirmation] = useState(''); const [recoveryPassword, setRecoveryPassword] = useState(''); const [error, setError] = useState('');
  // As in `SecretAccess`: the owner's switch to the recovery password alone, and the server asking for it as well.
  const [recovery, setRecovery] = useState(false); const [asked, setAsked] = useState(false);
  const generation = useRef(0); const sending = useRef(false);
  useEffect(() => () => { generation.current++; }, []);
  const setup = !!view && !view.status.initialized; const needsAccess = !!view && (setup || view.status.locked);
  const mode = unlockMode(view?.status.towerPassword, { recovery, asked }, view?.status.machineKey);
  const blocked = sessionBlocked(view?.error);
  const disabled = busy || submitting || reading;
  const kind = quickSecretKind(raw, format);
  const hasInput = format === 'file' ? !!fileName : raw.length > 0;
  const accessReady = setup ? password.length >= MIN_VAULT_PASSWORD && password === confirmation : unlockReady(mode, password, recoveryPassword);
  const ready = !disabled && !!view && (hasInput ? !blocked : needsAccess) && (!needsAccess || accessReady);
  const clearValue = () => { generation.current++; setRaw(''); setFileName(''); };
  const submit = async () => {
    if (sending.current || !ready) return;
    sending.current = true; setSubmitting(true); setError('');
    const payload = hasInput ? pastePayload({ raw, format, name, fileName, destination: save ? destination : 'session', sessionId, cwd }) : undefined;
    const accessPassword = password; const [action, body]: [string, Record<string, string>] = setup ? ['initialize', { password }] : unlockRequest(mode, password, recoveryPassword);
    clearValue(); setPassword(''); setConfirmation(''); setRecoveryPassword('');
    const current = generation.current;
    // Only the recovery password is missing: the Tower password just typed stays, and both are sent next.
    const refused = (code: string) => {
      if (code !== 'needs-recovery' || mode !== 'tower') return false;
      setAsked(true); setPassword(accessPassword); return true;
    };
    try {
      if (needsAccess && !await change(action, body, refused)) return;
      if (payload && await change('create', payload) && current === generation.current) { setName(''); onConnected(); }
    } finally { sending.current = false; if (current === generation.current) setSubmitting(false); }
  };
  const label = submitting ? '연결 중…' : !hasInput && needsAccess ? setup ? '보관함 만들기' : '잠금 해제' : save ? '저장하고 이 세션에 연결' : '이 세션에 연결';
  return <form className="secret-form secret-quick-form" onSubmit={event => { event.preventDefault(); event.stopPropagation(); void submit(); }}>
    <label className="secret-paste-label">{t('시크릿 붙여넣기')}
      {format === 'file' ? <input autoFocus type="file" disabled={disabled} onChange={async event => {
        const file = event.target.files?.[0]; event.currentTarget.value = ''; clearValue(); setError(''); if (!file) return;
        const current = generation.current; setReading(true);
        try { const content = await readSecretFile(file); if (current === generation.current) { setRaw(content); setFileName(file.name); } }
        catch (failure) { if (current === generation.current) setError(t(failure instanceof RangeError ? '파일은 1 MiB 이하여야 합니다.' : '파일을 읽지 못했습니다.')); }
        finally { if (current === generation.current) setReading(false); }
      }} /> : <textarea autoFocus rows={5} value={raw} disabled={disabled} autoComplete="off" spellCheck={false} placeholder={t('비밀번호, API 키 또는 .env 내용을 붙여넣으세요.')} onChange={event => { setRaw(event.target.value); setError(''); }} />}
    </label>
    <div className="secret-quick-format"><span>{fileName || t(kindNotes[kind])}</span><label>{t('입력 형식')}<select value={format} disabled={disabled} onChange={event => { const next = event.target.value as QuickSecretFormat; if (format === 'file' || next === 'file') clearValue(); setFormat(next); }}>
      <option value="auto">{t('자동 감지')}</option><option value="scalar">{t('단일 값')}</option><option value="env">.env</option><option value="file">{t('파일')}</option></select></label></div>
    <label className="secret-name-label">{t('이름')}<input value={name} maxLength={128} disabled={disabled} autoComplete="off" placeholder={suggestedSecretName(raw, kind, fileName)} onChange={event => setName(event.target.value)} /></label>
    <p className="secret-quick-note">{t('이 세션에서 바로 사용할 수 있습니다. 값은 대화에 남지 않습니다.')}</p>
    <label className="secret-check secret-save-check"><input type="checkbox" checked={save} disabled={disabled} onChange={event => setSave(event.target.checked)} />{t('보관함에 저장')}</label>
    {save && <fieldset className="secret-save-options"><legend>{t('공유 범위')}</legend>
      <label className="secret-check"><input type="radio" name="secret-destination" checked={destination === 'none'} disabled={disabled} onChange={() => setDestination('none')} />{t('공유 안 함')}</label>
      {cwd && <label className="secret-check"><input type="radio" name="secret-destination" checked={destination === 'folder'} disabled={disabled} onChange={() => setDestination('folder')} />{t('이 폴더')}</label>}
      <label className="secret-check"><input type="radio" name="secret-destination" checked={destination === 'global'} disabled={disabled} onChange={() => setDestination('global')} />{t('모든 내 머신')}</label>
      <p>{t('저장한 시크릿은 다른 세션에서 ‘기존 시크릿 연결’로 다시 쓸 수 있습니다. 공유 범위는 설정에서 바꿀 수 있습니다.')}</p>
    </fieldset>}
    {needsAccess && <div className="secret-inline-access"><strong>{t(setup ? '처음 한 번, 보관함 비밀번호를 정하세요' : '보관함 잠금 해제')}</strong><p>{t(setup ? '이 세션의 값도 비밀번호로 암호화합니다. 12자 이상 입력하세요.' : mode === 'machine' ? '보관함을 열면 붙여넣은 값과 저장한 시크릿을 사용할 수 있습니다.' : '비밀번호를 입력하면 붙여넣은 값과 저장한 시크릿을 사용할 수 있습니다.')}</p>
      {setup ? <>
        <label>{t('비밀번호')}<input type="password" autoComplete="new-password" value={password} required minLength={MIN_VAULT_PASSWORD} disabled={disabled} onChange={event => setPassword(event.target.value)} /></label>
        <label>{t('비밀번호 확인')}<input type="password" autoComplete="new-password" required value={confirmation} disabled={disabled} onChange={event => setConfirmation(event.target.value)} /></label>
      </> : <SecretUnlockFields mode={mode} password={password} recoveryPassword={recoveryPassword} disabled={disabled} onPassword={setPassword} onRecoveryPassword={setRecoveryPassword}
        onRecovery={next => { setPassword(''); setRecoveryPassword(''); setRecovery(next); }} />}</div>}
    {error && <p role="alert" className="secret-error">{error}</p>}
    <button type="submit" className="secret-primary" disabled={!ready}>{t(label)}</button>
  </form>;
}
