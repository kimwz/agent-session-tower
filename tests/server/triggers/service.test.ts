import assert from 'node:assert/strict';
import { collectTriggers } from '../../../server/backup/payload.js';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { TriggerService, triggerRequestId, type TriggerExecutor } from '../../../server/triggers/service.js';
import type { RunAdmission } from '../../../server/runs/manager.js';
import type { AutoPromptJob, CreateSessionRequest, Run, Session } from '../../../shared/types.js';
import type { TriggerActor, TriggerInput } from '../../../shared/triggers.js';
import { asideNames, blockQuarantine, captureErrors } from '../../helpers/quarantine.js';

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

test('trigger state of the wrong shape is moved aside and triggers start empty', async t => {
  const f = await fixture(t);
  const path = join(f.directory, 'trigger-engine.json');
  await writeFile(path, '[]', { mode: 0o600 });
  const logged = captureErrors(t, path);
  const service = await f.open();
  assert.equal(service.list().length, 0);
  const [aside] = await asideNames(path);
  assert.equal(await readFile(join(f.directory, aside), 'utf8'), '[]');
  assert.equal(logged[0].args[0], 'Trigger state could not be read and was moved aside:');
  assert.equal((logged[0].args[1] as Error).message, 'Saved trigger state is invalid.');
  assert.equal(logged[0].present, true, 'logged before the move');
});

test('trigger state with an invalid once ledger is moved aside', async t => {
  for (const onceConsumed of [[], { id: { bad: 1 } }]) {
    const f = await fixture(t);
    let service = await f.open();
    await service.create(hourly(f.project), OWNER);
    service.close(); await service.settle();
    const path = join(f.directory, 'trigger-engine.json');
    const saved = JSON.parse(await readFile(path, 'utf8'));
    saved.onceConsumed = onceConsumed;
    const text = JSON.stringify(saved);
    await writeFile(path, text);
    service = await f.open();
    assert.equal(service.list().length, 0, JSON.stringify(onceConsumed));
    const [aside] = await asideNames(path);
    assert.equal(await readFile(join(f.directory, aside), 'utf8'), text);
  }
});

test('trigger state that cannot be moved aside is logged and triggers still start', async t => {
  const f = await fixture(t);
  const path = join(f.directory, 'trigger-engine.json');
  await writeFile(path, '{ not json', { mode: 0o600 });
  const blocked = await blockQuarantine(t, path);
  const logged = captureErrors(t, path);
  const service = await f.open();
  blocked.release();
  assert.equal(service.list().length, 0);
  assert.equal(logged[0].args[0], 'Trigger state could not be read and was moved aside:');
  assert.ok(logged[0].args[1] instanceof SyntaxError);
  assert.deepEqual(await readdir(blocked.aside), ['occupied'], 'the move failed');
});

test('trigger secrets that were moved aside are shown on the triggers page', async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'trigger-secrets.json'), '{}', { mode: 0o600 });
  captureErrors(t, join(f.directory, 'trigger-secrets.json'));
  const service = await f.open();
  assert.match(service.overview().storageError ?? '', /^Trigger secrets could not be read and were kept as .*trigger-secrets\.json\.unreadable-\d+; triggers that use them fail until they are entered again\.$/);
});

