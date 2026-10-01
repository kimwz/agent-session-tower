import { useEffect, useState } from 'react';
import type { Provider, Session } from '../../../shared/types';
import { api } from '../common/lib';

const LIMIT = 80;

/** The conversations of `provider` a trigger can continue, newest first; `include` keeps a trigger's saved target among them. */
export function resumeCandidates(sessions: readonly Session[], provider: Provider): Session[] {
  return sessions.filter(session => session.provider === provider && !session.isSubagent && !session.master && session.resumable).slice(0, LIMIT);
}

/**
 * This computer's page holds only the sessions its list shows, so its candidates are asked for; a joined computer's
 * sessions (`sessions`) are all at hand.
 */
export function useResumeCandidates(provider: Provider, include: string | undefined, sessions?: readonly Session[]): Session[] {
  const [loaded, setLoaded] = useState<Session[]>([]);
  useEffect(() => {
    if (sessions) return;
    let live = true;
    const query = new URLSearchParams({ provider, ...(include ? { include } : {}) });
    void api<{ sessions: Session[] }>(`/api/sessions/resume-candidates?${query}`).then(value => { if (live) setLoaded(value.sessions); }).catch(() => { if (live) setLoaded([]); });
    return () => { live = false; };
  }, [provider, include, sessions]);
  if (sessions) return resumeCandidates(sessions, provider);
  // The server already chose them, with the saved target after the newest; until the answer for a newly chosen
  // provider arrives, the other provider's are not offered.
  return loaded.filter(session => session.provider === provider);
}
