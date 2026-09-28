/**
 * What the page decides from what it hears, as plain functions: when the owner starts and stops speaking, when
 * listening has gone on long enough, and how a notice went. The speech gate is SORI's, which works in real rooms.
 */

const SPEECH_ONSET_MS = 240;
/** Quiet this short between syllables does not start the onset over: speech is not one unbroken sound. */
const ONSET_GAP_MS = 100;
/** Of the onset, at least this share must be loud: syllables are, keys typed or tapped a moment apart are not. */
const ONSET_LOUD_SHARE = 0.6;
const ABS_START_MIN = 0.005;
const ABS_END_MIN = 0.003;
const START_RATIO = 2.5;
const END_RATIO = 1.8;
const RISE_IDLE = 0.001;
const RISE_SPEAKING = 0.0002;
const FALL = 0.02;

export type GateEvent = 'speech-start' | 'silence-commit' | null;

/**
 * Speech from the microphone's loudness (RMS, per audio frame), relative to the room's own level: it follows steady
 * noise so a fan does not read as a voice, speech starts well above it for a while, and ends once it has been back
 * near the level before it for `silenceMs`.
 */
export class SpeechGate {
  private baseline = ABS_START_MIN;
  private preSpeechBaseline = ABS_START_MIN;
  private voicedSince = 0;
  private lastAbove = 0;
  private loudMs = 0;
  private lastUpdate = 0;
  private lastLoud = 0;
  private speaking = false;
  private initialized = false;
  private smooth = 0;

  constructor(public silenceMs = 1000) {}

  get isSpeaking(): boolean { return this.speaking; }

  /** When (on the clock given to `update`) the voice was last heard, while speaking. */
  get lastVoiceAt(): number { return this.lastLoud; }

  /** Loud, but not for long enough yet to count as speech: the owner may be starting to speak again. */
  get isVoicing(): boolean { return !this.speaking && this.voicedSince > 0; }

  /** How long the moment has been loud (its short gaps left out), while `isVoicing`. */
  get voicedMs(): number { return this.isVoicing ? this.loudMs : 0; }

  update(rawRms: number, now = Date.now()): GateEvent {
    this.smooth = this.smooth ? this.smooth + (rawRms - this.smooth) * 0.1 : rawRms;
    const step = this.lastUpdate ? Math.max(0, now - this.lastUpdate) : 0;
    this.lastUpdate = now;
    const rms = this.smooth;
    if (!this.initialized) {
      // Starts at the room's level, so a noisy room is not one long voice while the slow average catches up.
      this.baseline = Math.max(rms, ABS_END_MIN);
      this.initialized = true;
      return null;
    }
    if (rms < this.baseline) this.baseline += (rms - this.baseline) * FALL;
    else this.baseline += (rms - this.baseline) * (this.speaking ? RISE_SPEAKING : RISE_IDLE);
    if (!this.speaking) {
      const start = Math.max(ABS_START_MIN, this.baseline * START_RATIO);
      if (rms > start) {
        // Loud time is the frames' own loudness, not the smoothed one, whose tail would make a click last long.
        if (!this.voicedSince) { this.voicedSince = now; this.loudMs = 0; } else if (rawRms > start) this.loudMs += step;
        this.lastAbove = now;
        if (now - this.voicedSince >= SPEECH_ONSET_MS && this.loudMs >= (now - this.voicedSince) * ONSET_LOUD_SHARE) {
          this.speaking = true;
          this.preSpeechBaseline = this.baseline;
          this.lastLoud = now;
          this.voicedSince = 0;
          return 'speech-start';
        }
      } else if (now - this.lastAbove > ONSET_GAP_MS) this.voicedSince = 0;
      return null;
    }
    if (rms > Math.max(ABS_END_MIN, this.preSpeechBaseline * END_RATIO)) this.lastLoud = now;
    if (now - this.lastLoud >= this.silenceMs) {
      this.speaking = false;
      this.voicedSince = 0;
      return 'silence-commit';
    }
    return null;
  }

  /** Forgets the utterance and takes the room's level again from the next frame (after playback, for one). */
  reset(): void {
    this.speaking = false;
    this.voicedSince = 0;
    this.lastUpdate = 0;
    this.initialized = false;
    this.smooth = 0;
  }
}

