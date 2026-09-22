import { useCallback, useEffect, useRef, useState } from 'react';
import type { SlackPublicStatus } from '../../../shared/slack';
import { api } from '../common/lib';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { useI18n } from '../i18n/i18n';

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
    if (!connected) { setSlack(null); setError(''); return; }
    let disposed = false;
    let controller: AbortController | undefined;
    let pending: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function poll(): Promise<void> {
      if (disposed) return Promise.resolve();
      if (pending) return pending;
      clearTimeout(timer);
      controller = new AbortController();
      pending = api<SlackPublicStatus>('/api/slack', { signal: controller.signal }).then(next => {
        if (!disposed) { setSlack(next); setError(''); }
      }).catch(cause => {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      }).finally(() => {
        pending = undefined;
        if (!disposed) timer = setTimeout(() => void poll(), 3000);
      });
      return pending;
    }
    const changed = () => { void poll().then(() => { if (!disposed) void poll(); }); };
    refreshRef.current = poll;
    window.addEventListener(SLACK_CHANGED_EVENT, changed);
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
      refreshRef.current = async () => {};
      window.removeEventListener(SLACK_CHANGED_EVENT, changed);
    };
  }, [connected]);
  return { slack, error: languageError || error, refresh };
}
