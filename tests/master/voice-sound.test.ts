import test from 'node:test';
import assert from 'node:assert/strict';
import { base64, listenExpired, noticeOutcome, SpeechGate, toPcm16 } from '../../client/src/master/voice-sound.js';

/** Feeds the gate a loudness for a while, 10 ms a frame (about what an audio worklet gives), and returns its events. */
function feed(gate: SpeechGate, rms: number, ms: number, from: number): { events: Array<{ at: number; event: string }>; end: number } {
  const events: Array<{ at: number; event: string }> = [];
  for (let at = from; at < from + ms; at += 10) { const event = gate.update(rms, at); if (event) events.push({ at, event }); }
  return { events, end: from + ms };
}

test('speech starts after it holds above the room for a moment and ends after the owner\'s pause; steady noise becomes the room', () => {
  const gate = new SpeechGate(1_000);
  const quiet = feed(gate, 0.002, 1_000, 0);
  assert.deepEqual(quiet.events, []);
  const talk = feed(gate, 0.05, 1_000, quiet.end);
  assert.equal(talk.events[0]?.event, 'speech-start');
  assert.ok(talk.events[0].at - quiet.end >= 280 && talk.events[0].at - quiet.end <= 400, 'a short sound is not speech');
  assert.ok(gate.isSpeaking);
  const pause = feed(gate, 0.002, 1_500, talk.end);
  assert.equal(pause.events[0]?.event, 'silence-commit');
  assert.ok(pause.events[0].at - talk.end >= 1_000 && pause.events[0].at - talk.end <= 1_300);
  // A blip shorter than the onset is nothing.
  assert.deepEqual(feed(gate, 0.05, 150, pause.end).events, []);
  // A fan that comes on and stays is taken as the room within seconds, not as someone talking forever.
  const fan = new SpeechGate(1_000);
  feed(fan, 0.002, 500, 0);
  fan.reset();
  const hum = feed(fan, 0.02, 10_000, 500);
  assert.ok(hum.events.every(item => item.event !== 'speech-start'), 'reset takes the level it hears as the room');
  assert.equal(new SpeechGate(600).silenceMs, 600);
});

test('listening ends after its minutes, a notice is judged with its moment to object, and PCM goes out as ElevenLabs wants it', () => {
  assert.equal(listenExpired(0, 5, 299_999), false);
  assert.equal(listenExpired(0, 5, 300_000), true);
  const notice = { startedAt: 1_000, now: 5_000, windowMs: 2_000 };
  assert.equal(noticeOutcome({ ...notice, endedAt: 2_500 }), 'played');
  assert.equal(noticeOutcome({ ...notice, endedAt: 4_000 }), undefined, 'still inside the moment to object');
  assert.equal(noticeOutcome({ ...notice, endedAt: 2_500, spokeAt: 3_000 }), 'interrupted');
  assert.equal(noticeOutcome({ ...notice, cancelled: true }), 'interrupted');
  assert.equal(noticeOutcome({ ...notice, failed: true }), 'failed');
  const pcm = toPcm16(new Float32Array([0, 0.5, -0.5, 1, -1, 2]), 16_000);
  assert.deepEqual([...pcm], [0, 16383, -16384, 32767, -32768, 32767]);
  assert.equal(toPcm16(new Float32Array(48_000), 48_000).length, 16_000, 'resampled to 16 kHz');
  assert.equal(base64(new Uint8Array([104, 105])), 'aGk=');
});
