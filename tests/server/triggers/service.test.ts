import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { TriggerService, triggerRequestId, type TriggerExecutor } from '../../../server/triggers/service.js';
import type { RunAdmission } from '../../../server/runs/manager.js';
import type { AutoPromptJob, CreateSessionRequest, Run, Session } from '../../../shared/types.js';
import type { TriggerActor, TriggerInput } from '../../../shared/triggers.js';

const OWNER: TriggerActor = { kind: 'owner', via: 'ui' };
const AGENT: TriggerActor = { kind: 'agent', via: 'mcp', sessionId: 'codex:agent', runId: randomUUID() };
const HOUR = 60 * 60 * 1000;
const start = Date.parse('2026-09-24T00:00:30.000Z');

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-triggers-'));
  const project = join(directory, 'project');
  await mkdir(project);
  const clock = { now: start };
  const runs: Run[] = [];
  const jobs = new Map<string, AutoPromptJob>();
  const calls: Array<{ kind: 'create' | 'enqueue' | 'auto'; input: unknown; internal: RunAdmission }> = [];
  const sessions = new Map<string, Session>([['claude:existing', { id: 'claude:existing', nativeId: 'n', provider: 'claude', title: 'Existing', cwd: project, project: 'project',
    status: 'idle', statusReason: '', createdAt: '', updatedAt: '', lastMessage: '', messageCount: 1, isSubagent: false, resumable: true }]]);
  const record = (sessionId: string, prompt: string, internal: RunAdmission): Run => {
    const run: Run = { id: randomUUID(), sessionId, prompt, status: 'running', createdAt: new Date(clock.now).toISOString(), output: '', autoPromptId: internal.autoPromptId, origin: internal.origin };
    runs.push(run); return run;
  };
  const executor: TriggerExecutor = {
    submitAutoPrompt: async (request, internal) => {
      calls.push({ kind: 'auto', input: request, internal });
      const run = record(`codex:${randomUUID()}`, request.prompt, { ...internal, autoPromptId: request.requestId });
      const job: AutoPromptJob = { id: request.requestId, provider: request.provider, prompt: request.prompt, routerModel: 'r', status: 'completed', createdAt: '', updatedAt: '',
        runId: run.id, sessionId: run.sessionId, decision: { action: 'create', cwd: project, reason: 'new' } };
      jobs.set(job.id, job); return job;
    },
    getAutoPrompt: id => jobs.get(id),
    create: async (input: CreateSessionRequest, internal) => {
      calls.push({ kind: 'create', input, internal });
      const id = `${input.provider}:${randomUUID()}`;
      const run = record(id, input.prompt, internal);
      return { run, session: { ...sessions.get('claude:existing')!, id, provider: input.provider } };
    },
    enqueue: async (sessionId, prompt, request, internal) => { calls.push({ kind: 'enqueue', input: { sessionId, prompt, request }, internal }); return record(sessionId, prompt, internal); },
    runs: () => structuredClone(runs),
    session: id => sessions.get(id),
  };
  const services: TriggerService[] = [];
  const open = async (limits?: { acceptBytes?: number; maxBytes?: number }) => {
    const service = new TriggerService({ stateDir: directory, executor, now: () => clock.now, tickMs: 60_000, ...(limits ? { limits } : {}) });
    await service.start();
    services.push(service);
    return service;
  };
  // Saves still under way are waited for, or removing the folder races a write into it.
  t.after(async () => { for (const service of services) service.close(); await Promise.all(services.map(service => service.settle())); await rm(directory, { recursive: true, force: true, maxRetries: 3 }); });
  const finish = (status: Run['status'] = 'completed') => { for (const run of runs) if (run.status === 'running') run.status = status; };
  return { directory, project, clock, runs, jobs, calls, sessions, executor, open, finish };
}

