import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { MasterEntry, MasterEntryData, MasterSay, MasterSpeak, MasterStreamEvent, MasterViewContext, MasterVoiceStatus } from '../../shared/master.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import type { ElevenLabs, VoiceInfo } from './elevenlabs.js';
import type { VoiceOrigin } from './journal.js';
import type { MasterRoom } from './room.js';
import type { MasterSettingsStore } from './settings.js';
import { isNoise, speakable, VOICE_ACKS, VOICE_NUDGE, VOICE_WORKING, voiced, voicedParts } from './voice-text.js';

/** Estimated prices: ElevenLabs realtime speech-to-text per second, text-to-speech per character by model. */
const STT_DOLLARS_PER_SECOND = 0.39 / 3600;
const ttsDollarsPerChar = (model: string) => (model === 'eleven_v3' ? 0.1 : 0.05) / 1000;
/** GPT-Live's price, for voice time kept from 1.52–1.55. */
const LIVE_DOLLARS_PER_SECOND = 0.05 / 60;
/** One thing said is at most this long (the page stops sending there); each token reserves it until settled. */
const UTTERANCE_SECONDS = 60;
const TOKEN_LIFE_MS = 16 * 60_000;
const TOKENS_PER_SESSION = 2;
const TOKENS_PER_MINUTE = 20;
const SAY_QUEUE = 20;
const KEEP_DAYS = 40;
const KEEP_SPEAKING = 500;
const CLIPS = 30;
const CLIP_BYTES = 5 * 1024 * 1024;
const LIVE_COUNT = 40;
/** Audio is kept longer than the longest answer read takes (`READ_CHARS` at `MS_PER_CHAR`). */
const LIVE_MS = 20 * 60_000;
/** Audio kept for one thing said: at least this, and more for a long answer (128 kbps is about 3 KB a character). */
const LIVE_BYTES = 2 * 1024 * 1024;
const LIVE_BYTES_PER_CHAR = 4 * 1024;
/** How long reading aloud may take a character, at most: the page gives up on a player later than this too. */
const MS_PER_CHAR = 200;
/** News older than this is not read aloud any more: it is on the screen. */
const STALE_MS = 60 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VoiceTiming {
  firstChunkMs: number; synthMs: number; playMs: number; noticeMs: number; resyncMs: number; waitMs: number; presenceMs: number; tickMs: number;
}
const TIMING: VoiceTiming = { firstChunkMs: 10_000, synthMs: 30_000, playMs: 60_000, noticeMs: 20_000, resyncMs: 15_000, waitMs: 30_000, presenceMs: 15_000, tickMs: 5_000 };

/** What the voice needs from the master: its hiding, its inbox, and when a new web arrived. */
export interface VoiceHooks {
  hide(text: string): string;
  send(input: { clientMessageId: string; text: string; viewContext?: MasterViewContext; local: boolean; voice: VoiceOrigin; spoken: true }): Promise<MasterEntry>;
  connectedSince(): number;
}

export interface MasterVoiceOptions {
  dataDir: string;
  settings: MasterSettingsStore;
  room: MasterRoom;
  hooks: VoiceHooks;
  elevenLabs: ElevenLabs;
  timing?: Partial<VoiceTiming>;
}

