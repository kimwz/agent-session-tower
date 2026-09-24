import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RunManager } from '../../../server/runs/manager.js';
import { WakeupTracker } from '../../../server/runs/wakeup.js';
import type { Run, Session } from '../../../shared/types.js';
import { until } from '../../helpers/until.ts';

const ID = '20000000-0000-4000-8000-000000000001';
const SESSION = `claude:${ID}`;

// Claude's own wakeup timer ends with its process; Tower keeps the agent's schedule instead.
const PROVIDER = `
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const send = event => process.stdout.write(JSON.stringify(event) + '\\n');
const id = process.argv.slice(2).find(value => /^20000000-/.test(value));
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') { send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } }); return; }
  if (message.type !== 'user') return;
  appendFileSync(process.env.PROMPTS, JSON.stringify(message.message.content[0].text) + '\\n');
  const turn = readFileSync(process.env.PROMPTS, 'utf8').trim().split('\\n').length - 1;
  const turns = JSON.parse(process.env.TURNS);
  send({ type: 'system', subtype: 'init', session_id: id, permissionMode: process.argv.includes('--permission-mode') ? process.argv[process.argv.indexOf('--permission-mode') + 1] : 'default' });
  for (const frame of turns[Math.min(turn, turns.length - 1)]) send(frame);
  send({ type: 'result', is_error: false, result: 'done' });
});
`;

const wakeupCall = (id: string, input: Record<string, unknown>) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'ScheduleWakeup', input }] } });
const wakeupResult = (id: string, content: unknown, isError = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] } });
const scheduled = (seconds: number) => [wakeupCall('toolu_1', { delaySeconds: 1200, prompt: 'Read the review and continue.', reason: 'waiting' }),
  wakeupResult('toolu_1', `Next wakeup scheduled for 19:52:00 (in ${seconds}s).`)];

async function fixture(turns: unknown[][], saved?: Run[]) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-wakeup-'));
  const script = join(directory, 'provider.mjs');
  const prompts = join(directory, 'prompts.log');
  await writeFile(script, PROVIDER);
  await writeFile(prompts, '');
  const stateDir = join(directory, 'state');
  if (saved) { await import('node:fs/promises').then(fs => fs.mkdir(stateDir, { recursive: true })); await writeFile(join(stateDir, 'runs.json'), JSON.stringify(saved)); }
  const session: Session = { id: SESSION, nativeId: ID, provider: 'claude', title: 'Wakeup fixture', cwd: directory, project: 'fixture', status: 'completed', statusReason: '',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastMessage: '', messageCount: 1, isSubagent: false, resumable: true };
  const sessions = new Map([[SESSION, session]]);
  const manager = new RunManager({ getSession: id => sessions.get(id), refreshSessions: async () => {}, stateDir, pollMs: 20,
    findExecutable: async provider => `/fixture/${provider}`, env: { PROMPTS: prompts, TURNS: JSON.stringify(turns) },
    spawnProcess: (_file, args, options) => spawn(process.execPath, [script, ...args], options) });
  await manager.start();
  const received = async () => (await readFile(prompts, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string);
  return { manager, session, sessions, stateDir, received, cleanup: async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); } };
}

const settled = (manager: RunManager, id: string) => until(() => { const run = manager.list().find(item => item.id === id); return run && !['queued', 'running'].includes(run.status) ? run : undefined; });
const continuation = (manager: RunManager) => manager.list().find(run => run.scheduled);

