import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat, realpath, chmod, rename, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../../../shared/types.js';
import { selectRetention, type RetentionRecord, type RetentionObservation } from '../../../server/sessions/retention/policy.js';
import { RetentionArchive } from '../../../server/sessions/retention/archive.js';
import { RetentionStore } from '../../../server/sessions/retention/store.js';
import { RetentionService } from '../../../server/sessions/retention/service.js';
const now = Date.UTC(2026, 9, 7); const day = 86_400_000;
function record(id: string, child = false, overrides: Partial<RetentionRecord> = {}): RetentionRecord {
  const session: Session = { id, nativeId: id, provider: 'claude', title: id, cwd: '/project', project: 'project', status: 'completed', statusReason: '', createdAt: new Date(now - 20 * day).toISOString(), updatedAt: new Date(now - 8 * day).toISOString(), lastMessage: '', messageCount: 1, isSubagent: child, resumable: true, ...(child ? { parentId: 'parent' } : {}) };
  return { session, kind: child ? 'subagent' : 'parent', projectKey: 'project', latestTaskEndedAt: new Date(now - 8 * day).toISOString(), lastActivityAt: new Date(now - 8 * day).toISOString(), ...overrides };
}
function observation(records: RetentionRecord[], overrides: Partial<RetentionObservation> = {}): RetentionObservation {
  return { now, migratedAt: now - 10 * day, complete: true, records, protectedIds: new Set(), ...overrides };
}
test('child expiry uses final activity and protects a completed Claude child while its parent is working', () => {
  const parent = record('parent'); parent.session.status = 'working'; parent.session.activeProcess = true;
  const child = record('child', true);
  assert.equal(selectRetention(observation([parent, child])).candidates.length, 0);
  parent.session.status = 'completed'; parent.session.activeProcess = false;
  assert.deepEqual(selectRetention(observation([parent, child])).candidates[0].ids, ['child']);
  child.lastActivityAt = new Date(now - day).toISOString();
  assert.equal(selectRetention(observation([parent, child])).candidates.length, 0);
});
test('migration, unknown termination, active descendants and cycles remain protected', () => {
  const parent = record('parent'), child = record('child', true);
  assert.equal(selectRetention(observation([parent, child], { migratedAt: now })).candidates.length, 1);
  child.latestTaskEndedAt = undefined;
  assert.equal(selectRetention(observation([parent, child])).candidates.length, 0);
  child.inactiveSince = new Date(now - 7 * day).toISOString();
  assert.equal(selectRetention(observation([parent, child])).candidates.length, 1);
  const grandchild = record('grandchild', true); grandchild.session.parentId = 'child'; grandchild.session.scheduledAt = new Date(now + day).toISOString();
  assert.equal(selectRetention(observation([parent, child, grandchild])).candidates.length, 0);
  child.session.parentId = 'grandchild'; grandchild.session.scheduledAt = undefined;
  assert.equal(selectRetention(observation([parent, child, grandchild])).candidates.length, 0);
});
test('parent count combines providers, protects descendants and excludes helpers and user forks', () => {
  const parents = Array.from({ length: 21 }, (_, i) => record(`p${i}`, false, { lastActivityAt: new Date(now - i * day).toISOString() }));
  parents[20].session.provider = 'codex';
  parents[0].session.parentId = 'p1'; // user fork starts its own family
  const helper = record('helper', false, { kind: 'helper' }); helper.session.launchedByAgent = true;
  assert.deepEqual(selectRetention(observation([...parents, helper])).candidates.find(candidate => candidate.reason === 'parent-limit')?.ids, ['p20']);
  const child = record('child', true, { lastActivityAt: new Date(now - 20 * day).toISOString() }); child.session.parentId = 'p20'; child.session.status = 'working';
  assert.equal(selectRetention(observation([...parents, child])).candidates.length, 0);
});
test('explicit child archive includes descendants and close remains separate from expiry', () => {
  const parent = record('parent'), child = record('child', true), grandchild = record('grandchild', true); grandchild.session.parentId = 'child';
  child.session.closed = true;
  assert.equal(selectRetention(observation([parent, child, grandchild], { migratedAt: now })).candidates.length, 2);
  child.archivedAt = new Date(now).toISOString();
  assert.deepEqual(selectRetention(observation([parent, child, grandchild], { migratedAt: now })).candidates[0].ids.sort(), ['child', 'grandchild']);
});
async function fixture(run: (path: string) => Promise<void>): Promise<void> {
  const path = await mkdtemp(join(await realpath(tmpdir()), 'tower-retention-domain-')); try { await run(path); } finally { await rm(path, { recursive: true, force: true }); }
}
test('private compressed backup verifies, preserves originals and survives export/import', async () => fixture(async path => {
  const native = join(path, 'native'); await mkdir(native); const source = join(native, 'child.jsonl'); await writeFile(source, 'private fixture\n');
  const archive = new RetentionArchive(join(path, 'cold'), [native]); await archive.start();
  const candidate = { rootId: 'child', ids: ['child'], reason: 'child-expired' as const, revisions: {} };
  await archive.create('operation', candidate, [record('child', true)], [{ path: source, root: native, nativeId: 'child', provider: 'claude' }]);
  assert.equal((await archive.verify('operation')).files[0].bytes, 16);
  assert.deepEqual((await archive.read('operation', 'file-0.gz', 7)).text, 'private');
  assert.equal((await archive.read('operation', 'file-0.gz', 7)).truncated, true);
  await assert.rejects(archive.read('operation', '../native/child.jsonl'), /Unknown cold payload/);
  await assert.rejects(archive.read('operation', 'file-0.gz', 2_000_000), /Invalid cold read limit/);
  assert.equal(await readFile(source, 'utf8'), 'private fixture\n');
  assert.equal((await stat(join(path, 'cold/operation/file-0.gz'))).mode & 0o777, 0o600);
  const entry = { id: 'operation', candidate, phase: 'backup-verified' as const, updatedAt: new Date(now).toISOString() };
  await archive.export('operation', join(path, 'export'), entry);
  const imported = new RetentionArchive(join(path, 'other-cold'), [native]); await imported.start();
  assert.equal((await imported.import(join(path, 'export'))).id, 'operation');
  await imported.verify('operation');
  assert.equal((await imported.import(join(path, 'export'))).id, 'operation'); // Identical verified import is idempotent.
  await writeFile(join(path, 'other-cold/operation/file-0.gz'), 'corrupt');
  await assert.rejects(imported.verify('operation'));
}));
test('source and destination symlinks, traversal and cold placement are rejected', async () => fixture(async path => {
  const native = join(path, 'native'); await mkdir(native); await writeFile(join(native, 'file'), 'fixture');
  const archive = new RetentionArchive(join(path, 'cold'), [native]); await archive.start();
  const candidate = { rootId: 'child', ids: ['child'], reason: 'child-expired' as const, revisions: {} };
  await symlink(join(native, 'file'), join(native, 'link'));
  await assert.rejects(archive.create('safe', candidate, [], [{ path: join(native, 'link'), root: native, nativeId: 'child', provider: 'claude' }]), /symlink/);
  await assert.rejects(archive.manifest('../outside'), /Invalid retention operation/);
  await assert.rejects(new RetentionArchive(join(native, 'cold'), [native]).start(), /outside native/);
}));
test('automatic blocked-provider sweep writes only metadata; explicit backup preserves native data', async () => fixture(async path => {
  const native = join(path, 'native'); await mkdir(native); const source = join(native, 'child'); await writeFile(source, 'fixture');
  const store = new RetentionStore(join(path, 'state')); await store.start(now - 10 * day);
  const archive = new RetentionArchive(join(path, 'cold'), [native]);
  let filesCalls = 0, reserves = 0;
  const service = new RetentionService({ store, archive, observe: async () => observation([record('parent'), record('child', true)]), adapter: {
    inspectCold: async members => ({ complete: true, members, issues: [] }), capability: () => ({ status: 'blocked', reason: 'No native write exclusion contract' }),
    reserve: async () => { reserves++; throw new Error('must never reserve'); },
    files: async () => { filesCalls++; return [{ path: source, root: native, nativeId: 'child', provider: 'claude' }]; },
  } });
  await service.start();
  try {
    const summary = await service.cycle(); assert.equal(summary.blockedProvider, 1); assert.equal(summary.archived, 0); assert.equal(filesCalls, 0); assert.equal(reserves, 0);
    assert.equal((await archive.list()).length, 0);
    const backup = await service.backup('child'); assert.equal(backup.phase, 'backup-verified'); assert.equal(await readFile(source, 'utf8'), 'fixture');
    await service.cycle(); assert.equal((await archive.list()).length, 1);
    assert.equal(store.get(backup.id)?.phase, 'backup-verified'); assert.equal(service.overview().backupOnly, 1);
  } finally { await service.quiesce(); }
}));
test('explicit archive state survives restart and cancels when a genuine new activity arrives', async () => fixture(async path => {
  const native = join(path, 'native'); await mkdir(native);
  const store = new RetentionStore(join(path, 'state')); const archive = new RetentionArchive(join(path, 'cold'), [native]);
  let activity = new Date(now - day).toISOString();
  const service = new RetentionService({ store, archive, observe: async () => observation([record('parent'), record('child', true, { lastActivityAt: activity, latestTaskEndedAt: activity })]), adapter: {
    inspectCold: async members => ({ complete: true, members, issues: [] }), capability: () => ({ status: 'blocked', reason: 'unsupported' }), reserve: async () => undefined, files: async () => [],
  } });
  await service.start();
  try {
    await service.verifyBackups(); await service.archiveSession('child'); assert.equal(store.policy('child')?.archivedAt, new Date(now).toISOString());
    const reopened = new RetentionStore(join(path, 'state')); await reopened.start(); assert.equal(reopened.policy('child')?.archiveRevision, 1);
    activity = new Date(now + day).toISOString(); await service.cycle(); assert.equal(store.policy('child')?.archivedAt, undefined);
  } finally { await service.quiesce(); }
}));
test('supported fixture adapter checks fresh protection before moving any original', async () => fixture(async path => {
  const native = join(path, 'native'); await mkdir(native); const source = join(native, 'child'); await writeFile(source, 'fixture');
  const store = new RetentionStore(join(path, 'state')); await store.start(now - 10 * day);
  const archive = new RetentionArchive(join(path, 'cold'), [native]); let checks = 0, removals = 0, releases = 0;
  const service = new RetentionService({ store, archive, observe: async () => observation([record('parent'), record('child', true)]), adapter: {
    inspectCold: async members => ({ complete: true, members, issues: [] }), capability: () => ({ status: 'supported' }),
    files: async () => [{ path: source, root: native, nativeId: 'child', provider: 'claude' }],
    reserve: async () => ({ revalidate: async () => { checks++; return false; }, preserveOwnership: async () => {}, moveCold: async () => { removals++; return []; }, sources: async () => [], release: async () => { releases++; } }),
  } });
  await service.start();
  try { await service.cycle(); assert.equal(removals, 0); assert.equal(releases, 1); assert.equal(store.list()[0].phase, 'conflict'); assert.equal(await readFile(source, 'utf8'), 'fixture'); assert.equal(await archive.exists(store.list()[0].id), false); }
  finally { await service.quiesce(); }
}));
test('missing transcript backups are exposed without blocking unrelated native operations', async () => fixture(async path => {
  const native = join(path, 'native'); await mkdir(native); const store = new RetentionStore(join(path, 'state')); await store.start(now - 10 * day);
  await store.put({ id: 'lost', candidate: { rootId: 'gone', ids: ['gone'], reason: 'child-expired', revisions: {} }, phase: 'archived', updatedAt: new Date(now).toISOString() });
  let reserves = 0;
  const service = new RetentionService({ store, archive: new RetentionArchive(join(path, 'cold'), [native]), observe: async () => observation([record('parent'), record('child', true)]), adapter: {
    inspectCold: async members => ({ complete: true, members, issues: [] }), capability: () => ({ status: 'supported' }), files: async () => [], reserve: async () => { reserves++; return undefined; },
  } });
  await service.start();
  try { const summary = await service.cycle(); assert.equal(summary.failures, 2); assert.equal(summary.backupFailures, 1); assert.equal(summary.archived, 0); assert.equal(store.get('lost')?.phase, 'archived'); assert.match(store.get('lost')?.backupError || '', /ENOENT/); await service.archiveSession('child'); await assert.rejects(service.restore('lost'), /no archived original/); assert.equal(reserves, 2); }
  finally { await service.quiesce(); }
}));
test('terminal operation identity survives inactive observer resets and stale unbacked metadata is pruned', async () => fixture(async path => {
  const native = join(path, 'native'); await mkdir(native); let inactiveSince = new Date(now - 10 * day).toISOString();
  const root = join(path, 'state'); const cold = join(path, 'cold');
  const make = (store: RetentionStore) => new RetentionService({ store, archive: new RetentionArchive(cold, [native]), observe: async () => observation([record('parent'), record('child', true, { inactiveSince })]), adapter: { inspectCold: async members => ({ complete: true, members, issues: [] }), capability: () => ({ status: 'blocked', reason: 'unsupported' }), files: async () => [], reserve: async () => undefined } });
  const initial = new RetentionStore(root); await initial.start(now - 10 * day); const service = make(initial); await service.start(); await service.cycle(); const id = initial.list()[0].id; await service.quiesce();
  await initial.put({ id: 'old-unbacked', candidate: { rootId: 'obsolete', ids: ['obsolete'], reason: 'child-expired', revisions: {} }, phase: 'blocked-provider', updatedAt: new Date(now).toISOString() });
  inactiveSince = new Date(now).toISOString(); const resumedStore = new RetentionStore(root); const resumed = make(resumedStore); await resumed.start();
  try { await resumed.cycle(); assert.equal(resumedStore.list().length, 1); assert.equal(resumedStore.list()[0].id, id); }
  finally { await resumed.quiesce(); }
}));
test('worker initialization returns before cold verification; removal and restore await readiness', async () => fixture(async path => {
  const native = join(path, 'native'); await mkdir(native); const store = new RetentionStore(join(path, 'state')); await store.start(now - 10 * day);
  await store.put({ id: 'fixture-backup', candidate: { rootId: 'child', ids: ['child'], reason: 'child-expired', revisions: {} }, phase: 'backup-verified', updatedAt: new Date(now).toISOString() });
  const archive = new RetentionArchive(join(path, 'cold'), [native]); let release!: () => void; let verifyCalls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  archive.verify = async () => { verifyCalls++; await gate; throw new Error('missing fixture backup'); };
  const service = new RetentionService({ store, archive, observe: async () => observation([record('parent'), record('child', true)]), adapter: { inspectCold: async members => ({ complete: true, members, issues: [] }), capability: () => ({ status: 'supported' }), files: async () => [], reserve: async () => undefined } });
  await service.start(); assert.equal(verifyCalls, 0); assert.equal(service.overview().verification, 'pending');
  await assert.rejects(service.archiveSession('child'), /verification is pending/); await assert.rejects(service.restore('fixture-backup'), /no archived original/);
  const checking = service.cycle(); await new Promise(resolve => setImmediate(resolve)); assert.equal(verifyCalls, 1); assert.equal(service.overview().verification, 'running');
  release(); await checking; assert.equal(service.overview().verification, 'complete'); assert.equal(store.get('fixture-backup')?.phase, 'backup-verified'); assert.match(store.get('fixture-backup')?.backupError || '', /missing fixture backup/); await service.quiesce();
}));
test('rejected nonempty export directory retains its original permissions', async () => fixture(async path => {
  const native = join(path, 'native'); await mkdir(native); const source = join(native, 'child'); await writeFile(source, 'fixture');
  const archive = new RetentionArchive(join(path, 'cold'), [native]); await archive.start();
  const candidate = { rootId: 'child', ids: ['child'], reason: 'child-expired' as const, revisions: {} };
  await archive.create('operation', candidate, [record('child', true)], [{ path: source, root: native, nativeId: 'child', provider: 'claude' }]);
  const target = join(path, 'existing'); await mkdir(target, { mode: 0o755 }); await writeFile(join(target, 'existing-file'), 'untouched'); const before = (await stat(target)).mode;
  await assert.rejects(archive.export('operation', target, { id: 'operation', candidate, phase: 'backup-verified', updatedAt: new Date(now).toISOString() }), /must be empty/);
  assert.equal((await stat(target)).mode, before); assert.equal(await readFile(join(target, 'existing-file'), 'utf8'), 'untouched');
}));
test('transient verification failures retry without losing the original phase; legacy missing state recovers conservatively', async () => fixture(async path => {
  const native = join(path, 'native'); await mkdir(native); const source = join(native, 'child'); await writeFile(source, 'fixture');
  const archive = new RetentionArchive(join(path, 'cold'), [native]); await archive.start(); const candidate = { rootId: 'child', ids: ['child'], reason: 'child-expired' as const, revisions: {} };
  await archive.create('operation', candidate, [record('child', true)], [{ path: source, root: native, nativeId: 'child', provider: 'claude' }]);
  const store = new RetentionStore(join(path, 'state')); await store.start(now - 10 * day); await store.put({ id: 'operation', candidate, phase: 'backup-verified', updatedAt: new Date(now).toISOString() });
  const verify = archive.verify.bind(archive); let calls = 0; archive.verify = async id => { if (++calls === 1) throw new Error('transient fixture I/O'); return verify(id); };
  const service = new RetentionService({ store, archive, onError: () => {}, observe: async () => observation([]), adapter: { inspectCold: async members => ({ complete: true, members, issues: [] }), capability: () => ({ status: 'blocked' }), files: async () => [], reserve: async () => undefined } }); await service.start();
  try {
    await service.cycle(); assert.equal(store.get('operation')?.phase, 'backup-verified'); assert.match(store.get('operation')?.backupError || '', /transient/); assert.equal(service.overview().backupOnly, 0);
    await service.cycle(); assert.equal(calls, 2); assert.equal(store.get('operation')?.backupError, undefined); assert.equal(store.get('operation')?.phase, 'backup-verified'); assert.equal(service.overview().backupOnly, 1);
  } finally { await service.quiesce(); }
  await store.put({ ...store.get('operation')!, phase: 'missing-backup', error: 'legacy verification error' });
  const legacy = new RetentionService({ store: new RetentionStore(join(path, 'state')), archive, observe: async () => observation([]), adapter: { inspectCold: async members => ({ complete: true, members, issues: [] }), capability: () => ({ status: 'blocked' }), files: async () => [], reserve: async () => undefined } }); await legacy.start();
  try { await legacy.cycle(); assert.equal(legacy.overview().backupOnly, 1); assert.equal(legacy.overview().failures, 0); } finally { await legacy.quiesce(); }
}));
test('import resumes its private scratch, registers an already committed bundle and quarantines corruption without touching native records', async () => fixture(async path => {
  const native = join(path, 'native'); await mkdir(native); const source = join(native, 'child'); await writeFile(source, 'fixture');
  const archive = new RetentionArchive(join(path, 'cold'), [native]); await archive.start(); const candidate = { rootId: 'child', ids: ['child'], reason: 'child-expired' as const, revisions: {} };
  const manifest = await archive.create('operation', candidate, [record('child', true)], [{ path: source, root: native, nativeId: 'child', provider: 'claude' }]);
  const entry = { id: 'operation', candidate, phase: 'backup-verified' as const, updatedAt: new Date(now).toISOString() }; const exported = join(path, 'export'); await archive.export('operation', exported, entry);
  await chmod(join(exported, 'manifest.json'), 0o644); await chmod(join(exported, 'export.json'), 0o640);
  const originalMode = (await stat(join(exported, 'manifest.json'))).mode; const originalExportMode = (await stat(join(exported, 'export.json'))).mode;
  const recovered = new RetentionArchive(join(path, 'recovered'), [native]); await recovered.start(); const scratch = join(path, 'recovered/operation-importing'); await mkdir(scratch, { mode: 0o700 }); await writeFile(join(scratch, 'file-0.gz'), 'interrupted'); await writeFile(join(scratch, 'import.json'), JSON.stringify(manifest));
  await recovered.import(exported); await recovered.verify('operation');
  const store = new RetentionStore(join(path, 'state')); const service = new RetentionService({ store, archive: recovered, observe: async () => observation([]), adapter: { inspectCold: async members => ({ complete: true, members, issues: [] }), capability: () => ({ status: 'blocked' }), files: async () => [], reserve: async () => undefined } }); await service.start();
  try {
    await service.importBundle(exported); assert.equal(store.get('operation')?.phase, 'backup-verified'); // Final rename had committed without a journal.
    const before = await recovered.diskBytes(); await writeFile(join(path, 'recovered/operation/file-0.gz'), 'corrupt'); await service.importBundle(exported); await recovered.verify('operation');
    const directories = await (await import('node:fs/promises')).readdir(join(path, 'recovered')); const quarantine = directories.find(name => name.startsWith('operation-quarantine-')); assert.ok(quarantine); assert.equal(await readFile(join(path, 'recovered', quarantine!, 'file-0.gz'), 'utf8'), 'corrupt');
    assert.equal((await recovered.list()).length, 1); assert.ok(await recovered.diskBytes() > before); assert.equal(await readFile(source, 'utf8'), 'fixture');
    assert.equal((await stat(join(exported, 'manifest.json'))).mode, originalMode); assert.equal((await stat(join(exported, 'export.json'))).mode, originalExportMode);
    const conflicting = structuredClone(manifest); conflicting.sessions[0].title = 'different snapshot'; await writeFile(join(exported, 'manifest.json'), JSON.stringify(conflicting));
    await assert.rejects(service.importBundle(exported), /conflicts with another bundle/); assert.deepEqual(await recovered.verify('operation'), manifest);
  } finally { await service.quiesce(); }
}));
test('incomplete observation exposes its reason and explicitly rejects backup and archive without source changes', async () => fixture(async path => {
  const native = join(path, 'native'); await mkdir(native); const store = new RetentionStore(join(path, 'state')); await store.start(now - 10 * day);
  const service = new RetentionService({ store, archive: new RetentionArchive(join(path, 'cold'), [native]), onError: () => {}, observe: async () => observation([record('parent'), record('child', true)], { complete: false, issues: ['native fixture root could not be read'] }), adapter: { inspectCold: async members => ({ complete: true, members, issues: [] }), capability: () => ({ status: 'blocked' }), files: async () => [], reserve: async () => undefined } }); await service.start();
  try { const result = await service.cycle(); assert.equal(result.observationComplete, false); assert.equal(result.deferredReasons?.['incomplete-observation'], 2); assert.deepEqual(result.observationIssues, ['native fixture root could not be read']); await assert.rejects(service.backup('child'), /native fixture root/); await assert.rejects(service.archiveSession('child'), /native fixture root/); assert.equal(store.list().length, 0); }
  finally { await service.quiesce(); }
}));
test('deferred totals and per-reason counts use the same candidate unit for backup errors, budgets and stopped work', async () => {
  const check = (summary: ReturnType<RetentionService['overview']>, reason: string, count: number) => {
    assert.equal(summary.deferred, count); assert.equal(summary.deferredReasons?.[reason], count);
    assert.equal(summary.deferred, Object.values(summary.deferredReasons || {}).reduce((sum, value) => sum + value, 0));
  };
  await fixture(async path => {
    const native = join(path, 'native'); await mkdir(native); const store = new RetentionStore(join(path, 'state')); await store.start(now - 10 * day);
    await store.put({ id: 'missing', candidate: { rootId: 'gone', ids: ['gone'], reason: 'child-expired', revisions: {} }, phase: 'backup-verified', updatedAt: new Date(now).toISOString() });
    const service = new RetentionService({ store, archive: new RetentionArchive(join(path, 'cold'), [native]), observe: async () => observation([record('parent'), record('c1', true), record('c2', true)]), adapter: { inspectCold: async members => ({ complete: true, members, issues: [] }), capability: () => ({ status: 'supported' }), files: async () => [], reserve: async () => { throw new Error('Protected work must not reserve'); } } }); await service.start();
    try { const summary = await service.cycle(); assert.equal(summary.deferred, 0); assert.equal(summary.backupFailures, 1); assert.equal(store.list().filter(entry => entry.phase === 'conflict').length, 2); } finally { await service.quiesce(); }
  });
  await fixture(async path => {
    const native = join(path, 'native'); await mkdir(native); const store = new RetentionStore(join(path, 'state')); await store.start(now - 10 * day);
    const parents = Array.from({ length: 21 }, (_, i) => record(`p${i}`, false, { lastActivityAt: new Date(now - (i + 30) * day).toISOString() }));
    const children = Array.from({ length: 100 }, (_, i) => { const child = record(`c${i}`, true, { lastActivityAt: new Date(now - 80 * day).toISOString() }); child.session.parentId = 'p20'; return child; });
    const service = new RetentionService({ store, archive: new RetentionArchive(join(path, 'cold'), [native]), observe: async () => observation([...parents, ...children]), adapter: { inspectCold: async members => ({ complete: true, members, issues: [] }), capability: () => ({ status: 'supported' }), files: async () => [], reserve: async () => { throw new Error('Over-budget work must not reserve'); } } }); await service.start();
    try { check(await service.cycle(), 'session-budget', 1); } finally { await service.quiesce(); }
  });
  await fixture(async path => {
    const native = join(path, 'native'); await mkdir(native); const store = new RetentionStore(join(path, 'state')); await store.start(now - 10 * day);
    const service = new RetentionService({ store, archive: new RetentionArchive(join(path, 'cold'), [native]), observe: async () => { service.stop(); return observation([record('parent'), record('c1', true), record('c2', true)]); }, adapter: { inspectCold: async members => ({ complete: true, members, issues: [] }), capability: () => ({ status: 'supported' }), files: async () => [], reserve: async () => { throw new Error('Stopped work must not reserve'); } } }); await service.start();
    try { check(await service.cycle(), 'maintenance-paused', 2); } finally { await service.quiesce(); }
  });
});
test('failed checks do not abort quiesce, which still drains queued intent cancellation', async () => fixture(async path => {
  const native = join(path, 'native'); await mkdir(native); const store = new RetentionStore(join(path, 'state')); await store.start(now - 10 * day);
  const restoredAt = new Date(now - day).toISOString(); await store.setPolicy({ id: 'child', archivedAt: new Date(now).toISOString(), archiveRevision: 2, restoredAt });
  let begin!: () => void, fail!: () => void, cancelBegan!: () => void, finishCancel!: () => void;
  const observed = new Promise<void>(resolve => { begin = resolve; }), failing = new Promise<void>(resolve => { fail = resolve; });
  const writing = new Promise<void>(resolve => { cancelBegan = resolve; }), finishWriting = new Promise<void>(resolve => { finishCancel = resolve; });
  const actualSetPolicy = store.setPolicy.bind(store); store.setPolicy = async policy => { cancelBegan(); await finishWriting; await actualSetPolicy(policy); };
  const errors: unknown[] = [];
  const service = new RetentionService({ store, archive: new RetentionArchive(join(path, 'cold'), [native]), onError: error => { errors.push(error); }, observe: async () => { begin(); await failing; throw new Error('fixture lookup failed'); }, adapter: { inspectCold: async members => ({ complete: true, members, issues: [] }), capability: () => ({ status: 'blocked' }), files: async () => [], reserve: async () => undefined } }); await service.start();
  const check = service.cycle(); await observed;
  const cancel = service.cancelArchiveRequest('child'); let drained = false; const quiesce = service.quiesce().then(() => { drained = true; });
  fail(); await assert.rejects(check, /fixture lookup failed/); await writing; await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
  finishCancel(); await cancel; await quiesce;
  assert.equal(drained, true); assert.ok(errors.some(error => String(error).includes('fixture lookup failed')));
  assert.equal(store.policy('child')?.archivedAt, undefined); assert.equal(store.policy('child')?.archiveRevision, 3); assert.equal(store.policy('child')?.restoredAt, restoredAt);
}));