const hourly = (project: string, values: Partial<TriggerInput> = {}): TriggerInput => ({
  name: 'Hourly report', enabled: true,
  source: { kind: 'schedule', schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' }, catchUp: 'latest' },
  handler: { kind: 'task', instructions: 'Summarize open issues', provider: 'codex', approvals: 'auto', target: { node: 'local', mode: 'folder', cwd: project } },
  policy: { overlap: 'skip', maxEventsPerHour: 20 }, ...values,
});

test('a schedule fires once for each time it is due, and a restart never fires that time again', async t => {
  const f = await fixture(t);
  let service = await f.open();
  const trigger = await service.create(hourly(f.project), OWNER);
  f.clock.now = Date.parse('2026-09-24T01:00:05.000Z');
  await service.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(service.events()[0].dedupKey, '2026-09-24T01:00:00.000Z');
  assert.equal(service.events()[0].status, 'running');
  service.close();
  service = await f.open();
  await service.tick();
  assert.equal(f.calls.length, 1, 'the same scheduled time never runs twice');
  f.finish();
  await service.tick();
  assert.equal(service.events()[0].status, 'completed');
  assert.equal(service.overview().triggers.find(item => item.id === trigger.id)?.nextRunAt, '2026-09-24T02:00:00.000Z');
});

test('after sleep, only the latest missed time runs once; skip runs none', async t => {
  const f = await fixture(t);
  const service = await f.open();
  const latest = await service.create(hourly(f.project), OWNER);
  const skipped = await service.create(hourly(f.project, { name: 'Skip missed', source: { kind: 'schedule', schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' }, catchUp: 'skip' } }), OWNER);
  f.clock.now = Date.parse('2026-09-24T05:30:00.000Z');
  await service.tick();
  const events = service.events();
  assert.deepEqual(events.map(event => [event.triggerId, event.dedupKey]), [[latest.id, '2026-09-24T05:00:00.000Z']]);
  assert.equal(service.overview().triggers.find(item => item.id === skipped.id)?.nextRunAt, '2026-09-24T06:00:00.000Z');
});

test('a clock that moves backwards never fires a time again', async t => {
  const f = await fixture(t);
  const service = await f.open();
  await service.create(hourly(f.project, { policy: { overlap: 'parallel', maxEventsPerHour: 20 } }), OWNER);
  f.clock.now = Date.parse('2026-09-24T01:00:05.000Z');
  await service.tick();
  f.clock.now = Date.parse('2026-09-24T00:59:00.000Z');
  await service.tick();
  f.clock.now = Date.parse('2026-09-24T01:00:30.000Z');
  await service.tick();
  assert.equal(service.events().length, 1);
});

test('while its previous run works, a trigger skips, queues one run, or runs in parallel as configured', async t => {
  for (const overlap of ['skip', 'queue', 'parallel'] as const) await t.test(overlap, async t => {
    const f = await fixture(t);
    const service = await f.open();
    const trigger = await service.create(hourly(f.project, { policy: { overlap, maxEventsPerHour: 20 } }), OWNER);
    await service.run(trigger.id, OWNER);
    await service.tick();
    await service.run(trigger.id, OWNER);
    await service.run(trigger.id, OWNER);
    await service.tick();
    const statuses = service.events().map(event => event.status).reverse();
    if (overlap === 'skip') assert.deepEqual(statuses, ['running', 'skipped', 'skipped']);
    if (overlap === 'queue') assert.deepEqual(statuses, ['running', 'queued', 'coalesced']);
    if (overlap === 'parallel') assert.deepEqual(statuses, ['running', 'running', 'running']);
    f.finish(); await service.tick(); await service.tick();
    if (overlap === 'queue') assert.equal(f.calls.length, 2, 'the waiting run starts after the previous one');
  });
});

test('too many runs in an hour pause the trigger until it is turned on again', async t => {
  const f = await fixture(t);
  const service = await f.open();
  let trigger = await service.create(hourly(f.project, { policy: { overlap: 'parallel', maxEventsPerHour: 2 } }), OWNER);
  for (let index = 0; index < 3; index++) await service.run(trigger.id, OWNER).catch(() => {});
  const summary = service.overview().triggers.find(item => item.id === trigger.id)!;
  assert.match(summary.paused?.reason ?? '', /more than 2 runs/);
  assert.equal(summary.nextRunAt, undefined);
  trigger = await service.setEnabled(trigger.id, false, trigger.revision, OWNER);
  await service.setEnabled(trigger.id, true, trigger.revision, OWNER);
  assert.equal(service.overview().triggers.find(item => item.id === trigger.id)?.paused, undefined);
});

test('a claim saved before a crash is matched to its run or reported uncertain, never submitted twice', async t => {
  const f = await fixture(t);
  let service = await f.open();
  const trigger = await service.create(hourly(f.project), OWNER);
  service.close();
  const path = join(f.directory, 'trigger-engine.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  const claimed = (dedupKey: string) => ({ id: randomUUID(), triggerId: trigger.id, triggerName: trigger.name, triggerRevision: 1, kind: 'schedule', dedupKey,
    occurredAt: dedupKey, receivedAt: dedupKey, updatedAt: dedupKey, status: 'claimed', requestId: triggerRequestId(trigger.id, dedupKey),
    input: { instructions: 'x', provider: 'codex', approvals: 'auto', target: { node: 'local', mode: 'folder', cwd: f.project }, untrustedInput: false }, summary: '' });
  state.events = [claimed('2026-09-23T22:00:00.000Z'), claimed('2026-09-23T23:00:00.000Z')];
  await writeFile(path, JSON.stringify(state));
  f.runs.push({ id: randomUUID(), sessionId: 'codex:admitted', prompt: '', status: 'running', createdAt: '', output: '', autoPromptId: state.events[1].requestId });
  service = await f.open();
  assert.deepEqual(service.events().map(event => event.status), ['running', 'uncertain']);
  await service.tick();
  assert.equal(f.calls.length, 0);
});

test('a folder target never creates the folder and only trusts folders the owner chose', async t => {
  const f = await fixture(t);
  const service = await f.open();
  const owner = await service.create(hourly(f.project), OWNER);
  const agentFolder = join(f.directory, 'agent-folder');
  await mkdir(agentFolder);
  const agent = await service.create(hourly(agentFolder, { name: 'Agent made' }), AGENT);
  await service.run(owner.id, OWNER);
  await service.run(agent.id, OWNER);
  await service.tick();
  assert.deepEqual(f.calls.map(call => [call.internal.createFolder, call.internal.trustWorkspace]), [[false, true], [false, false]]);
  await assert.rejects(service.create(hourly(join(f.directory, 'missing')), OWNER), /does not exist/);
  f.finish(); await service.tick();
  await rm(agentFolder, { recursive: true });
  await service.run(agent.id, OWNER);
  await service.tick();
  assert.match(service.events()[0].error ?? '', /no longer exists/);
});

test('unattended runs use each provider’s automatic approval; owner approval changes nothing', async t => {
  const f = await fixture(t);
  const service = await f.open();
  const codex = await service.create(hourly(f.project), OWNER);
  const claude = await service.create(hourly(f.project, { name: 'Claude', handler: { kind: 'task', instructions: 'x', provider: 'claude', approvals: 'auto', target: { node: 'local', mode: 'auto' } } }), OWNER);
  const watched = await service.create(hourly(f.project, { name: 'Watched', handler: { kind: 'task', instructions: 'x', provider: 'codex', approvals: 'owner', target: { node: 'local', mode: 'folder', cwd: f.project } } }), OWNER);
  for (const trigger of [codex, claude, watched]) { await service.run(trigger.id, OWNER); await service.tick(); }
  const [first, second, third] = f.calls;
  assert.equal((first.input as CreateSessionRequest).codexApprovalsReviewer, 'auto_review');
  assert.equal(first.internal.unattended, true);
  assert.equal(second.kind, 'auto');
  assert.equal(second.internal.unattended, true);
  assert.deepEqual(second.internal.origin, { kind: 'trigger', triggerId: claude.id, eventId: service.events().find(event => event.triggerId === claude.id)!.id });
  assert.equal((third.input as CreateSessionRequest).codexApprovalsReviewer, undefined);
  assert.equal(third.internal.unattended, false);
});

test('a session target continues that session only with its own agent', async t => {
  const f = await fixture(t);
  const service = await f.open();
  const target = { node: 'local' as const, mode: 'session' as const, sessionId: 'claude:existing' };
  await assert.rejects(service.create(hourly(f.project, { handler: { kind: 'task', instructions: 'x', provider: 'codex', approvals: 'auto', target } }), OWNER), /claude session/);
  const trigger = await service.create(hourly(f.project, { handler: { kind: 'task', instructions: 'Daily check-in', provider: 'claude', approvals: 'auto', target } }), OWNER);
  await service.run(trigger.id, OWNER);
  await service.tick();
  assert.equal(f.calls[0].kind, 'enqueue');
  assert.equal((f.calls[0].input as { sessionId: string }).sessionId, 'claude:existing');
  assert.match((f.calls[0].input as { prompt: string }).prompt, /Daily check-in/);
});

test('every change is audited, earlier revisions can be restored, and a stale revision is refused', async t => {
  const f = await fixture(t);
  const service = await f.open();
  const created = await service.create(hourly(f.project), AGENT);
  const updated = await service.update(created.id, hourly(f.project, { name: 'Renamed' }), created.revision, OWNER);
  await assert.rejects(service.update(created.id, hourly(f.project, { name: 'Stale' }), created.revision, OWNER), { statusCode: 409 });
  const reverted = await service.revert(created.id, 1, updated.revision, OWNER);
  assert.equal(reverted.name, 'Hourly report');
  assert.equal(reverted.revision, 3);
  await service.remove(created.id, reverted.revision, OWNER);
  const restored = await service.restore(created.id, OWNER);
  assert.equal(restored.enabled, false, 'a restored trigger starts turned off');
  assert.deepEqual(service.audit().map(entry => [entry.action, entry.actor.kind]).reverse(),
    [['create', 'agent'], ['update', 'owner'], ['revert', 'owner'], ['delete', 'owner'], ['restore', 'owner']]);
  assert.equal(service.audit().at(-1)?.actor.sessionId, 'codex:agent');
});

test('turning a trigger off cancels runs that are waiting but never ones already running', async t => {
  const f = await fixture(t);
  const service = await f.open();
  let trigger = await service.create(hourly(f.project, { policy: { overlap: 'queue', maxEventsPerHour: 20 } }), OWNER);
  await service.run(trigger.id, OWNER); await service.tick();
  await service.run(trigger.id, OWNER);
  trigger = await service.setEnabled(trigger.id, false, trigger.revision, OWNER);
  assert.deepEqual(service.events().map(event => event.status).reverse(), ['running', 'cancelled']);
  assert.equal(f.runs[0].status, 'running');
});

test('a state file that cannot be saved stops new runs and says why', async t => {
  const f = await fixture(t);
  const service = await f.open();
  const trigger = await service.create(hourly(f.project), OWNER);
  const path = join(f.directory, 'trigger-engine.json');
  await rm(path); await mkdir(path);
  f.clock.now = Date.parse('2026-09-24T01:00:05.000Z');
  await service.tick();
  assert.equal(f.calls.length, 0);
  assert.match(service.overview().storageError ?? '', /Cannot save triggers/);
  await assert.rejects(service.run(trigger.id, OWNER), { statusCode: 503 });
  await rm(path, { recursive: true });
  await service.tick();
  assert.equal(service.overview().storageError, undefined);
  assert.equal(f.calls.length, 1, 'the due time runs once the state can be saved');
});

test('unreadable trigger state is moved aside instead of guessed', async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'trigger-engine.json'), '{ not json', { mode: 0o600 });
  const service = await f.open();
  assert.equal(service.list().length, 0);
  assert.ok((await readdir(f.directory)).some(name => name.startsWith('trigger-engine.json.unreadable-')));
});

test('schedules refuse second-level cron and unknown time zones', async t => {
  const f = await fixture(t);
  const service = await f.open();
  for (const schedule of [{ type: 'cron', expression: '* * * * * *', timezone: 'UTC' }, { type: 'cron', expression: '0 9 * * *', timezone: 'Mars/Base' }] as const) {
    await assert.rejects(service.create(hourly(f.project, { source: { kind: 'schedule', schedule, catchUp: 'latest' } }), OWNER), { statusCode: 400 });
  }
  assert.deepEqual(service.preview({ type: 'cron', expression: '30 1 * * *', timezone: 'America/New_York' }).slice(0, 1), ['2026-09-24T05:30:00.000Z']);
});

test('a time that does not exist on a daylight-saving day is skipped, and a repeated hour runs once', async t => {
  const f = await fixture(t);
  f.clock.now = Date.parse('2026-10-31T12:00:00.000Z');
  const service = await f.open();
  assert.deepEqual(service.preview({ type: 'cron', expression: '30 1 * * *', timezone: 'America/New_York' }).slice(0, 2), ['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z']);
  f.clock.now = Date.parse('2027-03-13T12:00:00.000Z');
  assert.deepEqual(service.preview({ type: 'cron', expression: '30 2 * * *', timezone: 'America/New_York' }).slice(0, 2), ['2027-03-15T06:30:00.000Z', '2027-03-16T06:30:00.000Z']);
  assert.equal(HOUR, 3_600_000);
});

test('after a short sleep that spans two times, only the latest one runs', async t => {
  const f = await fixture(t);
  const service = await f.open();
  await service.create(hourly(f.project, { source: { kind: 'schedule', schedule: { type: 'interval', everySeconds: 60 }, catchUp: 'latest' } }), OWNER);
  f.clock.now = start + 2 * 60_000 + 10_000;
  await service.tick();
  assert.deepEqual(service.events().map(event => event.dedupKey), [new Date(start + 2 * 60_000).toISOString()]);
});

test('if the result of a submission cannot be saved, it is matched to its run later and never submitted again', async t => {
  const f = await fixture(t);
  const service = await f.open();
  const trigger = await service.create(hourly(f.project), OWNER);
  const path = join(f.directory, 'trigger-engine.json');
  const create = f.executor.create;
  f.executor.create = async (input, internal) => { const result = await create(input, internal); await rm(path); await mkdir(path); return result; };
  await service.run(trigger.id, OWNER);
  await service.tick();
  assert.equal(service.events()[0].status, 'claimed');
  await rm(path, { recursive: true });
  f.executor.create = create;
  await service.tick();
  assert.equal(service.events()[0].status, 'running');
  assert.equal(service.inFlight(), false, 'a matched claim no longer holds up a worker handoff');
  assert.equal(f.calls.length, 1);
});

test('turning a trigger off by editing or reverting also cancels waiting runs, and waiting runs keep the policy they fired under', async t => {
  const f = await fixture(t);
  const service = await f.open();
  let trigger = await service.create(hourly(f.project, { policy: { overlap: 'queue', maxEventsPerHour: 20 } }), OWNER);
  await service.run(trigger.id, OWNER); await service.tick();
  await service.run(trigger.id, OWNER);
  trigger = await service.update(trigger.id, hourly(f.project, { policy: { overlap: 'parallel', maxEventsPerHour: 20 } }), trigger.revision, OWNER);
  await service.tick();
  assert.equal(service.events()[0].status, 'queued', 'a run queued under “keep one waiting” still waits after the policy changes');
  await service.update(trigger.id, hourly(f.project, { enabled: false, policy: { overlap: 'parallel', maxEventsPerHour: 20 } }), trigger.revision, OWNER);
  assert.deepEqual(service.events().map(event => event.status).reverse(), ['running', 'cancelled']);
  f.finish(); await service.tick();
  assert.equal(f.calls.length, 1);
});

test('when trigger history is full, new runs and definitions stop but accepted runs still record how they end', async t => {
  const f = await fixture(t);
  let service = await f.open();
  const trigger = await service.create(hourly(f.project, { handler: { kind: 'task', instructions: 'x'.repeat(4000), provider: 'codex', approvals: 'auto', target: { node: 'local', mode: 'folder', cwd: f.project } } }), OWNER);
  await service.run(trigger.id, OWNER);
  await service.tick();
  service.close();
  const size = (await readFile(join(f.directory, 'trigger-engine.json'))).byteLength;
  service = await f.open({ acceptBytes: size - 1, maxBytes: size + 5000 });
  await assert.rejects(service.create(hourly(f.project, { name: 'One more' }), OWNER), { statusCode: 507 });
  await assert.rejects(service.run(trigger.id, OWNER), { statusCode: 507 });
  assert.match(service.overview().storageError ?? '', /history is full/);
  for (const run of f.runs) Object.assign(run, { status: 'error', error: 'The provider failed: '.padEnd(1400, '.') });
  await service.tick();
  assert.equal(service.events()[0].status, 'error', 'the running run still records its outcome in the reserved space');
});

test('hourly limits count every recent firing, even ones no longer in the history', async t => {
  const f = await fixture(t);
  let service = await f.open();
  const trigger = await service.create(hourly(f.project, { policy: { overlap: 'parallel', maxEventsPerHour: 60 } }), OWNER);
  await service.updateSettings({ maxTriggers: 50, maxConcurrentRuns: 3, maxEventsPerHour: 5 }, OWNER);
  service.close();
  const path = join(f.directory, 'trigger-engine.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  state.recentFires = Array.from({ length: 5 }, (_, index) => ({ at: start - index * 1000, triggerId: 'another-trigger' }));
  await writeFile(path, JSON.stringify(state));
  service = await f.open();
  const event = await service.run(trigger.id, OWNER);
  assert.equal(event.status, 'skipped');
  assert.match(event.reason ?? '', /all triggers together reached 5/);
});

test('a trigger at its record limit adds nothing more and says so', async t => {
  const f = await fixture(t);
  let service = await f.open();
  const trigger = await service.create(hourly(f.project), OWNER);
  service.close();
  const path = join(f.directory, 'trigger-engine.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  for (let index = 0; index < 20_000; index++) state.fired[`${trigger.id} old:${index}`] = new Date(start - 1000).toISOString();
  await writeFile(path, JSON.stringify(state));
  service = await f.open();
  await assert.rejects(service.run(trigger.id, OWNER), { statusCode: 409 });
  assert.match(service.overview().storageError ?? '', /20000 runs recorded/);
  assert.equal(Object.keys(JSON.parse(await readFile(path, 'utf8')).fired).length, 20_000);
});

test('with history full, a trigger can still be turned off or deleted, and a schedule moves on with a warning', async t => {
  const f = await fixture(t);
  let service = await f.open();
  const first = await service.create(hourly(f.project, { policy: { overlap: 'parallel', maxEventsPerHour: 20 } }), OWNER);
  const second = await service.create(hourly(f.project, { name: 'Second' }), OWNER);
  service.close();
  const size = (await readFile(join(f.directory, 'trigger-engine.json'))).byteLength;
  // Room for nothing new: the next recorded run would cross the acceptance limit.
  service = await f.open({ acceptBytes: size + 50, maxBytes: size + 20_000 });
  f.clock.now = Date.parse('2026-09-24T01:00:05.000Z');
  await service.tick();
  assert.equal(f.calls.length, 0);
  assert.match(service.overview().storageError ?? '', /skipped a scheduled run because trigger history is full/);
  assert.equal(service.overview().triggers.find(item => item.id === first.id)?.nextRunAt, '2026-09-24T02:00:00.000Z', 'the schedule moved on');
  const off = await service.setEnabled(first.id, false, first.revision, OWNER);
  assert.equal(off.enabled, false);
  await service.remove(second.id, second.revision, OWNER);
  assert.deepEqual(service.list().map(trigger => trigger.id), [first.id]);
});

test('a run fired before its trigger was turned off never starts, even if the trigger is turned on again', async t => {
  const f = await fixture(t);
  const service = await f.open();
  let trigger = await service.create(hourly(f.project, { policy: { overlap: 'parallel', maxEventsPerHour: 20 } }), OWNER);
  const before = await service.run(trigger.id, OWNER);
  assert.equal(service.launchAllowed(trigger.id, before.id), true);
  f.clock.now += 1000;
  trigger = await service.setEnabled(trigger.id, false, trigger.revision, OWNER);
  f.clock.now += 1000;
  trigger = await service.setEnabled(trigger.id, true, trigger.revision, OWNER);
  assert.equal(service.launchAllowed(trigger.id, before.id), false, 'the older run stays stopped');
  f.clock.now += 1000;
  const after = await service.run(trigger.id, OWNER);
  assert.equal(service.launchAllowed(trigger.id, after.id), true);
  assert.equal(service.launchAllowed('deleted-trigger', after.id), false);
});

test('turning a trigger on and off keeps no copies of its definition, so it never fills history', async t => {
  const f = await fixture(t);
  const service = await f.open();
  let trigger = await service.create(hourly(f.project), OWNER);
  for (let index = 0; index < 30; index++) trigger = await service.setEnabled(trigger.id, index % 2 === 1, trigger.revision, OWNER);
  assert.equal(trigger.revision, 31);
  assert.equal(service.get(trigger.id).revisions.length, 0);
  assert.equal(service.audit().filter(entry => entry.action === 'enable' || entry.action === 'disable').length, 30);
});

test('deleting and restoring a trigger never lets runs fired before the deletion start', async t => {
  const f = await fixture(t);
  const service = await f.open();
  let trigger = await service.create(hourly(f.project, { policy: { overlap: 'parallel', maxEventsPerHour: 20 } }), OWNER);
  const before = await service.run(trigger.id, OWNER);
  f.clock.now += 1000;
  await service.remove(trigger.id, trigger.revision, OWNER);
  f.clock.now += 1000;
  trigger = await service.restore(trigger.id, OWNER);
  trigger = await service.setEnabled(trigger.id, true, trigger.revision, OWNER);
  assert.equal(service.launchAllowed(trigger.id, before.id), false);
});

test('run history pages by position, so runs recorded at the same moment are never skipped, and one run reads after its trigger is gone', async t => {
  const f = await fixture(t);
  const service = await f.open();
  const trigger = await service.create({ ...hourly(f.project), policy: { overlap: 'parallel', maxEventsPerHour: 60 } }, OWNER);
  for (let index = 0; index < 5; index++) await service.run(trigger.id, OWNER);
  const all = service.events({ limit: 200 });
  assert.equal(all.length, 5);
  assert.ok(all.every(event => event.receivedAt === all[0].receivedAt), 'the clock did not move, so every run shares one time');
  const first = service.events({ limit: 2 });
  const second = service.events({ limit: 2, beforeId: first.at(-1)!.id });
  const third = service.events({ limit: 2, beforeId: second.at(-1)!.id });
  assert.deepEqual([...first, ...second, ...third].map(event => event.id), all.map(event => event.id));
  assert.deepEqual(service.events({ limit: 2, before: all[0].receivedAt }), [], 'a time cursor alone would skip them');
  await service.remove(trigger.id, trigger.revision, OWNER);
  assert.equal(service.event(all[0].id).triggerName, trigger.name);
  assert.throws(() => service.event('missing'), /no longer in trigger history/);
});

test('the live overview also carries older runs that are still working or just finished', async t => {
  const f = await fixture(t);
  const service = await f.open();
  const trigger = await service.create({ ...hourly(f.project), policy: { overlap: 'parallel', maxEventsPerHour: 60 } }, OWNER);
  const first = await service.run(trigger.id, OWNER);
  for (let wait = 0; service.events({ limit: 1 })[0]?.status !== 'running' && wait < 100; wait++) await new Promise(resolve => setTimeout(resolve, 10));
  for (let index = 0; index < 25; index++) { f.clock.now += 1000; await service.run(trigger.id, OWNER); }
  let overview = service.overview();
  assert.equal(overview.recent.length, 20);
  assert.ok(!overview.recent.some(event => event.id === first.id));
  assert.equal(overview.updated?.find(event => event.id === first.id)?.status, 'running', 'still working, so still live');
  assert.equal(overview.updated?.find(event => event.id === first.id)?.input.instructions, '');
  f.finish();
  f.clock.now += 1000;
  // The tick a manual run started may still be finishing; the next one sees the finished run.
  await service.tick();
  await service.tick();
  overview = service.overview();
  assert.equal(overview.updated?.find(event => event.id === first.id)?.status, 'completed', 'its finish reaches the monitor too');
});

