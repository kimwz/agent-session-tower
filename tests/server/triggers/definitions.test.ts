import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { TriggerService, type TriggerExecutor, type TriggerScope } from '../../../server/triggers/service.js';
import type { Run } from '../../../shared/types.js';
import type { TriggerActor, TriggerInput } from '../../../shared/triggers.js';
import { statusOf } from '../../../shared/errors.js';

const OWNER: TriggerActor = { kind: 'owner', via: 'ui' };
const REMOTE: TriggerActor = { kind: 'owner', via: 'ui', controllerId: 'c'.repeat(32) };
const start = Date.parse('2026-09-24T00:00:30.000Z');

async function engine(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-trigger-definitions-'));
  const project = join(directory, 'project');
  await mkdir(project);
  const clock = { now: start };
  const runs: Run[] = [];
  const executor: TriggerExecutor = {
    submitAutoPrompt: async () => { throw new Error('unused'); }, getAutoPrompt: () => undefined,
    create: async (input, internal) => { const run: Run = { id: randomUUID(), sessionId: `codex:${randomUUID()}`, prompt: input.prompt, status: 'running', createdAt: '', output: '', autoPromptId: internal.autoPromptId }; runs.push(run);
      return { run, session: { id: run.sessionId, nativeId: 'n', provider: input.provider, title: '', cwd: project, project: 'project', status: 'idle', statusReason: '', createdAt: '', updatedAt: '', lastMessage: '', messageCount: 0, isSubagent: false, resumable: true } }; },
    enqueue: async () => { throw new Error('unused'); }, runs: () => structuredClone(runs), session: () => undefined,
  };
  const services: TriggerService[] = [];
  const open = async (started = true) => {
    const service = new TriggerService({ stateDir: directory, executor, now: () => clock.now, tickMs: 3_600_000 });
    if (started) await service.start();
    services.push(service);
    return service;
  };
  t.after(async () => { for (const service of services) service.close(); await Promise.allSettled(services.map(service => service.settle())); await rm(directory, { recursive: true, force: true }); });
  return { directory, project, clock, runs, open, file: () => readFile(join(directory, 'trigger-engine.json'), 'utf8').catch(() => '') };
}

