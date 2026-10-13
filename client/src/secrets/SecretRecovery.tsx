import { useRef, useState, useEffect } from 'react';
import type { SecretMetadata } from '../../../shared/secrets';
import { useI18n } from '../i18n/i18n';
import type { SecretChange } from './SecretAccess';
import { readSecretFile } from './secrets-client';

export function SecretPendingImport({ ids, busy, change, onClose }: { ids: string[]; busy: boolean; change: SecretChange; onClose: () => void }) {
  const { t } = useI18n(); const [id, setId] = useState(ids[0] || ''); const [password, setPassword] = useState('');
  return <form className="secret-form" onSubmit={async event => { event.preventDefault(); event.stopPropagation(); const input = password; setPassword(''); if (await change('import', { id, password: input })) onClose(); }}>
    <h3>{t('암호화한 보관함 가져오기')}</h3><p>{t('백업의 시크릿 보관함은 암호화되어 있습니다. 원본 보관함의 비밀번호로 열어 이 보관함에 가져옵니다.')}</p>
    <label>{t('가져올 보관함')}<select value={id} disabled={busy} onChange={event => { setPassword(''); setId(event.target.value); }}>{ids.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
    <label>{t('원본 보관함 비밀번호')}<input autoFocus type="password" autoComplete="off" value={password} required disabled={busy} onChange={event => setPassword(event.target.value)} /></label>
    <div className="secret-actions"><button type="button" onClick={() => { setPassword(''); onClose(); }}>{t('취소')}</button><button type="submit" disabled={busy || !password || !ids.includes(id)}>{t('보관함 가져오기')}</button></div>
  </form>;
}

/** Replaces a saved value (`update`); the value view and editing of PR3 replace it. */
export function SecretValueEditor({ secret, busy, change, onClose }: { secret: SecretMetadata; busy: boolean; change: SecretChange; onClose: () => void }) {
  const { t } = useI18n(); const [raw, setRaw] = useState(''); const [fileSelected, setFileSelected] = useState(false); const [reading, setReading] = useState(false); const [error, setError] = useState(''); const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  return <form className="secret-form" onSubmit={async event => {
    event.preventDefault(); event.stopPropagation(); const body = { id: secret.id, ...(secret.kind === 'file' ? { content: raw } : { value: raw }) }; generation.current++; setRaw(''); setFileSelected(false);
    if (await change('update', body)) onClose();
  }}><h3>{t('시크릿 값 교체')} · {secret.name}</h3><p>{t('새 값을 저장하면 시크릿 버전이 올라가고, 다음 사용부터 새 값이 전달됩니다.')}</p>
    {secret.kind === 'file' ? <label>{t('파일 선택')}<input autoFocus type="file" disabled={busy || reading} onChange={async event => {
      const file = event.target.files?.[0]; event.currentTarget.value = ''; const current = ++generation.current; setRaw(''); setFileSelected(false); setError(''); if (!file) return;
      setReading(true);
      try { const content = await readSecretFile(file); if (current === generation.current) { setRaw(content); setFileSelected(true); } }
      catch (failure) { if (current === generation.current) setError(t(failure instanceof RangeError ? '파일은 1 MiB 이하여야 합니다.' : '파일을 읽지 못했습니다.')); }
      finally { if (current === generation.current) setReading(false); }
    }} /></label> : <label>{t(secret.kind === 'env' ? '.env 내용' : '값')}<textarea autoFocus value={raw} rows={secret.kind === 'env' ? 6 : 3} disabled={busy} autoComplete="off" spellCheck={false} onChange={event => setRaw(event.target.value)} /></label>}
    {error && <p role="alert">{error}</p>}
    <div className="secret-actions"><button type="button" onClick={() => { generation.current++; setRaw(''); setFileSelected(false); onClose(); }}>{t('취소')}</button><button type="submit" disabled={busy || reading || (secret.kind === 'file' && !fileSelected)}>{t('값 교체')}</button></div>
  </form>;
}
