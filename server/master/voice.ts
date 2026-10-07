import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { StreamSink } from '../streams/sink.js';
import { join } from 'node:path';
import type { MasterEntry, MasterEntryData, MasterMissed, MasterSay, MasterSpeak, MasterStreamEvent, MasterUnspoken, MasterViewContext, MasterVoiceStatus } from '../../shared/master.js';
import type { RunReply } from '../../shared/types.js';
import type { ElevenLabs, VoiceInfo } from './elevenlabs.js';
import type { FirstReplyMaker } from './first-reply.js';
import type { MasterRoom } from './room.js';
import type { MasterSettingsStore } from './settings.js';
import { isNoise, speakable, VOICE_REST, voiced, voicedPartPairs } from './voice-text.js';
import { playbackRecord, VoiceTimings, progressRecord, elapsed, attemptNumber, transportStage } from './voice-timings.js';
import { TowerError, type ErrorKind } from '../../shared/errors.js';
import { VoiceAudio } from './voice-audio.js';
import { VoiceClips } from './voice-clips.js';
import { bare, MS_PER_CHAR, played, reasonOf, unspoken, VoiceReader, withSpeak, type StreamInput } from './voice-reader.js';
import type { VoiceSession, VoiceTiming } from './voice-types.js';
import { ttsDollarsPerChar } from './tts-models.js';
import { FIRST_REPLY_DOLLARS, localDay, VoiceUsage } from './voice-usage.js';

export { frameAt, id3Size } from './mp3.js';
export type { VoiceTiming } from './voice-types.js';
export type { StreamInput } from './voice-reader.js';
export { migrate, type VoiceFile } from './voice-usage.js';

/** A first reply not ready this long after the request came is not said: the answer is near by then. */
const FIRST_REPLY_MS = 2_500;
const SAY_QUEUE = 20;
/** News older than this is not read aloud any more: it is on the screen. */
const STALE_MS = 60 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The page's word on something it played, as it may give it. */
const PAGE_RESULTS = new Set(['played', 'stopped', 'interrupted', 'failed', 'blocked', 'expired']);
/** What the owner is told of beside the voice: everything but their own stop and a restart. */
const QUIET = new Set<MasterUnspoken>(['stopped', 'restart']);

const TIMING: VoiceTiming = { firstChunkMs: 10_000, synthMs: 30_000, playMs: 60_000, resyncMs: 15_000, waitMs: 30_000, presenceMs: 15_000, tickMs: 5_000 };

/** What the voice needs from the master: its hiding, its inbox, and when a new web arrived. */
/** Where a spoken request came from: its key, and the digest of the voice session it was said in. */
export interface VoiceOrigin { key: string; session?: string }

export interface VoiceHooks {
  hide(text: string): string;
  /**
   * A turn read while it is written: `started` is kept (awaited) before its first words go to speech, so a restarted
   * host never reads that turn again; `stopped` or `done` when it ends.
   */
  streamState?(turn: string, state: 'started' | 'stopped' | 'done'): Promise<void>;
  send(input: { clientMessageId: string; text: string; viewContext?: MasterViewContext; local: boolean; voice: VoiceOrigin; spoken: true }): Promise<unknown>;
  connectedSince(): number;
}

export interface MasterVoiceOptions {
  dataDir: string;
  settings: MasterSettingsStore;
  room: MasterRoom;
  hooks: VoiceHooks;
  elevenLabs: ElevenLabs;
  /** Writes the first thing said after a spoken request; without it nothing is said before the answer. */
  firstReply?: Pick<FirstReplyMaker, 'prepare' | 'make' | 'close'>;
  timing?: Partial<VoiceTiming>;
}

/** The tab where voice is on (see `VoiceSession`): one object for its whole life, shared with the reader. */
type Session = VoiceSession;

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const fail = (message: string, kind: ErrorKind) => new TowerError(kind, message);
const speakOf = (data: MasterEntryData | undefined): MasterSpeak | undefined => data && (data.kind === 'master' || data.kind === 'error' || data.kind === 'event') ? data.speak : undefined;
/**
 * The master's voice. The owner's page listens and writes down what is said with ElevenLabs directly, using a
 * single-use token from here; what is said becomes a request like a typed one. Answers, news of finished work, and
 * the sentence before an irreversible change are read aloud: made here with the owner's key and played by the page
 * where voice is on. Turning voice off never stops anything the master does.
 */
