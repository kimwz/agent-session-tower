import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RunManager } from '../../../server/runs/manager.js';
import { importFixtureRuns } from '../runs/sql-fixture.js';
import { openStorage, type StorageClient } from '../../../server/storage/client.js';
import { captureStorageBundle } from '../../../server/storage/bundle.js';
import type { StorageLimits, StorageStatus } from '../../../server/storage/contract.js';
import type { WorkerStorageStatus } from '../../../shared/storage.js';
import { createMonitorServer } from '../../../server/http/server.js';
import { RetentionStore } from '../../../server/sessions/retention/store.js';
import { RetentionObserver } from '../../../server/sessions/retention/observer.js';
import { RetentionRepository } from '../../../server/sessions/retention/storage-repository.js';
import { journalDocument, observationDocument, retentionHash, RETENTION_INTENT_BYTES, RETENTION_CHUNK_BYTES, type RetentionDocuments } from '../../../server/sessions/retention/storage-codec.js';
import { RetentionService } from '../../../server/sessions/retention/service.js';
import { RetentionArchive } from '../../../server/sessions/retention/archive.js';
import type { RetentionRecord } from '../../../server/sessions/retention/policy.js';
import type { RetentionJournalEntry } from '../../../server/sessions/retention/types.js';
import { currentStorage } from '../../helpers/current-storage.js';
import { faultBuild, type FaultBuild } from '../../helpers/fault-storage.js';

async function folder(t: TestContext) { const path = await realpath(await mkdtemp(join(tmpdir(), 'tower-retention-fixture-'))); t.after(() => rm(path, { recursive: true, force: true })); return path; }
const documents = (): RetentionDocuments => ({
  journal: journalDocument({ version: 1, migratedAt: 1234, extra: { nested: ['retained'] }, entries: [
    { id: 'operation', phase: 'blocked-provider', archiveRevision: 3, restoreOperationId: 'restore-old', candidate: { ids: ['codex:child'], unknown: { nested: true } }, members: [{ unknown: 'cold-reference-only' }], error: 'blocked', backupError: 'previous-backup-error', unknown: { preserve: true } },
  ], policies: [{ id: 'policy', archiveRevision: 7, archivedAt: '2026-10-01T00:00:00.000Z', restoredAt: '2026-10-02T00:00:00.000Z', unknown: ['policy-extra'] }] }),
  observations: observationDocument({ version: 1, extra: { retain: true }, entries: [['codex:child', { fingerprint: 'fingerprint', since: '2026-10-01T00:00:00.000Z', observedAt: 1790812800000, extra: { nested: 'observation-extra' } }, { futureTupleField: ['preserve'] }]] }),
});
/** The documents as the codec reads them back from JSON. */
const decoded = (data: RetentionDocuments): RetentionDocuments => ({ journal: journalDocument(JSON.parse(JSON.stringify(data.journal))), observations: observationDocument(JSON.parse(JSON.stringify(data.observations))) });
/** The JSON a JSON-era build kept; here only stale files that the SQL owner must never read or write. */
async function staleSources(stateDir: string, data = documents()) {
  await mkdir(join(stateDir, 'retention'), { recursive: true, mode: 0o700 });
  await writeFile(join(stateDir, 'retention', 'journal.json'), JSON.stringify(data.journal), { mode: 0o600 });
  await writeFile(join(stateDir, 'retention-observations.json'), JSON.stringify(data.observations), { mode: 0o600 });
}
/** A current-build storage (currentStorage, no other domain) whose retention authority begins with `data`; closed. */
async function seeded(t: TestContext, data = documents(), commandId = 'retention-seed') {
  const stateDir = await folder(t), client = await currentStorage(stateDir, { initialize: false });
  try { await new RetentionRepository(client).importPrepared(decoded(data), 'a'.repeat(64), commandId); } finally { await client.close(); }
  return stateDir;
}
/** Opens a storage again, prepared: with the product build, or with `fault` of a fault build of this test's own. */
function opener(t: TestContext) {
  let faults: Promise<FaultBuild> | undefined;
  const open = async (stateDir: string, fault = 'normal', limits?: Partial<StorageLimits>, onUnavailable?: (status: StorageStatus) => void): Promise<StorageClient> => {
    const build = fault === 'normal' ? undefined : await (faults ??= faultBuild(t));
    const client = build ? await build.storage.openStorage({ stateDir, bundle: build.bundle(fault), limits, onUnavailable })
      : await openStorage({ stateDir, bundle: await captureStorageBundle(), limits, onUnavailable });
    t.after(() => client.close());
    await client.prepare({ allowMigration: false });
    return client;
  };
  return Object.assign(open, { faults: () => faults ??= faultBuild(t) });
}

