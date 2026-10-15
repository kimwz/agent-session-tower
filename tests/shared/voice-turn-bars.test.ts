import test from 'node:test';
import assert from 'node:assert/strict';
import { VOICE_TURN_BARS, voiceTurnBar, voiceTurnStep } from '../../shared/decisions.js';

test('the bar for sending a spoken request falls with the silence, in rows, and never below its floor', () => {
  assert.deepEqual([0, 2_999, 3_000, 5_999, 6_000, 20_000, 600_000].map(voiceTurnBar), [0.6, 0.6, 0.5, 0.5, 0.4, 0.4, 0.4]);
  assert.deepEqual([0, 2_999, 3_000, 6_000, 60_000].map(voiceTurnStep), [0, 0, 1, 2, 2]);
  for (let row = 1; row < VOICE_TURN_BARS.length; row++) {
    assert.ok(VOICE_TURN_BARS[row].fromMs > VOICE_TURN_BARS[row - 1].fromMs);
    assert.ok(VOICE_TURN_BARS[row].finished < VOICE_TURN_BARS[row - 1].finished);
  }
  // Jev's answers for speech left on a filler, joining word or stutter stayed at 0.31 or under at a six-second pause.
  assert.ok(VOICE_TURN_BARS.at(-1)!.finished >= 0.4);
});
