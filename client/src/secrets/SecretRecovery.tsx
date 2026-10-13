import { useState } from 'react';
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
