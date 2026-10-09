import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { promisify } from 'node:util';
import type { StorageBuildContext } from '../../../server/storage/bundle.js';
import type { KnownStorageEvidence, RecoveryBarrier } from '../../../server/storage/recovery.js';
import { historyAfterSnapshot, recordedWithSidecars, sha, type History } from './fixtures/history.js';
import { artifactOf, contextOf, DATABASE, databasePath, filesUnder, fixtureManifest, fixtureParentFile, openFixture, stateDir, storage } from './helpers.js';

const {
  activateRecoveryBarrier, adoptSnapshot, readRecoveryBarrier, readSnapshot, reconcileRecovery, recordRecoveryBarrier, recoveryHold, recoverySummary, StorageCommandError, StorageRecoveryError,
} = storage;
const run = promisify(execFile);
const hash = (char: string) => char.repeat(64);
const barrierFile = (dir: string) => join(dir, 'storage-recovery', 'barrier.json');

test('a snapshot holds the rows still in the WAL, is owner-only, checked and described by its manifest', async t => {
  const dir = await stateDir(t);
  const client = await openFixture(t, dir);
  await client.prepare({ allowMigration: true });
  await client.write('fixture', 'import', { manifestSha256: hash('a') }, 'import-1');
  await client.write('fixture', 'putMany', { prefix: 'wal', count: 40 }, 'rows-1');
  const database = databasePath(dir);
  // The rows are committed but not checkpointed: the main file alone does not have them.
  const probe = await stateDir(t);
  const mainOnly = join(probe, 'main-only.db');
  await copyFile(database, mainOnly);
  const plain = new DatabaseSync(mainOnly, { readOnly: true });
  const inMain = (() => { try { return Number((plain.prepare('SELECT count(*) AS n FROM fixture_items').get() as { n: number }).n); } catch { return -1; } finally { plain.close(); } })();
  assert.ok(inMain < 40, `the main file alone has ${inMain} rows`);
  assert.ok((await stat(`${database}-wal`)).size > 0);

  const manifest = await client.snapshot();
  const snapshotDir = join(dir, 'storage-snapshots', manifest.id);
  const copy = join(snapshotDir, 'snapshot.db');
  assert.equal((await stat(copy)).mode & 0o777, 0o600);
  assert.equal((await stat(snapshotDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(snapshotDir, 'manifest.json'))).mode & 0o777, 0o600);
  assert.equal(manifest.file.sha256, sha(await readFile(copy)));
  assert.deepEqual(manifest.checks, { quickCheck: 'ok', foreignKeyViolations: 0, journalMode: 'delete' });
  assert.equal(manifest.ownerEpoch, 1);
  assert.deepEqual(manifest.authority.map(row => [row.domain, row.generation]), [['fixture', 1]]);
  assert.deepEqual(manifest.schema.map(row => `${row.scope}@${row.version}`), ['core@1', 'fixture@1', 'plain@1']);
  const schema = client.status().schema;
  assert.ok(schema && schema.kind !== 'empty');
  assert.equal(manifest.storageId, schema.storageId);
  assert.deepEqual(manifest.build, client.status().identity);
  const opened = new DatabaseSync(copy, { readOnly: true });
  try { assert.equal(Number((opened.prepare('SELECT count(*) AS n FROM fixture_items').get() as { n: number }).n), 40); } finally { opened.close(); }
  assert.deepEqual(await readSnapshot(dir, manifest.id), manifest);
  // A copy that no longer matches its manifest is refused.
  await appendFile(copy, 'x');
  await assert.rejects(readSnapshot(dir, manifest.id), (error: unknown) => error instanceof StorageRecoveryError && error.code === 'snapshot-invalid');
  await assert.rejects(readSnapshot(dir, '../escape'), { code: 'snapshot-invalid' });
  // An empty storage has nothing to copy; a closed one cannot be asked.
  const empty = await openFixture(t, await stateDir(t));
  await assert.rejects(empty.snapshot(), (error: unknown) => error instanceof StorageCommandError && error.code === 'not-prepared');
});

