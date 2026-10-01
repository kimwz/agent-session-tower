import { useEffect, useState } from 'react';
import type { Provider, Session } from '../../../shared/types';
import type { TriggerTarget } from '../../../shared/triggers';
import { api } from '../common/lib';

const LIMIT = 80;

/** The conversations of `provider` a trigger can continue, newest first; `include` keeps a trigger's saved target among them. */
export function resumeCandidates(sessions: readonly Session[], provider: Provider): Session[] {
  return sessions.filter(session => session.provider === provider && !session.isSubagent && !session.master && session.resumable).slice(0, LIMIT);
}

/** A session target chosen before the candidates arrived names none yet; it takes the first once they do. */
export function filledSessionTarget(target: TriggerTarget, candidates: readonly Session[]): TriggerTarget | undefined {
  return target.mode === 'session' && !target.sessionId && candidates[0] ? { ...target, sessionId: candidates[0].id } : undefined;
}

/** What a page offers from the server's answer: the chosen provider's only, so an answer for the other one is never offered. */
export function offeredCandidates(loaded: readonly Session[], provider: Provider): Session[] {
  return loaded.filter(session => session.provider === provider);
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
  // The server already chose them, with the saved target after the newest.
  return offeredCandidates(loaded, provider);
}
