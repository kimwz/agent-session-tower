import { actualStorage, prepareActualStorage, closeActualStorage } from './retention-actual-storage.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, stat, realpath, readFile } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../../../shared/types.js';
import type { RetentionRecord, RetentionObservation } from '../../../server/sessions/retention/policy.js';
import { RetentionArchive } from '../../../server/sessions/retention/archive.js';
import { RetentionStore } from '../../../server/sessions/retention/store.js';
import { RetentionService } from '../../../server/sessions/retention/service.js';
import { RetentionCycleLog } from '../../../server/sessions/retention/cycle-log.js';
import type { RetentionAdapter, RetentionMember } from '../../../server/sessions/retention/types.js';

// When retention cycles come, what a pending request shows to pages, and what each cycle leaves for tracing.
const now = Date.UTC(2026, 9, 17); const day = 86_400_000; const hour = 3_600_000;
const iso = (time: number) => new Date(time).toISOString();
function record(id: string): RetentionRecord {
  const session: Session = { id, nativeId: id, provider: 'claude', title: id, cwd: '/work/project', project: 'project', status: 'completed', statusReason: '', createdAt: iso(now - 2 * day), updatedAt: iso(now - hour), lastMessage: '', messageCount: 1, isSubagent: false, resumable: true };
  return { session, kind: 'parent', latestTaskEndedAt: iso(now - hour), lastActivityAt: iso(now - hour) };
}
const observation = (records: RetentionRecord[]): RetentionObservation => ({ now, migratedAt: now - 30 * day, complete: true, records, protectedIds: new Set() });
const blocked: RetentionAdapter = { capability: () => ({ status: 'blocked', reason: 'fixture' }), files: async () => [], reserve: async () => undefined, inspectCold: async members => ({ complete: true, members, issues: [] }) };

async function fixture(run: (path: string, root: string, store: RetentionStore) => Promise<void>): Promise<void> {
  const path = await mkdtemp(join(await realpath(tmpdir()), 'tower-retention-scheduling-'));
  try {
    await prepareActualStorage(path);
    const root = join(path, 'state'); const store = new RetentionStore(root, { storage: actualStorage(root) }); await store.start(now - 30 * day);
    await run(path, root, store);
  } finally { await closeActualStorage(path); await rm(path, { recursive: true, force: true }); }
}
const settled = () => new Promise(resolve => setImmediate(resolve));

test('a request that comes while maintenance is paused brings a cycle within seconds of resuming, not an hour later', async () => fixture(async (path, _root, store) => {
  const service = new RetentionService({ store, archive: new RetentionArchive(join(path, 'bundles'), []), adapter: blocked, onError: () => {}, observe: async () => observation([record('a')]) });
  await service.start();
  try {
    assert.equal(service.nextCycleIn(), hour, 'nothing waits: the hourly cycle');
    await service.quiesce(); // a worker handoff begins
    await service.requestArchive(['a']);
    assert.equal(service.nextCycleIn(), undefined, 'no timer while paused');
    service.resume(); // the handoff did not happen
    assert.ok(service.nextCycleIn()! <= 5_000);
  } finally { await service.quiesce(); }
}));

test('a service that starts with requests waiting (a restart, a new worker) runs a cycle within seconds', async () => fixture(async (path, root, store) => {
  const first = new RetentionService({ store, archive: new RetentionArchive(join(path, 'bundles'), []), adapter: blocked, onError: () => {}, observe: async () => observation([record('a')]) });
  await first.start(); await first.requestArchive(['a']); await first.quiesce();
  const again = new RetentionStore(root, { storage: actualStorage(root) });
  const service = new RetentionService({ store: again, archive: new RetentionArchive(join(path, 'bundles'), []), adapter: blocked, onError: () => {}, observe: async () => observation([record('a')]) });
  await service.start();
  try { assert.equal(service.nextCycleIn(), 5_000); } finally { await service.quiesce(); }
}));

test('a pause with nothing requested keeps the cycle that was due instead of starting the hour over', async () => fixture(async (path, _root, store) => {
  const service = new RetentionService({ store, archive: new RetentionArchive(join(path, 'bundles'), []), adapter: blocked, onError: () => {}, observe: async () => observation([]) });
  await service.start();
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    await service.quiesce(); service.resume();
    assert.ok(service.nextCycleIn()! < hour, 'the remaining time, not a new hour');
    assert.ok(service.nextCycleIn()! > hour - 60_000);
  } finally { await service.quiesce(); }
}));