test('adopting a snapshot records the barrier first, preserves the originals, and holds every scope until the owner reconciles it by name', async t => {
  const { dir, context, known, snapshotId, liveSha } = await historyAfterSnapshot(t);
  const barrier = await adoptSnapshot(dir, { snapshotId, reason: 'fixture corruption', context, known });
  assert.deepEqual(barrier.recordedBy, context.identity, 'recorded by the trusted build that ran it');
  assert.equal(barrier.state, 'activated');
  assert.equal(barrier.snapshot.id, snapshotId);
  assert.equal(barrier.source.preservedDir, `${barrier.id}/source`);
  assert.deepEqual(barrier.source.files.map(file => file.name), [DATABASE]);
  assert.deepEqual(barrier.scopes.map(scope => [scope.scope, scope.snapshotGeneration, scope.knownGeneration, scope.retreated]), [
    ['core', undefined, undefined, false], ['fixture', 1, 2, true], ['plain', undefined, undefined, false],
  ]);
  // The live database at the time is preserved byte for byte under its own name; the snapshot is the database now.
  assert.equal(sha(await readFile(join(dir, 'storage-recovery', barrier.source.preservedDir, DATABASE))), liveSha);
  assert.equal(sha(await readFile(databasePath(dir))), (await readSnapshot(dir, snapshotId)).file.sha256);
  assert.equal((await stat(barrierFile(dir))).mode & 0o777, 0o600);

  // The storage opens on the snapshot, but nothing durable may go ahead: core, the domain, and domains it never saw.
  const client = await openFixture(t, dir);
  await client.prepare({ allowMigration: false });
  assert.equal(client.status().recovery?.state, 'held');
  for (const scope of ['core', 'fixture', 'plain', 'remote-ledger']) assert.equal((await client.gate(scope)).open, false, scope);
  assert.equal(await client.read('fixture', 'get', { key: 'late' }), null, 'the snapshot predates the late row');
  assert.deepEqual(await client.receipt('late-1'), { found: false }, 'an absent receipt is not evidence that the work never ran');

  // A reboot: a new process of the same build reads the barrier from disk and still holds.
  const artifact = join(await stateDir(t), 'fixture-artifact.json');
  await writeFile(artifact, JSON.stringify(artifactOf('fixture')));
  const script = `
    const storage = await import(${JSON.stringify(fixtureParentFile)});
    const context = storage.storageBuildContext(await storage.readStorageBundleArtifact(${JSON.stringify(artifact)}));
    const read = await storage.readRecoveryBarrier(${JSON.stringify(dir)});
    console.log(JSON.stringify([context.ok, ...['core', 'fixture', 'later-domain'].map(scope => storage.recoveryHold(read, scope, context).held)]));`;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script]);
  assert.deepEqual(JSON.parse(stdout.trim()), [true, true, true, true]);

  // Replacing the database again (here: with the preserved original) does not lift the barrier: it lives outside it.
  await client.close();
  await copyFile(join(dir, 'storage-recovery', barrier.source.preservedDir, DATABASE), databasePath(dir));
  assert.equal(recoveryHold(await readRecoveryBarrier(dir), 'fixture', context).held, true);
  await client.reopen();
  assert.equal((await client.gate('fixture')).open, false);

  // The owner reconciles named scopes this build supports, with evidence. There is no "all".
  const reconcile = (scopes: string[], evidence = 'compared once-consumed IDs with the remote ledger') => reconcileRecovery(dir, { barrierId: barrier.id, scopes, by: 'owner', evidence, context });
  await assert.rejects(reconcile(['fixture'], ' '), { code: 'invalid-command' });
  await assert.rejects(reconcileRecovery(dir, { barrierId: 'other', scopes: ['fixture'], by: 'owner', evidence: 'x', context }), { code: 'recovery-invalid' });
  await assert.rejects(reconcile(['*']), { code: 'invalid-command' });
  await assert.rejects(reconcile([]), { code: 'invalid-command' });
  await assert.rejects(reconcile(['fixture', 'fixture']), { code: 'invalid-command' });
  const untouched = await readFile(barrierFile(dir), 'utf8');
  await assert.rejects(reconcile(['later-domain']), { code: 'unknown-scope' });
  await assert.rejects(reconcileRecovery(dir, { barrierId: barrier.id, scopes: ['fixture'], by: 'owner', evidence: 'x', context: contextOf('production') }), { code: 'unknown-scope' }, 'a build without the domain cannot release it');
  assert.equal(await readFile(barrierFile(dir), 'utf8'), untouched, 'refused reconciliations change nothing');
  await reconcile(['fixture']);
  await client.prepare({ allowMigration: false });
  assert.deepEqual(await client.gate('fixture'), { open: true, reasons: [] });
  assert.equal((await client.gate('core')).open, false);
  await reconcile(['core', 'plain'], 'all listed scopes reviewed');
  for (const scope of ['core', 'fixture', 'plain']) assert.equal((await client.gate(scope)).open, true, scope);
  // Everything this build knows is released; a later or unknown domain is not, and the storage never reads as clear.
  assert.equal((await client.gate('later-domain')).open, false);
  assert.deepEqual(client.status().recovery, { state: 'held', barrierId: barrier.id, reason: 'Snapshot recovery holds every scope not reconciled by name.', reconciled: ['core', 'fixture', 'plain'], unreconciled: [] });
  const saved = await readRecoveryBarrier(dir);
  assert.ok(saved.state === 'present');
  assert.deepEqual(saved.barrier.reconciled.map(entry => [entry.scope, entry.manifestDigest]), [['fixture', fixtureManifest.digest], ['core', fixtureManifest.digest], ['plain', fixtureManifest.digest]]);
});