export class MasterVoice {
  /** The voice's own records: money spent, tokens held and news not yet read (voice.json). */
  private readonly usage: VoiceUsage;
  private session?: Session;
  /** Audio being made and kept for the page. */
  private readonly audio: VoiceAudio;
  /** Fixed sentences recorded once (voice samples). */
  private readonly clips: VoiceClips;
  private readonly results = new Map<string, (result: string) => void>();
  private line: Promise<unknown> = Promise.resolve();
  private delivering = false;
  private deliverAgain = false;
  private shownDay = localDay(Date.now());
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private closed = false;
  private readonly timing: VoiceTiming;
  /** A say's timing and accepted start, retained synchronously by its owning streamed segment. */
  private readonly says = new Map<string, { key: string; at: number; started?: boolean; onStarted?: () => void }>();
  /** The latest answer or report not read aloud that the owner is told of (see `MasterVoiceStatus.missed`). */
  private missed?: MasterMissed & { order: number; at: number };
  /** The session that ended last, for an answer that comes after it (`quiet`). */
  private lastEnded?: Session;
  /** Turns read while the master writes them. */
  private readonly reader: VoiceReader;
  readonly timings: VoiceTimings;

  constructor(private readonly options: MasterVoiceOptions) {
    this.timing = { ...TIMING, ...options.timing };
    this.usage = new VoiceUsage(join(options.dataDir, 'voice.json'), () => this.options.settings.current().voice.dailyDollars);
    this.timings = new VoiceTimings(join(options.dataDir, 'voice-timings.json'));
    this.audio = new VoiceAudio(this.usage, this.timings, options.elevenLabs, () => this.options.settings.current().voice, this.timing, () => this.broadcast());
    this.clips = new VoiceClips(join(options.dataDir, 'voice-previews'), this.audio, this.usage, options.settings, options.elevenLabs);
    this.reader = new VoiceReader({
      session: () => this.session,
      alive: session => this.alive(session),
      gone: session => this.gone(session),
      speaks: report => this.speaks(report),
      onLine: work => this.onLine(work),
      play: (session, what, waitMs, signal, onSay, onStarted) => this.play(session, what, waitMs, signal, onSay, onStarted),
      cancelSay: say => {
        const done = this.results.get(say.id);
        if (done) done('stopped');
        else this.options.room.broadcast({ type: 'say', seq: 0, say: { ...say, cancelled: true } });
      },
      hide: text => { const hide = this.options.hooks.hide; return hide(text); },
      model: () => this.options.settings.current().voice.model,
      addEntry: data => { this.options.room.add(data); },
      deliver: () => this.deliver(),
      streamState: (turn, state) => this.options.hooks.streamState?.(turn, state),
    }, this.audio, this.usage, this.timings, this.timing);
  }

  async start(): Promise<void> {
    const rebuild = await this.usage.load();
    await this.timings.start();
    // Short replies recorded before 1.73 are not said any more.
    await rm(join(this.options.dataDir, 'voice-clips'), { recursive: true, force: true }).catch(() => {});
    // News waiting to be read may sit in an older part of the conversation; nothing being read survives a restart.
    for (const item of this.usage.speakingItems()) await this.options.room.load(item.order).catch(() => {});
    this.usage.keepSpeaking(id => Boolean(speakOf(this.options.room.get(id)?.data)));
    if (rebuild) await this.rebuildSpeaking();
    this.unsubscribe = this.options.room.subscribe(event => this.follow(event));
    for (const { entry, speak } of this.speakEntries()) if (speak.state !== 'played' && speak.state !== 'unspoken') this.setSpeak(entry, unspoken(speak, 'restart'));
    this.usage.settleExpired(Date.now());
    await this.usage.save();
    this.timer = setInterval(() => this.tick(), this.timing.tickMs);
    this.timer.unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    this.reader.stopTimers();
    this.endSession(this.session, 'restart');
    this.options.firstReply?.close();
    this.audio.dropAll();
    await this.usage.flush();
    await this.timings.flush();
  }

  status(): MasterVoiceStatus {
    const now = Date.now();
    const today = this.usage.day(now);
    return {
      ...(this.session ? { session: this.session.digest } : {}),
      listening: Boolean(this.session?.listening && this.alive(this.session)),
      today: { sttSeconds: Math.round(today.sttSeconds), ttsChars: today.ttsChars, dollars: Math.round(this.usage.spent(now) * 100) / 100 },
      limitDollars: this.options.settings.current().voice.dailyDollars,
      limited: this.usage.limited(now, 0),
      ...(this.missed && now - this.missed.at < STALE_MS ? { missed: { entry: this.missed.entry, reason: this.missed.reason, ...(this.missed.heard ? { heard: true as const } : {}), text: this.missed.text } } : {}),
    };
  }

  // ─── the page's session ──────────────────────────────────────────────────────────────────────────────────────

