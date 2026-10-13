import { useEffect, useRef, useState } from 'react';
import type { SecretSettingsView } from '../../../shared/secrets';
import { useI18n } from '../i18n/i18n';
import type { SecretChange } from './SecretAccess';
import { SecretFolderPicker } from './SecretSharingEditor';
import { addPayload, quickSecretKind, readSecretFile, suggestedSecretName, type QuickSecretFormat, type SecretCanvas } from './secrets-client';

export const formatLabels: Record<string, string> = { scalar: '단일 값으로 저장합니다', env: '.env로 저장합니다', file: '비공개 파일로 저장합니다' };

/** A secret saved from the settings: a name, its value or file, and optionally where it is shared. */
export function SecretAddForm({ view, canvas, busy, change, onClose }: { view: SecretSettingsView; canvas: SecretCanvas; busy: boolean; change: SecretChange; onClose: () => void }) {
  const { t } = useI18n();
  const [raw, setRaw] = useState(''); const [name, setName] = useState(''); const [format, setFormat] = useState<QuickSecretFormat>('auto'); const [fileName, setFileName] = useState('');
  const [global, setGlobal] = useState(false); const [keys, setKeys] = useState<string[]>([]);
  const [reading, setReading] = useState(false); const [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const kind = quickSecretKind(raw, format);
  const hasInput = format === 'file' ? !!fileName : raw.length > 0;
  const clearValue = () => { generation.current++; setRaw(''); setFileName(''); };
  const disabled = busy || reading;
  return <form className="secret-form" onSubmit={async event => {
    event.preventDefault(); event.stopPropagation();
    if (disabled || !hasInput) return;
    const payload = addPayload({ raw, format, name, fileName, global, keys });
    clearValue();
    if (await change('create', payload)) onClose();
  }}>
    <h3>{t('시크릿 추가')}</h3>
    <label>{t('이름')}<input value={name} maxLength={128} disabled={disabled} autoComplete="off" placeholder={suggestedSecretName(raw, kind, fileName)} onChange={event => setName(event.target.value)} /></label>
    <label className="secret-paste-label">{t('값')}
      {format === 'file' ? <input type="file" disabled={disabled} onChange={async event => {
        const file = event.target.files?.[0]; event.currentTarget.value = ''; clearValue(); setError(''); if (!file) return;
        const current = generation.current; setReading(true);
        try { const content = await readSecretFile(file); if (current === generation.current) { setRaw(content); setFileName(file.name); } }
        catch (failure) { if (current === generation.current) setError(t(failure instanceof RangeError ? '파일은 1 MiB 이하여야 합니다.' : '파일을 읽지 못했습니다.')); }
        finally { if (current === generation.current) setReading(false); }
      }} /> : <textarea rows={4} value={raw} disabled={disabled} autoComplete="off" spellCheck={false} placeholder={t('비밀번호, API 키 또는 .env 내용을 붙여넣으세요.')} onChange={event => { setRaw(event.target.value); setError(''); }} />}
    </label>
    <div className="secret-quick-format"><span>{fileName || t(formatLabels[kind])}</span><label>{t('입력 형식')}<select value={format} disabled={disabled} onChange={event => { const next = event.target.value as QuickSecretFormat; if (format === 'file' || next === 'file') clearValue(); setFormat(next); }}>
      <option value="auto">{t('자동 감지')}</option><option value="scalar">{t('단일 값')}</option><option value="env">.env</option><option value="file">{t('파일')}</option></select></label></div>
    <fieldset><legend>{t('공유 (선택)')}</legend>
      <label className="secret-check secret-global-check"><input type="checkbox" checked={global} disabled={disabled} onChange={event => setGlobal(event.target.checked)} />
        <span><strong>GLOBAL</strong><small>{t('모든 컴퓨터의 모든 폴더에서 자동으로 사용합니다.')}</small></span></label>
      <SecretFolderPicker view={view} canvas={canvas} keys={keys} onKeys={setKeys} disabled={disabled} />
      {!global && !keys.length && <p className="secret-hint">{t('아무것도 고르지 않으면 공유하지 않습니다. 채팅의 ‘기존 시크릿 연결’로 세션마다 연결할 수 있습니다.')}</p>}
    </fieldset>
    {error && <p role="alert" className="secret-error">{error}</p>}
    <div className="secret-actions"><button type="button" onClick={() => { clearValue(); onClose(); }}>{t('취소')}</button><button type="submit" className="secret-save" disabled={disabled || !hasInput}>{t('저장')}</button></div>
  </form>;
}