test('live files that changed after the barrier was recorded are not moved; the barrier keeps holding; a retry continues', async t => {
  const { dir, context, known, snapshotId } = await historyAfterSnapshot(t);
  const recorded = await recordRecoveryBarrier(dir, { snapshotId, reason: 'test', context, known });
  assert.equal(recorded.state, 'recorded');
  // The worker opening the storage now is refused: activation has not finished.
  const before = await filesUnder(dir);
  const blocked = await openFixture(t, dir);
  assert.deepEqual([blocked.status().state, blocked.status().failure?.phase, blocked.status().failure?.code], ['unavailable', 'recovery', 'recovery-in-progress']);
  assert.deepEqual(await filesUnder(dir), before);
  assert.equal(recoveryHold(await readRecoveryBarrier(dir), 'core', context).held, true);

  // Someone writes to the live database between the steps.
  const live = new DatabaseSync(databasePath(dir));
  live.exec("INSERT INTO fixture_items (key, value) VALUES ('meanwhile', 'x')");
  live.close();
  const changed = await filesUnder(dir);
  await assert.rejects(activateRecoveryBarrier(dir, recorded.id), (error: unknown) => error instanceof StorageRecoveryError && error.code === 'source-changed');
  const after = await filesUnder(dir);
  for (const name of [DATABASE, `${DATABASE}-wal`, `${DATABASE}-shm`]) assert.deepEqual(after[name], changed[name], `${name} was not moved`);
  const still = await readRecoveryBarrier(dir);
  assert.ok(still.state === 'present' && still.barrier.state === 'recorded');

  // Another snapshot cannot start while this one is unfinished; the same one is re-recorded (nothing was moved yet).
  await assert.rejects(recordRecoveryBarrier(dir, { snapshotId: '20000101T000000Z-000000000000', reason: 'x', context }), { code: 'snapshot-invalid' });
  const again = await recordRecoveryBarrier(dir, { snapshotId, reason: 'retry', context, known });
  assert.equal(again.id, recorded.id);
  const activated = await activateRecoveryBarrier(dir, again.id);
  assert.equal(activated.state, 'activated');
  assert.equal((await activateRecoveryBarrier(dir, again.id)).activatedAt, activated.activatedAt, 'activating twice changes nothing');
});

test('a crash between moving the originals and installing the snapshot resumes from the preserved files', async t => {
  const { dir, context, snapshotId, liveSha } = await historyAfterSnapshot(t);
  const recorded = await recordRecoveryBarrier(dir, { snapshotId, reason: 'test', context });
  assert.ok(recorded.scopes.every(scope => scope.retreated), 'without evidence of the live database every scope counts as retreated');
  const preserved = join(dir, 'storage-recovery', recorded.source.preservedDir);
  await mkdir(preserved, { recursive: true, mode: 0o700 });
  for (const file of recorded.source.files) await rename(join(dir, file.name), join(preserved, file.name));
  const activated = await activateRecoveryBarrier(dir, recorded.id);
  assert.equal(activated.state, 'activated');
  assert.equal(sha(await readFile(join(preserved, DATABASE))), liveSha);
  // Once activated, recording again is a new adoption: a new barrier that names the one it replaces.
  const next = await recordRecoveryBarrier(dir, { snapshotId, reason: 'second adoption', context });
  assert.notEqual(next.id, recorded.id);
  assert.deepEqual(next.previous, [recorded.id]);
  assert.equal(next.state, 'recorded');
});

