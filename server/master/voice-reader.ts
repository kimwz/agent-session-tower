import type { MasterEntryData, MasterSay, MasterSpeak, MasterUnspoken } from '../../shared/master.js';
import type { RunReply } from '../../shared/types.js';
import type { VoiceAudio } from './voice-audio.js';
import { LIVE_WAIT_MS } from './voice-audio.js';
import { CHUNK_PAUSE_MS, TextFollower } from './voice-stream.js';
import { READ_CHARS, speakable, streamTone, VOICE_REST, voicedChunkPairs } from './voice-text.js';
import type { VoiceTimings } from './voice-timings.js';
import type { AudioHandle, VoiceSession, VoiceTiming } from './voice-types.js';
import { ttsDollarsPerChar } from './tts-models.js';
import type { VoiceUsage } from './voice-usage.js';

/** How long reading aloud may take a character, at most: the page gives up on a player later than this too. */
export const MS_PER_CHAR = 200;
/** Turns whose reading stopped, remembered (with why) until their end comes: this many. */
const STOPPED_TURNS = 50;
/** Why reading ended, from the word on what was given to play (the page's, or the host's own: `timeout`, `away`, `restart`). */
const REASONS: Record<string, MasterUnspoken> = { stopped: 'stopped', interrupted: 'stopped', blocked: 'blocked', expired: 'expired', timeout: 'timeout', away: 'away', restart: 'restart' };
export const reasonOf = (result: string): MasterUnspoken => REASONS[result] ?? 'failed';
/** How an answer's reading stands, without how an earlier reading of it ended. */
export const bare = ({ reason: _reason, heard: _heard, ...rest }: MasterSpeak): MasterSpeak => rest;
/** An answer's reading ended without it being heard to its end, and why. */
export const unspoken = (speak: MasterSpeak | undefined, reason: MasterUnspoken, heard = false): MasterSpeak =>
  ({ ...(speak ? bare(speak) : {}), state: 'unspoken', reason, ...(heard ? { heard: true as const } : {}) });
/** An answer's reading went to its end. */
export const played = (speak: MasterSpeak | undefined): MasterSpeak => ({ ...(speak ? bare(speak) : {}), state: 'played' });
export const withSpeak = (data: MasterEntryData, speak: MasterSpeak): MasterEntryData => ({ ...data, speak } as MasterEntryData);

/** Input for reading a turn while the master writes it. */
export interface StreamInput {
  /** The turn's run (the one steered messages joined). */
  turn: string;
  kind: 'answer' | 'report';
  /** The key of the timing record (the spoken request's key, or the report's). */
  key: string;
  /** The spoken request's key, for its first response and answer to keep their order. */
  request?: string;
  /** The voice session a spoken request belongs to (reports: whichever is on). */
  voiceSession?: string;
  replies: readonly RunReply[];
}

/** One reply (text block) of a turn read while it is written: its words, then its audio when its turn to play comes. */
interface Segment {
  reply: string;
  follower: TextFollower;
  /** What is sent to speech, and how many of those parts went into its audio. */
  parts: Array<{ speech: string; text: string }>;
  fed: number;
  wake?: () => void;
  /** What the page shows while it plays. */
  text: string;
  done: boolean;
  queued: boolean;
  queuedAt?: number;
  /** Heard to its end on the page. */
  played?: true;
  /** Its sound started on the page. */
  started?: true;
  live?: AudioHandle;
  say?: MasterSay;
}

interface Stream {
  turn: string;
  key: string;
  kind: 'answer' | 'report';
  request?: string;
  session: VoiceSession;
  segments: Segment[];
  /** The tone tag so far (undefined before the first words). */
  tag?: string;
  read: number;
  /** Reading ended at the limit (`READ_CHARS`). */
  full: boolean;
  /** Reading ended early at the daily limit: heard to there, it is not called heard to its end. */
  limitHit?: true;
  lastChunkAt: number;
  state: 'starting' | 'streaming' | 'stopped' | 'finished';
  played: number;
  /** The words so far, looked at again when a pause passes. */
  replies: readonly RunReply[];
  /** The turn ended: once everything is played, its entry (if any) is added. */
  finishing?: { data?: MasterEntryData };
}

/**
 * What the reader needs of the voice, and nothing more: the voice session now and whether it is there, why one is gone,
 * whether something is to be read, the one playback line, giving something to the page to play and taking it back,
 * hiding, the model, adding an entry and reading what waits, and keeping a turn's record.
 */