test('rows and IDs larger than the payload and result bounds cross them losslessly in chunks, and read back under the legal upper bounds', async t => {
  // Small legal bounds stand for the defaults: every limit-crossing path runs with a fraction of the default data.
  const limits = { maxPayloadBytes: 320 * 1024, maxResultBytes: 320 * 1024 }, data = documents();
  data.journal.entries[0] = { ...data.journal.entries[0], unknown: '\\"😀'.repeat(100_000) } as typeof data.journal.entries[number];
  data.observations.entries[0][0] = 'id'.repeat(200_000);
  data.observations.entries[0][1].extra = 'x'.repeat(500_000);
  assert.ok(Buffer.byteLength(JSON.stringify(data.journal)) > limits.maxResultBytes);
  assert.ok(Buffer.byteLength(data.observations.entries[0][0]) > limits.maxPayloadBytes, 'one ID alone exceeds a payload');
  assert.ok(Buffer.byteLength(JSON.stringify(data.observations)) > limits.maxResultBytes);
  const stateDir = await folder(t), client = await currentStorage(stateDir, { initialize: false, limits }); t.after(() => client.close());
  await new RetentionRepository(client).importPrepared(decoded(data), 'a'.repeat(64), 'large-import');
  assert.deepEqual((await new RetentionRepository(client).exportCurrent()).documents, data);
  const store = new RetentionStore(join(stateDir, 'retention'), { storage: client }); await store.start();
  await store.put({ ...store.get('operation')!, error: 'large current row update' });
  assert.equal((await new RetentionRepository(client).exportCurrent()).documents.journal.entries[0].error, 'large current row update');
  const receipt = await client.receipt('large-import-commit'); assert.equal(receipt.found, true);
  await client.close();
  const legalUpper = await opener(t)(stateDir, 'normal', { maxPayloadBytes: 16 * 1024 * 1024, maxResultBytes: 32 * 1024 * 1024 });
  const upper = (await new RetentionRepository(legalUpper).exportCurrent()).documents;
  assert.equal(upper.journal.entries[0].error, 'large current row update');
  assert.deepEqual(upper.observations, data.observations);
});

test('observation restart continuity and committed DB observations retain current clock and unknown fields', async t => {
  const data = documents(), stateDir = await seeded(t, data), client = await opener(t)(stateDir);
  const session = { id: 'codex:child', nativeId: 'child', provider: 'codex', status: 'completed', cwd: '/fixture', project: 'fixture', title: '', statusReason: '', createdAt: '', updatedAt: '', lastMessage: '', messageCount: 0, isSubagent: true };
  let now = data.observations.entries[0][1].observedAt + 1000;
  const observer = new RetentionObserver({ stateDir, storage: client, now: () => now, snapshot: () => ({ complete: true, records: [{ session: session as never, internal: false, fingerprint: 'fingerprint' }] }), reconcile: sessions => sessions, runs: () => [], settled: () => new Set(), protectedIds: () => [], projectIdentity: async () => undefined });
  await observer.start(); const first = await observer.observe();
  assert.equal(first.records[0].inactiveSince, new Date(now).toISOString(), 'existing restart resets continuously-inactive inference');
  now += 1000; const second = await observer.observe(); assert.equal(second.records[0].inactiveSince, first.records[0].inactiveSince);
  const exported = await new RetentionRepository(client).exportCurrent();
  assert.equal(exported.documents.journal.migratedAt, 1234, 'journal migration grace unchanged');
  assert.deepEqual(exported.documents.observations.extra, data.observations.extra);
  assert.deepEqual(exported.documents.observations.entries[0][1].extra, data.observations.entries[0][1].extra);
});