test('activation counts the snapshot as installed only with every original preserved as recorded and no sidecar left live', async t => {
  // A database equal to the snapshot (new inode) where the originals went somewhere else: not installed by this recovery.
  {
    const { dir, context, known, snapshotId } = await historyAfterSnapshot(t);
    const barrier = await recordRecoveryBarrier(dir, { snapshotId, reason: 'lost originals', context, known });
    await rename(databasePath(dir), join(dir, 'lost.db'));
    await copyFile(join(dir, 'storage-snapshots', snapshotId, 'snapshot.db'), databasePath(dir));
    await chmod(databasePath(dir), 0o600);
    const before = await filesUnder(dir);
    await assert.rejects(activateRecoveryBarrier(dir, barrier.id), { code: 'source-changed' });
    assert.deepEqual(await filesUnder(dir), before, 'nothing moved, nothing claimed as preserved');
    const read = await readRecoveryBarrier(dir);
    assert.ok(read.state === 'present' && read.barrier.state === 'recorded');
  }
  // A preserved WAL that was changed after it was moved aside.
  {
    const { dir, barrier } = await recordedWithSidecars(t);
    const preserved = join(dir, 'storage-recovery', barrier.source.preservedDir);
    await mkdir(join(dir, 'storage-recovery', barrier.id), { mode: 0o700 });
    await mkdir(preserved, { mode: 0o700 });
    for (const file of barrier.source.files) await rename(join(dir, file.name), join(preserved, file.name));
    const wal = join(preserved, `${DATABASE}-wal`);
    const bytes = await readFile(wal);
    bytes[bytes.length - 1] ^= 0xff;
    await writeFile(wal, bytes);
    await assert.rejects(activateRecoveryBarrier(dir, barrier.id), { code: 'source-changed' });
    assert.equal(Object.keys(await filesUnder(dir)).includes(DATABASE), false, 'no snapshot installed over a doubtful original');
  }
  // A shm left live after the originals were preserved and the snapshot installed.
  {
    const { dir, barrier } = await recordedWithSidecars(t);
    const preserved = join(dir, 'storage-recovery', barrier.source.preservedDir);
    await mkdir(join(dir, 'storage-recovery', barrier.id), { mode: 0o700 });
    await mkdir(preserved, { mode: 0o700 });
    for (const file of barrier.source.files) await rename(join(dir, file.name), join(preserved, file.name));
    await copyFile(join(dir, 'storage-snapshots', barrier.snapshot.id, 'snapshot.db'), databasePath(dir));
    await chmod(databasePath(dir), 0o600);
    await writeFile(databasePath(dir, '-shm'), Buffer.alloc(32768), { mode: 0o600 });
    await assert.rejects(activateRecoveryBarrier(dir, barrier.id), { code: 'source-changed' });
    const read = await readRecoveryBarrier(dir);
    assert.ok(read.state === 'present' && read.barrier.state === 'recorded');
    // With the stray shm gone, the same activation finishes and the originals are the recorded ones.
    await rename(databasePath(dir, '-shm'), join(dir, 'stray-shm'));
    assert.equal((await activateRecoveryBarrier(dir, barrier.id)).state, 'activated');
    for (const file of barrier.source.files) assert.equal(sha(await readFile(join(preserved, file.name))), file.sha256, file.name);
  }
});

