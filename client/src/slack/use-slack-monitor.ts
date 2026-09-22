import { useCallback, useEffect, useRef, useState } from 'react';
import type { SlackPublicStatus } from '../../../shared/slack';
import { api } from '../common/lib';

export const SLACK_CHANGED_EVENT = 'tower:slack-changed';
export function useSlackMonitor(connected: boolean) {
  const [slack, setSlack] = useState<SlackPublicStatus | null>(null);
  const [error, setError] = useState('');
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const refresh = useCallback(() => refreshRef.current(), []);
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
  return { slack, error, refresh };
}
