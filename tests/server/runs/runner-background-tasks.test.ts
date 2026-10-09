import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isSavedRun } from '../../../server/runs/saved-state.js';
import { BackgroundTaskTracker } from '../../../server/runs/background-tasks.js';
import { RunManager } from '../../../server/runs/manager.js';
import { WakeupTracker } from '../../../server/runs/wakeup.js';
import type { Session } from '../../../shared/types.js';
import { until } from '../../helpers/until.ts';
import { SECRET_CONNECTION_INSTRUCTIONS, SECRET_USE_INSTRUCTIONS } from '../../../server/secrets/notices.js';

const ID = '20000000-0000-4000-8000-000000000011';
const SESSION = `claude:${ID}`;

// A background task outlives the turn that started it. The fixture plays Claude: the first message gets `first`
// and a result, then `later` frames are sent on their own timers; any further message gets `reply` and a result.
const PROVIDER = `
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const send = event => process.stdout.write(JSON.stringify(event) + '\\n');
const log = entry => appendFileSync(process.env.LOG, JSON.stringify(entry) + '\\n');
const id = process.argv.slice(2).find(value => /^20000000-/.test(value));
let script = JSON.parse(process.env.SCRIPT);
if (script.recovered && readFileSync(process.env.LOG, 'utf8').includes('user')) script = script.recovered;
let turns = 0;
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') { send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } }); return; }
  if (message.type !== 'user') return;
  log({ user: message.message.content[0].text });
  if (turns++ === 0) {
    send({ type: 'system', subtype: 'init', session_id: id, permissionMode: 'auto' });
    for (const frame of script.first) send({ session_id: id, ...frame });
    if (!script.noResult) send({ type: 'result', session_id: id, is_error: false, result: 'first done' });
    for (const step of script.later ?? []) setTimeout(() => { for (const frame of step.frames ?? []) send({ session_id: id, ...frame }); if (step.exit) { if (step.stderr) process.stderr.write(step.stderr); process.exit(step.code ?? 0); } }, step.at);
    return;
  }
  if (script.unacknowledgedReply) { send({ type: 'result', session_id: id, is_error: false, result: 'finished without replay' }); return; }
  setTimeout(() => {
    send({ type: 'user', isReplay: true, uuid: message.uuid, session_id: id, parent_tool_use_id: null, message: message.message });
    for (const frame of script.reply ?? []) send({ session_id: id, ...frame });
    send({ type: 'result', session_id: id, is_error: false, result: 'reply done' });
  }, script.replyDelay ?? 0);
}).on('close', () => { log({ end: true }); process.exit(0); });
`;

