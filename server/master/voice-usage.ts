import { randomUUID } from 'node:crypto';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { TowerError, type ErrorKind } from '../../shared/errors.js';

/** Estimated prices: ElevenLabs realtime speech-to-text per second, text-to-speech per character by model. */
const STT_DOLLARS_PER_SECOND = 0.39 / 3600;
export const ttsDollarsPerChar = (model: string) => (model === 'eleven_v3' ? 0.1 : 0.05) / 1000;
/** GPT-Live's price, for voice time kept from 1.52–1.55. */
const LIVE_DOLLARS_PER_SECOND = 0.05 / 60;
/**
 * A first reply's model call, as counted against the daily limit: paid by the Claude subscription, estimated at Haiku's
 * list price for about 1,000 tokens read and 40 written, rounded up.
 */
export const FIRST_REPLY_DOLLARS = 0.002;
/** One thing said is at most this long (the page stops sending there); each token reserves it until settled. */
const UTTERANCE_SECONDS = 180;
const TOKEN_LIFE_MS = 16 * 60_000;
const TOKENS_PER_SESSION = 2;
const TOKENS_PER_MINUTE = 20;
const KEEP_DAYS = 40;
const KEEP_SPEAKING = 500;

interface Day { sttSeconds: number; ttsChars: number; dollars: number; firstReplies?: number }
export interface VoiceFile {
  version: 6;
  days: Record<string, Day>;
  /** Tokens given to a page and not yet settled: each holds a whole utterance's cost. */
  tokens: Array<{ id: string; session: string; issuedAt: number }>;
  /** Conversation entries with news not yet read aloud or given up on. */
  speaking: Array<{ id: string; order: number }>;
}

/** One listing of news not yet read, as the facade sees it; `token` names this very listing (not an equal one). */
export interface SpeakingListing { readonly id: string; readonly order: number; readonly token: SpeakingToken }
declare const listing: unique symbol;
export type SpeakingToken = { readonly [listing]: true };

const fail = (message: string, kind: ErrorKind) => new TowerError(kind, message);
export const localDay = (time: number) => { const date = new Date(time); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };

/**
 * The voice's own records (voice.json): money spent by day, tokens a page holds, and the list of news not yet read.
 * The only writer of that file and of what is in it; others get copies and named changes, never the records
 * themselves. A save writes the records as they are when it runs, one after another.
 */
export class VoiceUsage {
  private file: VoiceFile = { version: 6, days: {}, tokens: [], speaking: [] };
  private recentTokens: number[] = [];
  private writes: Promise<void> = Promise.resolve();
  /** The listing each token was given for, so a token stays this very listing however the list changes. */
  private readonly listings = new WeakMap<SpeakingToken, VoiceFile['speaking'][number]>();

  /** `dailyDollars`: the owner's limit as it is set now (0: none). */
  constructor(private readonly path: string, private readonly dailyDollars: () => number) {}

  /** Reads the saved records; true when the list of news must be rebuilt from the room (kept without one). */
  async load(): Promise<boolean> {
    const saved = await readPrivateJson(this.path).catch(() => undefined) as Record<string, unknown> | undefined;
    this.file = migrate(saved, Date.now());
    return Boolean(saved) && !Array.isArray(saved!.speaking);
  }

  // ─── money ─────────────────────────────────────────────────────────────────────────────────────────────────

  add(at: number, used: { sttSeconds?: number; ttsChars?: number; model?: string; firstReply?: true }): void {
    const day = (this.file.days[localDay(at)] ??= { sttSeconds: 0, ttsChars: 0, dollars: 0 });
    if (used.firstReply) { day.firstReplies = (day.firstReplies ?? 0) + 1; day.dollars += FIRST_REPLY_DOLLARS; }
    if (used.sttSeconds) { day.sttSeconds += used.sttSeconds; day.dollars += used.sttSeconds * STT_DOLLARS_PER_SECOND; }
    if (used.ttsChars) { day.ttsChars += used.ttsChars; day.dollars += used.ttsChars * ttsDollarsPerChar(used.model ?? ''); }
  }

  /** What a day used, as a copy (nothing when nothing was used). */
  day(now: number): { sttSeconds: number; ttsChars: number } {
    const day = this.file.days[localDay(now)];
    return { sttSeconds: day?.sttSeconds ?? 0, ttsChars: day?.ttsChars ?? 0 };
  }

  /** Today's dollars, with every unsettled token (whenever it was given) held as a whole utterance. */
  spent(now: number): number {
    const reserved = this.file.tokens.length * UTTERANCE_SECONDS * STT_DOLLARS_PER_SECOND;
    return (this.file.days[localDay(now)]?.dollars ?? 0) + reserved;
  }

  /** Whether today's limit is already reached, so nothing more would be read aloud. */
  spentOut(): boolean {
    const limit = this.dailyDollars();
    return limit > 0 && this.spent(Date.now()) >= limit - 1e-9;
  }

