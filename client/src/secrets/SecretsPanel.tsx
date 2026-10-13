import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { SecretSettingsView } from '../../../shared/secrets';
import { useI18n } from '../i18n/i18n';
import { SettingsFrameContext, SettingsPane } from '../settings/SettingsPane';
import type { SecretChange } from './SecretAccess';
import type { SecretComputer } from './SecretAdvanced';
import { SecretSettingsWorkspace } from './SecretSettings';
import { failureCode, postSecret, readSecretSettings, secretFailure, secretLoadFailure, sharingConflict, emptyCanvas, type SecretCanvas } from './secrets-client';

/** The settings view, read when the section is shown and replaced by every change's answer; never polled. A read is dropped once a change started after it. */
function useSecretSettings(token: string, active: boolean) {
  const { t } = useI18n();
  const [view, setView] = useState<SecretSettingsView>(); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [loadError, setLoadError] = useState(''); const [notice, setNotice] = useState(''); const [revision, setRevision] = useState(0);
  const generation = useRef(0); const mutating = useRef(false); const changes = useRef(0);
  useEffect(() => { generation.current++; setView(undefined); setError(''); setLoadError(''); setNotice(''); setBusy(false); mutating.current = false; }, [token]);
  useEffect(() => {
    if (!active || !token) return;
    const controller = new AbortController(); const current = generation.current; const started = mutating.current ? -1 : changes.current;
    readSecretSettings(controller.signal).then(next => {
      if (!controller.signal.aborted && current === generation.current && started === changes.current && !mutating.current) { setView(next); setLoadError(''); }
    }, failure => { if (!controller.signal.aborted && current === generation.current && started === changes.current) setLoadError(secretLoadFailure(failure, t)); });
    return () => controller.abort();
  }, [token, active, revision, t]);
  const reload = useCallback(() => { setError(''); setRevision(value => value + 1); }, []);
  const change: SecretChange = useCallback(async (action, body, refused) => {
    if (mutating.current || !active || !token) return false;
    const current = generation.current; mutating.current = true; changes.current++; setBusy(true); setError(''); setNotice('');
    try {
      const next = await postSecret<SecretSettingsView>(action, token, body);
      if (current !== generation.current) return false;
      setView(next); setLoadError('');
      return true;
    } catch (failure) {
      if (current !== generation.current) return false;
      const code = failureCode(failure);
      if (code && refused?.(code)) return false;
      // A stale revision: show what is stored now; the editor starts again from it.
      if (action === 'sharing' && sharingConflict(failure)) { setNotice(t('공유 설정이 다른 곳에서 바뀌었습니다. 지금 저장된 내용을 불러왔으니 확인한 뒤 다시 저장하세요.')); setRevision(value => value + 1); }
      else setError(secretFailure(failure, t));
      return false;
    } finally { if (current === generation.current) { mutating.current = false; setBusy(false); } }
  }, [active, token, t]);
  return { view, busy, error: error || loadError, notice, change, reload };
}

export function SecretsPanel({ token, computers = [], canvas = emptyCanvas, focus }: { token: string; computers?: SecretComputer[]; canvas?: SecretCanvas; focus?: string }) {
  const { t } = useI18n(); const frame = useContext(SettingsFrameContext); const state = useSecretSettings(token, frame.active);
  return <SettingsPane title={t('시크릿')} description={t('등록한 시크릿과 각 시크릿의 공유 범위를 관리합니다.')} scope="secrets-pane">
    {state.error && <p role="alert" className="secret-error">{state.error}<button type="button" onClick={state.reload}>{t('다시 시도')}</button></p>}
    {state.notice && <p role="status" className="secret-notice-line">{state.notice}</p>}
    {frame.active && (state.view ? <SecretSettingsWorkspace key={state.view.status.locked ? 'locked' : 'open'} view={state.view} canvas={canvas} computers={computers} busy={state.busy} change={state.change} focus={focus} reload={state.reload} /> : <p role="status">{t('불러오는 중…')}</p>)}
  </SettingsPane>;
}
