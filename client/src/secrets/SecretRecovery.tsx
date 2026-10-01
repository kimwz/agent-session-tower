import { useRef, useState, useEffect } from 'react';
import { MAX_SECRET_BYTES, type SecretMetadata } from '../../../shared/secrets';
import { useI18n } from '../i18n/i18n';
import type { SecretChange } from './SecretAccess';

export function SecretPendingImport({ ids, busy, change, onClose }: { ids: string[]; busy: boolean; change: SecretChange; onClose: () => void }) {
  const { t } = useI18n(); const [id, setId] = useState(ids[0] || ''); const [password, setPassword] = useState('');
  return <form className="secret-form" onSubmit={async event => { event.preventDefault(); event.stopPropagation(); const input = password; setPassword(''); if (await change('import', { id, password: input })) onClose(); }}>
    <h3>{t('암호화한 보관함 가져오기')}</h3><p>{t('백업의 시크릿 보관함은 암호화되어 있습니다. 원본 보관함의 비밀번호로 열어 이 보관함에 가져옵니다.')}</p>
    <label>{t('가져올 보관함')}<select value={id} disabled={busy} onChange={event => { setPassword(''); setId(event.target.value); }}>{ids.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
    <label>{t('원본 보관함 비밀번호')}<input autoFocus type="password" autoComplete="off" value={password} required disabled={busy} onChange={event => setPassword(event.target.value)} /></label>
    <div className="secret-actions"><button type="button" onClick={() => { setPassword(''); onClose(); }}>{t('취소')}</button><button type="submit" disabled={busy || !password || !ids.includes(id)}>{t('보관함 가져오기')}</button></div>
  </form>;
}

export function SecretValueEditor({ secret, busy, change, onClose }: { secret: SecretMetadata; busy: boolean; change: SecretChange; onClose: () => void }) {
  const { t } = useI18n(); const [raw, setRaw] = useState(''); const [fileSelected, setFileSelected] = useState(false); const [reading, setReading] = useState(false); const [error, setError] = useState(''); const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  return <form className="secret-form" onSubmit={async event => {
    event.preventDefault(); event.stopPropagation(); const body = { id: secret.id, ...(secret.kind === 'file' ? { content: raw } : { value: raw }) }; generation.current++; setRaw(''); setFileSelected(false);
    if (await change('update', body)) onClose();
  }}><h3>{t('시크릿 값 교체')} · {secret.name}</h3><p>{t('새 값을 저장하면 시크릿 버전이 올라갑니다. 현재 작업에서는 선택한 키 연결로 다시 승인하거나 새 작업을 시작하세요. 기존 최대 사용 시간은 연장되지 않습니다.')}</p>
    {secret.kind === 'file' ? <label>{t('파일 선택')}<input autoFocus type="file" disabled={busy || reading} onChange={async event => {
      const file = event.target.files?.[0]; event.currentTarget.value = ''; const current = ++generation.current; setRaw(''); setFileSelected(false); setError(''); if (!file) return;
      if (file.size > MAX_SECRET_BYTES) { setError(t('파일은 1 MiB 이하여야 합니다.')); return; } setReading(true);
      try { const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); if (current === generation.current) { setRaw(btoa(binary)); setFileSelected(true); } }
      catch { if (current === generation.current) setError(t('파일을 읽지 못했습니다.')); }
      finally { if (current === generation.current) setReading(false); }
    }} /></label> : <label>{t(secret.kind === 'env' ? '.env 내용' : '값')}<textarea autoFocus value={raw} rows={secret.kind === 'env' ? 6 : 3} disabled={busy}  autoComplete="off" spellCheck={false} onChange={event => setRaw(event.target.value)} /></label>}
    {error && <p role="alert">{error}</p>}
    <div className="secret-actions"><button type="button" onClick={() => { generation.current++; setRaw(''); setFileSelected(false); onClose(); }}>{t('취소')}</button><button type="submit" disabled={busy || reading || (secret.kind === 'file' && !fileSelected)}>{t('값 교체')}</button></div>
  </form>;
}
