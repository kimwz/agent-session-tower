import { RunAdmissionUncertain } from '../../../server/runs/run-records.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { TriggerService, type TriggerExecutor } from '../../../server/triggers/service.js';
import type { AutoPromptJob, Run } from '../../../shared/types.js';
import type { TriggerActor, TriggerEvent, TriggerInput } from '../../../shared/triggers.js';

const OWNER: TriggerActor = { kind: 'owner', via: 'ui' };
const start = Date.parse('2026-09-24T00:00:30.000Z');

async function engine(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-trigger-engine-'));
  const project = join(directory, 'project');
  await mkdir(project);
  const clock = { now: start };
  const runs: Run[] = [];
  const jobs = new Map<string, AutoPromptJob>();
  const calls = { create: 0, enqueue: 0, auto: 0, runs: 0, getAutoPrompt: 0 };
  const order: string[] = [];
  let gate: Promise<void> | undefined;
  const executor: TriggerExecutor = {
    submitAutoPrompt: async () => { calls.auto++; throw new Error('unused'); },
    getAutoPrompt: id => { calls.getAutoPrompt++; return jobs.get(id); },
    create: async (input, internal) => {
      calls.create++;
      order.push(input.title ?? '');
      await gate;
      const run: Run = { id: randomUUID(), sessionId: `codex:${randomUUID()}`, prompt: input.prompt, status: 'running', createdAt: '', output: '', autoPromptId: internal.autoPromptId };
      runs.push(run);
      return { run, session: { id: run.sessionId, nativeId: 'n', provider: input.provider, title: '', cwd: project, project: 'project', status: 'idle', statusReason: '', createdAt: '', updatedAt: '', lastMessage: '', messageCount: 0, isSubagent: false, resumable: true } };
    },
    enqueue: async () => { calls.enqueue++; throw new Error('unused'); },
    runs: () => { calls.runs++; return structuredClone(runs); },
    session: () => undefined,
  };
  const services: TriggerService[] = [];
  const make = () => {
    const service = new TriggerService({ stateDir: directory, executor, now: () => clock.now, tickMs: 3_600_000 });
    services.push(service);
    return service;
  };
  const open = async () => {
    const service = make();
    await service.start();
    return service;
  };
  t.after(async () => {
    for (const service of services) service.close();
    for (let i = 0; i < 400 && services.some(service => service.inFlight()); i++) await new Promise(resolve => setTimeout(resolve, 5));
    await Promise.allSettled(services.map(service => service.settle()));
    await rm(directory, { recursive: true, force: true });
  });
  const file = () => readFile(join(directory, 'trigger-engine.json'), 'utf8');
  return { directory, project, clock, runs, jobs, calls, order, open, make, file, executor, hold: (barrier: Promise<void> | undefined) => { gate = barrier; } };
}

