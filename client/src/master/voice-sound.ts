/**
 * What the page decides from what it hears, as plain functions: when the owner starts and stops speaking, when
 * listening has gone on long enough, and how a notice went. The speech gate is SORI's, which works in real rooms.
 */

const SPEECH_ONSET_MS = 280;
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
  private lastLoud = 0;
  private speaking = false;
  private initialized = false;
  private smooth = 0;

  constructor(public silenceMs = 1000) {}

  get isSpeaking(): boolean { return this.speaking; }

  update(rawRms: number, now = Date.now()): GateEvent {
    this.smooth = this.smooth ? this.smooth + (rawRms - this.smooth) * 0.1 : rawRms;
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
      if (rms > Math.max(ABS_START_MIN, this.baseline * START_RATIO)) {
        if (!this.voicedSince) this.voicedSince = now;
        if (now - this.voicedSince >= SPEECH_ONSET_MS) {
          this.speaking = true;
          this.preSpeechBaseline = this.baseline;
          this.lastLoud = now;
          this.voicedSince = 0;
          return 'speech-start';
        }
      } else this.voicedSince = 0;
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
    this.initialized = false;
    this.smooth = 0;
  }
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
 * the moment after passed is played; not yet decided otherwise.
 */
export function noticeOutcome(input: { endedAt?: number; failed?: boolean; cancelled?: boolean; spokeAt?: number; startedAt: number; now: number; windowMs: number }): 'played' | 'interrupted' | 'failed' | undefined {
  if (input.failed) return 'failed';
  if (input.cancelled || (input.spokeAt !== undefined && input.spokeAt >= input.startedAt)) return 'interrupted';
  if (input.endedAt !== undefined && input.now - input.endedAt >= input.windowMs) return 'played';
  return undefined;
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
