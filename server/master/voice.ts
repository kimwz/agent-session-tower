import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { MasterEntry, MasterEntryData, MasterMissed, MasterSay, MasterSpeak, MasterStreamEvent, MasterUnspoken, MasterViewContext, MasterVoiceStatus } from '../../shared/master.js';
import type { RunReply } from '../../shared/types.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import type { ElevenLabs, VoiceInfo } from './elevenlabs.js';
import type { FirstReplyMaker } from './first-reply.js';
import type { MasterRoom } from './room.js';
import type { MasterSettingsStore } from './settings.js';
import { isNoise, READ_CHARS, speakable, streamTone, VOICE_REST, VOICE_SAMPLE, voiced, voicedChunk, voicedParts } from './voice-text.js';
import { CHUNK_PAUSE_MS, TextFollower } from './voice-stream.js';
import { VoiceTimings } from './voice-timings.js';

/** Estimated prices: ElevenLabs realtime speech-to-text per second, text-to-speech per character by model. */
const STT_DOLLARS_PER_SECOND = 0.39 / 3600;
const ttsDollarsPerChar = (model: string) => (model === 'eleven_v3' ? 0.1 : 0.05) / 1000;
/** GPT-Live's price, for voice time kept from 1.52–1.55. */
const LIVE_DOLLARS_PER_SECOND = 0.05 / 60;
/**
 * A first reply's model call, as counted against the daily limit: paid by the Claude subscription, estimated at Haiku's
 * list price for about 1,000 tokens read and 40 written, rounded up.
 */
const FIRST_REPLY_DOLLARS = 0.002;
/** A first reply not ready this long after the request came is not said: the answer is near by then. */
const FIRST_REPLY_MS = 2_500;
/** One thing said is at most this long (the page stops sending there); each token reserves it until settled. */
const UTTERANCE_SECONDS = 180;
const TOKEN_LIFE_MS = 16 * 60_000;
const TOKENS_PER_SESSION = 2;
const TOKENS_PER_MINUTE = 20;
const SAY_QUEUE = 20;
const KEEP_DAYS = 40;
const KEEP_SPEAKING = 500;
const CLIP_BYTES = 5 * 1024 * 1024;
/** Voice samples kept for the settings: about one per voice an account lists. */
const PREVIEWS = 60;
const LIVE_COUNT = 40;
/** Audio is kept longer than the longest answer read takes (`READ_CHARS` at `MS_PER_CHAR`). */
const LIVE_MS = 20 * 60_000;
/** Audio kept for one thing said: at least this, and more for a long answer (128 kbps is about 3 KB a character). */
const LIVE_BYTES = 2 * 1024 * 1024;
const LIVE_BYTES_PER_CHAR = 4 * 1024;
/** How long reading aloud may take a character, at most: the page gives up on a player later than this too. */
const MS_PER_CHAR = 200;
/** Audio being read while it is written is sealed when no words came for it this long (a turn that hangs). */
const LIVE_WAIT_MS = 5 * 60_000;
/** mp3 at 128 kbps: bytes of audio a second, for starting again partway (see `serveAudio`). */
const MP3_BYTES_PER_SECOND = 16_000;
/** News older than this is not read aloud any more: it is on the screen. */
const STALE_MS = 60 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Turns whose reading stopped, remembered (with why) until their end comes: this many. */
const STOPPED_TURNS = 50;
/** The page's word on something it played, as it may give it. */
const PAGE_RESULTS = new Set(['played', 'stopped', 'interrupted', 'failed', 'blocked', 'expired']);
/** Why reading ended, from the word on what was given to play (the page's, or the host's own: `timeout`, `away`, `restart`). */
const REASONS: Record<string, MasterUnspoken> = { stopped: 'stopped', interrupted: 'stopped', blocked: 'blocked', expired: 'expired', timeout: 'timeout', away: 'away', restart: 'restart' };
const reasonOf = (result: string): MasterUnspoken => REASONS[result] ?? 'failed';
/** What the owner is told of beside the voice: everything but their own stop and a restart. */
const QUIET = new Set<MasterUnspoken>(['stopped', 'restart']);

export interface VoiceTiming {
  firstChunkMs: number; synthMs: number; playMs: number; resyncMs: number; waitMs: number; presenceMs: number; tickMs: number;
}
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

interface Day { sttSeconds: number; ttsChars: number; dollars: number; firstReplies?: number }
export interface VoiceFile {
  version: 6;
  days: Record<string, Day>;
  /** Tokens given to a page and not yet settled: each holds a whole utterance's cost. */
  tokens: Array<{ id: string; session: string; issuedAt: number }>;
  /** Conversation entries with news not yet read aloud or given up on. */
  speaking: Array<{ id: string; order: number }>;
}

/** The tab where voice is on. Its id lives in memory only; pages know it by its digest. */
interface Session {
  id: string;
  digest: string;
  tabId: string;
  local: boolean;
  listening: boolean;
  seenAt: number;
  activity?: { receivedAt: number; lastSpeechAt: number };
  /** How it ended (`endSession`), for what was still waiting on it. */
  ended?: 'stopped' | 'away' | 'restart';
}

/** Audio being made (or made) for the page, kept a short while. */
interface Live {
  id: string;
  chunks: Buffer[];
  bytes: number;
  done: boolean;
  failed: boolean;
  createdAt: number;
  waiters: Set<() => void>;
  readers: Set<ServerResponse>;
  /** Stops the request for sound under way. */
  stop?: () => void;
  /** What is to be read, in order: more may be added (`feed`) until it is sealed. */
  parts: string[];
  sealed: boolean;
  /** Parts asked for so far (the rest were never paid for if it fails). */
  sent: number;
  charged: number;
  voiceId: string;
  model: string;
  /** Held by a turn being read: never pushed out while it is. */
  held: boolean;
  /** The spoken request (or report) it answers, for the timing records. */
  timing?: string;
}

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
  parts: string[];
  fed: number;
  /** What the page shows while it plays. */
  text: string;
  done: boolean;
  queued: boolean;
  /** Heard to its end on the page. */
  played?: true;
  /** Its sound started on the page. */
  started?: true;
  live?: Live;
}

