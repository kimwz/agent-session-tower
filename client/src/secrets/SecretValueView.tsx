import { useEffect, useMemo, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import type { SecretMetadata, SecretValue } from '../../../shared/secrets';
import { useI18n } from '../i18n/i18n';
import type { SecretChange } from './SecretAccess';
import { filePreview, fileSize, readSecretFile, saveSecretFile, secretBytes, valueText } from './secrets-client';

/**
 * The one value slot the owner opened in the settings list: asked for (`want`: read once value viewing is on), being
 * read, or read. Values live here, in component state, and nowhere else.
 */
export interface ValueSlot { id: string; edit: boolean; want?: boolean; loading?: boolean; value?: SecretValue }
/** The list's value view: its slot and what a row may ask of it. */
export interface ValueControls {
  slot?: ValueSlot; valueView: boolean;
  open(secret: SecretMetadata, edit: boolean): void;
  close(): void;
  /** Turns value viewing on for this browser with the Tower password. */
  unlock(password: string): Promise<void>;
}

/** A row's value: masked, with show (hide once shown) and edit. */
export function SecretValueCell({ secret, slot, remote, busy, values }: { secret: SecretMetadata; slot?: ValueSlot; remote: boolean; busy: boolean; values: ValueControls }) {
  const { t } = useI18n();
  const shown = !!slot?.value && !slot.edit && values.valueView;
  return <div className="secret-value">
    <span className="secret-value-mask" aria-hidden="true">••••••••</span><span className="sr-only">{t('값 숨김')}</span>
    {/* Another vault's secret is read and changed at its source. */}
    {!remote && <span className="secret-value-actions">
      <button type="button" disabled={busy || !!slot?.loading} aria-expanded={!!slot && !slot.edit} aria-label={t(shown ? '{0} 값 숨기기' : '{0} 값 보기', { 0: secret.name })} onClick={() => shown ? values.close() : values.open(secret, false)}>{t(shown ? '숨기기' : '보기')}</button>
      <button type="button" disabled={busy || !!slot?.loading} aria-label={t('{0} 값 수정', { 0: secret.name })} onClick={() => values.open(secret, true)}>{t('수정')}</button>
    </span>}
  </div>;
}

/** Below an opened row: the Tower-password prompt while value viewing is off, then the value. */
export function SecretValuePanel({ secret, slot, valueView, busy, onUnlock, onClose }: {
  secret: SecretMetadata; slot: ValueSlot; valueView: boolean; busy: boolean; onUnlock: (password: string) => Promise<void>; onClose: () => void;
}) {
  const { t } = useI18n();
  if (!valueView) return <SecretViewUnlock name={secret.name} busy={busy} onUnlock={onUnlock} onCancel={onClose} />;
  if (slot.loading) return <p role="status" className="secret-value-panel">{t('불러오는 중…')}</p>;
  return slot.value && !slot.edit ? <SecretValueShown name={secret.name} value={slot.value} /> : null;
}

/** Asks for the Tower password inline, once per signed-in browser until value viewing is locked again. */
export function SecretViewUnlock({ name, busy, onUnlock, onCancel }: { name: string; busy: boolean; onUnlock: (password: string) => Promise<void>; onCancel: () => void }) {
  const { t } = useI18n(); const [password, setPassword] = useState('');
  return <form className="secret-form secret-value-panel" aria-label={t('{0} 값 보기', { 0: name })} onSubmit={event => {
    event.preventDefault(); event.stopPropagation();
    const input = password; setPassword(''); void onUnlock(input);
  }}>
    <label>{t('Tower 비밀번호')}<input type="password" autoFocus autoComplete="current-password" value={password} required disabled={busy} onChange={event => setPassword(event.target.value)} /></label>
    <p>{t('값을 보거나 고치려면 Tower 비밀번호를 입력하세요.')}</p>
    <div className="secret-actions"><button type="button" onClick={onCancel}>{t('취소')}</button><button type="submit" disabled={busy || !password}>{t('확인')}</button></div>
  </form>;
}

/** A read value: text in a read-only block; a file's size, its text when it is short UTF-8, and saving it as a file. */
export function SecretValueShown({ name, value }: { name: string; value: SecretValue }) {
  const { t } = useI18n();
  const preview = useMemo(() => value.kind === 'file' ? filePreview(value.content ?? '') : undefined, [value]);
  // A scrolling block a keyboard can reach and scroll.
  const block = (text: string) => <pre className="secret-value-text" role="region" tabIndex={0} aria-label={t('{0} 값', { 0: name })}>{text}</pre>;
  if (!preview) return <div className="secret-value-panel">{block(valueText(value))}</div>;
  return <div className="secret-value-panel">
    <div className="secret-section-head"><span className="secret-hint">{t('파일 · {0}', { 0: fileSize(preview.size) })}</span>
      <button type="button" onClick={() => saveSecretFile(name, value.content ?? '')}><Download size={14} aria-hidden="true" />{t('파일로 저장')}</button></div>
    {preview.text !== undefined ? block(preview.text) : <p className="secret-hint">{t('텍스트가 아니거나 64 KiB보다 커서 미리 볼 수 없습니다.')}</p>}
  </div>;
}

/** Edits a read value: its text prefilled, or a new file; saved against the version that was read. */
export function SecretValueForm({ secret, value, busy, change, onClose }: { secret: SecretMetadata; value: SecretValue; busy: boolean; change: SecretChange; onClose: () => void }) {
  const { t } = useI18n(); const file = value.kind === 'file';
  const original = useMemo(() => file ? '' : valueText(value), [file, value]);
  const size = useMemo(() => file ? secretBytes(value.content ?? '').length : 0, [file, value]);
  const [raw, setRaw] = useState(original); const [fileName, setFileName] = useState(''); const [reading, setReading] = useState(false); const [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const changed = file ? !!fileName : raw !== original;
  return <form className="secret-form" onSubmit={async event => {
    event.preventDefault(); event.stopPropagation();
    if (busy || reading || !changed) return;
    // The draft stays until the answer: a failed save can be sent again, and a value changed elsewhere is refused, not overwritten.
    if (await change('value-update', { secretId: secret.id, expectedVersion: value.version, ...(file ? { content: raw } : { value: raw }) })) onClose();
  }}><h3>{t('시크릿 값 수정')} · {secret.name}</h3><p>{t('새 값을 저장하면 시크릿 버전이 올라가고, 다음 사용부터 새 값이 전달됩니다.')}</p>
    {file ? <>
      <p>{t('현재 파일 · {0}', { 0: fileSize(size) })}</p>
      <label>{t('새 파일 선택')}<input autoFocus type="file" disabled={busy || reading} onChange={async event => {
        const picked = event.target.files?.[0]; event.currentTarget.value = ''; const current = ++generation.current; setRaw(''); setFileName(''); setError(''); if (!picked) return;
        setReading(true);
        try { const content = await readSecretFile(picked); if (current === generation.current) { setRaw(content); setFileName(picked.name); } }
        catch (failure) { if (current === generation.current) setError(t(failure instanceof RangeError ? '파일은 1 MiB 이하여야 합니다.' : '파일을 읽지 못했습니다.')); }
        finally { if (current === generation.current) setReading(false); }
      }} /></label>
      {fileName && <p className="secret-hint">{fileName}</p>}
    </> : <label>{t(value.kind === 'env' ? '.env 내용' : '값')}<textarea autoFocus value={raw} rows={value.kind === 'env' ? 8 : 3} disabled={busy} autoComplete="off" spellCheck={false} onChange={event => setRaw(event.target.value)} /></label>}
    {error && <p role="alert" className="secret-error">{error}</p>}
    <div className="secret-actions"><button type="button" onClick={onClose}>{t('취소')}</button><button type="submit" className="secret-save" disabled={busy || reading || !changed}>{t('저장')}</button></div>
  </form>;
}