export interface ReaderHost {
  session(): VoiceSession | undefined;
  alive(session: VoiceSession): boolean;
  gone(session: VoiceSession): MasterUnspoken;
  speaks(report: boolean): 'pending' | 'unspoken' | undefined;
  onLine<T>(work: () => Promise<T>): Promise<T>;
  play(session: VoiceSession, what: { kind: MasterSay['kind']; text: string; audio: string; request?: string; streaming?: true; timing?: string }, waitMs: number,
    signal?: AbortSignal, onSay?: (say: MasterSay) => void, onStarted?: () => void): Promise<{ result: string; started: boolean }>;
  /** A say given to the page that is no longer to be played: its word is answered `stopped`, or it is withdrawn. */
  cancelSay(say: MasterSay): void;
  hide(text: string): string;
  model(): string;
  addEntry(data: MasterEntryData): void;
  deliver(): void;
  streamState(turn: string, state: 'started' | 'stopped' | 'done'): Promise<void> | undefined;
}

/**
 * Reading a turn aloud while the master writes it: the only owner of the turns being read, their segments and future
 * text, the pause between chunks, and the turns whose reading stopped. Plays through the voice's one line.
 */
export class VoiceReader {
  /** Turns read while they are written, by turn. */
  private readonly streams = new Map<string, Stream>();
  /** Turns whose reading stopped, and why, for when their end comes (`finishStream`). */
  private readonly stoppedTurns = new Map<string, { reason: MasterUnspoken; heard: boolean }>();
  private pauseTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly host: ReaderHost, private readonly audio: VoiceAudio, private readonly usage: VoiceUsage, private readonly timings: VoiceTimings,
    private readonly timing: VoiceTiming) {}

  /**
   * The master's words for a turn so far (called whenever they grew): read aloud chunk by chunk as they are written,
   * where voice is on. A turn starts to be read only with something whole to say, while its voice session is on; its
   * record is kept first (`streamState`), so it is never read again after a restart. Replies keep their order; each
   * gets its own audio when its turn to play comes, so a tool call between two never holds audio open on the page.
   */
  stream(input: StreamInput): void {
    let stream = this.streams.get(input.turn);
    if (!stream) {
      const session = this.host.session();
      if (!session || !this.host.alive(session) || (input.voiceSession && input.voiceSession !== session.digest) || this.host.speaks(input.kind === 'report') !== 'pending') return;
      stream = { turn: input.turn, key: input.key, kind: input.kind, ...(input.request ? { request: input.request } : {}), session, segments: [], read: 0, full: false,
        lastChunkAt: Date.now(), state: 'starting', played: 0, replies: input.replies };
      this.take(stream, input.replies, false);
      // Nothing whole to say yet: looked at again with more words (the same words give the same chunks).
      if (!stream.segments.some(segment => segment.parts.length)) return;
      this.streams.set(input.turn, stream);
      this.timings.mark(stream.key, 'text', Date.now(), { kind: stream.kind, mode: 'stream' });
      const started = stream;
      void (this.host.streamState(input.turn, 'started') ?? Promise.resolve()).then(() => {
        if (started.state !== 'starting') return;
        started.state = 'streaming';
        for (const segment of started.segments) this.pump(started, segment);
      }, () => this.stopStream(started, 'failed'));
      this.pauses();
      return;
    }
    if (stream.state === 'starting' || stream.state === 'streaming') { stream.replies = input.replies; this.take(stream, input.replies, false); }
  }

  /** Whether a turn is being read while it is written. */
  streaming(turn: string): boolean { return this.streams.has(turn); }
  streamingTurns(): string[] { return [...this.streams.keys()]; }

  /**
   * A turn that was read while it was written ended: what was not read yet is read, then its entry is added, marked
   * played when all of it was heard (or unspoken). Nothing is read twice, and no entry of it waits to be read. A turn
   * that failed or was stopped stops being read; its error is read only when nothing of the turn was.
   */
  finishStream(input: { turn: string; replies?: readonly RunReply[]; completed: boolean; data?: MasterEntryData }): void {
    const stream = this.streams.get(input.turn);
    const add = (speak: (current: MasterSpeak | undefined) => MasterSpeak) => {
      const data = input.data;
      if (!data || (data.kind !== 'master' && data.kind !== 'event' && data.kind !== 'error')) return;
      const added = speak(data.speak);
      this.host.addEntry(withSpeak(data, added));
      if (added.state === 'pending') this.host.deliver();
    };
    // Stopped earlier (skipped, voice ended, failed on the page) or read before a restart: marked why, never read again.
    if (!stream) {
      const stopped = this.stoppedTurns.get(input.turn);
      this.stoppedTurns.delete(input.turn);
      add(current => unspoken(current, stopped?.reason ?? 'restart', stopped?.heard));
      return;
    }
    // Already ending (told once by the request that waited on it): nothing changes.
    if (stream.finishing) return;
    if (!input.completed) {
      const heard = this.heardOf(stream);
      this.stopStream(stream, 'stopped');
      this.stoppedTurns.delete(input.turn);
      add(current => heard ? unspoken(current, 'stopped', true) : { ...(current ?? {}), state: 'pending' });
      return;
    }
    if (input.replies) { stream.replies = input.replies; this.take(stream, input.replies, true); }
    for (const segment of stream.segments) { segment.done = true; this.pump(stream, segment); }
    stream.finishing = { ...(input.data ? { data: input.data } : {}) };
    this.settle(stream);
  }

  /** Takes the words that are whole from each reply into its segment, in order. `done`: the turn ended, take all. */
  private take(stream: Stream, replies: readonly RunReply[], done: boolean): void {
    const now = Date.now();
    for (const segment of stream.segments) {
      // A reply no longer there (dropped to keep the run small) ends where it was read.
      if (!segment.done && !replies.some(reply => reply.id === segment.reply)) { segment.done = true; this.pump(stream, segment); }
    }
    for (const reply of replies) {
      let segment = stream.segments.find(item => item.reply === reply.id);
      if (!segment) {
        segment = { reply: reply.id, follower: new TextFollower(), parts: [], fed: 0, text: '', done: false, queued: false };
        stream.segments.push(segment);
      }
      if (segment.done) continue;
      const ended = done || Boolean(reply.done) || Boolean(reply.cut);
      for (;;) {
        const chunk = segment.follower.next(reply.text, { done: ended, first: stream.read === 0, paused: now - stream.lastChunkAt >= CHUNK_PAUSE_MS });
        if (chunk === undefined) break;
        this.chunk(stream, segment, chunk);
      }
      if (ended) segment.done = true;
      this.pump(stream, segment);
    }
  }

  /** One chunk of words: as heard, within the turn's limit, with the turn's tone, into its segment's parts. */
  private chunk(stream: Stream, segment: Segment, raw: string): void {
    if (stream.full) return;
    let plain = this.hearable(raw).trim();
    if (!plain) return;
    const left = READ_CHARS - stream.read;
    if (plain.length > left) {
      // Past the limit, reading ends at a sentence and says the rest is on the screen.
      const head = plain.slice(0, Math.max(0, left));
      const end = Math.max(...[...head.matchAll(/[.!?…。]+["'”’)]*(?=\s|$)/g)].map(match => match.index + match[0].length), 0);
      plain = `${head.slice(0, end).trim()} ${VOICE_REST}`.trim();
      stream.full = true;
    }
    const model = this.host.model();
    stream.tag = streamTone(plain, model, stream.kind, stream.tag);
    this.timings.mark(stream.key, 'sentence');
    segment.parts.push(...voicedChunkPairs(plain, model, stream.tag));
    segment.text = `${segment.text} ${plain}`.trim();
    stream.read += plain.length;
    stream.lastChunkAt = Date.now();
  }

  /** What is heard of words the master wrote: hidden whole, as they are heard (without markdown), and hidden again. */
  private hearable(raw: string): string {
    const hide = (text: string) => this.host.hide(text);
    return hide(speakable(hide(raw)));
  }

  /** Wakes a reply already owning the line, or queues its one playback task. */
  private pump(stream: Stream, segment: Segment): void {
    segment.wake?.();
    if (stream.state !== 'streaming' || segment.queued || !segment.parts.length) return;
    segment.queued = true;
    segment.queuedAt = Date.now();
    void this.host.onLine(() => this.playSegment(stream, segment));
  }

  /** A reply retains the line while its finite parts are completed, played and acknowledged in order. */
  private async playSegment(stream: Stream, segment: Segment): Promise<void> {
    const session = stream.session;
    while (stream.state === 'streaming') {
      if (this.host.session() !== session || !this.host.alive(session)) { this.stopStream(stream, this.host.gone(session)); return; }
      if (segment.fed >= segment.parts.length) {
        if (segment.done) break;
        if (!await this.nextPart(stream, segment)) segment.done = true;
        continue;
      }
      const part = segment.parts[segment.fed];
      const model = this.host.model();
      if (this.usage.limited(Date.now(), part.speech.length * ttsDollarsPerChar(model))) { this.stopStream(stream, 'limit'); return; }
      const live = this.audio.synthesize(part.speech, undefined, stream.key);
      this.audio.configure(live, { held: true, session, queuedAt: segment.queuedAt, partIndex: segment.fed });
      segment.live = live;
      try {
        if (!await this.audio.complete(live) || this.host.session() !== session || stream.state !== 'streaming') {
          this.audio.abandon(live);
          if (stream.state === 'streaming') this.stopStream(stream, this.host.session() !== session ? this.host.gone(session) : 'audio');
          return;
        }
        const { result, started } = await this.host.play(session, { kind: stream.kind, text: part.text, audio: live.id, streaming: true, timing: stream.key,
          ...(stream.request ? { request: stream.request } : {}) }, this.timing.playMs + part.speech.length * MS_PER_CHAR, undefined, say => { segment.say = say; }, () => { segment.started = true; });
        if (started) segment.started = true;
        if (result !== 'played' || stream.state !== 'streaming') {
          if (stream.state === 'streaming') this.stopStream(stream, reasonOf(result));
          return;
        }
        segment.fed++;
        stream.played++;
      } finally { this.audio.configure(live, { held: false }); segment.live = undefined; segment.say = undefined; }
    }
    segment.played = segment.done && segment.fed >= segment.parts.length ? true : undefined;
    this.settle(stream);
  }

  /** No future text is awaited by a browser audio response; one bounded waiter owns the segment's pause. */
  private nextPart(stream: Stream, segment: Segment): Promise<boolean> {
    const ready = () => stream.state !== 'streaming' || segment.done || segment.fed < segment.parts.length;
    if (ready()) return Promise.resolve(true);
    return new Promise(resolve => {
      const finish = (available: boolean) => { clearTimeout(timer); segment.wake = undefined; resolve(available); };
      const timer = setTimeout(() => finish(false), LIVE_WAIT_MS);
      segment.wake = () => { if (ready()) finish(true); };
      segment.wake();
    });
  }

  /** Once a finished turn's segments were all played, its entry is added (played) and its reading ends. */
  private settle(stream: Stream): void {
    if (stream.state !== 'streaming' || !stream.finishing) return;
    if (stream.segments.some(segment => !segment.done || segment.fed < segment.parts.length || segment.live || segment.say)) return;
    stream.state = 'finished';
    this.streams.delete(stream.turn);
    const entry = stream.finishing.data;
    if (entry && (entry.kind === 'master' || entry.kind === 'event' || entry.kind === 'error')) this.host.addEntry(withSpeak(entry, stream.limitHit ? unspoken(entry.speak, 'limit', true) : played(entry.speak)));
    void this.host.streamState(stream.turn, 'done')?.catch(() => {});
  }

  /**
   * A turn stops being read: its audio stops, nothing more of it is read, and its record says so. Its entry says why
   * (now, or when the turn ends: `stoppedTurns`), so the owner is told of it beside the voice.
   */
  private stopStream(stream: Stream, reason: MasterUnspoken): void {
    if (stream.state === 'stopped' || stream.state === 'finished') return;
    stream.state = 'stopped';
    this.streams.delete(stream.turn);
    for (const segment of stream.segments) {
      segment.wake?.();
      if (segment.say && !segment.played) this.host.cancelSay(segment.say);
      if (segment.live) { this.audio.abandon(segment.live); this.audio.configure(segment.live, { held: false }); }
    }
    const heard = this.heardOf(stream);
    const finishing = stream.finishing?.data;
    if (finishing && (finishing.kind === 'master' || finishing.kind === 'event' || finishing.kind === 'error')) this.host.addEntry(withSpeak(finishing, unspoken(finishing.speak, reason, heard)));
    else {
      this.stoppedTurns.set(stream.turn, { reason, heard });
      while (this.stoppedTurns.size > STOPPED_TURNS) this.stoppedTurns.delete(this.stoppedTurns.keys().next().value!);
    }
    // Ended without an entry (the turn's end tells): kept in the timing record now.
    if (!finishing) this.timings.outcome(stream.key, { state: 'unspoken', reason, ...(heard ? { heard: true as const } : {}) });
    void this.host.streamState(stream.turn, 'stopped')?.catch(() => {});
  }

  /** Whether any of a turn read while it was written was heard. */
  private heardOf(stream: Stream): boolean { return stream.played > 0 || stream.segments.some(segment => segment.started); }

  /** While turns are read, short waiting words go after a pause even when the master writes nothing new. */
  private pauses(): void {
    if (this.pauseTimer) return;
    this.pauseTimer = setInterval(() => {
      if (!this.streams.size) { clearInterval(this.pauseTimer); this.pauseTimer = undefined; return; }
      for (const stream of this.streams.values()) if (stream.state === 'streaming' || stream.state === 'starting') this.take(stream, stream.replies, false);
    }, 400);
    this.pauseTimer.unref();
  }

  /** Whether a spoken request's answer has begun to be read here: one of its segments is queued to play. */
  answering(request: string): boolean {
    return [...this.streams.values()].some(stream => stream.request === request && stream.segments.some(segment => segment.queued));
  }

  /** Whether any turn is being read. */
  busy(): boolean { return this.streams.size > 0; }

  /** A voice session ended: each turn read for it stops, in the order they started. */
  stopSession(session: VoiceSession, reason: MasterUnspoken): void {
    for (const stream of [...this.streams.values()]) if (stream.session === session) this.stopStream(stream, reason);
  }

  /** The host closes: the pause timer stops (nothing else of the reading changes here). */
  stopTimers(): void { if (this.pauseTimer) clearInterval(this.pauseTimer); }
}