test('journal mutations publish only after durable writes and retry from committed state', async () => fixture(async path => {
  const root = join(path, 'state'); const store = new RetentionStore(root); await store.start(now);
  const initial = { id: 'child', archivedAt: new Date(now).toISOString(), archiveRevision: 2, restoredAt: new Date(now - day).toISOString() };
  await store.setPolicy(initial);
  const existing = { id: 'existing', candidate: { rootId: 'child', ids: ['child'], reason: 'child-expired' as const, revisions: {} }, phase: 'blocked-provider' as const, updatedAt: new Date(now).toISOString() };
  await store.put(existing);
  const service = new RetentionService({ store, archive: new RetentionArchive(join(path, 'cold'), []), adapter: { inspectCold: async members => ({ complete: true, members, issues: [] }), capability: () => ({ status: 'blocked' as const }), reserve: async () => undefined, files: async () => [], restore: async () => [] }, observe: async () => observation([]), onError: () => {} });
  await rename(root, join(path, 'saved')); await writeFile(root, 'fixture obstruction');
  try {
    await assert.rejects(service.cancelArchiveRequest('child'), { code: 'ENOTDIR' });
    assert.deepEqual(store.policy('child'), initial);
    const results = await Promise.allSettled([store.put({ ...existing, id: 'failed' }), store.removeMetadata(['existing'])]);
    assert.ok(results.every(result => result.status === 'rejected'));
    assert.equal(store.get('failed'), undefined); assert.deepEqual(store.get('existing'), existing);
  } finally { await unlink(root); await rename(join(path, 'saved'), root); }
  await service.cancelArchiveRequest('child');
  await Promise.all([store.put({ ...existing, id: 'new' }), store.removeMetadata(['existing']), store.setPolicy({ id: 'other', archiveRevision: 1 })]);
  const reloaded = new RetentionStore(root); await reloaded.start();
  assert.deepEqual(reloaded.policy('child'), { id: 'child', archiveRevision: 3, restoredAt: initial.restoredAt });
  assert.equal(reloaded.policy('other')?.archiveRevision, 1);
  assert.equal(reloaded.get('existing'), undefined); assert.equal(reloaded.get('failed'), undefined); assert.equal(reloaded.get('new')?.id, 'new');
  assert.deepEqual(reloaded.list(), store.list());
}));

