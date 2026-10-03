import test from 'node:test';
import assert from 'node:assert/strict';
import type { DecisionEngine } from '../../../server/decisions/engine.js';
import { INSERT_NOW, insertIfItBelongs, judgeSteerTiming, type InsertDependencies } from '../../../server/runs/steer-timing.js';
import type { DecisionRecord } from '../../../shared/decisions.js';
import type { Run } from '../../../shared/types.js';

const at = (seconds: number) => new Date(Date.parse('2026-09-27T00:00:00Z') + seconds * 1000).toISOString();
const running: Run = { id: 'turn', sessionId: 's1', origin: { kind: 'owner' }, prompt: 'Fix the payment button contrast', status: 'running', createdAt: at(0), startedAt: at(1), output: '[Bash]\nRaising the contrast in PaymentButton.tsx now.' };
const queued = (fields: Partial<Run> = {}): Run => ({ id: 'message', sessionId: 's1', origin: { kind: 'owner' }, prompt: 'Also match the hover state', status: 'queued', createdAt: at(5), output: '', ...fields });
/** Answers "now" with the probability given, and remembers what it was shown. */
function engine(now: number | Error) {
  const states: Array<Record<string, string>> = [];
  const value: DecisionEngine = { provider: 'jev', label: 'Jev', decide: async request => {
    states.push(request.state as Record<string, string>);
    if (now instanceof Error) throw now;
    return { timing: { choice: now >= 0.5 ? 'now' : 'after', confidence: 0.9, probabilities: { now, after: 1 - now } } } as never;
  } };
  return { value, states };
}
function harness(options: { now?: number | Error; runs?: Run[] | (() => Run[]); steer?: (id: string, target: string) => Promise<Run>; off?: boolean; oldWorker?: boolean } = {}) {
  const judge = engine(options.now ?? 0.9);
  const steered: string[] = [];
  const records: Array<Omit<DecisionRecord, 'at'>> = [];
  const claimed = new Set<string>();
  let clock = Date.parse(at(6));
  const list = options.runs;
  const dependencies: InsertDependencies = { engine: () => options.off ? undefined : judge.value, canTarget: () => !options.oldWorker, runs: () => typeof list === 'function' ? list() : list ?? [running],
    steer: options.steer ?? (async (id, target) => { steered.push(`${id}→${target}`); return { ...queued(), status: 'running', steering: { targetRunId: target, state: 'delivered', requestedAt: at(6) } }; }),
    record: entry => { records.push(entry); }, claim: id => !claimed.has(id) && Boolean(claimed.add(id)),
    now: () => clock, wait: async ms => { clock += ms; } };
  return { dependencies, steered, records, states: judge.states };
}

test('a message that belongs to the running work is inserted into it, and a separate request waits for the work to end', async () => {
  const belongs = harness({ now: 0.97 });
  assert.equal(await insertIfItBelongs(belongs.dependencies, queued()), 'inserted');
  assert.deepEqual(belongs.steered, ['message→turn'], 'into the turn it was judged against');
  assert.deepEqual(belongs.records.map(record => [record.feature, record.result, record.probabilities]), [['steerTiming', 'inserted', { now: 0.97, after: 0.030000000000000027 }]]);
  const separate = harness({ now: 0.43 });
  assert.equal(await insertIfItBelongs(separate.dependencies, queued({ prompt: 'Unrelated: check the other repo' })), 'waiting');
  assert.deepEqual(separate.steered, []);
  assert.equal(separate.records[0].result, 'waiting');
});

test('only a message this sure it belongs is inserted; anything less waits, as without a judgment', async () => {
  assert.equal(INSERT_NOW, 0.6);
  assert.equal(await insertIfItBelongs(harness({ now: INSERT_NOW }).dependencies, queued()), 'inserted');
  assert.equal(await insertIfItBelongs(harness({ now: 0.59 }).dependencies, queued()), 'waiting');
});

test('a failed judgment or a refused insert leaves the message waiting, and says why', async () => {
  const failed = harness({ now: new Error('Jev is unavailable') });
  assert.equal(await insertIfItBelongs(failed.dependencies, queued()), 'waiting');
  assert.deepEqual(failed.steered, []);
  assert.equal(failed.records[0].result, 'failed');
  const refused = harness({ now: 0.95, steer: async () => { throw Object.assign(new Error('The active turn changed before delivery.'), { statusCode: 409, disposition: 'rejected' }); } });
  assert.equal(await insertIfItBelongs(refused.dependencies, queued()), 'waiting');
  assert.deepEqual([refused.records[0].result, refused.records[0].detail], ['waiting', 'The active turn changed before delivery.']);
});

test('a delivery that could not be confirmed is reported as such and never sent again', async () => {
  let calls = 0;
  const unsure = harness({ now: 0.95, steer: async () => { calls++; throw Object.assign(new Error('Runner response timed out.'), { disposition: 'uncertain' }); } });
  assert.equal(await insertIfItBelongs(unsure.dependencies, queued()), 'uncertain');
  assert.equal(calls, 1);
  assert.equal(unsure.records[0].result, 'failed');
  assert.match(unsure.records[0].detail ?? '', /could not be confirmed/);
});

