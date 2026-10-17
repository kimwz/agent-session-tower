import { actualStorage, prepareActualStorage, closeActualStorage } from './retention-actual-storage.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../../../shared/types.js';
import { selectRetention, type RetentionRecord, type RetentionObservation } from '../../../server/sessions/retention/policy.js';
import { RetentionArchive } from '../../../server/sessions/retention/archive.js';
import { RetentionStore } from '../../../server/sessions/retention/store.js';
import { RetentionService } from '../../../server/sessions/retention/service.js';
import type { RetentionAdapter, RetentionMember } from '../../../server/sessions/retention/types.js';

// A closed issue asks for its sessions to be archived once they settle (archiveWhenIdle).
const now = Date.UTC(2026, 9, 17); const day = 86_400_000; const hour = 3_600_000;
const iso = (time: number) => new Date(time).toISOString();
function record(id: string, parentId?: string, overrides: Partial<RetentionRecord> = {}): RetentionRecord {
  const session: Session = { id, nativeId: id, provider: 'claude', title: id, cwd: '/state/todo-masters/t1', project: 't1', status: 'completed', statusReason: '', createdAt: iso(now - 2 * day), updatedAt: iso(now - hour), lastMessage: '', messageCount: 1, isSubagent: Boolean(parentId), resumable: true, ...(parentId ? { parentId } : {}) };
  return { session, kind: parentId ? 'subagent' : 'parent', latestTaskEndedAt: iso(now - hour), lastActivityAt: iso(now - hour), ...overrides };
}
function observation(records: RetentionRecord[], overrides: Partial<RetentionObservation> = {}): RetentionObservation {
  return { now, migratedAt: now - 30 * day, complete: true, records, protectedIds: new Set(), ...overrides };
}
const requested = (overrides: Partial<RetentionRecord> = {}) => ({ archiveWhenIdle: true, archiveRevision: 1, ...overrides });

test('a requested master leaves with its subagents once its turn ends, whatever happened after the request', () => {
  const master = record('master', undefined, requested({ lastActivityAt: iso(now - 10 * 60_000), latestTaskEndedAt: iso(now - 10 * 60_000) }));
  master.session.master = true;
  const child = record('child', 'master'), grandchild = record('grandchild', 'child');
  const [candidate, ...others] = selectRetention(observation([master, child, grandchild])).candidates;
  assert.equal(others.length, 0);
  assert.equal(candidate.reason, 'explicit-archive'); assert.equal(candidate.rootId, 'master');
  assert.deepEqual(candidate.ids.sort(), ['child', 'grandchild', 'master']);
  // Without the request a young parent stays.
  delete master.archiveWhenIdle;
  assert.deepEqual(selectRetention(observation([master, child, grandchild])).candidates, []);
});

test('a requested session that is working, scheduled, being created or otherwise protected waits, then goes', () => {
  for (const protect of [
    (r: RetentionRecord) => { r.session.status = 'working'; r.latestTaskEndedAt = undefined; },
    (r: RetentionRecord) => { r.session.activeProcess = true; },
    (r: RetentionRecord) => { r.session.scheduledAt = iso(now + hour); },
    (r: RetentionRecord) => { r.session.creationPending = true; },
  ]) {
    const master = record('master', undefined, requested()); protect(master);
    const selection = selectRetention(observation([master]));
    assert.deepEqual(selection.candidates, []);
    assert.ok(selection.deferred.some(item => item.id === 'master'));
  }
  const master = record('master', undefined, requested());
  assert.equal(selectRetention(observation([master], { protectedIds: new Set(['master']) })).candidates.length, 0);
  // A working subagent holds its requested parent back too.
  const child = record('child', 'master'); child.session.status = 'working';
  assert.deepEqual(selectRetention(observation([master, child])).deferred, [{ id: 'master', reason: 'protected' }]);
  child.session.status = 'completed';
  assert.deepEqual(selectRetention(observation([master, child])).candidates[0].ids.sort(), ['child', 'master']);
});

test('without a recorded end, a requested session goes after a quiet day and waits before that', () => {
  const master = record('master', undefined, requested({ latestTaskEndedAt: undefined, inactiveSince: iso(now - 23 * hour) }));
  assert.deepEqual(selectRetention(observation([master])).deferred, [{ id: 'master', reason: 'awaiting-idle' }]);
  master.inactiveSince = undefined;
  assert.deepEqual(selectRetention(observation([master])).deferred, [{ id: 'master', reason: 'awaiting-idle' }]);
  master.inactiveSince = iso(now - 25 * hour);
  assert.equal(selectRetention(observation([master])).candidates[0].rootId, 'master');
});

