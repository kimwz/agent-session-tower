import type { MasterUnspoken } from '../../shared/master.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';

/** The moments of one spoken request (or report) as it is answered aloud, in milliseconds since the epoch. */
export interface VoiceTimingRecord {
  key: string;
  kind?: 'answer' | 'report';
  /** `stream`: read while it was written; `turn-end`: read once the turn had ended. */
  mode?: 'stream' | 'turn-end';
  /** The host took the spoken request (or sent the report). */
  request?: number;
  /** The first response (a fast model's short sentence) was handed to the page. */
  ack?: number;
  /** The host first saw the master's words for it. */
  text?: number;
  /** The first words went to text-to-speech. */
  tts?: number;
  /** Their first sound came back. */
  audio?: number;
  /** The page was told to play it. */
  say?: number;
  /** The page started playing it (the page's own delay added to `say`). */
  play?: number;
  /** First sentence flushed to the speech queue; independent of first observed reply text. */
  sentence?: number;
  /** The host received the page's first positive playback progress. */
  started?: number;
  runId?: string;
  turnId?: string;
  delta?: number;
  completed?: number;
  pieces?: VoiceTtsRecord[];
  audioRequests?: VoiceAudioRequest[];
  droppedAudioRequests?: number;
  nativeEnd?: number;
  replies?: { id: string; firstAt?: number; completedAt?: number }[];
  /** The master's turn ended. */
  end?: number;
  /**
   * Every thing given to the page for it (each streamed reply's audio, a turn-end reading, one heard again), in order:
   * when it went, how many characters it showed, when its sound started, and the page's word on it.
   */
  says?: VoiceSayRecord[];
  /** How its reading ended: heard to the end, or not (and why). */
  outcome?: { at: number; state: 'played' | 'unspoken'; reason?: MasterUnspoken; heard?: true };
}
export interface VoicePlaybackRecord { position?: number; muted?: boolean; volume?: number; ready?: number; network?: number; context?: string; paused?: boolean; ended?: boolean; seeking?: boolean; rate?: number; bufferedEnd?: number; errorCode?: number }
export type VoiceProgressEvent = 'received' | 'source' | 'play-attempt' | 'play-resolved' | 'play-rejected' | 'started' | 'waiting' | 'resumed' | 'progress' | 'retry' | 'ended' | 'media-error' | 'terminal';
export interface VoiceProgressRecord { event: VoiceProgressEvent; at: number; elapsedMs?: number; attempt?: number; reason?: 'no-progress' | 'media-error'; error?: string; gate?: 'audio' | 'speech' | 'ready'; playback?: VoicePlaybackRecord; result?: string }
export interface VoiceTtsRecord { live: string; part: number; attempt: number; queuedAt?: number; start: number; firstByte?: number; done?: number; bytes: number; result?: 'done' | 'failed' }
export interface VoiceSayRecord { id: string; live?: string; at: number; chars?: number; play?: number; result?: string; detail?: string; playback?: VoicePlaybackRecord; received?: VoiceProgressRecord; source?: VoiceProgressRecord; started?: VoiceProgressRecord; latest?: VoiceProgressRecord; terminal?: VoiceProgressRecord; waits?: number; events?: VoiceProgressRecord[]; droppedEvents?: number }
/** Server HTTP stages: firstWrite means a server write, not browser receipt, decoded PCM or audible output. */
export interface VoiceTransportStage { request: number; firstWrite?: number; end?: number; close?: number; bytes: number; normal?: boolean }
export interface VoiceAudioRequest { requestId: string; live: string; offset: number; host?: VoiceTransportStage; web?: VoiceTransportStage }
const PROGRESS_EVENTS = new Set(['received', 'source', 'play-attempt', 'play-resolved', 'play-rejected', 'started', 'waiting', 'resumed', 'progress', 'retry', 'ended', 'media-error']);
const ERRORS = new Set(['NotAllowedError', 'NotSupportedError', 'AbortError', 'InvalidStateError', 'NetworkError', 'Error', 'Other']);
export function elapsed(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 3_600_000 ? value : undefined; }
export function attemptNumber(value: unknown): number | undefined { return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3 ? value : undefined; }
export function progressRecord(input: { event: unknown; elapsedMs: unknown; attempt?: unknown; reason?: unknown; error?: unknown; gate?: unknown; playback?: unknown }): VoiceProgressRecord | undefined {
  if (typeof input.event !== 'string' || !PROGRESS_EVENTS.has(input.event) || elapsed(input.elapsedMs) === undefined) return undefined;
  if (input.attempt !== undefined && attemptNumber(input.attempt) === undefined) return undefined;
  if (input.reason !== undefined && !['no-progress', 'media-error'].includes(String(input.reason))) return undefined;
  if (input.error !== undefined && (typeof input.error !== 'string' || !ERRORS.has(input.error))) return undefined;
  if (input.gate !== undefined && (input.event !== 'received' || !['audio', 'speech', 'ready'].includes(String(input.gate)))) return undefined;
  const playback = playbackRecord(input.playback);
  if (input.event === 'started' && !(playback?.position && playback.position > 0)) return undefined;
  return { event: input.event as VoiceProgressEvent, at: Date.now(), elapsedMs: input.elapsedMs as number,
    ...(input.attempt !== undefined ? { attempt: input.attempt as number } : {}), ...(input.reason ? { reason: input.reason as 'no-progress' | 'media-error' } : {}),
    ...(input.error ? { error: input.error as string } : {}), ...(input.gate ? { gate: input.gate as 'audio' | 'speech' | 'ready' } : {}), ...(playback ? { playback } : {}) };
}
/** Only whitelisted media state enters timing records. */
export function playbackRecord(value: unknown): VoicePlaybackRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  const result: VoicePlaybackRecord = {};
  for (const [key, max] of [['position', 3_600], ['volume', 1], ['ready', 4], ['network', 3], ['rate', 4], ['bufferedEnd', 3_600], ['errorCode', 4]] as const) {
    const number = input[key];
    if (typeof number === 'number' && Number.isFinite(number) && number >= (key === 'rate' ? 0.25 : 0) && number <= max) result[key] = number;
  }
  for (const key of ['muted', 'paused', 'ended', 'seeking'] as const) if (typeof input[key] === 'boolean') result[key] = input[key];
  if (['running', 'suspended', 'closed', 'interrupted'].includes(String(input.context))) result.context = String(input.context);
  return Object.keys(result).length ? result : undefined;
}
export function transportStage(value: unknown): VoiceTransportStage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.request !== 'number' || !Number.isFinite(input.request) || input.request < 0 || typeof input.bytes !== 'number' || !Number.isInteger(input.bytes) || input.bytes < 0 || input.bytes > 100 * 1024 * 1024) return undefined;
  const result: VoiceTransportStage = { request: input.request, bytes: input.bytes };
  for (const key of ['firstWrite', 'end', 'close'] as const) if (typeof input[key] === 'number' && Number.isFinite(input[key]) && input[key] >= input.request) result[key] = input[key];
  if (typeof input.normal === 'boolean') result.normal = input.normal;
  return result;
}
function count(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1_000_000, Math.floor(value))) : 0; }
function trim<T>(items: T[], max: number, first: number): number { const dropped = Math.max(0, items.length - max); if (dropped) items.splice(first, dropped); return dropped; }
export type VoiceTimingField = 'request' | 'ack' | 'text' | 'tts' | 'audio' | 'say' | 'play' | 'end' | 'sentence' | 'started' | 'delta' | 'completed' | 'nativeEnd';