  /** Whether spending `more` now would pass the daily limit (when there is one). */
  limited(now: number, more: number): boolean {
    const limit = this.dailyDollars();
    return limit > 0 && this.spent(now) + more > limit + 1e-9;
  }

  /** Days older than the records keep are forgotten (saved with the next change). */
  pruneDays(now: number): void {
    const oldest = localDay(now - KEEP_DAYS * 86_400_000);
    for (const day of Object.keys(this.file.days)) if (day < oldest) delete this.file.days[day];
  }

  // ─── tokens ────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Holds a token for a session before it is asked for, so two requests at once cannot both pass a check: at most two
   * a session, twenty a minute, and within the limit with every token held. Returns its id.
   */
  reserveToken(session: string, now: number): string {
    if (this.file.tokens.filter(token => token.session === session).length >= TOKENS_PER_SESSION) throw fail('받아쓰기 준비가 이미 되어 있습니다.', 'conflict');
    this.recentTokens = this.recentTokens.filter(at => now - at < 60_000);
    if (this.recentTokens.length >= TOKENS_PER_MINUTE) throw fail('받아쓰기 요청이 너무 많습니다.', 'rate-limited');
    if (this.limited(now, UTTERANCE_SECONDS * STT_DOLLARS_PER_SECOND)) throw fail('오늘 음성 한도에 닿았습니다.', 'conflict');
    const id = randomUUID();
    this.file.tokens.push({ id, session, issuedAt: now });
    this.recentTokens.push(now);
    return id;
  }

  /** A token that could not be given: no longer held (it still counts toward the minute). */
  releaseToken(id: string): void { this.file.tokens = this.file.tokens.filter(item => item.id !== id); }

  /** How long one utterance ran, once: counted today, 0–180 seconds (anything else a whole utterance). */
  settleToken(id: string, seconds: unknown): boolean {
    const index = this.file.tokens.findIndex(token => token.id === id);
    if (index < 0) return false;
    this.file.tokens.splice(index, 1);
    const used = typeof seconds === 'number' && Number.isFinite(seconds) ? Math.min(Math.max(seconds, 0), UTTERANCE_SECONDS) : UTTERANCE_SECONDS;
    this.add(Date.now(), { sttSeconds: used });
    return true;
  }

  /** Tokens never settled count as a whole utterance, on the day they run out. */
  settleExpired(now: number): void {
    const expired = this.file.tokens.filter(token => now - token.issuedAt > TOKEN_LIFE_MS);
    if (!expired.length) return;
    this.file.tokens = this.file.tokens.filter(token => now - token.issuedAt <= TOKEN_LIFE_MS);
    for (let index = 0; index < expired.length; index++) this.add(now, { sttSeconds: UTTERANCE_SECONDS });
    void this.save();
  }

  // ─── news not yet read ─────────────────────────────────────────────────────────────────────────────────────

  /** The listings, as they are read (the list itself, so a change while reading is seen as a loop over it would). */
  *speakingItems(): Generator<{ id: string; order: number }> {
    for (const item of this.file.speaking) yield { id: item.id, order: item.order };
  }

  /** The listings now, as copies, in list order. */
  speakingList(): Array<{ id: string; order: number }> { return this.file.speaking.map(item => ({ id: item.id, order: item.order })); }

  /** Keeps the listings whose entry `keep` says. */
  keepSpeaking(keep: (id: string) => boolean): void { this.file.speaking = this.file.speaking.filter(item => keep(item.id)); }

  isSpeaking(id: string): boolean { return this.file.speaking.some(item => item.id === id); }

  addSpeaking(id: string, order: number): void { this.file.speaking.push({ id, order }); }

  /** Removes the first listing of `id`. */
  removeSpeaking(id: string): void {
    const index = this.file.speaking.findIndex(item => item.id === id);
    if (index >= 0) this.file.speaking.splice(index, 1);
  }

  /** The oldest listing while the list is past its size, to be given up on; undefined when it is within it. */
  overflowing(): SpeakingListing | undefined {
    if (this.file.speaking.length <= KEEP_SPEAKING) return undefined;
    const item = this.file.speaking[0];
    const token = Object.freeze({}) as SpeakingToken;
    this.listings.set(token, item);
    return { id: item.id, order: item.order, token };
  }

  /** Removes the first listing when it is still that very listing (giving it up may already have removed it). */
  removeFirstIfSame(token: SpeakingToken): void {
    if (this.file.speaking[0] === this.listings.get(token)) this.file.speaking.shift();
  }

  // ─── saving ────────────────────────────────────────────────────────────────────────────────────────────────

  /** Writes the records as they are when the write runs, after any before it; a failure is logged and the next goes on. */
  save(): Promise<void> {
    const write = () => writePrivateJson(this.path, JSON.stringify(this.file));
    const next = this.writes.then(write, write);
    this.writes = next.catch(error => { console.error(`Master voice records were not saved: ${(error as NodeJS.ErrnoException)?.code ?? 'error'}`); });
    return next;
  }

  /** Waits for every save asked for so far (failed ones included). */
  flush(): Promise<void> { return this.writes; }
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
