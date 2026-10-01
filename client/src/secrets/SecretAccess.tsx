import { useState, type FormEvent } from 'react';
import { MIN_VAULT_PASSWORD, type VaultStatus } from '../../../shared/secrets';
import { useI18n } from '../i18n/i18n';

export type SecretChange = (action: string, body: unknown) => Promise<boolean>;
export function SecretAccess({ status, busy, change }: { status: VaultStatus; busy: boolean; change: SecretChange }) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const setup = !status.initialized;
  const submit = async (event: FormEvent) => {
    event.preventDefault(); event.stopPropagation();
    const input = password;
    setPassword(''); setConfirmation('');
    await change(setup ? 'initialize' : 'unlock', { password: input });
  };
  return <form className="secret-form" onSubmit={event => void submit(event)}>
    <h3>{t(setup ? '시크릿 보관함 만들기' : '시크릿 보관함 잠금 해제')}</h3>
    <p>{t(setup ? '비밀번호로 암호화하여 이 컴퓨터에 보관합니다.' : '보관함 비밀번호를 입력하세요.')}</p>
    <label>{t('비밀번호')}<input type="password" autoComplete={setup ? 'new-password' : 'current-password'} autoFocus value={password} minLength={setup ? MIN_VAULT_PASSWORD : undefined} required disabled={busy} onChange={event => setPassword(event.target.value)} /></label>
    {setup && <><p>{t('비밀번호는 12자 이상이어야 합니다.')}</p><label>{t('비밀번호 확인')}<input type="password" autoComplete="new-password" value={confirmation} required disabled={busy} onChange={event => setConfirmation(event.target.value)} /></label></>}
    <button type="submit" disabled={busy || !password || (setup && (password.length < MIN_VAULT_PASSWORD || password !== confirmation))}>{t(setup ? '보관함 만들기' : '잠금 해제')}</button>
  </form>;
}
export function SecretPassword({ busy, change, onClose }: { busy: boolean; change: SecretChange; onClose: () => void }) {
  const { t } = useI18n();
  const [currentPassword, setCurrent] = useState(''); const [next, setNext] = useState(''); const [confirmation, setConfirmation] = useState('');
  return <form className="secret-form" onSubmit={async event => { event.preventDefault(); event.stopPropagation(); const body = { currentPassword, newPassword: next }; setCurrent(''); setNext(''); setConfirmation(''); if (await change('password', body)) onClose(); }}>
    <h3>{t('비밀번호 변경')}</h3>
    <label>{t('현재 비밀번호')}<input autoFocus type="password" autoComplete="current-password" value={currentPassword} required disabled={busy} onChange={event => setCurrent(event.target.value)} /></label>
    <label>{t('새 비밀번호')}<input type="password" autoComplete="new-password" minLength={MIN_VAULT_PASSWORD} value={next} required disabled={busy} onChange={event => setNext(event.target.value)} /></label>
    <label>{t('비밀번호 확인')}<input type="password" autoComplete="new-password" value={confirmation} required disabled={busy} onChange={event => setConfirmation(event.target.value)} /></label>
    <div className="secret-actions"><button type="button" onClick={onClose}>{t('취소')}</button><button type="submit" disabled={busy || !currentPassword || next.length < MIN_VAULT_PASSWORD || next !== confirmation}>{t('변경')}</button></div>
  </form>;
}