test('a wakeup the agent scheduled becomes a queued continuation with the same authority', async t => {
  const { manager, stateDir, cleanup } = await fixture([scheduled(1232)]);
  t.after(cleanup);
  const before = Date.now();
  const first = await manager.enqueue(SESSION, 'Start the review', { model: 'opus', effort: 'high' }, { origin: { kind: 'owner' }, unattended: true });
  assert.equal((await settled(manager, first.id)).status, 'completed');
  const next = continuation(manager)!;
  assert.equal(next.status, 'queued');
  assert.equal(next.prompt, 'Read the review and continue.');
  assert.equal(next.scheduled!.afterRunId, first.id);
  assert.deepEqual([next.origin, next.unattended, next.model, next.effort], [{ kind: 'owner' }, true, 'opus', 'high']);
  // The native reply's own delay wins over the requested one.
  const at = Date.parse(next.scheduled!.at) - before;
  assert.ok(at >= 1232_000 && at < 1242_000, String(at));
  assert.equal(manager.getSession(SESSION)?.scheduledAt, next.scheduled!.at);
  assert.equal(next.canSteer, false);
  // It is saved, so another worker can deliver it.
  await manager.flushState();
  assert.ok(JSON.parse(await readFile(join(stateDir, 'runs.json'), 'utf8')).some((run: Run) => run.scheduled?.afterRunId === first.id));
});

test('Slack and trigger turns follow their event, so they never schedule a continuation', async t => {
  const { manager, cleanup } = await fixture([scheduled(600)]);
  t.after(cleanup);
  const run = await manager.enqueue(SESSION, 'From a trigger', {}, { origin: { kind: 'trigger', triggerId: 'trigger-1', eventId: 'event-1' } });
  assert.equal((await settled(manager, run.id)).status, 'completed');
  assert.equal(continuation(manager), undefined);
});

test('a continuation waits for its time, survives a worker restart, and resumes the conversation when due', async t => {
  const createdAt = new Date(Date.now() - 10_000).toISOString();
  const saved: Run[] = [
    { id: '30000000-0000-4000-8000-000000000001', sessionId: SESSION, prompt: 'Scheduled turn', status: 'completed', createdAt, finishedAt: createdAt, output: '' },
    { id: '30000000-0000-4000-8000-000000000002', sessionId: 'claude:20000000-0000-4000-8000-000000000008', origin: { kind: 'owner' }, prompt: 'Later', status: 'queued', createdAt, output: '',
      scheduled: { at: new Date(Date.now() + 60 * 60_000).toISOString(), afterRunId: '30000000-0000-4000-8000-000000000001' } },
    { id: '30000000-0000-4000-8000-000000000003', sessionId: SESSION, origin: { kind: 'owner' }, prompt: 'Due', status: 'queued', createdAt, output: '',
      scheduled: { at: new Date(Date.now() - 60_000).toISOString(), afterRunId: '30000000-0000-4000-8000-000000000001' } },
  ];
  const { manager, received, cleanup } = await fixture([[]], saved);
  t.after(cleanup);
  assert.equal((await settled(manager, saved[2].id)).status, 'completed');
  assert.deepEqual(await received(), ['Due']);
  const later = manager.list().find(run => run.id === saved[1].id)!;
  assert.equal(later.status, 'queued');
  assert.equal(manager.hasWorkWithin(5 * 60_000), false);
  assert.equal(manager.hasWorkWithin(2 * 60 * 60_000), true);
  // Shutting the worker down keeps the continuation for the next one.
  await manager.close();
  assert.equal(manager.list().find(run => run.id === saved[1].id)!.status, 'queued');
});

test('a continuation missed by more than the grace period is not started after a restart', async t => {
  const createdAt = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
  const { manager, received, cleanup } = await fixture([[]], [{ id: '30000000-0000-4000-8000-000000000004', sessionId: SESSION, prompt: 'Stale', status: 'queued', createdAt, output: '',
    scheduled: { at: new Date(Date.now() - 2 * 60 * 60_000).toISOString(), afterRunId: '30000000-0000-4000-8000-000000000005' } }]);
  t.after(cleanup);
  const [run] = manager.list();
  assert.equal(run.status, 'cancelled');
  assert.match(run.error ?? '', /not running when this scheduled continuation was due/);
  assert.deepEqual(await received(), []);
});