const started = (taskId: string, extra: Record<string, unknown> = {}) => ({ type: 'system', subtype: 'task_started', task_id: taskId, task_type: 'local_bash', description: 'Run the reviews', ...extra });
const notified = (taskId: string, status = 'completed') => ({ type: 'system', subtype: 'task_notification', task_id: taskId, status, summary: 'Background command "Run the reviews" completed (exit code 0)', output_file: '/tmp/reviews.out' });
const says = (text: string, id?: string) => ({ type: 'assistant', message: { ...(id ? { id } : {}), content: [{ type: 'text', text }] } });
// Claude replays each notice it takes into the conversation.
const takes = (taskId: string) => ({ type: 'user', isReplay: true, parent_tool_use_id: null, uuid: `replay-${taskId}`,
  message: { role: 'user', content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n</task-notification>` } });
const result = { type: 'result', is_error: false, result: 'follow-up done' };

async function fixture(script: Record<string, unknown>, options: { followUpMs?: number; waitMaxMs?: number; recoveryMs?: number; resolveRunTools?: ConstructorParameters<typeof RunManager>[0]['resolveRunTools'] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-background-'));
  const provider = join(directory, 'provider.mjs');
  const log = join(directory, 'provider.log');
  await writeFile(provider, PROVIDER);
  await writeFile(log, '');
  const session: Session = { id: SESSION, nativeId: ID, provider: 'claude', title: 'Background fixture', cwd: directory, project: 'fixture', status: 'completed', statusReason: '',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastMessage: '', messageCount: 1, isSubagent: false, resumable: true };
  const manager = new RunManager({ getSession: id => id === SESSION ? session : undefined, refreshSessions: async () => {}, stateDir: join(directory, 'state'), pollMs: 20,
    findExecutable: async provider => `/fixture/${provider}`, env: { LOG: log, SCRIPT: JSON.stringify(script) }, resolveRunTools: options.resolveRunTools,
    backgroundRecoveryMs: options.recoveryMs ?? 100,
    backgroundFollowUpMs: options.followUpMs ?? 5000, backgroundWaitMaxMs: options.waitMaxMs ?? 30_000,
    spawnProcess: (_file, args, spawnOptions) => spawn(process.execPath, [provider, ...args], spawnOptions) });
  await manager.start();
  const entries = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { user?: string; end?: true });
  return { manager, entries, cleanup: async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); } };
}

const find = (manager: RunManager, id: string) => manager.list().find(run => run.id === id)!;
const settled = (manager: RunManager, id: string) => until(() => { const run = find(manager, id); return run && !['queued', 'running'].includes(run.status) ? run : undefined; }, 10_000);

test('an unacknowledged private notice releases completed input after delivery settles', async t => {
  const f = await fixture({ first: [says('Working.')], noResult: true, unacknowledgedReply: true }, {
    resolveRunTools: () => ({ required: true, towerTools: 'attached', instructions: SECRET_USE_INSTRUCTIONS, servers: { tower_secrets: { command: '/fixture/secret-tool', args: [] } } }),
  });
  t.after(f.cleanup);
  const run = await f.manager.enqueue(SESSION, 'Use a fixture key', {}, { origin: { kind: 'owner' } });
  const owned = await until(() => (f.manager as unknown as { owned: Map<string, { claude?: { canSteer(): boolean; options: { steerTimeoutMs?: number } } }> }).owned.get(run.id)?.claude);
  await until(() => owned.canSteer());
  owned.options.steerTimeoutMs = 30;
  f.manager.notifyToolChange(SECRET_CONNECTION_INSTRUCTIONS, SESSION);
  const done = await settled(f.manager, run.id);
  assert.equal(done.status, 'completed');
  // Completion is observable before asynchronous notice/pump bookkeeping has fully settled.
  await until(() => !f.manager.busy());
  assert.equal(f.manager.busy(), false);
  assert.equal(f.manager.list().length, 1);
  assert.equal((await f.entries()).filter(entry => entry.user).length, 2);
  assert.equal((await f.entries()).at(-1)?.end, true);
});

test('a turn stays open while its background task runs and ends after Claude takes the result', async t => {
  const { manager, entries, cleanup } = await fixture({ first: [started('bash-1'), says('I will report when the reviews finish.')],
    later: [{ at: 300, frames: [notified('bash-1')] }, { at: 350, frames: [takes('bash-1'), says('All seven reviews passed.'), result] }] });
  t.after(cleanup);
  const run = await manager.enqueue(SESSION, 'Run the reviews', {}, { origin: { kind: 'owner' } });
  const waiting = await until(() => find(manager, run.id).backgroundWait);
  assert.equal(waiting.tasks, 1);
  assert.equal(find(manager, run.id).status, 'running');
  assert.equal((await entries()).some(entry => entry.end), false, 'input must stay open while the task runs');
  const done = await settled(manager, run.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.backgroundWait, undefined);
  assert.match(done.output, /I will report when the reviews finish\.[\s\S]*Waiting for 1 background task[\s\S]*All seven reviews passed\./);
  assert.deepEqual((await entries()).map(entry => entry.end ? 'end' : 'user'), ['user', 'end']);
});

test('tasks that finish and are taken inside the turn end it at its result as before', async t => {
  const { manager, entries, cleanup } = await fixture({ first: [started('agent-1', { task_type: 'local_agent', is_backgrounded: false }), notified('agent-1'),
    started('bash-1'), notified('bash-1'), takes('bash-1'), says('Done.')] });
  t.after(cleanup);
  const run = await manager.enqueue(SESSION, 'Quick', {}, { origin: { kind: 'owner' } });
  const done = await settled(manager, run.id);
  assert.equal(done.status, 'completed');
  assert.doesNotMatch(done.output, /Waiting for/);
  assert.ok((await entries()).some(entry => entry.end));
});

test('a task that ends in the turn but whose notice comes after the result still keeps the turn open', async t => {
  const { manager, entries, cleanup } = await fixture({ first: [started('bash-1'), { type: 'system', subtype: 'task_updated', task_id: 'bash-1', patch: { status: 'completed' } }],
    later: [{ at: 200, frames: [notified('bash-1'), takes('bash-1'), says('Read the output.'), result] }] });
  t.after(cleanup);
  const run = await manager.enqueue(SESSION, 'Run it', {}, { origin: { kind: 'owner' } });
  const done = await settled(manager, run.id);
  assert.equal(done.status, 'completed');
  assert.match(done.output, /Waiting for Claude to take the finished background work[\s\S]*Read the output\./);
  assert.deepEqual((await entries()).map(entry => entry.user ?? 'end'), ['Run it', 'end']);
});

test('a foreground task moved to the background is followed from then on', async t => {
  const { manager, cleanup } = await fixture({ first: [started('bash-1', { is_backgrounded: false }), { type: 'system', subtype: 'task_updated', task_id: 'bash-1', patch: { is_backgrounded: true } }],
    later: [{ at: 200, frames: [notified('bash-1'), takes('bash-1'), says('Build finished.'), result] }] });
  t.after(cleanup);
  const run = await manager.enqueue(SESSION, 'Build', {}, { origin: { kind: 'owner' } });
  assert.equal((await until(() => find(manager, run.id).backgroundWait)).tasks, 1);
  assert.match((await settled(manager, run.id)).output, /Build finished\./);
});

test('Claude exiting while its background work runs is not reported as success', async t => {
  const { manager, cleanup } = await fixture({ first: [started('bash-1')], later: [{ at: 150, exit: true }] });
  t.after(cleanup);
  const run = await manager.enqueue(SESSION, 'Run it', {}, { origin: { kind: 'owner' } });
  const done = await settled(manager, run.id);
  assert.equal(done.status, 'error');
  assert.match(done.error ?? '', /exited before it took the results of background work/);
});

test('ambient, subagent-owned and teammate tasks never hold a turn open', async t => {
  const { manager, cleanup } = await fixture({ first: [started('feed', { ambient: true }), started('mate', { task_type: 'in_process_teammate' }), started('hidden', { skip_transcript: true }),
    started('nested', { owned_by_subagent: true })] });
  t.after(cleanup);
  const run = await manager.enqueue(SESSION, 'Watch', {}, { origin: { kind: 'owner' } });
  assert.equal((await settled(manager, run.id)).status, 'completed');
});

test('when Claude does not pick up a finished task by itself, Tower hands it the notice', async t => {
  const { manager, entries, cleanup } = await fixture({ first: [started('bash-1')], later: [{ at: 100, frames: [notified('bash-1')] }], reply: [says('Summarised the reviews.')] }, { followUpMs: 150 });
  t.after(cleanup);
  const run = await manager.enqueue(SESSION, 'Run the reviews', {}, { origin: { kind: 'owner' } });
  const done = await settled(manager, run.id);
  assert.equal(done.status, 'completed');
  assert.match(done.output, /asking Claude to continue[\s\S]*Summarised the reviews\./);
  const log = await entries();
  assert.equal(log.length, 3);
  assert.match(log[1].user!, /Background work you started in this conversation has finished:\n- completed: Background command "Run the reviews" completed \(exit code 0\) \(output: \/tmp\/reviews\.out\)/);
  assert.ok(log[2].end);
});

test('Claude taking a notice by itself in a turn of its own, without replaying it, gets no second notice from Tower', async t => {
  const { manager, entries, cleanup } = await fixture({ first: [started('bash-1')],
    later: [{ at: 100, frames: [notified('bash-1'), says('The checks passed.'), result] }] }, { followUpMs: 150 });
  t.after(cleanup);
  const run = await manager.enqueue(SESSION, 'Run the checks', {}, { origin: { kind: 'owner' } });
  const done = await settled(manager, run.id);
  assert.equal(done.status, 'completed');
  assert.doesNotMatch(done.output, /asking Claude to continue/);
  assert.deepEqual((await entries()).map(entry => entry.user ?? 'end'), ['Run the checks', 'end']);
});

test('a notice the turn under way may have taken ends the turn quietly when Claude starts no turn for it', async t => {
  const { manager, entries, cleanup } = await fixture({ first: [started('bash-1'), notified('bash-1'), says('Almost done.', 'reply-1')] }, { followUpMs: 150 });
  t.after(cleanup);
  const run = await manager.enqueue(SESSION, 'Run the checks', {}, { origin: { kind: 'owner' } });
  const done = await settled(manager, run.id);
  assert.equal(done.status, 'completed');
  assert.doesNotMatch(done.output, /asking Claude to continue/);
  assert.deepEqual((await entries()).map(entry => entry.user ?? 'end'), ['Run the checks', 'end']);
});

test("Tower's notice holds the turn open until Claude takes it, even if another follow-up finishes first", async t => {
  const { manager, cleanup } = await fixture({ first: [started('bash-1')], replyDelay: 300, reply: [says('Summarised the reviews.')],
    later: [{ at: 100, frames: [notified('bash-1')] }, { at: 320, frames: [says('Something else.'), result] }] }, { followUpMs: 150 });
  t.after(cleanup);
  const run = await manager.enqueue(SESSION, 'Run the reviews', {}, { origin: { kind: 'owner' } });
  const done = await settled(manager, run.id);
  assert.equal(done.status, 'completed');
  assert.match(done.output, /Something else\.[\s\S]*Summarised the reviews\./);
});

test('background work still running at the limit closes the turn and is not reported as success', async t => {
  const { manager, entries, cleanup } = await fixture({ first: [started('server-1')] }, { waitMaxMs: 200 });
  t.after(cleanup);
  const run = await manager.enqueue(SESSION, 'Start the dev server', {}, { origin: { kind: 'owner' } });
  const done = await settled(manager, run.id);
  assert.equal(done.status, 'error');
  assert.match(done.error ?? '', /background work did not finish/);
  assert.ok((await entries()).some(entry => entry.end));
});

test("the owner's next message goes straight into a turn that only waits for background work", async t => {
  const { manager, entries, cleanup } = await fixture({ first: [started('bash-1')], reply: [says('Here is the status so far.')],
    later: [{ at: 1500, frames: [notified('bash-1'), takes('bash-1'), says('Reviews finished.'), result] }] });
  t.after(cleanup);
  const first = await manager.enqueue(SESSION, 'Run the reviews', {}, { origin: { kind: 'owner' } });
  await until(() => find(manager, first.id).backgroundWait);
  const second = await manager.enqueue(SESSION, 'How is it going?', {}, { origin: { kind: 'owner' } });
  await until(() => find(manager, second.id).steering?.state === 'delivered');
  await until(() => find(manager, first.id).output.includes('Here is the status so far.'));
  // Still waiting for the task after answering.
  await until(() => find(manager, first.id).backgroundWait);
  const done = await settled(manager, first.id);
  assert.equal(done.status, 'completed');
  assert.match(done.output, /Reviews finished\./);
  assert.equal((await settled(manager, second.id)).status, 'completed');
  assert.deepEqual((await entries()).map(entry => entry.user ?? 'end'), ['Run the reviews', 'How is it going?', 'end']);
});

test('the tracker follows each task from start to the notice Claude takes', () => {
  const tracker = new BackgroundTaskTracker();
  assert.equal(tracker.observe(started('a')), 'started');
  assert.equal(tracker.observe(started('a')), undefined);
  assert.equal(tracker.observe(started('b')), 'started');
  assert.equal(tracker.observe(started('f', { is_backgrounded: false })), undefined);
  assert.equal(tracker.runningCount, 2);
  assert.equal(tracker.observe({ type: 'system', subtype: 'task_updated', task_id: 'a', patch: { status: 'running' } }), undefined);
  assert.equal(tracker.observe({ type: 'system', subtype: 'task_updated', task_id: 'a', patch: { status: 'completed' } }), 'ended');
  // The notification after the update adds what the update lacked, without ending the task twice.
  assert.equal(tracker.observe(notified('a')), undefined);
  assert.equal(tracker.observe(notified('unknown')), undefined);
  assert.equal(tracker.observe(notified('f')), undefined);
  assert.deepEqual([tracker.runningCount, tracker.unreadCount, tracker.outstanding], [1, 1, 2]);
  tracker.observeReplay({ message: { content: [{ type: 'text', text: '<task-notification><task-id>ab</task-id></task-notification>' }] } });
  assert.equal(tracker.unreadCount, 1, 'another id does not count');
  assert.equal(tracker.observe(notified('b', 'killed')), 'ended');
  assert.deepEqual(tracker.takeUnread(), [
    { status: 'completed', summary: 'Background command "Run the reviews" completed (exit code 0)', outputFile: '/tmp/reviews.out' },
    { status: 'killed', summary: 'Background command "Run the reviews" completed (exit code 0)', outputFile: '/tmp/reviews.out' }]);
  assert.equal(tracker.outstanding, 0);
  tracker.observe(started('c'));
  tracker.observe(notified('c'));
  tracker.observeReplay(takes('c'));
  assert.equal(tracker.outstanding, 0);
});

test('a model reply that starts after a task ended takes its notice; one starting right after the end settles it only with the next', () => {
  let now = 0;
  const tracker = new BackgroundTaskTracker({ now: () => now });
  tracker.observe(started('a'));
  tracker.observeReply('m1');
  tracker.observe(notified('a'));
  tracker.observeReply('m1');
  assert.equal(tracker.unreadCount, 1, 'the reply under way when it ended did not take it');
  now += 2000;
  tracker.observeReply('m2');
  assert.equal(tracker.unreadCount, 1, 'a reply this close may have been requested before the notice was queued');
  tracker.observeReply('m3');
  assert.equal(tracker.outstanding, 0);
  tracker.observe(started('b'));
  tracker.observe(notified('b'));
  now += 60_000;
  tracker.observeReply('m4');
  assert.equal(tracker.outstanding, 0, 'a reply starting well after the end had it');
  tracker.observe(started('c'));
  tracker.observe(notified('c'));
  now += 1000;
  tracker.observeReply('m5');
  assert.deepEqual(tracker.takeUnread(), [], 'Tower does not hand over a notice a reply may have taken');
  tracker.observe(started('d'));
  tracker.observe(notified('d'));
  tracker.observeTurnStart();
  assert.equal(tracker.outstanding, 0, 'a turn Claude starts by itself takes every queued notice');
});

test("a wakeup is dropped only when Claude's own timer delivered it in the kept-open process", () => {
  let now = 1_000_000;
  const schedule = (prompt: string) => {
    const wakeups = new WakeupTracker(1000, () => now);
    wakeups.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w1', name: 'ScheduleWakeup', input: { delaySeconds: 600, prompt } }] } });
    wakeups.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'Scheduled (in 600s).' }] } });
    return wakeups;
  };
  const plain = schedule('Check again.');
  plain.observeReplay('<task-notification><task-id>a</task-id></task-notification>');
  plain.observeReplay('How is it going?');
  assert.ok(plain.pending, 'other follow-ups keep it');
  plain.observeReplay('Check again.');
  assert.equal(plain.pending, undefined);
  const loop = schedule('<<autonomous-loop-dynamic>>');
  loop.observeReplay('Loop instructions');
  assert.ok(loop.pending, 'before its time nothing is the wakeup');
  now += 600_000;
  loop.observeReplay('[Agent Session Tower] Background work you started has finished.');
  assert.ok(loop.pending);
  loop.observeReplay('Loop instructions');
  assert.equal(loop.pending, undefined);
});


test('a task start arriving after the result keeps input open', async t => {
  const { manager, cleanup } = await fixture({ first: [says('Waiting for review.')], later: [
    { at: 40, frames: [started('late')] },
    { at: 400, frames: [notified('late'), takes('late'), says('Review complete.'), result] },
  ] });
  t.after(cleanup);
  const run = await manager.enqueue(SESSION, 'Review');
  assert.equal((await until(() => find(manager, run.id).backgroundWait)).tasks, 1);
  const done = await settled(manager, run.id);
  assert.equal(done.status, 'completed');
  assert.match(done.output, /Review complete/);
});

test('a subagent result cannot close the parent input', async t => {
  const { manager, cleanup } = await fixture({ noResult: true,
    first: [{ ...result, parent_tool_use_id: 'agent-tool' }],
    later: [{ at: 500, frames: [says('Parent finished.'), result] }] });
  t.after(cleanup);
  const run = await manager.enqueue(SESSION, 'Delegate');
  const done = await settled(manager, run.id);
  assert.equal(done.status, 'completed');
  assert.match(done.output, /Parent finished/);
});

test('unexpected exit before a result resumes proven unfinished work with the same owner authority', async t => {
  const { manager, entries, cleanup } = await fixture({ noResult: true, first: [started('review'), says('Waiting.')],
    later: [{ at: 50, exit: true, code: 1, stderr: 'fixture unexpected exit' }],
    recovered: { first: [says('Read the existing review. Work completed.')] } });
  t.after(cleanup);
  const run = await manager.enqueue(SESSION, 'Review', { model: 'opus', effort: 'high' }, { origin: { kind: 'owner' } });
  const done = await settled(manager, run.id);
  assert.equal(done.status, 'error');
  assert.match(done.error!, /fixture unexpected exit/);
  assert.match(done.output, /code=1.*result=false.*inputClosedByTower=false/);
  const recovery = await until(() => manager.list().find(item => item.scheduled?.afterRunId === run.id));
  assert.deepEqual([recovery.origin, recovery.model, recovery.effort, recovery.scheduled?.backgroundRecoveryAttempt], [{ kind: 'owner' }, 'opus', 'high', 1]);
  assert.equal((await settled(manager, recovery.id)).status, 'completed');
  assert.match((await entries())[1].user!, /First inspect existing output files/);
});

test('repeated unexpected exits stop after three persisted recovery attempts', async t => {
  const { manager, cleanup } = await fixture({ noResult: true, first: [started('review')], later: [{ at: 20, exit: true, code: 1 }] }, { recoveryMs: 10 });
  t.after(cleanup);
  await manager.enqueue(SESSION, 'Review', {}, { origin: { kind: 'owner' } });
  const last = await until(() => manager.list().find(run => run.scheduled?.backgroundRecoveryAttempt === 3 && run.status === 'error'), 10_000);
  assert.match(last.output, /stopped after three attempts/);
  assert.equal(manager.list().length, 4);
  assert.equal(manager.list().some(run => run.status === 'queued' || run.status === 'running'), false);
});

test('owner cancellation and a background wait timeout never schedule recovery', async t => {
  for (const stop of [false, true]) {
    const { manager, cleanup } = await fixture({ first: [started('review')] }, { waitMaxMs: stop ? 30_000 : 50 });
    t.after(cleanup);
    const run = await manager.enqueue(SESSION, 'Review', {}, { origin: { kind: 'owner' } });
    await until(() => find(manager, run.id).backgroundWait);
    if (stop) await manager.cancel(run.id);
    await settled(manager, run.id);
    assert.equal(manager.list().length, 1);
  }
});

test('a newer owner instruction supersedes queued recovery', async t => {
  const { manager, cleanup } = await fixture({ first: [started('review')], later: [{ at: 30, exit: true }], recovered: { first: [says('New request handled.')] } }, { recoveryMs: 60_000 });
  t.after(cleanup);
  const run = await manager.enqueue(SESSION, 'Review', {}, { origin: { kind: 'owner' } });
  await settled(manager, run.id);
  const recovery = manager.list().find(item => item.scheduled)!;
  assert.ok(recovery);
  const newer = await manager.enqueue(SESSION, 'Different instruction', {}, { origin: { kind: 'owner' } });
  assert.equal(find(manager, recovery.id).status, 'cancelled');
  assert.equal((await settled(manager, newer.id)).status, 'completed');
});


test('recovery attempt limits survive saved-state validation', () => {
  const run = { id: '30000000-0000-4000-8000-000000000001', sessionId: SESSION, prompt: 'Resume', status: 'queued',
    createdAt: new Date().toISOString(), output: '', scheduled: { at: new Date().toISOString(),
      afterRunId: '30000000-0000-4000-8000-000000000002', backgroundRecoveryAttempt: 3 } };
  assert.equal(isSavedRun(JSON.parse(JSON.stringify(run))), true);
  for (const attempt of [0, 4, -1, 1.5, '1']) {
    assert.equal(isSavedRun({ ...run, scheduled: { ...run.scheduled, backgroundRecoveryAttempt: attempt } }), false);
  }
});

test('an explicit provider error or a pending approval is never retried', async t => {
  for (const script of [
    { first: [started('review'), { ...result, is_error: true, errors: ['Access refused'] }], noResult: true },
    { first: [started('review'), { type: 'control_request', request_id: 'approve', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'fixture' } } }], noResult: true, later: [{ at: 100, exit: true, code: 1 }] },
  ]) {
    const { manager, cleanup } = await fixture(script);
    t.after(cleanup);
    const run = await manager.enqueue(SESSION, 'Review', {}, { origin: { kind: 'owner' } });
    assert.equal((await settled(manager, run.id)).status, 'error');
    assert.equal(manager.list().length, 1);
  }
});


test('a repeated result is not evidence that Claude consumed a pending task notice', async t => {
  const { manager, entries, cleanup } = await fixture({ first: [started('review')],
    later: [{ at: 50, frames: [notified('review'), result] }], reply: [says('Read the review.')] }, { followUpMs: 100 });
  t.after(cleanup);
  const run = await manager.enqueue(SESSION, 'Review');
  assert.equal((await settled(manager, run.id)).status, 'completed');
  assert.match((await entries())[1].user!, /Background work you started/);
  assert.match(find(manager, run.id).output, /Read the review/);
});
