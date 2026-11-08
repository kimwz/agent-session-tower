import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCodexStdioRun, type CodexStdioOptions, type CodexStdioResult } from '../../../server/runs/codex-stdio.js';
import { goalResumption } from '../../../server/runs/codex-turn.js';
import { until } from '../../helpers/until.ts';

const ID = '10000000-0000-4000-8000-000000000001';
/** One native turn: whether it did work, the goal Codex reports before it ends, how it ends, and whether Codex starts the next. */
interface Turn { work?: boolean; goal?: string | null; status?: string; next?: boolean; hold?: boolean }

/** Plays turns as Codex does (measured on 0.167): goal update, `turn/completed`, then at once the next `turn/started`. */
const PROVIDER = `
import readline from 'node:readline';
const turns = JSON.parse(process.env.TURNS); const resumed = process.env.RESUMED_GOAL;
const threadId = '${ID}';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const notice = (method, params) => send({ method, params: { threadId, ...params } });
let index = -1; let goal = resumed === 'none' ? undefined : resumed;
const play = () => {
  index++;
  const turn = turns[Math.min(index, turns.length - 1)]; const turnId = 't' + index;
  if (turn.work) notice('item/started', { turnId, item: { id: 'c' + index, type: 'commandExecution', command: 'x' } });
  notice('item/completed', { turnId, item: { id: 'm' + index, type: 'agentMessage', text: 'reply ' + index } });
  if (turn.hold) return;
  if (turn.goal !== undefined) { if (turn.goal) notice('thread/goal/updated', { turnId, goal: { status: turn.goal } }); else notice('thread/goal/cleared', {}); }
  notice('turn/completed', { turn: { id: turnId, status: turn.status || 'completed', completedAt: 1789516801 + index, items: [] } });
  if (turn.next) { notice('turn/started', { turn: { id: 't' + (index + 1), status: 'inProgress', startedAt: 1789516900, items: [] } }); play(); }
};
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line); const reply = result => send({ id: request.id, result });
  if (request.method === 'initialize') return reply({});
  if (request.method === 'thread/resume') { reply({ thread: { id: threadId, status: { type: 'idle' } }, approvalPolicy: 'on-request' }); if (goal) notice('thread/goal/updated', { turnId: null, goal: { status: goal } }); return; }
  if (request.method === 'turn/start') { reply({ turn: { id: 't0', status: 'inProgress', startedAt: 1789516800, items: [] } }); index = -1; setTimeout(play, Number(process.env.START_DELAY || 0)); return; }
  if (request.method === 'thread/goal/get') return reply({ goal: goal ? { status: goal } : null });
  if (request.method === 'thread/goal/set') { goal = request.params.status; reply({ goal: { status: goal } }); notice('thread/goal/updated', { turnId: null, goal: { status: goal } }); return; }
  if (request.method === 'turn/steer') return reply({ turnId: request.params.expectedTurnId });
  if (request.method === 'turn/interrupt') { reply({}); setTimeout(() => notice('turn/completed', { turn: { id: request.params.turnId, status: 'interrupted', items: [] } }), 10); }
});
`;

async function fixture(t: TestContext, turns: Turn[], overrides: Partial<CodexStdioOptions> & { resumedGoal?: string; startDelay?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-codex-goal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'provider.mjs');
  await writeFile(script, PROVIDER);
  const sent: Array<{ method?: string; params?: Record<string, unknown> }> = [], output: string[] = [], finished: CodexStdioResult[] = [];
  const { resumedGoal, startDelay, ...options } = overrides;
  const run = await openCodexStdioRun({ executable: '/fixture/codex', cwd: directory, threadId: ID, prompt: 'go', continueGoal: () => true, goalFollowMs: 40,
    env: { ...process.env, TURNS: JSON.stringify(turns), RESUMED_GOAL: resumedGoal ?? 'none', START_DELAY: String(startDelay ?? 0) },
    spawnProcess(_executable, args, spawned) {
      const child = spawn(process.execPath, [script, ...args], spawned);
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = ((chunk: string, ...rest: never[]) => { sent.push(JSON.parse(String(chunk))); return write(chunk, ...rest); }) as typeof child.stdin.write;
      return child;
    },
    onSession() {}, onOutput(text) { output.push(text); }, onApproval() {}, onFinished(result) { finished.push(result); }, ...options });
  t.after(() => run.close());
  await run.start();
  return { run, sent, output, finished, text: () => output.join('') };
}
const ended = async (f: Awaited<ReturnType<typeof fixture>>) => { await until(() => f.finished.length === 1); return f.finished[0]; };