interface Stream {
  turn: string;
  key: string;
  kind: 'answer' | 'report';
  request?: string;
  session: Session;
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

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const fail = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });
const localDay = (time: number) => { const date = new Date(time); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
const speakOf = (data: MasterEntryData | undefined): MasterSpeak | undefined => data && (data.kind === 'master' || data.kind === 'error' || data.kind === 'event') ? data.speak : undefined;
const wake = (live: Live) => { for (const waiter of [...live.waiters]) waiter(); };
/** How an answer's reading stands, without how an earlier reading of it ended. */
const bare = ({ reason: _reason, heard: _heard, ...rest }: MasterSpeak): MasterSpeak => rest;
/** An answer's reading ended without it being heard to its end, and why. */
const unspoken = (speak: MasterSpeak | undefined, reason: MasterUnspoken, heard = false): MasterSpeak =>
  ({ ...(speak ? bare(speak) : {}), state: 'unspoken', reason, ...(heard ? { heard: true as const } : {}) });
/** An answer's reading went to its end. */
const played = (speak: MasterSpeak | undefined): MasterSpeak => ({ ...(speak ? bare(speak) : {}), state: 'played' });
const withSpeak = (data: MasterEntryData, speak: MasterSpeak): MasterEntryData => ({ ...data, speak } as MasterEntryData);
/**
 * An mp3 stream without the ID3 tag it starts with. The parts of a long answer are made one after another into one
 * stream, and only the first part's tag may stand at its start.
 */
async function* withoutTag(stream: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  let head = Buffer.alloc(0);
  let skip = -1;
  for await (const chunk of stream) {
    if (skip < 0) {
      head = Buffer.concat([head, chunk]);
      if (head.length < 10) continue;
      // An ID3v2 header: "ID3", version, flags (0x10: a footer follows), then the tag's size in 7-bit bytes.
      skip = head.subarray(0, 3).toString('latin1') === 'ID3'
        ? 10 + (((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f)) + (head[5] & 0x10 ? 10 : 0)
        : 0;
      const rest = head.subarray(Math.min(skip, head.length));
      skip = Math.max(0, skip - head.length);
      if (rest.length) yield rest;
      continue;
    }
    if (skip >= chunk.length) { skip -= chunk.length; continue; }
    const rest = skip ? chunk.subarray(skip) : chunk;
    skip = 0;
    yield rest;
  }
  if (skip < 0 && head.length) yield head;
}

/** How many bytes the ID3v2 tag an mp3 starts with takes (0 without one). */
export function id3Size(data: Buffer): number {
  if (data.length < 10 || data.subarray(0, 3).toString('latin1') !== 'ID3') return 0;
  return 10 + (((data[6] & 0x7f) << 21) | ((data[7] & 0x7f) << 14) | ((data[8] & 0x7f) << 7) | (data[9] & 0x7f)) + (data[5] & 0x10 ? 10 : 0);
}

/** The first MPEG-1 layer III frame at or after `from` (its header, and the next frame's when it is there), or the end. */
export function frameAt(data: Buffer, from: number): number {
  const BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const RATES = [44_100, 48_000, 32_000];
  const length = (at: number) => {
    if (at + 4 > data.length || data[at] !== 0xff || (data[at + 1] & 0xfe) !== 0xfa) return 0;
    const bitrate = BITRATES[data[at + 2] >> 4];
    const rate = RATES[(data[at + 2] >> 2) & 3];
    if (!bitrate || !rate) return 0;
    return Math.floor(144_000 * bitrate / rate) + ((data[at + 2] >> 1) & 1);
  };
  for (let at = Math.max(0, from); at + 4 <= data.length; at++) {
    const size = length(at);
    if (!size) continue;
    if (at + size + 4 > data.length || length(at + size)) return at;
  }
  return data.length;
}

/**
 * The master's voice. The owner's page listens and writes down what is said with ElevenLabs directly, using a
 * single-use token from here; what is said becomes a request like a typed one. Answers, news of finished work, and
 * the sentence before an irreversible change are read aloud: made here with the owner's key and played by the page
 * where voice is on. Turning voice off never stops anything the master does.
 */
export class MasterVoice {
  private file: VoiceFile = { version: 6, days: {}, tokens: [], speaking: [] };
  private session?: Session;
  private readonly lives = new Map<string, Live>();
  private readonly results = new Map<string, (result: string) => void>();
  private line: Promise<unknown> = Promise.resolve();
  private writes: Promise<void> = Promise.resolve();
  private delivering = false;
  private deliverAgain = false;
  private recentTokens: number[] = [];
  private shownDay = localDay(Date.now());
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private closed = false;
  private readonly timing: VoiceTiming;
  private readonly path: string;
  private readonly previews: string;
  /** Recordings being made, by digest. */
  private readonly recording = new Map<string, Promise<string>>();
  /** Turns read while they are written, by turn. */
  private readonly streams = new Map<string, Stream>();
  /** For the timing records: a say's request and when it went to the page. */
  private readonly says = new Map<string, { key: string; at: number; started?: boolean }>();
  /** Turns whose reading stopped, and why, for when their end comes (`finishStream`). */
  private readonly stoppedTurns = new Map<string, { reason: MasterUnspoken; heard: boolean }>();
  /** The latest answer or report not read aloud that the owner is told of (see `MasterVoiceStatus.missed`). */
  private missed?: MasterMissed & { order: number; at: number };
  /** The session that ended last, for an answer that comes after it (`quiet`). */
  private lastEnded?: Session;
  private pauseTimer?: ReturnType<typeof setInterval>;
  readonly timings: VoiceTimings;

  constructor(private readonly options: MasterVoiceOptions) {
    this.timing = { ...TIMING, ...options.timing };
    this.path = join(options.dataDir, 'voice.json');
    this.previews = join(options.dataDir, 'voice-previews');
    this.timings = new VoiceTimings(join(options.dataDir, 'voice-timings.json'));
  }

  async start(): Promise<void> {
    const saved = await readPrivateJson(this.path).catch(() => undefined) as Record<string, unknown> | undefined;
    this.file = migrate(saved, Date.now());
    await this.timings.start();
    // Short replies recorded before 1.73 are not said any more.
    await rm(join(this.options.dataDir, 'voice-clips'), { recursive: true, force: true }).catch(() => {});
    // News waiting to be read may sit in an older part of the conversation; nothing being read survives a restart.
    for (const item of this.file.speaking) await this.options.room.load(item.order).catch(() => {});
    this.file.speaking = this.file.speaking.filter(item => speakOf(this.options.room.get(item.id)?.data));
    if (saved && !Array.isArray(saved.speaking)) await this.rebuildSpeaking();
    this.unsubscribe = this.options.room.subscribe(event => this.follow(event));
    for (const { entry, speak } of this.speakEntries()) if (speak.state !== 'played' && speak.state !== 'unspoken') this.setSpeak(entry, unspoken(speak, 'restart'));
    this.settleExpired(Date.now());
    await this.save();
    this.timer = setInterval(() => this.tick(), this.timing.tickMs);
    this.timer.unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    if (this.pauseTimer) clearInterval(this.pauseTimer);
    this.endSession(this.session, 'restart');
    this.options.firstReply?.close();
    for (const live of [...this.lives.values()]) this.drop(live);
    await this.writes;
    await this.timings.flush();
  }

  status(): MasterVoiceStatus {
    const now = Date.now();
    const today = this.file.days[localDay(now)] ?? { sttSeconds: 0, ttsChars: 0, dollars: 0 };
    return {
      ...(this.session ? { session: this.session.digest } : {}),
      listening: Boolean(this.session?.listening && this.alive(this.session)),
      today: { sttSeconds: Math.round(today.sttSeconds), ttsChars: today.ttsChars, dollars: Math.round(this.spent(now) * 100) / 100 },
      limitDollars: this.options.settings.current().voice.dailyDollars,
      limited: this.limited(now, 0),
      ...(this.missed && now - this.missed.at < STALE_MS ? { missed: { entry: this.missed.entry, reason: this.missed.reason, ...(this.missed.heard ? { heard: true as const } : {}), text: this.missed.text } } : {}),
    };
  }

  // ─── the page's session ──────────────────────────────────────────────────────────────────────────────────────

  /** The owner turned voice on in a tab: a new session, which ends any before it. */
  voiceOn(input: { tabId: unknown; local: boolean }): { session: string } {
    if (typeof input.tabId !== 'string' || !UUID.test(input.tabId)) throw fail('음성 켜기 요청이 올바르지 않습니다.', 400);
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
    if (!session) throw fail('음성 세션이 바뀌었습니다.', 409);
    this.ready();
    const now = Date.now();
    this.settleExpired(now);
    if (this.file.tokens.filter(token => token.session === session.digest).length >= TOKENS_PER_SESSION) throw fail('받아쓰기 준비가 이미 되어 있습니다.', 409);
    this.recentTokens = this.recentTokens.filter(at => now - at < 60_000);
    if (this.recentTokens.length >= TOKENS_PER_MINUTE) throw fail('받아쓰기 요청이 너무 많습니다.', 429);
    if (this.limited(now, UTTERANCE_SECONDS * STT_DOLLARS_PER_SECOND)) throw fail('오늘 음성 한도에 닿았습니다.', 409);
    // Held before the token is asked for, so two requests at once cannot both pass the limit.
    const id = randomUUID();
    this.file.tokens.push({ id, session: session.digest, issuedAt: now });
    this.recentTokens.push(now);
    let token: string;
    try { token = await this.options.elevenLabs.sttToken(); }
    catch (error) {
      this.file.tokens = this.file.tokens.filter(item => item.id !== id);
      throw error;
    }
    await this.save();
    this.broadcast();
    return { tokenId: id, url: this.options.elevenLabs.sttUrl(token), expiresAt: now + 14 * 60_000 };
  }

  /** How long one utterance ran, from any page that got its token (voice may have moved since). Counted once, today. */
  async voiceUsage(input: { tokenId: unknown; seconds: unknown }): Promise<boolean> {
    if (typeof input.tokenId !== 'string') return false;
    const index = this.file.tokens.findIndex(token => token.id === input.tokenId);
    if (index < 0) return false;
    this.file.tokens.splice(index, 1);
    const seconds = typeof input.seconds === 'number' && Number.isFinite(input.seconds) ? Math.min(Math.max(input.seconds, 0), UTTERANCE_SECONDS) : UTTERANCE_SECONDS;
    this.add(Date.now(), { sttSeconds: seconds });
    await this.save();
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
    if (typeof input.clientMessageId !== 'string' || !/^[a-zA-Z0-9-]{8,64}$/.test(input.clientMessageId)) throw fail('요청 ID가 올바르지 않습니다.', 400);
    if (typeof input.text !== 'string' || input.text.length > 4_000) throw fail('받아쓴 글이 올바르지 않습니다.', 400);
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
    if (this.limited(Date.now(), FIRST_REPLY_DOLLARS)) return undefined;
    this.add(Date.now(), { firstReply: true });
    void this.save();
    const signal = AbortSignal.any([cancel, AbortSignal.timeout(FIRST_REPLY_MS)]);
    const reply = await maker.make(text, signal);
    if (!reply.text || signal.aborted || this.session !== session || !this.alive(session) || this.answering(request)) return undefined;
    // A card's value in it would go out as it is: such a sentence is not said.
    if (this.options.hooks.hide(reply.text) !== reply.text) return undefined;
    const model = this.options.settings.current().voice.model;
    const sent = voiced(reply.text, model, 'ack');
    // Judged against the limit as it is now (an answer may have spent meanwhile), and charged in the same step.
    if (this.limited(Date.now(), sent.length * ttsDollarsPerChar(model))) return undefined;
    const live = this.synthesize(sent);
    if (!await this.firstChunk(live) || this.session !== session) { this.abandon(live); return undefined; }
    return { id: randomUUID(), session: session.digest, kind: 'ack', text: reply.text, audio: `/api/master/voice/audio/${live.id}`, expiresAt: Date.now() + 60_000, request };
  }

  /** Whether `session` is the voice session now (for a judgment the web makes about it). */
  voiceKnown(input: { session: unknown }): boolean { return Boolean(this.current(input.session)); }

  /** Whether the answer to a spoken request has begun to be read: a first response would come too late then. */
  private answering(request: string): boolean {
    return [...this.streams.values()].some(stream => stream.request === request && stream.segments.some(segment => segment.queued))
      || [...this.says.values()].some(say => say.key === request);
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
  voicePlayed(input: { session: unknown; id: unknown; result: unknown; startedMs?: unknown; detail?: unknown }): boolean {
    if (!this.current(input.session) || typeof input.id !== 'string') return false;
    const done = this.results.get(input.id);
    if (!done) return false;
    const result = PAGE_RESULTS.has(String(input.result)) ? String(input.result) : 'failed';
    // How long the page took from being told to play to its sound starting, measured on its own clock.
    const said = this.says.get(input.id);
    const started = said && typeof input.startedMs === 'number' && Number.isFinite(input.startedMs) && input.startedMs >= 0 && input.startedMs < 3_600_000 ? said.at + input.startedMs : undefined;
    if (said && started !== undefined) this.timings.mark(said.key, 'play', started);
    if (said && started !== undefined) said.started = true;
    if (said) this.timings.heard(said.key, input.id, { ...(started !== undefined ? { play: started } : {}), result, ...(typeof input.detail === 'string' && input.detail ? { detail: input.detail.slice(0, 80) } : {}) });
    done(result);
    return true;
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
    // All of it is read, in parts of whole sentences made into one stream; the tone tag goes only to speech, and the
    // page is sent the text as it is.
    const kind = entry.data.kind === 'error' ? 'error' : speak.session ? 'answer' : 'report';
    const parts = voicedParts(text, model, kind);
    // Kept shorter than it was: the owner hears that the rest is on the screen.
    if (speak.cut && parts.length && !parts.at(-1)!.endsWith(VOICE_REST)) parts.push(voiced(VOICE_REST, model, kind));
    const chars = parts.reduce((sum, part) => sum + part.length, 0);
    // Judged and recorded together: nothing else can start making audio in between.
    const refused: MasterUnspoken | undefined = !parts.length ? 'empty' : this.session !== session || !this.alive(session) ? this.gone(session) : this.limited(Date.now(), chars * ttsDollarsPerChar(model)) ? 'limit' : undefined;
    if (refused) { this.setSpeak(entry, unspoken(speak, refused)); return; }
    const request = entry.data.kind === 'master' ? entry.data.request : undefined;
    const key = speak.timing ?? request;
    this.timings.mark(key, 'text', Date.now(), { mode: 'turn-end' });
    const live = this.synthesize(parts, undefined, key);
    if (!await this.firstChunk(live) || this.session !== session) { this.abandon(live); this.setSpeak(entry, unspoken(speak, this.session !== session ? this.gone(session) : 'audio')); return; }
    this.setSpeak(entry, { ...speak, state: 'playing' });
    const { result, started } = await this.play(session, { kind: speak.session ? 'answer' : 'report', text, audio: live.id, ...(request ? { request } : {}), ...(key ? { timing: key } : {}) }, this.timing.playMs + chars * MS_PER_CHAR);
    // Not heard to the end (skipped, voice ended, or given up on): the parts not made yet are not asked for.
    if (result !== 'played') this.abandon(live);
    const later = speakOf(this.options.room.get(entry.id)?.data) ?? speak;
    // Played on the page, but its audio failed partway: the page heard it end where the sound stopped.
    this.setSpeak(entry, result !== 'played' ? unspoken(later, reasonOf(result), started) : live.failed ? unspoken(later, 'audio', true) : played(later));
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
    let stream = this.streams.get(input.turn);
    if (!stream) {
      const session = this.session;
      if (!session || !this.alive(session) || (input.voiceSession && input.voiceSession !== session.digest) || this.speaks(input.kind === 'report') !== 'pending') return;
      stream = { turn: input.turn, key: input.key, kind: input.kind, ...(input.request ? { request: input.request } : {}), session, segments: [], read: 0, full: false,
        lastChunkAt: Date.now(), state: 'starting', played: 0, replies: input.replies };
      this.take(stream, input.replies, false);
      // Nothing whole to say yet: looked at again with more words (the same words give the same chunks).
      if (!stream.segments.some(segment => segment.parts.length)) return;
      this.streams.set(input.turn, stream);
      this.timings.mark(stream.key, 'text', Date.now(), { kind: stream.kind, mode: 'stream' });
      const started = stream;
      void (this.options.hooks.streamState?.(input.turn, 'started') ?? Promise.resolve()).then(() => {
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
      this.options.room.add(withSpeak(data, added));
      if (added.state === 'pending') this.deliver();
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

  /** Whether reading aloud is under way: a turn being read, audio being made, or the page's word awaited. */
  busy(): boolean { return this.streams.size > 0 || this.results.size > 0 || [...this.lives.values()].some(live => !live.done); }

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
    const model = this.options.settings.current().voice.model;
    stream.tag = streamTone(plain, model, stream.kind, stream.tag);
    segment.parts.push(...voicedChunk(plain, model, stream.tag));
    segment.text = `${segment.text} ${plain}`.trim();
    stream.read += plain.length;
    stream.lastChunkAt = Date.now();
  }

  /** What is heard of words the master wrote: hidden whole, as they are heard (without markdown), and hidden again. */
  private hearable(raw: string): string {
    const hide = this.options.hooks.hide;
    return hide(speakable(hide(raw)));
  }

  /** Feeds a segment's new parts into its audio (and seals it when done), or queues its turn to play. */
  private pump(stream: Stream, segment: Segment): void {
    if (stream.state !== 'streaming') return;
    const live = segment.live;
    if (live) {
      while (segment.fed < segment.parts.length) {
        if (!this.feed(live, segment.parts[segment.fed])) {
          // Refused while still open: the daily limit (not the end of its audio).
          if (!live.sealed && !live.done) stream.limitHit = true;
          this.seal(live); stream.full = true; segment.fed = segment.parts.length; break;
        }
        segment.fed++;
      }
      if (segment.done && segment.fed >= segment.parts.length) this.seal(live);
      return;
    }
    if (segment.queued || !segment.parts.length) return;
    segment.queued = true;
    void this.onLine(() => this.playSegment(stream, segment));
  }

  /** A segment's turn to play: its audio is made now, played, and the turn stops being read if it was not heard. */
  private async playSegment(stream: Stream, segment: Segment): Promise<void> {
    const session = stream.session;
    if (stream.state !== 'streaming') return;
    if (this.session !== session || !this.alive(session)) { this.stopStream(stream, this.gone(session)); return; }
    const live = this.openLive(undefined, stream.key);
    live.held = true;
    segment.live = live;
    this.pump(stream, segment);
    // Nothing could be paid for: the turn is not read further.
    if (!live.parts.length) { this.seal(live); live.held = false; this.stopStream(stream, 'limit'); return; }
    try {
      if (!await this.firstChunk(live) || this.session !== session || stream.state !== 'streaming') { this.abandon(live); this.stopStream(stream, this.session !== session ? this.gone(session) : 'audio'); return; }
      const { result, started } = await this.play(session, { kind: stream.kind, text: segment.text, audio: live.id, streaming: true, timing: stream.key, ...(stream.request ? { request: stream.request } : {}) },
        this.timing.playMs + READ_CHARS * MS_PER_CHAR);
      if (started) segment.started = true;
      // Not heard to its end: nothing more of the turn is read, and why is kept for its entry.
      if (result !== 'played' || live.failed) { this.abandon(live); this.stopStream(stream, result !== 'played' ? reasonOf(result) : 'audio'); return; }
      live.held = false;
      segment.played = true;
      stream.played++;
      this.settle(stream);
    } finally { live.held = false; }
  }

  /** Once a finished turn's segments were all played, its entry is added (played) and its reading ends. */
  private settle(stream: Stream): void {
    if (stream.state !== 'streaming' || !stream.finishing) return;
    if (stream.segments.some(segment => segment.parts.length && !segment.played)) return;
    stream.state = 'finished';
    this.streams.delete(stream.turn);
    const entry = stream.finishing.data;
    if (entry && (entry.kind === 'master' || entry.kind === 'event' || entry.kind === 'error')) this.options.room.add(withSpeak(entry, stream.limitHit ? unspoken(entry.speak, 'limit', true) : played(entry.speak)));
    void this.options.hooks.streamState?.(stream.turn, 'done').catch(() => {});
  }

  /**
   * A turn stops being read: its audio stops, nothing more of it is read, and its record says so. Its entry says why
   * (now, or when the turn ends: `stoppedTurns`), so the owner is told of it beside the voice.
   */
  private stopStream(stream: Stream, reason: MasterUnspoken): void {
    if (stream.state === 'stopped' || stream.state === 'finished') return;
    stream.state = 'stopped';
    this.streams.delete(stream.turn);
    for (const segment of stream.segments) if (segment.live) { this.abandon(segment.live); segment.live.held = false; }
    const heard = this.heardOf(stream);
    const finishing = stream.finishing?.data;
    if (finishing && (finishing.kind === 'master' || finishing.kind === 'event' || finishing.kind === 'error')) this.options.room.add(withSpeak(finishing, unspoken(finishing.speak, reason, heard)));
    else {
      this.stoppedTurns.set(stream.turn, { reason, heard });
      while (this.stoppedTurns.size > STOPPED_TURNS) this.stoppedTurns.delete(this.stoppedTurns.keys().next().value!);
    }
    // Ended without an entry (the turn's end tells): kept in the timing record now.
    if (!finishing) this.timings.outcome(stream.key, { state: 'unspoken', reason, ...(heard ? { heard: true as const } : {}) });
    void this.options.hooks.streamState?.(stream.turn, 'stopped').catch(() => {});
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

  /**
   * Sends one thing to the session's page to play, and waits for its word (or gives up): how it went, and whether its
   * sound started. Each one, and the word on it, goes into the timing record.
   */
  private play(session: Session, what: { kind: MasterSay['kind']; text: string; audio: string; request?: string; streaming?: true; timing?: string }, waitMs: number, signal?: AbortSignal): Promise<{ result: string; started: boolean }> {
    const id = randomUUID();
    const key = what.timing ?? what.request;
    return new Promise(resolve => {
      const finish = (result: string) => {
        clearTimeout(timer);
        const started = Boolean(this.says.get(id)?.started);
        this.results.delete(id); this.says.delete(id); signal?.removeEventListener('abort', stopped);
        this.timings.heard(key, id, { result });
        resolve({ result, started });
      };
      const stopped = () => finish('stopped');
      const timer = setTimeout(() => finish('timeout'), waitMs);
      this.results.set(id, finish);
      signal?.addEventListener('abort', stopped, { once: true });
      if (signal?.aborted || this.session !== session) { finish('stopped'); return; }
      if (key) { this.says.set(id, { key, at: Date.now() }); this.timings.mark(key, 'say'); this.timings.said(key, id, Date.now(), what.text.length); }
      this.options.room.broadcast({ type: 'say', seq: 0, say: { id, session: session.digest, kind: what.kind, text: what.text, audio: `/api/master/voice/audio/${what.audio}`, expiresAt: Date.now() + 60_000,
        ...(what.request ? { request: what.request } : {}), ...(what.streaming ? { streaming: true as const } : {}) } });
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
   * Starts making audio for text, given whole or in parts made one after another into one stream; the page can play
   * it while it is still being made. The caller has checked the limit in the same step: the characters are counted
   * here, before anything is awaited.
   */
  private synthesize(text: string | string[], voice?: { voiceId: string; model: string }, timing?: string): Live {
    const live = this.openLive(voice, timing);
    const parts = typeof text === 'string' ? [text] : text;
    const chars = parts.reduce((sum, part) => sum + part.length, 0);
    // Characters sent are paid for, whether or not the audio comes back whole.
    this.add(live.createdAt, { ttsChars: chars, model: live.model });
    live.charged = chars;
    live.parts.push(...parts);
    live.sealed = true;
    wake(live);
    void this.save();
    this.broadcast();
    return live;
  }

  /**
   * Audio that parts are added to (`feed`) until it is sealed (`seal`), made part after part into one stream while the
   * page plays it. Waiting for a part has no time limit other than `LIVE_WAIT_MS`; each request for sound has its own.
   */
  private openLive(voice?: { voiceId: string; model: string }, timing?: string): Live {
    const settings = voice ?? this.options.settings.current().voice;
    const live: Live = { id: randomUUID(), chunks: [], bytes: 0, done: false, failed: false, createdAt: Date.now(), waiters: new Set(), readers: new Set(),
      parts: [], sealed: false, sent: 0, charged: 0, voiceId: settings.voiceId, model: settings.model, held: false, ...(timing ? { timing } : {}) };
    this.lives.set(live.id, live);
    this.evict();
    void this.make(live);
    return live;
  }

  /** Adds a part to audio being made, paid for now: false (and nothing added) when sealed, stopped or over the limit. */
  private feed(live: Live, part: string): boolean {
    if (live.sealed || live.done || this.limited(Date.now(), part.length * ttsDollarsPerChar(live.model))) return false;
    this.add(Date.now(), { ttsChars: part.length, model: live.model });
    live.charged += part.length;
    live.parts.push(part);
    wake(live);
    void this.save();
    this.broadcast();
    return true;
  }

  /** No more parts: the audio ends after those it has. */
  private seal(live: Live): void {
    if (live.sealed) return;
    live.sealed = true;
    wake(live);
  }

  private async make(live: Live): Promise<void> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      for (let index = 0; ; index++) {
        while (index >= live.parts.length) {
          if (live.failed) throw new Error('stopped');
          if (live.sealed) { live.done = true; return; }
          await this.until(live, () => live.failed || live.sealed || index < live.parts.length, LIVE_WAIT_MS);
          // No words came for it for a long while: it ends with what it has.
          if (!live.failed && !live.sealed && index >= live.parts.length) live.sealed = true;
        }
        if (live.failed) throw new Error('stopped');
        const part = live.parts[index];
        live.sent = index + 1;
        const most = Math.max(LIVE_BYTES, live.charged * LIVE_BYTES_PER_CHAR);
        // Each part has its own time; a part that failed before any of its sound came is asked for once more, if
        // the daily limit allows paying for it again. A part that comes back without sound has failed.
        for (let attempt = 0; ; attempt++) {
          const controller = new AbortController();
          live.stop = () => controller.abort(new Error('stopped'));
          // Timed from the last sound that came: a long part is given its time as long as sound keeps coming.
          const idle = () => { clearTimeout(deadline); deadline = setTimeout(() => controller.abort(new Error('시간 초과')), this.timing.synthMs); };
          idle();
          let got = false;
          this.timings.mark(live.timing, 'tts');
          try {
            const stream = this.options.elevenLabs.speak(part, live.voiceId, live.model, controller.signal);
            for await (const chunk of index ? withoutTag(stream) : stream) {
              if (live.failed) throw new Error('stopped');
              if (live.bytes + chunk.length > most) throw new Error('too large');
              idle();
              if (!got) this.timings.mark(live.timing, 'audio');
              got = true;
              live.chunks.push(chunk);
              live.bytes += chunk.length;
              wake(live);
            }
            if (!got) throw new Error('no sound');
            break;
          } catch (error) {
            if (got || attempt > 0 || live.failed || (error as Error).message === 'too large' || this.limited(Date.now(), part.length * ttsDollarsPerChar(live.model))) throw error;
            this.add(Date.now(), { ttsChars: part.length, model: live.model });
            void this.save();
          } finally { clearTimeout(deadline); }
        }
      }
    } catch {
      live.failed = true;
      live.done = true;
      live.sealed = true;
      // Parts never asked for are not paid for.
      const unsent = live.parts.slice(live.sent).reduce((sum, part) => sum + part.length, 0);
      if (unsent) { this.add(live.createdAt, { ttsChars: -unsent, model: live.model }); void this.save(); this.broadcast(); }
    } finally {
      clearTimeout(deadline);
      // A reader of audio that failed sees its connection cut, never a clean end.
      if (live.failed) for (const reader of live.readers) this.cutOff(reader);
      wake(live);
    }
  }

  /** At most `LIVE_COUNT` pieces of audio are kept: the oldest go first, never one a turn being read holds. */
  private evict(): void {
    while (this.lives.size > LIVE_COUNT) {
      const oldest = [...this.lives.values()].find(live => !live.held);
      if (!oldest) break;
      this.drop(oldest);
    }
  }

  /** Audio nobody will hear any more: the request under way stops, and no further part is asked for. */
  private abandon(live: Live): void {
    if (live.done) return;
    live.failed = true;
    live.stop?.();
    wake(live);
  }

  private firstChunk(live: Live): Promise<boolean> {
    return this.until(live, () => live.chunks.length > 0 || live.done, this.timing.firstChunkMs).then(() => live.chunks.length > 0 && !live.failed);
  }
  private finished(live: Live): Promise<void> { return this.until(live, () => live.done, this.timing.synthMs); }
  private until(live: Live, ready: () => boolean, ms: number): Promise<void> {
    if (ready()) return Promise.resolve();
    return new Promise(resolve => {
      const check = () => { if (ready()) finish(); };
      const finish = () => { clearTimeout(timer); live.waiters.delete(check); resolve(); };
      const timer = setTimeout(finish, ms);
      live.waiters.add(check);
    });
  }

  /** Ends audio kept too long (or pushed out): readers still waiting are cut off, and it is gone. */
  private drop(live: Live): void {
    if (!live.done) { live.failed = true; live.done = true; }
    for (const reader of live.readers) if (live.failed) this.cutOff(reader);
    wake(live);
    this.lives.delete(live.id);
  }

  /**
   * Streams audio to the page (through the web): what is made so far, then the rest as it comes. A slow page is
   * waited for, but never past its connection closing or a while; nothing waiting is left behind either way.
   */
  async serveAudio(id: string, res: ServerResponse, at = 0): Promise<void> {
    const preview = /^preview-([a-f0-9]{64})$/.exec(id);
    if (preview) {
      const data = await readFile(join(this.previews, `${preview[1]}.mp3`)).catch(() => undefined);
      if (!data) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'Content-Length': data.length }).end(data);
      return;
    }
    const live = this.lives.get(id);
    if (!live) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
    live.readers.add(res);
    let index = 0;
    try {
      // Played again from `at` seconds (the page lost its connection partway): from the first whole frame there.
      if (at > 0 && live.chunks.length) {
        const made = Buffer.concat(live.chunks);
        index = live.chunks.length;
        const from = frameAt(made, id3Size(made) + Math.floor(at * MP3_BYTES_PER_SECOND));
        if (from < made.length && !res.write(made.subarray(from)) && !await this.wait(res, live, true)) { res.destroy(); return; }
      }
      while (!res.destroyed && !res.writableEnded) {
        while (index < live.chunks.length && !res.destroyed) {
          // A page that does not take what it was sent in a while is cut off.
          if (!res.write(live.chunks[index++]) && !await this.wait(res, live, true)) { res.destroy(); return; }
        }
        if (res.destroyed) return;
        if (live.failed) { this.cutOff(res); return; }
        if (live.done && index >= live.chunks.length) { res.end(); return; }
        await this.wait(res, live, false);
      }
    } finally { live.readers.delete(res); }
  }

  /**
   * Cuts a page off failed audio, never with a clean end, once what it was sent has left: cut at once, audio written
   * just before would be thrown away, and a page that came late would get nothing of what was made.
   */
  private cutOff(res: ServerResponse): void {
    const socket = res.socket;
    if (!socket || socket.destroyed) { res.destroy(); return; }
    // Ending the connection (not the response) sends what is queued first; the page sees a response cut short.
    const timer = setTimeout(() => res.destroy(), this.timing.waitMs);
    socket.once('close', () => clearTimeout(timer));
    socket.end();
  }

  /**
   * Waits for the page to drain what it was sent (`drain`), or for more audio (otherwise); either way also for its
   * connection ending or a while passing, which is the only false answer. Leaves nothing registered.
   */
  private wait(res: ServerResponse, live: Live, drain: boolean): Promise<boolean> {
    return new Promise(resolve => {
      const done = (value: boolean) => {
        clearTimeout(timer);
        res.off('drain', drained); res.off('close', ended); res.off('error', ended);
        live.waiters.delete(more);
        resolve(value);
      };
      const drained = () => done(true);
      const ended = () => done(true);
      const more = () => { if (!drain || live.failed) done(true); };
      // A player takes a long answer as it plays, so it may not read for a while; it is waited for while its
      // connection is open and the audio is kept. More audio is waited for a while, then looked at again.
      const timer = setTimeout(() => done(false), drain ? Math.max(this.timing.waitMs, live.createdAt + LIVE_MS - Date.now()) : this.timing.waitMs);
      if (drain) res.once('drain', drained);
      res.once('close', ended);
      res.once('error', ended);
      live.waiters.add(more);
    });
  }

  /** How many readers and waiters audio still has, for tests: none once its readers are gone. */
  listeners(id: string): number {
    const live = this.lives.get(id);
    return live ? live.waiters.size + live.readers.size : 0;
  }

  /**
   * Audio of a fixed sentence in a voice and model, kept in `dir` under its digest and made only when it is not there;
   * the same recording asked for twice at once is made once. Made with exactly the voice and model it is kept under.
   */
  private record(dir: string, sent: string, voiceId: string, model: string, keep: number): Promise<string> {
    const key = createHash('sha256').update(JSON.stringify([voiceId, model, sent])).digest('hex');
    const known = this.recording.get(key);
    if (known) return known;
    const work = (async () => {
      const path = join(dir, `${key}.mp3`);
      if (await stat(path).then(() => true, () => false)) return key;
      if (this.limited(Date.now(), sent.length * ttsDollarsPerChar(model))) throw new Error('limited');
      const live = this.synthesize(sent, { voiceId, model });
      await this.finished(live);
      // Not done in time: nothing more is asked for, and what came is not kept.
      if (live.failed || !live.done) { this.abandon(live); this.drop(live); throw new Error('clip failed'); }
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(path, Buffer.concat(live.chunks), { mode: 0o600 });
      this.drop(live);
      await this.prune(dir, key, keep);
      return key;
    })();
    this.recording.set(key, work);
    void work.catch(() => {}).finally(() => this.recording.delete(key));
    return work;
  }

  /** At most `keep` recordings and `CLIP_BYTES` in all, the newest kept (and the one just made, always). */
  private async prune(dir: string, keep: string, most: number): Promise<void> {
    const names = (await readdir(dir).catch(() => [] as string[])).filter(name => /^[a-f0-9]{64}\.mp3$/.test(name));
    const files = await Promise.all(names.map(async name => ({ name, info: await stat(join(dir, name)).catch(() => undefined) })));
    const known = files.filter((file): file is { name: string; info: NonNullable<typeof file.info> } => Boolean(file.info))
      .sort((a, b) => (b.name === `${keep}.mp3` ? 1 : 0) - (a.name === `${keep}.mp3` ? 1 : 0) || b.info.mtimeMs - a.info.mtimeMs);
    let bytes = 0;
    for (const [index, file] of known.entries()) {
      bytes += file.info.size;
      if (index > 0 && (index >= most || bytes > CLIP_BYTES)) await unlink(join(dir, file.name)).catch(() => {});
    }
  }

  /**
   * A short sample in a voice, for the owner choosing one in the settings: read with the model and bright tone set
   * now, made once per voice and model, and paid for like anything else read aloud. Needs only the key.
   */
  async voicePreview(input: { voiceId: unknown }): Promise<{ audio: string }> {
    if (!this.options.settings.voiceKey()) throw fail('ElevenLabs API 키가 없습니다. 마스터 설정에서 넣어 주세요.', 409);
    if (typeof input.voiceId !== 'string' || !/^[A-Za-z0-9]{10,64}$/.test(input.voiceId)) throw fail('목소리가 올바르지 않습니다.', 400);
    const { model } = this.options.settings.current().voice;
    try {
      const key = await this.record(this.previews, voiced(VOICE_SAMPLE, model, 'answer'), input.voiceId, model, PREVIEWS);
      return { audio: `/api/master/voice/audio/preview-${key}` };
    } catch (error) {
      if ((error as Error).message === 'limited') throw fail('오늘 음성 한도에 닿았습니다.', 409);
      throw fail('미리 듣기를 만들지 못했습니다. 이 계정에서 쓸 수 있는 목소리인지 확인해 주세요.', 502);
    }
  }

  /** Voices the account can use; needs only the key, so a voice can be chosen before the master session starts. */
  async voiceVoices(): Promise<VoiceInfo[]> {
    if (!this.options.settings.voiceKey()) throw fail('ElevenLabs API 키가 없습니다. 마스터 설정에서 넣어 주세요.', 409);
    return this.options.elevenLabs.voices();
  }

  // ─── cost ────────────────────────────────────────────────────────────────────────────────────────────────────

  private add(at: number, used: { sttSeconds?: number; ttsChars?: number; model?: string; firstReply?: true }): void {
    const day = (this.file.days[localDay(at)] ??= { sttSeconds: 0, ttsChars: 0, dollars: 0 });
    if (used.firstReply) { day.firstReplies = (day.firstReplies ?? 0) + 1; day.dollars += FIRST_REPLY_DOLLARS; }
    if (used.sttSeconds) { day.sttSeconds += used.sttSeconds; day.dollars += used.sttSeconds * STT_DOLLARS_PER_SECOND; }
    if (used.ttsChars) { day.ttsChars += used.ttsChars; day.dollars += used.ttsChars * ttsDollarsPerChar(used.model ?? ''); }
  }

  /** Today's dollars, with every unsettled token (whenever it was given) held as a whole utterance. */
  private spent(now: number): number {
    const reserved = this.file.tokens.length * UTTERANCE_SECONDS * STT_DOLLARS_PER_SECOND;
    return (this.file.days[localDay(now)]?.dollars ?? 0) + reserved;
  }

  /** Whether today's limit is already reached, so nothing more would be read aloud. */
  spentOut(): boolean {
    const limit = this.options.settings.current().voice.dailyDollars;
    return limit > 0 && this.spent(Date.now()) >= limit - 1e-9;
  }

  /** Whether spending `more` now would pass the daily limit (when there is one). */
  private limited(now: number, more: number): boolean {
    const limit = this.options.settings.current().voice.dailyDollars;
    return limit > 0 && this.spent(now) + more > limit + 1e-9;
  }

  /** Tokens never settled count as a whole utterance, on the day they run out. */
  private settleExpired(now: number): void {
    const expired = this.file.tokens.filter(token => now - token.issuedAt > TOKEN_LIFE_MS);
    if (!expired.length) return;
    this.file.tokens = this.file.tokens.filter(token => now - token.issuedAt <= TOKEN_LIFE_MS);
    for (let index = 0; index < expired.length; index++) this.add(now, { sttSeconds: UTTERANCE_SECONDS });
    void this.save();
  }

  // ─── news to read ────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Keeps the list of news not yet read as the conversation changes, whatever else is added meanwhile; and, as each
   * reading ends, its outcome in the timing record and what the owner is told of beside the voice.
   */
  private follow(event: MasterStreamEvent, history = false): void {
    if (event.type !== 'entry') return;
    const speak = speakOf(event.entry.data);
    const known = this.file.speaking.findIndex(item => item.id === event.entry.id);
    const open = speak?.state === 'pending' || speak?.state === 'playing';
    // Its reading ended now: added ended, or waiting until now.
    if (speak && !open && !history && (known >= 0 || event.entry.revision === 1)) this.ended(event.entry, speak);
    if (open && known < 0) {
      this.file.speaking.push({ id: event.entry.id, order: event.entry.order });
      while (this.file.speaking.length > KEEP_SPEAKING) {
        const oldest = this.file.speaking[0];
        const entry = this.options.room.get(oldest.id);
        const stale = speakOf(entry?.data);
        // Given up on while still in the list, so its end is recorded and told of like any other.
        if (entry && stale && (stale.state === 'pending' || stale.state === 'playing')) this.setSpeak(entry, unspoken(stale, 'queue'));
        if (this.file.speaking[0] === oldest) this.file.speaking.shift();
      }
      if (speak?.state === 'pending') this.deliver();
    } else if (!open && known >= 0) this.file.speaking.splice(known, 1);
    else return;
    void this.save();
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
    return this.file.speaking.flatMap(item => {
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
    if (!settings.session) throw fail('마스터 세션이 아직 없습니다. 먼저 글로 한 번 말을 걸어 주세요.', 409);
    if (!this.options.settings.voiceKey()) throw fail('ElevenLabs API 키가 없습니다. 마스터 설정에서 넣어 주세요.', 409);
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
    for (const stream of [...this.streams.values()]) if (stream.session === session) this.stopStream(stream, reason);
  }

  /** Playback, one thing at a time. */
  private onLine<T>(work: () => Promise<T>): Promise<T> {
    const next = this.line.then(work, work);
    this.line = next.catch(() => {});
    return next;
  }

  private tick(): void {
    const now = Date.now();
    this.settleExpired(now);
    this.sweep();
    // Nothing waits to write a first reply for a page that is gone.
    if (!this.session || !this.alive(this.session)) this.options.firstReply?.close();
    for (const live of [...this.lives.values()]) if (now - live.createdAt > LIVE_MS && !live.held) this.drop(live);
    const oldest = localDay(now - KEEP_DAYS * 86_400_000);
    for (const day of Object.keys(this.file.days)) if (day < oldest) delete this.file.days[day];
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

  private save(): Promise<void> {
    const write = () => writePrivateJson(this.path, JSON.stringify(this.file));
    const next = this.writes.then(write, write);
    this.writes = next.catch(error => { console.error(`Master voice records were not saved: ${(error as NodeJS.ErrnoException)?.code ?? 'error'}`); });
    return next;
  }
}

/**
 * Voice records as kept before (GPT-Live, 1.52–1.55) become today's form in one step: their time, counted and not
 * yet counted, is added to the days as dollars; the calls themselves are dropped. Records in today's form pass as
 * they are, so reading them again adds nothing.
 */
export function migrate(saved: Record<string, unknown> | undefined, now: number): VoiceFile {
  const file: VoiceFile = { version: 6, days: {}, tokens: [], speaking: [] };
  if (!saved || typeof saved !== 'object') return file;
  if (Array.isArray(saved.speaking)) file.speaking = saved.speaking.filter((item): item is { id: string; order: number } => typeof item?.id === 'string' && Number.isInteger(item?.order));
  if (saved.version === 6) {
    if (saved.days && typeof saved.days === 'object') {
      for (const [day, value] of Object.entries(saved.days as Record<string, Partial<Day>>)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(day) && value && typeof value === 'object') file.days[day] = { sttSeconds: Number(value.sttSeconds) || 0, ttsChars: Number(value.ttsChars) || 0, dollars: Number(value.dollars) || 0, ...(Number(value.firstReplies) > 0 ? { firstReplies: Number(value.firstReplies) } : {}) };
      }
    }
    if (Array.isArray(saved.tokens)) file.tokens = saved.tokens.filter((token): token is VoiceFile['tokens'][number] => typeof token?.id === 'string' && typeof token?.session === 'string' && Number.isFinite(token?.issuedAt));
    return file;
  }
  const liveDollars = (day: string, seconds: number) => {
    const entry = (file.days[day] ??= { sttSeconds: 0, ttsChars: 0, dollars: 0 });
    entry.dollars += seconds * LIVE_DOLLARS_PER_SECOND;
  };
  if (saved.days && typeof saved.days === 'object') {
    for (const [day, seconds] of Object.entries(saved.days as Record<string, unknown>)) if (/^\d{4}-\d{2}-\d{2}$/.test(day) && typeof seconds === 'number' && seconds > 0) liveDollars(day, seconds);
  }
  interface OldAttempt { folded?: boolean; unbilled?: boolean; answered?: boolean; readyAt?: number; createdAt?: number; closedAt?: number; expiresAt?: number; usage?: { seconds?: number; observedAt?: number; final?: boolean; byDay?: Record<string, unknown> } }
  for (const attempt of Array.isArray(saved.attempts) ? saved.attempts as OldAttempt[] : []) {
    if (!attempt || typeof attempt !== 'object' || attempt.folded || attempt.unbilled || !Number.isFinite(attempt.createdAt)) continue;
    // Not yet in the days: what it reported, on the days it reported it; for a call whose answer reached the page,
    // the time since its last report until it ended (or now), on the days that time fell; and at least the 15
    // seconds every call is billed, on the day it was made.
    const days: Record<string, number> = {};
    let seconds = 0;
    for (const [day, value] of Object.entries(attempt.usage?.byDay ?? {})) if (/^\d{4}-\d{2}-\d{2}$/.test(day) && typeof value === 'number' && value > 0) { days[day] = (days[day] ?? 0) + value; seconds += value; }
    // Reported without its days (or only partly): the rest goes on the day the call was made.
    const reported = Number(attempt.usage?.seconds) || 0;
    if (reported > seconds) { days[localDay(attempt.createdAt!)] = (days[localDay(attempt.createdAt!)] ?? 0) + reported - seconds; seconds = reported; }
    const reachedPage = attempt.answered ?? attempt.readyAt !== undefined;
    if (!attempt.usage?.final && reachedPage) {
      const from = attempt.usage?.observedAt ?? attempt.readyAt ?? attempt.createdAt!;
      const to = Math.min(attempt.closedAt ?? now, attempt.expiresAt ?? Number.MAX_SAFE_INTEGER, now);
      for (let at = from; at < to;) {
        const midnight = new Date(at); midnight.setHours(24, 0, 0, 0);
        const end = Math.min(to, midnight.getTime());
        days[localDay(at)] = (days[localDay(at)] ?? 0) + (end - at) / 1000;
        seconds += (end - at) / 1000;
        at = end;
      }
    }
    if (seconds < 15) days[localDay(attempt.createdAt!)] = (days[localDay(attempt.createdAt!)] ?? 0) + 15 - seconds;
    for (const [day, value] of Object.entries(days)) liveDollars(day, value);
  }
  return file;
}