interface Day { sttSeconds: number; ttsChars: number; dollars: number }
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
  panelOpen: boolean;
  seenAt: number;
  activity?: { receivedAt: number; lastSpeechAt: number };
  gates: Set<{ since: number; controller: AbortController }>;
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
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const fail = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });
const localDay = (time: number) => { const date = new Date(time); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
const speakOf = (data: MasterEntryData | undefined): MasterSpeak | undefined => data && (data.kind === 'master' || data.kind === 'error' || data.kind === 'event') ? data.speak : undefined;
const wake = (live: Live) => { for (const waiter of [...live.waiters]) waiter(); };
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
  private readonly clips: string;

  constructor(private readonly options: MasterVoiceOptions) {
    this.timing = { ...TIMING, ...options.timing };
    this.path = join(options.dataDir, 'voice.json');
    this.clips = join(options.dataDir, 'voice-clips');
  }

  async start(): Promise<void> {
    const saved = await readPrivateJson(this.path).catch(() => undefined) as Record<string, unknown> | undefined;
    this.file = migrate(saved, Date.now());
    // News waiting to be read may sit in an older part of the conversation; nothing being read survives a restart.
    for (const item of this.file.speaking) await this.options.room.load(item.order).catch(() => {});
    this.file.speaking = this.file.speaking.filter(item => speakOf(this.options.room.get(item.id)?.data));
    if (saved && !Array.isArray(saved.speaking)) await this.rebuildSpeaking();
    this.unsubscribe = this.options.room.subscribe(event => this.follow(event));
    for (const { entry, speak } of this.speakEntries()) if (speak.state !== 'played' && speak.state !== 'unspoken') this.setSpeak(entry, { ...speak, state: 'unspoken' });
    this.settleExpired(Date.now());
    await this.save();
    this.timer = setInterval(() => this.tick(), this.timing.tickMs);
    this.timer.unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    this.endSession(this.session);
    for (const live of [...this.lives.values()]) this.drop(live);
    await this.writes;
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
    };
  }

  // ─── the page's session ──────────────────────────────────────────────────────────────────────────────────────

  /** The owner turned voice on in a tab: a new session, which ends any before it. */
  voiceOn(input: { tabId: unknown; local: boolean }): { session: string } {
    if (typeof input.tabId !== 'string' || !UUID.test(input.tabId)) throw fail('음성 켜기 요청이 올바르지 않습니다.', 400);
    this.ready();
    this.endSession(this.session);
    const id = randomUUID();
    this.session = { id, digest: hash(id), tabId: input.tabId, local: input.local, listening: true, panelOpen: true, seenAt: Date.now(), gates: new Set() };
    this.broadcast();
    this.deliver();
    return { session: id };
  }

  voiceOff(input: { session: unknown }): boolean {
    const session = this.current(input.session);
    if (!session) return false;
    this.endSession(session);
    this.broadcast();
    return true;
  }

  /** Where the page stands: listening or not, and whether the master is open there. Never takes voice back. */
  voicePresence(input: { session: unknown; listening: unknown; panelOpen: unknown }): boolean {
    const session = this.current(input.session);
    if (!session) return false;
    const listening = input.listening === true, panelOpen = input.panelOpen === true;
    const changed = session.listening !== listening || session.panelOpen !== panelOpen || !this.alive(session);
    Object.assign(session, { listening, panelOpen, seenAt: Date.now() });
    if (changed) { this.broadcast(); if (this.alive(session)) this.deliver(); }
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
    for (const gate of session.gates) if (session.activity.lastSpeechAt >= gate.since) gate.controller.abort(new Error('소유자가 말했습니다.'));
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

  /** What the owner said, written down on their page: a request like a typed one, answered first with a short reply. */
  async voiceRequest(input: { session: unknown; clientMessageId: unknown; text: unknown; viewContext?: MasterViewContext; local: boolean }): Promise<{ ignored?: true; stale?: true; ack?: MasterSay }> {
    const session = this.current(input.session);
    if (!session) return { stale: true };
    if (typeof input.clientMessageId !== 'string' || !/^[a-zA-Z0-9-]{8,64}$/.test(input.clientMessageId)) throw fail('요청 ID가 올바르지 않습니다.', 400);
    if (typeof input.text !== 'string' || input.text.length > 4_000) throw fail('받아쓴 글이 올바르지 않습니다.', 400);
    session.seenAt = Date.now();
    if (isNoise(input.text)) return { ignored: true };
    await this.options.hooks.send({
      clientMessageId: input.clientMessageId, text: input.text.trim(), local: input.local,
      viewContext: { ...input.viewContext, tabId: session.tabId },
      voice: { session: session.digest, key: hash(input.clientMessageId) }, spoken: true,
    });
    const ack = await this.clipSay(session, VOICE_ACKS[Math.floor(Math.random() * VOICE_ACKS.length)], 'ack').catch(() => undefined);
    return ack ? { ack } : {};
  }

  /** Whether `session` is the voice session now (for a judgment the web makes about it). */
  voiceKnown(input: { session: unknown }): boolean { return Boolean(this.current(input.session)); }

  /**
   * A short sign that the owner is still being listened to, for a long pause in the middle of what they say: played
   * by the page only, from a recording, and never a request, an answer or the end of what is being said.
   */
  async voiceNudge(input: { session: unknown }): Promise<{ stale?: true; say?: MasterSay }> {
    const session = this.current(input.session);
    if (!session) return { stale: true };
    session.seenAt = Date.now();
    const say = await this.clipSay(session, VOICE_NUDGE, 'ack').catch(() => undefined);
    return say ? { say } : {};
  }

  /** A spoken request takes a while: said once, from a recording. */
  async working(origin: VoiceOrigin): Promise<void> {
    const session = this.session;
    if (!session || origin.session !== session.digest || !this.alive(session)) return;
    const say = await this.clipSay(session, VOICE_WORKING, 'working').catch(() => undefined);
    if (say && this.session === session) this.options.room.broadcast({ type: 'say', seq: 0, say });
  }

  // ─── reading aloud ───────────────────────────────────────────────────────────────────────────────────────────

  /**
   * How an answer (or, `report`, news of finished work) is told: read aloud where voice is on with the master open,
   * or marked as not said aloud when there is no such page (a report only while voice is on somewhere). Nothing when
   * reports are not read, or for a report with voice off.
   */
  speaks(report: boolean): 'pending' | 'unspoken' | undefined {
    const session = this.session;
    if (report && !this.options.settings.current().voice.readReports) return undefined;
    if (session && this.alive(session)) return 'pending';
    return session || !report ? 'unspoken' : undefined;
  }

  /** The page's word on something it was given to play (a notice included). */
  voicePlayed(input: { session: unknown; id: unknown; result: unknown }): boolean {
    if (!this.current(input.session) || typeof input.id !== 'string') return false;
    const done = this.results.get(input.id);
    if (!done) return false;
    done(['played', 'stopped', 'interrupted'].includes(String(input.result)) ? String(input.result) : 'failed');
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
          for (const { entry, speak } of waiting.slice(0, Math.max(0, waiting.length - SAY_QUEUE))) this.setSpeak(entry, { ...speak, state: 'unspoken' });
          for (const { entry } of waiting.slice(-SAY_QUEUE)) {
            if (this.closed) return;
            const current = speakOf(this.options.room.get(entry.id)?.data);
            if (current?.state !== 'pending') continue;
            const session = this.session;
            if (!session || !this.alive(session)) { this.setSpeak(entry, { ...current, state: 'unspoken' }); continue; }
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
    const parts = voicedParts(text, model, entry.data.kind === 'error' ? 'error' : speak.session ? 'answer' : 'report');
    const chars = parts.reduce((sum, part) => sum + part.length, 0);
    // Judged and recorded together: nothing else can start making audio in between.
    if (!parts.length || this.session !== session || !this.alive(session) || this.limited(Date.now(), chars * ttsDollarsPerChar(model))) { this.setSpeak(entry, { ...speak, state: 'unspoken' }); return; }
    const live = this.synthesize(parts);
    if (!await this.firstChunk(live) || this.session !== session) { this.abandon(live); this.setSpeak(entry, { ...speak, state: 'unspoken' }); return; }
    this.setSpeak(entry, { ...speak, state: 'playing' });
    const result = await this.play(session, { kind: speak.session ? 'answer' : 'report', text, audio: live.id }, this.timing.playMs + chars * MS_PER_CHAR);
    // Not heard to the end (skipped, voice ended, or given up on): the parts not made yet are not asked for.
    if (result !== 'played') this.abandon(live);
    const later = speakOf(this.options.room.get(entry.id)?.data) ?? speak;
    this.setSpeak(entry, { ...later, state: result === 'played' && !live.failed ? 'played' : 'unspoken' });
  }

  /** Sends one thing to the session's page to play, and waits for its word (or gives up). */
  private play(session: Session, what: { kind: MasterSay['kind']; text: string; audio: string }, waitMs: number, signal?: AbortSignal): Promise<string> {
    const id = randomUUID();
    return new Promise(resolve => {
      const finish = (result: string) => { clearTimeout(timer); this.results.delete(id); signal?.removeEventListener('abort', stopped); resolve(result); };
      const stopped = () => finish('stopped');
      const timer = setTimeout(() => finish('timeout'), waitMs);
      this.results.set(id, finish);
      signal?.addEventListener('abort', stopped, { once: true });
      if (signal?.aborted || this.session !== session) { finish('stopped'); return; }
      this.options.room.broadcast({ type: 'say', seq: 0, say: { id, session: session.digest, kind: what.kind, text: what.text, audio: `/api/master/voice/audio/${what.audio}`, expiresAt: Date.now() + 60_000 } });
    });
  }

  /**
   * Before an irreversible change of a spoken request: the sentence is read aloud on the page where voice is
   * listening. The change may go only if the whole sentence was made and played, nobody objected in the moment
   * after, and the page's next word (after it played) says the owner did not speak since it began.
   */
  async announce(text: string, signal: AbortSignal): Promise<{ ok: true; signal: AbortSignal; check: () => Promise<boolean>; done: () => void } | { ok: false; reason: string }> {
    const session = this.session;
    if (!session || !session.listening || !this.alive(session)) return { ok: false, reason: '음성을 듣는 중이 아니라 먼저 알릴 수 없어 되돌릴 수 없는 작업을 보내지 않았습니다.' };
    const since = Date.now();
    const gate = { since, controller: new AbortController() };
    session.gates.add(gate);
    const done = () => { session.gates.delete(gate); };
    const hidden = this.options.hooks.hide(text).slice(0, 200);
    const result = await this.onLine(async () => {
      if (this.session !== session || signal.aborted) return 'stopped';
      const model = this.options.settings.current().voice.model;
      const sent = voiced(hidden, model, 'notice');
      if (this.limited(Date.now(), sent.length * ttsDollarsPerChar(model))) return 'failed';
      const live = this.synthesize(sent);
      if (!await this.firstChunk(live)) return 'failed';
      const heard = await this.play(session, { kind: 'notice', text: hidden, audio: live.id }, this.timing.noticeMs, AbortSignal.any([signal, gate.controller.signal]));
      // Played only counts for the whole sentence: one cut off by a failed synthesis is not a notice.
      if (heard === 'played') await this.finished(live);
      return heard === 'played' && live.done && !live.failed ? 'played' : heard === 'played' ? 'failed' : heard;
    });
    const playedAt = Date.now();
    if (result !== 'played' || gate.controller.signal.aborted || this.session !== session) {
      done();
      const reason = result === 'interrupted' || (result === 'played' && gate.controller.signal.aborted && this.session === session) ? '안내 뒤 소유자가 말하거나 취소해서 보내지 않았습니다. 무엇을 원하는지 다시 들어 주세요.'
        : result === 'stopped' || this.session !== session ? '중지되어 보내지 않았습니다.' : '안내를 들려 드리지 못해 보내지 않았습니다.';
      return { ok: false, reason };
    }
    const check = async () => {
      // Only the page's word from after the notice played counts: an older one may have missed the owner speaking.
      const deadline = Date.now() + this.timing.resyncMs;
      const heard = () => (session.activity?.receivedAt ?? 0) > Math.max(this.options.hooks.connectedSince(), playedAt);
      while (this.session === session && !heard() && !gate.controller.signal.aborted && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      return this.session === session && session.listening && heard() && !gate.controller.signal.aborted && (session.activity?.lastSpeechAt ?? 0) < since;
    };
    return { ok: true, signal: gate.controller.signal, check, done };
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
  private synthesize(text: string | string[]): Live {
    const settings = this.options.settings.current().voice;
    const parts = typeof text === 'string' ? [text] : text;
    const chars = parts.reduce((sum, part) => sum + part.length, 0);
    const most = Math.max(LIVE_BYTES, chars * LIVE_BYTES_PER_CHAR);
    const live: Live = { id: randomUUID(), chunks: [], bytes: 0, done: false, failed: false, createdAt: Date.now(), waiters: new Set(), readers: new Set() };
    this.lives.set(live.id, live);
    while (this.lives.size > LIVE_COUNT) this.drop(this.lives.values().next().value!);
    // Characters sent are paid for, whether or not the audio comes back whole.
    const chargedAt = Date.now();
    this.add(chargedAt, { ttsChars: chars, model: settings.model });
    void this.save();
    this.broadcast();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let sent = 0;
    void (async () => {
      try {
        for (const [index, part] of parts.entries()) {
          if (live.failed) throw new Error('stopped');
          sent = index + 1;
          // Each part has its own time; a part that failed before any of its sound came is asked for once more, if
          // the daily limit allows paying for it again. A part that comes back without sound has failed.
          for (let attempt = 0; ; attempt++) {
            const controller = new AbortController();
            live.stop = () => controller.abort(new Error('stopped'));
            // Timed from the last sound that came: a long part is given its time as long as sound keeps coming.
            const idle = () => { clearTimeout(deadline); deadline = setTimeout(() => controller.abort(new Error('시간 초과')), this.timing.synthMs); };
            idle();
            let got = false;
            try {
              const stream = this.options.elevenLabs.speak(part, settings.voiceId, settings.model, controller.signal);
              for await (const chunk of index ? withoutTag(stream) : stream) {
                if (live.failed) throw new Error('stopped');
                if (live.bytes + chunk.length > most) throw new Error('too large');
                idle();
                got = true;
                live.chunks.push(chunk);
                live.bytes += chunk.length;
                wake(live);
              }
              if (!got) throw new Error('no sound');
              break;
            } catch (error) {
              if (got || attempt > 0 || live.failed || (error as Error).message === 'too large' || this.limited(Date.now(), part.length * ttsDollarsPerChar(settings.model))) throw error;
              this.add(Date.now(), { ttsChars: part.length, model: settings.model });
              void this.save();
            } finally { clearTimeout(deadline); }
          }
        }
        live.done = true;
      } catch {
        live.failed = true;
        live.done = true;
        // Parts never asked for are not paid for.
        const unsent = parts.slice(sent).reduce((sum, part) => sum + part.length, 0);
        if (unsent) { this.add(chargedAt, { ttsChars: -unsent, model: settings.model }); void this.save(); this.broadcast(); }
      } finally {
        clearTimeout(deadline);
        // A reader of audio that failed sees its connection cut, never a clean end.
        if (live.failed) for (const reader of live.readers) this.cutOff(reader);
        wake(live);
      }
    })();
    return live;
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
  async serveAudio(id: string, res: ServerResponse): Promise<void> {
    const clip = /^clip-([a-f0-9]{64})$/.exec(id);
    if (clip) {
      const data = await readFile(join(this.clips, `${clip[1]}.mp3`)).catch(() => undefined);
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

  /** A short fixed sentence, made once per voice and model and kept on disk; played from there each time. */
  private async clipSay(session: Session, text: string, kind: 'ack' | 'working'): Promise<MasterSay> {
    const settings = this.options.settings.current().voice;
    // A card's value found in a fixed sentence would go out as it is: such a sentence is not said.
    if (this.options.hooks.hide(text) !== text) throw new Error('hidden');
    const sent = voiced(text, settings.model, 'ack');
    const key = createHash('sha256').update(JSON.stringify([settings.voiceId, settings.model, sent])).digest('hex');
    const path = join(this.clips, `${key}.mp3`);
    if (!await stat(path).then(() => true, () => false)) {
      if (this.limited(Date.now(), sent.length * ttsDollarsPerChar(settings.model))) throw new Error('limited');
      const live = this.synthesize(sent);
      await this.finished(live);
      if (live.failed || !live.done) throw new Error('clip failed');
      await mkdir(this.clips, { recursive: true, mode: 0o700 });
      await writeFile(path, Buffer.concat(live.chunks), { mode: 0o600 });
      this.drop(live);
      await this.pruneClips(key);
    }
    return { id: randomUUID(), session: session.digest, kind, text, audio: `/api/master/voice/audio/clip-${key}`, expiresAt: Date.now() + 60_000 };
  }

  /** At most `CLIPS` recordings and `CLIP_BYTES` in all, the newest kept (and the one just made, always). */
  private async pruneClips(keep: string): Promise<void> {
    const names = (await readdir(this.clips).catch(() => [] as string[])).filter(name => /^[a-f0-9]{64}\.mp3$/.test(name));
    const files = await Promise.all(names.map(async name => ({ name, info: await stat(join(this.clips, name)).catch(() => undefined) })));
    const known = files.filter((file): file is { name: string; info: NonNullable<typeof file.info> } => Boolean(file.info))
      .sort((a, b) => (b.name === `${keep}.mp3` ? 1 : 0) - (a.name === `${keep}.mp3` ? 1 : 0) || b.info.mtimeMs - a.info.mtimeMs);
    let bytes = 0;
    for (const [index, file] of known.entries()) {
      bytes += file.info.size;
      if (index > 0 && (index >= CLIPS || bytes > CLIP_BYTES)) await unlink(join(this.clips, file.name)).catch(() => {});
    }
  }

  async voiceVoices(): Promise<VoiceInfo[]> { this.ready(); return this.options.elevenLabs.voices(); }

  // ─── cost ────────────────────────────────────────────────────────────────────────────────────────────────────

  private add(at: number, used: { sttSeconds?: number; ttsChars?: number; model?: string }): void {
    const day = (this.file.days[localDay(at)] ??= { sttSeconds: 0, ttsChars: 0, dollars: 0 });
    if (used.sttSeconds) { day.sttSeconds += used.sttSeconds; day.dollars += used.sttSeconds * STT_DOLLARS_PER_SECOND; }
    if (used.ttsChars) { day.ttsChars += used.ttsChars; day.dollars += used.ttsChars * ttsDollarsPerChar(used.model ?? ''); }
  }

  /** Today's dollars, with every unsettled token (whenever it was given) held as a whole utterance. */
  private spent(now: number): number {
    const reserved = this.file.tokens.length * UTTERANCE_SECONDS * STT_DOLLARS_PER_SECOND;
    return (this.file.days[localDay(now)]?.dollars ?? 0) + reserved;
  }

  /** Whether today's limit is already reached, so nothing more would be read aloud. */
  spentOut(): boolean { return this.limited(Date.now(), 0); }

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

  /** Keeps the list of news not yet read as the conversation changes, whatever else is added meanwhile. */
  private follow(event: MasterStreamEvent): void {
    if (event.type !== 'entry') return;
    const speak = speakOf(event.entry.data);
    const known = this.file.speaking.findIndex(item => item.id === event.entry.id);
    const open = speak?.state === 'pending' || speak?.state === 'playing';
    if (open && known < 0) {
      this.file.speaking.push({ id: event.entry.id, order: event.entry.order });
      while (this.file.speaking.length > KEEP_SPEAKING) {
        const oldest = this.file.speaking.shift()!;
        const entry = this.options.room.get(oldest.id);
        const stale = speakOf(entry?.data);
        if (entry && stale) this.setSpeak(entry, { ...stale, state: 'unspoken' });
      }
      if (speak?.state === 'pending') this.deliver();
    } else if (!open && known >= 0) this.file.speaking.splice(known, 1);
    else return;
    void this.save();
  }

  private async rebuildSpeaking(): Promise<void> {
    for (let before = Number.MAX_SAFE_INTEGER; ;) {
      const page = await this.options.room.page(before, 200).catch(() => undefined);
      if (!page?.entries.length) break;
      for (const entry of page.entries) this.follow({ type: 'entry', seq: 0, entry });
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
    for (const { entry, speak } of this.speakEntries()) if (speak.state === 'pending' && now - Date.parse(entry.at) > STALE_MS) this.setSpeak(entry, { ...speak, state: 'unspoken' });
  }

  private setSpeak(entry: MasterEntry, speak: MasterSpeak): void {
    const data = this.options.room.get(entry.id)?.data;
    if (data && (data.kind === 'master' || data.kind === 'error' || data.kind === 'event')) this.options.room.update(entry.id, { ...data, speak });
  }

  // ─── plumbing ────────────────────────────────────────────────────────────────────────────────────────────────

  private ready(): void {
    const settings = this.options.settings.current();
    if (!settings.enabled || !this.options.settings.keyFor(settings.model)) throw fail('마스터가 꺼져 있거나 설정한 모델의 API 키가 없습니다.', 409);
    if (!this.options.settings.voiceKey()) throw fail('ElevenLabs API 키가 없습니다. 마스터 설정에서 넣어 주세요.', 409);
  }

  private current(session: unknown): Session | undefined {
    return typeof session === 'string' && this.session?.id === session ? this.session : undefined;
  }

  private alive(session: Session): boolean { return session.panelOpen && Date.now() - session.seenAt < this.timing.presenceMs; }

  /** Ends a session at once: its notices and what it was playing stop, and it gets no more of anything. */
  private endSession(session: Session | undefined): void {
    if (!session || this.session !== session) return;
    this.session = undefined;
    for (const gate of session.gates) gate.controller.abort(new Error('음성이 꺼졌습니다.'));
    for (const done of [...this.results.values()]) done('stopped');
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
    for (const live of [...this.lives.values()]) if (now - live.createdAt > LIVE_MS) this.drop(live);
    const oldest = localDay(now - KEEP_DAYS * 86_400_000);
    for (const day of Object.keys(this.file.days)) if (day < oldest) delete this.file.days[day];
    const day = localDay(now);
    if (day !== this.shownDay) { this.shownDay = day; this.broadcast(); }
  }

  broadcast(): void { this.options.room.broadcast({ type: 'voice', seq: 0, voice: this.status() }); }

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
        if (/^\d{4}-\d{2}-\d{2}$/.test(day) && value && typeof value === 'object') file.days[day] = { sttSeconds: Number(value.sttSeconds) || 0, ttsChars: Number(value.ttsChars) || 0, dollars: Number(value.dollars) || 0 };
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
