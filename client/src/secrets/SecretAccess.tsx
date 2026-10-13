import { useState, type FormEvent } from 'react';
import { MIN_VAULT_PASSWORD, type VaultStatus } from '../../../shared/secrets';
import { useI18n } from '../i18n/i18n';
import { unlockMode, unlockReady, unlockRequest, type UnlockMode } from './secrets-client';

/**
 * Sends one vault action; true once it is applied. `refused` sees a refusal's code first (`needs-recovery` …) and
 * returns true when it handled it, so no general error is shown.
 */
export type SecretChange = (action: string, body: unknown, refused?: (code: string) => boolean) => Promise<boolean>;

/**
 * A locked vault's password fields for `mode`, with a small switch between the Tower password and the recovery
 * password alone (none without Tower-password support, where the vault password is the only way).
 */
export function SecretUnlockFields({ mode, password, recoveryPassword, disabled, autoFocus, onPassword, onRecoveryPassword, onRecovery }: {
  mode: UnlockMode; password: string; recoveryPassword: string; disabled: boolean; autoFocus?: boolean;
  onPassword: (value: string) => void; onRecoveryPassword: (value: string) => void; onRecovery: (recovery: boolean) => void;
}) {
  const { t } = useI18n();
  const label = mode === 'vault' ? '비밀번호' : mode === 'recovery' ? '복구 비밀번호(기존 보관함 비밀번호)' : 'Tower 비밀번호';
  return <>
    <label>{t(label)}<input type="password" autoComplete={mode === 'recovery' ? 'off' : 'current-password'} autoFocus={autoFocus} value={password} required disabled={disabled} onChange={event => onPassword(event.target.value)} /></label>
    {mode === 'both' && <>
      <p className="secret-hint">{t('보관함이 아직 이 Tower 비밀번호와 연결되지 않았습니다. 복구 비밀번호를 한 번 함께 입력하면 다음부터는 Tower 비밀번호만으로 열립니다.')}</p>
      <label>{t('복구 비밀번호(기존 보관함 비밀번호)')}<input type="password" autoComplete="off" value={recoveryPassword} required disabled={disabled} onChange={event => onRecoveryPassword(event.target.value)} /></label>
    </>}
    {mode !== 'vault' && <button type="button" className="secret-unlock-switch" disabled={disabled} onClick={() => onRecovery(mode !== 'recovery')}>{t(mode === 'recovery' ? 'Tower 비밀번호로 열기' : '복구 비밀번호로 열기')}</button>}
  </>;
}

/** Sets up or opens the vault: in the settings and in the chat's second tab. */
export function SecretAccess({ status, busy, change }: { status: VaultStatus; busy: boolean; change: SecretChange }) {
  const { t } = useI18n();
  const [password, setPassword] = useState(''); const [recoveryPassword, setRecoveryPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  // The owner's switch to the recovery password alone, and the server asking for it with the Tower password.
  const [recovery, setRecovery] = useState(false); const [asked, setAsked] = useState(false);
  const setup = !status.initialized; const mode = unlockMode(status.towerPassword, { recovery, asked });
  const submit = async (event: FormEvent) => {
    event.preventDefault(); event.stopPropagation();
    const input = password; const second = recoveryPassword;
    setPassword(''); setRecoveryPassword(''); setConfirmation('');
    if (setup) { await change('initialize', { password: input }); return; }
    const [action, body] = unlockRequest(mode, input, second);
    await change(action, body, code => {
      if (code !== 'needs-recovery' || mode !== 'tower') return false;
      // Only the recovery password is missing: the Tower password just typed stays, and both are sent next.
      setAsked(true); setPassword(input);
      return true;
    });
  };
  const choose = (next: boolean) => { setPassword(''); setRecoveryPassword(''); setRecovery(next); };
  const ready = setup ? password.length >= MIN_VAULT_PASSWORD && password === confirmation : unlockReady(mode, password, recoveryPassword);
  const description = setup ? '비밀번호로 암호화하여 이 컴퓨터에 보관합니다.' : mode === 'vault' ? '보관함 비밀번호를 입력하세요.'
    : mode === 'recovery' ? '복구 비밀번호로 보관함을 엽니다. 값을 보려면 Tower 비밀번호가 따로 필요합니다.' : 'Tower에 로그인하는 비밀번호로 보관함을 엽니다.';
  return <form className="secret-form" onSubmit={event => void submit(event)}>
    <h3>{t(setup ? '시크릿 보관함 만들기' : '시크릿 보관함 잠금 해제')}</h3>
    <p>{t(description)}</p>
    {setup ? <>
      <label>{t('비밀번호')}<input type="password" autoComplete="new-password" autoFocus value={password} minLength={MIN_VAULT_PASSWORD} required disabled={busy} onChange={event => setPassword(event.target.value)} /></label>
      <p>{t('비밀번호는 12자 이상이어야 합니다.')}</p><label>{t('비밀번호 확인')}<input type="password" autoComplete="new-password" value={confirmation} required disabled={busy} onChange={event => setConfirmation(event.target.value)} /></label>
    </> : <SecretUnlockFields mode={mode} password={password} recoveryPassword={recoveryPassword} disabled={busy} autoFocus onPassword={setPassword} onRecoveryPassword={setRecoveryPassword} onRecovery={choose} />}
    <button type="submit" disabled={busy || !ready}>{t(setup ? '보관함 만들기' : '잠금 해제')}</button>
  </form>;
}
export function SecretPassword({ busy, change, onClose }: { busy: boolean; change: SecretChange; onClose: () => void }) {
  const { t } = useI18n();
  const [currentPassword, setCurrent] = useState(''); const [next, setNext] = useState(''); const [confirmation, setConfirmation] = useState('');
  return <form className="secret-form" onSubmit={async event => { event.preventDefault(); event.stopPropagation(); const body = { currentPassword, newPassword: next }; setCurrent(''); setNext(''); setConfirmation(''); if (await change('password', body)) onClose(); }}>
    <h3>{t('보관함 비밀번호 변경')}</h3>
    <label>{t('현재 비밀번호')}<input autoFocus type="password" autoComplete="current-password" value={currentPassword} required disabled={busy} onChange={event => setCurrent(event.target.value)} /></label>
    <label>{t('새 비밀번호')}<input type="password" autoComplete="new-password" minLength={MIN_VAULT_PASSWORD} value={next} required disabled={busy} onChange={event => setNext(event.target.value)} /></label>
    <label>{t('비밀번호 확인')}<input type="password" autoComplete="new-password" value={confirmation} required disabled={busy} onChange={event => setConfirmation(event.target.value)} /></label>
    <div className="secret-actions"><button type="button" onClick={onClose}>{t('취소')}</button><button type="submit" disabled={busy || !currentPassword || next.length < MIN_VAULT_PASSWORD || next !== confirmation}>{t('변경')}</button></div>
  </form>;
}
