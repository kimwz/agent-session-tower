import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retentionBuild } from '../storage/fixtures/retention-build.js';
import { recordPreparationEvidence, evaluateStorageUpdate, type StorageUpdateInput } from '../../../server/link/storage-update.js';
import { RetentionStore } from '../../../server/sessions/retention/store.js';
import { RetentionObserver } from '../../../server/sessions/retention/observer.js';
import { RetentionRepository } from '../../../server/sessions/retention/storage-repository.js';
import { exportRetention, importRetention, restoreRetention } from '../../../server/sessions/retention/storage-transfer.js';
import { journalDocument, observationDocument, retentionHash, type RetentionDocuments } from '../../../server/sessions/retention/storage-codec.js';
import { RetentionService } from '../../../server/sessions/retention/service.js';
import { RetentionArchive } from '../../../server/sessions/retention/archive.js';
import type { RetentionRecord } from '../../../server/sessions/retention/policy.js';

async function folder(t: TestContext) { const path = await mkdtemp(join(tmpdir(), 'tower-retention-fixture-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
async function builds(t: TestContext) {
  const a = await retentionBuild('1.120.0', await folder(t)), b = await retentionBuild('1.121.0', await folder(t));
  return { a, b };
}
const documents = (): RetentionDocuments => ({
  journal: journalDocument({ version: 1, migratedAt: 1234, extra: { nested: ['retained'] }, entries: [
    { id: 'operation', phase: 'blocked-provider', archiveRevision: 3, restoreOperationId: 'restore-old', candidate: { ids: ['codex:child'], unknown: { nested: true } }, members: [{ unknown: 'cold-reference-only' }], error: 'blocked', backupError: 'previous-backup-error', unknown: { preserve: true } },
  ], policies: [{ id: 'policy', archiveRevision: 7, archivedAt: '2026-10-01T00:00:00.000Z', restoredAt: '2026-10-02T00:00:00.000Z', unknown: ['policy-extra'] }] }),
  observations: observationDocument({ version: 1, extra: { retain: true }, entries: [['codex:child', { fingerprint: 'fingerprint', since: '2026-10-01T00:00:00.000Z', observedAt: 1790812800000, extra: { nested: 'observation-extra' } }, { futureTupleField: ['preserve'] }]] }),
});
async function sources(stateDir: string, data = documents()) {
  await mkdir(join(stateDir, 'retention'), { mode: 0o700 });
  await writeFile(join(stateDir, 'retention', 'journal.json'), JSON.stringify(data.journal), { mode: 0o600 });
  await writeFile(join(stateDir, 'retention-observations.json'), JSON.stringify(data.observations), { mode: 0o600 });
  const evidenceParent = join(stateDir, 'storage-migrations'); await mkdir(evidenceParent, { mode: 0o700 });
  return evidenceParent;
}
async function prepareA(stateDir: string, a: Awaited<ReturnType<typeof retentionBuild>>) {
  const client = await a.storage.openStorage({ stateDir, bundle: a.bundle() });
  const prepared = await client.prepare({ allowMigration: true });
  const preflight = await a.storage.preflightStorage({ bundle: a.bundle(), stateDir });
  await recordPreparationEvidence(stateDir, { context: client.context!, preflight, prepared, gate: await client.gate('core') });
  await client.close();
}
async function openB(t: TestContext, stateDir: string, b: Awaited<ReturnType<typeof retentionBuild>>, fault = 'normal', limits?: { maxPayloadBytes: number; maxResultBytes: number }) {
  const client = await b.storage.openStorage({ stateDir, bundle: b.bundle(fault), ...(limits ? { limits } : {}) }); t.after(() => client.close());
  await client.prepare({ allowMigration: false });
  const preflight = await b.storage.preflightStorage({ bundle: b.bundle(fault), stateDir });
  const update: StorageUpdateInput = { stateDir, managed: false, build: { version: b.version, manifest: b.manifest, preflight } };
  return { client, update };
}

test('actual A refuses first import; actual B source backup/marker/receipt; A reads and writes current DB without JSON fallback', async t => {
  const stateDir = await folder(t), { a, b } = await builds(t), original = documents(), evidenceParent = await sources(stateDir, original);
  const ac = await a.storage.openStorage({ stateDir, bundle: a.bundle() });
  const prepared = await ac.prepare({ allowMigration: true });
  const preflight = await a.storage.preflightStorage({ bundle: a.bundle(), stateDir });
  const aUpdate = { stateDir, managed: false, build: { version: a.version, manifest: a.manifest, preflight } };
  await assert.rejects(importRetention({ stateDir, evidenceParent, storage: ac, update: aUpdate }), /no cutover/);
  await assert.rejects(new RetentionRepository(ac).importPrepared(original, 'a'.repeat(64), 'a-refused'), /cutover/);
  assert.equal((await new RetentionRepository(ac).head()).authority, null, 'hidden stages do not publish authority');
  assert.equal((await ac.receipt('a-refused-commit')).found, false);
  assert.equal((await ac.gate('core')).open, true, 'retention-only failure leaves healthy core independently proven');
  const legacy = new RetentionStore(join(stateDir, 'retention'), { storage: ac }); await legacy.start(); assert.equal(legacy.migratedAt, 1234);
  await recordPreparationEvidence(stateDir, { context: ac.context!, preflight, prepared, gate: await ac.gate('core') }); await ac.close();
  const { client: bc, update } = await openB(t, stateDir, b);
  assert.equal((await evaluateStorageUpdate(update)).importAllowed, true);
  const imported = await importRetention({ stateDir, evidenceParent, storage: bc, update, commandId: 'first-import' });
  const manifestBytes = await readFile(join(imported.directory, 'manifest.json'));
  assert.equal(retentionHash(manifestBytes), imported.manifestSha256);
  const manifest = JSON.parse(manifestBytes.toString());
  assert.equal(manifest.files['journal.json'].sha256, retentionHash(await readFile(join(stateDir, 'retention', 'journal.json'))));
  assert.equal((await stat(join(imported.directory, 'journal.json'))).mode & 0o777, 0o600);
  assert.equal((await bc.receipt('first-import-commit')).found, true);
  const repository = new RetentionRepository(bc);
  assert.deepEqual((await repository.exportCurrent()).documents, original);
  await assert.rejects(importRetention({ stateDir, evidenceParent, storage: bc, update }), /marker exists/);
  await bc.close();
  await writeFile(join(stateDir, 'retention', 'journal.json'), '{bad JSON');
  await writeFile(join(stateDir, 'retention-observations.json'), '{bad JSON');
  const currentA = await a.storage.openStorage({ stateDir, bundle: a.bundle() }); t.after(() => currentA.close()); await currentA.prepare({ allowMigration: false });
  const store = new RetentionStore(join(stateDir, 'retention'), { storage: currentA }); await store.start();
  const before = store.get('operation')!;
  const next = { ...before, phase: 'planned' as const, error: 'new error' };
  await store.putIfUnchanged([{ previous: before, next }], () => false); assert.deepEqual(store.get('operation'), before);
  await store.putIfUnchanged([{ previous: before, next }], () => true); assert.deepEqual(store.get('operation'), next);
  await store.putIfUnchanged([{ previous: before, next: before }], () => true); assert.deepEqual(store.get('operation'), next, 'stale phase guard preserved');
  await store.put({ ...next, phase: 'archived' });
  await store.removeMetadata(['operation']); assert.equal(store.get('operation')!.phase, 'archived');
  await store.put(next);
  await store.setPolicy({ ...store.policy('policy')!, archiveRevision: 8 });
  const current = await new RetentionRepository(currentA).exportCurrent();
  assert.equal(current.documents.journal.migratedAt, original.journal.migratedAt);
  assert.deepEqual(current.documents.journal.extra, original.journal.extra);
  assert.deepEqual(current.documents.observations, original.observations);
  assert.equal(current.documents.journal.entries[0].error, 'new error');
  const exported = await exportRetention(currentA, evidenceParent);
  assert.deepEqual(JSON.parse(await readFile(join(exported.directory, 'journal.json'), 'utf8')), current.documents.journal, 'exports current DB, not migration backup');
  await new RetentionRepository(currentA).restore(original, 'current-restore');
  assert.deepEqual((await new RetentionRepository(currentA).exportCurrent()).documents, original);
  assert.equal((await currentA.receipt('current-restore-commit')).found, true);
  const restoreRevision = (await new RetentionRepository(currentA).head()).revision;
  await new RetentionRepository(currentA).restore(original, 'current-restore');
  assert.equal((await new RetentionRepository(currentA).head()).revision, restoreRevision, 'same restore receipt does not repeat the merge');
  await restoreRetention(currentA, exported.directory, 'sealed-current-restore');
  assert.deepEqual((await new RetentionRepository(currentA).exportCurrent()).documents, current.documents);
  await new RetentionRepository(currentA).restore(original, 'restore-original-again');
  await assert.rejects(store.removeMetadata(['operation']), /changed/);
  // The externally restored row differs from the store's cached row; guarded deletion must refuse, not delete a newer phase.
});

test('actual evaluator requires A; malformed/missing sources refuse while core stays healthy', async t => {
  const stateDir = await folder(t), { a, b } = await builds(t), evidenceParent = await sources(stateDir);
  // The schema can be prepared by A, but without its actual preparation evidence B cannot import.
  const ac = await a.storage.openStorage({ stateDir, bundle: a.bundle() }); await ac.prepare({ allowMigration: true }); await ac.close();
  const first = await openB(t, stateDir, b);
  assert.equal((await evaluateStorageUpdate(first.update)).importAllowed, false);
  await assert.rejects(importRetention({ ...first, storage: first.client, stateDir, evidenceParent }), /held/); await first.client.close();
  await prepareA(stateDir, a);
  const { client, update } = await openB(t, stateDir, b);
  await writeFile(join(stateDir, 'retention', 'journal.json'), '{broken');
  await assert.rejects(importRetention({ storage: client, update, stateDir, evidenceParent }), SyntaxError);
  assert.equal((await client.gate('core')).open, true);
  assert.equal((await new RetentionRepository(client).head()).authority, null);
  await rm(join(stateDir, 'retention-observations.json'));
  await writeFile(join(stateDir, 'retention', 'journal.json'), JSON.stringify(documents().journal));
  await assert.rejects(importRetention({ storage: client, update, stateDir, evidenceParent }), /ENOENT/);
  assert.equal((await client.gate('core')).open, true);
});

test('actual before/after commit crash receipts separate unknown from absent authority; no automatic replay', async t => {
  const { a, b } = await builds(t);
  for (const fault of ['before', 'after']) {
    const stateDir = await folder(t), evidenceParent = await sources(stateDir); await prepareA(stateDir, a);
    const { client, update } = await openB(t, stateDir, b, fault);
    await assert.rejects(importRetention({ storage: client, update, stateDir, evidenceParent, commandId: `crash-${fault}` }), (error: unknown) => { assert.equal((error as { disposition: string }).disposition, 'unknown'); return true; });
    await client.close();
    const reopened = await openB(t, stateDir, b), receipt = await reopened.client.receipt(`crash-${fault}-commit`);
    assert.equal(receipt.found, fault === 'after');
    const head = await new RetentionRepository(reopened.client).head();
    assert.equal(Boolean(head.authority), fault === 'after');
    if (fault === 'after') {
      assert.deepEqual((await new RetentionRepository(reopened.client).exportCurrent()).documents, documents());
      await assert.rejects(importRetention({ storage: reopened.client, update: reopened.update, stateDir, evidenceParent }), /marker exists/);
    }
  }
});

test('actual large accepted JSON budgets cross default payload and result bounds losslessly including huge IDs', async t => {
  const stateDir = await folder(t), { a, b } = await builds(t), data = documents();
  data.journal.entries[0] = { ...data.journal.entries[0], unknown: '\\"😀'.repeat(1_800_000) } as typeof data.journal.entries[number];
  data.observations.entries[0][0] = 'id'.repeat(700_000);
  data.observations.entries[0][1].extra = 'x'.repeat(4_000_000);
  data.journal.padding = 'x'.repeat(31_999_900 - Buffer.byteLength(JSON.stringify(data.journal)));
  data.observations.padding = 'x'.repeat(7_999_900 - Buffer.byteLength(JSON.stringify(data.observations)));
  assert.ok(Buffer.byteLength(JSON.stringify(data.journal)) <= 32_000_000);
  assert.ok(Buffer.byteLength(JSON.stringify(data.journal)) > 8 * 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(data.observations)) <= 8_000_000);
  const evidenceParent = await sources(stateDir, data); await prepareA(stateDir, a);
  const { client, update } = await openB(t, stateDir, b);
  await importRetention({ storage: client, update, stateDir, evidenceParent, commandId: 'large-import' });
  assert.deepEqual((await new RetentionRepository(client).exportCurrent()).documents, data);
  const store = new RetentionStore(join(stateDir, 'retention'), { storage: client }); await store.start();
  await store.put({ ...store.get('operation')!, error: 'large current row update' });
  assert.equal((await new RetentionRepository(client).exportCurrent()).documents.journal.entries[0].error, 'large current row update');
  const receipt = await client.receipt('large-import-commit'); assert.equal(receipt.found, true);
  await client.close();
  const legalUpper = await openB(t, stateDir, b, 'normal', { maxPayloadBytes: 16 * 1024 * 1024, maxResultBytes: 32 * 1024 * 1024 });
  assert.equal((await new RetentionRepository(legalUpper.client).exportCurrent()).documents.journal.entries[0].error, 'large current row update');
});

test('observation restart continuity and committed DB observations retain current clock and unknown fields', async t => {
  const stateDir = await folder(t), { a, b } = await builds(t), data = documents(), evidenceParent = await sources(stateDir, data); await prepareA(stateDir, a);
  const { client, update } = await openB(t, stateDir, b); await importRetention({ storage: client, update, stateDir, evidenceParent });
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
  const stateDir = await folder(t), { a, b } = await builds(t), evidenceParent = await sources(stateDir); await prepareA(stateDir, a);
  const normal = await openB(t, stateDir, b); await importRetention({ storage: normal.client, update: normal.update, stateDir, evidenceParent }); await normal.client.close();
  const lost = await openB(t, stateDir, b, 'after');
  const store = new RetentionStore(join(stateDir, 'retention'), { storage: lost.client }); await store.start();
  const previous = store.get('operation')!;
  await assert.rejects(store.put({ ...previous, error: 'committed-but-response-lost' }), (error: unknown) => { assert.equal((error as { disposition: string }).disposition, 'unknown'); return true; });
  assert.deepEqual(store.get('operation'), previous, 'unknown never publishes draft');
  const intent = (store as unknown as { repository: RetentionRepository }).repository.lastIntent!;
  await assert.rejects(store.put({ ...previous, error: 'must-not-replay' }));
  assert.equal((store as unknown as { repository: RetentionRepository }).repository.lastIntent!.id, intent.id);
  await lost.client.close();
  const reopened = await openB(t, stateDir, b);
  assert.equal((await reopened.client.receipt(intent.commandId)).found, true);
  assert.equal((await new RetentionRepository(reopened.client).exportCurrent()).documents.journal.entries[0].error, 'committed-but-response-lost');
});

test('DB-backed automatic blocked-provider cycle retains grace and cannot reach native effects', async t => {
  const stateDir = await folder(t), { a, b } = await builds(t), data = documents();
  const now = Date.UTC(2026, 9, 9), day = 86_400_000;
  data.journal.entries = []; data.journal.policies = []; data.journal.migratedAt = now - 10 * day;
  const evidenceParent = await sources(stateDir, data); await prepareA(stateDir, a);
  const { client, update } = await openB(t, stateDir, b); await importRetention({ storage: client, update, stateDir, evidenceParent });
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
  const stateDir = await folder(t), { a, b } = await builds(t), evidenceParent = await sources(stateDir); await prepareA(stateDir, a);
  const { client, update } = await openB(t, stateDir, b); await importRetention({ storage: client, update, stateDir, evidenceParent }); await client.close();
  const legacyBytes = await readFile(join(stateDir, 'retention', 'journal.json'));
  await rename(join(stateDir, 'state.sqlite'), join(stateDir, 'preserved-missing-db.sqlite'));
  const missing = await a.storage.openStorage({ stateDir, bundle: a.bundle() }); t.after(() => missing.close());
  assert.equal(missing.status().state, 'unavailable');
  await assert.rejects(new RetentionStore(join(stateDir, 'retention'), { storage: missing }).start());
  assert.deepEqual(await readFile(join(stateDir, 'retention', 'journal.json')), legacyBytes);
});
