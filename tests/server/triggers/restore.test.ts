import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { TriggerService, type TriggerExecutor } from '../../../server/triggers/service.js';
import { collectTriggers, type TriggerBackup } from '../../../server/backup/payload.js';
import type { Run } from '../../../shared/types.js';
import type { Trigger, TriggerActor, TriggerInput } from '../../../shared/triggers.js';

const OWNER: TriggerActor = { kind: 'owner', via: 'ui' };
const start = Date.parse('2026-09-24T00:00:30.000Z');

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-trigger-restore-'));
  const project = join(directory, 'project');
  await mkdir(project);
  const clock = { now: start };
  const runs: Run[] = [];
  const executor = {
    create: async (input: { prompt: string }) => { const run = { id: randomUUID(), sessionId: `codex:${randomUUID()}`, prompt: input.prompt, status: 'running', createdAt: '', output: '' } as Run; runs.push(run); return { run, session: {} }; },
    runs: () => structuredClone(runs), session: () => undefined, getAutoPrompt: () => undefined,
  } as unknown as TriggerExecutor;
  const services: TriggerService[] = [];
  const open = async (restore?: TriggerBackup) => {
    const service = new TriggerService({ stateDir: directory, executor, now: () => clock.now, tickMs: 60_000 });
    const result = await service.start(restore ? { restore } : {});
    services.push(service);
    return { service, errors: result.errors };
  };
  const reopen = async (service: TriggerService, restore?: TriggerBackup) => { service.close(); await service.settle(); return open(restore); };
  t.after(async () => { for (const service of services) service.close(); await Promise.all(services.map(service => service.settle())); await rm(directory, { recursive: true, force: true, maxRetries: 3 }); });
  return { directory, project, clock, runs, open, reopen };
}

