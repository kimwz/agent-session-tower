import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import type { Session, Run } from '../../../shared/types.js';
import { permissionRetentionPending, RetentionObserver, gitProjectIdentity, type NativeRetentionObservation } from '../../../server/sessions/retention/observer.js';

function session(id: string, parentId?: string): Session {
  return { id: `claude:${id}`, nativeId: id, provider: 'claude', title: 'fixture', cwd: '/fixture', project: 'fixture',
    status: 'completed', statusReason: 'fixture', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    lastMessage: 'done', messageCount: 1, isSubagent: Boolean(parentId), resumable: !parentId, parentId };
}
async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), 'tower-retention-observer-'));
  try { await run(await realpath(temporary)); } finally { await rm(temporary, { force: true, recursive: true }); }
}

test('unknown termination needs uninterrupted fingerprint observations; restart and incomplete scans reset it', async () => fixture(async stateDir => {
  let now = Date.parse('2026-10-01T00:00:00Z');
  const snapshot: NativeRetentionObservation = { complete: true, records: [{ session: session('child', 'claude:parent'), internal: false, fingerprint: 'v1' }] };
  const make = () => new RetentionObserver({ stateDir, now: () => now, snapshot: () => snapshot, reconcile: value => value,
    runs: () => [], settled: () => new Set(), protectedIds: () => [], projectIdentity: async () => undefined });
  const observer = make(); await observer.start();
  const first = (await observer.observe()).records[0]!.inactiveSince;
  now += 3_600_000;
  assert.equal((await observer.observe()).records[0]!.inactiveSince, first);
  snapshot.records[0]!.fingerprint = 'v2';
  assert.equal((await observer.observe()).records[0]!.inactiveSince, new Date(now).toISOString());
  now += 3_600_000; snapshot.complete = false; snapshot.issues = ['native-history-incomplete:claude'];
  const incomplete = await observer.observe(); assert.equal(incomplete.complete, false); assert.equal(incomplete.records[0]!.inactiveSince, undefined);
  assert.deepEqual(incomplete.issues, ['native-history-incomplete:claude']);
  snapshot.complete = true; now += 3_600_000;
  const afterGap = (await observer.observe()).records[0]!.inactiveSince;
  now += 3_600_000;
  const successor = make(); await successor.start();
  assert.notEqual((await successor.observe()).records[0]!.inactiveSince, afterGap);
}));

test('native aliases protect waiting runs and all Claude descendants, including terminal children, inherit a busy parent', async () => fixture(async stateDir => {
  const parent = session('parent'); parent.activeProcess = true;
  const child = session('child', 'claude:parent');
  const grandchild = session('grandchild', 'claude:child');
  const completed = session('completed', 'claude:parent');
  const waiting = session('waiting', 'claude:parent');
  const snapshot: NativeRetentionObservation = { complete: true, records: [
    { session: grandchild, internal: false, fingerprint: 'v1' },
    { session: child, internal: false, fingerprint: 'v1' },
    { session: parent, internal: false, fingerprint: 'v1' },
    { session: completed, internal: false, fingerprint: 'v1', latestTaskEndedAt: '2026-01-01T00:00:00Z' },
    { session: waiting, internal: false, fingerprint: 'v1', latestTaskEndedAt: '2026-01-01T00:00:00Z' },
  ] };
  const observer = new RetentionObserver({ stateDir, snapshot: () => snapshot,
    reconcile: value => value.map(item => ({ ...item, id: `claude:monitor-${item.nativeId}` })),
    runs: () => [{ id: 'queued-run', sessionId: 'claude:waiting', status: 'queued' } as Run],
    settled: () => new Set(), protectedIds: () => [], projectIdentity: async () => 'git-common' });
  await observer.start(); const observation = await observer.observe();
  assert.ok(observation.protectedIds.has('claude:monitor-grandchild'));
  assert.ok(observation.protectedIds.has('claude:monitor-child'));
  assert.ok(observation.protectedIds.has('claude:monitor-waiting'));
  assert.ok(observation.protectedIds.has('claude:monitor-completed'));
  assert.equal(observation.records.find(record => record.session.nativeId === 'completed')!.session.parentId, 'claude:monitor-parent');
  assert.equal(observation.records.find(record => record.session.nativeId === 'completed')!.latestTaskEndedAt, '2026-01-01T00:00:00Z');
}));