test('trigger state that cannot be moved aside is never written over', async t => {
  const f = await fixture(t);
  const path = join(f.directory, 'trigger-engine.json');
  const original = '{ "version": 1, "triggers": [ not json';
  await writeFile(path, original, { mode: 0o600 });
  const blocked = await blockQuarantine(t, path);
  captureErrors(t, path);
  const service = await f.open();
  blocked.release();
  const locked = /Trigger state could not be read or moved aside; nothing is saved until Tower restarts\./;
  assert.match(service.overview().storageError ?? '', locked);
  f.clock.now += 2 * HOUR;
  await service.tick();
  await assert.rejects(service.create(hourly(f.project), OWNER), { statusCode: 503, message: locked });
  const backup = { triggers: [{ ...hourly(f.project), id: randomUUID(), revision: 1, createdAt: '', updatedAt: '', updatedBy: OWNER }], settings: service.settings(), trustedFolders: [f.project], secretGrants: {}, fired: {}, github: {} };
  await assert.rejects(service.restoreBackup(backup as any), { statusCode: 503 });
  await service.flush();
  assert.equal(service.inFlight(), false);
  await service.settle();
  assert.equal(f.calls.length, 0);
  assert.equal(await readFile(path, 'utf8'), original);
  assert.deepEqual((await readdir(f.directory)).filter(name => name.startsWith('trigger-engine.json')).sort(), ['trigger-engine.json', basename(blocked.aside)].sort(), 'no other state file is written');
  assert.match(service.overview().storageError ?? '', locked);
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


// A calendar cron is recurrent even with a day and month. Once reservations must persist their consumption.
test('an explicit once reservation survives restart without another year, retaining run details and audit', async t => {
  const f = await fixture(t);
  let service = await f.open();
  const trigger = await service.create(hourly(f.project, { source: { kind: 'schedule', schedule: { type: 'once', at: '2026-09-24T10:00:00+09:00' }, catchUp: 'latest' } }), OWNER);
  f.clock.now = Date.parse('2026-09-24T01:00:05Z');
  await Promise.all([service.tick(), service.tick()]);
  assert.equal(f.calls.length, 1);
  const event = service.events({ triggerId: trigger.id })[0];
  assert.equal(event.status, 'running');
  assert.equal(service.launchAllowed(trigger.id, event.id), true, 'automatic consumption must still admit its queued run');
  assert.equal(service.list().some(item => item.id === trigger.id), false);
  assert.equal(service.get(trigger.id).trigger.enabled, false);
  assert.equal(service.event(event.id).input.instructions, 'Summarize open issues');
  await assert.rejects(service.setEnabled(trigger.id, true, service.get(trigger.id).trigger.revision, OWNER), /consumed/i);
  await assert.rejects(service.run(trigger.id, OWNER), /consumed/i);
  f.finish('error');
  await service.tick();
  service.close();
  service = await f.open();
  f.clock.now += 366 * 24 * HOUR;
  await service.tick();
  assert.equal(f.calls.length, 1, 'failure never automatically reissues a reservation');
  assert.equal(service.event(event.id).status, 'error');
  assert.equal(service.events({ triggerId: trigger.id }).length, 1);
  assert.ok(service.audit().some(item => item.triggerId === trigger.id && item.action === 'consume'));
});

test('late once reservations are consumed, latest runs after long downtime while skip records the missed reservation', async t => {
  const f = await fixture(t);
  const service = await f.open();
  const source = { kind: 'schedule', schedule: { type: 'once', at: '2026-09-24T01:00:00Z' }, catchUp: 'latest' } as const;
  const latest = await service.create(hourly(f.project, { source }), OWNER);
  const skip = await service.create(hourly(f.project, { source: { ...source, catchUp: 'skip' } }), OWNER);
  f.clock.now += 3 * 24 * HOUR;
  await service.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(service.events({ triggerId: latest.id })[0].status, 'running');
  assert.equal(service.events({ triggerId: skip.id })[0].status, 'skipped');
  assert.equal(service.list().length, 0);
});

test('once manual calls race with the scheduler as a single reservation; explicit cancellation still prevents launch', async t => {
  const f = await fixture(t);
  const service = await f.open();
  await service.updateSettings({ maxConcurrentRuns: 1 }, OWNER);
  await service.run((await service.create(hourly(f.project), OWNER)).id, OWNER);
  await service.tick();
  const trigger = await service.create(hourly(f.project, { source: { kind: 'schedule', schedule: { type: 'once', at: '2026-09-24T01:00:00Z' }, catchUp: 'latest' } }), OWNER);
  const results = await Promise.allSettled([service.run(trigger.id, OWNER), service.run(trigger.id, OWNER)]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  const event = service.events({ triggerId: trigger.id })[0];
  assert.equal(event.status, 'queued');
  const current = service.get(trigger.id).trigger;
  await service.setEnabled(trigger.id, false, current.revision, OWNER);
  assert.equal(service.launchAllowed(trigger.id, event.id), false);
  assert.equal(service.event(event.id).status, 'cancelled');
  f.finish();
  await service.tick();
  assert.equal(f.calls.length, 1);
});

test('archiving is explicit, preserves disabled recurring triggers and refuses unfinished work', async t => {
  const f = await fixture(t);
  const service = await f.open();
  const repeat = await service.create(hourly(f.project, { enabled: false, name: 'once in the name is still recurring' }), OWNER);
  assert.equal(service.list().length, 1, 'disabled repeating definitions never disappear by inference');
  const archived = await service.setArchived(repeat.id, true, repeat.revision, OWNER);
  assert.equal(service.list().length, 0);
  assert.equal(service.get(repeat.id).trigger.name, repeat.name);
  assert.equal(service.list({ includeArchived: true }).length, 1);
  await service.setArchived(repeat.id, false, archived.revision, OWNER);
  assert.equal(service.list()[0].enabled, false, 'unarchive never silently restarts work');
  const run = await service.create(hourly(f.project), OWNER);
  await service.run(run.id, OWNER);
  await service.tick();
  await assert.rejects(service.setArchived(run.id, true, run.revision, OWNER), /unfinished|working|running/i);
  assert.equal(f.runs[0].status, 'running', 'archive failure leaves running work alone');
});

test('a consumed once remains consumed through delete, restore, revert and an older backup', async t => {
  const f = await fixture(t);
  const service = await f.open();
  const trigger = await service.create(hourly(f.project, { source: { kind: 'schedule', schedule: { type: 'once', at: '2026-09-24T01:00:00Z' }, catchUp: 'latest' } }), OWNER);
  const olderBackup = { triggers: [trigger], settings: service.settings(), trustedFolders: [f.project], secretGrants: {}, fired: {}, github: {} };
  await service.run(trigger.id, OWNER);
  await service.tick(); f.finish(); await service.tick();
  let current = service.get(trigger.id).trigger;
  await service.remove(current.id, current.revision, OWNER);
  current = await service.restore(current.id, OWNER);
  await assert.rejects(service.setEnabled(current.id, true, current.revision, OWNER), /consumed/i);
  await service.restoreBackup(olderBackup);
  current = service.get(current.id).trigger;
  assert.equal(current.enabled, false);
  await assert.rejects(service.run(current.id, OWNER), /consumed/i);
  assert.equal(f.calls.length, 1);
  assert.equal(service.events({ triggerId: current.id }).length, 1, 'backup restore never drops its run record');
});

test('once storage failure and capacity exhaustion keep the original reservation pending', async t => {
  const f = await fixture(t);
  const service = await f.open();
  const trigger = await service.create(hourly(f.project, { source: { kind: 'schedule', schedule: { type: 'once', at: '2026-09-24T01:00:00Z' }, catchUp: 'latest' } }), OWNER);
  const path = join(f.directory, 'trigger-engine.json');
  await rm(path); await mkdir(path);
  f.clock.now = Date.parse('2026-09-24T01:00:05Z');
  await service.tick();
  assert.equal(f.calls.length, 0);
  assert.equal(service.get(trigger.id).trigger.enabled, true);
  await rm(path, { recursive: true });
  // Exercise the acceptance capacity path without filling a file with synthetic history.
  (service as any).options.limits = { acceptBytes: 1 };
  await service.tick();
  assert.equal(f.calls.length, 0);
  assert.equal(service.overview().triggers.find(item => item.id === trigger.id)?.nextRunAt, '2026-09-24T01:00:00.000Z');
  (service as any).options.limits = undefined;
  await service.tick();
  assert.equal(f.calls.length, 1);
});

test('consumption survives tombstone pruning and restoring a pre-consumption backup', async t => {
  const f = await fixture(t);
  const service = await f.open();
  const once = await service.create(hourly(f.project, { source: { kind: 'schedule', schedule: { type: 'once', at: '2026-09-24T01:00:00Z' }, catchUp: 'latest' } }), OWNER);
  const backup = { triggers: [once], settings: service.settings(), trustedFolders: [f.project], secretGrants: {}, fired: {}, github: {} };
  await service.run(once.id, OWNER); await service.tick(); f.finish(); await service.tick();
  await service.remove(once.id, service.get(once.id).trigger.revision, OWNER);
  for (let i = 0; i < 21; i++) {
    const trigger = await service.create(hourly(f.project, { enabled: false }), OWNER);
    await service.remove(trigger.id, trigger.revision, OWNER);
  }
  assert.equal(service.deleted().some(item => item.id === once.id), false);
  await service.restoreBackup(backup);
  await assert.rejects(service.setEnabled(once.id, true, service.get(once.id).trigger.revision, OWNER), /consumed/i);
  await service.tick();
  assert.equal(f.calls.length, 1);
});

test('once parsing keeps past state readable; timing admission requires a future offset-bearing instant', async t => {
  const f = await fixture(t);
  const service = await f.open();
  const source = (at: string): TriggerInput['source'] => ({ kind: 'schedule', schedule: { type: 'once', at }, catchUp: 'latest' });
  for (const at of ['2026-09-24T01:00:00', 'not-a-date', '2026-09-23T01:00:00Z']) {
    await assert.rejects(service.create(hourly(f.project, { source: source(at) } as any), OWNER), { statusCode: 400 });
  }
  const trigger = await service.create(hourly(f.project, { source: source('2026-09-24T01:00:00Z') }), OWNER);
  f.clock.now += 24 * HOUR;
  await service.tick(); f.finish(); await service.tick();
  const current = service.get(trigger.id).trigger;
  await service.update(current.id, { ...hourly(f.project, { source: source('2026-09-24T01:00:00Z') } as any), enabled: false, name: 'Past reservation renamed' }, current.revision, OWNER);
  service.close();
  const reopened = await f.open();
  assert.equal(reopened.get(trigger.id).trigger.name, 'Past reservation renamed');
});

test('a consumed queued reservation starts after restart, while an uncertain claim is never retried', async t => {
  const f = await fixture(t);
  let service = await f.open();
  await service.updateSettings({ maxConcurrentRuns: 1 }, OWNER);
  await service.run((await service.create(hourly(f.project), OWNER)).id, OWNER); await service.tick();
  const once = await service.create(hourly(f.project, { source: { kind: 'schedule', schedule: { type: 'once', at: '2026-09-24T01:00:00Z' }, catchUp: 'latest' } }), OWNER);
  const queued = await service.run(once.id, OWNER); await service.tick();
  assert.equal(service.event(queued.id).status, 'queued');
  service.close(); await service.settle();
  service = await f.open();
  assert.equal(service.launchAllowed(once.id, queued.id), true);
  f.finish(); await service.tick();
  assert.equal(f.calls.length, 2);
  assert.equal(service.event(queued.id).status, 'running');
  service.close(); await service.settle();
  const path = join(f.directory, 'trigger-engine.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  const event = state.events.find((item: any) => item.id === queued.id);
  event.status = 'claimed'; delete event.dispatch;
  f.runs.length = 0;
  await writeFile(path, JSON.stringify(state));
  service = await f.open(); await service.tick();
  assert.equal(service.event(queued.id).status, 'uncertain');
  assert.equal(f.calls.length, 2);
});

test('a disabled once cannot be consumed manually and a consumed source cannot be replaced or reverted', async t => {
  const f = await fixture(t);
  const service = await f.open();
  const input = hourly(f.project, { enabled: false, source: { kind: 'schedule', schedule: { type: 'once', at: '2026-09-24T01:00:00Z' }, catchUp: 'latest' } });
  let trigger = await service.create(input, OWNER);
  await assert.rejects(service.run(trigger.id, OWNER), { statusCode: 409 });
  assert.equal(service.events().length, 0);
  trigger = await service.setEnabled(trigger.id, true, trigger.revision, OWNER);
  f.clock.now++;
  await service.run(trigger.id, OWNER); await service.tick();
  trigger = service.get(trigger.id).trigger;
  await assert.rejects(service.update(trigger.id, { ...hourly(f.project), enabled: false }, trigger.revision, OWNER), /consumed/i);
  await assert.rejects(service.revert(trigger.id, 2, trigger.revision, OWNER), /consumed/i);
});


test('backups retain consumption after deleting a definition and a fresh restore cannot reissue it', async t => {
  const f = await fixture(t);
  const service = await f.open();
  const trigger = await service.create(hourly(f.project, { source: { kind: 'schedule', schedule: { type: 'once', at: '2026-09-24T01:00:00Z' }, catchUp: 'latest' } }), OWNER);
  const before = await collectTriggers(f.directory);
  const event = await service.run(trigger.id, OWNER); await service.tick(); f.finish(); await service.tick();
  await service.remove(trigger.id, service.get(trigger.id).trigger.revision, OWNER);
  const after = await collectTriggers(f.directory);
  assert.equal(after!.triggers.length, 0);
  assert.equal(after!.onceConsumed![trigger.id].eventId, event.id);
  const fresh = await fixture(t);
  const restored = await fresh.open();
  await restored.restoreBackup({ ...before!, onceConsumed: after!.onceConsumed });
  assert.equal(restored.get(trigger.id).trigger.enabled, false);
  assert.ok(restored.get(trigger.id).trigger.archivedAt);
  await assert.rejects(restored.run(trigger.id, OWNER), /consumed/i);
  assert.equal(fresh.calls.length, 0);
});


test('editing a consumed reservation preserves pending execution until explicit disable', async t => {
  const f = await fixture(t); const service = await f.open();
  await service.updateSettings({ maxConcurrentRuns: 1 }, OWNER);
  await service.run((await service.create(hourly(f.project), OWNER)).id, OWNER); await service.tick();
  const trigger = await service.create(hourly(f.project, { source: { kind: 'schedule', schedule: { type: 'once', at: '2026-09-24T01:00:00Z' }, catchUp: 'latest' } }), OWNER);
  const event = await service.run(trigger.id, OWNER); await service.tick();
  let current = service.get(trigger.id).trigger;
  current = await service.update(trigger.id, { ...hourly(f.project), name: 'Renamed reservation', enabled: false, source: current.source }, current.revision, OWNER);
  assert.equal(service.event(event.id).status, 'queued');
  assert.equal(service.launchAllowed(trigger.id, event.id), true);
  await service.setEnabled(trigger.id, false, current.revision, OWNER);
  assert.equal(service.event(event.id).status, 'cancelled');
  assert.equal(service.launchAllowed(trigger.id, event.id), false);
});

test('a full consumption ledger admits restoration of its own consumed ID and keeps recurring execution available', async t => {
  const f = await fixture(t); let service = await f.open();
  const once = await service.create(hourly(f.project, { source: { kind: 'schedule', schedule: { type: 'once', at: '2026-09-24T01:00:00Z' }, catchUp: 'latest' } }), OWNER);
  await service.run(once.id, OWNER); await service.tick(); f.finish(); await service.tick();
  await service.remove(once.id, service.get(once.id).trigger.revision, OWNER);
  service.close(); await service.settle();
  const path = join(f.directory, 'trigger-engine.json'); const state = JSON.parse(await readFile(path, 'utf8'));
  for (let i = 1; i < 2000; i++) state.onceConsumed[randomUUID()] = { at: new Date(f.clock.now).toISOString() };
  await writeFile(path, JSON.stringify(state)); service = await f.open();
  const restored = await service.restore(once.id, OWNER);
  assert.equal(restored.enabled, false); assert.ok(restored.consumed);
  await assert.rejects(service.create(hourly(f.project, { source: once.source }), OWNER), /records are full/);
  const repeat = await service.create(hourly(f.project), OWNER);
  await service.run(repeat.id, OWNER); await service.tick();
  assert.equal(service.events({ triggerId: repeat.id })[0].status, 'running');
  assert.equal(service.overview().onceReservations!.used, 2000);
});

test('retained archived definitions cannot exhaust admission for existing recurring execution', async t => {
  const f = await fixture(t); let service = await f.open();
  const repeat = await service.create(hourly(f.project), OWNER);
  service.close(); await service.settle();
  const path = join(f.directory, 'trigger-engine.json'); const state = JSON.parse(await readFile(path, 'utf8'));
  for (let i = 1; i < 200; i++) state.triggers.push({ ...state.triggers[0], id: randomUUID(), name: `Archived ${i}`, enabled: false, archivedAt: new Date(f.clock.now).toISOString() });
  await writeFile(path, JSON.stringify(state)); service = await f.open();
  assert.equal(service.list().length, 1); assert.equal(service.list({ includeArchived: true }).length, 200);
  await assert.rejects(service.create(hourly(f.project), OWNER), /definitions can be retained/);
  const event = await service.run(repeat.id, OWNER); await service.tick();
  assert.equal(service.event(event.id).status, 'running');
});

test('a tick waiting for a commit rechecks an edited once due time before consuming it', async t => {
  const f = await fixture(t); const service = await f.open();
  const trigger = await service.create(hourly(f.project, { source: { kind: 'schedule', schedule: { type: 'once', at: '2026-09-24T01:00:00Z' }, catchUp: 'latest' } }), OWNER);
  f.clock.now = Date.parse('2026-09-24T01:00:01Z');
  const engine = service as any; const commit = engine.commit.bind(engine);
  let entered!: () => void; let release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  engine.commit = async (...args: any[]) => { if (first) { first = false; entered(); await gate; } return commit(...args); };
  const tick = service.tick(); await waiting;
  await service.update(trigger.id, hourly(f.project, { source: { kind: 'schedule', schedule: { type: 'once', at: '2026-09-24T02:00:00Z' }, catchUp: 'latest' } }), trigger.revision, OWNER);
  release(); await tick;
  assert.equal(service.events({ triggerId: trigger.id }).length, 0);
  assert.equal(service.get(trigger.id).trigger.enabled, true);
  assert.equal(service.overview().triggers.find(item => item.id === trigger.id)!.nextRunAt, '2026-09-24T02:00:00.000Z');
});

test('catch-up policy may change on a due once without changing its absolute reservation', async t => {
  const f = await fixture(t); const service = await f.open();
  const trigger = await service.create(hourly(f.project, { source: { kind: 'schedule', schedule: { type: 'once', at: '2026-09-24T01:00:00Z' }, catchUp: 'latest' } }), OWNER);
  f.clock.now = Date.parse('2026-09-24T02:00:00Z');
  const edited = await service.update(trigger.id, hourly(f.project, { source: { kind: 'schedule', schedule: trigger.source.schedule, catchUp: 'skip' } }), trigger.revision, OWNER);
  assert.equal(edited.enabled, true); await service.tick();
  assert.equal(service.events({ triggerId: trigger.id })[0].status, 'skipped');
  assert.equal(f.calls.length, 0);
});

test('backup restore rechecks reservation capacity after concurrent local consumption', async t => {
  const f = await fixture(t); let service = await f.open();
  const trigger = await service.create(hourly(f.project, { source: { kind: 'schedule', schedule: { type: 'once', at: '2026-09-24T01:00:00Z' }, catchUp: 'latest' } }), OWNER);
  service.close(); await service.settle();
  const path = join(f.directory, 'trigger-engine.json'); const state = JSON.parse(await readFile(path, 'utf8'));
  for (let i = 0; i < 1999; i++) state.onceConsumed[randomUUID()] = { at: new Date(f.clock.now).toISOString() };
  await writeFile(path, JSON.stringify(state)); service = await f.open();
  const backup = (await collectTriggers(f.directory))!;
  const newId = randomUUID(); backup.triggers = [{ ...service.get(trigger.id).trigger, id: newId, name: 'Incoming reservation' }];
  // A restore checks each incoming definition through the definitions' validate.
  const engine = (service as any).definitions; const validate = engine.validate.bind(engine);
  let entered!: () => void; let release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  engine.validate = async (...args: any[]) => { entered(); await gate; return validate(...args); };
  const restore = service.restoreBackup(backup); await waiting;
  await service.run(trigger.id, OWNER); release();
  await assert.rejects(restore, /capacity/i);
  assert.equal(service.overview().onceReservations!.used, 2000);
  assert.ok(service.get(trigger.id).trigger.consumed);
  assert.throws(() => service.get(newId), /not found/i);
});

test('unarchiving an already active recurring definition is a no-op and never turns it off', async t => {
  const f = await fixture(t); const service = await f.open();
  await service.updateSettings({ maxTriggers: 1 }, OWNER);
  const trigger = await service.create(hourly(f.project), OWNER);
  const result = await service.setArchived(trigger.id, false, trigger.revision, OWNER);
  assert.equal(result.enabled, true); assert.equal(result.revision, trigger.revision);
  assert.equal(service.get(trigger.id).trigger.enabled, true);
});

test('restoring an older backup preserves an explicit local archive and converges without new revisions', async t => {
  const f = await fixture(t); const service = await f.open();
  const trigger = await service.create(hourly(f.project), OWNER);
  const backup = (await collectTriggers(f.directory))!;
  const archived = await service.setArchived(trigger.id, true, trigger.revision, OWNER);
  await service.restoreBackup(backup);
  assert.equal(service.get(trigger.id).trigger.enabled, false);
  assert.equal(service.get(trigger.id).trigger.archivedAt, archived.archivedAt);
  const revision = service.get(trigger.id).trigger.revision;
  await service.restoreBackup(backup);
  assert.equal(service.get(trigger.id).trigger.revision, revision);
});


test('manual execution races a due tick as one reservation in both invocation orders', async t => {
  for (const manualFirst of [true, false]) {
    const f = await fixture(t); const service = await f.open();
    const trigger = await service.create(hourly(f.project, { source: { kind: 'schedule', schedule: { type: 'once', at: '2026-09-24T01:00:00Z' }, catchUp: 'latest' } }), OWNER);
    f.clock.now = Date.parse('2026-09-24T01:00:01Z');
    await Promise.allSettled(manualFirst ? [service.run(trigger.id, OWNER), service.tick()] : [service.tick(), service.run(trigger.id, OWNER)]);
    await service.tick();
    assert.equal(service.events({ triggerId: trigger.id }).length, 1);
    assert.equal(f.calls.length, 1);
    assert.ok(service.get(trigger.id).trigger.consumed);
  }
});

test('older backups keep archived definitions missing from the snapshot and preserve consumed unarchive choice', async t => {
  const f = await fixture(t); const service = await f.open();
  const emptyBackup = (await collectTriggers(f.directory))!;
  const trigger = await service.create(hourly(f.project, { source: { kind: 'schedule', schedule: { type: 'once', at: '2026-09-24T01:00:00Z' }, catchUp: 'latest' } }), OWNER);
  const event = await service.run(trigger.id, OWNER); await service.tick(); f.finish(); await service.tick();
  const consumedBackup = (await collectTriggers(f.directory))!;
  await service.restoreBackup(emptyBackup);
  assert.ok(service.get(trigger.id).trigger.archivedAt);
  assert.equal(service.event(event.id).status, 'completed');
  assert.ok((await collectTriggers(f.directory))!.trustedFolders.includes(f.project));
  const visible = await service.setArchived(trigger.id, false, service.get(trigger.id).trigger.revision, OWNER);
  await service.restoreBackup(consumedBackup);
  assert.equal(service.get(trigger.id).trigger.archivedAt, undefined);
  assert.equal(service.get(trigger.id).trigger.revision, visible.revision);
  assert.ok(service.get(trigger.id).trigger.consumed);
});

test('restoring a consumed unarchived definition respects the active definition limit', async t => {
  const f = await fixture(t); const service = await f.open();
  await service.updateSettings({ maxTriggers: 1 }, OWNER);
  const trigger = await service.create(hourly(f.project, { source: { kind: 'schedule', schedule: { type: 'once', at: '2026-09-24T01:00:00Z' }, catchUp: 'latest' } }), OWNER);
  await service.run(trigger.id, OWNER); await service.tick(); f.finish(); await service.tick();
  const visible = await service.setArchived(trigger.id, false, service.get(trigger.id).trigger.revision, OWNER);
  await service.remove(trigger.id, visible.revision, OWNER);
  const repeat = await service.create(hourly(f.project), OWNER);
  await assert.rejects(service.restore(trigger.id, OWNER), /active trigger definitions/);
  assert.equal(service.get(repeat.id).trigger.enabled, true);
});

test('a missing downgrade consumption ledger is recovered from snapshots with one durable warning', async t => {
  const f = await fixture(t); let service = await f.open();
  const trigger = await service.create(hourly(f.project, { source: { kind: 'schedule', schedule: { type: 'once', at: '2026-09-24T01:00:00Z' }, catchUp: 'latest' } }), OWNER);
  const event = await service.run(trigger.id, OWNER); await service.tick(); f.finish(); await service.tick();
  service.close(); await service.settle();
  const path = join(f.directory, 'trigger-engine.json'); const state = JSON.parse(await readFile(path, 'utf8')); delete state.onceConsumed;
  await writeFile(path, JSON.stringify(state)); service = await f.open();
  assert.equal(service.get(trigger.id).trigger.consumed!.eventId, event.id);
  assert.equal(service.audit().filter(entry => entry.summary.includes('ledger was absent')).length, 1);
  service.close(); await service.settle(); service = await f.open();
  assert.equal(service.audit().filter(entry => entry.summary.includes('ledger was absent')).length, 1);
  await assert.rejects(service.run(trigger.id, OWNER), /consumed/i);
});

test('a once skip policy uses the admission time after waiting for a commit', async t => {
  const f = await fixture(t); const service = await f.open();
  const trigger = await service.create(hourly(f.project, { source: { kind: 'schedule', schedule: { type: 'once', at: '2026-09-24T01:00:00Z' }, catchUp: 'skip' } }), OWNER);
  f.clock.now = Date.parse('2026-09-24T01:00:01Z');
  const engine = service as any; const commit = engine.commit.bind(engine);
  let entered!: () => void; let release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  engine.commit = async (...args: any[]) => { if (first) { first = false; entered(); await gate; } return commit(...args); };
  const tick = service.tick(); await waiting;
  f.clock.now = Date.parse('2026-09-24T01:02:00Z'); release(); await tick;
  assert.equal(service.events({ triggerId: trigger.id })[0].status, 'skipped');
  assert.equal(f.calls.length, 0); assert.ok(service.get(trigger.id).trigger.consumed);
});
