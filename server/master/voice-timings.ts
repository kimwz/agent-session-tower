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
export interface VoiceSayRecord { id: string; at: number; chars?: number; play?: number; result?: string; detail?: string }
export type VoiceTimingField = Exclude<keyof VoiceTimingRecord, 'key' | 'kind' | 'mode' | 'says' | 'outcome'>;

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
  said(key: string | undefined, id: string, at: number, chars: number): void {
    const record = this.find(key);
    if (!record) return;
    const says = record.says ??= [];
    says.push({ id, at: Math.round(at), chars });
    if (says.length > SAYS) says.splice(0, says.length - SAYS);
    this.later();
  }

  /** The page's word on one thing it was given: when its sound started, how it went, and what failed. */
  heard(key: string | undefined, id: string, word: { play?: number; result?: string; detail?: string }): void {
    const say = this.find(key)?.says?.find(item => item.id === id);
    if (!say) return;
    if (word.play !== undefined) say.play ??= Math.round(word.play);
    if (word.result) say.result ??= word.result;
    if (word.detail) say.detail ??= word.detail;
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

  list(): VoiceTimingRecord[] { return this.records.map(item => ({ ...item, ...(item.says ? { says: item.says.map(say => ({ ...say })) } : {}) })); }

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