test('a restored requested session needs a new end or a quiet day before it goes back', () => {
  const master = record('master', undefined, requested({ latestTaskEndedAt: iso(now - 2 * hour), restoredAt: iso(now - hour) }));
  assert.deepEqual(selectRetention(observation([master])).deferred, [{ id: 'master', reason: 'awaiting-idle' }]);
  master.latestTaskEndedAt = iso(now - 30 * 60_000);
  assert.equal(selectRetention(observation([master])).candidates.length, 1);
});

test('a subagent request is honoured on its own, even under a parent that stays', () => {
  const master = record('master'), child = record('child', 'master', requested()), grandchild = record('grandchild', 'child');
  const [candidate, ...others] = selectRetention(observation([master, child, grandchild])).candidates;
  assert.equal(others.length, 0); assert.equal(candidate.rootId, 'child'); assert.deepEqual(candidate.ids.sort(), ['child', 'grandchild']);
  // Requested on both sides, the family leaves as one operation rooted at the parent.
  Object.assign(master, requested());
  const candidates = selectRetention(observation([master, child, grandchild])).candidates;
  assert.equal(candidates.length, 1); assert.equal(candidates[0].rootId, 'master'); assert.equal(candidates[0].ids.length, 3);
});

test('a descendant reopened or restored on its own after the request holds the family back until requested again', () => {
  const master = record('master', undefined, requested({ archiveRequestedAt: iso(now - 3 * hour) }));
  const child = record('child', 'master', { reopenedAt: iso(now - 2 * hour) });
  assert.deepEqual(selectRetention(observation([master, child])).deferred, [{ id: 'master', reason: 'reopened-descendant' }]);
  child.reopenedAt = undefined; child.restoredAt = iso(now - 2 * hour);
  assert.deepEqual(selectRetention(observation([master, child])).deferred, [{ id: 'master', reason: 'reopened-descendant' }]);
  // Restored together with the parent is the same family coming back, not a separate reopen.
  master.restoredAt = child.restoredAt; master.latestTaskEndedAt = iso(now - hour);
  assert.equal(selectRetention(observation([master, child])).candidates.length, 1);
  // A reopen before the request, or a request on the descendant since its reopen, lets the family go.
  delete master.restoredAt; delete child.restoredAt; child.reopenedAt = iso(now - 4 * hour);
  assert.equal(selectRetention(observation([master, child])).candidates.length, 1);
  child.reopenedAt = iso(now - 2 * hour); Object.assign(child, requested({ archiveRequestedAt: iso(now - hour) }));
  assert.deepEqual(selectRetention(observation([master, child])).candidates[0].ids.sort(), ['child', 'master']);
});

test('a requested family over the cycle budget leaves in batches, deepest members first and the parent last', () => {
  const master = record('master', undefined, requested());
  const children = Array.from({ length: 120 }, (_, i) => record(`c${String(i).padStart(3, '0')}`, 'master'));
  const grandchildren = Array.from({ length: 30 }, (_, i) => record(`g${i}`, 'c000'));
  let hot = [master, ...children, ...grandchildren];
  const first = selectRetention(observation(hot)).candidates;
  assert.equal(first.length, 1); assert.equal(first[0].rootId, 'master'); assert.equal(first[0].ids.length, 100);
  assert.ok(grandchildren.every(record => first[0].ids.includes(record.session.id))); assert.ok(!first[0].ids.includes('master'));
  // One working member anywhere holds every batch back.
  children[119].session.status = 'working';
  assert.deepEqual(selectRetention(observation(hot)).deferred, [{ id: 'master', reason: 'protected' }]);
  children[119].session.status = 'completed';
  hot = hot.filter(record => !first[0].ids.includes(record.session.id));
  const second = selectRetention(observation(hot)).candidates;
  assert.equal(second[0].ids.length, 51); assert.ok(second[0].ids.includes('master'));
});

test('helpers a master launched are their own requests, and parent limits keep counting other parents', () => {
  const helper = record('helper', undefined, requested({ kind: 'helper' })); helper.session.launchedByAgent = true;
  const parents = Array.from({ length: 21 }, (_, i) => record(`p${i}`, undefined, { projectKey: 'project', lastActivityAt: iso(now - (i + 1) * day) }));
  const candidates = selectRetention(observation([helper, ...parents])).candidates;
  assert.deepEqual(candidates.map(candidate => [candidate.rootId, candidate.reason]).sort(), [['helper', 'explicit-archive'], ['p20', 'parent-limit']]);
});

