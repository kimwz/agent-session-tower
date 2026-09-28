import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { MasterEntry, MasterEntryData, MasterSpeak, MasterStreamEvent, MasterVoicePhase, MasterVoiceStatus } from '../../shared/master.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import type { VoiceOrigin } from './journal.js';
import type { MasterRoom } from './room.js';
import type { MasterSettingsStore } from './settings.js';
import { VOICE_INSTRUCTIONS, VOICE_PHRASES } from './voice-text.js';

const MODEL = 'gpt-live-1';
const DOLLARS_PER_SECOND = 0.05 / 60;
/** A call is billed 15 seconds when it is made; they count toward its own time. */
const RESERVED_SECONDS = 15;
/** Sizes in bytes: never fewer bytes than tokens, so these stay under GPT-Live's limits (8,192 and 500 tokens). */
const SEED_BYTES = 8_000;
const SEED_ITEM_BYTES = 400;
const SEED_ITEMS = 20;
const APPEND_BYTES = 450;
/** A pause this long starts a new line of the transcript on screen. */
const LINE_GAP_MS = 1_200;
const RENDER_MS = 250;
/** Text before the part being shown that is hidden with it, so a card value (at most 4,096 characters) crossing into it is whole. */
const CONTEXT_CHARS = 4_096;
/** News older than this is not told any more: it is on the screen. */
const STALE_MS = 60 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE: ReadonlySet<MasterVoicePhase> = new Set(['reserved', 'creating', 'attached', 'ready', 'closing']);
const KEEP_ATTEMPTS = 100;
const KEEP_DAYS = 40;
const KEEP_SPEAKING = 500;
const KEEP_SEEN = 5_000;

export interface VoiceTiming {
  createMs: number; attachMs: number; readyMs: number; closeWaitMs: number; ackMs: number; deliveredMs: number;
  backstopMs: number; leaseMs: number; probeMs: number; quietMs: number; quietMaxMs: number;
  noticeMs: number; resyncMs: number; limitNoticeMs: number;
}
const TIMING: VoiceTiming = {
  createMs: 20_000, attachMs: 10_000, readyMs: 30_000, closeWaitMs: 12_000, ackMs: 10_000, deliveredMs: 5_000,
  backstopMs: 60_000, leaseMs: 5_000, probeMs: 5 * 60_000, quietMs: 600, quietMaxMs: 2_000,
  noticeMs: 15_000, resyncMs: 15_000, limitNoticeMs: 6_000,
};

/** What the voice needs from the master: its hiding, its inbox and its conversation. */
export interface VoiceHooks {
  hide(text: string): string;
  holdBack(): number;
  partialEnd(text: string): number;
  delegate(request: { key: string; text: string; local: boolean; tabId: string; origin: VoiceOrigin }): Promise<void>;
  /** A request of this call still waiting or being answered, which a delegation without new words joins. */
  openRequest(attempt: string): VoiceOrigin | undefined;
  join(key: string, delegationId: string): Promise<void>;
  /** The recent conversation, oldest first, to start a call with. */
  seed(): Array<{ role: 'user' | 'assistant'; text: string }>;
  /** When this host last got a new web; a page's report from before may have missed what happened in between. */
  connectedSince(): number;
}

export interface MasterVoiceOptions {
  dataDir: string;
  settings: MasterSettingsStore;
  room: MasterRoom;
  hooks: VoiceHooks;
  apiBase?: string;
  socketBase?: string;
  fetcher?: typeof fetch;
  timing?: Partial<VoiceTiming>;
}

/** A call as it is kept: browser ids only as digests. */
interface Attempt {
  attempt: string;
  tab: string;
  local: boolean;
  wake?: boolean;
  phase: MasterVoicePhase;
  appReason?: string;
  apiReason?: string;
  closedConfirmed?: boolean;
  /** GPT-Live refused to make it: nothing was billed. */
  unbilled?: boolean;
  /** Its time is in the daily totals, so it may be forgotten. */
  folded?: boolean;
  sessionId?: string;
  /** Its answer went to the page, which may have connected: until then the call cannot have started. */
  answered?: boolean;
  createdAt: number;
  readyAt?: number;
  expiresAt?: number;
  closedAt?: number;
  lastProbeAt?: number;
  usage: { seconds: number; observedAt?: number; final?: boolean; byDay: Record<string, number> };
}

interface VoiceFile {
  attempts: Attempt[];
  /** The last call ended on silence, in this tab, and nobody ended or started one by hand since: news may wake it. */
  silence: { tab: string; at: number } | null;
  /** Seconds of voice per local day of the calls that are over. */
  days: Record<string, number>;
  /** Conversation entries with news not yet told or given up on, wherever they are in the conversation. */
  speaking: Array<{ id: string; order: number }>;
}

/** One side of the call's transcript: everything said, and the lines on screen not yet final. */
interface Side {
  raw: string;
  lines: Array<{ start: number; entryId?: string; shown: string }>;
  lastAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

interface Live {
  attempt: Attempt;
  key: string;
  /** The page's own tab id, in memory only, so screen commands of its requests go there. */
  tabId: string;
  socket?: WebSocket;
  /** The call is ending: nothing more is sent on it, and no change waiting on it goes. */
  closing?: boolean;
  seen: Set<string>;
  input: Side;
  output: Side;
  /** The owner's words, as ranges of the input transcript, and how far requests took them. */
  words: Array<{ end: number; startMs: number }>;
  cursor: number;
  lastWordAt: number;
  delegations: Array<{ id: string; offsetMs: number }>;
  working: boolean;
  handled: Set<string>;
  acks: Map<string, (ok: boolean) => void>;
  activity?: { receivedAt: number; speaking: boolean; playing: boolean; lastSpeechAt: number; lastPlaybackAt: number };
  notices: Map<string, (result: string) => void>;
  gates: Set<{ since: number; controller: AbortController }>;
  readyTimer?: ReturnType<typeof setTimeout>;
  backstop?: ReturnType<typeof setInterval>;
  closed?: () => void;
  toldFirst?: boolean;
  delivering?: boolean;
  deliverAgain?: boolean;
  limitReached?: boolean;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const fail = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });
const localDay = (time: number) => { const date = new Date(time); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
const nextMidnight = (time: number) => { const date = new Date(time); date.setHours(24, 0, 0, 0); return date.getTime(); };
const emptySide = (): Side => ({ raw: '', lines: [], lastAt: 0 });
const speakOf = (data: MasterEntryData | undefined): MasterSpeak | undefined => data && (data.kind === 'master' || data.kind === 'error' || data.kind === 'event') ? data.speak : undefined;
/** At most `bytes` of UTF-8, cut on a character boundary. */
export function cutBytes(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  let result = '';
  let size = 0;
  for (const char of text) {
    const length = Buffer.byteLength(char);
    if (size + length > bytes - 3) break;
    result += char;
    size += length;
  }
  return `${result}…`;
}
/** The first paragraph of an answer, without markdown marks, as something to say. */
function spoken(text: string): string {
  const first = text.split(/\n\s*\n/).find(part => part.trim()) ?? text;
  return first.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_#>|]/g, '').replace(/\s+/g, ' ').trim();
}
/** Where raw position `at` falls in `whole` (the hidden text of `raw` from `from`): a value hidden across it goes after it. */
function boundary(raw: string, from: number, at: number, whole: string, hide: (text: string) => string): number {
  if (at <= from) return 0;
  if (at >= raw.length) return whole.length;
  const before = hide(raw.slice(from, at));
  let common = 0;
  while (common < before.length && common < whole.length && before.charCodeAt(common) === whole.charCodeAt(common)) common++;
  return outsideReference(whole, common);
}
/** `at`, or the start of a reference it would cut. */
function outsideReference(text: string, at: number): number {
  const open = text.lastIndexOf('{{secret:', at - 1);
  if (open < 0 || open >= at) return at;
  const close = text.indexOf('}}', open);
  return close < 0 || close + 2 > at ? open : at;
}
/** Adds `seconds` used from `from` to `to` to the days they fell on. */
export function spread(days: Record<string, number>, seconds: number, from: number, to: number): void {
  if (seconds <= 0) return;
  if (to <= from) { days[localDay(to)] = (days[localDay(to)] ?? 0) + seconds; return; }
  for (let at = from; at < to;) {
    const end = Math.min(to, nextMidnight(at));
    days[localDay(at)] = (days[localDay(at)] ?? 0) + seconds * (end - at) / (to - from);
    at = end;
  }
}

/**
 * The master's voice: a GPT-Live call made and followed by this host with the owner's key. The page holds the audio
 * and judges what it hears (speech, playback, silence); the host keeps requests, news to tell, cost and the call's
 * life. Ending a call never stops the master's work or anything it started.
 */
export class MasterVoice {
  private file: VoiceFile = { attempts: [], silence: null, days: {}, speaking: [] };
  private live?: Live;
  private serial: Promise<unknown> = Promise.resolve();
  private writes: Promise<void> = Promise.resolve();
  private leaseTimer?: ReturnType<typeof setInterval>;
  private probeTimer?: ReturnType<typeof setInterval>;
  private probing?: Promise<void>;
  /** Starts waiting their turn, which the page may call off before they make anything. */
  private readonly starting = new Map<string, { cancelled: boolean }>();
  private unsubscribe?: () => void;
  private shownDay = localDay(Date.now());
  private closedHost = false;
  private readonly timing: VoiceTiming;
  private readonly path: string;

  constructor(private readonly options: MasterVoiceOptions) {
    this.timing = { ...TIMING, ...options.timing };
    this.path = join(options.dataDir, 'voice.json');
  }

  async start(): Promise<void> {
    const saved = await readPrivateJson(this.path).catch(() => undefined) as Partial<VoiceFile> | undefined;
    if (saved && Array.isArray(saved.attempts)) {
      this.file = {
        attempts: saved.attempts.filter(item => item && typeof item === 'object' && item.usage),
        silence: saved.silence ?? null,
        days: saved.days && typeof saved.days === 'object' ? saved.days : {},
        speaking: Array.isArray(saved.speaking) ? saved.speaking.filter(item => typeof item?.id === 'string' && Number.isInteger(item.order)) : [],
      };
    }
    // A call this host was following when it stopped cannot be followed again: it is closed if it still runs.
    for (const attempt of this.file.attempts) if (ACTIVE.has(attempt.phase)) { attempt.phase = 'unconfirmed'; attempt.appReason ??= 'host'; attempt.closedAt ??= Date.now(); }
    for (const attempt of this.file.attempts) if (attempt.phase === 'unconfirmed' && !attempt.answered) this.closeAttempt(attempt);
    // News waiting to be told may sit in an older part of the conversation.
    for (const item of this.file.speaking) await this.options.room.load(item.order).catch(() => {});
    this.file.speaking = this.file.speaking.filter(item => speakOf(this.options.room.get(item.id)?.data));
    // Records kept without that list: it is rebuilt from the conversation, back as far as news is still told.
    if (saved && !Array.isArray(saved.speaking)) {
      for (let before = Number.MAX_SAFE_INTEGER; ;) {
        const page = await this.options.room.page(before, 200).catch(() => undefined);
        if (!page?.entries.length) break;
        for (const entry of page.entries) this.follow({ type: 'entry', seq: 0, entry });
        if (!page.hasMore || Date.now() - Date.parse(page.entries[0].at) > STALE_MS) break;
        before = page.entries[0].order;
      }
    }
    this.unsubscribe = this.options.room.subscribe(event => this.follow(event));
    // News sent just before the stop may not have been heard.
    for (const { entry, speak } of this.speakEntries()) if (speak.state === 'sent') this.retry(entry, speak);
    await this.save();
    this.leaseTimer = setInterval(() => this.tick(), this.timing.leaseMs);
    this.leaseTimer.unref();
    this.probeTimer = setInterval(() => { void this.probe(); }, this.timing.probeMs);
    this.probeTimer.unref();
    void this.probe();
  }

  async close(): Promise<void> {
    this.closedHost = true;
    this.unsubscribe?.();
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    if (this.probeTimer) clearInterval(this.probeTimer);
    if (this.live) this.release(this.live);
    await this.probing;
    await this.writes;
  }

  /** A call is being made, running or ending: the host stays. */
  busy(): boolean { return Boolean(this.live); }

  /** News should be marked to tell by voice: a call is on, or the last one ended on silence and may be woken. */
  wantsSpeech(): boolean { return Boolean(this.live) || Boolean(this.file.silence); }

  status(): MasterVoiceStatus {
    const last = this.live?.attempt ?? this.file.attempts.at(-1);
    const seconds = this.todaySeconds(Date.now());
    const settings = this.options.settings.current().voice;
    const { pending, wakeable } = this.speakCounts();
    const reason = last?.appReason ?? last?.apiReason;
    return {
      ...(last ? { attempt: last.attempt, tab: last.tab, phase: last.phase, ...(reason ? { reason } : {}) } : {}),
      today: { seconds: Math.round(seconds), dollars: Math.round(seconds * DOLLARS_PER_SECOND * 100) / 100 },
      limitMinutes: settings.dailyMinutes,
      pending,
      wakeable: this.file.silence && settings.autoWake ? wakeable : 0,
    };
  }

  // ─── starting and ending a call ──────────────────────────────────────────────────────────────────────────────

  async voiceStart(input: { attemptId: unknown; sdp: unknown; tabId: unknown; local: boolean; wake: unknown }): Promise<{ sdp: string; attempt: string }> {
    if (typeof input.attemptId !== 'string' || !UUID.test(input.attemptId) || typeof input.tabId !== 'string' || !UUID.test(input.tabId)) throw fail('음성 시작 요청이 올바르지 않습니다.', 400);
    if (typeof input.sdp !== 'string' || !input.sdp.startsWith('v=') || input.sdp.length > 100_000) throw fail('음성 연결 정보가 올바르지 않습니다.', 400);
    const attempt = hash(input.attemptId);
    const tab = hash(input.tabId);
    const tabId = input.tabId;
    const wake = input.wake === true;
    const sdp = input.sdp;
    if (this.starting.has(attempt)) throw fail('이미 시작 중인 음성 시도입니다.', 409);
    const pending = { cancelled: false };
    this.starting.set(attempt, pending);
    return this.inTurn(async () => {
      if (pending.cancelled) throw fail('음성 시작을 취소했습니다.', 409);
      const settings = this.options.settings.current();
      const key = this.options.settings.key();
      if (!settings.enabled || !key) throw fail('마스터가 꺼져 있거나 OpenAI 키가 없습니다.', 409);
      const limit = settings.voice.dailyMinutes;
      if (limit > 0 && this.todaySeconds(Date.now()) + RESERVED_SECONDS > limit * 60) throw fail('오늘 음성 한도에 닿았습니다. 설정에서 한도를 바꿀 수 있습니다.', 409);
      if (this.file.attempts.some(item => item.attempt === attempt)) throw fail('이미 쓴 음성 시도입니다.', 409);
      if (wake) {
        // Waking never takes a call over, and only follows a call that ended on silence in this tab.
        if (this.live || !settings.voice.autoWake || this.file.silence?.tab !== tab || !this.speakCounts().wakeable) throw fail('지금은 음성을 스스로 다시 켤 수 없습니다.', 409);
        for (const { entry, speak } of this.speakEntries()) if (speak.state === 'pending' && !speak.woke) this.setSpeak(entry, { ...speak, woke: true });
      }
      // Starting by hand while a call runs takes it over: the old one ends first, so two are never paid for at once.
      if (this.live) await this.finish(this.live, 'taken-over');
      // A wake that fails does not wake again: the silence it followed is spent.
      this.file.silence = null;
      const record: Attempt = { attempt, tab, local: input.local, ...(wake ? { wake } : {}), phase: 'reserved', createdAt: Date.now(), usage: { seconds: 0, byDay: {} } };
      this.file.attempts.push(record);
      this.prune();
      await this.save();
      const live: Live = { attempt: record, key, tabId, seen: new Set(), input: emptySide(), output: emptySide(), words: [], cursor: 0, lastWordAt: 0, delegations: [], working: false, handled: new Set(), acks: new Map(), notices: new Map(), gates: new Set() };
      this.live = live;
      this.broadcast();
      if (pending.cancelled) { record.appReason = 'owner'; record.unbilled = true; record.usage.final = true; this.closeAttempt(record); this.live = undefined; await this.save(); this.broadcast(); throw fail('음성 시작을 취소했습니다.', 409); }
      let created: { id: string; answer: string };
      try { created = await this.create(key, sdp, settings.voice.voice); }
      catch (error) {
        // Refused outright, nothing was made. Any other failure may have made a call this host cannot find, but its
        // answer never reached the page, so it never started: it costs the fifteen seconds of making it.
        const refused = (error as { refused?: boolean }).refused === true;
        record.appReason = 'failed';
        record.closedAt = Date.now();
        if (refused) { record.closedConfirmed = true; record.unbilled = true; record.usage.final = true; }
        this.closeAttempt(record);
        this.live = undefined;
        await this.save();
        this.broadcast();
        throw fail(this.options.hooks.hide(error instanceof Error ? error.message : String(error)), (error as { statusCode?: number }).statusCode ?? 502);
      }
      record.sessionId = created.id;
      record.phase = 'creating';
      await this.save();
      try { await this.attach(live); }
      catch (error) {
        // Not followed, the call is not handed to the page; it will not start.
        record.appReason = 'failed';
        record.closedAt = Date.now();
        this.closeAttempt(record);
        this.release(live);
        await this.save();
        this.broadcast();
        throw fail(`음성 세션을 따라가지 못했습니다: ${this.options.hooks.hide(error instanceof Error ? error.message : String(error))}`, 502);
      }
      // Called off while it was being made: it is closed, and its answer never goes to the page.
      if (live.closing || pending.cancelled) {
        await this.finish(live, 'owner');
        throw fail('음성 시작을 취소했습니다.', 409);
      }
      record.phase = 'attached';
      record.answered = true;
      await this.save();
      if (live.closing || pending.cancelled) {
        await this.finish(live, 'owner');
        throw fail('음성 시작을 취소했습니다.', 409);
      }
      this.broadcast();
      // The page must say it is ready (started and playing) in time, or the call is ended.
      live.readyTimer = setTimeout(() => { void this.inTurn(() => this.live === live && record.phase === 'attached' ? this.finish(live, 'failed') : Promise.resolve()); }, this.timing.readyMs);
      live.readyTimer.unref();
      return { sdp: created.answer, attempt };
    }).finally(() => { this.starting.delete(attempt); });
  }

  /** The page heard the call start and plays it. */
  async voiceReady(input: { attemptId: unknown }): Promise<boolean> {
    const live = this.mine(input.attemptId);
    if (!live || live.closing || live.attempt.phase !== 'attached') return false;
    live.attempt.phase = 'ready';
    live.attempt.readyAt = Date.now();
    if (live.readyTimer) clearTimeout(live.readyTimer);
    // The page reports every two seconds while the call is on; a page silent this long is gone.
    live.backstop = setInterval(() => {
      const last = live.activity?.receivedAt ?? live.attempt.readyAt ?? Date.now();
      if (Date.now() - last > this.timing.backstopMs) this.end(live, 'connection');
    }, 1_000);
    live.backstop.unref();
    await this.save();
    this.broadcast();
    void this.deliver();
    return true;
  }

  /**
   * The page ends its call: by hand, on silence, or because it could not start it. From the moment it asks, nothing
   * more goes out on the call's behalf, even while the host is still busy closing another. Another call's stop is ignored.
   */
  async voiceStop(input: { attemptId: unknown; reason: unknown }): Promise<boolean> {
    const reason = input.reason === 'silence' || input.reason === 'failed' ? input.reason : 'owner';
    const waiting = typeof input.attemptId === 'string' && UUID.test(input.attemptId) ? this.starting.get(hash(input.attemptId)) : undefined;
    if (waiting) waiting.cancelled = true;
    const live = this.mine(input.attemptId);
    if (!live) return Boolean(waiting);
    await this.end(live, reason);
    return true;
  }

  /** What the page hears: whether the owner speaks and the call plays, and how long ago each last happened. */
  voiceActivity(input: { attemptId: unknown; speaking: unknown; playing: unknown; sinceSpeechMs?: unknown; sincePlaybackMs?: unknown }): boolean {
    const live = this.mine(input.attemptId);
    if (!live || live.closing) return false;
    const now = Date.now();
    // Durations, not the page's clock: its clock may differ from this computer's.
    const ago = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? now - Math.min(value, 86_400_000) : 0;
    const speaking = input.speaking === true, playing = input.playing === true;
    live.activity = { receivedAt: now, speaking, playing, lastSpeechAt: speaking ? now : ago(input.sinceSpeechMs), lastPlaybackAt: playing ? now : ago(input.sincePlaybackMs) };
    for (const gate of live.gates) if (live.activity.lastSpeechAt >= gate.since) gate.controller.abort(new Error('소유자가 말했습니다.'));
    return true;
  }

  /** The page said (or could not say) a notice before an irreversible change. */
  voiceNotice(input: { noticeId: unknown; result: unknown }): boolean {
    const live = this.live;
    if (!live || typeof input.noticeId !== 'string') return false;
    const done = live.notices.get(input.noticeId);
    if (!done) return false;
    done(input.result === 'played' ? 'played' : input.result === 'interrupted' ? 'interrupted' : 'failed');
    return true;
  }

  // ─── what the master's turns ask of the call ─────────────────────────────────────────────────────────────────

  /** Quiet context for the model while a request is worked on. */
  progress(origin: VoiceOrigin, text: string): void {
    const live = this.ready(origin);
    const id = origin.delegationIds.at(-1);
    if (live && id) void this.append(live, 'session.thinking.append', id, this.options.hooks.hide(text));
  }

  /** A request takes long: the model says so, once. */
  stillWorking(origin: VoiceOrigin): void {
    const live = this.ready(origin);
    const id = origin.delegationIds.at(-1);
    if (live && id) void this.append(live, 'session.commentary.append', id, VOICE_PHRASES.stillWorking);
  }

  /**
   * Before an irreversible change of a spoken request: the page says the notice itself. The change may go only if it
   * was played to the end, and the owner said nothing from its start until the moment it is sent. `signal` ends when
   * the owner speaks or the call ends; `check` is asked right before sending; `done` lets go.
   */
  async announce(text: string, signal: AbortSignal): Promise<{ ok: true; signal: AbortSignal; check: () => Promise<boolean>; done: () => void } | { ok: false; reason: string }> {
    const live = this.live;
    if (!live || live.closing || live.attempt.phase !== 'ready') return { ok: false, reason: '음성으로 먼저 알릴 수 없어 되돌릴 수 없는 작업을 보내지 않았습니다.' };
    const id = randomUUID();
    const since = Date.now();
    const gate = { since, controller: new AbortController() };
    live.gates.add(gate);
    const done = () => { live.gates.delete(gate); };
    const result = await new Promise<string>(resolve => {
      const finish = (value: string) => { clearTimeout(timer); live.notices.delete(id); signal.removeEventListener('abort', stopped); resolve(value); };
      const stopped = () => finish('stopped');
      const timer = setTimeout(() => finish('timeout'), this.timing.noticeMs);
      live.notices.set(id, finish);
      signal.addEventListener('abort', stopped, { once: true });
      if (signal.aborted) { finish('stopped'); return; }
      this.options.room.broadcast({ type: 'notice', seq: 0, notice: { id, attempt: live.attempt.attempt, text: cutBytes(this.options.hooks.hide(text), 600) } });
    });
    if (result !== 'played' || gate.controller.signal.aborted || live.closing) {
      done();
      const reason = result === 'interrupted' || (result === 'played' && gate.controller.signal.aborted && !live.closing) ? '안내하는 동안 소유자가 말해서 보내지 않았습니다. 무엇을 원하는지 다시 들어 주세요.'
        : result === 'stopped' || live.closing ? '중지되어 보내지 않았습니다.' : '안내를 들려 드리지 못해 보내지 않았습니다.';
      return { ok: false, reason };
    }
    const check = async () => {
      // A web restart may have kept the page's word from arriving: only a report made after it counts.
      const deadline = Date.now() + this.timing.resyncMs;
      const heard = () => (live.activity?.receivedAt ?? 0) > this.options.hooks.connectedSince();
      while (!live.closing && !heard() && !gate.controller.signal.aborted && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      return this.live === live && !live.closing && live.attempt.phase === 'ready' && heard() && !gate.controller.signal.aborted && (live.activity?.lastSpeechAt ?? 0) < since;
    };
    return { ok: true, signal: gate.controller.signal, check, done };
  }

  /** Tells what is waiting to be told, in order, while a call is ready. */
  async deliver(): Promise<void> {
    const live = this.live;
    if (!live || live.closing || live.attempt.phase !== 'ready') return;
    if (live.delivering) { live.deliverAgain = true; return; }
    live.delivering = true;
    try {
      do {
        live.deliverAgain = false;
        this.sweep();
        for (const { entry, speak } of this.speakEntries()) {
          if (speak.state !== 'pending') continue;
          if (this.live !== live || live.closing) return;
          // A request of this call is answered under its latest delegation, the earlier ones it joined quietly;
          // other news is told without a delegation.
          const own = speak.attempt === live.attempt.attempt ? speak.delegationIds ?? [] : [];
          const ok = await this.append(live, 'session.commentary.append', own.at(-1) ?? null, this.content(entry.data));
          const current = speakOf(this.options.room.get(entry.id)?.data) ?? speak;
          // Taken in just as the call began to end: perhaps never heard.
          if (!ok || live.closing) { this.retry(entry, current); if (live.closing) return; continue; }
          this.setSpeak(entry, { ...current, state: 'sent' });
          for (const earlier of own.slice(0, -1)) void this.append(live, 'session.thinking.append', earlier, VOICE_PHRASES.answeredTogether);
          const timer = setTimeout(() => {
            const later = speakOf(this.options.room.get(entry.id)?.data);
            // Told, unless the call has ended or begun to end since.
            if (this.live === live && !live.closing && later?.state === 'sent') this.setSpeak(entry, { ...later, state: 'delivered' });
          }, this.timing.deliveredMs);
          timer.unref();
          if (live.attempt.wake && !live.toldFirst) {
            live.toldFirst = true;
            void this.append(live, 'session.instructions.append', null, VOICE_PHRASES.tellFirst);
          }
        }
      } while (live.deliverAgain && this.live === live && !live.closing);
    } finally { live.delivering = false; this.broadcast(); }
  }

  /** What is said of an entry: its first paragraph, hidden whole, shortened to the append's size, and hidden again. */
  private content(data: MasterEntryData): string {
    const hide = this.options.hooks.hide;
    const text = data.kind === 'master' ? data.text : data.kind === 'error' ? `요청을 처리하지 못했습니다: ${data.text}` : data.kind === 'event' ? data.text : '';
    return cutBytes(hide(cutBytes(hide(spoken(text)), APPEND_BYTES)), APPEND_BYTES);
  }

  // ─── the call with GPT-Live ──────────────────────────────────────────────────────────────────────────────────

  private async create(key: string, sdp: string, voice: string): Promise<{ id: string; answer: string }> {
    const fetcher = this.options.fetcher ?? fetch;
    const body = {
      session: {
        model: MODEL,
        instructions: VOICE_INSTRUCTIONS,
        audio: { output: { voice } },
        input: this.seed(),
        delegation: { type: 'client' },
        // The page sends nothing on its data channel and hears only that the call started, ended or failed.
        client: { data_channel: { allowed_client_events: [], allowed_server_events: [{ type: 'session.started' }, { type: 'session.closed' }, { type: 'error' }] } },
        store: false,
      },
      transport: { type: 'webrtc', sdp },
    };
    let response: Response;
    try {
      response = await fetcher(`${this.options.apiBase ?? 'https://api.openai.com'}/v1/live/sessions`, {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timing.createMs),
      });
    } catch (error) { throw Object.assign(new Error(`음성 세션을 만들지 못했습니다: ${error instanceof Error ? error.message : String(error)}`), { statusCode: 502 }); }
    const json = await response.json().catch(() => undefined) as { session?: { id?: unknown }; transport?: { sdp?: unknown }; error?: { message?: unknown } } | undefined;
    if (!response.ok) {
      const refused = response.status >= 400 && response.status < 500 && response.status !== 408;
      throw Object.assign(new Error(`음성 세션을 만들지 못했습니다: ${typeof json?.error?.message === 'string' ? json.error.message : `HTTP ${response.status}`}`), { statusCode: refused ? 409 : 502, refused });
    }
    if (typeof json?.session?.id !== 'string' || typeof json.transport?.sdp !== 'string') throw Object.assign(new Error('음성 세션 응답을 읽지 못했습니다.'), { statusCode: 502 });
    return { id: json.session.id, answer: json.transport.sdp };
  }

  /** The recent conversation in its own roles: each hidden whole, shortened, and hidden again; within the seed's size. */
  private seed(): Array<Record<string, unknown>> {
    const hide = this.options.hooks.hide;
    const items = this.options.hooks.seed().map(item => ({ role: item.role, text: cutBytes(hide(cutBytes(hide(item.text), SEED_ITEM_BYTES)), SEED_ITEM_BYTES) })).filter(item => item.text.trim());
    const kept: typeof items = [];
    let bytes = 0;
    for (const item of [...items].reverse()) {
      bytes += Buffer.byteLength(item.text);
      if (bytes > SEED_BYTES || kept.length >= SEED_ITEMS) break;
      kept.unshift(item);
    }
    return kept.map(item => ({ type: 'message', role: item.role, content: [{ type: item.role === 'user' ? 'input_text' : 'output_text', text: item.text }] }));
  }

  private attach(live: Live): Promise<void> {
    const id = live.attempt.sessionId!;
    const url = `${this.options.socketBase ?? 'wss://api.openai.com'}/v1/live/sessions/${encodeURIComponent(id)}/attach`;
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${live.key}` } });
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('시간 초과')); }, this.timing.attachMs);
      socket.once('open', () => { clearTimeout(timer); live.socket = socket; resolve(); });
      socket.once('unexpected-response', (_request, response) => { clearTimeout(timer); response.resume(); socket.terminate(); reject(Object.assign(new Error(`HTTP ${response.statusCode}`), { status: response.statusCode })); });
      socket.on('error', error => { clearTimeout(timer); reject(error); });
      socket.on('message', data => {
        let event: Record<string, unknown>;
        try { event = JSON.parse(String(data)) as Record<string, unknown>; } catch { return; }
        this.event(live, event);
      });
      socket.on('close', () => { if (live.socket === socket) { live.socket = undefined; this.lost(live); } });
    });
  }

  /** The follow-up connection went away: what it missed does not come back, so the call is closed rather than trusted. */
  private lost(live: Live): void {
    if (live.closing || this.live !== live || this.closedHost) return;
    this.halt(live);
    void this.inTurn(async () => {
      if (this.live !== live) return;
      if (!live.attempt.closedConfirmed) await this.attach(live).catch(() => undefined);
      await this.finish(live, 'connection');
    });
  }

  private event(live: Live, event: Record<string, unknown>): void {
    const id = typeof event.event_id === 'string' ? event.event_id : undefined;
    if (id) {
      if (live.seen.has(id)) return;
      live.seen.add(id);
      if (live.seen.size > KEEP_SEEN) live.seen.delete(live.seen.values().next().value!);
    }
    switch (event.type) {
      case 'session.started': {
        const expires = Number((event.session as { expires_at?: unknown } | undefined)?.expires_at);
        if (Number.isFinite(expires) && expires > 1e9 && expires < 1e11) { live.attempt.expiresAt = expires * 1000; void this.save(); }
        return;
      }
      case 'session.input_transcript.delta': {
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (!delta) return;
        this.said(live, live.input, delta, 'input');
        live.words.push({ end: live.input.raw.length, startMs: Number(event.start_ms) || 0 });
        live.lastWordAt = Date.now();
        return;
      }
      case 'session.output_transcript.delta': {
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (delta) this.said(live, live.output, delta, 'output');
        return;
      }
      case 'session.delegation.created': {
        const delegation = event.delegation as { id?: unknown } | undefined;
        if (typeof delegation?.id !== 'string' || live.closing) return;
        live.delegations.push({ id: delegation.id, offsetMs: Number(event.offset_ms) || 0 });
        if (!live.working) void this.requests(live);
        return;
      }
      case 'session.commentary.appended': case 'session.thinking.appended': case 'session.instructions.appended': {
        const done = typeof event.client_event_id === 'string' ? live.acks.get(event.client_event_id) : undefined;
        done?.(true);
        return;
      }
      case 'error': {
        const error = event.error as { client_event_id?: unknown } | undefined;
        const client = typeof error?.client_event_id === 'string' ? error.client_event_id : typeof event.client_event_id === 'string' ? event.client_event_id : undefined;
        if (client) live.acks.get(client)?.(false);
        return;
      }
      case 'session.usage.updated': {
        const seconds = Number((event.usage as { seconds?: unknown } | undefined)?.seconds);
        if (Number.isFinite(seconds) && seconds >= 0) this.used(live.attempt, seconds, Date.now(), false);
        this.checkLimit(live);
        return;
      }
      case 'session.closed': {
        const seconds = Number((event.usage as { seconds?: unknown } | undefined)?.seconds);
        if (Number.isFinite(seconds) && seconds >= 0) this.used(live.attempt, seconds, Date.now(), true);
        else live.attempt.usage.final = true;
        live.attempt.apiReason = typeof event.reason === 'string' ? event.reason.slice(0, 40) : 'closed';
        live.attempt.closedConfirmed = true;
        if (live.closed) live.closed();
        else if (this.live === live) void this.end(live, live.attempt.apiReason === 'expired' ? 'expired' : 'closed');
        return;
      }
    }
  }

  /** A transcript piece: a pause starts a new line on screen; what is shown is drawn a little later, all at once. */
  private said(live: Live, side: Side, delta: string, kind: 'input' | 'output'): void {
    const now = Date.now();
    const last = side.lines.at(-1);
    if (!last || (now - side.lastAt > LINE_GAP_MS && side.raw.length > last.start)) side.lines.push({ start: side.raw.length, shown: '' });
    side.raw += delta;
    side.lastAt = now;
    side.timer ??= setTimeout(() => { side.timer = undefined; if (this.live === live) this.render(side, kind, false); }, RENDER_MS);
  }

  /**
   * Draws a side's open lines from the hidden text of all of it, so a value said across a pause is still found whole.
   * The end, where a card's value may not be whole yet, waits for more (or for the call to end), and a reference is
   * never shown in part.
   */
  private render(side: Side, kind: 'input' | 'output', final: boolean): void {
    if (side.timer) { clearTimeout(side.timer); side.timer = undefined; }
    if (!side.lines.length) return;
    const hide = this.options.hooks.hide;
    const from = Math.max(0, side.lines[0].start - CONTEXT_CHARS);
    const whole = hide(side.raw.slice(from));
    const limit = outsideReference(whole, final ? whole.length : Math.max(0, whole.length - this.options.hooks.holdBack()));
    const starts = side.lines.map(line => boundary(side.raw, from, line.start, whole, hide));
    side.lines.forEach((line, index) => {
      const start = starts[index];
      const end = Math.min(index + 1 < starts.length ? starts[index + 1] : whole.length, limit);
      const text = whole.slice(start, Math.max(start, end)).trim();
      if (!text || text === line.shown) return;
      line.shown = text;
      const data: MasterEntryData = kind === 'input' ? { kind: 'owner', text, voice: true } : { kind: 'voice', text };
      if (!line.entryId) line.entryId = this.options.room.add(data).id;
      else this.options.room.update(line.entryId, data);
    });
    // Lines shown to their end are final; the last line stays open for more.
    while (side.lines.length > 1 && starts[1] <= limit) { side.lines.shift(); starts.shift(); }
    if (final) side.lines = [];
  }

  /**
   * Delegations, one at a time: each takes the owner's words since the last one, up to where it was made. Without new
   * words it joins the request still being answered, or the owner is asked again; a model's own idea never runs.
   */
  private async requests(live: Live): Promise<void> {
    live.working = true;
    try {
      while (live.delegations.length && this.live === live && !live.closing) {
        const delegation = live.delegations.shift()!;
        if (live.handled.has(delegation.id)) continue;
        live.handled.add(delegation.id);
        // Words still arriving belong to this request: wait until they pause.
        const until = Date.now() + this.timing.quietMaxMs;
        while (Date.now() < until && Date.now() - live.lastWordAt < this.timing.quietMs) await new Promise(resolve => setTimeout(resolve, 50));
        let next = live.cursor;
        while (next < live.words.length && live.words[next].startMs <= delegation.offsetMs + 1_000) next++;
        const from = live.cursor ? live.words[live.cursor - 1].end : 0;
        const to = next ? live.words[next - 1].end : 0;
        live.cursor = next;
        const text = this.requestText(live.input.raw, from, to);
        const key = hash(`${live.attempt.attempt}:${delegation.id}`);
        if (text) {
          await this.options.hooks.delegate({ key, text, local: live.attempt.local, tabId: live.tabId, origin: { attempt: live.attempt.attempt, key, delegationIds: [delegation.id] } }).catch(error => {
            console.error(`Master could not take a spoken request: ${(error as NodeJS.ErrnoException)?.code ?? 'error'}`);
          });
          continue;
        }
        const open = this.options.hooks.openRequest(live.attempt.attempt);
        if (open) { await this.options.hooks.join(open.key, delegation.id).catch(() => {}); continue; }
        void this.append(live, 'session.commentary.append', delegation.id, VOICE_PHRASES.askAgain);
      }
    } finally { live.working = false; }
  }

  /** The owner's words from `from` to `to`, hidden with what surrounds them, without the start of a card's value at the end. */
  private requestText(raw: string, from: number, to: number): string {
    if (to <= from) return '';
    const hide = this.options.hooks.hide;
    const context = Math.max(0, from - CONTEXT_CHARS);
    const whole = hide(raw.slice(context));
    const start = boundary(raw, context, from, whole, hide);
    const end = Math.min(boundary(raw, context, to, whole, hide), whole.length - this.options.hooks.partialEnd(whole));
    return whole.slice(start, Math.max(start, end)).trim();
  }

  /** Sends an append and waits for GPT-Live to take it in (not to say it): false on an error, no word, or no connection. */
  private append(live: Live, type: string, delegationId: string | null, content: string): Promise<boolean> {
    const socket = live.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || live.closing) return Promise.resolve(false);
    const id = `tower_${randomUUID()}`;
    return new Promise(resolve => {
      const finish = (ok: boolean) => { clearTimeout(timer); live.acks.delete(id); resolve(ok); };
      const timer = setTimeout(() => finish(false), this.timing.ackMs);
      live.acks.set(id, finish);
      socket.send(JSON.stringify({ type, event_id: id, delegation_id: delegationId, content: cutBytes(content, APPEND_BYTES) }), error => { if (error) finish(false); });
    });
  }

  /** The daily limit, when set, is reached during a call: the model says so, and the call ends. */
  private checkLimit(live: Live): void {
    const limit = this.options.settings.current().voice.dailyMinutes;
    if (live.limitReached || live.closing || limit <= 0 || live.attempt.phase !== 'ready' || this.todaySeconds(Date.now()) < limit * 60) return;
    live.limitReached = true;
    void this.append(live, 'session.instructions.append', null, VOICE_PHRASES.dailyLimit);
    const timer = setTimeout(() => { if (this.live === live) void this.end(live, 'daily-limit'); }, this.timing.limitNoticeMs);
    timer.unref();
  }

  /** Stops a call at once for everything waiting on it, then closes it in turn with the other calls' work. */
  private end(live: Live, reason: string): Promise<void> {
    live.attempt.appReason ??= reason;
    this.halt(live);
    return this.inTurn(() => this.live === live ? this.finish(live, reason) : Promise.resolve());
  }

  /**
   * From here on the call does nothing more: no change waiting on it goes, no news is sent, and news sent just now
   * is told again next time (it may not have been heard).
   */
  private halt(live: Live): void {
    if (live.closing) return;
    live.closing = true;
    for (const gate of live.gates) gate.controller.abort(new Error('음성이 끝났습니다.'));
    for (const done of [...live.notices.values()]) done('stopped');
    for (const { entry, speak } of this.speakEntries()) if (speak.state === 'sent') this.retry(entry, speak);
    if (live.attempt.phase !== 'closed' && live.attempt.phase !== 'unconfirmed') live.attempt.phase = 'closing';
    this.broadcast();
  }

  /**
   * Ends a call: asks GPT-Live to close it and waits a while for its word and final use; without it the end stays
   * unconfirmed and is checked later.
   */
  private async finish(live: Live, reason: string): Promise<void> {
    const attempt = live.attempt;
    attempt.appReason ??= reason;
    this.halt(live);
    const socket = live.socket;
    if (socket && socket.readyState === WebSocket.OPEN && !attempt.closedConfirmed) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, this.timing.closeWaitMs);
        live.closed = () => { clearTimeout(timer); resolve(); };
        socket.send(JSON.stringify({ type: 'session.close', event_id: `tower_${randomUUID()}` }), error => { if (error) { clearTimeout(timer); resolve(); } });
      });
    }
    attempt.closedAt = Date.now();
    if (attempt.closedConfirmed) this.closeAttempt(attempt);
    else attempt.phase = 'unconfirmed';
    if (reason === 'silence') this.file.silence = { tab: attempt.tab, at: attempt.closedAt };
    else if (reason === 'owner') this.file.silence = null;
    this.release(live);
    await this.save();
    this.broadcast();
  }

  /** Lets go of a call's connection and timers, showing what it said to the end; its work and records stay. */
  private release(live: Live): void {
    live.closing = true;
    if (live.readyTimer) clearTimeout(live.readyTimer);
    if (live.backstop) clearInterval(live.backstop);
    for (const done of [...live.acks.values()]) done(false);
    for (const done of [...live.notices.values()]) done('stopped');
    for (const gate of live.gates) gate.controller.abort(new Error('음성이 끝났습니다.'));
    this.render(live.input, 'input', true);
    this.render(live.output, 'output', true);
    const socket = live.socket;
    live.socket = undefined;
    socket?.close();
    if (this.live === live) this.live = undefined;
  }

  /**
   * Calls whose end was never confirmed: attach and close them every few minutes. One GPT-Live no longer knows has
   * ended; one that cannot be checked stays counted, up to the end GPT-Live gave it when it said.
   */
  probe(): Promise<void> {
    if (!this.probing && !this.closedHost) this.probing = this.probeAll().finally(() => { this.probing = undefined; });
    return this.probing ?? Promise.resolve();
  }

  private async probeAll(): Promise<void> {
    const key = this.options.settings.key();
    for (const attempt of this.file.attempts.filter(item => item.phase === 'unconfirmed')) {
      if (this.closedHost) return;
      const now = Date.now();
      // Past the end GPT-Live gave it, it cannot be running; a call that never got to the page never started.
      if (attempt.expiresAt !== undefined && now >= attempt.expiresAt) { attempt.closedAt = attempt.expiresAt; this.closeAttempt(attempt); continue; }
      if (!attempt.answered) { this.closeAttempt(attempt); continue; }
      if (!attempt.sessionId || !key) continue;
      attempt.lastProbeAt = now;
      const live: Live = { attempt, key, tabId: '', seen: new Set(), input: emptySide(), output: emptySide(), words: [], cursor: 0, lastWordAt: 0, delegations: [], working: false, handled: new Set(), acks: new Map(), notices: new Map(), gates: new Set(), closing: true };
      try {
        await this.attach(live);
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, this.timing.closeWaitMs);
          live.closed = () => { clearTimeout(timer); resolve(); };
          live.socket?.send(JSON.stringify({ type: 'session.close', event_id: `tower_${randomUUID()}` }));
        });
        if (attempt.closedConfirmed) { attempt.closedAt = Date.now(); this.closeAttempt(attempt); }
      } catch (error) {
        // GPT-Live no longer knows the call: it ended. Its use stays as estimated until now.
        const status = (error as { status?: number }).status;
        if (status === 404 || status === 410) { attempt.closedConfirmed = true; attempt.closedAt = now; this.closeAttempt(attempt); }
      } finally { const socket = live.socket; live.socket = undefined; socket?.close(); }
    }
    if (this.closedHost) return;
    await this.save();
    this.broadcast();
  }

  /** When a call can be running no longer: when GPT-Live said it expires; unknown otherwise. */
  private limitOf(attempt: Attempt): number { return attempt.expiresAt ?? Number.MAX_SAFE_INTEGER; }

  // ─── cost ────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Records GPT-Live's running total for a call, spreading what was added over the days since the last report. */
  private used(attempt: Attempt, total: number, now: number, final: boolean): void {
    const from = attempt.usage.observedAt ?? attempt.readyAt ?? attempt.createdAt;
    const added = total - attempt.usage.seconds;
    if (added > 0) {
      spread(attempt.usage.byDay, added, Math.min(from, now), now);
      attempt.usage.seconds = total;
    }
    attempt.usage.observedAt = now;
    if (final) attempt.usage.final = true;
    void this.save();
  }

  /**
   * A call's seconds per day: what GPT-Live reported, plus, until it reports a final total, all the time since its
   * last report (up to when the call ends or could no longer run); at least the 15 seconds every call is billed.
   */
  private attemptDays(attempt: Attempt, now: number): Record<string, number> {
    if (attempt.unbilled) return {};
    const days = { ...attempt.usage.byDay };
    let total = attempt.usage.seconds;
    // A call whose answer never reached the page never ran: only the seconds of making it.
    if (!attempt.usage.final && attempt.answered) {
      const from = attempt.usage.observedAt ?? attempt.readyAt ?? attempt.createdAt;
      const open = ACTIVE.has(attempt.phase) || attempt.phase === 'unconfirmed';
      const to = Math.min(open ? now : attempt.closedAt ?? now, this.limitOf(attempt));
      if (to > from) { spread(days, (to - from) / 1000, from, to); total += (to - from) / 1000; }
    }
    if (total < RESERVED_SECONDS) spread(days, RESERVED_SECONDS - total, attempt.createdAt, attempt.createdAt);
    return days;
  }

  /** A call that is over: its time goes into the daily totals for good, so the call itself may be forgotten. */
  private closeAttempt(attempt: Attempt): void {
    attempt.phase = 'closed';
    attempt.closedAt ??= Date.now();
    if (attempt.folded) return;
    for (const [day, seconds] of Object.entries(this.attemptDays(attempt, attempt.closedAt))) this.file.days[day] = (this.file.days[day] ?? 0) + seconds;
    attempt.folded = true;
  }

  /** Old calls go once they are counted; old days go after a while. */
  private prune(): void {
    while (this.file.attempts.length > KEEP_ATTEMPTS) {
      const index = this.file.attempts.findIndex(item => item.folded);
      if (index < 0) break;
      this.file.attempts.splice(index, 1);
    }
    const oldest = localDay(Date.now() - KEEP_DAYS * 86_400_000);
    for (const day of Object.keys(this.file.days)) if (day < oldest) delete this.file.days[day];
  }

  private todaySeconds(now: number): number {
    const today = localDay(now);
    let total = this.file.days[today] ?? 0;
    for (const attempt of this.file.attempts) if (!attempt.folded) total += this.attemptDays(attempt, now)[today] ?? 0;
    return total;
  }

  // ─── news to tell ────────────────────────────────────────────────────────────────────────────────────────────

  /** Keeps the list of news not yet told as the conversation changes, whatever else is added meanwhile. */
  private follow(event: MasterStreamEvent): void {
    if (event.type !== 'entry') return;
    const speak = speakOf(event.entry.data);
    const known = this.file.speaking.findIndex(item => item.id === event.entry.id);
    const open = speak?.state === 'pending' || speak?.state === 'sent';
    if (open && known < 0) {
      this.file.speaking.push({ id: event.entry.id, order: event.entry.order });
      // Bounded: the oldest beyond the limit is given up on (and says so on screen).
      while (this.file.speaking.length > KEEP_SPEAKING) {
        const oldest = this.file.speaking.shift()!;
        const entry = this.options.room.get(oldest.id);
        const stale = speakOf(entry?.data);
        if (entry && stale) this.setSpeak(entry, { ...stale, state: 'undelivered' });
      }
    } else if (!open && known >= 0) this.file.speaking.splice(known, 1);
    else return;
    void this.save();
  }

  private speakEntries(): Array<{ entry: MasterEntry; speak: MasterSpeak }> {
    return this.file.speaking.flatMap(item => {
      const entry = this.options.room.get(item.id);
      const speak = speakOf(entry?.data);
      return entry && speak ? [{ entry, speak }] : [];
    }).sort((a, b) => a.entry.order - b.entry.order);
  }

  /** News older than an hour is not told any more; it says so on screen. */
  private sweep(): void {
    const now = Date.now();
    for (const { entry, speak } of this.speakEntries()) if (speak.state === 'pending' && now - Date.parse(entry.at) > STALE_MS) this.setSpeak(entry, { ...speak, state: 'undelivered' });
  }

  private speakCounts(): { pending: number; wakeable: number } {
    let pending = 0, wakeable = 0;
    const now = Date.now();
    for (const { entry, speak } of this.speakEntries()) {
      if (speak.state !== 'pending' || now - Date.parse(entry.at) > STALE_MS) continue;
      pending++;
      if (!speak.woke) wakeable++;
    }
    return { pending, wakeable };
  }

  /** Not taken in, or perhaps not heard: waits for the next try, up to three. */
  private retry(entry: MasterEntry, speak: MasterSpeak): void {
    const tries = speak.tries + 1;
    this.setSpeak(entry, { ...speak, state: tries >= 3 ? 'undelivered' : 'pending', tries });
  }

  private setSpeak(entry: MasterEntry, speak: MasterSpeak): void {
    const data = this.options.room.get(entry.id)?.data;
    if (data && (data.kind === 'master' || data.kind === 'error' || data.kind === 'event')) this.options.room.update(entry.id, { ...data, speak });
  }

  // ─── plumbing ────────────────────────────────────────────────────────────────────────────────────────────────

  /** Every few seconds: the host's word to the page on its call, the daily limit, old news, and a new day's totals. */
  private tick(): void {
    this.sweep();
    const day = localDay(Date.now());
    if (this.live) { this.checkLimit(this.live); this.broadcast(); }
    else if (day !== this.shownDay) this.broadcast();
    this.shownDay = day;
  }

  private mine(attemptId: unknown): Live | undefined {
    if (typeof attemptId !== 'string' || !UUID.test(attemptId)) return undefined;
    const live = this.live;
    return live && live.attempt.attempt === hash(attemptId) ? live : undefined;
  }

  /** The ready call a request came from, if it is still on. */
  private ready(origin: VoiceOrigin): Live | undefined {
    const live = this.live;
    return live && !live.closing && live.attempt.phase === 'ready' && live.attempt.attempt === origin.attempt ? live : undefined;
  }

  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const next = this.serial.then(work, work);
    this.serial = next.catch(() => {});
    return next;
  }

  broadcast(): void { this.options.room.broadcast({ type: 'voice', seq: 0, voice: this.status() }); }

  private save(): Promise<void> {
    const write = () => writePrivateJson(this.path, JSON.stringify(this.file));
    const next = this.writes.then(write, write);
    this.writes = next.catch(error => { console.error(`Master voice records were not saved: ${(error as NodeJS.ErrnoException)?.code ?? 'error'}`); });
    return next;
  }
}