test('pages see a request or its withdrawal at once, even while a cycle holds the queue; the store follows', async () => fixture(async (path, root, store) => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let hold = false;
  const service = new RetentionService({ store, archive: new RetentionArchive(join(path, 'bundles'), []), adapter: blocked, onError: () => {},
    observe: async () => { if (hold) await gate; return observation([record('a'), record('b')]); } });
  await service.start();
  try {
    await service.cycle();
    hold = true;
    const running = service.cycle();
    const requested = service.requestArchive(['a', 'b']);
    assert.deepEqual(service.requestedIds().sort(), ['a', 'b'], 'before the cycle lets the request through');
    const withdrawn = service.withdrawArchiveRequests(['b']);
    assert.deepEqual(service.requestedIds(), ['a']);
    assert.equal(store.policy('a'), undefined, 'not written yet');
    release(); await running;
    assert.deepEqual(await requested, { requested: 2 }); assert.deepEqual(await withdrawn, { withdrawn: 1 });
    assert.deepEqual(service.requestedIds(), ['a']);
    const reopened = new RetentionStore(root, { storage: actualStorage(root) }); await reopened.start();
    assert.equal(reopened.policy('a')?.archiveWhenIdle, true); assert.equal(reopened.policy('b')?.archiveWhenIdle, undefined);
    // Withdrawing touches only a session's own request: nothing is written for one without.
    assert.deepEqual(await service.withdrawArchiveRequests(['c']), { withdrawn: 0 });
    assert.equal(store.policy('c'), undefined);
  } finally { await service.quiesce(); }
}));

/** Moves fixture originals into a cold folder, as the native adapter does. */
function movingAdapter(native: string, originals: string): RetentionAdapter {
  return { capability: () => ({ status: 'supported' }), files: async () => [], inspectCold: async members => ({ complete: true, members, issues: [] }),
    reserve: async (candidate, _records, ctx) => ({ revalidate: async () => { await ctx.fresh(); return true; }, preserveOwnership: async () => {}, release: async () => {},
      moveCold: async () => {
        const members: RetentionMember[] = [];
        for (const id of candidate.ids) {
          const hot = join(native, `${id}.jsonl`), cold = join(originals, `${id}.jsonl`); const info = await stat(hot);
          const member: RetentionMember = { sessionId: id, provider: 'claude', nativeId: id, originalPath: hot, coldPath: cold, operationId: ctx.operationId, state: 'intent', identity: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs } };
          await ctx.commitMember(member); await rename(hot, cold);
          const confirmed = { ...member, state: 'cold' as const }; await ctx.commitMember(confirmed); members.push(confirmed);
        }
        return members;
      }, sources: async members => members.map(member => ({ path: member.coldPath!, originalPath: member.originalPath, root: native, nativeId: member.nativeId, provider: 'claude' as const, provenance: 'cold-original' as const })) }) };
}

test('each cycle is recorded: when, automatic or the owner\'s check and why, and what left for cold storage; the record outlives a restart and stays bounded', async () => fixture(async (path, root, store) => {
  const native = join(path, 'native'), originals = join(path, 'originals'); await mkdir(native); await mkdir(originals);
  await writeFile(join(native, 'a.jsonl'), 'a\n');
  let hot = [record('a'), record('b')];
  const log = new RetentionCycleLog(join(root, 'retention'));
  const service = new RetentionService({ store, archive: new RetentionArchive(join(path, 'bundles'), [native], [originals]), adapter: movingAdapter(native, originals), onError: () => {}, log,
    observe: async () => observation(hot) });
  await service.start();
  try {
    await service.cycle('check');
    await service.requestArchive(['a']);
    const summary = await service.cycle('scheduled'); hot = [record('b')];
    assert.equal(summary.archivedMembers, 1);
    await settled();
    const [checked, scheduled] = summary.recentCycles!;
    assert.equal(checked.trigger, 'check'); assert.equal(checked.reason, undefined); assert.deepEqual(checked.archived, []);
    assert.equal(scheduled.trigger, 'scheduled'); assert.equal(scheduled.reason, 'request');
    assert.deepEqual(scheduled.archived, ['a']); assert.equal(scheduled.conflicts, 0); assert.equal(scheduled.observationComplete, true);
    assert.ok(Date.parse(scheduled.endedAt) >= Date.parse(scheduled.startedAt)); assert.equal(typeof scheduled.ms, 'number');
    // Read back by the next worker.
    const saved = new RetentionCycleLog(join(root, 'retention')); await saved.start();
    assert.deepEqual(saved.recent(20), summary.recentCycles);
    assert.equal(JSON.parse(await readFile(join(root, 'retention', 'cycles.json'), 'utf8')).length, 2);
    for (let i = 0; i < 205; i++) await saved.record({ ...scheduled, archived: [`s${i}`] });
    const bounded = JSON.parse(await readFile(join(root, 'retention', 'cycles.json'), 'utf8'));
    assert.equal(bounded.length, 200); assert.deepEqual(bounded.at(-1).archived, ['s204']);
  } finally { await service.quiesce(); }
}));

test('a cycle that cannot observe sessions says so in its record', async () => fixture(async (path, root, store) => {
  const log = new RetentionCycleLog(join(root, 'retention'));
  const service = new RetentionService({ store, archive: new RetentionArchive(join(path, 'bundles'), []), adapter: blocked, onError: () => {}, log,
    observe: async () => { throw new Error('native scan failed'); } });
  await service.start();
  try {
    await assert.rejects(service.cycle('check'), /native scan failed/);
    const [entry] = log.recent(1);
    assert.equal(entry.trigger, 'check'); assert.match(entry.error!, /native scan failed/); assert.equal(entry.candidates, 0);
  } finally { await service.quiesce(); }
}));