async function fixture(run: (path: string) => Promise<void>): Promise<void> {
  const path = await mkdtemp(join(await realpath(tmpdir()), 'tower-retention-requests-'));
  try { await prepareActualStorage(path); await run(path); } finally { await closeActualStorage(path); await rm(path, { recursive: true, force: true }); }
}
/** Moves fixture originals into a cold folder and back, recording each step like the native adapter. */
function movingAdapter(native: string, originals: string, beforeMove?: () => Promise<void>): RetentionAdapter & { moved: string[] } {
  const moved: string[] = [];
  return { moved, capability: () => ({ status: 'supported' }), files: async () => [], inspectCold: async members => ({ complete: true, members, issues: [] }),
    reserve: async (candidate, records, ctx) => ({ revalidate: async () => { await beforeMove?.(); await ctx.fresh(); return true; }, preserveOwnership: async () => {}, release: async () => {},
      moveCold: async () => {
        const members: RetentionMember[] = [];
        for (const id of candidate.ids) {
          const hot = join(native, `${id}.jsonl`), cold = join(originals, `${id}.jsonl`); const info = await stat(hot);
          const parentId = records.find(record => record.session.id === id)?.session.parentId;
          const member: RetentionMember = { sessionId: id, provider: 'claude', nativeId: id, ...(parentId ? { parentId } : {}), originalPath: hot, coldPath: cold, operationId: ctx.operationId, state: 'intent', identity: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs } };
          await ctx.commitMember(member); await rename(hot, cold); moved.push(id);
          const confirmed = { ...member, state: 'cold' as const }; await ctx.commitMember(confirmed); members.push(confirmed);
        }
        return members;
      }, sources: async members => members.map(member => ({ path: member.coldPath!, originalPath: member.originalPath, root: native, nativeId: member.nativeId, provider: 'claude' as const, provenance: 'cold-original' as const })) }),
    restore: async (_manifest, _operation, members, ctx) => {
      const restored: RetentionMember[] = [];
      for (const member of members) { await rename(member.coldPath!, member.originalPath); const next = { ...member, state: 'restored' as const }; await ctx.commitMember(next); restored.push(next); }
      return restored;
    } };
}

test('a request survives a service restart, archives the master with its subagent after the turn, and reopening restores and cancels it', async () => fixture(async path => {
  const native = join(path, 'native'), originals = join(path, 'originals'), root = join(path, 'state'); await mkdir(native); await mkdir(originals);
  for (const id of ['master', 'child']) await writeFile(join(native, `${id}.jsonl`), `${id} transcript\n`);
  let working = true; let hot = true;
  const records = () => {
    const master = record('master'); master.session.master = true;
    if (working) { master.session.status = 'working'; master.latestTaskEndedAt = undefined; }
    return hot ? [master, record('child', 'master')] : [];
  };
  const make = (store: RetentionStore, adapter: RetentionAdapter) => new RetentionService({ store, archive: new RetentionArchive(join(path, 'bundles'), [native], [originals]), adapter, observe: async () => observation(records()), onError: () => {} });

  const first = new RetentionStore(root, { storage: actualStorage(root) }); await first.start(now - 30 * day);
  const firstService = make(first, movingAdapter(native, originals)); await firstService.start();
  try { assert.deepEqual(await firstService.requestArchive(['master', 'master']), { requested: 1 }); assert.equal(first.policy('master')?.archiveWhenIdle, true); }
  finally { await firstService.quiesce(); }

  const store = new RetentionStore(root, { storage: actualStorage(root) }); await store.start();
  assert.equal(store.policy('master')?.archiveWhenIdle, true); assert.equal(store.policy('master')?.archiveRevision, 1);
  const adapter = movingAdapter(native, originals); const service = make(store, adapter); await service.start();
  try {
    // The master is still in its turn: nothing moves.
    let summary = await service.cycle(); assert.equal(summary.archived, 0); assert.deepEqual(adapter.moved, []); assert.equal(summary.deferredReasons?.['awaiting-idle'], 1);
    working = false;
    summary = await service.cycle(); assert.equal(summary.archivedMembers, 2); assert.deepEqual(adapter.moved.sort(), ['child', 'master']);
    await assert.rejects(readFile(join(native, 'master.jsonl')), /ENOENT/);
    hot = false;
    // Reopening (setClosed false) restores the family, then cancels the request.
    await service.restoreSession('master'); await service.cancelArchiveRequest('master');
    assert.equal(await readFile(join(native, 'master.jsonl'), 'utf8'), 'master transcript\n');
    assert.equal(await readFile(join(native, 'child.jsonl'), 'utf8'), 'child transcript\n');
    assert.equal(store.policy('master')?.archiveWhenIdle, undefined); assert.ok(store.policy('master')?.restoredAt); assert.ok(store.policy('master')?.reopenedAt);
    hot = true;
    summary = await service.cycle(); assert.equal(summary.candidates, 0);
  } finally { await service.quiesce(); }
}));