test('a barrier is used only when whole: anything incomplete, malformed, unknown or outside its folder holds everything and is left as found', async t => {
  const { dir, context, known, snapshotId } = await historyAfterSnapshot(t);
  const valid = await adoptSnapshot(dir, { snapshotId, reason: 'whole', context, known });
  const reconciledValid: RecoveryBarrier = { ...valid, reconciled: [{ scope: 'fixture', at: new Date().toISOString(), by: 'owner', evidence: 'checked', manifestDigest: fixtureManifest.digest }] };
  const without = (value: object, key: string) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
  const cases: [string, unknown][] = [
    ['the reviewer\'s incomplete v1', { format: 'tower-storage-recovery-barrier', version: 1, state: 'activated', scopes: [], reconciled: [{ scope: '*' }] }],
    ['unknown version', { ...valid, version: 2 }],
    ['unknown format', { ...valid, format: 'other' }],
    ['unknown state', { ...valid, state: 'finished' }],
    ['an extra field', { ...valid, clearAll: true }],
    ...(['id', 'state', 'recordedAt', 'recordedBy', 'snapshot', 'source', 'scopes', 'reconciled', 'previous', 'activatedAt'] as const).map(key => [`no ${key}`, without(valid, key)] as [string, unknown]),
    ['bad id', { ...valid, id: '../escape' }],
    ['recorded with an activation time', { ...valid, state: 'recorded' }],
    ['snapshot without its hash', { ...valid, snapshot: without(valid.snapshot, 'sha256') }],
    ['snapshot hash not a hash', { ...valid, snapshot: { ...valid.snapshot, sha256: 'x' } }],
    ['snapshot storage id', { ...valid, snapshot: { ...valid.snapshot, storageId: 'someone' } }],
    ['snapshot build', { ...valid, snapshot: { ...valid.snapshot, build: { ...valid.snapshot.build, sourceHash: undefined } } }],
    ['authority generation 0', { ...valid, snapshot: { ...valid.snapshot, authority: [{ domain: 'fixture', authority: 'database', generation: 0 }] } }],
    ['source file hash', { ...valid, source: { ...valid.source, files: valid.source.files.map(file => ({ ...file, sha256: 'nope' })) } }],
    ['source file generation', { ...valid, source: { ...valid.source, files: valid.source.files.map(file => ({ ...file, generation: { ...file.generation, ino: -1 } })) } }],
    ['source file name', { ...valid, source: { ...valid.source, files: valid.source.files.map(file => ({ ...file, name: '../../outside' })) } }],
    ['source file twice', { ...valid, source: { ...valid.source, files: [...valid.source.files, ...valid.source.files] } }],
    ['preserved folder outside', { ...valid, source: { ...valid.source, preservedDir: '../../elsewhere' } }],
    ['preserved folder of another barrier', { ...valid, source: { ...valid.source, preservedDir: '20000101T000000Z-000000000000/source' } }],
    ['known evidence', { ...valid, source: { ...valid.source, known: { schema: 'all' } } }],
    ['scopes not from the evidence', { ...valid, scopes: valid.scopes.map(scope => ({ ...scope, retreated: false })) }],
    ['scopes emptied', { ...valid, scopes: [] }],
    ['wildcard reconciliation', { ...reconciledValid, reconciled: [{ ...reconciledValid.reconciled[0], scope: '*' }] }],
    ...(['scope', 'at', 'by', 'evidence', 'manifestDigest'] as const).map(key => [`reconciliation without ${key}`, { ...reconciledValid, reconciled: [without(reconciledValid.reconciled[0], key)] }] as [string, unknown]),
    ['reconciliation without evidence text', { ...reconciledValid, reconciled: [{ ...reconciledValid.reconciled[0], evidence: '  ' }] }],
    ['reconciliation at no time', { ...reconciledValid, reconciled: [{ ...reconciledValid.reconciled[0], at: 'yesterday' }] }],
    ['reconciled before activation', { ...without(reconciledValid, 'activatedAt'), state: 'recorded' }],
    ['previous names itself', { ...valid, previous: [valid.id] }],
  ];
  // The whole one reads back as present, and the mutations below are measured against it.
  await writeFile(barrierFile(dir), JSON.stringify(reconciledValid));
  assert.equal((await readRecoveryBarrier(dir)).state, 'present');
  const client = await openFixture(t, dir);
  await client.prepare({ allowMigration: false });
  assert.equal((await client.gate('fixture')).open, true, 'the whole barrier releases its reconciled scope');
  for (const [name, value] of cases) {
    const text = JSON.stringify(value);
    await writeFile(barrierFile(dir), text);
    const read = await readRecoveryBarrier(dir);
    assert.equal(read.state, 'invalid', name);
    for (const scope of ['core', 'fixture', 'plain', 'later-domain']) assert.equal(recoveryHold(read, scope, context).held, true, `${name}: ${scope}`);
    assert.deepEqual(recoverySummary(read, context), { state: 'held', reason: (read as { reason: string }).reason, reconciled: [], unreconciled: [] }, name);
    assert.equal((await client.gate('fixture')).open, false, name);
    await assert.rejects(reconcileRecovery(dir, { barrierId: valid.id, scopes: ['fixture'], by: 'owner', evidence: 'x', context }), { code: 'recovery-invalid' }, name);
    await assert.rejects(activateRecoveryBarrier(dir, valid.id), { code: 'recovery-invalid' }, name);
    await assert.rejects(recordRecoveryBarrier(dir, { snapshotId, reason: 'x', context }), { code: 'recovery-invalid' }, name);
    assert.equal(await readFile(barrierFile(dir), 'utf8'), text, `${name}: left as found`);
  }
  // Not JSON at all.
  await writeFile(barrierFile(dir), '{ not json');
  assert.equal(recoveryHold(await readRecoveryBarrier(dir), 'core', context).held, true);
  assert.equal(await readFile(barrierFile(dir), 'utf8'), '{ not json');
});