  /** The owner turned voice on in a tab: a new session, which ends any before it. */
  voiceOn(input: { tabId: unknown; local: boolean }): { session: string } {
    if (typeof input.tabId !== 'string' || !UUID.test(input.tabId)) throw fail('음성 켜기 요청이 올바르지 않습니다.', 'invalid');
    this.ready();
    this.endSession(this.session, 'away');
    const id = randomUUID();
    this.session = { id, digest: hash(id), tabId: input.tabId, local: input.local, listening: true, seenAt: Date.now() };
    this.options.firstReply?.prepare();
    this.broadcast();
    this.deliver();
    return { session: id };
  }

  voiceOff(input: { session: unknown }): boolean {
    const session = this.current(input.session);
    if (!session) return false;
    this.endSession(session, 'stopped');
    this.broadcast();
    return true;
  }

  /**
   * Where the page stands: listening or not. Whether the master's conversation is open there does not matter: voice
   * goes on with it closed. Never takes voice back.
   */
  voicePresence(input: { session: unknown; listening: unknown }): boolean {
    const session = this.current(input.session);
    if (!session) return false;
    const listening = input.listening === true;
    const changed = session.listening !== listening || !this.alive(session);
    Object.assign(session, { listening, seenAt: Date.now() });
    if (changed) { this.broadcast(); if (this.alive(session)) { this.options.firstReply?.prepare(); this.deliver(); } }
    return true;
  }

  /** What the page hears, for a change waiting on its notice: whether the owner speaks, and how long ago they last did. */
  voiceActivity(input: { session: unknown; speaking: unknown; sinceSpeechMs?: unknown }): boolean {
    const session = this.current(input.session);
    if (!session) return false;
    const now = Date.now();
    const speaking = input.speaking === true;
    const ago = typeof input.sinceSpeechMs === 'number' && Number.isFinite(input.sinceSpeechMs) && input.sinceSpeechMs >= 0 ? now - Math.min(input.sinceSpeechMs, 86_400_000) : 0;
    session.activity = { receivedAt: now, lastSpeechAt: speaking ? now : ago };
    session.seenAt = now;
    return true;
  }

  // ─── writing down what is said ───────────────────────────────────────────────────────────────────────────────

  /**
   * A token for one thing the owner says. Each holds a whole utterance's cost until the page settles it, on
   * whatever day that is, so the daily limit is never passed; a session holds at most two unsettled.
   */
  async voiceToken(input: { session: unknown }): Promise<{ tokenId: string; url: string; expiresAt: number }> {
    const session = this.current(input.session);
    if (!session) throw fail('음성 세션이 바뀌었습니다.', 'conflict');
    this.ready();
    const now = Date.now();
    this.usage.settleExpired(now);
    // Held before the token is asked for, so two requests at once cannot both pass the limit.
    const id = this.usage.reserveToken(session.digest, now);
    let token: string;
    try { token = await this.options.elevenLabs.sttToken(); }
    catch (error) {
      this.usage.releaseToken(id);
      throw error;
    }
    await this.usage.save();
    this.broadcast();
    return { tokenId: id, url: this.options.elevenLabs.sttUrl(token), expiresAt: now + 14 * 60_000 };
  }

  /** How long one utterance ran, from any page that got its token (voice may have moved since). Counted once, today. */
  async voiceUsage(input: { tokenId: unknown; seconds: unknown }): Promise<boolean> {
    if (typeof input.tokenId !== 'string') return false;
    if (!this.usage.settleToken(input.tokenId, input.seconds)) return false;
    await this.usage.save();
    this.broadcast();
    return true;
  }

  /**
   * What the owner said, written down on their page: a request like a typed one. A short first reply, written from the
   * request alone while the master starts on it, comes back to be played first (when one is ready in time).
   */
  async voiceRequest(input: { session: unknown; clientMessageId: unknown; text: unknown; viewContext?: MasterViewContext; local: boolean }): Promise<{ ignored?: true; stale?: true; ack?: MasterSay }> {
    const session = this.current(input.session);
    if (!session) return { stale: true };
    if (typeof input.clientMessageId !== 'string' || !/^[a-zA-Z0-9-]{8,64}$/.test(input.clientMessageId)) throw fail('요청 ID가 올바르지 않습니다.', 'invalid');
    if (typeof input.text !== 'string' || input.text.length > 4_000) throw fail('받아쓴 글이 올바르지 않습니다.', 'invalid');
    session.seenAt = Date.now();
    if (isNoise(input.text)) return { ignored: true };
    const key = hash(input.clientMessageId);
    const text = input.text.trim();
    // Made alongside sending the request, never holding it up.
    const cancel = new AbortController();
    const first = this.firstResponse(session, text, key, cancel.signal).catch(() => undefined);
    try {
      await this.options.hooks.send({
        clientMessageId: input.clientMessageId, text, local: input.local,
        viewContext: { ...input.viewContext, tabId: session.tabId },
        voice: { session: session.digest, key }, spoken: true,
      });
    } catch (error) { cancel.abort(); throw error; }
    const ack = await first;
    if (ack) this.timings.mark(key, 'ack');
    return ack ? { ack } : {};
  }