test('a run follows every turn Codex starts for an active goal and ends when the goal is complete', async t => {
  const f = await fixture(t, [{ work: true, goal: 'active', next: true }, { work: true, goal: 'active', next: true }, { work: true, goal: 'complete' }]);
  assert.equal((await ended(f)).status, 'completed');
  assert.match(f.text(), /reply 0/); assert.match(f.text(), /reply 2/);
});
test('without an active goal the first finished turn ends the run, as it did', async t => {
  for (const goal of [undefined, 'blocked', 'paused', 'usageLimited', 'budgetLimited', 'complete', null]) {
    const f = await fixture(t, [{ work: true, goal, next: true }, { work: true, goal: 'active' }]);
    await ended(f);
    assert.equal(f.text().includes('reply 1'), false, String(goal));
  }
});
test('the goal reported on resume alone is enough, and a goal the agent marks blocked ends the run at that turn', async t => {
  const resumed = await fixture(t, [{ work: true, next: true }, { work: true, goal: 'blocked' }], { resumedGoal: 'active' });
  await ended(resumed); assert.match(resumed.text(), /reply 1/);
  const blocked = await fixture(t, [{ work: true, goal: 'blocked', next: true }, { work: true }], { resumedGoal: 'active' });
  await ended(blocked); assert.equal(blocked.text().includes('reply 1'), false);
});
test('no next turn within the wait ends the run as completed', async t => {
  const f = await fixture(t, [{ work: true, goal: 'active' }]);
  assert.equal((await ended(f)).status, 'completed');
});
test('a failed or interrupted continuation ends the run with that outcome', async t => {
  const failed = await fixture(t, [{ work: true, goal: 'active', next: true }, { work: true, goal: 'active', status: 'failed' }]);
  assert.equal((await ended(failed)).status, 'error');
  const interrupted = await fixture(t, [{ work: true, goal: 'active', next: true }, { goal: 'active', status: 'interrupted' }]);
  assert.equal((await ended(interrupted)).status, 'cancelled');
});
test('turns that only talk end the run after three in a row; work in between resets the count', async t => {
  const idle = await fixture(t, [{ goal: 'active', next: true }]);
  await ended(idle);
  assert.match(idle.text(), /reply 2/); assert.equal(idle.text().includes('reply 3'), false); assert.match(idle.text(), /3 turns in a row/);
  const mixed = await fixture(t, [{ goal: 'active', next: true }, { goal: 'active', next: true }, { work: true, goal: 'active', next: true }, { goal: 'active', next: true }, { goal: 'active', next: true }, { goal: 'complete' }]);
  await ended(mixed);
  assert.match(mixed.text(), /reply 5/); assert.equal(mixed.text().includes('in a row'), false);
});
test('a run ends at the turn cap however much work goes on', async t => {
  const f = await fixture(t, [{ work: true, goal: 'active', next: true }]);
  await ended(f);
  assert.match(f.text(), /reply 99/); assert.equal(f.text().includes('reply 100'), false); assert.match(f.text(), /100 turns/);
});
test('update drain or a stopping worker ends following at the turn end', async t => {
  const f = await fixture(t, [{ work: true, goal: 'active', next: true }, { work: true, goal: 'active' }], { continueGoal: () => false });
  await ended(f); assert.equal(f.text().includes('reply 1'), false);
  const absent = await fixture(t, [{ work: true, goal: 'active', next: true }, { work: true, goal: 'active' }], { continueGoal: undefined });
  await ended(absent); assert.equal(absent.text().includes('reply 1'), false);
});
test('steering and cancelling reach the continuation turn; between turns steering waits and cancel ends the run', async t => {
  const f = await fixture(t, [{ work: true, goal: 'active', next: true }, { work: true, hold: true }]);
  await until(() => f.text().includes('reply 1'));
  await f.run.steer!({ id: 'u', text: 'more' } as never);
  assert.equal(f.sent.find(frame => frame.method === 'turn/steer')?.params?.expectedTurnId, 't1');
  await f.run.cancel();
  assert.equal(f.sent.find(frame => frame.method === 'turn/interrupt')?.params?.turnId, 't1');
  assert.equal((await ended(f)).status, 'cancelled');
  const between = await fixture(t, [{ work: true, goal: 'active' }], { goalFollowMs: 60_000 });
  await until(() => between.text().includes('reply 0'));
  await until(() => !between.run.canSteer!());
  await between.run.cancel();
  assert.equal((await ended(between)).status, 'cancelled');
  assert.equal(between.sent.some(frame => frame.method === 'turn/interrupt'), false);
});
test('/goal resume lifts a blocked or paused goal inside the submitted turn and nothing else', async t => {
  for (const goal of ['blocked', 'paused']) {
    const f = await fixture(t, [{ work: true, goal: 'active', next: true }, { work: true, goal: 'complete' }], { resumedGoal: goal, resumeGoal: true, startDelay: 30 });
    await ended(f);
    const start = f.sent.findIndex(frame => frame.method === 'turn/start'), set = f.sent.findIndex(frame => frame.method === 'thread/goal/set');
    assert.ok(start >= 0 && set > start); assert.equal(f.sent[set].params?.status, 'active');
  }
  for (const [goal, seen] of [['complete', /it is complete/], ['none', /No goal to resume/]] as const) {
    const f = await fixture(t, [{ work: true }], { resumedGoal: goal, resumeGoal: true, startDelay: 30 });
    await until(() => f.text().includes('reply 0') && f.finished.length === 1);
    assert.equal(f.sent.some(frame => frame.method === 'thread/goal/set'), false); assert.match(f.text(), seen);
  }
  const plain = await fixture(t, [{ work: true }], { resumedGoal: 'blocked' });
  await ended(plain); assert.equal(plain.sent.some(frame => String(frame.method).startsWith('thread/goal')), false);
});
test('only a first line of exactly /goal resume asks for it', () => {
  assert.deepEqual(goalResumption('/goal resume'), { prompt: 'Continue the goal.' });
  assert.deepEqual(goalResumption('/goal resume  \nFinish it'), { prompt: 'Finish it' });
  for (const text of ['please /goal resume', '/goal resumes', '/goal 게임 완료', ' /goal resume']) assert.equal(goalResumption(text), undefined, text);
});
