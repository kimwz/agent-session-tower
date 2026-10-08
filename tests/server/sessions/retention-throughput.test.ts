import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import type { TestContext } from 'node:test';
import { RetentionArchive } from '../../../server/sessions/retention/archive.js';
import { RetentionStore } from '../../../server/sessions/retention/store.js';
import { RetentionService } from '../../../server/sessions/retention/service.js';
import type { RetentionMember } from '../../../server/sessions/retention/types.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../../../shared/types.js';
import { RetentionObserver, type NativeRetentionObservation } from '../../../server/sessions/retention/observer.js';

const now = Date.UTC(2026, 9, 8), day = 86_400_000;
function session(id: string, child = false): Session {
  return { id: `codex:${id}`, nativeId: id, provider: 'codex', cwd: '/fixture/a', project: 'fixture', title: id,
    createdAt: new Date(now - 20 * day).toISOString(), updatedAt: new Date(now - 8 * day).toISOString(),
    status: 'completed', statusReason: 'fixture', lastMessage: 'done', messageCount: 1, resumable: true,
    isSubagent: child, ...(child ? { parentId: 'codex:p0' } : {}) };
}

test('two thousand child workspaces do not amplify fresh parent project discovery', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-retention-throughput-')));
  try {
    const parents = Array.from({ length: 20 }, (_, i) => ({ ...session(`p${i}`), cwd: `/fixture/${i % 2 ? 'b' : 'a'}` }));
    const children = Array.from({ length: 2000 }, (_, i) => ({ ...session(`c${i}`, true), cwd: `/fixture/one-shot-${i}` }));
    const helper = { ...session('helper'), launchedByAgent: true, cwd: '/fixture/helper' };
    const guardian = { ...session('guardian'), cwd: '/fixture/guardian' };
    const snapshot: NativeRetentionObservation = { complete: true, records: [...parents, ...children, helper, guardian].map(s => ({ session: s,
      internal: s.id === guardian.id, fingerprint: 'stable', latestTaskEndedAt: new Date(now - 8 * day).toISOString() })) };
    let calls: string[] = [], generation = 'old';
    const observer = new RetentionObserver({ stateDir: root, now: () => now, snapshot: () => snapshot, reconcile: s => s,
      runs: () => [], settled: () => new Set(), protectedIds: () => [], projectIdentity: async cwd => { calls.push(cwd); return `${generation}:${cwd}`; } });
    await observer.start();
    const first = await observer.observe();
    assert.deepEqual(calls.sort(), ['/fixture/a', '/fixture/b'], 'only parent count policy needs logical project proof');
    assert.ok(first.records.filter(r => r.kind !== 'parent').every(r => r.projectKey === undefined), 'child project absence is stable even when sharing a parent cwd');
    assert.equal(first.records.filter(r => r.kind === 'parent').length, 20);
    generation = 'new'; calls = [];
    const second = await observer.observe();
    assert.deepEqual(calls.sort(), ['/fixture/a', '/fixture/b']);
    assert.ok(second.records.filter(r => r.kind === 'parent').every(r => r.projectKey?.startsWith('new:')), 'fresh parent proof is never reused across observations');
    assert.equal(second.records.length, first.records.length);
    assert.equal(second.records.find(r => r.session.id === children[0]!.id)?.latestTaskEndedAt, new Date(now - 8 * day).toISOString());
  } finally { await rm(root, { recursive: true, force: true }); }
});


async function maintenanceFixture(t: TestContext, count: number, hook?: (id: string) => Promise<boolean>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-retention-throughput-')));
  const native = join(root, 'native'); await mkdir(native);
  const file = join(native, 'fixture.jsonl'); await writeFile(file, 'fixture\n'); const info = await stat(file);
  const store = new RetentionStore(join(root, 'state')); await store.start(now - 10 * day);
  const records = [session('p0'), ...Array.from({ length: count }, (_, i) => session(`c${i}`, true))].map(s => ({session: s, kind: s.isSubagent ? 'subagent' as const : 'parent' as const, latestTaskEndedAt: new Date(now - 8 * day).toISOString()}));
  const attempts: string[] = [];
  const service = new RetentionService({store, archive: new RetentionArchive(join(root, 'cold'), [native]),
    observe: async () => { const cold = new Set(store.list().flatMap(e => e.members || []).filter(m => m.state === 'cold').map(m => m.sessionId));
      return {now: Date.now(), migratedAt: now - 10 * day, complete: true, records: records.filter(r => !cold.has(r.session.id)), protectedIds: new Set()}; },
    adapter: {capability: () => ({status: 'supported'}), files: async () => [], inspectCold: async members => ({complete: true, members, issues: []}),
      reserve: async (candidate, selected, context) => {
        attempts.push(candidate.rootId);
        if (hook && !await hook(candidate.rootId)) return undefined;
        const members: RetentionMember[] = selected.map(({session: s}) => ({sessionId: s.id, nativeId: s.nativeId, provider: s.provider, parentId: s.parentId,
          isSubagent: s.isSubagent, createdAt: s.createdAt, operationId: context.operationId, state: 'cold', originalPath: file, coldPath: file,
          identity: {dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs}}));
        return {revalidate: async () => { await context.fresh(); return true; }, preserveOwnership: async () => {},
          moveCold: async () => { await context.fresh(); for(const m of members) await context.commitMember(m); return members; },
          sources: async () => selected.map(({session: s}) => ({path: file, root: native, nativeId: s.nativeId, provider: s.provider})), release: async () => {}};
      }} });
  t.after(async () => {await service.quiesce(); await rm(root, {recursive: true, force: true});});
  await service.start(); return {service, attempts, records};
}