  /**
   * The first response to a spoken request: a short sentence a fast model writes from the request alone ("SORI 광고
   * 성과를 확인해 볼게요") while the request goes to the master, or nothing — when the model finds nothing worth saying
   * (a greeting), it is not ready in time, the answer has begun, the daily limit is near, or voice moved. It is never kept
   * in the conversation. The page plays it before the answer and drops it once the answer has begun (`SayOrder` in
   * shared/master/voice-order.ts, where the whole order is described).
   */
  private async firstResponse(session: Session, text: string, request: string, cancel: AbortSignal): Promise<MasterSay | undefined> {
    const maker = this.options.firstReply;
    if (!maker) return undefined;
    // The call is counted when it is made, like characters read.
    if (this.usage.limited(Date.now(), FIRST_REPLY_DOLLARS)) return undefined;
    this.usage.add(Date.now(), { firstReply: true });
    void this.usage.save();
    const signal = AbortSignal.any([cancel, AbortSignal.timeout(FIRST_REPLY_MS)]);
    const reply = await maker.make(text, signal);
    if (!reply.text || signal.aborted || this.session !== session || !this.alive(session) || this.answering(request)) return undefined;
    // A card's value in it would go out as it is: such a sentence is not said.
    if (this.options.hooks.hide(reply.text) !== reply.text) return undefined;
    const model = this.options.settings.current().voice.model;
    const sent = voiced(reply.text, model, 'ack');
    // Judged against the limit as it is now (an answer may have spent meanwhile), and charged in the same step.
    if (this.usage.limited(Date.now(), sent.length * ttsDollarsPerChar(model))) return undefined;
    const live = this.audio.synthesize(sent);
    this.audio.configure(live, { session });
    if (!await this.audio.complete(live, signal) || signal.aborted || this.session !== session || !this.alive(session) || this.answering(request)) { this.audio.abandon(live); return undefined; }
    return { id: randomUUID(), session: session.digest, kind: 'ack', text: reply.text, audio: `/api/master/voice/audio/${live.id}`, expiresAt: Date.now() + 60_000, request };
  }

  /** Whether `session` is the voice session now (for a judgment the web makes about it). */
  voiceKnown(input: { session: unknown }): boolean { return Boolean(this.current(input.session)); }

  /** Whether the answer to a spoken request has begun to be read: a first response would come too late then. */
  private answering(request: string): boolean {
    return this.reader.answering(request) || [...this.says.values()].some(say => say.key === request);
  }

  // ─── reading aloud ───────────────────────────────────────────────────────────────────────────────────────────

  /**
   * How an answer (or, `report`, news of finished work) is told: read aloud where voice is on, whether or not the
   * master's conversation is open there, or marked as not said aloud when there is no such page (a report only while voice is on somewhere). Nothing when
   * reports are not read, or for a report with voice off.
   */
  speaks(report: boolean): 'pending' | 'unspoken' | undefined {
    const session = this.session;
    if (report && !this.options.settings.current().voice.readReports) return undefined;
    if (session && this.alive(session)) return 'pending';
    return session || !report ? 'unspoken' : undefined;
  }

  /**
   * The page's word on something it was given to play: how it went (`PAGE_RESULTS`), when its sound started, and for
   * a failure what failed (`detail`, kept in the timing record).
   */
  voicePlayed(input: { session: unknown; id: unknown; result: unknown; startedMs?: unknown; detail?: unknown; playback?: unknown; elapsedMs?: unknown; attempt?: unknown }): boolean {
    if (!this.current(input.session) || typeof input.id !== 'string') return false;
    const done = this.results.get(input.id);
    if (!done) return false;
    const result = PAGE_RESULTS.has(String(input.result)) ? String(input.result) : 'failed';
    // How long the page took from being told to play to its sound starting, measured on its own clock.
    const said = this.says.get(input.id);
    const started = said && typeof input.startedMs === 'number' && Number.isFinite(input.startedMs) && input.startedMs >= 0 && input.startedMs < 3_600_000 ? said.at + input.startedMs : undefined;
    if (said && started !== undefined) this.timings.mark(said.key, 'play', started);
    if (said && started !== undefined) { said.started = true; said.onStarted?.(); }
    if (said) this.timings.terminal(said.key, input.id, { event: 'terminal', at: Date.now(), result, ...(elapsed(input.elapsedMs) !== undefined ? { elapsedMs: elapsed(input.elapsedMs) } : {}), ...(attemptNumber(input.attempt) !== undefined ? { attempt: attemptNumber(input.attempt) } : {}), ...(playbackRecord(input.playback) ? { playback: playbackRecord(input.playback) } : {}) });
    if (said) this.timings.heard(said.key, input.id, { ...(started !== undefined ? { play: started } : {}), result, ...(typeof input.detail === 'string' && input.detail ? { detail: input.detail.slice(0, 80) } : {}), playback: playbackRecord(input.playback) });
    done(result);
    return true;
  }

