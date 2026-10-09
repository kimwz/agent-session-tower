import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { triggerBackupOf } from '../../../server/triggers/backup.js';
import { ONCE_FALLBACK } from '../../../server/triggers/once-storage.js';
import { TriggerService, type TriggerExecutor } from '../../../server/triggers/service.js';
import type { Run } from '../../../shared/types.js';
import type { TriggerActor, TriggerInput } from '../../../shared/triggers.js';
import * as OldSchema from './fixtures/trigger-schema-1.105.0.js';

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

/** The golden file with real-looking IDs and a port again, so an engine can load it. */
async function goldenState(): Promise<Record<string, any>> {
  const text = await readFile(join(FIXTURES, 'engine-after-operations.json'), 'utf8');
  return JSON.parse(text.replaceAll('<dir>', '/tmp/tower-engine-format').replaceAll('127.0.0.1:<port>', '127.0.0.1:1').replace(/<uuid#(\d+)>/g, (_match, n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`));
}

async function golden(name: string, actual: string): Promise<void> {
  const path = join(FIXTURES, name);
  if (UPDATE) { await mkdir(FIXTURES, { recursive: true }); await writeFile(path, actual); }
  assert.equal(actual, await readFile(path, 'utf8'), name);
}

async function engine(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-engine-format-'));
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
    const service = new TriggerService({ stateDir: directory, executor, now: () => clock.now, tickMs: 3_600_000 });
    await service.start();
    services.push(service);
    return service;
  };
  t.after(async () => {
    for (const service of services) service.close();
    await Promise.allSettled(services.map(service => service.settle()));
    await rm(directory, { recursive: true, force: true });
  });
  const finish = () => { for (const run of runs) if (run.status === 'running') run.status = 'completed'; };
  const file = () => readFile(join(directory, 'trigger-engine.json'), 'utf8');
  return { directory, project, clock, runs, open, finish, file };
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
  assert.equal((await stat(join(f.directory, 'trigger-engine.json'))).mode & 0o777, 0o600);
  await golden('engine-after-operations.json', `${normalized(await f.file(), port, f.directory)}\n`);
});

test('the saved file stays readable by a 1.105.0 engine', async () => {
  const saved = await goldenState();
  assert.doesNotMatch(JSON.stringify(saved), /"type":"once"/, 'no schedule an older engine does not know');
  // Exactly what a 1.105.0 engine's parseState reads of each definition, checked with its own frozen schema.
  const projection = (value: Record<string, any>) => ({ name: value.name, enabled: value.enabled, source: value.source, handler: value.handler, policy: value.policy });
  const definitions = [...saved.triggers, ...saved.tombstones, ...Object.values(saved.revisions as Record<string, unknown[]>).flat()] as Array<Record<string, any>>;
  for (const definition of definitions) {
    const parsed = OldSchema.TriggerInputSchema.safeParse(projection(definition));
    assert.equal(parsed.success, true, `${definition.name}: ${parsed.success ? '' : parsed.error.message}`);
    assert.equal(typeof definition.id, 'string');
    assert.ok(Number.isInteger(definition.revision));
    if (definition.onceSchedule) {
      assert.equal(definition.enabled, false, 'an older engine never schedules a once reservation');
      assert.deepEqual(definition.source.schedule, ONCE_FALLBACK);
    }
  }
  assert.equal(OldSchema.TriggerSettingsSchema.safeParse(saved.settings).success, true);
  assert.ok(definitions.some(definition => definition.onceSchedule), 'the sequence stored a once reservation');
  assert.ok(Object.keys(saved.onceConsumed).length >= 2, 'the ledger keeps both consumptions');
});

/** Loads a saved file in a fresh engine, makes its first commit, and answers the engine and the file it wrote. */
async function load(t: TestContext, saved: unknown) {
  const f = await engine(t);
  await writeFile(join(f.directory, 'trigger-engine.json'), JSON.stringify(saved), { mode: 0o600 });
  const service = await f.open();
  await service.flush();
  return { f, service, written: JSON.parse(await f.file()) };
}

test('a file an older engine rewrote loads turned off with one audit entry', async t => {
  const saved = await goldenState();
  const marker = { id: '40000000-0000-4000-8000-000000000001', name: 'Rewritten reservation', enabled: false, revision: 3, createdAt: '2026-09-24T00:00:30.000Z', updatedAt: '2026-09-24T00:00:30.000Z',
    createdBy: OWNER, updatedBy: OWNER, source: { kind: 'schedule', schedule: ONCE_FALLBACK, catchUp: 'latest' }, handler: { ...saved.triggers[0].handler }, policy: { overlap: 'skip', maxEventsPerHour: 20 },
    onceSchedule: { at: '2026-12-01T00:00:00.000Z', enabled: true, revision: 2 } };
  saved.triggers.push(marker);
  saved.cursors[marker.id] = { anchorAt: start };
  const { service, written } = await load(t, saved);
  const loaded = service.list().find(item => item.id === marker.id)!;
  assert.equal(loaded.enabled, false);
  assert.equal(service.audit({ limit: 1000 }).filter(entry => entry.triggerId === marker.id).length, 1);
  assert.match(service.audit({ limit: 1000 }).find(entry => entry.triggerId === marker.id)!.summary, /changed by an older engine/);
  assert.equal(written.triggers.find((item: { id: string }) => item.id === marker.id).onceSchedule.enabled, false, 'saved again as a turned-off reservation');
});

