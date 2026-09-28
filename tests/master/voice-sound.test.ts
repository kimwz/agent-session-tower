import test from 'node:test';
import assert from 'node:assert/strict';
import type { MasterVoiceStatus } from '../../shared/master.js';
import { activityReport, createHearing, hear, leaseVerdict, noticeResult, shouldWake, silenceDue } from '../../client/src/master/voice-sound.js';

const BIN_HZ = 48_000 / 1_024;
const BINS = 512;
const FRAME = 20;

/** A repeatable pseudo-random sequence, so the room's noise is the same every run. */
function noise(seed = 1) {
  let value = seed;
  return () => { value = (value * 1_103_515_245 + 12_345) % 2_147_483_648; return value / 2_147_483_648; };
}
const random = noise();
/** A quiet room: every bin a little noise. */
function room(level = 1e-9): Float64Array {
  const power = new Float64Array(BINS);
  for (let index = 0; index < BINS; index++) power[index] = level * (0.5 + random());
  return power;
}
/** A voice: harmonics of `pitch` shaped by three formants, over the room. */
function voice(level: number, pitch = 150): Float64Array {
  const power = room();
  for (let harmonic = pitch; harmonic < 4_000; harmonic += pitch) {
    const shape = [500, 1_500, 2_500].reduce((sum, formant) => sum + Math.exp(-(((harmonic - formant) / 300) ** 2)), 0.15);
    const bin = Math.round(harmonic / BIN_HZ);
    power[bin] += level * shape;
    power[bin - 1] += level * shape * 0.4;
    power[bin + 1] += level * shape * 0.4;
  }
  return power;
}
/** One tone (an alert, a beep): nearly all of its energy in a bin or two. */
function tone(level: number, hz = 1_000): Float64Array {
  const power = room();
  const bin = Math.round(hz / BIN_HZ);
  power[bin] += level;
  power[bin + 1] += level * 0.3;
  power[bin - 1] += level * 0.3;
  return power;
}
/** A steady sound in the voice band, spread like a voice but never changing: a fan near the microphone. */
function hum(level: number): Float64Array {
  const power = room();
  for (let bin = Math.ceil(300 / BIN_HZ); bin * BIN_HZ <= 3_400; bin++) power[bin] += level * (0.95 + 0.1 * random());
  return power;
}

/** Feeds `ms` of frames from `spectrum(t)` and returns whether each was heard as speech. */
function play(state = createHearing(), from: number, ms: number, spectrum: (t: number) => ArrayLike<number>): { state: ReturnType<typeof createHearing>; heard: boolean[]; end: number } {
  const heard: boolean[] = [];
  for (let t = from; t < from + ms; t += FRAME) heard.push(hear(state, spectrum(t), BIN_HZ, t));
  return { state, heard, end: from + ms };
}

test('speech is heard quickly over a learned noise floor and ends soon after it stops; a soft voice counts too', () => {
  const calibrated = play(undefined, 0, 1_500, () => room());
  assert.ok(calibrated.heard.every(value => !value), 'a quiet room is not speech');
  const speech = play(calibrated.state, calibrated.end, 1_000, () => voice(1e-6));
  const first = speech.heard.indexOf(true);
  assert.ok(first >= 0 && first * FRAME <= 300, `heard within ~250 ms (${first * FRAME} ms)`);
  const after = play(speech.state, speech.end, 1_000, () => room());
  const ended = (after.heard.indexOf(false) + 1) * FRAME;
  assert.ok(ended >= 380 && ended <= 460, `ends about 400 ms after the last word (${ended} ms)`);
  assert.ok(after.heard.slice(after.heard.indexOf(false)).every(value => !value));
  const soft = play(after.state, after.end, 1_000, () => voice(3e-8));
  assert.ok(soft.heard.some(Boolean), 'a soft voice is still a voice');
});

test('a tone is never speech, alone or right after speaking, and a call then goes quiet; a long sentence stays speech', () => {
  const calibrated = play(undefined, 0, 1_500, () => room());
  const beeps = play(calibrated.state, calibrated.end, 5_000, t => Math.floor(t / 400) % 2 ? tone(1e-4) : room());
  assert.ok(beeps.heard.every(value => !value), 'repeated alert tones are not speech');
  const speech = play(beeps.state, beeps.end, 2_000, () => voice(1e-6));
  const alarm = play(speech.state, speech.end, 20_000, () => tone(1e-4, 800));
  assert.ok(alarm.heard.findIndex(value => !value) * FRAME <= 440, 'speech ends when only a tone is left');
  assert.ok(alarm.heard.slice(30).every(value => !value));
  let lastSpeechAt = 0;
  speech.heard.forEach((value, index) => { if (value) lastSpeechAt = beeps.end + index * FRAME; });
  alarm.heard.forEach((value, index) => { if (value) lastSpeechAt = speech.end + index * FRAME; });
  assert.equal(silenceDue({ now: alarm.end, readyAt: 0, lastSpeechAt, lastPlaybackAt: 0, seconds: 15 }), true, 'twenty seconds of a tone ends the call');

  // Twenty-five seconds of talking, with syllables rising and falling, is heard all the way.
  const fresh = play(undefined, 0, 1_500, () => room());
  const long = play(fresh.state, fresh.end, 25_000, t => voice(1e-6 * (0.3 + 0.7 * Math.abs(Math.sin(t / 80)))));
  const from = long.heard.indexOf(true);
  assert.ok(long.heard.slice(from).filter(Boolean).length / (long.heard.length - from) > 0.97, 'a long sentence is not taken for the floor');
});