test('actual lost committed update does not publish draft memory or replay; receipt settles current DB', async t => {
  const stateDir = await seeded(t), open = opener(t);
  const lost = await open(stateDir, 'after');
  const store = new RetentionStore(join(stateDir, 'retention'), { storage: lost }); await store.start();
  const previous = store.get('operation')!;
  await assert.rejects(store.put({ ...previous, error: 'committed-but-response-lost' }), (error: unknown) => { assert.equal((error as { disposition: string }).disposition, 'unknown'); return true; });
  assert.deepEqual(store.get('operation'), previous, 'unknown never publishes draft');
  const intent = (store as unknown as { repository: RetentionRepository }).repository.lastIntent!;
  await assert.rejects(store.put({ ...previous, error: 'must-not-replay' }));
  assert.equal((store as unknown as { repository: RetentionRepository }).repository.lastIntent!.id, intent.id);
  await lost.close();
  const reopened = await open(stateDir);
  assert.equal((await reopened.receipt(intent.commandId)).found, true);
  assert.equal((await new RetentionRepository(reopened).exportCurrent()).documents.journal.entries[0].error, 'committed-but-response-lost');
});

test('DB-backed automatic blocked-provider cycle retains grace and cannot reach native effects', async t => {
  const data = documents();
  const now = Date.UTC(2026, 9, 9), day = 86_400_000;
  data.journal.entries = []; data.journal.policies = []; data.journal.migratedAt = now - 10 * day;
  const stateDir = await seeded(t, data), client = await opener(t)(stateDir);
  const store = new RetentionStore(join(stateDir, 'retention'), { storage: client }); await store.start();
  const records: RetentionRecord[] = ['parent', 'child'].map((id): RetentionRecord => ({
    session: { id, nativeId: id, provider: 'claude', title: id, cwd: '/fixture', project: 'fixture', status: 'completed', statusReason: '', createdAt: new Date(now - 20 * day).toISOString(), updatedAt: new Date(now - 8 * day).toISOString(), lastMessage: '', messageCount: 1, resumable: true, isSubagent: id === 'child', ...(id === 'child' ? { parentId: 'parent' } : {}) },
    kind: id === 'child' ? 'subagent' : 'parent', projectKey: 'fixture', lastActivityAt: new Date(now - 8 * day).toISOString(), latestTaskEndedAt: new Date(now - 8 * day).toISOString(),
  }));
  let nativeEffects = 0;
  const service = new RetentionService({ store, archive: new RetentionArchive(join(stateDir, 'fixture-cold'), []), observe: async () => ({ now, migratedAt: store.migratedAt, complete: true, records, protectedIds: new Set() }), adapter: {
    inspectCold: async members => ({ complete: true, members, issues: [] }), capability: () => ({ status: 'blocked', reason: 'fixture has no native exclusion contract' }),
    files: async () => { nativeEffects++; throw new Error('must not inspect native files'); }, reserve: async () => { nativeEffects++; throw new Error('must not reserve native effects'); },
  } });
  await service.start();
  try { const summary = await service.cycle(); assert.equal(summary.blockedProvider, 1); assert.equal(summary.archived, 0); assert.equal(nativeEffects, 0); }
  finally { await service.quiesce(); }
  const current = await new RetentionRepository(client).exportCurrent();
  assert.equal(current.documents.journal.migratedAt, data.journal.migratedAt);
  assert.ok(current.documents.journal.entries.some(entry => entry.phase === 'blocked-provider'));
});

