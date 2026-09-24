import { useEffect, useState } from 'react';
import type { SessionDetail } from '../../../shared/types';
import { api } from './lib';
import { nodeOf, pathFor, scopeDetail } from '../remote/scope';

/** The latest messages of a session that automation started, refreshed every few seconds while shown. */
export function useSessionTail(sessionId: string | undefined, key?: string) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setDetail(null); setError('');
    if (!sessionId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function poll() {
      try {
        const next = scopeDetail(nodeOf(sessionId), await api<SessionDetail>(pathFor(sessionId!, id => `/api/sessions/${encodeURIComponent(id)}?limit=100`), { signal: controller.signal }));
        if (!disposed) { setDetail(next); setError(''); }
      } catch (cause) { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); }
      if (!disposed) timer = setTimeout(() => void poll(), 3000);
    }
    void poll();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, [sessionId, key]);
  // A changed selection must never show the previous session while its effect resets.
  return { detail: detail?.session.id === sessionId ? detail : null, error };
}