const hourly = (project: string, values: Partial<TriggerInput> = {}): TriggerInput => ({
  name: 'Hourly report', enabled: true,
  source: { kind: 'schedule', schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' }, catchUp: 'latest' },
  handler: { kind: 'task', instructions: 'Summarize open issues', provider: 'codex', approvals: 'auto', target: { node: 'local', mode: 'folder', cwd: project } },
  policy: { overlap: 'skip', maxEventsPerHour: 20 }, ...values,
});
const github = (id: string, handled: string[], checkedAt: number): { trigger: Trigger; cursor: TriggerBackup['github'][string] } => ({
  trigger: { id, revision: 3, name: 'Issues', enabled: true, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', createdBy: OWNER, updatedBy: OWNER,
    source: { kind: 'github', schedule: { type: 'interval', everySeconds: 300 }, auth: { type: 'gh' }, account: 'me', watch: { type: 'issues', repos: ['octo/app'], assignee: 'me', start: 'existing' } },
    handler: { kind: 'task', instructions: 'Work on it', provider: 'codex', approvals: 'auto', target: { node: 'local', mode: 'folder', cwd: '/tmp' } },
    policy: { overlap: 'skip', maxEventsPerHour: 20 } } as unknown as Trigger,
  cursor: { handled, checkedAt },
});
const backupOf = (triggers: Trigger[], values: Partial<TriggerBackup> = {}): TriggerBackup => ({ triggers, settings: {}, trustedFolders: [], secretGrants: {}, fired: {}, github: {}, ...values });

test('a restore keeps unchanged triggers as they are, reschedules changed ones from now and removes the rest', async t => {
  const f = await fixture(t);
  let { service } = await f.open();
  const same = await service.create(hourly(f.project, { name: 'Same' }), OWNER);
  const changed = await service.create(hourly(f.project, { name: 'Changed' }), OWNER);
  const extra = await service.create(hourly(f.project, { name: 'Extra' }), OWNER);
  const saved = await collectTriggers(f.directory);
  assert.ok(saved);
  // After the backup: one is edited, one is gone from the backup, and time goes on.
  const backup = { ...saved, triggers: saved.triggers.filter(item => (item as Trigger).id !== extra.id).map(item => (item as Trigger).id === changed.id ? { ...(item as Trigger), name: 'Changed back' } : item) };
  f.clock.now = start + 30 * 60 * 1000;
  let errors: string[];
  ({ service, errors } = await f.reopen(service, backup));
  assert.deepEqual(errors, []);
  const list = service.list();
  assert.deepEqual(list.map(item => item.name).sort(), ['Changed back', 'Same']);
  assert.equal(list.find(item => item.id === same.id)!.revision, same.revision, 'an unchanged trigger keeps its revision');
  assert.equal(list.find(item => item.id === changed.id)!.revision, changed.revision + 1);
  const audit = service.audit({ limit: 10 });
  assert.ok(audit.some(entry => entry.action === 'delete' && entry.triggerId === extra.id));
  assert.ok(audit.some(entry => entry.action === 'restore' && entry.triggerId === changed.id));
  // Both fire at the next hour; nothing catches up on times before the restore.
  f.clock.now = Date.parse('2026-09-24T01:00:05.000Z');
  await service.tick();
  assert.equal(f.runs.length, 2);
});

test('a trigger deleted after the backup runs again once the backup is restored', async t => {
  const f = await fixture(t);
  let { service } = await f.open();
  const trigger = await service.create(hourly(f.project), OWNER);
  const backup = await collectTriggers(f.directory);
  await service.remove(trigger.id, trigger.revision, OWNER);
  ({ service } = await f.reopen(service, backup));
  const restored = service.list().find(item => item.id === trigger.id);
  assert.ok(restored?.enabled);
  assert.ok(restored.revision > trigger.revision);
  f.clock.now = Date.parse('2026-09-24T01:00:05.000Z');
  await service.tick();
  assert.equal(f.runs.length, 1);
});

test("either computer's GitHub history counts, so an issue one of them took is not taken again", async t => {
  const f = await fixture(t);
  const a = github('11111111-1111-4111-8111-111111111111', ['octo/app#1'], 1000);
  let { service, errors } = await f.open(backupOf([a.trigger], { github: { [a.trigger.id]: a.cursor }, fired: { [`${a.trigger.id} octo/app#1`]: '2026-09-01T00:00:00.000Z' } }));
  assert.deepEqual(errors, []);
  const b = github(a.trigger.id, ['octo/app#2'], 2000);
  ({ service, errors } = await f.reopen(service, backupOf([b.trigger], { github: { [b.trigger.id]: b.cursor }, fired: { [`${a.trigger.id} octo/app#2`]: '2026-09-02T00:00:00.000Z' } })));
  const saved = await collectTriggers(f.directory);
  assert.deepEqual(saved?.github[a.trigger.id]?.handled?.sort(), ['octo/app#1', 'octo/app#2']);
  assert.equal(saved?.github[a.trigger.id]?.checkedAt, 2000);
  assert.deepEqual(Object.keys(saved!.fired).sort(), [`${a.trigger.id} octo/app#1`, `${a.trigger.id} octo/app#2`]);
  assert.equal(service.list()[0]!.revision, 4, 'the definition came in once and is unchanged the second time');
});

test('broken entries and secrets that do not exist here are left out and reported', async t => {
  const f = await fixture(t);
  const good = hourly(f.project, { name: 'Good' });
  const { service, errors } = await f.open(backupOf([{ id: 'x', revision: 1, name: 'Broken' } as unknown as Trigger, { ...good, id: randomUUID(), revision: 2, createdAt: '', updatedAt: '', createdBy: OWNER, updatedBy: OWNER } as Trigger],
    { settings: { maxConcurrentRuns: 'many' }, secretGrants: { 'missing-secret': ['x'] }, trustedFolders: [f.project] }));
  assert.equal(errors.length, 2);
  assert.ok(errors.some(error => /Broken/.test(error)));
  assert.deepEqual(service.list().map(item => item.name), ['Good']);
  const saved = await collectTriggers(f.directory);
  assert.deepEqual(saved?.secretGrants, {});
  assert.deepEqual(saved?.trustedFolders, [f.project]);
});

test('a restored trigger never runs a time missed before the restore, and one this computer cannot run comes in turned off', async t => {
  const f = await fixture(t);
  let { service } = await f.open();
  const edited = await service.create(hourly(f.project, { name: 'Edited' }), OWNER);
  const kept = await service.create(hourly(f.project, { name: 'Kept' }), OWNER);
  const saved = (await collectTriggers(f.directory))!;
  const elsewhere = { ...(saved.triggers[0] as Trigger), id: randomUUID(), name: 'Elsewhere', handler: { ...(saved.triggers[0] as Trigger).handler, target: { node: 'local', mode: 'folder', cwd: join(f.directory, 'missing') } } } as Trigger;
  const backup = { ...saved, triggers: [
    { ...(saved.triggers[0] as Trigger), handler: { ...(saved.triggers[0] as Trigger).handler, instructions: 'Changed instructions' } },
    // A definition this build cannot read, for a trigger that exists here: it stays as it is.
    { id: kept.id, revision: 9, name: 'Kept', source: { kind: 'unknown' } },
    elsewhere,
  ] };
  // Tower was off over 01:00; the restore happens at 01:10.
  service.close(); await service.settle();
  f.clock.now = Date.parse('2026-09-24T01:10:00.000Z');
  let errors: string[];
  ({ service, errors } = await f.open(backup));
  await service.tick();
  assert.equal(f.runs.filter(run => run.prompt.includes('Changed instructions')).length, 0, 'the 01:00 time is not caught up with the restored definition');
  const before = f.runs.length;
  for (const run of f.runs) run.status = 'completed';
  await service.tick();
  assert.equal(service.list().find(item => item.id === edited.id)?.revision, edited.revision + 1);
  assert.equal(service.list().find(item => item.id === kept.id)?.revision, kept.revision, 'kept as it was, not deleted');
  const restored = service.list().find(item => item.name === 'Elsewhere');
  assert.equal(restored?.enabled, false);
  assert.ok(errors.some(error => /Elsewhere.*꺼서 복원/.test(error) && /does not exist/.test(error)));
  assert.ok(errors.some(error => /Kept.*올바르지 않아/.test(error)));
  f.clock.now = Date.parse('2026-09-24T02:00:05.000Z');
  await service.tick();
  assert.equal(f.runs.length - before, 2, 'from the next time on, both run');
  assert.ok(f.runs.some(run => run.prompt.includes('Changed instructions')));
});