test('a snapshot of another storage is refused', async t => {
  const mine = await historyAfterSnapshot(t);
  const theirs = await historyAfterSnapshot(t);
  await rename(join(theirs.dir, 'storage-snapshots', theirs.snapshotId), join(mine.dir, 'storage-snapshots', theirs.snapshotId));
  await assert.rejects(recordRecoveryBarrier(mine.dir, { snapshotId: theirs.snapshotId, reason: 'x', context: mine.context }), { code: 'snapshot-foreign' });
  assert.equal((await readRecoveryBarrier(mine.dir)).state, 'absent');
});

/** The snapshot adopted with `known` as the evidence of the live database it replaced. */
async function adoptedWith(t: Parameters<typeof historyAfterSnapshot>[0], change: (known: KnownStorageEvidence) => KnownStorageEvidence): Promise<History & { barrier: RecoveryBarrier }> {
  const history = await historyAfterSnapshot(t);
  const barrier = await adoptSnapshot(history.dir, { snapshotId: history.snapshotId, reason: 'evidence', context: history.context, known: change(history.known) });
  return { ...history, barrier };
}
const release = (scope: string, manifestDigest = fixtureManifest.digest) => ({ scope, at: new Date().toISOString(), by: 'owner', evidence: 'checked by a build that understood it', manifestDigest });

test('a barrier whose evidence names a scope or schema version beyond this build holds every scope, a reconciled core included, and refuses to reconcile without writing', async t => {
  const cases: [string, (known: KnownStorageEvidence) => KnownStorageEvidence, string][] = [
    ['an unknown domain\'s schema', known => ({ ...known, schema: [...known.schema, { scope: 'later', version: 1 }] }), 'later'],
    ['a higher core schema', known => ({ ...known, schema: [...known.schema, { scope: 'core', version: 2 }] }), 'core schema 2'],
    ['a higher domain schema', known => ({ ...known, schema: [...known.schema, { scope: 'fixture', version: 2 }] }), 'fixture schema 2'],
    ['an unknown domain\'s authority', known => ({ ...known, authority: [...known.authority, { domain: 'later', authority: 'database', generation: 1 }] }), 'later'],
  ];
  for (const [name, change, named] of cases) {
    const { dir, context, barrier } = await adoptedWith(t, change);
    // As a build that understood the evidence would have left it: core reconciled.
    await writeFile(barrierFile(dir), JSON.stringify({ ...barrier, reconciled: [release('core')] }));
    const read = await readRecoveryBarrier(dir);
    assert.equal(read.state, 'present', `${name}: a whole barrier`);
    for (const scope of ['core', 'fixture', 'plain']) {
      const hold = recoveryHold(read, scope, context);
      assert.equal(hold.held, true, `${name}: ${scope}`);
      assert.match(hold.reason!, /does not understand its evidence/, name);
      assert.ok(hold.reason!.includes(named), `${name}: ${hold.reason}`);
    }
    const summary = recoverySummary(read, context);
    assert.ok(summary.state === 'held' && !summary.reconciled.length && /reconciliations do not apply/.test(summary.reason), `${name}: ${JSON.stringify(summary)}`);
    // The storage still opens and prepares, for diagnosis; its gate stays closed.
    const client = await openFixture(t, dir);
    await client.prepare({ allowMigration: false });
    const gate = await client.gate('core');
    assert.equal(gate.open, false, `${name}: core stays held though reconciled`);
    assert.ok(gate.reasons.some(reason => reason.includes(named)));
    await client.close();
    const before = await readFile(barrierFile(dir), 'utf8');
    await assert.rejects(reconcileRecovery(dir, { barrierId: barrier.id, scopes: ['core'], by: 'owner', evidence: 'x', context }), { code: 'unknown-scope' }, name);
    assert.equal(await readFile(barrierFile(dir), 'utf8'), before, `${name}: nothing written`);
  }
});