const KEEP = 200;
/** Things said kept per record: a long turn of many replies keeps its latest. */
const SAYS = 30;
const SAVE_MS = 2_000;

/**
 * When each answer's first sound came, kept for the owner to check (`master/voice-timings.json`, the latest 200) and
 * written to the host's log once it played. Each moment is kept the first time it happens.
 */
export class VoiceTimings {
  private records: VoiceTimingRecord[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async start(): Promise<void> {
    const saved = await readPrivateJson(this.path).catch(() => undefined) as { records?: unknown } | undefined;
    if (Array.isArray(saved?.records)) this.records = saved.records.filter((item): item is VoiceTimingRecord => typeof (item as VoiceTimingRecord)?.key === 'string').slice(-KEEP);
    for (const record of this.records) {
      if (Array.isArray(record.says)) { record.says = record.says.slice(-SAYS); for (const say of record.says) if (Array.isArray(say.events)) say.droppedEvents = Math.min(1_000_000, count(say.droppedEvents) + trim(say.events, 64, 16)); }
      if (Array.isArray(record.audioRequests)) record.droppedAudioRequests = Math.min(1_000_000, count(record.droppedAudioRequests) + trim(record.audioRequests, 30, 8));
    }
  }

  mark(key: string | undefined, field: VoiceTimingField, at = Date.now(), about: Pick<VoiceTimingRecord, 'kind' | 'mode'> = {}): void {
    if (!key) return;
    let record = this.records.find(item => item.key === key);
    if (!record) {
      // Only a request (or report) starts a record: later moments of something not followed are not kept.
      if (field !== 'request') return;
      record = { key };
      this.records.push(record);
      if (this.records.length > KEEP) this.records.splice(0, this.records.length - KEEP);
    }
    if (about.kind && !record.kind) record.kind = about.kind;
    if (about.mode && !record.mode) record.mode = about.mode;
    if (record[field] !== undefined) return;
    record[field] = Math.round(at);
    if (field === 'play') console.log(describe(record));
    this.later();
  }

  /** One thing given to the page to play, every time (not only the first). */
  said(key: string | undefined, id: string, at: number, chars: number, live?: string): void {
    const record = this.find(key);
    if (!record) return;
    const says = record.says ??= [];
    says.push({ id, at: Math.round(at), chars, ...(live ? { live } : {}) });
    if (says.length > SAYS) says.splice(0, says.length - SAYS);
    this.later();
  }

  /** The page's word on one thing it was given: when its sound started, how it went, and what failed. */
  heard(key: string | undefined, id: string, word: { play?: number; result?: string; detail?: string; playback?: VoicePlaybackRecord }): void {
    const say = this.find(key)?.says?.find(item => item.id === id);
    if (!say) return;
    if (word.play !== undefined) say.play ??= Math.round(word.play);
    if (word.result) say.result ??= word.result;
    if (word.detail) say.detail ??= word.detail;
    if (word.playback) say.playback = word.playback;
    this.later();
  }

  /** Progress never settles playback; its bounded history contains only validated diagnostic fields. */
  progress(key: string, id: string, progress: VoiceProgressRecord): void {
    const record = this.find(key);
    const say = record?.says?.find(item => item.id === id);
    if (!record || !say || say.result) return;
    if (progress.event === 'received' || progress.event === 'source' || progress.event === 'started') say[progress.event] ??= progress;
    if (progress.event === 'started') this.mark(key, 'started', progress.at);
    if (progress.event === 'waiting') say.waits = Math.min(10_000, (say.waits ?? 0) + 1);
    say.latest = progress;
    this.event(say, progress);
    this.later();
  }

  terminal(key: string, id: string, terminal: VoiceProgressRecord): void {
    const say = this.find(key)?.says?.find(item => item.id === id);
    if (!say || say.terminal) return;
    say.terminal = terminal;
    this.event(say, terminal);
    this.later();
  }

  private event(say: VoiceSayRecord, event: VoiceProgressRecord): void {
    const events = say.events ??= [];
    events.push(event);
    say.droppedEvents = Math.min(1_000_000, count(say.droppedEvents) + trim(events, 64, 16));
  }

  audioRequest(key: string | undefined, live: string, requestId: string, offset: number, host: VoiceTransportStage): void {
    const record = this.find(key);
    if (!record) return;
    const requests = record.audioRequests ??= [];
    const existing = requests.find(item => item.requestId === requestId && item.live === live);
    if (existing) existing.host = { ...host };
    else { requests.push({ live, requestId, offset, host: { ...host } }); record.droppedAudioRequests = Math.min(1_000_000, count(record.droppedAudioRequests) + trim(requests, 30, 8)); }
    this.later();
  }

  webTransport(live: string, requestId: string, web: VoiceTransportStage): boolean {
    const request = this.records.flatMap(record => record.audioRequests ?? []).find(item => item.live === live && item.requestId === requestId);
    if (!request) return false;
    request.web = { ...request.web, ...web, request: Math.min(request.web?.request ?? web.request, web.request), bytes: Math.max(request.web?.bytes ?? 0, web.bytes), ...(request.web?.normal === true ? { normal: true } : {}) };
    this.later();
    return true;
  }

  piece(key: string | undefined, piece: VoiceTtsRecord): void {
    const record = this.find(key);
    if (!record) return;
    const pieces = record.pieces ??= [];
    const existing = pieces.find(item => item.live === piece.live && item.part === piece.part && item.attempt === piece.attempt);
    if (existing) Object.assign(existing, piece);
    else { pieces.push({ ...piece }); if (pieces.length > 40) pieces.splice(1, pieces.length - 40); }
    this.later();
  }

  observe(key: string | undefined, input: { runId: string; turnId: string; finishedAt?: string; replies?: readonly { id: string; firstAt?: number; completedAt?: number }[] }): void {
    const record = this.find(key);
    if (!record) return;
    record.runId ??= input.runId;
    record.turnId ??= input.turnId;
    const nativeEnd = input.finishedAt ? Date.parse(input.finishedAt) : NaN;
    if (Number.isFinite(nativeEnd)) this.mark(key, 'nativeEnd', nativeEnd);
    for (const reply of input.replies ?? []) {
      if (reply.firstAt === undefined && reply.completedAt === undefined) continue;
      const replies = record.replies ??= [];
      let saved = replies.find(item => item.id === reply.id);
      if (!saved) { replies.push(saved = { id: reply.id }); if (replies.length > 30) replies.splice(1, replies.length - 30); }
      if (typeof reply.firstAt === 'number' && Number.isFinite(reply.firstAt)) saved.firstAt ??= reply.firstAt;
      if (typeof reply.completedAt === 'number' && Number.isFinite(reply.completedAt)) saved.completedAt ??= reply.completedAt;
      if (typeof reply.firstAt === 'number' && Number.isFinite(reply.firstAt)) this.mark(key, 'delta', reply.firstAt);
      if (typeof reply.completedAt === 'number' && Number.isFinite(reply.completedAt)) this.mark(key, 'completed', reply.completedAt);
    }
    this.later();
  }

  /** How the reading ended, written to the log too (each time: a reading heard again ends again). */
  outcome(key: string | undefined, outcome: Omit<NonNullable<VoiceTimingRecord['outcome']>, 'at'>, at = Date.now()): void {
    const record = this.find(key);
    if (!record) return;
    record.outcome = { at: Math.round(at), ...outcome };
    console.log(describeOutcome(record));
    this.later();
  }

  list(): VoiceTimingRecord[] { return structuredClone(this.records); }

  private find(key: string | undefined): VoiceTimingRecord | undefined { return key ? this.records.find(item => item.key === key) : undefined; }

  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; this.save(); }
    await this.writes;
  }

  private later(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.save(); }, SAVE_MS);
    this.timer.unref();
  }

  private save(): void {
    const text = JSON.stringify({ records: this.records });
    this.writes = this.writes.then(() => writePrivateJson(this.path, text)).catch(() => {});
  }
}

/** One line for the log: how long after the request each moment came. */
export function describe(record: VoiceTimingRecord): string {
  const base = record.request;
  const after = (field: VoiceTimingField) => record[field] !== undefined && base !== undefined ? `${field} +${record[field]! - base}ms` : undefined;
  const steps = (['ack', 'text', 'tts', 'audio', 'say', 'play', 'end'] as const).map(after).filter(Boolean).join(', ');
  return `Master voice timing ${record.key.slice(0, 8)} (${record.mode ?? 'unknown'}): ${steps || 'no request time'}`;
}

/** One line for the log: how a reading ended, and the page's word on each thing it was given. */
export function describeOutcome(record: VoiceTimingRecord): string {
  const outcome = record.outcome;
  const how = !outcome ? 'unknown' : outcome.state === 'played' ? 'played' : `unspoken ${outcome.reason ?? 'unknown'}${outcome.heard ? ', part heard' : ''}`;
  const says = (record.says ?? []).map(say => `${say.result ?? 'no word'}${say.detail ? `(${say.detail})` : ''}`).join(', ');
  return `Master voice outcome ${record.key.slice(0, 8)} (${record.mode ?? 'unknown'}): ${how}${says ? `; says: ${says}` : ''}`;
}
