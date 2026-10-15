import { actualStorage } from './actual-storage-fixture.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { triggerBackupOf } from '../../../server/triggers/backup.js';
import { TriggerService, type TriggerExecutor } from '../../../server/triggers/service.js';
import type { Run } from '../../../shared/types.js';
import type { TriggerActor, TriggerInput } from '../../../shared/triggers.js';

const OWNER: TriggerActor = { kind: 'owner', via: 'ui' };
const FIXTURES = join(import.meta.dirname, 'fixtures');
const UPDATE = process.env.UPDATE_ENGINE_GOLDEN === '1';
const start = Date.parse('2026-09-24T00:00:30.000Z');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Random IDs become `<uuid#n>` in order of first appearance, and the test server's port a fixed marker. */
function normalized(text: string, port: number, directory: string): string {
  const ids = new Map<string, string>();
  return text.replaceAll(directory, '<dir>').replaceAll(`127.0.0.1:${port}`, '127.0.0.1:<port>').replace(UUID, id => { if (!ids.has(id)) ids.set(id, `<uuid#${ids.size + 1}>`); return ids.get(id)!; });
}

async function golden(name: string, actual: string): Promise<void> {
  const path = join(FIXTURES, name);
  if (UPDATE) { await mkdir(FIXTURES, { recursive: true }); await writeFile(path, actual); }
  assert.equal(actual, await readFile(path, 'utf8'), name);
}

async function engine(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-engine-format-'));
  const sql = await actualStorage(t, directory);
  const project = join(directory, 'project');
  await mkdir(project);
  const clock = { now: start };
  const runs: Run[] = [];
  const executor: TriggerExecutor = {
    submitAutoPrompt: async () => { throw new Error('unused'); },
    getAutoPrompt: () => undefined,
    create: async (input, internal) => {
      const id = `${input.provider}:${randomUUID()}`;
      const run: Run = { id: randomUUID(), sessionId: id, prompt: input.prompt, status: 'running', createdAt: new Date(clock.now).toISOString(), output: '', autoPromptId: internal.autoPromptId, origin: internal.origin };
      runs.push(run);
      return { run, session: { id, nativeId: 'n', provider: input.provider, title: '', cwd: project, project: 'project', status: 'idle', statusReason: '', createdAt: '', updatedAt: '',
        lastMessage: '', messageCount: 0, isSubagent: false, resumable: true } };
    },
    enqueue: async () => { throw new Error('unused'); },
    runs: () => structuredClone(runs),
    session: () => undefined,
  };
  const services: TriggerService[] = [];
  const open = async () => {
    const service = new TriggerService({ stateDir: directory, storage: sql.client, executor, now: () => clock.now, tickMs: 3_600_000 });
    await sql.bootstrap(() => clock.now);
    await service.start();
    services.push(service);
    return service;
  };
  t.after(async () => {
    for (const service of services) service.close();
    await Promise.allSettled(services.map(service => service.settle()));
    await sql.client.close(); await rm(directory, { recursive: true, force: true });
  });
  const finish = () => { for (const run of runs) if (run.status === 'running') run.status = 'completed'; };
  const file = () => sql.text();
  return { directory, sql, project, clock, runs, open, finish, file };
}

