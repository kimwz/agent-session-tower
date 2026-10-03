import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import type { StreamSink } from '../streams/sink.js';
import type { ElevenLabs } from './elevenlabs.js';
import { frameAt, id3Size, MP3_BYTES_PER_SECOND, withoutTag } from './mp3.js';
import type { VoiceTimings, VoiceTransportStage, VoiceTtsRecord } from './voice-timings.js';
import type { AudioHandle, VoiceTiming } from './voice-types.js';
import { ttsDollarsPerChar, type VoiceUsage } from './voice-usage.js';

const LIVE_COUNT = 40;
/** Audio is kept longer than the longest answer read takes (`READ_CHARS` at `MS_PER_CHAR`). */
const LIVE_MS = 20 * 60_000;
/** Audio kept for one thing said: at least this, and more for a long answer (128 kbps is about 3 KB a character). */
const LIVE_BYTES = 2 * 1024 * 1024;
const LIVE_BYTES_PER_CHAR = 4 * 1024;
/** Audio being read while it is written is sealed when no words came for it this long (a turn that hangs). */
export const LIVE_WAIT_MS = 5 * 60_000;

/** Audio being made (or made) for the page, kept a short while. */
interface Live {
  id: string;
  chunks: Buffer[];
  bytes: number;
  done: boolean;
  failed: boolean;
  createdAt: number;
  waiters: Set<() => void>;
  readers: Set<StreamSink>;
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
  /** First part waited in the segment queue from this time; later parts share that segment origin. */
  queuedAt?: number;
  /** The voice session it was made for (only compared, never looked into). */
  session?: object;
  partIndex?: number;
}

const wake = (live: Live) => { for (const waiter of [...live.waiters]) waiter(); };

/**
 * Audio being made and kept a short while for the page: the only owner of each piece's bytes, readers, waiters and the
 * request for its sound. Others hold a handle (its id); every handle stays bound to the very audio it was made for,
 * even once that audio is no longer kept. Only serving and counting listeners look audio up by id.
 */
export class VoiceAudio {
  private readonly lives = new Map<string, Live>();
  private readonly handles = new WeakMap<AudioHandle, Live>();

  /**
   * `timings` is the voice's own diagnostics, looked up when used; `voice` the voice and model set now; `changed` tells
   * the pages that spending changed (when audio starts, and when parts never asked for are given back).
   */
  constructor(private readonly usage: VoiceUsage, private readonly timings: VoiceTimings, private readonly elevenLabs: Pick<ElevenLabs, 'speak'>,
    private readonly voice: () => { voiceId: string; model: string }, private readonly timing: VoiceTiming, private readonly changed: () => void) {}

  /**
   * Starts making audio for text, given whole or in parts made one after another into one stream; the page can play
   * it while it is still being made. The caller has checked the limit in the same step: the characters are counted
   * here, before anything is awaited.
   */
  synthesize(text: string | string[], voice?: { voiceId: string; model: string }, timing?: string): AudioHandle {
    const handle = this.openLive(voice, timing);
    const live = this.handles.get(handle)!;
    const parts = typeof text === 'string' ? [text] : text;
    const chars = parts.reduce((sum, part) => sum + part.length, 0);
    // Characters sent are paid for, whether or not the audio comes back whole.
    this.usage.add(live.createdAt, { ttsChars: chars, model: live.model });
    live.charged = chars;
    live.parts.push(...parts);
    live.sealed = true;
    wake(live);
    void this.usage.save();
    this.changed();
    return handle;
  }