test('a downgraded file without the ledger recovers consumption from snapshots with one warning', async t => {
  const saved = await goldenState();
  const ledger = saved.onceConsumed as Record<string, unknown>;
  delete saved.onceConsumed;
  const { service, written } = await load(t, saved);
  const recovered = Object.keys(written.onceConsumed);
  // Only consumption still visible in a snapshot (a tombstone, a revision, an archived definition) comes back.
  assert.ok(recovered.length >= 1 && recovered.every(id => id in ledger));
  assert.equal(service.audit({ limit: 1000 }).filter(entry => /ledger was absent after a downgrade/.test(entry.summary)).length, 1);
});

test('a 1.105.0 state file loads and is written back as the base writes it', async t => {
  const saved = { version: 1, triggers: [], revisions: {}, tombstones: [], cursors: {}, events: [], fired: {}, audit: [], secretGrants: {},
    settings: { maxTriggers: 20, maxEventsPerHour: 60, maxConcurrentRuns: 2, privateHosts: [] }, trustedFolders: [], recentFires: [] };
  const { written } = await load(t, saved);
  assert.deepEqual(written, { ...saved, onceConsumed: {} });
  assert.deepEqual(Object.keys(written), ['version', 'onceConsumed', 'triggers', 'revisions', 'tombstones', 'cursors', 'events', 'fired', 'audit', 'secretGrants', 'settings', 'trustedFolders', 'recentFires']);
});

test('wrong shapes and parse failures preserve state and hold startup', async t => {
  t.mock.method(console, 'error', () => {});
  const legacy = await goldenState();
  for (const broken of [{ ...legacy, version: 2 }, { ...legacy, cursors: [] }, { ...legacy, triggers: [{ id: 'x' }] }, { ...legacy, events: [{ id: 1 }] }]) {
    const f = await engine(t);
    await writeFile(join(f.directory, 'trigger-engine.json'), JSON.stringify(broken), { mode: 0o600 });
    await assert.rejects(f.open(),{ kind: 'unavailable' });
    assert.deepEqual(JSON.parse(await readFile(join(f.directory,'trigger-engine.json'),'utf8')),broken);
    assert.equal((await readdir(f.directory)).filter(name => name.startsWith('trigger-engine.json.unreadable-')).length,0,'original is preserved without quarantine');
  }
});

test('a failed write, a full state and a locked state behave as before', async t => {
  const f = await engine(t);
  const service = await f.open();
  await service.create(hourly(f.project), OWNER);
  const before = await f.file();
  // Test-only: writes of the engine file fail after a successful load, as on a disk error.
  const original = fsPromises.open;
  t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof original>) => {
    if (String(args[0]).startsWith(join(f.directory, 'trigger-engine.json.')) && String(args[0]).endsWith('.tmp')) throw Object.assign(new Error('EIO: i/o error, open'), { code: 'EIO' });
    return original(...args);
  });
  syncBuiltinESMExports();
  await assert.rejects(service.create(hourly(f.project, { name: 'Unsaved' }), OWNER), { kind: 'unavailable', message: /^Cannot save triggers: EIO/ });
  assert.equal(await f.file(), before, 'the file is not changed');
  assert.match(service.overview().storageError ?? '', /^Cannot save triggers: EIO/);
  assert.equal(service.list().length, 1, 'nothing unsaved becomes current');
  t.mock.restoreAll(); syncBuiltinESMExports();
  await service.flush();
  assert.equal(service.overview().storageError, undefined, 'the next save clears the problem');
  // Full: nothing new is accepted past the acceptance limit.
  const full = await engine(t);
  const small = new TriggerService({ stateDir: full.directory, executor: { runs: () => [], session: () => undefined, getAutoPrompt: () => undefined } as never, now: () => full.clock.now, tickMs: 3_600_000, limits: { acceptBytes: 500, maxBytes: 100_000 } });
  await small.start();
  t.after(() => small.close());
  await assert.rejects(small.create(hourly(full.project), OWNER), { kind: 'storage-full' });
  assert.deepEqual(small.list(), []);
});
