import assert from 'node:assert/strict';
import { lstat, readdir, readFile, realpath, rename } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import test, { type TestContext } from 'node:test';
import { storageFs, storageLayout } from '../../../server/storage/paths.js';
import { activateRecoveryBarrier, readRecoveryBarrier, readSnapshot, recordStorageIdentity } from '../../../server/storage/recovery.js';
import { recordedWithSidecars, sha } from './fixtures/history.js';
import { DATABASE, databasePath, filesUnder, openFixture, rejectsWith, stateDir } from './helpers.js';

/**
 * Storage durability is checked two ways, kept apart:
 *  - An ordering model, not a power failure: it records every create, move and sync the storage makes through
 *    storageFs, and treats a folder's entries as surviving a power cut only as they were at that folder's last sync
 *    (a folder never synced since it was made keeps nothing). At every point between two operations it asks whether
 *    each original file is still reachable from the state directory. Nothing here cuts power or proves what a given
 *    file system does; it proves the order of links and syncs the code relies on.
 *  - Real private files: a step fails (an injected error) and the process carries on, then the same operation runs
 *    again on the files as they were left.
 */

type Op = 'mkdir' | 'rename' | 'createFile' | 'copyFile' | 'syncDirectory';
const OPS: Op[] = ['mkdir', 'rename', 'createFile', 'copyFile', 'syncDirectory'];
interface Entry { ino: number; dir: boolean }
type Listing = ReadonlyMap<string, Entry>;

async function listing(dir: string): Promise<Listing> {
  const entries = new Map<string, Entry>();
  for (const entry of await readdir(dir, { withFileTypes: true })) entries.set(entry.name, { ino: (await lstat(join(dir, entry.name))).ino, dir: entry.isDirectory() });
  return entries;
}

/** The durable view of folder entries, step by step. */
class OrderModel {
  readonly log: [Op, string][] = [];
  readonly cuts: Map<string, Listing>[] = [];
  readonly #durable = new Map<string, Listing>();
  constructor(readonly root: string) {}
  /** Everything that exists now counts as durable: the state before the operation under test. */
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
  /** The inodes of regular files reachable from the root in one cut. */
  static reachable(cut: Map<string, Listing>, root: string): Set<number> {
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
}

/** Records every storageFs operation in `model`, and lets `fail` throw instead of (or after) one. */
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

test('ordering model: at every point of an activation the original database, WAL and shm stay reachable, and only the synced links count', async t => {
  const recorded = await recordedWithSidecars(t);
  const { barrier } = recorded;
  const dir = await realpath(recorded.dir);
  const originals = barrier.source.files.map(file => file.generation.ino);
  const model = new OrderModel(dir);
  await model.start();
  instrument(t, model);
  await activateRecoveryBarrier(dir, barrier.id);
  t.mock.restoreAll();

  const at = (op: Op, path: string) => model.log.findIndex(([o, p]) => o === op && p === path);
  // Each new folder is synced into its parent before anything moves into it.
  const recoveryDir = join(dir, 'storage-recovery');
  const own = join(recoveryDir, barrier.id);
  const preserved = join(own, 'source');
  assert.ok(at('mkdir', own) < at('syncDirectory', recoveryDir) && at('mkdir', preserved) < at('syncDirectory', own), JSON.stringify(model.log));
  const firstMove = model.log.findIndex(([op, path]) => op === 'rename' && path.startsWith(preserved));
  assert.ok(at('syncDirectory', own) < firstMove && at('syncDirectory', recoveryDir) < firstMove);
  // Every move syncs where it went, then where it left.
  model.log.forEach(([op, path], index) => {
    if (op !== 'rename' || !path.startsWith(preserved)) return;
    assert.deepEqual(model.log.slice(index + 1, index + 3), [['syncDirectory', preserved], ['syncDirectory', dir]], relative(dir, path));
  });
  for (const [index, cut] of model.cuts.entries()) {
    const reachable = OrderModel.reachable(cut, dir);
    for (const ino of originals) assert.ok(reachable.has(ino), `original ${ino} lost at cut ${index} (after ${JSON.stringify(model.log[index - 1])})`);
  }
  // Real files: the originals are the recorded bytes, under their own names, and the snapshot is the database.
  for (const file of barrier.source.files) assert.equal(sha(await readFile(join(preserved, file.name))), file.sha256, file.name);
  assert.equal(sha(await readFile(databasePath(dir))), (await readSnapshot(dir, barrier.snapshot.id)).file.sha256);
});

test('ordering model control: the same activation without the parent sync of a new folder loses the originals at some cut', async t => {
  const recorded = await recordedWithSidecars(t);
  const { barrier } = recorded;
  const dir = await realpath(recorded.dir);
  const originals = barrier.source.files.map(file => file.generation.ino);
  const model = new OrderModel(dir);
  await model.start();
  // As the reviewed code did: new folders made, their parents never synced.
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
  const lost = model.cuts.some(cut => originals.some(ino => !OrderModel.reachable(cut, dir).has(ino)));
  assert.equal(lost, true, 'the model detects the missing parent sync');
});

test('real files: an activation stopped at any step resumes, preserving the recorded originals exactly', async t => {
  // How many operations a whole activation makes.
  const probe = await recordedWithSidecars(t);
  const count = instrument(t, undefined);
  await activateRecoveryBarrier(probe.dir, probe.barrier.id);
  const steps = count();
  t.mock.restoreAll();
  assert.ok(steps >= 12, `an activation makes ${steps} operations`);

  for (let step = 1; step <= steps; step++) {
    for (const when of ['before', 'after'] as const) {
      if (when === 'after' && step !== steps) continue; // after step n is before step n + 1
      const { dir, barrier } = await recordedWithSidecars(t);
      instrument(t, undefined, at => at === step ? when : undefined);
      await assert.rejects(activateRecoveryBarrier(dir, barrier.id), `${when} step ${step}`);
      t.mock.restoreAll();
      const read = await readRecoveryBarrier(dir);
      assert.equal(read.state, 'present', `${when} step ${step}`);
      if (read.state === 'present' && read.barrier.state === 'recorded') {
        // While unfinished, the storage does not open.
        const blocked = await openFixture(t, dir);
        assert.equal(blocked.status().failure?.code, 'recovery-in-progress', `${when} step ${step}`);
        await blocked.close();
      }
      const activated = await activateRecoveryBarrier(dir, barrier.id);
      assert.equal(activated.state, 'activated', `${when} step ${step}`);
      const preserved = join(dir, 'storage-recovery', barrier.source.preservedDir);
      for (const file of barrier.source.files) {
        const info = await lstat(join(preserved, file.name));
        assert.equal(info.ino, file.generation.ino, `${when} step ${step}: ${file.name} is the original file`);
        assert.equal(sha(await readFile(join(preserved, file.name))), file.sha256, `${when} step ${step}: ${file.name} bytes`);
      }
      assert.equal(sha(await readFile(databasePath(dir))), barrier.snapshot.sha256, `${when} step ${step}: the snapshot is installed`);
      assert.ok(!Object.keys(await filesUnder(dir)).some(name => name.includes('.restore-') || name.endsWith('.tmp')), `${when} step ${step}: no temporary file left`);
    }
  }
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
