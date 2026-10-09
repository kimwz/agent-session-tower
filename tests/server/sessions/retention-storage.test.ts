import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, stat, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RunManager } from '../../../server/runs/manager.js';
import type { StorageStatus } from '../../../server/storage/contract.js';
import type { WorkerStorageStatus } from '../../../shared/storage.js';
import { createMonitorServer } from '../../../server/http/server.js';
import { retentionBuild } from '../storage/fixtures/retention-build.js';
import { recordPreparationEvidence, evaluateStorageUpdate, type StorageUpdateInput } from '../../../server/link/storage-update.js';
import { RetentionStore } from '../../../server/sessions/retention/store.js';
import { RetentionObserver } from '../../../server/sessions/retention/observer.js';
import { RetentionRepository } from '../../../server/sessions/retention/storage-repository.js';
import { exportRetention, importRetention, restoreRetention } from '../../../server/sessions/retention/storage-transfer.js';
import { journalDocument, observationDocument, retentionHash, type RetentionDocuments } from '../../../server/sessions/retention/storage-codec.js';
import { RetentionService } from '../../../server/sessions/retention/service.js';
import { RetentionArchive } from '../../../server/sessions/retention/archive.js';
import { SessionService } from '../../../server/sessions/service.js';
import type { RetentionRecord } from '../../../server/sessions/retention/policy.js';
import { createNativeRetentionAdapter } from '../../../server/sessions/retention/provider.js';
import type { RetentionJournalEntry, RetentionOperationContext } from '../../../server/sessions/retention/types.js';

async function folder(t: TestContext) { const path = await realpath(await mkdtemp(join(tmpdir(), 'tower-retention-fixture-'))); t.after(() => rm(path, { recursive: true, force: true })); return path; }
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