test('a restore without reopening keeps the request; cancelling clears it durably', async () => fixture(async path => {
  const native = join(path, 'native'), originals = join(path, 'originals'), root = join(path, 'state'); await mkdir(native); await mkdir(originals);
  await writeFile(join(native, 'master.jsonl'), 'master transcript\n');
  let hot = true;
  const store = new RetentionStore(root, { storage: actualStorage(root) }); await store.start(now - 30 * day);
  const service = new RetentionService({ store, archive: new RetentionArchive(join(path, 'bundles'), [native], [originals]), adapter: movingAdapter(native, originals), observe: async () => observation(hot ? [record('master')] : []), onError: () => {} });
  await service.start();
  try {
    await service.requestArchive(['master']); await service.cycle(); hot = false;
    // A message to the archived session restores it; it goes back once it settles again.
    await service.restoreSession('master'); assert.equal(store.policy('master')?.archiveWhenIdle, true);
    await service.cancelArchiveRequest('master');
    const reopened = new RetentionStore(root, { storage: actualStorage(root) }); await reopened.start();
    assert.equal(reopened.policy('master')?.archiveWhenIdle, undefined);
  } finally { await service.quiesce(); }
}));

test('a family of 151 sessions leaves over two cycles, the parent with the last batch', async () => fixture(async path => {
  const native = join(path, 'native'), originals = join(path, 'originals'), root = join(path, 'state'); await mkdir(native); await mkdir(originals);
  const ids = ['master', ...Array.from({ length: 150 }, (_, i) => `c${i}`)];
  for (const id of ids) await writeFile(join(native, `${id}.jsonl`), `${id}\n`);
  const adapter = movingAdapter(native, originals);
  const store = new RetentionStore(root, { storage: actualStorage(root) }); await store.start(now - 30 * day);
  const service = new RetentionService({ store, archive: new RetentionArchive(join(path, 'bundles'), [native], [originals]), adapter, onError: () => {},
    observe: async () => observation(ids.filter(id => !adapter.moved.includes(id)).map(id => id === 'master' ? record('master') : record(id, 'master'))) });
  await service.start();
  try {
    await service.requestArchive(['master']);
    let summary = await service.cycle(); assert.equal(adapter.moved.length, 100); assert.ok(!adapter.moved.includes('master')); assert.equal(summary.archivedMembers, 100); assert.equal(summary.deferredReasons?.['session-budget'], 1);
    summary = await service.cycle(); assert.equal(adapter.moved.length, 151); assert.ok(adapter.moved.includes('master')); assert.equal(summary.archivedMembers, 151);
  } finally { await service.quiesce(); }
}));

test('a descendant reopened while its family is being reserved stops the move before any original leaves', async () => fixture(async path => {
  const native = join(path, 'native'), originals = join(path, 'originals'), root = join(path, 'state'); await mkdir(native); await mkdir(originals);
  for (const id of ['master', 'child']) await writeFile(join(native, `${id}.jsonl`), `${id}\n`);
  const store = new RetentionStore(root, { storage: actualStorage(root) }); await store.start(now - 30 * day);
  // The reopen lands between selection and the move (written directly: the cycle holds the service queue).
  const adapter = movingAdapter(native, originals, async () => { await store.setPolicy({ id: 'child', archiveRevision: 1, reopenedAt: new Date().toISOString() }); });
  const service = new RetentionService({ store, archive: new RetentionArchive(join(path, 'bundles'), [native], [originals]), adapter, onError: () => {},
    observe: async () => observation([record('master'), record('child', 'master')]) });
  await service.start();
  try {
    await service.requestArchive(['master']);
    const summary = await service.cycle();
    assert.deepEqual(adapter.moved, []); assert.equal(summary.archived, 0); assert.equal(store.list()[0].phase, 'conflict');
    assert.equal(await readFile(join(native, 'child.jsonl'), 'utf8'), 'child\n');
    assert.equal(store.policy('master')?.archiveWhenIdle, true);
    assert.equal((await service.cycle()).deferredReasons?.['reopened-descendant'], 1);
  } finally { await service.quiesce(); }
}));