const definition = (project: string, values: Partial<TriggerInput> = {}): TriggerInput => ({ name: 'Report', enabled: true,
  source: { kind: 'schedule', schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' }, catchUp: 'latest' },
  handler: { kind: 'task', instructions: 'Summarize', provider: 'codex', approvals: 'auto', target: { node: 'local', mode: 'folder', cwd: project } },
  policy: { overlap: 'skip', maxEventsPerHour: 20 }, ...values });
const once = (project: string, at: string, values: Partial<TriggerInput> = {}) => definition(project, { name: 'Once', source: { kind: 'schedule', schedule: { type: 'once', at }, catchUp: 'latest' }, ...values });

/** What a refused call answers: its status and message. */
async function refusal(call: Promise<unknown>): Promise<string> {
  try { await call; return 'accepted'; } catch (error) { return `${statusOf(error)} ${(error as Error).message}`; }
}

test('capacity, consumed and archived refusals answer as before', async t => {
  const f = await engine(t);
  const service = await f.open();
  await service.updateSettings({ maxTriggers: 2, maxEventsPerHour: 60, maxConcurrentRuns: 2, privateHosts: [] }, OWNER);
  const answers: string[] = [];
  const first = await service.create(definition(f.project, { name: 'First' }), OWNER);
  const reservation = await service.create(once(f.project, '2026-09-24T01:00:00.000Z'), OWNER);
  answers.push(await refusal(service.create(definition(f.project, { name: 'Third' }), OWNER)));
  answers.push(await refusal(service.create(once(f.project, '2026-09-24T00:00:00.000Z'), OWNER)));
  const archived = await service.setArchived(first.id, true, first.revision, OWNER);
  answers.push(await refusal(service.setEnabled(archived.id, true, archived.revision, OWNER)));
  answers.push(await refusal(service.run(archived.id, OWNER)));
  answers.push(await refusal(service.update(archived.id, definition(f.project, { name: 'First' }), archived.revision, OWNER)));
  answers.push(await refusal(service.update(archived.id, definition(f.project, { name: 'First' }), archived.revision + 5, OWNER)));
  // The reservation is consumed when it fires.
  f.clock.now = Date.parse('2026-09-24T01:00:05.000Z');
  await service.tick();
  const consumed = service.list({ includeArchived: true }).find(item => item.id === reservation.id)!;
  answers.push(await refusal(service.setEnabled(consumed.id, true, consumed.revision, OWNER)));
  answers.push(await refusal(service.run(consumed.id, OWNER)));
  answers.push(await refusal(service.update(consumed.id, once(f.project, '2026-09-25T00:00:00.000Z', { enabled: false }), consumed.revision, OWNER)));
  answers.push(await refusal(service.revert(consumed.id, 1, consumed.revision, OWNER)));
  const back = await service.setArchived(archived.id, false, archived.revision, OWNER);
  answers.push(await refusal(service.create(definition(f.project, { name: 'Fourth' }), OWNER)));
  answers.push(await refusal(service.setArchived(back.id, false, back.revision, OWNER)));
  assert.deepEqual(answers, [
    '409 At most 2 active trigger definitions can exist. Archive one first.',
    '409 At most 2 active trigger definitions can exist. Archive one first.',
    '409 Unarchive this trigger before enabling it.',
    '409 Unarchive this trigger before running it.',
    '409 Unarchive this trigger before enabling it.',
    '409 The trigger changed (now revision 2). Reload it and try again.',
    '409 This once reservation was consumed. Create a new reservation to retry.',
    '409 This once reservation was consumed. Create a new reservation to retry.',
    '409 This once reservation was consumed. Create a new reservation to retry or change its schedule.',
    '409 This once reservation was consumed. Create a new reservation to retry or change its schedule.',
    'accepted',
    'accepted',
  ]);
});

test('scope refusals and stale revisions answer as before', async t => {
  const f = await engine(t);
  const service = await f.open();
  const hidden: TriggerScope = { handler: () => false, target: () => true };
  const blind: TriggerScope = { handler: () => true, target: () => false };
  const trigger = await service.create(definition(f.project), OWNER);
  const answers = [
    await refusal(service.update(trigger.id, definition(f.project), trigger.revision, REMOTE, hidden)),
    await refusal(service.setEnabled(trigger.id, false, trigger.revision, REMOTE, hidden)),
    await refusal(service.setArchived(trigger.id, true, trigger.revision, REMOTE, hidden)),
    await refusal(service.remove(trigger.id, trigger.revision, REMOTE, hidden)),
    await refusal(service.revert(trigger.id, 1, trigger.revision, REMOTE, hidden)),
    await refusal(service.run(trigger.id, REMOTE, hidden)),
    await refusal(service.create(definition(f.project), REMOTE, blind)),
    await refusal(service.update(trigger.id, definition(f.project), trigger.revision + 1, OWNER)),
    await refusal(service.remove(trigger.id, trigger.revision + 1, OWNER)),
    await refusal(service.restore(randomUUID(), OWNER)),
    await refusal(service.revert(trigger.id, 7, trigger.revision, OWNER)),
    await refusal(service.run(randomUUID(), OWNER)),
    await refusal(service.createSecret({ name: 'x', origin: 'https://example.com', value: 'Bearer abcdefgh' }, { kind: 'agent', via: 'mcp', sessionId: 's', runId: randomUUID() })),
    await refusal(service.updateSettings({}, { kind: 'agent', via: 'mcp', sessionId: 's', runId: randomUUID() })),
  ];
  assert.deepEqual(answers.map(answer => answer.replace(f.project, '<project>')), [
    '404 Trigger not found.',
    '404 Trigger not found.',
    '404 Trigger not found.',
    '404 Trigger not found.',
    '404 Trigger not found.',
    '404 Trigger not found.',
    '400 The folder <project> does not exist. Tower does not create folders for triggers.',
    '409 The trigger changed (now revision 1). Reload it and try again.',
    '409 The trigger changed (now revision 1). Reload it and try again.',
    '404 This deleted trigger is no longer kept.',
    '404 Revision 7 is no longer kept. Only the last 20 revisions can be restored.',
    '404 Trigger not found.',
    '403 Only the owner can save secrets.',
    '403 Only the owner can change trigger limits.',
  ]);
});

test('an owner restore refuses before start (503), on a bad shape, and on a grant whose secret is missing, and changes nothing', async t => {
  const f = await engine(t);
  const service = await f.open();
  await service.create(definition(f.project), OWNER);
  const before = await f.file();
  const idle = await f.open(false);
  const backup = { triggers: [], settings: {}, trustedFolders: [], secretGrants: {}, fired: {}, github: {} };
  const answers = [
    await refusal(idle.restoreBackup(backup)),
    await refusal(service.restoreBackup({ ...backup, triggers: 'nope' } as never)),
    await refusal(service.restoreBackup({ ...backup, triggers: [{ name: 'no id' }] })),
    await refusal(service.restoreBackup({ ...backup, secretGrants: { [randomUUID()]: [] } })),
  ];
  assert.deepEqual(answers, [
    '503 The trigger engine is not ready for an owner restore.',
    '400 Invalid trigger backup.',
    '400 Invalid restored trigger.',
    '400 Import the original secret Vault before restoring its trigger grants.',
  ]);
  assert.equal(await f.file(), before);
  assert.equal(service.list().length, 1);
});

test('audit summaries read as before', async t => {
  const f = await engine(t);
  const service = await f.open();
  await service.updateSettings({ maxTriggers: 20, maxEventsPerHour: 60, maxConcurrentRuns: 2, privateHosts: [] }, OWNER);
  let trigger = await service.create(definition(f.project), OWNER);
  trigger = await service.update(trigger.id, definition(f.project, { name: 'Renamed', policy: { overlap: 'queue', maxEventsPerHour: 5 } }), trigger.revision, OWNER);
  trigger = await service.revert(trigger.id, 1, trigger.revision, OWNER);
  trigger = await service.setArchived(trigger.id, true, trigger.revision, OWNER);
  trigger = await service.setArchived(trigger.id, false, trigger.revision, OWNER);
  await service.remove(trigger.id, trigger.revision, OWNER);
  await service.restore(trigger.id, OWNER);
  await service.recordSlack(OWNER, 'slack', 'Slack connection changed');
  const reservation = await service.create(once(f.project, '2026-09-24T01:00:00.000Z'), OWNER);
  f.clock.now = Date.parse('2026-09-24T01:00:05.000Z');
  await service.tick();
  // A backup that changes the trigger and leaves out the reservation (kept: it is archived).
  const restored = service.list({ includeArchived: true }).find(item => item.id === trigger.id)!;
  await service.restoreBackup({ triggers: [{ ...restored, name: 'From backup' }], settings: service.settings(), trustedFolders: [], secretGrants: {}, fired: {}, github: {} });
  const summaries = service.audit({ limit: 1000 }).reverse().map(entry => `${entry.action}: ${entry.summary.replace(f.project, '<project>')}`);
  assert.deepEqual(summaries, [
    'settings: Limits: {"maxTriggers":20,"maxConcurrentRuns":2,"maxEventsPerHour":60,"privateHosts":[]}',
    'create: Created "Report" (0 * * * * UTC)',
    'update: Changed name, policy',
    'revert: Restored revision 1',
    'archive: Archived; history retained',
    'unarchive: Unarchived, turned off; a consumed reservation cannot run again',
    'delete: Deleted "Report" (0 * * * * UTC)',
    'restore: Restored after deletion, turned off',
    'slack: Slack connection changed',
    'create: Created "Once" (once at 2026-09-24T01:00:00.000Z)',
    'consume: Once reservation consumed and archived; run outcome is separate from task completion',
    'restore: Restored from a backup: name',
  ]);
});