const task = (project: string, name: string, values: Partial<TriggerInput> = {}): TriggerInput => ({ name, enabled: true,
  source: { kind: 'schedule', schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' }, catchUp: 'latest' },
  handler: { kind: 'task', instructions: 'Work', provider: 'codex', approvals: 'auto', target: { node: 'local', mode: 'folder', cwd: project } },
  policy: { overlap: 'parallel', maxEventsPerHour: 20 }, ...values });

const settled = async (service: TriggerService) => { for (let i = 0; i < 400 && service.inFlight(); i++) await new Promise(resolve => setTimeout(resolve, 5)); };

test('dispatch claims in order within maxConcurrentRuns and records outcomes in submission order', async t => {
  const f = await engine(t);
  const service = await f.open();
  await service.updateSettings({ maxConcurrentRuns: 2 }, OWNER);
  const triggers = [];
  for (const name of ['First', 'Second', 'Third']) triggers.push(await service.create(task(f.project, name), OWNER));
  let release!: () => void;
  f.hold(new Promise<void>(resolve => { release = resolve; }));
  for (const trigger of triggers) await service.run(trigger.id, OWNER);
  release(); f.hold(undefined);
  await settled(service); await service.tick(); await settled(service);
  assert.deepEqual(f.order, ['First', 'Second'], 'two run at once; the third waits');
  assert.deepEqual(service.events().map(event => [event.triggerName, event.status]).reverse(), [['First', 'running'], ['Second', 'running'], ['Third', 'queued']]);
  for (const run of f.runs) run.status = 'completed';
  await service.tick(); await settled(service); await service.tick(); await settled(service);
  assert.deepEqual(f.order, ['First', 'Second', 'Third']);
  const events = service.events().reverse();
  assert.deepEqual(events.map(event => event.triggerName), ['First', 'Second', 'Third']);
  assert.ok(events[2].status === 'running' && events[0].status === 'completed' && events[1].status === 'completed');
});

/** A saved engine file with the given claimed events and polling cursors added to real definitions. */
async function seeded(f: Awaited<ReturnType<typeof engine>>) {
  const service = await f.open();
  const folder = await service.create(task(f.project, 'Folder'), OWNER);
  const get = await service.create({ ...task(f.project, 'GET'), source: { kind: 'http', schedule: { type: 'interval', everySeconds: 60 }, request: { method: 'GET', url: 'https://example.com/a', headers: [], timeoutSeconds: 5 }, condition: { type: 'every-success' } } as TriggerInput['source'] }, OWNER);
  const post = await service.create({ ...task(f.project, 'POST'), source: { kind: 'http', schedule: { type: 'interval', everySeconds: 60 }, request: { method: 'POST', url: 'https://example.com/b', headers: [], body: '{}', timeoutSeconds: 5 }, condition: { type: 'every-success' } } as TriggerInput['source'] }, OWNER);
  service.close(); await service.settle();
  const state = JSON.parse(await f.file());
  const event = (status: TriggerEvent['status'], values: Partial<TriggerEvent>): TriggerEvent => ({ id: randomUUID(), triggerId: folder.id, triggerName: 'Folder', triggerRevision: 1, kind: 'manual', dedupKey: `manual:${randomUUID()}`,
    occurredAt: new Date(start).toISOString(), receivedAt: new Date(start).toISOString(), updatedAt: new Date(start).toISOString(), status, requestId: randomUUID(), claimedAt: new Date(start).toISOString(),
    input: { instructions: 'Work', provider: 'codex', approvals: 'auto', target: { node: 'local', mode: 'folder', cwd: f.project }, untrustedInput: false, overlap: 'parallel' }, summary: 'Run now', ...values });
  const listed = event('claimed', {});
  const routed = event('claimed', { input: { ...listed.input, target: { node: 'local', mode: 'auto' } } });
  const coordinator = event('claimed', { input: { ...listed.input, handler: 'coordinator', rules: [] } as TriggerEvent['input'] });
  const lost = event('claimed', {});
  state.events.push(listed, routed, coordinator, lost);
  state.cursors[get.id].polling = { slot: start, revision: 1, method: 'GET' };
  state.cursors[post.id].polling = { slot: start, revision: 1, method: 'POST' };
  await writeFile(join(f.directory, 'trigger-engine.json'), JSON.stringify(state), { mode: 0o600 });
  const run: Run = { id: randomUUID(), sessionId: `codex:${randomUUID()}`, prompt: 'Work', status: 'running', createdAt: '', output: '', autoPromptId: listed.requestId };
  f.runs.push(run);
  f.jobs.set(routed.requestId, { id: routed.requestId, provider: 'codex', prompt: 'Work', routerModel: 'r', status: 'queued', createdAt: '', updatedAt: '' });
  return { listed, routed, coordinator, lost, run, get, post };
}

test('recovered claims and cut-off polls are saved by the first commit at start', async t => {
  const f = await engine(t);
  const s = await seeded(f);
  Object.assign(f.calls, { create: 0, enqueue: 0, auto: 0, runs: 0, getAutoPrompt: 0 });
  await f.open();
  const saved = JSON.parse(await f.file());
  const status = (id: string) => saved.events.find((event: TriggerEvent) => event.id === id);
  assert.deepEqual([status(s.listed.id).status, status(s.listed.id).dispatch], ['running', { runId: s.run.id, sessionId: s.run.sessionId }]);
  assert.deepEqual([status(s.routed.id).status, status(s.routed.id).dispatch], ['running', {}]);
  assert.equal(status(s.coordinator.id).status, 'queued');
  assert.equal(status(s.coordinator.id).claimedAt, undefined);
  assert.equal(status(s.lost.id).status, 'uncertain');
  assert.ok(f.calls.runs > 0 && f.calls.getAutoPrompt > 0, 'the executor was asked what was admitted');
  assert.deepEqual([f.calls.create, f.calls.enqueue, f.calls.auto], [0, 0, 0], 'nothing was submitted');
  assert.equal(saved.cursors[s.get.id].polling, undefined);
  assert.equal(saved.cursors[s.post.id].polling, undefined);
  assert.equal(saved.cursors[s.get.id].lastError, undefined, 'a GET cut off by a stop leaves no error');
  assert.match(saved.cursors[s.post.id].lastError, /POST was being sent/);
});

test('when the first commit at start cannot be written, startup rejects and explicit retry preserves recovery without dispatch', async t => {
  const f = await engine(t);
  const s = await seeded(f);
  const before = await f.file();
  const original = fsPromises.open;
  t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof original>) => {
    if (String(args[0]).startsWith(join(f.directory, 'trigger-engine.json.')) && String(args[0]).endsWith('.tmp')) throw Object.assign(new Error('EIO: i/o error, open'), { code: 'EIO' });
    return original(...args);
  });
  syncBuiltinESMExports();
  const service = f.make();
  Object.assign(f.calls, { create: 0, enqueue: 0, auto: 0 });
  await assert.rejects(service.start(), /Cannot save triggers/);
  assert.deepEqual([f.calls.create, f.calls.enqueue, f.calls.auto], [0, 0, 0]);
  assert.equal(service.event(s.listed.id).status, 'running');
  assert.equal(service.event(s.lost.id).status, 'uncertain');
  await service.tick();
  assert.deepEqual([f.calls.create, f.calls.enqueue, f.calls.auto], [0, 0, 0], 'held engine tick cannot dispatch recovered work');
  assert.equal(await f.file(), before, 'the claims stay on disk');
  t.mock.restoreAll(); syncBuiltinESMExports();
  await service.start();
  assert.deepEqual([f.calls.create, f.calls.enqueue, f.calls.auto], [0, 0, 0], 'explicit retry recovers without dispatch');
  const saved = JSON.parse(await f.file());
  assert.equal(saved.events.find((event: TriggerEvent) => event.id === s.lost.id).status, 'uncertain', 'the next successful commit saves them');
});

