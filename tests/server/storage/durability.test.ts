import assert from 'node:assert/strict';
import { lstat, readdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { RecoveryBarrier } from '../../../server/storage/recovery.js';
import { historyAfterSnapshot, historyWithSidecars, recordedWithSidecars, sha, type History } from './fixtures/history.js';
import { DATABASE, databasePath, filesUnder, openFixture, rejectsWith, stateDir, storage } from './helpers.js';

const { activateRecoveryBarrier, adoptSnapshot, readRecoveryBarrier, reconcileRecovery, recordRecoveryBarrier, recordStorageIdentity, recoveryHold, storageFs, storageLayout } = storage;

/**
 * Storage durability is checked two ways, kept apart:
 *  - An ordering model, not a power failure: it records every create, move and sync the storage makes through
 *    storageFs, and treats a folder's entries as surviving a power cut only as they were at that folder's last sync
 *    (a folder never synced since it was made keeps nothing). At every point between two operations it asks whether
 *    each file that must survive is still reachable from the state directory. One model runs from before the first
 *    step through every failed attempt and every retry: a retry is judged by what the earlier attempts left durable,
 *    never by what is merely there. Nothing here cuts power or proves what a given file system does; it proves the
 *    order of links and syncs the code relies on.
 *  - Real private files: a step fails (an injected error) and the process carries on, then the same operation runs
 *    again on the files as they were left.
 */

type Op = 'mkdir' | 'rename' | 'createFile' | 'copyFile' | 'syncFile' | 'syncDirectory';
const OPS: Op[] = ['mkdir', 'rename', 'createFile', 'copyFile', 'syncFile', 'syncDirectory'];
interface Entry { ino: number; dir: boolean }
type Listing = ReadonlyMap<string, Entry>;
type Cut = Map<string, Listing>;

async function listing(dir: string): Promise<Listing> {
  const entries = new Map<string, Entry>();
  for (const entry of await readdir(dir, { withFileTypes: true })) entries.set(entry.name, { ino: (await lstat(join(dir, entry.name))).ino, dir: entry.isDirectory() });
  return entries;
}

/** The durable view of folder entries, step by step. `cuts[k]` is the view after the k-th operation (`log[k - 1]`). */
class OrderModel {
  readonly log: [Op, string][] = [];
  readonly cuts: Cut[] = [];
  /** Where a publication (a return the caller relies on) happened: the cut it was made at. */
  readonly marks = new Map<string, number>();
  readonly #durable = new Map<string, Listing>();
  constructor(readonly root: string) {}
  /** Everything that exists now counts as durable: the state before the operations under test. */
  async start(): Promise<void> {
    const walk = async (dir: string): Promise<void> => {
      const entries = await listing(dir);
      this.#durable.set(dir, entries);
      for (const [name, entry] of entries) if (entry.dir) await walk(join(dir, name));
    };
    await walk(this.root);
    this.cuts.push(new Map(this.#durable));
  }
  async after(op: Op, path: string): Promise<void> {
    this.log.push([op, path]);
    if (op === 'syncDirectory') this.#durable.set(path, await listing(path));
    this.cuts.push(new Map(this.#durable));
  }
  mark(label: string): void { this.marks.set(label, this.cuts.length - 1); }
  /** The inodes of regular files reachable from the root in one cut. */
  static reachable(cut: Cut, root: string): Set<number> {
    const found = new Set<number>();
    const queue = [root];
    while (queue.length) {
      const dir = queue.shift()!;
      for (const [name, entry] of cut.get(dir) ?? new Map<string, Entry>()) {
        if (entry.dir) queue.push(join(dir, name)); else found.add(entry.ino);
      }
    }
    return found;
  }
  /** The inode a path (relative to the root) names in one cut, following only durable entries. */
  static inodeAt(cut: Cut, root: string, path: string): number | undefined {
    let dir = root;
    const parts = path.split('/');
    for (const [index, part] of parts.entries()) {
      const entry = cut.get(dir)?.get(part);
      if (!entry) return undefined;
      if (index === parts.length - 1) return entry.ino;
      dir = join(dir, part);
    }
    return undefined;
  }
  /** The first cut, from `from` on, where one of `inodes` is unreachable, or -1. */
  lost(inodes: number[], from = 0): number {
    return this.cuts.findIndex((cut, index) => index >= from && inodes.some(ino => !OrderModel.reachable(cut, this.root).has(ino)));
  }
  describe(index: number): string { return `cut ${index} (after ${JSON.stringify(this.log[index - 1])})`; }
}

/**
 * Records every storageFs operation in `model`, and lets `fail` throw instead of (or after) one. Installed once per
 * test: a retry changes what `fail` answers, never the instrument, so the same model sees every attempt.
 */
function instrument(t: TestContext, model: OrderModel | undefined, fail?: (index: number, op: Op, path: string) => 'before' | 'after' | undefined) {
  let index = 0;
  for (const op of OPS) {
    const original = storageFs[op] as (...args: string[]) => Promise<void>;
    t.mock.method(storageFs, op, async (...args: string[]) => {
      const at = ++index;
      const path = op === 'rename' || op === 'copyFile' ? args[1] : args[0];
      if (fail?.(at, op, path) === 'before') throw Object.assign(new Error(`injected failure before ${op} #${at}`), { code: 'EIO' });
      await original(...args);
      await model?.after(op, path);
      if (fail?.(at, op, path) === 'after') throw Object.assign(new Error(`injected failure after ${op} #${at}`), { code: 'EIO' });
    });
  }
  return () => index;
}
const isSync = (op: Op) => op === 'syncDirectory' || op === 'syncFile';

/** The live database files of a history, by inode: what an adoption must never lose. */
async function originals(dir: string): Promise<number[]> {
  const inodes: number[] = [];
  for (const suffix of ['', '-wal', '-shm'] as const) inodes.push((await lstat(databasePath(dir, suffix))).ino);
  return inodes;
}
const adopt = (history: History) => recordRecoveryBarrier(history.dir, { snapshotId: history.snapshotId, reason: 'sidecars', context: history.context, known: history.known })
  .then(barrier => activateRecoveryBarrier(history.dir, barrier.id));
/** Whether a path is a move of an original out of the state directory into a preserved folder. */
const preservedMove = (dir: string, [op, path]: [Op, string]) => op === 'rename' && relative(dir, path).split('/').length === 4 && path.includes('/source/');

/**
 * What every adoption under `model` must show, failed attempts and retries included: every original reachable at every
 * cut; no original moved while the barrier was not durable; once activation was published, the installed database and
 * the activated barrier durable from then on.
 */
async function adoptionHolds(model: OrderModel, dir: string, inodes: number[], barrier: RecoveryBarrier): Promise<void> {
  const lost = model.lost(inodes);
  assert.equal(lost, -1, `an original is unreachable at ${model.describe(lost)}`);
  model.log.forEach((entry, index) => {
    if (!preservedMove(dir, entry)) return;
    assert.ok(OrderModel.inodeAt(model.cuts[index], dir, 'storage-recovery/barrier.json'), `moved ${entry[1]} without a durable barrier`);
  });
  const published = model.marks.get('activated');
  assert.ok(published !== undefined);
  const database = (await lstat(databasePath(dir))).ino;
  const activated = (await lstat(join(dir, 'storage-recovery', 'barrier.json'))).ino;
  for (let index = published; index < model.cuts.length; index++) {
    assert.equal(OrderModel.inodeAt(model.cuts[index], dir, DATABASE), database, `installed database at ${model.describe(index)}`);
    assert.equal(OrderModel.inodeAt(model.cuts[index], dir, 'storage-recovery/barrier.json'), activated, `activated barrier at ${model.describe(index)}`);
  }
  // Real files: the originals are the recorded bytes, under their own names, and the snapshot is the database.
  const preserved = join(dir, 'storage-recovery', barrier.source.preservedDir);
  for (const file of barrier.source.files) {
    assert.equal((await lstat(join(preserved, file.name))).ino, file.generation.ino, `${file.name} is the original file`);
    assert.equal(sha(await readFile(join(preserved, file.name))), file.sha256, `${file.name} bytes`);
  }
  assert.equal(sha(await readFile(databasePath(dir))), barrier.snapshot.sha256, 'the snapshot is installed');
  assert.ok(!Object.keys(await filesUnder(dir)).some(name => name.includes('.restore-') || name.endsWith('.tmp')), 'no temporary file left');
}

test('ordering model: an adoption keeps its barrier durable before the first move, each folder durable before anything moves into it, and every original reachable', async t => {
  const history = await historyWithSidecars(t);
  const dir = await realpath(history.dir);
  const inodes = await originals(dir);
  const model = new OrderModel(dir);
  await model.start();
  instrument(t, model);
  const barrier = await adopt(history);
  model.mark('activated');

  const recoveryDir = join(dir, 'storage-recovery');
  const own = join(recoveryDir, barrier.id);
  const preserved = join(own, 'source');
  const firstMove = model.log.findIndex(entry => preservedMove(dir, entry));
  // Each new folder is synced into its parent before anything moves into it.
  for (const folder of [own, preserved]) {
    const made = model.log.findIndex(([op, path]) => op === 'mkdir' && path === folder);
    const synced = model.log.findIndex(([op, path], index) => index > made && op === 'syncDirectory' && path === dirname(folder));
    assert.ok(made >= 0 && made < synced && synced < firstMove, `${relative(dir, folder)}: ${JSON.stringify(model.log)}`);
  }
  // Every move syncs where it went, then where it left.
  model.log.forEach(([op, path], index) => {
    if (op !== 'rename' || !path.startsWith(`${preserved}/`)) return;
    assert.deepEqual(model.log.slice(index + 1, index + 3), [['syncDirectory', preserved], ['syncDirectory', dir]], relative(dir, path));
  });
  await adoptionHolds(model, dir, inodes, barrier);
});

test('ordering model control: the same activation without the parent sync of a new folder loses the originals at some cut', async t => {
  const recorded = await recordedWithSidecars(t);
  const { barrier } = recorded;
  const dir = await realpath(recorded.dir);
  const inodes = barrier.source.files.map(file => file.generation.ino);
  const model = new OrderModel(dir);
  await model.start();
  // As the code once did: new folders made, their parents never synced.
  const skipped = new Set([join(dir, 'storage-recovery'), join(dir, 'storage-recovery', barrier.id)]);
  const sync = storageFs.syncDirectory;
  const mkdir = storageFs.mkdir;
  t.mock.method(storageFs, 'mkdir', async (path: string) => { await mkdir(path); await model.after('mkdir', path); });
  t.mock.method(storageFs, 'syncDirectory', async (path: string) => {
    if (skipped.has(path) && model.log.every(([op]) => op !== 'rename')) return;
    await sync(path);
    await model.after('syncDirectory', path);
  });
  const move = storageFs.rename;
  t.mock.method(storageFs, 'rename', async (from: string, to: string) => { await move(from, to); await model.after('rename', to); });
  await activateRecoveryBarrier(dir, barrier.id);
  t.mock.restoreAll();
  assert.notEqual(model.lost(inodes), -1, 'the model detects the missing parent sync');
});

test('ordering model: an adoption stopped before any one step (or after the last) is retried under the same model, and the retry proves every link the failed attempt left', async t => {
  // How many operations a whole adoption (record, then activate) makes.
  const probe = await historyWithSidecars(t);
  const count = instrument(t, undefined);
  await adopt(probe);
  const steps = count();
  t.mock.restoreAll();
  assert.ok(steps >= 20, `an adoption makes ${steps} operations`);

  for (let step = 1; step <= steps; step++) {
    for (const when of ['before', 'after'] as const) {
      if (when === 'after' && step !== steps) continue; // after step n is before step n + 1
      const history = await historyWithSidecars(t);
      const dir = await realpath(history.dir);
      const inodes = await originals(dir);
      const model = new OrderModel(dir);
      await model.start();
      let failing = true;
      instrument(t, model, at => failing && at === step ? when : undefined);
      await assert.rejects(adopt(history), `${when} step ${step}`);
      const read = await readRecoveryBarrier(dir);
      if (read.state === 'present' && read.barrier.state === 'recorded') {
        // While unfinished, the storage does not open.
        const blocked = await openFixture(t, dir);
        assert.equal(blocked.status().failure?.code, 'recovery-in-progress', `${when} step ${step}`);
        await blocked.close();
      }
      // The same failure condition lifted; the instrument and the model stay.
      failing = false;
      const barrier = await adopt(history);
      model.mark('activated');
      assert.equal(barrier.state, 'activated', `${when} step ${step}`);
      await adoptionHolds(model, dir, inodes, barrier);
      t.mock.restoreAll();
    }
  }
});

/** Fails every sync once `from` has answered true for an operation, until `lift()`. */
function syncsFailFrom(t: TestContext, model: OrderModel, from: (op: Op, path: string) => boolean) {
  let state: 'waiting' | 'failing' | 'lifted' = 'waiting';
  instrument(t, model, (_index, op, path) => {
    if (state === 'waiting' && from(op, path)) state = 'failing';
    return state === 'failing' && isSync(op) ? 'before' : undefined;
  });
  return { lift: () => { state = 'lifted'; }, get failing() { return state === 'failing'; } };
}
const renamesSince = (model: OrderModel, index: number, path: string) => model.log.slice(index).filter(([op, to]) => op === 'rename' && to === path).length;

test('a recorded barrier whose publication failed moves nothing while syncs keep failing; the retry proves it before the first move', async t => {
  const history = await historyWithSidecars(t);
  const dir = await realpath(history.dir);
  const inodes = await originals(dir);
  const barrierPath = join(dir, 'storage-recovery', 'barrier.json');
  const model = new OrderModel(dir);
  await model.start();
  // The barrier's rename lands; its folder sync, and every sync after it, fails.
  const syncs = syncsFailFrom(t, model, (op, path) => op === 'rename' && path === barrierPath);
  await assert.rejects(recordRecoveryBarrier(dir, { snapshotId: history.snapshotId, reason: 'eio', context: history.context, known: history.known }));
  const read = await readRecoveryBarrier(dir);
  assert.ok(read.state === 'present' && read.barrier.state === 'recorded', 'the unsynced barrier is visible');
  await assert.rejects(activateRecoveryBarrier(dir, read.barrier.id), { code: 'io-error' });
  assert.ok(!model.log.some(([op]) => op === 'mkdir' || op === 'copyFile') && !model.log.some(entry => preservedMove(dir, entry)), 'nothing was made or moved');
  const blocked = await openFixture(t, dir);
  assert.equal(blocked.status().failure?.code, 'recovery-in-progress');
  assert.equal((await blocked.gate('core')).open, false);
  syncs.lift();
  const barrier = await adopt(history);
  model.mark('activated');
  assert.equal(barrier.id, read.barrier.id, 'the same adoption, resumed');
  await adoptionHolds(model, dir, inodes, barrier);
});

test('an activation whose publication failed is not answered, opened on or released while syncs keep failing; once they work it is proven, not rewritten', async t => {
  const recorded = await recordedWithSidecars(t);
  const dir = await realpath(recorded.dir);
  const barrierPath = join(dir, 'storage-recovery', 'barrier.json');
  const model = new OrderModel(dir);
  await model.start();
  const syncs = syncsFailFrom(t, model, (op, path) => op === 'rename' && path === barrierPath);
  await assert.rejects(activateRecoveryBarrier(dir, recorded.barrier.id));
  const read = await readRecoveryBarrier(dir);
  assert.ok(read.state === 'present' && read.barrier.state === 'activated', 'the unsynced activated barrier is visible');
  // Still failing: a retry does not answer activated, and the storage does not open on it.
  await assert.rejects(activateRecoveryBarrier(dir, recorded.barrier.id), { code: 'io-error' });
  const client = await openFixture(t, dir);
  assert.deepEqual([client.status().state, client.status().failure?.phase, client.status().failure?.code], ['unavailable', 'recovery', 'io-error']);
  assert.equal((await client.gate('core')).open, false);
  await client.close();
  syncs.lift();
  const lifted = model.cuts.length - 1;
  const activated = await activateRecoveryBarrier(dir, recorded.barrier.id);
  model.mark('activated');
  assert.equal(activated.activatedAt, read.barrier.activatedAt, 'the same document, proven');
  assert.equal(renamesSince(model, lifted, barrierPath), 0, 'not rewritten');
  const inode = (await lstat(barrierPath)).ino;
  assert.equal(OrderModel.inodeAt(model.cuts.at(-1)!, dir, 'storage-recovery/barrier.json'), inode, 'durable once answered');
  assert.equal(model.lost(recorded.barrier.source.files.map(file => file.generation.ino)), -1);
  const opened = await openFixture(t, dir);
  assert.equal(opened.status().state, 'ready', JSON.stringify(opened.status().failure));
});

test('a reconciliation whose publication failed opens no gate while syncs keep failing; once they work the gate proves it, without another write', async t => {
  const history = await historyAfterSnapshot(t);
  const dir = await realpath(history.dir);
  const barrier = await adoptSnapshot(dir, { snapshotId: history.snapshotId, reason: 'reconcile', context: history.context, known: history.known });
  const client = await openFixture(t, dir);
  await client.prepare({ allowMigration: false });
  const barrierPath = join(dir, 'storage-recovery', 'barrier.json');
  const model = new OrderModel(dir);
  await model.start();
  const syncs = syncsFailFrom(t, model, (op, path) => op === 'rename' && path === barrierPath);
  await assert.rejects(reconcileRecovery(dir, { barrierId: barrier.id, scopes: ['fixture'], by: 'owner', evidence: 'checked', context: history.context }));
  // The document says released; its publication is not durable, so the gate stays closed.
  assert.equal(recoveryHold(await readRecoveryBarrier(dir), 'fixture', history.context).held, false);
  const held = await client.gate('fixture');
  assert.equal(held.open, false);
  assert.match(held.reasons.join(' '), /not durable yet/);
  syncs.lift();
  const lifted = model.cuts.length - 1;
  assert.deepEqual(await client.gate('fixture'), { open: true, reasons: [] });
  model.mark('released');
  assert.equal(renamesSince(model, lifted, barrierPath), 0, 'proven, not rewritten');
  assert.equal(OrderModel.inodeAt(model.cuts.at(-1)!, dir, 'storage-recovery/barrier.json'), (await lstat(barrierPath)).ino);
  assert.equal((await client.gate('core')).open, false, 'only the named scope');
});

test('a storage found without its identity: an identity whose sync failed is not trusted on reopen while the failure lasts; the claim waits for it to be durable', async t => {
  const dir = await realpath(await stateDir(t));
  const first = await openFixture(t, dir);
  await first.prepare({ allowMigration: true });
  await first.close();
  const layout = await storageLayout(dir);
  await rm(join(layout.recoveryDir, 'identity.json'));
  const model = new OrderModel(dir);
  await model.start();
  let failing = true;
  instrument(t, model, (_index, op, path) => failing && op === 'syncDirectory' && path === layout.recoveryDir ? 'before' : undefined);
  const client = await openFixture(t, dir);
  assert.deepEqual([client.status().state, client.status().failure?.code], ['unavailable', 'io-error']);
  assert.equal(JSON.parse(await readFile(join(layout.recoveryDir, 'identity.json'), 'utf8')).state, 'created', 'what the failed record left visible');
  // The same failure: the visible identity is proven again, and is not.
  const again = await client.reopen();
  assert.deepEqual([again.state, again.failure?.code], ['unavailable', 'io-error']);
  await rejectsWith(client.prepare({ allowMigration: false }), { disposition: 'not-committed' });
  assert.equal((await client.gate('core')).open, false);
  failing = false;
  assert.equal((await client.reopen()).state, 'ready');
  const prepared = await client.prepare({ allowMigration: false });
  model.mark('claimed');
  assert.equal(prepared.claimed, true);
  assert.equal((await client.gate('core')).open, true);
  for (let index = model.marks.get('claimed')!; index < model.cuts.length; index++) {
    assert.equal(OrderModel.inodeAt(model.cuts[index], dir, 'storage-recovery/identity.json'), (await lstat(join(layout.recoveryDir, 'identity.json'))).ino, 'identity durable from the claim on');
    assert.equal(OrderModel.inodeAt(model.cuts[index], dir, DATABASE), (await lstat(databasePath(dir))).ino, 'database durable from the claim on');
  }
});

test('a "creating" identity whose sync failed: with the failure kept, the creating prepare is refused before the thread creates anything; once syncs work it resumes with the same ID', async t => {
  const dir = await realpath(await stateDir(t));
  const layout = await storageLayout(dir);
  const client = await openFixture(t, dir);
  const model = new OrderModel(dir);
  await model.start();
  let failing = true;
  instrument(t, model, (_index, op, path) => failing && op === 'syncDirectory' && path === layout.recoveryDir ? 'before' : undefined);
  await rejectsWith(client.prepare({ allowMigration: true, commandId: 'create-1' }), { phase: 'prepare', code: 'io-error', disposition: 'not-committed' });
  const creating = JSON.parse(await readFile(join(layout.recoveryDir, 'identity.json'), 'utf8'));
  assert.equal(creating.state, 'creating');
  assert.equal((await client.reopen()).schema?.kind, 'empty');
  await rejectsWith(client.prepare({ allowMigration: true, commandId: 'create-2' }), { phase: 'prepare', code: 'io-error', disposition: 'not-committed' });
  assert.equal((await client.reopen()).schema?.kind, 'empty', 'the thread created nothing');
  assert.deepEqual(await client.receipt('create-2'), { found: false });
  failing = false;
  const prepared = await client.prepare({ allowMigration: true, commandId: 'create-3' });
  model.mark('claimed');
  assert.ok(prepared.schema.kind !== 'empty' && prepared.schema.storageId === creating.storageId, 'the recorded ID');
  assert.equal(OrderModel.inodeAt(model.cuts.at(-1)!, dir, 'storage-recovery/identity.json'), (await lstat(join(layout.recoveryDir, 'identity.json'))).ino);
  assert.equal((await client.gate('core')).open, true);
});

test('new storage folders are synced into their parents before anything is put in them (identity, snapshots)', async t => {
  const dir = await realpath(await stateDir(t));
  const model = new OrderModel(dir);
  await model.start();
  instrument(t, model);
  const client = await openFixture(t, dir);
  await client.prepare({ allowMigration: true });
  await client.snapshot();
  await client.close();
  t.mock.restoreAll();
  const made = model.log.filter(([op]) => op === 'mkdir').map(([, path]) => path);
  assert.deepEqual(made.map(path => relative(dir, path).replace(/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}/, '<id>')), ['storage-recovery', 'storage-snapshots', 'storage-snapshots/<id>']);
  for (const path of made) {
    const created = model.log.findIndex(([op, p]) => op === 'mkdir' && p === path);
    const synced = model.log.findIndex(([op, p], index) => index > created && op === 'syncDirectory' && p === dirname(path));
    assert.ok(synced > created, `${path}: parent synced`);
    assert.ok(model.log.slice(created + 1, synced).every(([, p]) => !p.startsWith(`${path}/`)), `${path}: nothing put in it before its parent sync`);
  }
  // The first database file is synced into the state directory too.
  const database = model.log.findIndex(([op, p]) => op === 'createFile' && p === databasePath(dir));
  assert.deepEqual(model.log[database + 1], ['syncDirectory', dir]);
});

test('a folder found in place is synced into its parent again before it is used: a snapshot after one whose folder link failed is reachable', async t => {
  const dir = await realpath(await stateDir(t));
  const client = await openFixture(t, dir);
  await client.prepare({ allowMigration: true });
  const snapshots = join(dir, 'storage-snapshots');
  const model = new OrderModel(dir);
  await model.start();
  let failing = true;
  let made = false;
  instrument(t, model, (_index, op, path) => {
    if (op === 'mkdir' && path === snapshots) made = true;
    return failing && made && op === 'syncDirectory' && path === dir ? 'before' : undefined;
  });
  // storage-snapshots is made, and its link in the state directory is not synced.
  await rejectsWith(client.snapshot(), { phase: 'snapshot', code: 'io-error' });
  failing = false;
  const manifest = await client.snapshot();
  for (const name of ['snapshot.db', 'manifest.json']) {
    const path = `storage-snapshots/${manifest.id}/${name}`;
    assert.equal(OrderModel.inodeAt(model.cuts.at(-1)!, dir, path), (await lstat(join(dir, path))).ino, `${path} is reachable from the state directory`);
  }
});

const failure = (code: string) => Object.assign(new Error(`injected ${code}`), { code });

test('identity before claim: a failed "creating" record refuses the prepare as not committed and holds everything', async t => {
  const dir = await stateDir(t);
  const statuses: unknown[] = [];
  const client = await openFixture(t, dir, { onUnavailable: status => statuses.push(status) });
  const createFile = storageFs.createFile;
  t.mock.method(storageFs, 'createFile', async (path: string, data: string) => {
    if (path.includes('identity.json')) throw failure('ENOSPC');
    return createFile(path, data);
  });
  await rejectsWith(client.prepare({ allowMigration: true, commandId: 'create-1' }), { phase: 'prepare', code: 'no-space', disposition: 'not-committed', retryable: true, commandId: 'create-1' });
  t.mock.restoreAll();
  const status = client.status();
  assert.deepEqual([status.state, status.failure?.phase, status.failure?.code, status.failure?.sourcePreserved, status.ownerEpoch], ['unavailable', 'prepare', 'no-space', true, undefined]);
  assert.equal(statuses.length, 1);
  assert.equal((await client.gate('core')).open, false);
  await rejectsWith(client.write('fixture', 'put', { key: 'k', value: 'v' }, 'w-1'), { disposition: 'not-committed' });
  // Nothing was committed: the next open finds the same empty file and no identity.
  assert.equal((await client.reopen()).schema?.kind, 'empty');
  assert.ok(!Object.keys(await filesUnder(dir)).includes('storage-recovery/identity.json'));
});

for (const [name, inject] of [
  ['the "created" record cannot be written', 'rename'],
  ['the "created" record cannot be synced', 'syncDirectory'],
] as const) {
  test(`identity before claim: when ${name}, the committed prepare stays committed, nothing is claimed, and a lost database is never recreated empty`, async t => {
    const dir = await stateDir(t);
    const layout = await storageLayout(dir);
    const identity = join(layout.recoveryDir, 'identity.json');
    const client = await openFixture(t, dir);
    let identityWrites = 0;
    const original = { rename: storageFs.rename, syncDirectory: storageFs.syncDirectory };
    t.mock.method(storageFs, 'rename', async (from: string, to: string) => {
      if (to === identity && ++identityWrites === 2 && inject === 'rename') throw failure('EIO');
      return original.rename(from, to);
    });
    t.mock.method(storageFs, 'syncDirectory', async (path: string) => {
      if (path === layout.recoveryDir && identityWrites === 2 && inject === 'syncDirectory') throw failure('EIO');
      return original.syncDirectory(path);
    });
    await rejectsWith(client.prepare({ allowMigration: true, commandId: 'create-1' }), { phase: 'prepare', code: 'io-error', disposition: 'committed', retryable: true, commandId: 'create-1' });
    t.mock.restoreAll();
    assert.deepEqual([client.status().state, client.status().ownerEpoch], ['unavailable', undefined]);
    assert.equal((await client.gate('core')).open, false, 'no claim was published');
    await rejectsWith(client.write('fixture', 'put', { key: 'k', value: 'v' }, 'w-1'), { disposition: 'not-committed' });
    const recorded = JSON.parse(await readFile(identity, 'utf8'));
    assert.equal(recorded.state, inject === 'rename' ? 'creating' : 'created', 'what the failed step left on disk');
    await client.close();

    // The storage that may exist is known: losing the database and its sidecars (a reboot later) never yields a new empty one.
    const kept = await stateDir(t);
    const present = Object.keys(await filesUnder(dir)).filter(name => name.startsWith(DATABASE));
    for (const name of present) await rename(join(dir, name), join(kept, name));
    const before = await filesUnder(dir);
    const reboot = await openFixture(t, dir);
    assert.deepEqual([reboot.status().state, reboot.status().failure?.phase, reboot.status().failure?.code], ['unavailable', 'paths', 'database-missing']);
    await reboot.close();
    assert.deepEqual(await filesUnder(dir), before, 'no new state.sqlite');

    // With the files back, the open names the storage created, prepare claims it, and the first prepare's receipt is there.
    for (const name of present) await rename(join(kept, name), join(dir, name));
    const back = await openFixture(t, dir);
    assert.equal(back.status().state, 'ready', JSON.stringify(back.status().failure));
    assert.equal(JSON.parse(await readFile(identity, 'utf8')).state, 'created');
    await back.prepare({ allowMigration: false });
    assert.equal((await back.gate('core')).open, true);
    assert.ok((await back.receipt('create-1')).found, 'the committed creation is still committed');
  });
}

test('identity before claim: a creation that never committed resumes with the storage ID it recorded', async t => {
  const dir = await stateDir(t);
  const first = await openFixture(t, dir);
  await first.close();
  const layout = await storageLayout(dir);
  const storageId = '00000000-0000-4000-8000-000000000001';
  await recordStorageIdentity(layout, storageId, 'creating');
  const client = await openFixture(t, dir);
  assert.equal(client.status().schema?.kind, 'empty');
  const prepared = await client.prepare({ allowMigration: true });
  assert.ok(prepared.schema.kind !== 'empty' && prepared.schema.storageId === storageId);
  assert.equal(JSON.parse(await readFile(join(layout.recoveryDir, 'identity.json'), 'utf8')).state, 'created');
  // An identity still being created for one storage does not accept another storage's database either.
  await client.close();
  await recordStorageIdentity(layout, '00000000-0000-4000-8000-000000000002', 'creating');
  const refused = await openFixture(t, dir);
  assert.deepEqual([refused.status().failure?.phase, refused.status().failure?.code], ['schema', 'storage-replaced']);
});
