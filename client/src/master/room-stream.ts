import type { MasterCheckpoint, MasterDirective, MasterOverview, MasterSay, MasterStreamEvent, MasterVoiceStatus } from '../../../shared/master';
import { api } from '../common/lib';

export interface RoomState {
  overview?: MasterOverview;
  /** Voice as the host sees it, kept current between overviews. */
  voice?: MasterVoiceStatus;
  error?: string;
}

/** What voice in this page hears from the host. */
export interface VoiceListener {
  status(voice: MasterVoiceStatus): void;
  say(say: MasterSay): void;
  connected(up: boolean): void;
}

/**
 * Follows the master host: its state, screen commands for this tab, and what voice plays. The conversation itself is
 * the master session's, shown like any session. When the stream cannot continue where it left off (the host
 * restarted) it starts again from a new checkpoint.
 */
export function followRoom(onState: (state: RoomState) => void, onDirective: (directive: MasterDirective) => void, voiceListener?: VoiceListener): { stop(): void } {
  let overview: MasterOverview | undefined;
  let voice: MasterVoiceStatus | undefined;
  let epoch = '';
  let seq = -1;
  let source: EventSource | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const publish = (error?: string) => onState({ ...(overview ? { overview } : {}), ...(voice ? { voice } : {}), ...(error ? { error } : {}) });
  const heard = (status: MasterVoiceStatus | undefined) => { if (!status) return; voice = status; voiceListener?.status(status); };
  const apply = (event: MasterStreamEvent) => {
    seq = Math.max(seq, event.seq);
    if (event.type === 'overview') { overview = event.overview; heard(event.overview.voice); }
    else if (event.type === 'directive') { onDirective(event.directive); return; }
    else if (event.type === 'voice') heard(event.voice);
    else if (event.type === 'say') { voiceListener?.say(event.say); return; }
    else return;
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
      overview = state.overview; epoch = state.epoch; seq = state.seq;
      heard(state.overview.voice);
      publish();
      connect();
    } catch (error) {
      publish(error instanceof Error ? error.message : String(error));
      schedule();
    }
  };
  void checkpoint();
  return { stop: () => { stopped = true; clearTimeout(retry); source?.close(); } };
}