/** Words said while thinking, or that lead into more: after one of these the owner is not done. */
const LEAD_WORDS = new Set(['음', '으음', '음음', '어', '어어', '아', '저', '저기', '그', '뭐', '뭐지', '뭐더라', '그러니까', '그니까', '그리고', '그래서', '그런데', '근데', '그럼', '그러면', '아니면', '또', '및', '혹은', '이제', '좀', '막', '약간', '일단', '우선', '그거', '그게', '이거', '이게', '거기', 'um', 'umm', 'uh', 'uhm', 'er', 'erm', 'and', 'so', 'but', 'or', 'like', 'the', 'a', 'an', 'to', 'of', 'with', 'because']);
/** Korean endings that join a clause to the next one, and particles after which the sentence has not ended. */
const LEAD_ENDING = /(?:고|서|는데|은데|인데|한데|던데|면|면서|니까|지만|거나|든지|도록|려고|랑|과|를|을|은|는|에|에서|에게|한테|로|의|도|만|까지|부터|보다|처럼)$/;
/** How a finished Korean sentence (or any sentence with its full stop) ends. */
const FINAL_ENDING = /(?:[.?!。？！]|요|다|까|죠|지|네|니다|세요|줘|봐|래|야|자|해|어|아)$/;

/** How long past the gate's own pause the owner is given before what they said is taken as finished. */
export const END_HOLD_MS = { finished: 200, unclear: 900, unfinished: 1_600 } as const;

/**
 * How much longer to wait, after a pause long enough to end speech, before taking what was said so far (`heard`, the
 * latest partial writing) as finished: little after a finished sentence, more when it is unclear, and most when it
 * trails off with a filler, a joining ending or a particle. Nothing written down yet is unclear: likely a noise, or
 * writing that lags behind.
 */
export function endHoldMs(heard: string): number {
  const text = heard.trim().toLowerCase();
  if (!text) return END_HOLD_MS.unclear;
  if (/(?:,|，|、|\.\.\.|…|-)$/.test(text)) return END_HOLD_MS.unfinished;
  const bare = text.replace(/[\s.?!。？！]+$/, '');
  const last = bare.split(/\s+/).at(-1) ?? '';
  if (!last || LEAD_WORDS.has(last)) return END_HOLD_MS.unfinished;
  if (LEAD_ENDING.test(last)) return END_HOLD_MS.unfinished;
  if (/[.?!。？！]$/.test(text) || FINAL_ENDING.test(last)) return END_HOLD_MS.finished;
  return END_HOLD_MS.unclear;
}

/** One utterance is at most 60 seconds of 16 kHz 16-bit audio: what each token reserves. */
export const UTTERANCE_BYTES = 60 * 32_000;

/** How much of a chunk (in bytes, whole samples) still fits an utterance, leaving room for the tail that commits it. */
export function fitUtterance(sent: number, size: number, tail: number): number {
  const room = UTTERANCE_BYTES - tail - sent;
  return Math.max(0, Math.min(size, room - (room % 2)));
}

/** Listening turns off after the owner's minutes with neither a request nor a report. */
export function listenExpired(lastActivityAt: number, minutes: number, now: number): boolean {
  return now - lastActivityAt >= minutes * 60_000;
}

/**
 * How a notice went: cancelled or talked over (during it, or in the moment after) is interrupted; played through with
 * the moment after passed is played; not yet decided otherwise. The moment after starts at `armedAt` (when it really
 * began) and, when the microphone is heard (`heardMs`), lasts until that much of it was heard as well.
 */
export function noticeOutcome(input: { armedAt?: number; heardMs?: number; failed?: boolean; cancelled?: boolean; spokeAt?: number; startedAt: number; now: number; windowMs: number }): 'played' | 'interrupted' | 'failed' | undefined {
  if (input.failed) return 'failed';
  if (input.cancelled || (input.spokeAt !== undefined && input.spokeAt >= input.startedAt)) return 'interrupted';
  if (input.armedAt === undefined || input.now - input.armedAt < input.windowMs) return undefined;
  if (input.heardMs !== undefined && input.heardMs < input.windowMs) return undefined;
  return 'played';
}

/** The same digest the host keeps of a voice session, so the page knows its own. */
export async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

/** 16 kHz 16-bit PCM from the microphone's float samples at its own rate (linear interpolation, as SORI). */
export function toPcm16(input: Float32Array, fromRate: number): Int16Array {
  const ratio = fromRate / 16_000;
  const length = Math.floor(input.length / ratio);
  const out = new Int16Array(length);
  for (let index = 0; index < length; index++) {
    const position = index * ratio;
    const low = Math.floor(position);
    const high = Math.min(low + 1, input.length - 1);
    const sample = Math.max(-1, Math.min(1, input[low] * (1 - (position - low)) + input[high] * (position - low)));
    out[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return out;
}

export function base64(bytes: Uint8Array): string {
  let text = '';
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(text);
}
