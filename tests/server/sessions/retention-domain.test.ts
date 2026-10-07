import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat, realpath } from 'node:fs/promises';
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
test('child expiry uses final activity and does not retain old completed child for a working parent', () => {
  const parent = record('parent'); parent.session.status = 'working'; parent.session.activeProcess = true;
  const child = record('child', true);
  assert.deepEqual(selectRetention(observation([parent, child])).candidates[0].ids, ['child']);
  child.lastActivityAt = new Date(now - day).toISOString();
  assert.equal(selectRetention(observation([parent, child])).candidates.length, 0);
});
test('migration, unknown termination, active descendants and cycles remain protected', () => {
  const parent = record('parent'), child = record('child', true);
  assert.equal(selectRetention(observation([parent, child], { migratedAt: now })).candidates.length, 0);
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
test('explicit child archive includes descendants but existing close does not bypass migration', () => {
  const parent = record('parent'), child = record('child', true), grandchild = record('grandchild', true); grandchild.session.parentId = 'child';
  child.session.closed = true;
  assert.equal(selectRetention(observation([parent, child, grandchild], { migratedAt: now })).candidates.length, 0);
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
  await assert.rejects(imported.import(join(path, 'export')), /already exists/);
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
    capability: () => ({ status: 'blocked', reason: 'No native write exclusion contract' }),
    reserve: async () => { reserves++; throw new Error('must never reserve'); },
    files: async () => { filesCalls++; return [{ path: source, root: native, nativeId: 'child', provider: 'claude' }]; },
  } });
  await service.start();
  try {
    const summary = await service.cycle(); assert.equal(summary.blockedProvider, 1); assert.equal(summary.archived, 0); assert.equal(filesCalls, 0); assert.equal(reserves, 0);
    assert.equal((await archive.list()).length, 0);
    const backup = await service.backup('child'); assert.equal(backup.phase, 'backup-verified'); assert.equal(await readFile(source, 'utf8'), 'fixture');
    await service.cycle(); assert.equal((await archive.list()).length, 1);
  } finally { await service.quiesce(); }
}));
test('explicit archive state survives restart and cancels when a genuine new activity arrives', async () => fixture(async path => {
  const native = join(path, 'native'); await mkdir(native);
  const store = new RetentionStore(join(path, 'state')); const archive = new RetentionArchive(join(path, 'cold'), [native]);
  let activity = new Date(now - day).toISOString();
  const service = new RetentionService({ store, archive, observe: async () => observation([record('parent'), record('child', true, { lastActivityAt: activity, latestTaskEndedAt: activity })]), adapter: {
    capability: () => ({ status: 'blocked', reason: 'unsupported' }), reserve: async () => undefined, files: async () => [],
  } });
  await service.start();
  try {
    await service.archiveSession('child'); assert.equal(store.policy('child')?.archivedAt, new Date(now).toISOString());
    const reopened = new RetentionStore(join(path, 'state')); await reopened.start(); assert.equal(reopened.policy('child')?.archiveRevision, 1);
    activity = new Date(now + day).toISOString(); await service.cycle(); assert.equal(store.policy('child')?.archivedAt, undefined);
  } finally { await service.quiesce(); }
}));
test('supported fixture adapter rechecks its lease after backup before removing any original', async () => fixture(async path => {
  const native = join(path, 'native'); await mkdir(native); const source = join(native, 'child'); await writeFile(source, 'fixture');
  const store = new RetentionStore(join(path, 'state')); await store.start(now - 10 * day);
  const archive = new RetentionArchive(join(path, 'cold'), [native]); let checks = 0, removals = 0, releases = 0;
  const service = new RetentionService({ store, archive, observe: async () => observation([record('parent'), record('child', true)]), adapter: {
    capability: () => ({ status: 'supported' }),
    files: async () => [{ path: source, root: native, nativeId: 'child', provider: 'claude' }],
    reserve: async () => ({ revalidate: async () => ++checks === 1, preserveOwnership: async () => {}, remove: async () => { removals++; }, release: async () => { releases++; } }),
  } });
  await service.start();
  try { await service.cycle(); assert.equal(removals, 0); assert.equal(releases, 1); assert.equal(store.list()[0].phase, 'conflict'); assert.equal(await readFile(source, 'utf8'), 'fixture'); await archive.verify(store.list()[0].id); }
  finally { await service.quiesce(); }
}));
test('missing backups are exposed after restart and block further removal', async () => fixture(async path => {
  const native = join(path, 'native'); await mkdir(native); const store = new RetentionStore(join(path, 'state')); await store.start(now - 10 * day);
  await store.put({ id: 'lost', candidate: { rootId: 'gone', ids: ['gone'], reason: 'child-expired', revisions: {} }, phase: 'archived', updatedAt: new Date(now).toISOString() });
  let reserves = 0;
  const service = new RetentionService({ store, archive: new RetentionArchive(join(path, 'cold'), [native]), observe: async () => observation([record('parent'), record('child', true)]), adapter: {
    capability: () => ({ status: 'supported' }), files: async () => [], reserve: async () => { reserves++; return undefined; },
  } });
  await service.start();
  try { const summary = await service.cycle(); assert.equal(summary.failures, 1); assert.equal(summary.archived, 0); assert.equal(store.get('lost')?.phase, 'missing-backup'); assert.equal(reserves, 0); }
  finally { await service.quiesce(); }
}));