  /** A current page's diagnostic receipt/progress; terminal results remain in voicePlayed. */
  voiceProgress(input: { session: unknown; id: unknown; event: unknown; elapsedMs: unknown; gate?: unknown; playback?: unknown; attempt?: unknown; reason?: unknown; error?: unknown }): boolean {
    if (!this.current(input.session) || typeof input.id !== 'string' || !this.results.has(input.id)) return false;
    const said = this.says.get(input.id);
    const progress = progressRecord(input);
    if (!said || !progress) return false;
    if (progress.event === 'started') { said.started = true; said.onStarted?.(); }
    this.timings.progress(said.key, input.id, progress);
    return true;
  }

  /** Only the authenticated web relay can report a request the host already observed. */
  voiceTransport(input: { live: unknown; requestId: unknown; web: unknown }): boolean {
    if (typeof input.live !== 'string' || !UUID.test(input.live) || typeof input.requestId !== 'string' || !UUID.test(input.requestId)) return false;
    const web = transportStage(input.web);
    return Boolean(web && this.timings.webTransport(input.live, input.requestId, web));
  }

  /**
   * The owner's answer to an answer not read aloud (`MasterVoiceStatus.missed`): heard again whole, read like one that
   * waited for its turn's end, or dismissed. Either way it is no longer told of. Nothing to read stays unread.
   */
  voiceMissed(input: { session: unknown; entry: unknown; action: unknown }): boolean {
    if (!this.current(input.session) || typeof input.entry !== 'string' || (input.action !== 'replay' && input.action !== 'dismiss')) return false;
    if (this.missed?.entry === input.entry) { this.missed = undefined; this.broadcast(); }
    if (input.action === 'dismiss') return true;
    const entry = this.options.room.get(input.entry);
    const speak = speakOf(entry?.data);
    if (!entry || !speak || (speak.state !== 'unspoken' && speak.state !== 'played') || speak.reason === 'empty') return false;
    this.ready();
    const rest = bare(speak);
    // Made pending, it is taken into what waits to be read (`follow`) and read whole when its turn comes.
    this.setSpeak(entry, { ...rest, state: 'pending', again: new Date().toISOString() });
    return true;
  }

  /** Reads what is waiting, one at a time, while voice is on; what cannot be read is marked so on screen. */
  deliver(): void {
    if (this.delivering) { this.deliverAgain = true; return; }
    this.delivering = true;
    void (async () => {
      try {
        do {
          this.deliverAgain = false;
          this.sweep();
          const waiting = this.speakEntries().filter(item => item.speak.state === 'pending');
          // Bounded: the oldest beyond the queue's size is given up on.
          for (const { entry, speak } of waiting.slice(0, Math.max(0, waiting.length - SAY_QUEUE))) this.setSpeak(entry, unspoken(speak, 'queue'));
          for (const { entry } of waiting.slice(-SAY_QUEUE)) {
            if (this.closed) return;
            const current = speakOf(this.options.room.get(entry.id)?.data);
            if (current?.state !== 'pending') continue;
            const session = this.session;
            if (!session || !this.alive(session)) { this.setSpeak(entry, unspoken(current, 'away')); continue; }
            await this.onLine(() => this.readEntry(session, entry));
          }
        } while (this.deliverAgain && !this.closed);
      } finally { this.delivering = false; }
    })();
  }