test('logical projects use proven git common directory, while deleted worktrees stay unclassified', async () => fixture(async root => {
  const exec = promisify(execFile);
  const repository = join(root, 'repository'), worktree = join(root, 'worktree');
  await exec('git', ['init', repository]);
  await exec('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
  await exec('git', ['-C', repository, 'worktree', 'add', '--detach', worktree]);
  assert.equal(await gitProjectIdentity(repository), await gitProjectIdentity(worktree));
  await exec('git', ['-C', repository, 'worktree', 'remove', worktree]);
  assert.equal(await gitProjectIdentity(worktree), undefined);
}));

test('invalid retained observations fail closed and preserve the corrupt file for inspection', async () => fixture(async stateDir => {
  const path = join(stateDir, 'retention-observations.json');
  await writeFile(path, '{broken fixture');
  const observer = new RetentionObserver({ stateDir, snapshot: () => ({ complete: true, records: [] }),
    reconcile: value => value, runs: () => [], settled: () => new Set(), protectedIds: () => [] });
  await assert.rejects(observer.start());
  assert.equal(await readFile(path, 'utf8'), '{broken fixture');
}));

test('a normal asynchronous scan finishes before inactivity, clock and pending-run state are observed', async () => fixture(async stateDir => {
  let now = Date.parse('2026-10-01T00:00:00Z');
  const snapshot: NativeRetentionObservation = { complete: true, records: [{ session: session('child', 'claude:parent'), internal: false, fingerprint: 'stable' }] };
  let scan: Promise<void> = Promise.resolve();
  let resumeScan!: () => void;
  let requested!: () => void;
  let pendingRuns: Run[] = [];
  const observer = new RetentionObserver({ stateDir, now: () => now,
    snapshot: async () => { requested?.(); await scan; return snapshot; }, reconcile: value => value,
    runs: () => pendingRuns, settled: () => new Set(), protectedIds: () => [], projectIdentity: async () => undefined });
  await observer.start();
  const original = (await observer.observe()).records[0]!.inactiveSince;
  now += 3_600_000;
  scan = new Promise<void>(resolve => { resumeScan = resolve; });
  const entered = new Promise<void>(resolve => { requested = resolve; });
  let finished = false;
  const next = observer.observe().then(value => { finished = true; return value; });
  await entered;
  await Promise.resolve(); assert.equal(finished, false, 'a scan in progress is awaited rather than persisted as incomplete');
  now += 60_000; resumeScan();
  const completed = await next;
  assert.equal(completed.complete, true);
  assert.equal(completed.now, now, 'clock is taken after the completed scan');
  assert.equal(completed.records[0]!.inactiveSince, original, 'unchanged records retain their continuous inactivity');
  scan = new Promise<void>(resolve => { resumeScan = resolve; });
  const enteringAgain = new Promise<void>(resolve => { requested = resolve; });
  const queuedDuringScan = observer.observe(); await enteringAgain;
  pendingRuns = [{ id: 'new-run', sessionId: 'claude:child', status: 'queued' } as Run];
  resumeScan();
  const protectedObservation = await queuedDuringScan;
  assert.ok(protectedObservation.protectedIds.has('claude:child'), 'run protection is also taken after scan completion');
  assert.equal(protectedObservation.records[0]!.inactiveSince, undefined);
}));

test('a rejected scan breaks continuous inactive observation instead of extending an old clock', async () => fixture(async stateDir => {
  let now = Date.parse('2026-10-01T00:00:00Z');
  let fail = false;
  const snapshot: NativeRetentionObservation = { complete: true, records: [{ session: session('child', 'claude:parent'), internal: false, fingerprint: 'stable' }] };
  const observer = new RetentionObserver({ stateDir, now: () => now, snapshot: async () => { if (fail) throw new Error('fixture scan failure'); return snapshot; },
    reconcile: value => value, runs: () => [], settled: () => new Set(), protectedIds: () => [], projectIdentity: async () => undefined });
  await observer.start(); const original = (await observer.observe()).records[0]!.inactiveSince;
  now += 3_600_000; fail = true;
  const messages: unknown[][] = []; const previous = console.error;
  console.error = (...args) => { messages.push(args); };
  try { await assert.rejects(observer.observe(), /fixture scan failure/); } finally { console.error = previous; }
  assert.ok(messages.some(args => String(args[0]).includes('fixture scan failure')));
  fail = false; now += 60_000;
  const recovered = await observer.observe();
  assert.notEqual(recovered.records[0]!.inactiveSince, original);
  assert.equal(recovered.records[0]!.inactiveSince, new Date(now).toISOString());
}));


test('finished permission command results stay protected until actually delivered', () => {
  for(const status of ['done','failed']) {
    assert.equal(permissionRetentionPending({status:'approved',run:{status}}),true);
    assert.equal(permissionRetentionPending({status:'approved',run:{status,delivered:true}}),false);
  }
  assert.equal(permissionRetentionPending({status:'approved',run:{status:'running',delivered:true}}),true);
  assert.equal(permissionRetentionPending({status:'pending'}),true);
  assert.equal(permissionRetentionPending({status:'approved',notification:{state:'pending'}}),true);
  assert.equal(permissionRetentionPending({status:'denied'}),false);
});
