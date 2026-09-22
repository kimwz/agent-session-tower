import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SlackWorkflow } from '../../../shared/slack';
import { readSlackState, SLACK_READ_KEY, slackCompletionRevision } from './slack-read-state';

export function useSlackReadState(events: SlackWorkflow[], selectedId: string | null | undefined, visible = true) {
  const [read, setRead] = useState(() => { try { return readSlackState(localStorage.getItem(SLACK_READ_KEY)); } catch { return {}; } });
  const selected = events.find(event => event.id === selectedId);
  const revision = selected ? slackCompletionRevision(selected) : '';
  const acknowledge = useCallback(() => {
    if (!visible || !selectedId || !revision || document.visibilityState !== 'visible') return;
    setRead(previous => {
      if (previous[selectedId] === revision) return previous;
      const next = { ...previous, [selectedId]: revision };
      try { localStorage.setItem(SLACK_READ_KEY, JSON.stringify(next)); } catch { /* Memory state remains usable. */ }
      return next;
    });
  }, [selectedId, revision, visible]);
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === SLACK_READ_KEY) setRead(readSlackState(event.newValue)); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  const unreadIds = useMemo(() => new Set(events.filter(event => {
    const current = slackCompletionRevision(event);
    return current && read[event.id] !== current;
  }).map(event => event.id)), [events, read]);
  return { unreadIds, acknowledge };
}