test('missing known DB never falls back to valid stale legacy files', async t => {
  const stateDir = await seeded(t); await staleSources(stateDir);
  const legacyBytes = await readFile(join(stateDir, 'retention', 'journal.json'));
  await rename(join(stateDir, 'state.sqlite'), join(stateDir, 'preserved-missing-db.sqlite'));
  const missing = await openStorage({ stateDir, bundle: await captureStorageBundle() }); t.after(() => missing.close());
  assert.equal(missing.status().state, 'unavailable');
  await assert.rejects(new RetentionStore(join(stateDir, 'retention'), { storage: missing }).start());
  assert.deepEqual(await readFile(join(stateDir, 'retention', 'journal.json')), legacyBytes);
});

test('DB observations recover snapshot and known write failures without losing committed guards or protection', async t => {
  for (const failure of ['snapshot', 'write']) {
    const data = documents(), stateDir = await seeded(t, data);
    const client = await opener(t)(stateDir, failure === 'write' ? 'refuse-once' : 'normal');
    let now = data.observations.entries[0][1].observedAt + 1000, failSnapshot = failure === 'snapshot';
    let protectedChild = false;
    const session = { id: 'codex:child', nativeId: 'child', provider: 'codex', status: 'completed', cwd: '/fixture', project: 'fixture', title: '', statusReason: '', createdAt: '', updatedAt: '', lastMessage: '', messageCount: 0, isSubagent: true };
    const observer = new RetentionObserver({ stateDir, storage: client, now: () => now,
      snapshot: () => { if (failSnapshot) throw new Error('fixture snapshot failure'); return { complete: true, records: [{ session: session as never, internal: false, fingerprint: 'fingerprint' }] }; },
      reconcile: sessions => sessions, runs: () => [], settled: () => new Set(), protectedIds: () => protectedChild ? ['codex:child'] : [], projectIdentity: async () => undefined });
    await observer.start();
    await assert.rejects(observer.observe(), failure === 'write' ? /known write refusal/ : /snapshot failure/);
    assert.deepEqual((await new RetentionRepository(client).exportCurrent()).documents.observations, data.observations, 'failed attempt leaves committed observations untouched');
    failSnapshot = false; now += 1000;
    const recovered = await observer.observe();
    assert.equal(recovered.records[0].inactiveSince, new Date(now).toISOString(), 'failure breaks inferred continuity only');
    now += 1000;
    assert.equal((await observer.observe()).records[0].inactiveSince, recovered.records[0].inactiveSince, 'known retry commits and continuity resumes');
    const current = (await new RetentionRepository(client).exportCurrent()).documents;
    assert.equal(current.journal.migratedAt, data.journal.migratedAt);
    assert.deepEqual(current.observations.entries[0][1].extra, data.observations.entries[0][1].extra);
    assert.deepEqual(current.observations.entries[0].slice(2), data.observations.entries[0].slice(2));
    protectedChild = true; now += 1000;
    const protectedResult = await observer.observe();
    assert.ok(protectedResult.protectedIds.has('codex:child'));
    assert.equal(protectedResult.records[0].inactiveSince, undefined);
    assert.deepEqual((await new RetentionRepository(client).exportCurrent()).documents.observations.entries, []);
    await client.close();
  }
});

