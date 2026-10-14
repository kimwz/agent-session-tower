import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { SecretSettingsView, SecretValue } from '../../../shared/secrets';
import { useI18n } from '../i18n/i18n';
import { SettingsFrameContext, SettingsPane } from '../settings/SettingsPane';
import type { SecretChange } from './SecretAccess';
import type { SecretComputer } from './SecretAdvanced';
import { SecretSettingsWorkspace } from './SecretSettings';
import { failureCode, LOGIN_EXPIRED, postSecret, readSecretSettings, readSecretValue, secretFailure, secretLoadFailure, staleConflict, emptyCanvas, valueStale, viewLost, type SecretCanvas } from './secrets-client';

/** Value actions whose refusal because value viewing ended asks for the Tower password again. */
const VALUE_ACTIONS = new Set(['value', 'value-update', 'view-lock']);

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
  /**
   * A value action's refusal: a value changed or removed elsewhere reloads what is stored now; value viewing that
   * ended on the server is turned off here too, which drops shown values and asks for the Tower password again.
   */
  const valueRefused = useCallback((action: string, failure: unknown) => {
    if ((action === 'value' || action === 'value-update') && valueStale(failure)) {
      setNotice(t('값이 다른 곳에서 바뀌었습니다. 지금 저장된 내용을 불러왔으니 다시 열어 확인하세요.')); setRevision(value => value + 1); return true;
    }
    if (!VALUE_ACTIONS.has(action) || !viewLost(failure)) return false;
    setView(current => current && { ...current, valueView: false });
    if (failureCode(failure) === 'login-required') setNotice(t(LOGIN_EXPIRED));
    else if (action !== 'view-lock') setNotice(t('값 보기가 잠겼습니다. Tower 비밀번호를 다시 입력하세요.'));
    return true;
  }, [t]);
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
      if (action === 'sharing' && staleConflict(failure)) { setNotice(t('공유 설정이 다른 곳에서 바뀌었습니다. 지금 저장된 내용을 불러왔으니 확인한 뒤 다시 저장하세요.')); setRevision(value => value + 1); }
      else if (!valueRefused(action, failure)) setError(secretFailure(failure, t, action));
      return false;
    } finally { if (current === generation.current) { mutating.current = false; setBusy(false); } }
  }, [active, token, t, valueRefused]);
  /** Reads one value for the owner's view; undefined once refused, the refusal handled as a change's is. */
  const reveal = useCallback(async (secretId: string, expectedVersion: number): Promise<SecretValue | undefined> => {
    if (!active || !token) return undefined;
    const current = generation.current; setError(''); setNotice('');
    try {
      const value = await readSecretValue(token, secretId, expectedVersion);
      return current === generation.current ? value : undefined;
    } catch (failure) {
      if (current === generation.current && !valueRefused('value', failure)) setError(secretFailure(failure, t, 'value'));
      return undefined;
    }
  }, [active, token, t, valueRefused]);
  return { view, busy, error: error || loadError, notice, change, reload, reveal };
}

export function SecretsPanel({ token, computers = [], canvas = emptyCanvas, focus }: { token: string; computers?: SecretComputer[]; canvas?: SecretCanvas; focus?: string }) {
  const { t } = useI18n(); const frame = useContext(SettingsFrameContext); const state = useSecretSettings(token, frame.active);
  return <SettingsPane title={t('시크릿')} description={t('등록한 시크릿과 각 시크릿의 공유 범위를 관리합니다.')} scope="secrets-pane">
    {state.error && <p role="alert" className="secret-error">{state.error}<button type="button" onClick={state.reload}>{t('다시 시도')}</button></p>}
    {state.notice && <p role="status" className="secret-notice-line">{state.notice}</p>}
    {frame.active && (state.view ? <SecretSettingsWorkspace key={state.view.status.locked ? 'locked' : 'open'} view={state.view} canvas={canvas} computers={computers} busy={state.busy} change={state.change} reveal={state.reveal} focus={focus} reload={state.reload} /> : <p role="status">{t('불러오는 중…')}</p>)}
  </SettingsPane>;
}
