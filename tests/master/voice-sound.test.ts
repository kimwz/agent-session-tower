import test from 'node:test';
import assert from 'node:assert/strict';
import { base64, endHoldMs, END_HOLD_MS, fitUtterance, joinSegments, listenExpired, noticeOutcome, SpeechGate, toPcm16, UTTERANCE_BYTES } from '../../client/src/master/voice-sound.js';

/** Feeds the gate a loudness for a while, 10 ms a frame (or `step`: a worklet's 128 samples at 48 kHz are 2.67 ms), and returns its events. */
function feed(gate: SpeechGate, rms: number, ms: number, from: number, step = 10): { events: Array<{ at: number; event: string }>; end: number } {
  const events: Array<{ at: number; event: string }> = [];
  for (let at = from; at < from + ms; at += step) { const event = gate.update(rms, at); if (event) events.push({ at, event }); }
  return { events, end: from + ms };
}

test('speech starts after it holds above the room for a moment and ends after the owner\'s pause; steady noise becomes the room', () => {
  const gate = new SpeechGate(1_000);
  const quiet = feed(gate, 0.002, 1_000, 0);
  assert.deepEqual(quiet.events, []);
  const talk = feed(gate, 0.05, 1_000, quiet.end);
  assert.equal(talk.events[0]?.event, 'speech-start');
  assert.ok(talk.events[0].at - quiet.end >= 240 && talk.events[0].at - quiet.end <= 360, 'a short sound is not speech');
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
  assert.equal(noticeOutcome({ ...notice, armedAt: 2_500 }), 'played', 'listening off: the moment after is time alone');
  assert.equal(noticeOutcome({ ...notice, armedAt: 2_500, heardMs: 2_000 }), 'played');
  assert.equal(noticeOutcome(notice), undefined, 'the moment after has not begun');
  assert.equal(noticeOutcome({ ...notice, armedAt: 4_000, heardMs: 2_000 }), undefined, 'still inside the moment to object');
  assert.equal(noticeOutcome({ ...notice, armedAt: 2_500, heardMs: 1_990 }), undefined, 'a stalled page has not heard the moment yet');
  assert.equal(noticeOutcome({ ...notice, armedAt: 2_500, heardMs: 2_000, spokeAt: 3_000 }), 'interrupted');
  assert.equal(noticeOutcome({ ...notice, cancelled: true }), 'interrupted');
  assert.equal(noticeOutcome({ ...notice, failed: true }), 'failed');
  const pcm = toPcm16(new Float32Array([0, 0.5, -0.5, 1, -1, 2]), 16_000);
  assert.deepEqual([...pcm], [0, 16383, -16384, 32767, -32768, 32767]);
  assert.equal(toPcm16(new Float32Array(48_000), 48_000).length, 16_000, 'resampled to 16 kHz');
  assert.equal(base64(new Uint8Array([104, 105])), 'aGk=');
  // An utterance never sends more than its three minutes, the silent tail that commits it included.
  assert.equal(UTTERANCE_BYTES, 5_760_000);
  assert.equal(fitUtterance(0, 3_200, 640), 3_200);
  assert.equal(fitUtterance(UTTERANCE_BYTES - 640 - 1_001, 3_200, 640), 1_000, 'whole samples only');
  assert.equal(fitUtterance(UTTERANCE_BYTES - 640, 3_200, 640), 0);
  let sent = 0;
  for (let chunk = 0; chunk < 1_900; chunk++) sent += fitUtterance(sent, 3_200, 640);
  assert.equal(sent + 640, UTTERANCE_BYTES);
});

test('without a judgment, the wait after a pause follows how the sentence ends: short when finished, longest when it trails off', () => {
  for (const text of ['세션 목록 보여 줘', '지금 몇 시예요?', '배포해 주세요.', '그거 해', '네', 'Deploy it.', '확인했습니다']) assert.equal(endHoldMs(text), END_HOLD_MS.finished, text);
  for (const text of ['이거 확인하고', '로그를 보니까', '테스트는 통과했는데', '음', '그리고', '그래서 음', 'check the logs and', 'um', '첫째,', '이건…', '캔버스에서']) assert.equal(endHoldMs(text), END_HOLD_MS.unfinished, text);
  for (const text of ['', '세션 목록', 'the build']) assert.equal(endHoldMs(text), END_HOLD_MS.unclear, text);
  assert.equal(endHoldMs('그리고.'), END_HOLD_MS.unfinished, 'a full stop after a joining word is the writing\'s, not the owner\'s');
});

test('the gate tells when the voice was last heard, and a loud moment too short to be speech yet', () => {
  const gate = new SpeechGate(1_000);
  const quiet = feed(gate, 0.002, 1_000, 0);
  const talk = feed(gate, 0.05, 600, quiet.end);
  assert.ok(gate.isSpeaking && talk.end - gate.lastVoiceAt <= 10);
  const pause = feed(gate, 0.002, 1_500, talk.end);
  assert.equal(pause.events.at(-1)?.event, 'silence-commit');
  const blip = feed(gate, 0.05, 150, pause.end);
  assert.deepEqual(blip.events, []);
  assert.ok(gate.isVoicing, 'loud, not yet speech');
  feed(gate, 0.002, 400, blip.end);
  assert.equal(gate.isVoicing, false);
});

test('speech made of syllables with short gaps between them starts at its first syllable; clicks a while apart never do', () => {
  const gate = new SpeechGate(1_000);
  let at = feed(gate, 0.002, 1_000, 0).end;
  const events: Array<{ at: number; event: string }> = [];
  // "그, 마스터…": 150 ms syllables, 60 ms between them, never 280 ms unbroken.
  const start = at;
  for (let syllable = 0; syllable < 6; syllable++) {
    const loud = feed(gate, 0.05, 150, at, 128 / 48);
    const gap = feed(gate, 0.002, 60, loud.end, 128 / 48);
    events.push(...loud.events, ...gap.events);
    at = gap.end;
  }
  assert.equal(events[0]?.event, 'speech-start');
  assert.ok(events[0].at - start <= 400, `speech starts within the second syllable, not ${events[0].at - start} ms in`);

  const clicks = new SpeechGate(1_000);
  let time = feed(clicks, 0.002, 1_000, 0).end;
  for (const [loud, quiet] of [[30, 250], [30, 120], [20, 100]]) {
    const heard: string[] = [];
    for (let click = 0; click < 20; click++) {
      const key = feed(clicks, 0.05, loud, time, 128 / 48);
      const after = feed(clicks, 0.002, quiet, key.end, 128 / 48);
      heard.push(...key.events.map(item => item.event), ...after.events.map(item => item.event));
      time = after.end;
    }
    assert.deepEqual(heard, [], `keys typed ${loud + quiet} ms apart are not speech`);
    time = feed(clicks, 0.002, 1_000, time, 128 / 48).end;
  }
});

test('the parts of one utterance join into one text, a word cut between two parts once', () => {
  assert.equal(joinSegments(['그리고 미리 녹음해 둔', '', '중간말은 빼 줘.']), '그리고 미리 녹음해 둔 중간말은 빼 줘.', 'an empty (silent) part adds nothing');
  // As ElevenLabs writes a commit that falls mid-word (measured 2026-09-29).
  assert.equal(joinSegments(['그리고 마지막으로-', '-모든 구간이']), '그리고 마지막으로 모든 구간이');
  assert.equal(joinSegments(['열아홉, 스-', '스물, 스물하나']), '열아홉, 스물, 스물하나');
  assert.equal(joinSegments([' 하나 ', '둘']), '하나 둘');
  assert.equal(joinSegments([]), '');
});