test('a claim being submitted is never reconciled', async t => {
  const f = await engine(t);
  const service = await f.open();
  const trigger = await service.create(task(f.project, 'Slow'), OWNER);
  const other = await service.create(task(f.project, 'Other'), OWNER);
  let release!: () => void;
  f.hold(new Promise<void>(resolve => { release = resolve; }));
  await service.run(trigger.id, OWNER);
  for (let i = 0; i < 200 && f.calls.create === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(service.events()[0].status, 'claimed');
  await Promise.race([service.tick(), new Promise(resolve => setTimeout(resolve, 20))]);
  await service.run(other.id, OWNER);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(service.events().find(event => event.triggerId === trigger.id)!.status, 'claimed');
  release(); f.hold(undefined);
  await settled(service); await service.tick(); await settled(service);
  const event = service.events().find(item => item.triggerId === trigger.id)!;
  assert.equal(event.status, 'running');
  assert.equal(f.order.filter(name => name === 'Slow').length, 1, 'submitted exactly once');
});

test('a claimed coordinator event is queued again after a restart', async t => {
  const f = await engine(t);
  const s = await seeded(f);
  const service = await f.open();
  assert.equal(service.event(s.coordinator.id).status, 'queued');
  assert.equal(service.event(s.coordinator.id).claimedAt, undefined);
});

test('uncertain run admission records an uncertain trigger event and never submits again', async t => {
  const f = await engine(t); let submitted = 0;
  f.executor.create = async () => { submitted++; throw new RunAdmissionUncertain('receipt unresolved',{ commandId: 'trigger-fixed-commit',sha256: 'a'.repeat(64) }); };
  const service = await f.open(), trigger = await service.create(task(f.project,'Uncertain'),OWNER);
  await service.run(trigger.id,OWNER); await settled(service);
  assert.equal(service.overview().recent[0].status,'uncertain');
  await service.tick(); await settled(service); assert.equal(submitted,1);
  service.close(); await service.settle();
  const restarted = await f.open(); await restarted.tick(); await settled(restarted);
  assert.equal(restarted.overview().recent[0].status,'uncertain'); assert.equal(submitted,1);
});
