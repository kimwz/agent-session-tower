import test from 'node:test';
import assert from 'node:assert/strict';
import { DecisionError, type DecisionEngine } from '../../server/decisions/engine.js';
import { VoiceTurnEnd } from '../../server/master/voice-turn-end.js';
import type { DecisionRecord } from '../../shared/decisions.js';

/** Answers "finished" with the probability given (or fails), and remembers what it was shown. */
function harness(options: { finished?: number | Error; off?: boolean; known?: boolean } = {}) {
  const states: Array<{ said_so_far: string; pause_seconds: number }> = [];
  const questions: unknown[] = [];
  const engine: DecisionEngine = { provider: 'jev', label: 'Jev', decide: async request => {
    states.push(request.state as { said_so_far: string; pause_seconds: number });
    questions.push(request.questions);
    if (options.finished instanceof Error) throw options.finished;
    return { finished: { yes: options.finished ?? 0.9 } } as never;
  } };
  const records: Array<Omit<DecisionRecord, 'at'>> = [];
  let clock = 1_000_000;
  const turnEnd = new VoiceTurnEnd({ engine: () => options.off ? undefined : engine, known: async session => (options.known ?? true) && session === 'live', record: entry => { records.push(entry); }, now: () => clock });
  return { turnEnd, states, questions, records, advance: (ms: number) => { clock += ms; } };
}

test('a pause is judged with what was said so far and how long the pause is; the answer is the chance the owner is finished', async () => {
  const h = harness({ finished: 0.12 });
  assert.deepEqual(await h.turnEnd.judge({ session: 'live', text: '이 세션 로그 확인하고', pauseMs: 1_040 }), { finished: 0.12 });
  assert.deepEqual(h.states.map(state => [state.said_so_far, state.pause_seconds]), [['이 세션 로그 확인하고', 1]]);
  assert.match(JSON.stringify(h.questions[0]), /yesNo/);
  assert.deepEqual(h.records.map(record => [record.feature, record.result, record.probabilities.finished]), [['voiceTurnEnd', 'listening', 0.12]]);
  const done = harness({ finished: 0.93 });
  await done.turnEnd.judge({ session: 'live', text: '배포해 줘', pauseMs: 1_000 });
  assert.equal(done.records[0].result, 'finished');
});

test('the same words at about the same pause are answered from memory; a longer pause is asked again', async () => {
  const h = harness();
  await h.turnEnd.judge({ session: 'live', text: '그러니까', pauseMs: 1_000 });
  await h.turnEnd.judge({ session: 'live', text: '그러니까 ', pauseMs: 1_200 });
  assert.equal(h.states.length, 1);
  await h.turnEnd.judge({ session: 'live', text: '그러니까', pauseMs: 3_000 });
  assert.equal(h.states.length, 2);
});

test('no judgment, and the page decides itself: feature off, another session, nothing said, too many in a minute, or the service failing', async () => {
  assert.deepEqual(await harness({ off: true }).turnEnd.judge({ session: 'live', text: '배포해 줘', pauseMs: 1_000 }), { unavailable: true });
  const other = harness();
  assert.deepEqual(await other.turnEnd.judge({ session: 'old', text: '배포해 줘', pauseMs: 1_000 }), { unavailable: true });
  assert.equal(other.states.length, 0, 'a session that is not the host\'s is not judged');
  assert.deepEqual(await other.turnEnd.judge({ session: 'live', text: '  ', pauseMs: 1_000 }), { unavailable: true });
  assert.deepEqual(await other.turnEnd.judge({ session: 'live', text: 'x'.repeat(4_001), pauseMs: 1_000 }), { unavailable: true });

  const busy = harness();
  for (let index = 0; index < 40; index++) assert.ok((await busy.turnEnd.judge({ session: 'live', text: `요청 ${index}`, pauseMs: 1_000 })).finished !== undefined);
  assert.deepEqual(await busy.turnEnd.judge({ session: 'live', text: '하나 더', pauseMs: 1_000 }), { unavailable: true }, 'at most 40 a minute');
  busy.advance(60_000);
  assert.ok((await busy.turnEnd.judge({ session: 'live', text: '하나 더', pauseMs: 1_000 })).finished !== undefined);

  const failing = harness({ finished: new DecisionError('timeout', 'Jev did not answer in time.') });
  assert.deepEqual(await failing.turnEnd.judge({ session: 'live', text: '배포해 줘', pauseMs: 1_000 }), { unavailable: true });
  assert.deepEqual(failing.records.map(record => [record.result, record.detail]), [['failed', 'Jev did not answer in time.']]);
});
