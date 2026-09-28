import type { MasterVoiceStatus } from '../../../shared/master';

/**
 * What the page decides from what it hears in a voice call, as plain functions: whether the owner speaks, whether
 * the call has gone quiet, whether news may wake a call, how a notice went, and whether the host still holds the call.
 */

export const HEARING = {
  /** The voice band, as a share of what a microphone picks up of speech (up to 8 kHz). */
  bandLow: 300, bandHigh: 3_400, heardHigh: 8_000,
  /** A frame may be speech at three times the noise floor, and stays speech at twice it. */
  startRatio: 3, keepRatio: 2,
  /** Most of the energy in the voice band, spread over many bins, none of them holding most of it (not a tone). */
  bandShare: 0.6, peakShare: 0.4, spreadBins: 8,
  startWindowMs: 250, startShare: 0.7, endMs: 400,
  /** The floor is the quiet 20% of the last three seconds that were not speech; the first second only learns it. */
  floorMs: 3_000, floorQuantile: 0.2, calibrateMs: 1_000, minFloor: 1e-9,
  /** A sound this steady for this long is a machine, not a voice: it becomes part of the floor. */
  steadyMs: 5_000, steadyVariation: 0.2,
};

export interface Hearing {
  speaking: boolean;
  startedAt: number;
  lastKeepAt: number;
  firstAt?: number;
  floor: number;
  quiet: Array<{ at: number; energy: number }>;
  recent: Array<{ at: number; candidate: boolean }>;
  loud: Array<{ at: number; energy: number }>;
}

export const createHearing = (): Hearing => ({ speaking: false, startedAt: 0, lastKeepAt: 0, floor: HEARING.minFloor, quiet: [], recent: [], loud: [] });

/** The voice band's energy and whether its spectrum looks like a voice (broad) rather than a tone. */
export function voiceBand(power: ArrayLike<number>, binHz: number): { energy: number; voiceLike: boolean } {
  let band = 0, total = 0, peak = 0, squares = 0;
  for (let index = 0; index < power.length; index++) {
    const value = Math.max(0, power[index]);
    const hz = index * binHz;
    if (hz <= HEARING.heardHigh) total += value;
    if (hz < HEARING.bandLow || hz > HEARING.bandHigh) continue;
    band += value;
    squares += value * value;
    peak = Math.max(peak, value);
  }
  // How many bins the energy is effectively spread over: about one or two for a tone, dozens for a voice.
  const spread = squares > 0 ? band * band / squares : 0;
  return { energy: band, voiceLike: band > 0 && band / Math.max(total, 1e-30) >= HEARING.bandShare && peak < band * HEARING.peakShare && spread >= HEARING.spreadBins };
}

/** One frame of the microphone's spectrum (linear power per bin, `binHz` apart): whether the owner is speaking now. */
export function hear(state: Hearing, power: ArrayLike<number>, binHz: number, now: number): boolean {
  const { energy, voiceLike } = voiceBand(power, binHz);
  state.firstAt ??= now;
  const learning = now - state.firstAt < HEARING.calibrateMs;
  const candidate = !learning && voiceLike && energy >= state.floor * HEARING.startRatio;
  const keep = !learning && voiceLike && energy >= state.floor * HEARING.keepRatio;
  state.recent.push({ at: now, candidate });
  while (state.recent.length && now - state.recent[0].at > HEARING.startWindowMs) state.recent.shift();
  if (state.speaking) {
    if (keep) state.lastKeepAt = now;
    state.loud.push({ at: now, energy });
    while (state.loud.length && now - state.loud[0].at > HEARING.steadyMs) state.loud.shift();
    if (now - state.lastKeepAt >= HEARING.endMs) state.speaking = false;
    else if (now - state.startedAt >= HEARING.steadyMs && steady(state.loud)) {
      // A hum that started loud enough to count: it is taken into the floor instead of being heard forever.
      state.speaking = false;
      for (const item of state.loud) state.quiet.push(item);
    }
    if (!state.speaking) state.loud = [];
  } else {
    const window = state.recent.length;
    if (window >= 3 && state.recent.filter(item => item.candidate).length / window >= HEARING.startShare && now - state.recent[0].at >= HEARING.startWindowMs * 0.8) {
      state.speaking = true;
      state.startedAt = now;
      state.lastKeepAt = now;
      state.loud = [{ at: now, energy }];
    }
  }
  // The floor learns only from what is not speech, so a long sentence does not raise it.
  if (!state.speaking) {
    state.quiet.push({ at: now, energy });
    while (state.quiet.length && now - state.quiet[0].at > HEARING.floorMs) state.quiet.shift();
    const sorted = state.quiet.map(item => item.energy).sort((a, b) => a - b);
    state.floor = Math.max(HEARING.minFloor, sorted[Math.floor((sorted.length - 1) * HEARING.floorQuantile)] ?? HEARING.minFloor);
  }
  return state.speaking;
}

