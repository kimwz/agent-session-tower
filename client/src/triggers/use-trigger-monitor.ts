import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TriggerEvent, TriggerOverview } from '../../../shared/triggers';
import { towerOperation } from './trigger-helpers';
import { keepTriggerEvents, laneWorthy, mergeTriggerEvents, readTriggerState, RecheckQueue, reconcileSnapshot, TRIGGER_READ_KEY, TRIGGER_READ_SINCE_KEY, triggerEventRevision, triggerUnread, type TriggerReadState } from './trigger-monitor';

const PAGE = 20;
type Floor = Pick<TriggerEvent, 'id' | 'receivedAt'>;

/**
 * Runs the monitor shows. The latest ones and older ones that are still working or just changed come live
 * with every snapshot and are kept once seen; older history loads a page at a time below the oldest run
 * already here, so the list never has a hole in it.
 */
export function useTriggerEvents(overview: TriggerOverview | undefined, token: string) {
  const recent = overview?.recent;
  const updated = overview?.updated;
  const [kept, setKept] = useState<TriggerEvent[]>([]);
  /** The oldest run of the unbroken stretch from the newest; pages continue below it. */
  const [floor, setFloor] = useState<Floor | undefined>();
  const [exhausted, setExhausted] = useState(false);
  const loading = useRef(false);
  /** Changes whenever the list starts over, so a page asked for before that is not mixed into the new list. */
  const generation = useRef(0);
  const keptRef = useRef(kept);
  keptRef.current = kept;
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const [recheck] = useState(() => new RecheckQueue(async (id, current) => {
    try {
      const { event } = await towerOperation<{ event: TriggerEvent }>(tokenRef.current, 'triggers.event', { id });
      if (current()) setKept(list => keepTriggerEvents(mergeTriggerEvents([event], list)));
    } catch (error) {
      // A run trimmed from history is gone for good; anything else is tried again.
      if (/no longer in trigger history/.test(String(error))) { if (current()) setKept(list => list.filter(item => item.id !== id)); return; }
      throw error;
    }
  }, { permanent: error => /Unknown Tower operation/.test(String(error)) }));
  // Started with the component and stopped with it (development mounts twice, so it must start again).
  useEffect(() => { recheck.start(); return () => recheck.stop(); }, [recheck]);
  useEffect(() => {
    if (!recent) return;
    const { next, joined, stale } = reconcileSnapshot(keptRef.current, recent, updated, PAGE);
    setKept(next);
    if (!joined) { generation.current++; setFloor(undefined); setExhausted(false); }
    // A run shown as working that the snapshot no longer lists finished while this page was away.
    if (token) recheck.add(stale);
  }, [recent, updated, token, recheck]);
  const hasMore = !exhausted && (recent?.length ?? 0) >= PAGE;
  const loadMore = useCallback(async () => {
    const from = floor ?? recent?.at(-1);
    if (!token || loading.current || !hasMore || !from) return;
    loading.current = true;
    const asked = generation.current;
    try {
      const older = (await towerOperation<{ events: TriggerEvent[] }>(token, 'triggers.events', { limit: PAGE, beforeId: from.id, before: from.receivedAt })).events;
      if (asked !== generation.current) return;
      setKept(previous => keepTriggerEvents(mergeTriggerEvents(previous, older)));
      const last = older.at(-1);
      if (last) setFloor({ id: last.id, receivedAt: last.receivedAt });
      if (older.length < PAGE) setExhausted(true);
    } catch { /* A failed page can be asked for again. */ }
    finally { loading.current = false; }
  }, [token, hasMore, floor, recent]);
  /** A fresher copy of one run, such as the one open in the panel. */
  const update = useCallback((event: TriggerEvent) => setKept(previous => keepTriggerEvents(mergeTriggerEvents([event], previous))), []);
  const events = useMemo(() => kept.filter(laneWorthy), [kept]);
  return { events, hasMore, loadMore, update };
}

export function useTriggerReadState(events: TriggerEvent[], ready: boolean, visible = true) {
  const [read, setRead] = useState<TriggerReadState>(() => { try { return readTriggerState(localStorage.getItem(TRIGGER_READ_KEY)); } catch { return {}; } });
  const [since, setSince] = useState<string | null>(() => { try { return localStorage.getItem(TRIGGER_READ_SINCE_KEY); } catch { return null; } });
  useEffect(() => {
    if (since !== null || !ready) return;
    const now = new Date().toISOString();
    try { localStorage.setItem(TRIGGER_READ_SINCE_KEY, now); } catch { /* Memory state remains usable. */ }
    setSince(now);
  }, [since, ready]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === TRIGGER_READ_KEY) setRead(readTriggerState(event.newValue));
      if (event.key === TRIGGER_READ_SINCE_KEY && event.newValue) setSince(event.newValue);
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  /** Marks the result the panel is showing as read, from the panel's own copy of the run. */
  const acknowledge = useCallback((event: TriggerEvent) => {
    const revision = triggerEventRevision(event);
    if (!visible || !revision || document.visibilityState !== 'visible') return;
    setRead(previous => {
      if (previous[event.id] === revision) return previous;
      // Once the record grows, only runs still loaded are remembered, so it stays small.
      const entries = Object.entries(previous);
      const kept = entries.length > 300 ? entries.filter(([id]) => eventsRef.current.some(item => item.id === id)) : entries;
      const next = { ...Object.fromEntries(kept), [event.id]: revision };
      try { localStorage.setItem(TRIGGER_READ_KEY, JSON.stringify(next)); } catch { /* Memory state remains usable. */ }
      return next;
    });
  }, [visible]);
  const unreadIds = useMemo(() => new Set(events.filter(event => triggerUnread(event, read, since)).map(event => event.id)), [events, read, since]);
  return { unreadIds, acknowledge };
}