test('actual SQLite corrupt and I/O command errors activate existing intake hold; format refusal keeps core healthy', async t => {
  const open = opener(t), b = await open.faults();
  const damagedPath = join(b.directory, 'corrupt.sqlite');
  const damaged = new DatabaseSync(damagedPath);
  damaged.exec('CREATE TABLE damage (value TEXT); INSERT INTO damage VALUES (\'fixture\');'); damaged.close();
  const damagedBytes = await readFile(damagedPath); damagedBytes[100] = 0;
  await writeFile(damagedPath, damagedBytes, { mode: 0o600 });
  for (const fault of ['corrupt', 'io']) {
    const stateDir = await seeded(t);
    const normal = await open(stateDir); await importFixtureRuns(normal); await normal.close();
    await staleSources(stateDir);
    let effects = 0, unavailable: StorageStatus | undefined;
    let health: WorkerStorageStatus = { state: 'ready', code: 'ready', reason: '', admissionOpen: true, sessionsAvailable: true, healthStatus: 200 };
    let manager: RunManager;
    t.after(async () => { await manager?.close(); });
    const client = await b.storage.openStorage({ stateDir, bundle: b.bundle(fault), onUnavailable: status => { unavailable = status; manager.holdStorage(); health = { ...health, state: 'unavailable', code: status.failure!.code, reason: status.failure!.message, admissionOpen: false, healthStatus: 503 }; } });
    t.after(() => client.close()); await client.prepare({ allowMigration: false });
    manager = new RunManager({ stateDir, storage: client, getSession: () => undefined, refreshSessions: async () => {},
      holdUntilReady: true, findExecutable: async () => { effects++; throw new Error('must not reach provider'); } });
    await manager.start();
    await assert.rejects(new RetentionStore(join(stateDir, 'retention'), { storage: client }).start(), (error: unknown) => {
      assert.equal((error as { code: string }).code, fault === 'io' ? 'io-error' : 'corrupt'); return true;
    });
    assert.equal(unavailable?.state, 'unavailable');
    assert.equal(client.status().state, 'unavailable');
    assert.equal((await client.gate('core')).open, false);
    await assert.rejects(manager.enqueue('codex:fixture', 'must not be admitted'), (error: unknown) => {
      assert.equal((error as { kind: string }).kind, 'unavailable'); return true;
    });
    assert.equal(manager.list().length, 0); assert.equal(effects, 0);
    const { server, dispose } = createMonitorServer({ port: 0, clientDir: stateDir, backend: {
      snapshot: () => ({ sessions: [], runs: [], providers: [], scanning: false, hostname: 'fixture', version: 'fixture', updatedAt: new Date().toISOString() }),
      detail: async () => undefined, enqueue: (id, prompt) => manager.enqueue(id, prompt), cancel: async () => {}, subscribe: () => () => {}, storageStatus: () => health,
    } });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/health`);
      assert.equal(response.status, 503);
      const body = await response.json() as { storage: WorkerStorageStatus };
      assert.equal(body.storage.admissionOpen, false); assert.equal(body.storage.code, unavailable?.failure?.code);
    } finally { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

    assert.deepEqual(await readFile(join(stateDir, 'retention', 'journal.json')), Buffer.from(JSON.stringify(documents().journal)), 'no legacy fallback write');
    await manager.close(); await client.close();
  }
  const stateDir = await seeded(t);
  const db = new DatabaseSync(join(stateDir, 'state.sqlite'));
  try { db.prepare("UPDATE retention_metadata SET json = ? WHERE kind = 'journal'").run('{invalid'); } finally { db.close(); }
  const healthy = await open(stateDir);
  await assert.rejects(new RetentionStore(join(stateDir, 'retention'), { storage: healthy }).start(), SyntaxError);
  assert.equal(healthy.status().state, 'ready', 'domain format quarantine does not claim a physical DB failure');
  assert.equal((await healthy.gate('core')).open, true);

});

test('unknown observation commit preserves memory and forbids retry even when the DB committed', async t => {
  const data = documents(), stateDir = await seeded(t, data), open = opener(t);
  const lost = await open(stateDir, 'after');
  const observer = new RetentionObserver({ stateDir, storage: lost, now: () => data.observations.entries[0][1].observedAt + 1000,
    snapshot: () => ({ complete: true, records: [] }), reconcile: sessions => sessions, runs: () => [], settled: () => new Set(), protectedIds: () => [] });
  await observer.start();
  const view = observer as unknown as { inactive: Map<string, unknown>; repository: RetentionRepository; restarted: boolean };
  const committed = [...view.inactive];
  await assert.rejects(observer.observe(), (error: unknown) => { assert.equal((error as { disposition: string }).disposition, 'unknown'); return true; });
  assert.deepEqual([...view.inactive], committed); assert.equal(view.restarted, true);
  const intent = view.repository.lastIntent!;
  await assert.rejects(observer.observe()); assert.equal(view.repository.lastIntent!.id, intent.id);
  await lost.close();
  const reopened = await open(stateDir);
  assert.equal((await reopened.receipt(intent.commandId)).found, true);
  assert.deepEqual((await new RetentionRepository(reopened).exportCurrent()).documents.observations.entries, []);
});

test('all-owner reservations enforce count 16/17 and bytes boundary through the actual SDK and survive a reopen', async t => {
  const open = opener(t);
  for (const reservations of [Array(16).fill(1), [RETENTION_INTENT_BYTES, RETENTION_INTENT_BYTES], [RETENTION_INTENT_BYTES, RETENTION_INTENT_BYTES - 1, 1]]) {
    const stateDir = await folder(t), client = await currentStorage(stateDir, { initialize: false }); t.after(() => client.close());
    for (const [index, bytes] of reservations.entries()) {
      const payload = { intent: `reserved-${index}`, bytes, chunks: Math.ceil(bytes / RETENTION_CHUNK_BYTES), sha256: 'a'.repeat(64) };
      await client.write('retention', 'begin', payload, `reserve-${index}`);
      await client.write('retention', 'begin', payload, `reserve-${index}`); // receipt replay does not reserve again
      await assert.rejects(client.write('retention', 'commit', { intent: payload.intent }, `failed-${index}`), error => {
        assert.equal((error as { disposition: string }).disposition, 'not-committed'); return true;
      });
      assert.equal((await client.receipt(`failed-${index}`)).found, false);
    }
    await client.close();
    const rollback = await open(stateDir);
    await assert.rejects(rollback.write('retention', 'begin', { intent: 'over-limit', bytes: 1, chunks: 1, sha256: 'b'.repeat(64) }, 'over-limit'), error => {
      assert.equal((error as { code: string }).code, 'domain-failed');
      assert.equal((error as { disposition: string }).disposition, 'not-committed'); return true;
    });
    assert.equal((await rollback.receipt('over-limit')).found, false);
    assert.equal((await rollback.gate('core')).open, true);
    await rollback.close();
    const db = new DatabaseSync(join(stateDir, 'state.sqlite'));
    try {
      assert.equal((db.prepare('SELECT count(*) AS n FROM retention_stages').get() as { n: number }).n, reservations.length);
      assert.throws(() => db.prepare('INSERT INTO retention_stages VALUES (?,?,?,?,?)').run('sql-bypass', 999, 1, 'c'.repeat(64), 1), /reservation limit/);
      if (reservations.length !== 16) assert.throws(() => db.prepare('UPDATE retention_stages SET bytes = bytes + 1 WHERE intent = ?').run(`reserved-${reservations.length - 1}`), /reservation limit/);
    } finally { db.close(); }
  }
});

test('failed current guards reserve their intent until the all-owner cap; receipts never authorize replay', async t => {
  const stateDir = await seeded(t, documents(), 'guard-import'), open = opener(t), client = await open(stateDir);
  for (let index = 0; index < 16; index++) {
    const intent = `guard-${index}`, bytes = Buffer.from(JSON.stringify({ mode: 'update', revision: 0, generation: 1, changes: [] }));
    await client.write('retention', 'begin', { intent, bytes: bytes.length, chunks: 1, sha256: retentionHash(bytes) }, `${intent}-begin`);
    await client.write('retention', 'stage', { intent, part: 0, data: bytes.toString('base64') }, `${intent}-stage`);
    await assert.rejects(client.write('retention', 'commit', { intent }, `${intent}-commit`), /current generation/);
    assert.equal((await client.receipt(`${intent}-begin`)).found, true);
    assert.equal((await client.receipt(`${intent}-commit`)).found, false);
  }
  const before = await new RetentionRepository(client).exportCurrent(); await client.close();
  const rollback = await open(stateDir);
  await assert.rejects(rollback.write('retention', 'begin', { intent: 'blocked', bytes: 1, chunks: 1, sha256: 'a'.repeat(64) }, 'blocked'), /reservation limit/);
  assert.deepEqual(await new RetentionRepository(rollback).exportCurrent(), before);
});

test('R6 runtime refuses absent SDK and absent authority without reading valid legacy JSON', async t => {
  const stateDir = await folder(t);
  await staleSources(stateDir);
  const journal = await readFile(join(stateDir, 'retention', 'journal.json'));
  const observations = await readFile(join(stateDir, 'retention-observations.json'));
  await assert.rejects(new RetentionStore(join(stateDir, 'retention')).start(), /storage is unavailable/);
  const options = { stateDir, snapshot: () => ({ complete: true, records: [] }), reconcile: (sessions: import('../../../shared/types.js').Session[]) => sessions,
    runs: () => [], settled: () => new Set<string>(), protectedIds: () => [] };
  await assert.rejects(new RetentionObserver(options).start(), /storage is unavailable/);
  const client = await currentStorage(stateDir, { initialize: false }); t.after(() => client.close());
  const store = new RetentionStore(join(stateDir, 'retention'), { storage: client });
  await assert.rejects(store.start(), /database authority is required/);
  await assert.rejects(store.gateNativeEffects(), /not loaded database authority/);
  await assert.rejects(new RetentionObserver({ ...options, storage: client }).start(), /database authority is required/);
  assert.deepEqual(await readFile(join(stateDir, 'retention', 'journal.json')), journal);
  assert.deepEqual(await readFile(join(stateDir, 'retention-observations.json')), observations);
  assert.equal((await new RetentionRepository(client).head()).authority, null);
});

test('R6 explicit journal targets never serialize unrelated projection and preserve policy wrapper metadata', async t => {
  const data = documents();
  data.journal.policies = false;
  const stateDir = await seeded(t, data); await staleSources(stateDir, data);
  const client = await opener(t)(stateDir);
  const store = new RetentionStore(join(stateDir, 'retention'), { storage: client }); await store.start();
  const view = store as unknown as { entries: Map<string, RetentionJournalEntry> };
  const unrelated = view.entries.get('operation')!;
  Object.defineProperty(unrelated, 'toJSON', { value: () => { throw new Error('unrelated projection serialized'); }, configurable: true });
  const next = { ...data.journal.entries[0], id: 'new-metadata' };
  await store.putMany([next, { ...next, error: 'last duplicate wins' }]);
  const previous = store.get(next.id)!;
  await store.putIfUnchanged([{ previous, next: { ...previous, error: 'conditional' } }], () => true);
  await store.putIfUnchanged([{ previous, next: { ...previous, error: 'stale must not win' } }], () => true);
  assert.equal(store.get(next.id)!.error, 'conditional');
  await store.setPolicy({ id: 'new-policy', archiveRevision: 1 });
  await store.removeMetadata([next.id, next.id, 'absent']);
  const current = (await new RetentionRepository(client).exportCurrent()).documents;
  assert.deepEqual(current.journal.entries, data.journal.entries);
  assert.deepEqual(current.journal.extra, data.journal.extra);
  assert.deepEqual(current.journal.policies, [{ id: 'new-policy', archiveRevision: 1 }]);
  assert.deepEqual(current.observations, data.observations);
  assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'retention', 'journal.json'), 'utf8')), data.journal, 'SQL writes do not save legacy JSON');
});