function steady(items: Array<{ energy: number }>): boolean {
  if (items.length < 10) return false;
  const mean = items.reduce((sum, item) => sum + item.energy, 0) / items.length;
  if (mean <= 0) return false;
  const deviation = Math.sqrt(items.reduce((sum, item) => sum + (item.energy - mean) ** 2, 0) / items.length);
  return deviation / mean < HEARING.steadyVariation;
}

/** The call went quiet: nobody spoke and nothing played (a notice included) for the owner's number of seconds. */
export function silenceDue(input: { now: number; readyAt: number; lastSpeechAt: number; lastPlaybackAt: number; seconds: number }): boolean {
  return input.seconds > 0 && input.now - Math.max(input.readyAt, input.lastSpeechAt, input.lastPlaybackAt) >= input.seconds * 1000;
}

/**
 * News may start a call by itself: the last call in this tab ended on silence, there is news it has not woken for,
 * the panel is open and in view, waking is on, and nothing is starting here or failed to wake before.
 */
export function shouldWake(input: { status?: MasterVoiceStatus; tabHash?: string; panelOpen: boolean; autoWake: boolean; visible: boolean; busy: boolean; failed: boolean }): boolean {
  const status = input.status;
  return Boolean(status && input.tabHash && status.wakeable > 0 && status.tab === input.tabHash && status.reason === 'silence'
    && (status.phase === 'closed' || status.phase === 'unconfirmed') && input.panelOpen && input.autoWake && input.visible && !input.busy && !input.failed);
}

/** How a notice went: talked over from its start until a second after it ended, played through, or not played. */
export function noticeResult(input: { startedAt: number; endedAt?: number; failed?: boolean; lastSpeechAt: number; now: number }): 'played' | 'interrupted' | 'failed' | undefined {
  if (input.failed) return 'failed';
  if (input.lastSpeechAt >= input.startedAt) return 'interrupted';
  if (input.endedAt !== undefined && input.now - input.endedAt >= 1_000) return 'played';
  return undefined;
}

/**
 * Whether this page's call still stands with the host: over when the host ends or replaces it, lost when its word
 * stops coming (twenty seconds while the stream is up, five minutes while it is down).
 */
export function leaseVerdict(input: { status?: MasterVoiceStatus; attemptHash: string; connected: boolean; lastLeaseAt: number; disconnectedAt?: number; now: number }): 'keep' | 'ended' | 'lost' {
  const status = input.status;
  if (status?.attempt && status.attempt !== input.attemptHash) return 'ended';
  if (status?.attempt === input.attemptHash && (status.phase === 'closing' || status.phase === 'closed' || status.phase === 'unconfirmed')) return 'ended';
  if (input.connected && input.now - input.lastLeaseAt > 20_000) return 'lost';
  if (!input.connected && input.disconnectedAt !== undefined && input.now - input.disconnectedAt > 5 * 60_000) return 'lost';
  return 'keep';
}

/** What the page tells the host it hears, as times since (its clock never matters). */
export function activityReport(input: { speaking: boolean; playing: boolean; lastSpeechAt: number; lastPlaybackAt: number }, now: number) {
  return {
    speaking: input.speaking, playing: input.playing,
    ...(input.lastSpeechAt ? { sinceSpeechMs: Math.max(0, now - input.lastSpeechAt) } : {}),
    ...(input.lastPlaybackAt ? { sincePlaybackMs: Math.max(0, now - input.lastPlaybackAt) } : {}),
  };
}

/** Why a call ended, for the owner. */
export function endReason(reason: string | undefined, words: (ko: string, en: string) => string): string {
  switch (reason) {
    case 'silence': return words('말이 없어서 음성을 껐습니다.', 'Voice ended after a quiet while.');
    case 'owner': return words('음성을 껐습니다.', 'Voice ended.');
    case 'taken-over': return words('다른 곳에서 음성을 시작했습니다.', 'Voice started somewhere else.');
    case 'daily-limit': return words('오늘 음성 한도에 닿았습니다.', 'Today\'s voice limit was reached.');
    case 'expired': return words('음성 세션 시간이 다 됐습니다.', 'The voice session ran out of time.');
    case 'connection': case 'host': return words('연결이 끊겨 음성이 꺼졌습니다.', 'Voice ended: the connection was lost.');
    case 'failed': return words('음성을 시작하지 못했습니다.', 'Voice could not start.');
    default: return words('음성이 꺼졌습니다.', 'Voice ended.');
  }
}

/** The same digest the host keeps of a page's ids, so the page knows its own call and tab. */
export async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