test('cold original remains restorable when its optional transcript export fails', async () => fixture(async path => {
  const native = join(path, 'native'), originals = join(path, 'originals'); await mkdir(native); await mkdir(originals);
  const source = join(native, 'child.jsonl'), cold = join(originals, 'child.jsonl'); await writeFile(source, 'retained original');
  const original = await stat(source); const store = new RetentionStore(join(path, 'state')); await store.start(now - 10 * day);
  const archive = new RetentionArchive(join(path, 'bundles'), [native], [originals]);
  archive.create = async () => { throw new Error('optional export fixture failure'); };
  let durableIntent = false, published = 0, released = 0;
  const service = new RetentionService({ store, archive, observe: async () => observation([record('parent'), record('child', true)]),
    reserveAdmission: () => () => { released++; }, onColdChanged: members => { published = members.length; },
    adapter: {
      capability: () => ({ status: 'supported' }), files: async () => [], inspectCold: async members => ({ complete: true, members, issues: [] }),
      reserve: async (_candidate, _records, ctx) => ({ revalidate: async () => true, preserveOwnership: async () => {}, release: async () => {},
        moveCold: async () => {
          const member = { sessionId: 'child', provider: 'claude' as const, nativeId: 'child', parentId: 'parent', originalPath: source, coldPath: cold, operationId: ctx.operationId, state: 'intent' as const,
            identity: { dev: original.dev, ino: original.ino, size: original.size, mtimeMs: original.mtimeMs } };
          await ctx.commitMember(member);
          const reopened = new RetentionStore(store.root); await reopened.start(); durableIntent = reopened.get(ctx.operationId)?.members?.[0].state === 'intent';
          assert.equal(durableIntent, true); await rename(source, cold);
          const confirmed = { ...member, state: 'cold' as const }; await ctx.commitMember(confirmed); return [confirmed];
        }, sources: async () => [{ path: cold, originalPath: source, root: native, nativeId: 'child', provider: 'claude', provenance: 'cold-original' }], }),
      restore: async (_manifest, _operation, members, ctx) => {
        assert.equal(await readFile(cold, 'utf8'), 'retained original'); await rename(cold, source);
        const restored = { ...members[0], state: 'restored' as const }; await ctx.commitMember(restored); return [restored];
      },
    } });
  await service.start();
  try {
    const result = await service.cycle(); assert.equal(result.archived, 1); assert.equal(result.archivedMembers, 1); assert.equal(result.backupFailures, 1);
    assert.equal(published, 1); assert.equal(released, 1); assert.equal(await readFile(cold, 'utf8'), 'retained original');
    await assert.rejects(readFile(source), /ENOENT/);
    const entry = store.list()[0]; assert.equal(entry.phase, 'archived'); assert.match(entry.backupError || '', /optional export fixture failure/);
    await service.restore(entry.id); assert.equal(await readFile(source, 'utf8'), 'retained original'); assert.equal(published, 0); assert.equal(released, 2);
    const reopened = new RetentionStore(store.root); await reopened.start(); assert.equal(reopened.get(entry.id)?.members?.[0].state, 'restored');
  } finally { await service.quiesce(); }
}));