for (const damage of ['malformed', 'missing'] as const) test(`actual B to A journal loads despite ${damage} observations and the real cold scan preserves launcher proof bytes`, async t => {
  const stateDir = await folder(t), { a, b } = await builds(t), data = documents();
  const claudeHome = join(stateDir, 'fixture-claude'), codexHome = join(stateDir, 'fixture-codex');
  const hot = join(claudeHome, 'projects', 'fixture'), coldPath = join(stateDir, 'fixture-cold', 'B.jsonl');
  await mkdir(hot, { recursive: true });
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await mkdir(join(codexHome, 'archived_sessions'));
  await mkdir(join(stateDir, 'fixture-cold'));
  const createdAt = '2026-09-01T00:00:00.000Z';
  const transcript = (id: string) => JSON.stringify({ type: 'user', sessionId: id, cwd: stateDir, entrypoint: 'cli', timestamp: createdAt, message: { role: 'user', content: id } }) + '\n';
  await writeFile(join(hot, 'A.jsonl'), transcript('A'));
  await writeFile(coldPath, transcript('B'));
  data.journal.entries[0] = { ...data.journal.entries[0], phase: 'archived', candidate: { ...data.journal.entries[0].candidate, ids: ['claude:B'] }, members: [{
    sessionId: 'claude:B', provider: 'claude', nativeId: 'B', parentId: 'claude:A', isSubagent: true, parentLink: 'exec', createdAt,
    operationId: 'operation', state: 'cold', originalPath: join(hot, 'B.jsonl'), coldPath,
    identity: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
  }] };
  const proofPath = join(stateDir, 'agent-launches.json');
  const proofBytes = Buffer.from('{ "version": 1, "launches": { "claude:B": ["claude:A"] } }\n');
  await writeFile(proofPath, proofBytes, { mode: 0o600 });
  const evidenceParent = await sources(stateDir, data); await prepareA(stateDir, a);
  const { client: bc, update } = await openB(t, stateDir, b);
  await importRetention({ storage: bc, update, stateDir, evidenceParent, commandId: 'cold-journal-import' });
  const importedHead = await new RetentionRepository(bc).head();
  await bc.close();
  const db = new DatabaseSync(join(stateDir, 'state.sqlite'));
  try {
    const changed = damage === 'missing'
      ? db.prepare("DELETE FROM retention_metadata WHERE kind = 'observations' AND id = ''").run()
      : db.prepare("UPDATE retention_metadata SET json = ? WHERE kind = 'observations' AND id = ''").run(JSON.stringify({ ...data.observations, version: 2, entries: undefined }));
    assert.equal(changed.changes, 1);
  } finally { db.close(); }
  await writeFile(join(stateDir, 'retention', 'journal.json'), '{invalid legacy journal');
  await writeFile(join(stateDir, 'retention-observations.json'), '{invalid legacy observations');
  const currentA = await a.storage.openStorage({ stateDir, bundle: a.bundle() }); t.after(() => currentA.close());
  await currentA.prepare({ allowMigration: false });
  const repository = new RetentionRepository(currentA);
  assert.deepEqual(await repository.head(), importedHead, 'observation damage preserves authority and revision');
  assert.equal(await repository.databaseAuthority(), true);
  const observationError = damage === 'missing' ? /Missing retention observations metadata/ : /Invalid retention observations/;
  assert.deepEqual((await repository.readCurrentJournal()).journal, data.journal, 'root and nested metadata survive independently');
  await assert.rejects(repository.exportCurrent(), observationError);
  const store = new RetentionStore(join(stateDir, 'retention'), { storage: currentA }); await store.start();
  assert.deepEqual(store.list(), data.journal.entries);
  assert.deepEqual(store.policy('policy'), data.journal.policies && data.journal.policies[0]);
  assert.equal(store.migratedAt, data.journal.migratedAt);
  const members = store.list().flatMap(entry => entry.members || []).filter(member => member.state !== 'restored');
  assert.deepEqual(members.map(member => `${member.provider}:${member.nativeId}`), ['claude:B']);
  const sessions = new SessionService({ claudeHome, codexHome, launchProofs: proofPath,
    inspectProcesses: async () => ({ claude: new Map(), codex: new Set<string>(), providerRunning: { claude: false, codex: false } }) });
  t.after(() => sessions.stop());
  sessions.setColdRegistry(members.flatMap(member => [member.originalPath, ...(member.coldPath ? [member.coldPath] : [])]), members.map(member => `${member.provider}:${member.nativeId}`));
  const observer = new RetentionObserver({ stateDir, storage: currentA, snapshot: () => sessions.completedRetentionRecords(),
    reconcile: value => value, journalMembers: () => members, runs: () => [], settled: () => new Set(), protectedIds: () => [] });
  await assert.rejects(observer.start(), observationError);
  assert.equal(currentA.status().state, 'ready');
  assert.equal((await currentA.gate('core')).open, true, 'observation format failure remains domain-local');
  await sessions.refresh(); await sessions.quiesce();
  assert.ok(sessions.get('claude:A'), 'accessible hot Claude history exercises proof pruning');
  assert.equal(sessions.get('claude:B'), undefined, 'cold original is outside the native scan');
  assert.deepEqual(await readFile(proofPath), proofBytes, 'real scanner retains exact launcher proof bytes');
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

test('actual A/B same captured SDK reopen leaves uncertain store held despite healthy observer and native fixture', async t => {
  const { a, b } = await builds(t);
  for (const build of [a, b]) {
    const stateDir = await folder(t), data = documents();
    const claudeHome = join(stateDir, 'fixture-claude'), codexHome = join(stateDir, 'fixture-codex');
    const hot = join(claudeHome, 'projects', 'fixture'), coldRoot = join(stateDir, 'fixture-cold');
    await mkdir(hot, { recursive: true }); await mkdir(coldRoot); await mkdir(codexHome);
    const originalPath = join(hot, 'B.jsonl'), coldPath = join(coldRoot, 'B.jsonl');
    const coldBytes = Buffer.from('{"sessionId":"B","message":{"role":"user","content":"cold original"}}\n');
    const hotPath = join(hot, 'A.jsonl'), hotBytes = Buffer.from('preserve unrelated hot original\n');
    await writeFile(coldPath, coldBytes); await writeFile(hotPath, hotBytes);
    const info = await stat(coldPath);
    data.journal.entries[0] = { ...data.journal.entries[0], phase: 'archived', candidate: { ...data.journal.entries[0].candidate, ids: ['claude:B'] }, members: [{
      sessionId: 'claude:B', provider: 'claude', nativeId: 'B', isSubagent: false, createdAt: '2026-09-01T00:00:00.000Z',
      operationId: 'operation', state: 'cold', originalPath, coldPath,
      identity: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs },
    }] };
    const evidenceParent = await sources(stateDir, data); await prepareA(stateDir, a);
    const normal = await openB(t, stateDir, b);
    await importRetention({ storage: normal.client, update: normal.update, stateDir, evidenceParent }); await normal.client.close();
    const client = await build.storage.openStorage({ stateDir, bundle: build.bundle('after-native-hold') }); t.after(() => client.close());
    await client.prepare({ allowMigration: false });
    const store = new RetentionStore(join(stateDir, 'retention'), { storage: client }); await store.start();
    const observer = new RetentionObserver({ stateDir, storage: client, snapshot: () => ({ complete: true, records: [] }),
      reconcile: value => value, journalMembers: () => store.list().flatMap(entry => entry.members || []),
      runs: () => [], settled: () => new Set(), protectedIds: () => [] });
    await observer.start();
    let inspections = 0;
    const adapter = createNativeRetentionAdapter({ claude: [join(claudeHome, 'projects')], codex: [codexHome] }, {
      coldRoot, claudeHome, codexHome, inspect: async () => { inspections++; return { complete: true, activeIds: new Set(), issues: [] }; },
    });
    const service = new RetentionService({ store, adapter, archive: new RetentionArchive(join(stateDir, 'bundles'), [hot], [coldRoot]), observe: () => observer.observe() });
    const previous = store.get('operation')!;
    const native = await adapter.inspectCold(previous.members!);
    assert.equal(native.complete, true); assert.equal(native.members[0].state, 'cold');
    inspections = 0;
    await assert.rejects(store.put({ ...previous, error: 'native-hold-response-lost' }), (error: unknown) => {
      assert.equal((error as { disposition: string }).disposition, 'unknown'); return true;
    });
    const repository = (store as unknown as { repository: RetentionRepository }).repository;
    const intent = structuredClone(repository.lastIntent!);
    await client.reopen(); await client.prepare({ allowMigration: false });
    assert.equal((await client.gate('core')).open, true); assert.equal((await client.gate('retention')).open, true);
    service.resume();
    assert.equal((await observer.observe()).complete, true, 'same observer repository is healthy after same SDK reopen');
    const current = new RetentionRepository(client);
    const head = await current.head();
    assert.equal((await client.receipt(intent.commandId)).found, true);
    assert.equal((await current.readCurrentJournal()).journal.entries[0].error, 'native-hold-response-lost');
    const context = (service as unknown as { context(entry: RetentionJournalEntry): RetentionOperationContext }).context(previous);
    await assert.rejects(context.fresh(), (error: unknown) => (error as { disposition: string }).disposition === 'unknown');
    await assert.rejects(adapter.restore!({ version: 1, id: previous.id, createdAt: previous.updatedAt, reason: previous.candidate.reason, files: [], sessions: [] },
      'held-native-restore', previous.members!, context), (error: unknown) => (error as { disposition: string }).disposition === 'unknown');
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(service.restore('operation'), (error: unknown) => (error as { disposition: string }).disposition === 'unknown');
    await assert.rejects(store.put({ ...previous, error: 'must-not-replay' }));
    await service.quiesce();
    assert.equal(inspections, 0, 'restore stops before provider inspection and native effects');
    await assert.rejects(stat(originalPath), { code: 'ENOENT' });
    assert.deepEqual(await readFile(coldPath), coldBytes); assert.deepEqual(await readFile(hotPath), hotBytes);
    const after = await stat(coldPath); assert.equal(after.ino, info.ino); assert.equal(after.dev, info.dev); assert.equal(after.nlink, info.nlink);
    assert.deepEqual(store.get('operation'), previous); assert.deepEqual(repository.lastIntent, intent);
    assert.equal((await current.head()).revision, head.revision, 'held attempts neither replay nor publish conflict journal writes');
  }
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


test('DB observations recover snapshot and known write failures without losing committed guards or protection', async t => {
  const { a, b } = await builds(t);
  for (const failure of ['snapshot', 'write']) {
    const stateDir = await folder(t), data = documents(), evidenceParent = await sources(stateDir, data);
    await prepareA(stateDir, a);
    const normal = await openB(t, stateDir, b);
    await importRetention({ storage: normal.client, update: normal.update, stateDir, evidenceParent });
    await normal.client.close();
    const { client } = await openB(t, stateDir, b, failure === 'write' ? 'refuse-once' : 'normal');
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

test('accepted numeric expansion imports, guarded updates, pages and sealed restores through actual default SDK bounds', async t => {
  const stateDir = await folder(t), { a, b } = await builds(t), data = documents();
  // One designated hosted CI member runs the near-32MB source. Other members
  // still genuinely exceed the old 32MB canonical restore budget.
  const count = process.env.SQLITE_RETENTION_LARGE === '1' ? 6_000_000 : 1_500_000;
  (data.journal.entries[0] as unknown as Record<string, unknown>).unknown = 'NUMERIC_EXPANSION';
  data.journal.policies = Array.from({ length: 40 }, (_, index) => ({ id: `paged-${index}`, archiveRevision: index }));
  const evidenceParent = await sources(stateDir, data);
  const source = JSON.stringify(data.journal).replace('"NUMERIC_EXPANSION"', '[' + '1e20,'.repeat(count - 1) + '1e20]');
  assert.ok(Buffer.byteLength(source) < 32_000_000);
  const canonical = JSON.stringify(JSON.parse(source));
  assert.ok(Buffer.byteLength(canonical) > 32_000_000);
  if (count === 6_000_000) assert.ok(Buffer.byteLength(canonical) > 132_000_000);
  await writeFile(join(stateDir, 'retention', 'journal.json'), source, { mode: 0o600 });
  await prepareA(stateDir, a);
  const { client, update } = await openB(t, stateDir, b);
  await writeFile(join(stateDir, 'retention', 'journal.json'), source.padEnd(32_000_001, ' '), { mode: 0o600 });
  await assert.rejects(importRetention({ storage: client, update, stateDir, evidenceParent, commandId: 'numeric-too-large' }), /Unsafe retention source/);
  assert.equal((await new RetentionRepository(client).head()).authority, null);
  await writeFile(join(stateDir, 'retention', 'journal.json'), source, { mode: 0o600 });
  await importRetention({ storage: client, update, stateDir, evidenceParent, commandId: 'numeric-import' });
  const store = new RetentionStore(join(stateDir, 'retention'), { storage: client }); await store.start();
  await store.put({ ...store.get('operation')!, error: 'expanded guarded update' });
  const repository = new RetentionRepository(client), current = await repository.exportCurrent();
  const values = (current.documents.journal.entries[0] as unknown as Record<string, unknown>).unknown as number[];
  assert.equal(values.length, count); assert.equal(values[0], 1e20); assert.equal(values[count - 1], 1e20);
  assert.equal(current.documents.journal.policies && current.documents.journal.policies.length, 40, 'ordinal paging crosses a 32-row page');
  const intent = (store as unknown as { repository: RetentionRepository }).repository.lastIntent!;
  assert.equal((await client.receipt(intent.commandId)).found, true);
  const db = new DatabaseSync(join(stateDir, 'state.sqlite'), { readOnly: true });
  try {
    const parts = db.prepare("SELECT count(*) AS n FROM operation_receipts WHERE scope = 'retention' AND command = 'stage'").get() as { n: number };
    assert.ok(parts.n > 128, 'default 1MiB command/8MiB response SDK enforced many bounded stage pages');
  } finally { db.close(); }
  const exported = await exportRetention(client, evidenceParent, 'numeric-export');
  assert.ok((await stat(join(exported.directory, 'journal.json'))).size > 32_000_000);
  await store.put({ ...store.get('operation')!, error: 'after sealed export' });
  await restoreRetention(client, exported.directory, 'numeric-restore');
  const restored = (await repository.exportCurrent()).documents;
  assert.equal(restored.journal.entries[0].error, 'expanded guarded update');
  assert.equal(((restored.journal.entries[0] as unknown as Record<string, unknown>).unknown as number[]).length, count);
  assert.equal((await client.receipt('numeric-restore-commit')).found, true);
  assert.equal(retentionHash(JSON.stringify(restored)), current.sha256);
  const manifestPath = join(exported.directory, 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const revision = (await repository.head()).revision;
  await assert.rejects(repository.restore(restored, 'raced-export-generation', current.head.authority!.generation + 1), /another authority generation/);
  assert.equal((await client.receipt('raced-export-generation-commit')).found, false);
  manifest.head.authority.generation += 1;
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(restoreRetention(client, exported.directory, 'wrong-export-generation'), /another authority generation/);
  assert.equal((await client.receipt('wrong-export-generation-commit')).found, false);
  manifest.head.authority.generation -= 1;
  const exportPath = join(exported.directory, 'journal.json'), noncanonical = Buffer.concat([Buffer.from(' '), await readFile(exportPath)]);
  await writeFile(exportPath, noncanonical);
  manifest.files['journal.json'] = { bytes: noncanonical.length, sha256: retentionHash(noncanonical) };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(restoreRetention(client, exported.directory, 'noncanonical-export'), /exact canonical export/);
  assert.equal((await client.receipt('noncanonical-export-commit')).found, false);
  assert.equal((await repository.head()).revision, revision);
});

test('actual SQLite corrupt and I/O command errors activate existing intake hold; format refusal keeps core healthy', async t => {
  const { a, b } = await builds(t);
  const damagedPath = join(b.directory, 'corrupt.sqlite');
  const damaged = new DatabaseSync(damagedPath);
  damaged.exec('CREATE TABLE damage (value TEXT); INSERT INTO damage VALUES (\'fixture\');'); damaged.close();
  const damagedBytes = await readFile(damagedPath); damagedBytes[100] = 0;
  await writeFile(damagedPath, damagedBytes, { mode: 0o600 });
  for (const fault of ['corrupt', 'io']) {
    const stateDir = await folder(t), evidenceParent = await sources(stateDir);
    await prepareA(stateDir, a);
    const normal = await openB(t, stateDir, b);
    await importRetention({ storage: normal.client, update: normal.update, stateDir, evidenceParent }); await normal.client.close();
    let effects = 0, unavailable: StorageStatus | undefined;
    let health: WorkerStorageStatus = { state: 'ready', code: 'ready', reason: '', admissionOpen: true, sessionsAvailable: true, healthStatus: 200 };
    const manager = new RunManager({ stateDir: join(stateDir, 'fixture-runner'), getSession: () => undefined, refreshSessions: async () => {},
      holdUntilReady: true, findExecutable: async () => { effects++; throw new Error('must not reach provider'); } });
    await manager.start(); t.after(() => manager.close());
    const client = await b.storage.openStorage({ stateDir, bundle: b.bundle(fault), onUnavailable: status => { unavailable = status; manager.holdStorage(); health = { ...health, state: 'unavailable', code: status.failure!.code, reason: status.failure!.message, admissionOpen: false, healthStatus: 503 }; } });
    t.after(() => client.close()); await client.prepare({ allowMigration: false });
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
    await client.close(); await manager.close();
  }
  const stateDir = await folder(t), evidenceParent = await sources(stateDir);
  await prepareA(stateDir, a);
  const normal = await openB(t, stateDir, b);
  await importRetention({ storage: normal.client, update: normal.update, stateDir, evidenceParent }); await normal.client.close();
  const db = new DatabaseSync(join(stateDir, 'state.sqlite'));
  try { db.prepare("UPDATE retention_metadata SET json = ? WHERE kind = 'journal'").run('{invalid'); } finally { db.close(); }
  const healthy = await openB(t, stateDir, b);
  await assert.rejects(new RetentionStore(join(stateDir, 'retention'), { storage: healthy.client }).start(), SyntaxError);
  assert.equal(healthy.client.status().state, 'ready', 'domain format quarantine does not claim a physical DB failure');
  assert.equal((await healthy.client.gate('core')).open, true);

});


test('unknown observation commit preserves memory and forbids retry even when the DB committed', async t => {
  const stateDir = await folder(t), { a, b } = await builds(t), data = documents(), evidenceParent = await sources(stateDir, data);
  await prepareA(stateDir, a);
  const normal = await openB(t, stateDir, b);
  await importRetention({ storage: normal.client, update: normal.update, stateDir, evidenceParent }); await normal.client.close();
  const lost = await openB(t, stateDir, b, 'after');
  const observer = new RetentionObserver({ stateDir, storage: lost.client, now: () => data.observations.entries[0][1].observedAt + 1000,
    snapshot: () => ({ complete: true, records: [] }), reconcile: sessions => sessions, runs: () => [], settled: () => new Set(), protectedIds: () => [] });
  await observer.start();
  const view = observer as unknown as { inactive: Map<string, unknown>; repository: RetentionRepository; restarted: boolean };
  const committed = [...view.inactive];
  await assert.rejects(observer.observe(), (error: unknown) => { assert.equal((error as { disposition: string }).disposition, 'unknown'); return true; });
  assert.deepEqual([...view.inactive], committed); assert.equal(view.restarted, true);
  const intent = view.repository.lastIntent!;
  await assert.rejects(observer.observe()); assert.equal(view.repository.lastIntent!.id, intent.id);
  await lost.client.close();
  const reopened = await openB(t, stateDir, b);
  assert.equal((await reopened.client.receipt(intent.commandId)).found, true);
  assert.deepEqual((await new RetentionRepository(reopened.client).exportCurrent()).documents.observations.entries, []);
});
