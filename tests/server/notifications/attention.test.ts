import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createECDH, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DecisionEngine } from '../../../server/decisions/engine.js';
import { judgeTurn, type TurnAttention } from '../../../server/notifications/attention.js';
import { followedUp, notificationMessage, NotificationService, pendingEvents, turnRequest, type NotificationContext } from '../../../server/notifications/service.js';
import type { Run, Session } from '../../../shared/types.js';

const at = (seconds: number) => new Date(Date.parse('2026-09-26T00:00:00Z') + seconds * 1000).toISOString();
const run = (id: string, fields: Partial<Run>): Run => ({ id, sessionId: 's1', origin: { kind: 'owner' }, prompt: 'Fix the login bug', status: 'completed', createdAt: at(0), startedAt: at(1), finishedAt: at(10), output: 'Done.', ...fields });
const session: Session = { id: 's1', nativeId: 'n1', provider: 'claude', title: 'Login bug', cwd: '/work/app', project: 'app', status: 'idle', statusReason: '',
  createdAt: at(0), updatedAt: at(0), lastMessage: '', messageCount: 1, isSubagent: false, resumable: true };
const answering = (outcome: string, progress: number, interrupt: number): DecisionEngine => ({ provider: 'jev', label: 'Jev', decide: async () => ({
  outcome: { choice: outcome, confidence: 0.8, probabilities: { done: 0, needs_owner: 0, blocked: 0, progress, [outcome]: outcome === 'progress' ? progress : 0.9 } },
  owner_should_know: { yes: interrupt },
}) as never });

test('a turn is skipped only when it is clearly an intermediate step by both signals', async () => {
  const input = { request: 'Deploy', reply: 'Build started; I will check back in 10 minutes.', conversation: 'Deploy', project: 'app' };
  assert.deepEqual(await judgeTurn(answering('progress', 0.8, 0.2), input), { outcome: 'progress', quiet: true });
  assert.deepEqual(await judgeTurn(answering('progress', 0.8, 0.7), input), { outcome: 'done', quiet: false }, 'the owner should know: announce');
  assert.deepEqual(await judgeTurn(answering('progress', 0.4, 0.1), input), { outcome: 'done', quiet: false }, 'unsure it is progress: announce');
  assert.deepEqual(await judgeTurn(answering('needs_owner', 0.05, 0.9), input), { outcome: 'needsOwner', quiet: false });
  assert.deepEqual(await judgeTurn(answering('blocked', 0.05, 0.9), input), { outcome: 'blocked', quiet: false });
});

test('the judgment sees the request and the end of the output, never more than it needs', async () => {
  let state: Record<string, string> = {};
  const engine: DecisionEngine = { provider: 'jev', label: 'Jev', decide: async request => { state = request.state as Record<string, string>; return answering('done', 0, 1).decide(request); } };
  await judgeTurn(engine, { request: 'r'.repeat(5000), reply: `${'early '.repeat(2000)}FINAL ANSWER`, conversation: 'c', project: 'p' });
  assert.ok(state.owner_request.length <= 2000);
  assert.ok(state.end_of_agent_output.length <= 4000);
  assert.match(state.end_of_agent_output, /FINAL ANSWER$/);
});

test('a turn that another turn of the same conversation continues is a step: a scheduled continuation or a message sent while it ran', () => {
  const turn = run('turn', {});
  const others = (runs: Run[]) => followedUp(turn, [turn, ...runs]);
  assert.equal(others([]), false);
  assert.equal(others([run('wake', { status: 'queued', startedAt: undefined, finishedAt: undefined, createdAt: at(11), scheduled: { at: at(600), afterRunId: 'turn' } })]), true);
  assert.equal(others([run('wake', { status: 'completed', createdAt: at(11), startedAt: at(600), finishedAt: at(700), scheduled: { at: at(600), afterRunId: 'turn' } })]), true, 'still a step after the continuation ended');
  assert.equal(others([run('next', { status: 'queued', createdAt: at(5), startedAt: undefined, finishedAt: undefined })]), true);
  assert.equal(others([run('next', { status: 'completed', createdAt: at(5), startedAt: at(10), finishedAt: at(20) })]), true, 'after a restart it is still known');
  assert.equal(others([run('next', { status: 'cancelled', createdAt: at(5), startedAt: undefined })]), false, 'a cancelled next message continued nothing');
  assert.equal(others([run('later', { status: 'running', createdAt: at(30), startedAt: at(30) })]), true, 'sent after the turn ended: the owner has seen it');
  assert.equal(others([run('later', { status: 'cancelled', createdAt: at(30), startedAt: undefined })]), true, 'even when that message was then cancelled');
  assert.equal(others([run('earlier', { createdAt: at(0), startedAt: at(0), finishedAt: at(1) })]), false, 'a turn that ended before is not a continuation');
  assert.equal(others([run('inserted', { status: 'completed', createdAt: at(5), steering: { targetRunId: 'turn', state: 'delivered', requestedAt: at(5) } })]), false, 'an inserted message is part of the turn');
  assert.equal(others([run('elsewhere', { sessionId: 's2', status: 'queued', createdAt: at(5), startedAt: undefined })]), false);
});