test('the same barrier is judged by what each build understands, not by which build recorded it', async t => {
  const { dir, context, known, snapshotId } = await historyAfterSnapshot(t);
  const barrier = await adoptSnapshot(dir, { snapshotId, reason: 'judged by its evidence', context, known });
  await reconcileRecovery(dir, { barrierId: barrier.id, scopes: ['core'], by: 'owner', evidence: 'checked', context });
  const read = await readRecoveryBarrier(dir);
  // Control: the recording build understands every row and releases what was reconciled.
  assert.equal(recoveryHold(read, 'core', context).held, false);
  // Another source with the same contract (another build of the same release) is not asked to be the recorder.
  assert.notEqual(contextOf('change-on-check').sourceHash, barrier.recordedBy.sourceHash);
  assert.equal(recoveryHold(read, 'core', contextOf('change-on-check')).held, false);
  // A build without the fixture domain (lower) does not understand the snapshot's own rows: it holds everything.
  const lower = contextOf('production');
  const hold = recoveryHold(read, 'core', lower);
  assert.equal(hold.held, true);
  assert.match(hold.reason!, /does not understand its evidence of fixture/);
  const before = await readFile(barrierFile(dir), 'utf8');
  await assert.rejects(reconcileRecovery(dir, { barrierId: barrier.id, scopes: ['core'], by: 'owner', evidence: 'x', context: lower }), { code: 'unknown-scope' });
  assert.equal(await readFile(barrierFile(dir), 'utf8'), before);
});

test('a reconciliation naming a scope this build does not support has no effect, and holds nothing else', async t => {
  const { dir, context, known, snapshotId } = await historyAfterSnapshot(t);
  const barrier = await adoptSnapshot(dir, { snapshotId, reason: 'later release', context, known });
  // As a later build that supports later-domain would leave it.
  await writeFile(barrierFile(dir), JSON.stringify({ ...barrier, reconciled: [release('later-domain', 'a'.repeat(64))] }));
  const read = await readRecoveryBarrier(dir);
  assert.equal(read.state, 'present');
  assert.equal(recoveryHold(read, 'later-domain', context).held, true, 'not a release in this build');
  const summary = recoverySummary(read, context);
  assert.ok(summary.state === 'held');
  assert.deepEqual(summary.reconciled, []);
  assert.doesNotMatch(summary.reason, /does not understand/);
  await reconcileRecovery(dir, { barrierId: barrier.id, scopes: ['core'], by: 'owner', evidence: 'checked', context });
  const client = await openFixture(t, dir);
  await client.prepare({ allowMigration: false });
  assert.deepEqual(await client.gate('core'), { open: true, reasons: [] });
  assert.equal((await client.gate('later-domain')).open, false);
});

test('recovery steps take only a trusted build context: a hand-made one with more domains holds everything and is refused before anything is written', async t => {
  const { dir, context, known, snapshotId } = await historyAfterSnapshot(t);
  const barrier = await adoptSnapshot(dir, { snapshotId, reason: 'forged', context, known });
  const forged = { ...context, manifest: { ...context.manifest, domains: [...context.manifest.domains, { ...context.manifest.domains[0], scope: 'later-domain' }] } } as StorageBuildContext;
  assert.equal(storage.isStorageBuildContext(forged), false);
  const read = await readRecoveryBarrier(dir);
  for (const scope of ['core', 'later-domain']) assert.equal(recoveryHold(read, scope, forged).held, true, scope);
  assert.equal(recoverySummary(read, forged).state, 'held');
  const before = await filesUnder(dir);
  await assert.rejects(reconcileRecovery(dir, { barrierId: barrier.id, scopes: ['later-domain'], by: 'owner', evidence: 'x', context: forged }), { code: 'bundle-untrusted' });
  await assert.rejects(recordRecoveryBarrier(dir, { snapshotId, reason: 'x', context: forged }), { code: 'bundle-untrusted' });
  assert.deepEqual(await filesUnder(dir), before);
  // A trusted context cannot be widened in place either.
  assert.throws(() => { (context.manifest.domains as unknown[]).push(forged.manifest.domains.at(-1)); }, TypeError);
});
