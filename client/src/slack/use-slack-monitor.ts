import { useCallback, useEffect, useRef, useState } from 'react';
import type { SlackPublicStatus } from '../../../shared/slack';
import { api } from '../common/lib';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { translate as t, useI18n } from '../i18n/i18n';
import { startSlackMonitorPoll } from './slack-monitor-poll';

export const SLACK_CHANGED_EVENT = 'tower:slack-changed';
export function useSlackMonitor(connected: boolean, token = '') {
  const { language } = useI18n();
  const languageUpdates = useRef<Promise<unknown>>(Promise.resolve());
  const [slack, setSlack] = useState<SlackPublicStatus | null>(null);
  const [error, setError] = useState('');
  const [languageError, setLanguageError] = useState('');
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  useEffect(() => {
    if (!connected || !token) return;
    let disposed = false;
    const update = languageUpdates.current.catch(() => {}).then(async () => {
      if (disposed) return;
      await api('/api/slack/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token }, body: JSON.stringify({ language }) });
      if (!disposed) setLanguageError('');
    });
    languageUpdates.current = update;
    void update.catch(cause => { if (!disposed) setLanguageError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { disposed = true; };
  }, [connected, token, language]);
  useEffect(() => {
    // Keep the last successful overview across disconnects so hidden sessions and Slack selection stay stable.
    if (!connected) return;
    const poll = startSlackMonitorPoll({
      read: signal => api<SlackPublicStatus>('/api/slack', { signal }),
      loaded: next => { setSlack(next); setError(''); },
      failed: cause => setError(cause.message),
      timeoutMessage: () => t('세션 표시 정보를 불러오는 시간이 초과되었습니다. 다시 시도해 주세요.'),
    });
    const changed = () => { void poll.changed(); };
    refreshRef.current = poll.refresh;
    window.addEventListener(SLACK_CHANGED_EVENT, changed);
    return () => {
      poll.dispose();
      refreshRef.current = async () => {};
      window.removeEventListener(SLACK_CHANGED_EVENT, changed);
    };
  }, [connected]);
  return { slack, error: languageError || error, loadError: error, refresh };
}