  private async readEntry(session: Session, entry: MasterEntry): Promise<void> {
    const speak = speakOf(this.options.room.get(entry.id)?.data);
    if (!speak || speak.state !== 'pending') return;
    const text = this.content(entry.data);
    const model = this.options.settings.current().voice.model;
    // Each finite part keeps its original display text; tags and bracket conversion belong only to speech.
    const kind = entry.data.kind === 'error' ? 'error' : speak.session ? 'answer' : 'report';
    const parts = voicedPartPairs(text, model, kind);
    // Kept shorter than it was: the owner hears that the rest is on the screen.
    if (speak.cut && parts.length && !parts.at(-1)!.text.endsWith(VOICE_REST)) parts.push({ text: VOICE_REST, speech: voiced(VOICE_REST, model, kind) });
    const chars = parts.reduce((sum, part) => sum + part.speech.length, 0);
    // Judged and recorded together: nothing else can start making audio in between.
    const refused: MasterUnspoken | undefined = !parts.length ? 'empty' : this.session !== session || !this.alive(session) ? this.gone(session) : this.usage.limited(Date.now(), chars * ttsDollarsPerChar(model)) ? 'limit' : undefined;
    if (refused) { this.setSpeak(entry, unspoken(speak, refused)); return; }
    const request = entry.data.kind === 'master' ? entry.data.request : undefined;
    const key = speak.timing ?? request;
    this.timings.mark(key, 'text', Date.now(), { mode: 'turn-end' });
    let heard = false;
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      const refuse = this.session !== session || !this.alive(session) ? this.gone(session) : this.usage.limited(Date.now(), part.speech.length * ttsDollarsPerChar(model)) ? 'limit' : undefined;
      if (refuse) { this.setSpeak(entry, unspoken(speakOf(this.options.room.get(entry.id)?.data) ?? speak, refuse, heard)); return; }
      const live = this.audio.synthesize(part.speech, undefined, key);
      this.audio.configure(live, { session, held: true, partIndex: index });
      try {
        if (!await this.audio.complete(live) || this.session !== session) {
          this.audio.abandon(live);
          this.setSpeak(entry, unspoken(speakOf(this.options.room.get(entry.id)?.data) ?? speak, this.session !== session ? this.gone(session) : 'audio', heard)); return;
        }
        this.setSpeak(entry, { ...speak, state: 'playing' });
        const { result, started } = await this.play(session, { kind: speak.session ? 'answer' : 'report', text: part.text, audio: live.id, streaming: true,
          ...(request ? { request } : {}), ...(key ? { timing: key } : {}) }, this.timing.playMs + part.speech.length * MS_PER_CHAR);
        heard ||= started || result === 'played';
        if (result !== 'played') {
          this.setSpeak(entry, unspoken(speakOf(this.options.room.get(entry.id)?.data) ?? speak, reasonOf(result), heard)); return;
        }
      } finally { this.audio.configure(live, { held: false }); }
    }
    this.setSpeak(entry, played(speakOf(this.options.room.get(entry.id)?.data) ?? speak));
  }

  // ─── reading while the master writes ─────────────────────────────────────────────────────────────────────────

  /**
   * The master's words for a turn so far (called whenever they grew): read aloud chunk by chunk as they are written,
   * where voice is on. A turn starts to be read only with something whole to say, while its voice session is on; its
   * record is kept first (`streamState`), so it is never read again after a restart. Replies keep their order; each
   * gets its own audio when its turn to play comes, so a tool call between two never holds audio open on the page.
   */
  stream(input: StreamInput): void {
    if (this.closed) return;
    this.reader.stream(input);
  }

  /** Whether a turn is being read while it is written. */
  streaming(turn: string): boolean { return this.reader.streaming(turn); }
  streamingTurns(): string[] { return this.reader.streamingTurns(); }

  /**
   * A turn that was read while it was written ended: what was not read yet is read, then its entry is added, marked
   * played when all of it was heard (or unspoken). Nothing is read twice, and no entry of it waits to be read. A turn
   * that failed or was stopped stops being read; its error is read only when nothing of the turn was.
   */
  finishStream(input: { turn: string; replies?: readonly RunReply[]; completed: boolean; data?: MasterEntryData }): void { this.reader.finishStream(input); }

  /** Whether reading aloud is under way: a turn being read, audio being made, or the page's word awaited. */
  busy(): boolean { return this.reader.busy() || this.results.size > 0 || this.audio.busy(); }

  /**
   * Sends one thing to the session's page to play, and waits for its word (or gives up): how it went, and whether its
   * sound started. Each one, and the word on it, goes into the timing record.
   */
  private play(session: Session, what: { kind: MasterSay['kind']; text: string; audio: string; request?: string; streaming?: true; timing?: string }, waitMs: number, signal?: AbortSignal, onSay?: (say: MasterSay) => void, onStarted?: () => void): Promise<{ result: string; started: boolean }> {
    const id = randomUUID();
    const key = what.timing ?? what.request;
    const say: MasterSay = { id, session: session.digest, kind: what.kind, text: what.text, audio: `/api/master/voice/audio/${what.audio}`, expiresAt: Date.now() + 60_000,
      ...(what.request ? { request: what.request } : {}), ...(what.streaming ? { streaming: true as const } : {}) };
    return new Promise(resolve => {
      const finish = (result: string) => {
        clearTimeout(timer);
        const started = Boolean(this.says.get(id)?.started);
        this.results.delete(id); this.says.delete(id); signal?.removeEventListener('abort', stopped);
        this.timings.heard(key, id, { result });
        if (result !== 'played') this.options.room.broadcast({ type: 'say', seq: 0, say: { ...say, cancelled: true } });
        resolve({ result, started });
      };
      const stopped = () => finish('stopped');
      const timer = setTimeout(() => finish('timeout'), waitMs);
      this.results.set(id, finish);
      signal?.addEventListener('abort', stopped, { once: true });
      if (signal?.aborted || this.session !== session) { finish('stopped'); return; }
      if (key) { this.says.set(id, { key, at: Date.now(), ...(onStarted ? { onStarted } : {}) }); this.timings.mark(key, 'say'); this.timings.said(key, id, Date.now(), what.text.length, what.audio); }
      onSay?.(say);
      this.options.room.broadcast({ type: 'say', seq: 0, say });
    });
  }

  /** What is read of an entry: hidden whole, then all of it as it is heard (without markdown), and hidden again. */
  private content(data: MasterEntryData): string {
    const hide = this.options.hooks.hide;
    const raw = data.kind === 'master' ? data.text : data.kind === 'error' ? `요청을 처리하지 못했습니다: ${data.text}` : data.kind === 'event' ? data.text : '';
    return hide(speakable(hide(raw)));
  }

  // ─── audio ───────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Audio for the page (through the web): a voice sample kept on disk, or audio being made or kept for a while. A
   * missing one is a bodiless 404; see `VoiceClips.serve` and `VoiceAudio.serve`.
   */
  async serveAudio(id: string, sink: StreamSink, at = 0, requestId: string = randomUUID()): Promise<void> {
    const preview = /^preview-([a-f0-9]{64})$/.exec(id);
    if (preview) return this.clips.serve(preview[1], sink);
    return this.audio.serve(id, sink, at, requestId);
  }

  /** How many readers and waiters audio still has, for tests: none once its readers are gone. */
  listeners(id: string): number { return this.audio.listeners(id); }

  /**
   * A short sample in a voice, for the owner choosing one in the settings: read with the model and bright tone set
   * now, made once per voice and model, and paid for like anything else read aloud. Needs only the key.
   */
  async voicePreview(input: { voiceId: unknown }): Promise<{ audio: string }> { return this.clips.preview(input); }

  /** Voices the account can use; needs only the key, so a voice can be chosen before the master session starts. */
  async voiceVoices(): Promise<VoiceInfo[]> { return this.clips.voices(); }

  // ─── cost ────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Whether today's limit is already reached, so nothing more would be read aloud. */
  spentOut(): boolean { return this.usage.spentOut(); }

  // ─── news to read ────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Keeps the list of news not yet read as the conversation changes, whatever else is added meanwhile; and, as each
   * reading ends, its outcome in the timing record and what the owner is told of beside the voice.
   */
  private follow(event: MasterStreamEvent, history = false): void {
    if (event.type !== 'entry') return;
    const speak = speakOf(event.entry.data);
    const known = this.usage.isSpeaking(event.entry.id);
    const open = speak?.state === 'pending' || speak?.state === 'playing';
    // Its reading ended now: added ended, or waiting until now.
    if (speak && !open && !history && (known || event.entry.revision === 1)) this.ended(event.entry, speak);
    if (open && !known) {
      this.usage.addSpeaking(event.entry.id, event.entry.order);
      for (let oldest; (oldest = this.usage.overflowing());) {
        const entry = this.options.room.get(oldest.id);
        const stale = speakOf(entry?.data);
        // Given up on while still in the list, so its end is recorded and told of like any other (the room's change
        // may remove that listing itself).
        if (entry && stale && (stale.state === 'pending' || stale.state === 'playing')) this.setSpeak(entry, unspoken(stale, 'queue'));
        this.usage.removeFirstIfSame(oldest.token);
      }
      if (speak?.state === 'pending') this.deliver();
    } else if (!open && known) this.usage.removeSpeaking(event.entry.id);
    else return;
    void this.usage.save();
  }

  /** A reading ended: kept in its timing record, and told of beside the voice when the owner should know. */
  private ended(entry: MasterEntry, speak: MasterSpeak): void {
    if (speak.state !== 'played' && speak.state !== 'unspoken') return;
    const key = speak.timing ?? (entry.data.kind === 'master' ? entry.data.request : undefined);
    this.timings.outcome(key, { state: speak.state, ...(speak.reason ? { reason: speak.reason } : {}), ...(speak.heard ? { heard: true as const } : {}) });
    const missed = this.missed;
    if (speak.state === 'unspoken' && speak.reason && !QUIET.has(speak.reason)) {
      if (missed && missed.order > entry.order) return;
      const text = entry.data.kind === 'owner' ? '' : entry.data.text.replace(/\s+/g, ' ').trim();
      this.missed = { entry: entry.id, order: entry.order, at: Date.now(), reason: speak.reason, ...(speak.heard ? { heard: true as const } : {}), text: text.length > 80 ? `${text.slice(0, 79)}…` : text };
      this.broadcastSoon();
    } else if (missed && (missed.entry === entry.id || (speak.state === 'played' && entry.order > missed.order))) {
      // Heard after all, or something later was: no longer told of.
      this.missed = undefined;
      this.broadcastSoon();
    }
  }

  private async rebuildSpeaking(): Promise<void> {
    for (let before = Number.MAX_SAFE_INTEGER; ;) {
      const page = await this.options.room.page(before, 200).catch(() => undefined);
      if (!page?.entries.length) break;
      for (const entry of page.entries) this.follow({ type: 'entry', seq: 0, entry }, true);
      if (!page.hasMore || Date.now() - Date.parse(page.entries[0].at) > STALE_MS) break;
      before = page.entries[0].order;
    }
  }

  private speakEntries(): Array<{ entry: MasterEntry; speak: MasterSpeak }> {
    return this.usage.speakingList().flatMap(item => {
      const entry = this.options.room.get(item.id);
      const speak = speakOf(entry?.data);
      return entry && speak ? [{ entry, speak }] : [];
    }).sort((a, b) => a.entry.order - b.entry.order);
  }

  private sweep(): void {
    const now = Date.now();
    for (const { entry, speak } of this.speakEntries()) if (speak.state === 'pending' && now - Date.parse(speak.again ?? entry.at) > STALE_MS) this.setSpeak(entry, unspoken(speak, 'queue'));
  }

  private setSpeak(entry: MasterEntry, speak: MasterSpeak): void {
    const data = this.options.room.get(entry.id)?.data;
    if (data && (data.kind === 'master' || data.kind === 'error' || data.kind === 'event')) this.options.room.update(entry.id, { ...data, speak });
  }

  // ─── plumbing ────────────────────────────────────────────────────────────────────────────────────────────────

  private ready(): void {
    const settings = this.options.settings.current();
    if (!settings.session) throw fail('마스터 세션이 아직 없습니다. 먼저 글로 한 번 말을 걸어 주세요.', 'conflict');
    if (!this.options.settings.voiceKey()) throw fail('ElevenLabs API 키가 없습니다. 마스터 설정에서 넣어 주세요.', 'conflict');
  }

  private current(session: unknown): Session | undefined {
    return typeof session === 'string' && this.session?.id === session ? this.session : undefined;
  }

  /** Why `session` is no longer the one to read to: how it ended, or its page gone (or voice moved). */
  private gone(session: Session): MasterUnspoken { return this.session === session ? 'away' : session.ended ?? 'away'; }

  /** Why an answer that comes with no voice page to read it is not read: voice turned off by the owner, or no page there. */
  quiet(): MasterUnspoken { return !this.session && this.lastEnded?.ended === 'stopped' ? 'stopped' : 'away'; }

  /** The voice page is still there (it tells so every few seconds). */
  private alive(session: Session): boolean { return Date.now() - session.seenAt < this.timing.presenceMs; }

  /**
   * Ends a session at once: what it was playing stops, and it gets no more of anything. `reason`: the owner turned
   * voice off (`stopped`), voice moved or started again (`away`), or the host is closing (`restart`).
   */
  private endSession(session: Session | undefined, reason: 'stopped' | 'away' | 'restart'): void {
    if (!session || this.session !== session) return;
    this.session = undefined;
    session.ended = reason;
    this.lastEnded = session;
    this.options.firstReply?.close();
    // The page's word first, so what each said ended with is recorded before its reading's outcome.
    for (const done of [...this.results.values()]) done(reason);
    this.audio.abandonSession(session);
    this.reader.stopSession(session, reason);
  }

  /** Playback, one thing at a time. */
  private onLine<T>(work: () => Promise<T>): Promise<T> {
    const next = this.line.then(work, work);
    this.line = next.catch(() => {});
    return next;
  }

  private tick(): void {
    const now = Date.now();
    this.usage.settleExpired(now);
    this.sweep();
    // Nothing waits to write a first reply for a page that is gone.
    if (!this.session || !this.alive(this.session)) this.options.firstReply?.close();
    this.audio.expire(now);
    this.usage.pruneDays(now);
    const day = localDay(now);
    if (day !== this.shownDay) { this.shownDay = day; this.broadcast(); }
    // Too old to be told of any more: pages stop showing it.
    if (this.missed && now - this.missed.at >= STALE_MS) { this.missed = undefined; this.broadcast(); }
  }

  broadcast(): void { this.options.room.broadcast({ type: 'voice', seq: 0, voice: this.status() }); }

  /**
   * Broadcast once the step under way is over: a reading ended while voice moves to another tab is told with the new
   * session, so the tab it left sees it moved (not voice gone from the host).
   */
  private broadcastSoon(): void { queueMicrotask(() => { if (!this.closed) this.broadcast(); }); }
}
