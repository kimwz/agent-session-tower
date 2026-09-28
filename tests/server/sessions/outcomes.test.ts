import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DecisionEngine } from '../../../server/decisions/engine.js';
import { judgeable, lastTurn, outcomeMark, SessionOutcomes, type SessionOutcomeDependencies } from '../../../server/sessions/outcomes.js';
import type { ChatMessage, Session } from '../../../shared/types.js';
import type { DecisionRecord } from '../../../shared/decisions.js';

const NOW = Date.now();
const session = (id: string, patch: Partial<Session> = {}): Session => ({ id, nativeId: `n-${id}`, provider: 'claude', title: `Title ${id}`, cwd: '/work/app', project: 'app',
  status: 'completed', statusReason: '', createdAt: new Date(NOW - 60_000).toISOString(), updatedAt: new Date(NOW - 1_000).toISOString(), lastMessage: 'Deployed.', messageCount: 4,
  isSubagent: false, resumable: true, ...patch });
const message = (role: ChatMessage['role'], text: string, toolName?: string): ChatMessage => ({ id: `${role}-${text}`, role, text, timestamp: new Date(NOW).toISOString(), ...(toolName ? { toolName } : {}) });
const answering = (choice: string, calls: unknown[] = []): DecisionEngine => ({ provider: 'jev', label: 'Jev', decide: async request => {
  calls.push(request.state);
  return { turn_end: { choice, confidence: 0.9, probabilities: { finished: 0, asks_owner: 0, failed: 0, continuing: 0, [choice]: 0.95 } } } as never;
} });

async function setup(t: test.TestContext, patch: Partial<SessionOutcomeDependencies> & { list?: Session[] } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-outcomes-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const records: Array<Omit<DecisionRecord, 'at'>> = [];
  let changes = 0;
  const list = patch.list ?? [session('a')];
  const outcomes = new SessionOutcomes({ stateDir, engine: () => answering('finished'), sessions: () => list,
    history: async () => [message('user', 'Deploy it'), message('tool', '', 'Bash'), message('assistant', 'Deployed 1.2.0.')],
    project: item => item.project, title: item => item.title, record: entry => records.push(entry), onChange: () => changes++, settleMs: 1, ...patch });
  t.after(() => outcomes.close());
  const settled = async () => { for (let i = 0; i < 50 && !changes; i++) await new Promise(resolve => setTimeout(resolve, 5)); await new Promise(resolve => setTimeout(resolve, 20)); };
  return { stateDir, outcomes, records, list, settled, changes: () => changes };
}

test('only a finished conversation the canvas shows as its own card is judged', () => {
  assert.equal(judgeable(session('a'), NOW), true);
  for (const patch of [{ status: 'working' }, { closed: true }, { isSubagent: true }, { launchedByAgent: true }, { launchedBy: { kind: 'trigger', triggerId: 't' } },
    { scheduledAt: new Date(NOW + 60_000).toISOString() }, { updatedAt: new Date(NOW - 4 * 86_400_000).toISOString() }] as Partial<Session>[]) {
    assert.equal(judgeable(session('a', patch), NOW), false, JSON.stringify(patch));
  }
});

test('the last turn is the last owner message and what the agent wrote after it', () => {
  assert.deepEqual(lastTurn([message('user', 'Old'), message('assistant', 'Old answer'), message('user', 'Deploy'), message('tool', '', 'Bash'), message('assistant', 'Done.')]),
    { request: 'Deploy', output: '[Bash]\n\nDone.' });
  assert.deepEqual(lastTurn([message('assistant', 'Hello')]), { request: '', output: 'Hello' });
});

test('a judged outcome shows only while the turn it read is still the last one and the feature is on', async t => {
  let engine: DecisionEngine | undefined = answering('asks_owner');
  const { outcomes, records, list, settled } = await setup(t, { engine: () => engine });
  await outcomes.start();
  await settled();
  assert.equal(outcomes.apply(list[0]).outcome, 'needsOwner');
  assert.equal(records[0].feature, 'sessionOutcomes');
  assert.equal(records[0].result, 'labeled');
  assert.equal(outcomes.apply({ ...list[0], messageCount: 5, lastMessage: 'Next' }).outcome, undefined, 'a newer turn is not judged yet');
  assert.equal(outcomes.apply({ ...list[0], status: 'working' }).outcome, undefined);
  engine = undefined;
  assert.equal(outcomes.apply(list[0]).outcome, undefined, 'turned off: nothing shows');
});

test('a broken-off conversation is known without asking, and each turn is judged once and remembered', async t => {
  const calls: unknown[] = [];
  const list = [session('a', { status: 'error' }), session('b', { messageCount: 2 })];
  const history = async (item: Session) => item.id === 'b' ? [message('user', 'Fix it')] : [message('user', 'Deploy'), message('assistant', 'Done')];
  const first = await setup(t, { list, history, engine: () => answering('finished', calls) });
  await first.outcomes.start();
  await first.settled();
  assert.equal(first.outcomes.apply(list[0]).outcome, 'blocked', 'the process ended in an error');
  assert.equal(first.outcomes.apply(list[1]).outcome, 'blocked', 'the owner\'s message got no answer');
  assert.equal(calls.length, 0);
  await first.outcomes.close();
  assert.ok(JSON.parse(await readFile(join(first.stateDir, 'session-outcomes.json'), 'utf8')).a.mark === outcomeMark(list[0]));
  const again = new SessionOutcomes({ stateDir: first.stateDir, engine: () => answering('finished', calls), sessions: () => list, history, project: () => '', title: () => '', record() {}, onChange() {}, settleMs: 1 });
  t.after(() => again.close());
  await again.start();
  assert.equal(again.apply(list[0]).outcome, 'blocked', 'remembered across a restart');
});

test('a failed judgment is recorded, shows nothing and is not retried at once', async t => {
  let calls = 0;
  const failing: DecisionEngine = { provider: 'jev', label: 'Jev', decide: async () => { calls++; throw new Error('unavailable'); } };
  const { outcomes, records, list } = await setup(t, { engine: () => failing });
  await outcomes.start();
  for (let i = 0; i < 50 && !records.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  outcomes.changed();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, 1);
  assert.equal(records[0].result, 'failed');
  assert.equal(outcomes.apply(list[0]).outcome, undefined);
});

test('the owner can mark a turn that needs them as done; the mark is kept and a new turn is judged again', async t => {
  const { outcomes, list, settled, stateDir } = await setup(t, { engine: () => answering('asks_owner') });
  await outcomes.start();
  await settled();
  assert.equal(outcomes.apply(list[0]).outcome, 'needsOwner');
  assert.equal(outcomes.acknowledge({ ...list[0], messageCount: 5, lastMessage: 'Next' }), false, 'a turn that was not judged is left alone');
  assert.equal(outcomes.acknowledge(list[0]), true);
  assert.equal(outcomes.apply(list[0]).outcome, 'done');
  assert.equal(outcomes.acknowledge(list[0]), false, 'already done');
  await outcomes.close();
  const saved = JSON.parse(await readFile(join(stateDir, 'session-outcomes.json'), 'utf8'));
  assert.equal(saved.a.outcome, 'done');
});
