import type { MasterCheckpoint, MasterDirective, MasterDraft, MasterEntry, MasterOverview, MasterStreamEvent } from '../../../shared/master';
import { api } from '../common/lib';

export interface RoomState {
  entries: MasterEntry[];
  hasMore: boolean;
  draft?: MasterDraft;
  overview?: MasterOverview;
  error?: string;
}

/**
 * Follows the master's conversation: a checkpoint first, then live changes after it. When the stream cannot continue
 * where it left off (the host restarted, or too much was missed) it starts again from a new checkpoint.
 */
export function followRoom(onState: (state: RoomState) => void, onDirective: (directive: MasterDirective) => void): { stop(): void; earlier(): Promise<void> } {
  const entries = new Map<string, MasterEntry>();
  let hasMore = false;
  let draft: MasterDraft | undefined;
  let overview: MasterOverview | undefined;
  let epoch = '';
  let seq = -1;
  let source: EventSource | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const publish = (error?: string) => onState({ entries: [...entries.values()].sort((a, b) => a.order - b.order), hasMore, ...(draft ? { draft } : {}), ...(overview ? { overview } : {}), ...(error ? { error } : {}) });
  const apply = (event: MasterStreamEvent) => {
    seq = Math.max(seq, event.seq);
    if (event.type === 'entry') {
      const known = entries.get(event.entry.id);
      if (!known || known.revision <= event.entry.revision) entries.set(event.entry.id, event.entry);
    } else if (event.type === 'draft') draft = event.draft ?? undefined;
    else if (event.type === 'overview') overview = event.overview;
    else if (event.type === 'directive') { onDirective(event.directive); return; }
    publish();
  };
  const connect = () => {
    if (stopped) return;
    source = new EventSource(`/api/master/events?${new URLSearchParams({ epoch, after: String(seq) })}`);
    source.onmessage = message => { try { apply(JSON.parse(message.data) as MasterStreamEvent); } catch { /* ignore */ } };
    source.addEventListener('resync', () => { source?.close(); void checkpoint(); });
    // A dropped connection resumes where it left off; the host answers `resync` if it cannot.
    source.onerror = () => { source?.close(); reconnect(); };
  };
  const reconnect = () => { if (!stopped) { clearTimeout(retry); retry = setTimeout(connect, 2000); } };
  const schedule = () => { if (!stopped) { clearTimeout(retry); retry = setTimeout(() => void checkpoint(), 2000); } };
  const checkpoint = async () => {
    if (stopped) return;
    try {
      const state = await api<MasterCheckpoint>('/api/master/state');
      entries.clear();
      for (const entry of state.entries) entries.set(entry.id, entry);
      hasMore = state.hasMore; draft = state.draft; overview = state.overview; epoch = state.epoch; seq = state.seq;
      publish();
      connect();
    } catch (error) {
      publish(error instanceof Error ? error.message : String(error));
      schedule();
    }
  };
  void checkpoint();
  return {
    stop: () => { stopped = true; clearTimeout(retry); source?.close(); },
    // Older entries than any shown, for "show earlier".
    earlier: async () => {
      const first = Math.min(...[...entries.values()].map(entry => entry.order));
      if (!Number.isFinite(first)) return;
      const page = await api<{ entries: MasterEntry[]; hasMore: boolean }>(`/api/master/room?before=${first}`);
      for (const entry of page.entries) if (!entries.has(entry.id)) entries.set(entry.id, entry);
      hasMore = page.hasMore;
      publish();
    },
  };
}