test('a newer instruction replaces the scheduled continuation', async t => {
  const { manager, received, cleanup } = await fixture([scheduled(600), []]);
  t.after(cleanup);
  const first = await manager.enqueue(SESSION, 'First', {}, { origin: { kind: 'owner' } });
  await settled(manager, first.id);
  const planned = continuation(manager)!;
  const second = await manager.enqueue(SESSION, 'Second', {}, { origin: { kind: 'owner' } });
  const replaced = manager.list().find(run => run.id === planned.id)!;
  assert.equal(replaced.status, 'cancelled');
  assert.match(replaced.output, /newer instruction/);
  await settled(manager, second.id);
  assert.deepEqual(await received(), ['First', 'Second']);
  assert.equal(manager.list().filter(run => run.status === 'queued').length, 0);
  assert.equal(manager.getSession(SESSION)?.scheduledAt, undefined);
});

test('a continuation is not started when the conversation continued outside Tower', async t => {
  const createdAt = new Date(Date.now() - 10_000).toISOString();
  const run = (id: string, at: number): Run => ({ id, sessionId: SESSION, origin: { kind: 'owner' }, prompt: id, status: 'queued', createdAt, output: '',
    scheduled: { at: new Date(at).toISOString(), afterRunId: '30000000-0000-4000-8000-000000000009' } });
  const due = run('30000000-0000-4000-8000-000000000006', Date.now() + 300);
  const { manager, sessions, received, cleanup } = await fixture([[]], [due]);
  t.after(cleanup);
  // The owner continued in a terminal after the agent scheduled this.
  sessions.set(SESSION, { ...sessions.get(SESSION)!, lastRequestAt: new Date().toISOString() });
  const result = await settled(manager, due.id);
  assert.equal(result.status, 'cancelled');
  assert.match(result.output, /continued before the scheduled time/);
  assert.deepEqual(await received(), []);
});

test('explicit cancel stops a scheduled continuation before it starts', async t => {
  const createdAt = new Date(Date.now() - 10_000).toISOString();
  const planned: Run = { id: '30000000-0000-4000-8000-000000000007', sessionId: SESSION, origin: { kind: 'owner' }, prompt: 'Planned', status: 'queued', createdAt, output: '',
    scheduled: { at: new Date(Date.now() + 60_000).toISOString(), afterRunId: '30000000-0000-4000-8000-000000000009' } };
  const { manager, cleanup } = await fixture([[]], [planned]);
  t.after(cleanup);
  assert.ok(manager.getSession(SESSION)?.scheduledAt);
  await manager.cancel(planned.id);
  assert.equal(manager.list()[0].status, 'cancelled');
  assert.equal(manager.getSession(SESSION)?.scheduledAt, undefined);
});

test('the tracker follows only accepted calls: the last wins, stop clears it, errors and unanswered calls do not count', () => {
  let now = 1_000_000;
  const tracker = new WakeupTracker(100, () => now);
  tracker.observe(wakeupCall('a', { delaySeconds: 30, prompt: 'too soon' }));
  tracker.observe(wakeupResult('a', 'Scheduled.'));
  assert.deepEqual(tracker.pending, { at: now + 60_000, prompt: 'too soon' });
  tracker.observe(wakeupCall('b', { delaySeconds: 9999, prompt: '<<autonomous-loop-dynamic>>' }));
  tracker.observe(wakeupResult('b', 'Scheduled.'));
  assert.deepEqual(tracker.pending, { at: now + 3_600_000, prompt: 'Continue the work you scheduled with ScheduleWakeup.' });
  tracker.observe(wakeupCall('c', { delaySeconds: 120, prompt: 'failed' }));
  tracker.observe(wakeupResult('c', 'Error', true));
  tracker.observe(wakeupCall('d', { delaySeconds: 120, prompt: 'never answered' }));
  assert.equal(tracker.pending?.prompt, 'Continue the work you scheduled with ScheduleWakeup.');
  tracker.observe(wakeupCall('e', { stop: true }));
  tracker.observe(wakeupResult('e', 'Stopped.'));
  assert.equal(tracker.pending, undefined);
  now += 5;
  tracker.observe(wakeupCall('f', { delaySeconds: 600, prompt: 'x'.repeat(500) }));
  tracker.observe(wakeupResult('f', [{ type: 'text', text: 'Next wakeup scheduled (in 610s).' }]));
  assert.deepEqual(tracker.pending, { at: now + 610_000, prompt: 'x'.repeat(100) });
});