  /** Creates the retained byte stream; synthesize seals its known input before making proceeds. */
  private openLive(voice?: { voiceId: string; model: string }, timing?: string): AudioHandle {
    const settings = voice ?? this.voice();
    const live: Live = { id: randomUUID(), chunks: [], bytes: 0, done: false, failed: false, createdAt: Date.now(), waiters: new Set(), readers: new Set(),
      parts: [], sealed: false, sent: 0, charged: 0, voiceId: settings.voiceId, model: settings.model, held: false, ...(timing ? { timing } : {}) };
    const handle: AudioHandle = Object.freeze({ id: live.id });
    this.handles.set(handle, live);
    this.lives.set(live.id, live);
    this.evict();
    void this.make(live);
    return handle;
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
          const piece: VoiceTtsRecord = { live: live.id, part: live.partIndex ?? index, attempt, ...(live.queuedAt !== undefined ? { queuedAt: live.queuedAt } : {}), start: Date.now(), bytes: 0 };
          this.timings.piece(live.timing, piece);
          this.timings.mark(live.timing, 'tts');
          try {
            const stream = this.elevenLabs.speak(part, live.voiceId, live.model, controller.signal);
            for await (const chunk of index ? withoutTag(stream) : stream) {
              if (live.failed) throw new Error('stopped');
              if (live.bytes + chunk.length > most) throw new Error('too large');
              idle();
              piece.bytes += chunk.length;
              if (!got) { this.timings.mark(live.timing, 'audio'); piece.firstByte = Date.now(); this.timings.piece(live.timing, piece); }
              got = true;
              live.chunks.push(chunk);
              live.bytes += chunk.length;
              wake(live);
            }
            if (!got) throw new Error('no sound');
            piece.result = 'done';
            break;
          } catch (error) {
            piece.result = 'failed';
            if (got || attempt > 0 || live.failed || (error as Error).message === 'too large' || this.usage.limited(Date.now(), part.length * ttsDollarsPerChar(live.model))) throw error;
            this.usage.add(Date.now(), { ttsChars: part.length, model: live.model });
            void this.usage.save();
          } finally { clearTimeout(deadline); piece.done = Date.now(); this.timings.piece(live.timing, piece); }
        }
      }
    } catch {
      live.failed = true;
      live.done = true;
      live.sealed = true;
      // Parts never asked for are not paid for.
      const unsent = live.parts.slice(live.sent).reduce((sum, part) => sum + part.length, 0);
      if (unsent) { this.usage.add(live.createdAt, { ttsChars: -unsent, model: live.model }); void this.usage.save(); this.changed(); }
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
      this.dropLive(oldest);
    }
  }

  /** Audio nobody will hear any more: the request under way stops, and no further part is asked for. */
  private abandonLive(live: Live): void {
    if (live.done) return;
    live.failed = true;
    live.stop?.();
    wake(live);
  }

  /** A finite part is published only once its complete successful byte count is known. */
  async complete(handle: AudioHandle, signal?: AbortSignal): Promise<boolean> {
    const live = this.handles.get(handle)!;
    const abort = () => this.abandonLive(live);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const deadline = Date.now() + 2 * this.timing.synthMs;
      await this.until(live, () => live.bytes > 0 || live.done || live.failed, Math.min(this.timing.firstChunkMs, 2 * this.timing.synthMs));
      if (!live.bytes) { this.abandonLive(live); return false; }
      await this.until(live, () => live.done || live.failed, Math.max(0, deadline - Date.now()));
      const complete = live.done && !live.failed && live.bytes > 0 && !signal?.aborted;
      if (!complete) this.abandonLive(live);
      return complete;
    } finally { signal?.removeEventListener('abort', abort); }
  }

  finished(handle: AudioHandle): Promise<void> { const live = this.handles.get(handle)!; return this.until(live, () => live.done, this.timing.synthMs); }
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
  private dropLive(live: Live): void {
    if (!live.done) { live.failed = true; live.done = true; }
    for (const reader of live.readers) if (live.failed) this.cutOff(reader);
    wake(live);
    this.lives.delete(live.id);
  }

  /**
   * What a turn or reply being read adds to its audio, right after it starts: the voice session it is for, whether a
   * turn holds it (never pushed out then), and where it waited and which part it is (for the timing records).
   */
  configure(handle: AudioHandle, set: { session?: object; held?: boolean; queuedAt?: number; partIndex?: number }): void {
    Object.assign(this.handles.get(handle)!, set);
  }

  /** How the audio stands now, as a copy. */
  snapshot(handle: AudioHandle): { done: boolean; failed: boolean } {
    const live = this.handles.get(handle)!;
    return { done: live.done, failed: live.failed };
  }

  /** Its sound so far, as it is when asked (kept even once the audio is no longer). */
  bytes(handle: AudioHandle): Buffer { return Buffer.concat(this.handles.get(handle)!.chunks); }

  /** Audio nobody will hear any more: the request under way stops, and no further part is asked for. */
  abandon(handle: AudioHandle): void { this.abandonLive(this.handles.get(handle)!); }

  /** Audio no longer kept: its unfinished making fails, its readers are cut off, and it is gone from the store. */
  drop(handle: AudioHandle): void { this.dropLive(this.handles.get(handle)!); }

  /** A voice session ended: the audio made for it is abandoned. */
  abandonSession(session: object): void { for (const live of this.lives.values()) if (live.session === session) this.abandonLive(live); }

  /** Nothing is kept any more (the host closing). */
  dropAll(): void { for (const live of [...this.lives.values()]) this.dropLive(live); }

  /** Audio kept too long goes, unless a turn being read holds it. */
  expire(now: number): void { for (const live of [...this.lives.values()]) if (now - live.createdAt > LIVE_MS && !live.held) this.dropLive(live); }

  /** Whether any audio is still being made. */
  busy(): boolean { return [...this.lives.values()].some(live => !live.done); }

  /**
   * Streams audio to the page (through the web): what is made so far, then the rest as it comes. A slow page is
   * waited for, but never past its connection closing or a while; nothing waiting is left behind either way.
   */
  async serve(id: string, sink: StreamSink, at: number, requestId: string): Promise<void> {
    const res = sink.body;
    const live = this.lives.get(id);
    if (!live) { sink.refuse('not-found'); return; }
    const stage: VoiceTransportStage = { request: Date.now(), bytes: 0 };
    const record = () => this.timings.audioRequest(live.timing, id, requestId, at, stage);
    record();
    res.once('finish', () => { stage.end = Date.now(); stage.normal = true; record(); });
    res.once('close', () => { stage.close = Date.now(); stage.normal ??= false; record(); });
    const write = (chunk: Buffer) => { const sent = res.write(chunk); stage.bytes += chunk.length; if (stage.firstWrite === undefined) { stage.firstWrite = Date.now(); record(); } return sent; };
    if (live.failed) { sink.refuse('upstream'); return; }
    const finite = live.done;
    const made = finite ? Buffer.concat(live.chunks) : undefined;
    const from = made && at > 0 ? frameAt(made, id3Size(made) + Math.floor(at * MP3_BYTES_PER_SECOND)) : 0;
    sink.open(made ? { length: Math.max(0, made.length - from) } : {});
    live.readers.add(sink);
    let index = 0;
    try {
      if (made) {
        if (from < made.length && !write(made.subarray(from)) && !await this.wait(res, live, true)) { res.destroy(); return; }
        if (!res.destroyed) res.end();
        return;
      }
      // Played again from `at` seconds (the page lost its connection partway): from the first whole frame there.
      if (at > 0 && live.chunks.length) {
        const made = Buffer.concat(live.chunks);
        index = live.chunks.length;
        const from = frameAt(made, id3Size(made) + Math.floor(at * MP3_BYTES_PER_SECOND));
        if (from < made.length && !write(made.subarray(from)) && !await this.wait(res, live, true)) { res.destroy(); return; }
      }
      while (!res.destroyed && !res.writableEnded) {
        while (index < live.chunks.length && !res.destroyed) {
          // A page that does not take what it was sent in a while is cut off.
          if (!write(live.chunks[index++]) && !await this.wait(res, live, true)) { res.destroy(); return; }
        }
        if (res.destroyed) return;
        if (live.failed) { this.cutOff(sink); return; }
        if (live.done && index >= live.chunks.length) { res.end(); return; }
        await this.wait(res, live, false);
      }
    } finally { live.readers.delete(sink); }
  }

  /**
   * Cuts a page off failed audio, never with a clean end, once what it was sent has left: cut at once, audio written
   * just before would be thrown away, and a page that came late would get nothing of what was made.
   */
  private cutOff(reader: StreamSink): void { reader.cutOff(this.timing.waitMs); }

  /**
   * Waits for the page to drain what it was sent (`drain`), or for more audio (otherwise); either way also for its
   * connection ending or a while passing, which is the only false answer. Leaves nothing registered.
   */
  private wait(res: Writable, live: Live, drain: boolean): Promise<boolean> {
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
}