test('a steady sound in the voice band becomes the floor instead of being heard forever', () => {
  const calibrated = play(undefined, 0, 1_500, () => room());
  const fan = play(calibrated.state, calibrated.end, 12_000, () => hum(2e-7));
  assert.ok(fan.heard.slice(0, 50).some(Boolean), 'at first it sounds like someone');
  assert.ok(fan.heard.slice(-100).every(value => !value), 'after a few steady seconds it is part of the room');
  const speech = play(fan.state, fan.end, 1_000, () => { const power = hum(2e-7); const talk = voice(1e-5); for (let bin = 0; bin < BINS; bin++) power[bin] += talk[bin]; return power; });
  assert.ok(speech.heard.some(Boolean), 'speech over the fan is still heard');
});

test('the page ends a quiet call, wakes one only where it went quiet, judges notices with a second to object, and follows the host\'s word on its call', () => {
  assert.equal(silenceDue({ now: 20_000, readyAt: 0, lastSpeechAt: 4_000, lastPlaybackAt: 5_500, seconds: 15 }), false);
  assert.equal(silenceDue({ now: 20_500, readyAt: 0, lastSpeechAt: 4_000, lastPlaybackAt: 5_500, seconds: 15 }), true);
  assert.equal(silenceDue({ now: 999_999, readyAt: 0, lastSpeechAt: 0, lastPlaybackAt: 0, seconds: 0 }), false, '0 keeps the call open');

  const status: MasterVoiceStatus = { attempt: 'a1', tab: 'tab1', phase: 'closed', reason: 'silence', today: { seconds: 0, dollars: 0 }, limitMinutes: 0, pending: 1, wakeable: 1 };
  const wake = { status, tabHash: 'tab1', panelOpen: true, autoWake: true, visible: true, busy: false, failed: false };
  assert.equal(shouldWake(wake), true);
  for (const change of [{ tabHash: 'tab2' }, { panelOpen: false }, { autoWake: false }, { visible: false }, { busy: true }, { failed: true },
    { status: { ...status, reason: 'owner' } }, { status: { ...status, wakeable: 0 } }, { status: { ...status, phase: 'ready' as const } }]) {
    assert.equal(shouldWake({ ...wake, ...change }), false, JSON.stringify(change));
  }

  assert.equal(noticeResult({ startedAt: 1_000, endedAt: 3_000, lastSpeechAt: 0, now: 3_500 }), undefined, 'still inside the second to object');
  assert.equal(noticeResult({ startedAt: 1_000, endedAt: 3_000, lastSpeechAt: 0, now: 4_000 }), 'played');
  assert.equal(noticeResult({ startedAt: 1_000, endedAt: 3_000, lastSpeechAt: 3_700, now: 4_000 }), 'interrupted');
  assert.equal(noticeResult({ startedAt: 1_000, lastSpeechAt: 1_200, now: 1_300 }), 'interrupted');
  assert.equal(noticeResult({ startedAt: 1_000, failed: true, lastSpeechAt: 0, now: 1_300 }), 'failed');

  const lease = { status: { ...status, phase: 'ready' as const }, attemptHash: 'a1', connected: true, lastLeaseAt: 0, now: 10_000 };
  assert.equal(leaseVerdict(lease), 'keep');
  assert.equal(leaseVerdict({ ...lease, now: 20_001 }), 'lost', 'the host went silent while the stream is up');
  assert.equal(leaseVerdict({ ...lease, connected: false, disconnectedAt: 10_000, now: 200_000 }), 'keep', 'a web restart is waited out');
  assert.equal(leaseVerdict({ ...lease, connected: false, disconnectedAt: 10_000, now: 310_001 }), 'lost');
  assert.equal(leaseVerdict({ ...lease, status: { ...status, attempt: 'a2', phase: 'ready' } }), 'ended', 'another call took over');
  assert.equal(leaseVerdict({ ...lease, status: { ...status, phase: 'closing' } }), 'ended');

  assert.deepEqual(activityReport({ speaking: false, playing: true, lastSpeechAt: 9_000, lastPlaybackAt: 10_000 }, 10_000), { speaking: false, playing: true, sinceSpeechMs: 1_000, sincePlaybackMs: 0 });
  assert.deepEqual(activityReport({ speaking: false, playing: false, lastSpeechAt: 0, lastPlaybackAt: 0 }, 10_000), { speaking: false, playing: false }, 'never spoke: nothing to date');
});