test('a message inserted into a turn is announced with it, and a continuation is judged by the request that started it', () => {
  const turn = run('turn', { prompt: 'Ship the release' });
  const inserted = run('inserted', { prompt: 'Also tag it', steering: { targetRunId: 'turn', state: 'delivered', requestedAt: at(5) } });
  const wake = run('wake', { prompt: 'Continue the work you scheduled with ScheduleWakeup.', createdAt: at(11), scheduled: { at: at(600), afterRunId: 'turn' } });
  assert.deepEqual(pendingEvents([turn, inserted], 0, new Set(), Date.parse(at(20))).map(event => event.key), ['done:turn']);
  assert.equal(turnRequest(turn, [turn, inserted]), 'Ship the release\n\nAlso tag it');
  assert.equal(turnRequest(wake, [turn, inserted, wake]), 'Ship the release\n\nAlso tag it');
});

test('an approval or question a conversation waits on is announced once, whoever started the work', () => {
  const approval = { id: 'a1', toolName: 'Bash', input: {}, description: 'Run npm publish' };
  const question = { id: 'q1', toolName: 'AskUserQuestion', input: {}, interaction: { type: 'questions' as const, questions: [{ id: 'x', header: 'Target', question: 'Which environment?', isOther: false, isSecret: false, options: null }] } };
  const runs = [run('owner', { status: 'running', finishedAt: undefined, approvals: [approval] }), run('trigger', { status: 'running', finishedAt: undefined, origin: { kind: 'trigger', triggerId: 't', eventId: 'e' }, startedAt: at(0), approvals: [question] })];
  const events = pendingEvents(runs, 0, new Set(), Date.parse(at(50)));
  assert.deepEqual(events.map(event => event.key).sort(), ['trigger:t:e', 'wait:owner:a1', 'wait:trigger:q1']);
  assert.deepEqual(pendingEvents(runs, 0, new Set(['wait:owner:a1', 'wait:trigger:q1', 'trigger:t:e'])), []);
  const context: NotificationContext = { runs: () => runs, session: () => session, project: () => 'App', trigger: () => 'Nightly' };
  const byKey = new Map(events.map(event => [event.key, event]));
  assert.deepEqual(notificationMessage(byKey.get('wait:owner:a1')!, context, 'ko'), { title: 'App · 승인 필요', body: 'Login bug\nRun npm publish', url: '/?session=s1', tag: 'session:s1' });
  assert.equal(notificationMessage(byKey.get('wait:trigger:q1')!, context, 'en').title, 'App · Question for you');
  assert.match(notificationMessage(byKey.get('wait:trigger:q1')!, context, 'en').body, /Which environment\?/);
});