test('when another request is already inserting the message, how that insert ends is what is recorded', async () => {
  const sending = (target: string): Run => ({ ...queued(), status: 'running', steering: { targetRunId: target, state: 'sending', requestedAt: at(6) } });
  let polls = 0;
  const delivered = harness({ now: 0.95, steer: async (_id, target) => sending(target),
    runs: () => (polls++ < 2 ? [running] : [running, { ...queued(), status: 'running', steering: { targetRunId: 'turn', state: 'delivered', requestedAt: at(6) } }]) });
  assert.equal(await insertIfItBelongs(delivered.dependencies, queued()), 'inserted');
  assert.equal(delivered.records[0].result, 'inserted');
  const lost = harness({ now: 0.95, steer: async (_id, target) => sending(target), runs: () => [running, { ...queued(), status: 'error', steering: { targetRunId: 'turn', state: 'uncertain', requestedAt: at(6) } }] });
  assert.equal(await insertIfItBelongs(lost.dependencies, queued()), 'uncertain');
  assert.equal(lost.records[0].result, 'failed');
  const already = harness({ now: 0.95, steer: async (_id, target) => ({ ...sending(target), status: 'error', steering: { targetRunId: target, state: 'uncertain', requestedAt: at(6) } }) });
  assert.equal(await insertIfItBelongs(already.dependencies, queued()), 'uncertain', 'an earlier uncertain insert is never counted as done');
  const stuck = harness({ now: 0.95, steer: async (_id, target) => sending(target), runs: () => [running] });
  assert.equal(await insertIfItBelongs(stuck.dependencies, queued()), 'uncertain');
  assert.match(stuck.records[0].detail ?? '', /not confirmed in time/);
});

test("a message this computer sent to a joined computer's conversation is judged here, and no other controller's", async () => {
  const mine = queued({ origin: { kind: 'owner', controllerId: 'this-mac' } });
  const sent = harness({ now: 0.95 });
  sent.dependencies.sentBy = 'this-mac';
  assert.equal(await insertIfItBelongs(sent.dependencies, mine), 'inserted');
  assert.deepEqual(sent.steered, ['message→turn']);
  const other = harness({ now: 0.95 });
  other.dependencies.sentBy = 'this-mac';
  assert.equal(await insertIfItBelongs(other.dependencies, queued({ origin: { kind: 'owner', controllerId: 'another-controller' } })), 'skipped');
  assert.equal(await insertIfItBelongs(other.dependencies, queued({ id: 'local' })), 'skipped', 'a message typed on that computer itself is judged there');
  // The joined computer never judges what its controllers send it.
  assert.equal(await insertIfItBelongs(harness({ now: 0.95 }).dependencies, mine), 'skipped');
});

test('a message is judged once, and only when it was accepted just now, so a retried request never lands in a later turn', async () => {
  const once = harness({ now: 0.95 });
  assert.equal(await insertIfItBelongs(once.dependencies, queued()), 'inserted');
  assert.equal(await insertIfItBelongs(once.dependencies, queued()), 'skipped');
  assert.equal(once.states.length, 1);
  const stale = harness({ now: 0.95 });
  assert.equal(await insertIfItBelongs(stale.dependencies, queued({ createdAt: at(-60) })), 'skipped');
  assert.deepEqual(stale.states, []);
});

test('nothing is judged without the feature, a running turn, or an owner message that could join it', async () => {
  const cases: Array<[string, Parameters<typeof harness>[0], Run]> = [
    ['feature off', { off: true }, queued()],
    ['no running turn', { runs: [] }, queued()],
    ['turn in another conversation', { runs: [{ ...running, sessionId: 's2' }] }, queued()],
    ['turn only waiting for background work, which takes the message itself', { runs: [{ ...running, backgroundWait: { since: at(3), tasks: 1 } }] }, queued()],
    ['not queued', {}, queued({ status: 'running' })],
    ['not the owner', {}, queued({ origin: { kind: 'agent', runId: 'r' } })],
    ['sent from a controlling computer, which may retry it', {}, queued({ origin: { kind: 'owner', controllerId: 'a'.repeat(32) } })],
    ['a scheduled continuation', {}, queued({ scheduled: { at: at(60), afterRunId: 'turn' } })],
    ['a worker that cannot insert into one chosen turn', { oldWorker: true }, queued()],
    ['a message the worker says cannot join the turn (another model or effort)', { runs: [running, queued({ canSteer: false, model: 'other-model' })] }, queued({ model: 'other-model' })],
  ];
  for (const [name, options, message] of cases) {
    const { dependencies, steered, states } = harness(options);
    assert.equal(await insertIfItBelongs(dependencies, message), 'skipped', name);
    assert.deepEqual([steered, states], [[], []], name);
  }
});

test('the judgment sees the running request, the end of its progress without tool marks, and the new message', async () => {
  const { value, states } = engine(0.9);
  await judgeSteerTiming(value, { currentRequest: 'r'.repeat(3000), currentOutput: `${'x'.repeat(3000)}[Bash]\nNow testing.`, message: 'Also match the hover state' });
  assert.ok(states[0].current_request.length <= 2000);
  assert.ok(states[0].agent_progress_so_far.length <= 1500);
  assert.match(states[0].agent_progress_so_far, /Now testing\.$/);
  assert.doesNotMatch(states[0].agent_progress_so_far, /\[Bash\]/);
  assert.equal(states[0].new_message, 'Also match the hover state');
});

test('a message that keeps the chat model and effort choice is still judged when it can join the turn', async () => {
  const same = harness({ now: 0.9, runs: [{ ...running, model: 'model-a', effort: 'high' }, queued({ canSteer: true, model: 'model-a', effort: 'high' })] });
  assert.equal(await insertIfItBelongs(same.dependencies, queued({ model: 'model-a', effort: 'high' })), 'inserted');
});

test('an exception from record escapes insertIfItBelongs', async () => {
  const { dependencies } = harness({ now: 0.97 });
  await assert.rejects(insertIfItBelongs({ ...dependencies, record: () => { throw new Error('the decision log is full'); } }, queued()), /decision log is full/);
});