const task = (project: string) => ({ kind: 'task' as const, instructions: 'Summarize open issues', provider: 'codex' as const, approvals: 'auto' as const, target: { node: 'local' as const, mode: 'folder' as const, cwd: project } });
const hourly = (project: string, values: Partial<TriggerInput> = {}): TriggerInput => ({ name: 'Hourly report', enabled: true,
  source: { kind: 'schedule', schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' }, catchUp: 'latest' }, handler: task(project), policy: { overlap: 'skip', maxEventsPerHour: 20 }, ...values });

/** The fixed sequence whose saved bytes are pinned. Returns the test server's port. */
async function operations(t: TestContext, f: Awaited<ReturnType<typeof engine>>) {
  const server = createServer((request, response) => { request.resume(); request.on('end', () => response.end(JSON.stringify({ ok: true, method: request.method }))); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const service = await f.open();
  const settled = async () => { await service.tick(); for (let i = 0; i < 200 && service.inFlight(); i++) await new Promise(resolve => setTimeout(resolve, 5)); await service.tick(); };
  await service.updateSettings({ maxTriggers: 20, maxEventsPerHour: 60, maxConcurrentRuns: 4, privateHosts: ['127.0.0.1'] }, OWNER);
  const secret = await service.createSecret({ name: 'Status token', origin, value: 'Bearer fixture-secret-value' }, OWNER);
  // A recurring trigger: create, change, turn off and on, run now, a scheduled firing, both dispatched to completion.
  let hourlyTrigger = await service.create(hourly(f.project), OWNER);
  hourlyTrigger = await service.update(hourlyTrigger.id, hourly(f.project, { name: 'Hourly summary' }), hourlyTrigger.revision, OWNER);
  hourlyTrigger = await service.setEnabled(hourlyTrigger.id, false, hourlyTrigger.revision, OWNER);
  f.clock.now += 1000;
  hourlyTrigger = await service.setEnabled(hourlyTrigger.id, true, hourlyTrigger.revision, OWNER);
  await service.run(hourlyTrigger.id, OWNER);
  await settled(); f.finish(); await settled();
  f.clock.now = Date.parse('2026-09-24T01:00:05.000Z');
  await settled(); f.finish(); await settled();
  // A once reservation fires and is consumed (archived, with its ledger entry).
  const once = await service.create({ ...hourly(f.project, { name: 'Once report' }), source: { kind: 'schedule', schedule: { type: 'once', at: '2026-09-24T02:00:00.000Z' }, catchUp: 'latest' } }, OWNER);
  f.clock.now = Date.parse('2026-09-24T02:00:05.000Z');
  await settled(); f.finish(); await settled();
  // Archive and unarchive, change and revert.
  let other = await service.create(hourly(f.project, { name: 'Weekly digest' }), OWNER);
  other = await service.setArchived(other.id, true, other.revision, OWNER);
  other = await service.setArchived(other.id, false, other.revision, OWNER);
  other = await service.update(other.id, hourly(f.project, { name: 'Weekly digest (edited)', enabled: false }), other.revision, OWNER);
  other = await service.revert(other.id, service.get(other.id).revisions[0].revision, other.revision, OWNER);
  // The consumed reservation is deleted (its tombstone keeps `consumed`); the recurring one is deleted and restored.
  const consumed = service.list({ includeArchived: true }).find(item => item.id === once.id)!;
  await service.remove(consumed.id, consumed.revision, OWNER);
  const current = service.list().find(item => item.id === hourlyTrigger.id)!;
  await service.remove(current.id, current.revision, OWNER);
  await service.restore(current.id, OWNER);
  await service.recordSlack(OWNER, 'slack', 'Slack connection changed');
  // HTTP: a GET poll that fires, and a POST that carries the owner's secret.
  const watch = (method: 'GET' | 'POST', name: string): TriggerInput => ({ name, enabled: true,
    source: { kind: 'http', schedule: { type: 'interval', everySeconds: 60 }, request: { method, url: `${origin}/status`, timeoutSeconds: 5,
      headers: method === 'POST' ? [{ name: 'Authorization', secretId: secret.id }] : [], ...(method === 'POST' ? { body: '{"ping":true}' } : {}) }, condition: { type: 'every-success' } } as TriggerInput['source'],
    handler: task(f.project), policy: { overlap: 'parallel', maxEventsPerHour: 20 } });
  await service.create(watch('GET', 'Status GET'), OWNER);
  await service.create(watch('POST', 'Status POST'), OWNER);
  f.clock.now += 61_000;
  await settled(); f.finish(); await settled();
  // A backup restored on the started engine, carrying another computer's once consumption.
  const backup = triggerBackupOf(JSON.parse(await f.file()))!;
  backup.onceConsumed = { ...backup.onceConsumed, '30000000-0000-4000-8000-000000000001': { at: '2026-09-23T00:00:00.000Z' } };
  await service.restoreBackup(backup);
  await service.flush();
  return { port, service };
}

test('the saved file after a fixed sequence of operations is byte-identical', async t => {
  const f = await engine(t);
  const { port } = await operations(t, f);
  await golden('engine-after-operations.json', `${normalized(await f.file(), port, f.directory)}\n`);
});

test('a failed write, a full state and a locked state behave as before', async t => {
  const f = await engine(t);
  const service = await f.open();
  await service.create(hourly(f.project), OWNER);
  const before = await f.file();
  await f.sql.failCommit();
  await assert.rejects(service.create(hourly(f.project, { name: 'Unsaved' }), OWNER), { kind: 'unavailable', message: /Cannot save triggers:.*fixture SQL commit refusal/ });
  assert.equal(await f.file(), before, 'the file is not changed');
  assert.match(service.overview().storageError ?? '', /Cannot save triggers:.*fixture SQL commit refusal/);
  assert.equal(service.list().length, 1, 'nothing unsaved becomes current');
  await f.sql.allowCommit();
  await service.flush();
  assert.equal(service.overview().storageError, undefined, 'the next save clears the problem');
  // Full: nothing new is accepted past the acceptance limit.
  const full = await engine(t);
  const small = new TriggerService({ stateDir: full.directory, storage: full.sql.client, executor: { runs: () => [], session: () => undefined, getAutoPrompt: () => undefined } as never, now: () => full.clock.now, tickMs: 3_600_000, limits: { acceptBytes: 500, maxBytes: 100_000 } });
  await full.sql.bootstrap(() => full.clock.now);
  await small.start();
  t.after(() => small.close());
  await assert.rejects(small.create(hourly(full.project), OWNER), { kind: 'storage-full' });
  assert.deepEqual(small.list(), []);
});
