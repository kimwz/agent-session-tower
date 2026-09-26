import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BackgroundTaskTracker } from '../../../server/runs/background-tasks.js';
import { RunManager } from '../../../server/runs/manager.js';
import { WakeupTracker } from '../../../server/runs/wakeup.js';
import type { Session } from '../../../shared/types.js';
import { until } from '../../helpers/until.ts';

const ID = '20000000-0000-4000-8000-000000000011';
const SESSION = `claude:${ID}`;

// A background task outlives the turn that started it. The fixture plays Claude: the first message gets `first`
// and a result, then `later` frames are sent on their own timers; any further message gets `reply` and a result.
const PROVIDER = `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const send = event => process.stdout.write(JSON.stringify(event) + '\\n');
const log = entry => appendFileSync(process.env.LOG, JSON.stringify(entry) + '\\n');
const id = process.argv.slice(2).find(value => /^20000000-/.test(value));
const script = JSON.parse(process.env.SCRIPT);
let turns = 0;
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') { send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } }); return; }
  if (message.type !== 'user') return;
  log({ user: message.message.content[0].text });
  if (turns++ === 0) {
    send({ type: 'system', subtype: 'init', session_id: id, permissionMode: 'auto' });
    for (const frame of script.first) send({ session_id: id, ...frame });
    send({ type: 'result', session_id: id, is_error: false, result: 'first done' });
    for (const step of script.later ?? []) setTimeout(() => { for (const frame of step.frames ?? []) send({ session_id: id, ...frame }); if (step.exit) process.exit(0); }, step.at);
    return;
  }
  setTimeout(() => {
    send({ type: 'user', isReplay: true, uuid: message.uuid, session_id: id, parent_tool_use_id: null, message: message.message });
    for (const frame of script.reply ?? []) send({ session_id: id, ...frame });
    send({ type: 'result', session_id: id, is_error: false, result: 'reply done' });
  }, script.replyDelay ?? 0);
}).on('close', () => { log({ end: true }); process.exit(0); });
`;

const started = (taskId: string, extra: Record<string, unknown> = {}) => ({ type: 'system', subtype: 'task_started', task_id: taskId, task_type: 'local_bash', description: 'Run the reviews', ...extra });
const notified = (taskId: string, status = 'completed') => ({ type: 'system', subtype: 'task_notification', task_id: taskId, status, summary: 'Background command "Run the reviews" completed (exit code 0)', output_file: '/tmp/reviews.out' });
const says = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
// Claude replays each notice it takes into the conversation.
const takes = (taskId: string) => ({ type: 'user', isReplay: true, parent_tool_use_id: null, uuid: `replay-${taskId}`,
  message: { role: 'user', content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n</task-notification>` } });
const result = { type: 'result', is_error: false, result: 'follow-up done' };

async function fixture(script: Record<string, unknown>, options: { followUpMs?: number; waitMaxMs?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-background-'));
  const provider = join(directory, 'provider.mjs');
  const log = join(directory, 'provider.log');
  await writeFile(provider, PROVIDER);
  await writeFile(log, '');
  const session: Session = { id: SESSION, nativeId: ID, provider: 'claude', title: 'Background fixture', cwd: directory, project: 'fixture', status: 'completed', statusReason: '',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastMessage: '', messageCount: 1, isSubagent: false, resumable: true };
  const manager = new RunManager({ getSession: id => id === SESSION ? session : undefined, refreshSessions: async () => {}, stateDir: join(directory, 'state'), pollMs: 20,
    findExecutable: async provider => `/fixture/${provider}`, env: { LOG: log, SCRIPT: JSON.stringify(script) },
    backgroundFollowUpMs: options.followUpMs ?? 5000, backgroundWaitMaxMs: options.waitMaxMs ?? 30_000,
    spawnProcess: (_file, args, spawnOptions) => spawn(process.execPath, [provider, ...args], spawnOptions) });
  await manager.start();
  const entries = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { user?: string; end?: true });
  return { manager, entries, cleanup: async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); } };
}

const find = (manager: RunManager, id: string) => manager.list().find(run => run.id === id)!;
const settled = (manager: RunManager, id: string) => until(() => { const run = find(manager, id); return run && !['queued', 'running'].includes(run.status) ? run : undefined; }, 10_000);

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