test('parent-limit transfer reserves already-cold descendants without changing their journal ownership', async () => fixture(async path => {
  const native = join(path, 'native'); await mkdir(native); const store = new RetentionStore(join(path, 'state')); await store.start(now - 10 * day);
  const oldMember = { sessionId: 'cold-child', provider: 'codex' as const, nativeId: 'cold-child', parentId: 'p20', originalPath: join(native, 'child'), coldPath: join(native, 'archived-child'), operationId: 'existing-operation', state: 'cold' as const, identity: { dev:1,ino:1,size:1,mtimeMs:1 } };
  await store.put({ id: oldMember.operationId, candidate: {rootId:'cold-child',ids:['cold-child'],reason:'child-expired',revisions:{}},phase:'archived',members:[oldMember],updatedAt:new Date(now).toISOString() });
  const parents=Array.from({length:21},(_,i)=>record(`p${i}`,false,{lastActivityAt:new Date(now-(i+30)*day).toISOString()})); parents[20].session.provider='codex';
  let reserved: readonly string[]=[];
  const service=new RetentionService({store,archive:new RetentionArchive(join(path,'bundles'),[native]),observe:async()=>observation(parents),reserveAdmission:ids=>{reserved=ids;return()=>{};},adapter:{capability:()=>({status:'supported'}),inspectCold:async members=>({complete:true,members,issues:[]}),files:async()=>[],reserve:async (_candidate,_records,ctx)=>{assert.equal(ctx.managedCold()[0].operationId,'existing-operation');return undefined;}}});
  await service.start();try{await service.cycle();assert.deepEqual([...reserved].sort(),['cold-child','p20']);assert.deepEqual(store.get('existing-operation')?.members,[oldMember]);}finally{await service.quiesce();}
}));
test('parent-limit keeps a family whose inactive descendant has not reached seven days', () => {
  const parents=Array.from({length:21},(_,i)=>record(`p${i}`,false,{lastActivityAt:new Date(now-i*day).toISOString()}));
  const child=record('young',true,{latestTaskEndedAt:new Date(now-day).toISOString(),lastActivityAt:new Date(now-20*day).toISOString()});child.session.parentId='p20';
  const selected=selectRetention(observation([...parents,child]));assert.equal(selected.candidates.length,0);assert.ok(selected.deferred.some(item=>item.id==='p20'&&item.reason==='young-descendant'));
});