const subscription = () => {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  return { endpoint: `https://push.example/${randomBytes(4).toString('hex')}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
};
async function service(t: test.TestContext, runs: () => Run[], attention?: NotificationContext['attention'], now = () => Date.parse(at(20))) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-attention-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sent: string[] = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => { sent.push(String(init?.headers && (init.headers as Record<string, string>).TTL)); return new Response(null, { status: 201 }); }) as typeof fetch;
  const context: NotificationContext = { runs, session: () => session, project: () => 'App', trigger: () => undefined, ...(attention ? { attention } : {}) };
  // A device registered before the work: this first run sees none of it.
  const first = new NotificationService(dir, { ...context, runs: () => [] }, fetcher, () => Date.parse(at(0)));
  await first.start();
  await first.subscribe({ subscription: subscription(), language: 'en' });
  await first.close();
  sent.length = 0;
  const notifications = new NotificationService(dir, context, fetcher, now);
  return { dir, sent, notifications };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

test('a step followed by another turn is not pushed, and a failure always is', async t => {
  const turn = run('turn', {}), failed = run('failed', { sessionId: 's2', status: 'error', error: 'boom' });
  const next = run('next', { status: 'running', createdAt: at(5), startedAt: at(10), finishedAt: undefined });
  const followedByError = run('next2', { sessionId: 's2', status: 'queued', createdAt: at(5), startedAt: undefined, finishedAt: undefined });
  const { sent, notifications, dir } = await service(t, () => [turn, next, failed, followedByError]);
  await notifications.start();
  await settle();
  await notifications.close();
  assert.equal(sent.length, 1, 'only the failure');
  const saved = JSON.parse(await readFile(join(dir, 'notifications.json'), 'utf8'));
  assert.ok(saved.delivered.keys.includes('done:turn'), 'a skipped step is handled for good');
});

test('with fast judgments on, an intermediate turn is not pushed and a failed judgment pushes as before', async t => {
  const turn = run('turn', {});
  for (const [name, attention, expected] of [
    ['quiet', async () => ({ outcome: 'progress', quiet: true }) as TurnAttention, 0],
    ['needs owner', async () => ({ outcome: 'needsOwner', quiet: false }) as TurnAttention, 1],
    ['judgment failed', async () => { throw new Error('down'); }, 1],
    ['judgments off', async () => undefined, 1],
  ] as const) await t.test(name, async t => {
    const { sent, notifications } = await service(t, () => [turn], attention);
    await notifications.start();
    await settle();
    await notifications.close();
    assert.equal(sent.length, expected);
  });
});

test('a message the owner sends while a turn is being judged means they have seen it, so it is not pushed', async t => {
  const turn = run('turn', {});
  let runs = [turn];
  let release!: () => void;
  const attention = () => new Promise<TurnAttention>(resolve => { release = () => resolve({ outcome: 'done', quiet: false }); });
  const { sent, notifications } = await service(t, () => runs, attention);
  await notifications.start();
  await settle();
  runs = [turn, run('next', { status: 'running', createdAt: at(12), startedAt: at(21), finishedAt: undefined })];
  release();
  await settle();
  assert.equal(sent.length, 0);
  await notifications.close();
});

test('a turn still being judged when the web stops is taken up again after a restart', async t => {
  const turn = run('turn', {});
  const { dir, sent, notifications } = await service(t, () => [turn], () => new Promise<TurnAttention>(() => {}));
  await notifications.start();
  await settle();
  await notifications.close();
  assert.equal(sent.length, 0);
  const saved = JSON.parse(await readFile(join(dir, 'notifications.json'), 'utf8'));
  assert.ok(!saved.delivered.keys.includes('done:turn'));
  assert.ok(Date.parse(saved.delivered.since) <= Date.parse(turn.finishedAt!), 'the restart mark stays before it');
  const fetcher = (async () => { sent.push('again'); return new Response(null, { status: 201 }); }) as typeof fetch;
  const restarted = new NotificationService(dir, { runs: () => [turn], session: () => session, project: () => 'App', trigger: () => undefined }, fetcher, () => Date.parse(at(60)));
  await restarted.start();
  await settle();
  await restarted.close();
  assert.deepEqual(sent, ['again']);
});

test('devices saved before approval notifications existed receive them', async t => {
  const approval = { id: 'a1', toolName: 'Bash', input: {} };
  const { dir, sent, notifications } = await service(t, () => [run('owner', { status: 'running', finishedAt: undefined, approvals: [approval] })]);
  const file = join(dir, 'notifications.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  for (const device of saved.devices) delete device.events.runWaiting;
  await (await import('node:fs/promises')).writeFile(file, JSON.stringify(saved));
  await notifications.start();
  assert.equal(notifications.overview().devices[0].events.runWaiting, true);
  await settle();
  await notifications.close();
  assert.equal(sent.length, 1);
});

test('work an agent, a trigger or Slack puts into the conversation does not count as the owner having seen a turn', () => {
  const turn = run('turn', {});
  for (const kind of ['agent', 'trigger', 'slack'] as const) {
    assert.equal(followedUp(turn, [turn, run('other', { origin: { kind }, status: 'running', createdAt: at(30), startedAt: at(30), finishedAt: undefined })]), false, kind);
    assert.equal(followedUp(turn, [turn, run('other', { origin: { kind }, status: 'queued', createdAt: at(5), startedAt: undefined, finishedAt: undefined })]), false, kind);
  }
});

test('a continuation is judged with every message inserted along the way', () => {
  const turn = run('turn', { prompt: 'Ship the release' });
  const inserted = run('inserted', { prompt: 'Also tag it', steering: { targetRunId: 'turn', state: 'delivered', requestedAt: at(5) } });
  const wake = run('wake', { prompt: 'Continue the work you scheduled with ScheduleWakeup.', createdAt: at(11), scheduled: { at: at(600), afterRunId: 'turn' } });
  const later = run('later', { prompt: 'And announce it', steering: { targetRunId: 'wake', state: 'delivered', requestedAt: at(610) } });
  assert.equal(turnRequest(wake, [turn, inserted, wake, later]), 'Ship the release\n\nAlso tag it\n\nAnd announce it');
});

test('an approval answered before its push was decided is not pushed', async t => {
  const approval = { id: 'a1', toolName: 'Bash', input: {} };
  let runs = [run('owner', { status: 'running', finishedAt: undefined, approvals: [approval] })];
  const { sent, notifications } = await service(t, () => runs);
  runs = [run('owner', { status: 'completed', approvals: [approval] })];
  await notifications.start();
  await settle();
  await notifications.close();
  assert.deepEqual(sent.length, 1, 'only the finished turn');
});

test('after shutdown a judgment that finishes late neither pushes nor overwrites the saved state', async t => {
  const turn = run('turn', {});
  let release!: () => void;
  const { dir, sent, notifications } = await service(t, () => [turn], () => new Promise<TurnAttention>(resolve => { release = () => resolve({ outcome: 'done', quiet: false }); }));
  await notifications.start();
  await settle();
  await notifications.close();
  const before = await readFile(join(dir, 'notifications.json'), 'utf8');
  release();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(sent.length, 0);
  assert.equal(await readFile(join(dir, 'notifications.json'), 'utf8'), before);
});