test('budgeted progress continues after one second and shares an in-flight manual check', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date'], now});
  const {service, attempts} = await maintenanceFixture(t, 101);
  const first = service.cycle(); assert.equal(service.cycle(), first);
  assert.equal((await first).archivedMembers, 100);
  assert.equal(service.overview().deferredReasons?.['session-budget'], 1);
  t.mock.timers.tick(999); await new Promise(setImmediate); assert.equal(attempts.length, 100);
  t.mock.timers.tick(1); await new Promise(setImmediate);
  assert.equal(attempts.length, 101, 'automatic continuation starts without another manual request');
  const second = service.cycle(); assert.equal(service.cycle(), second);
  assert.equal((await second).archivedMembers, 101, 'timer and manual call share the same next chunk');
  assert.equal(attempts.length, 101);
  t.mock.timers.tick(1000); await new Promise(setImmediate); assert.equal(attempts.length, 101);
});

test('no progress keeps the hourly delay rather than retrying failed candidates in a tight loop', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date'], now});
  const {service, attempts} = await maintenanceFixture(t, 1, async () => false);
  await service.cycle(); assert.equal(attempts.length, 1);
  t.mock.timers.tick(1000); await new Promise(setImmediate); assert.equal(attempts.length, 1);
  t.mock.timers.tick(3_599_000); await service.cycle(); assert.equal(attempts.length, 2);
});

test('time-budget cursor reaches later candidates after a slow failure at the front', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date'], now});
  const {service, attempts, records} = await maintenanceFixture(t, 3, async id => {t.mock.timers.tick(30_000); return id !== 'codex:c0';});
  records.push({session: {...session('p0'), id: 'claude:p0', provider: 'claude'}, kind: 'parent', latestTaskEndedAt: new Date(now - 8 * day).toISOString()});
  const later = records.find(r => r.session.nativeId === 'c1')!;
  later.session.id = 'claude:c1'; later.session.provider = 'claude'; later.session.parentId = 'claude:p0';
  await service.cycle(); assert.deepEqual(attempts, ['codex:c0']);
  await service.cycle(); assert.deepEqual(attempts, ['codex:c0', 'claude:c1']);
  assert.equal(service.overview().archivedMembers, 1);
  t.mock.timers.tick(1000); await service.cycle();
  assert.deepEqual(attempts, ['codex:c0', 'claude:c1', 'codex:c2']);
});

test('quiesce clears a scheduled catch-up and drains an in-flight original operation', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date'], now});
  let entered!: () => void, finish!: () => void;
  const began = new Promise<void>(r => {entered = r;}), barrier = new Promise<void>(r => {finish = r;});
  const {service, attempts} = await maintenanceFixture(t, 2, async () => {entered(); await barrier; t.mock.timers.tick(30_000); return true;});
  const cycle = service.cycle(); await began;
  let drained = false; const quiescing = service.quiesce().then(() => {drained = true;});
  await new Promise(setImmediate); assert.equal(drained, false);
  finish(); await cycle; await quiescing; assert.equal(drained, true);
  t.mock.timers.tick(3_600_000); await new Promise(setImmediate);
  assert.equal(attempts.length, 1, 'completed stopped work must not schedule another chunk');
});

test('stopping after a successful chunk removes its pending catch-up timer', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date'], now});
  const {service, attempts} = await maintenanceFixture(t, 101);
  await service.cycle(); assert.equal(attempts.length, 100);
  await service.quiesce(); t.mock.timers.tick(3_600_000); await new Promise(setImmediate);
  assert.equal(attempts.length, 100);
});
