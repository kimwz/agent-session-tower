import type { MasterCheckpoint, MasterDirective, MasterDraft, MasterEntry, MasterOverview, MasterStreamEvent, MasterVoiceStatus } from '../../../shared/master';
import { api } from '../common/lib';

export interface RoomState {
  entries: MasterEntry[];
  hasMore: boolean;
  draft?: MasterDraft;
  overview?: MasterOverview;
  /** The voice call as the host sees it, kept current between overviews. */
  voice?: MasterVoiceStatus;
  error?: string;
}

/** What a voice call in this page hears from the host besides the conversation. */
export interface VoiceListener {
  status(voice: MasterVoiceStatus): void;
  notice(notice: { id: string; attempt: string; text: string }): void;
  connected(up: boolean): void;
}

/**
 * Follows the master's conversation: a checkpoint first, then live changes after it. When the stream cannot continue
 * where it left off (the host restarted, or too much was missed) it starts again from a new checkpoint.
 */
export function followRoom(onState: (state: RoomState) => void, onDirective: (directive: MasterDirective) => void, voiceListener?: VoiceListener): { stop(): void; earlier(): Promise<void> } {
  const entries = new Map<string, MasterEntry>();
  let hasMore = false;
  let draft: MasterDraft | undefined;
  let overview: MasterOverview | undefined;
  let voice: MasterVoiceStatus | undefined;
  let epoch = '';
  let seq = -1;
  let source: EventSource | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const publish = (error?: string) => onState({ entries: [...entries.values()].sort((a, b) => a.order - b.order), hasMore, ...(draft ? { draft } : {}), ...(overview ? { overview } : {}), ...(voice ? { voice } : {}), ...(error ? { error } : {}) });
  const heard = (status: MasterVoiceStatus | undefined) => { if (!status) return; voice = status; voiceListener?.status(status); };
  const apply = (event: MasterStreamEvent) => {
    seq = Math.max(seq, event.seq);
    if (event.type === 'entry') {
      const known = entries.get(event.entry.id);
      if (!known || known.revision <= event.entry.revision) entries.set(event.entry.id, event.entry);
    } else if (event.type === 'draft') draft = event.draft ?? undefined;
    else if (event.type === 'overview') { overview = event.overview; heard(event.overview.voice); }
    else if (event.type === 'directive') { onDirective(event.directive); return; }
    else if (event.type === 'voice') heard(event.voice);
    else if (event.type === 'notice') { voiceListener?.notice(event.notice); return; }
    publish();
  };
  const connect = () => {
    if (stopped) return;
    source = new EventSource(`/api/master/events?${new URLSearchParams({ epoch, after: String(seq) })}`);
    source.onopen = () => voiceListener?.connected(true);
    source.onmessage = message => { try { apply(JSON.parse(message.data) as MasterStreamEvent); } catch { /* ignore */ } };
    source.addEventListener('resync', () => { source?.close(); void checkpoint(); });
    // A dropped connection resumes where it left off; the host answers `resync` if it cannot.
    source.onerror = () => { source?.close(); voiceListener?.connected(false); reconnect(); };
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
      heard(state.overview.voice);
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