test('cold reconciliation batches operations, keeps newer commits and drains before handoff', async () => fixture(async path => {
  const native=join(path,'native');await mkdir(native);const store=new RetentionStore(join(path,'state'));await store.start(now-10*day);
  const member=(id:string)=>({sessionId:id,provider:'codex' as const,nativeId:id,originalPath:join(native,id),coldPath:join(native,'archived-'+id),operationId:id,state:'cold' as const,identity:{dev:1,ino:1,size:1,mtimeMs:1}});
  for(const id of ['one','two'])await store.put({id,candidate:{rootId:id,ids:[id],reason:'child-expired',revisions:{}},phase:'archived',members:[member(id)],updatedAt:new Date(now).toISOString()});
  let begin!:()=>void,finish!:()=>void,calls=0;const began=new Promise<void>(resolve=>{begin=resolve;}),end=new Promise<void>(resolve=>{finish=resolve;});
  const service=new RetentionService({store,archive:new RetentionArchive(join(path,'bundles'),[native]),observe:async()=>observation([]),adapter:{capability:()=>({status:'supported'}),files:async()=>[],reserve:async()=>undefined,inspectCold:async members=>{calls++;assert.equal(members.length,2);begin();await end;return{complete:true,members:members.map(value=>({...value,state:'conflict' as const,error:'old inspection'})),issues:[]};}}});
  await service.start();const pending=service.reconcileCold();await began;
  await store.put({...store.get('one')!,members:[{...member('one'),state:'restored'}],phase:'restored-awaiting-start'});
  let drained=false;const draining=service.quiesce().then(()=>{drained=true;});await Promise.resolve();assert.equal(drained,false);finish();await pending;await draining;
  assert.equal(calls,1);assert.equal(store.get('one')?.members?.[0].state,'restored');assert.equal(store.get('two')?.members?.[0].state,'cold','paused inspection cannot write after handoff');
  await service.reconcileCold();assert.equal(calls,1,'paused inspection never begins again');
}));
