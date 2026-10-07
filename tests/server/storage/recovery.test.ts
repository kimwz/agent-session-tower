import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { StorageCommandError, type StorageBuildIdentity } from '../../../server/storage/contract.js';
import {
  activateRecoveryBarrier, adoptSnapshot, readRecoveryBarrier, readSnapshot, reconcileRecovery, recordRecoveryBarrier, recoveryHold, StorageRecoveryError,
  type KnownStorageEvidence,
} from '../../../server/storage/recovery.js';
import { filesUnder, openFixture, stateDir } from './helpers.js';

const run = promisify(execFile);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const hash = (char: string) => char.repeat(64);

test('a snapshot holds the rows still in the WAL, is owner-only, checked and described by its manifest', async t => {
  const dir = await stateDir(t);
  const client = await openFixture(t, dir);
  await client.prepare({ allowMigration: true });
  await client.write('fixture', 'import', { manifestSha256: hash('a') }, 'import-1');
  await client.write('fixture', 'putMany', { prefix: 'wal', count: 40 }, 'rows-1');
  const database = join(dir, 'storage', 'tower.db');
  // The rows are committed but not checkpointed: the main file alone does not have them.
  const mainOnly = join(dir, 'main-only.db');
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

interface Adopted { dir: string; build: StorageBuildIdentity; known: KnownStorageEvidence; snapshotId: string; liveSha: string }
/** Snapshot at generation 1, then more history (generation 2, rows, receipts) the snapshot will not have. Closed. */
async function historyAfterSnapshot(t: Parameters<typeof openFixture>[0]): Promise<Adopted> {
  const dir = await stateDir(t);
  const client = await openFixture(t, dir);
  await client.prepare({ allowMigration: true });
  await client.write('fixture', 'import', { manifestSha256: hash('a') }, 'import-1');
  await client.write('fixture', 'put', { key: 'early', value: '1' }, 'early-1');
  const snapshot = await client.snapshot();
  await client.write('fixture', 'put', { key: 'late', value: '2' }, 'late-1');
  await client.write('fixture', 'export', { manifestSha256: hash('b') }, 'export-1');
  const inspection = await client.inspect();
  const known: KnownStorageEvidence = {
    schema: inspection.schema.kind === 'empty' ? [] : inspection.schema.applied.map(({ scope, version }) => ({ scope, version })),
    authority: inspection.authority.map(({ domain, authority, generation }) => ({ domain, authority, generation })), ownerEpoch: inspection.ownerEpoch,
  };
  const build = client.status().identity!;
  await client.close();
  return { dir, build, known, snapshotId: snapshot.id, liveSha: sha(await readFile(join(dir, 'storage', 'tower.db'))) };
}

test('adopting a snapshot records the barrier first, preserves the originals, and holds every scope until the owner reconciles it', async t => {
  const { dir, build, known, snapshotId, liveSha } = await historyAfterSnapshot(t);
  const barrier = await adoptSnapshot(dir, { snapshotId, reason: 'fixture corruption', build, known });
  assert.equal(barrier.state, 'activated');
  assert.equal(barrier.snapshot.id, snapshotId);
  assert.deepEqual(barrier.scopes.map(scope => [scope.scope, scope.snapshotGeneration, scope.knownGeneration, scope.retreated]), [
    ['core', undefined, undefined, false], ['fixture', 1, 2, true], ['plain', undefined, undefined, false],
  ]);
  // The live database at the time is preserved byte for byte; the snapshot is the database now.
  assert.equal(sha(await readFile(join(dir, 'storage-recovery', barrier.source.preservedDir, 'tower.db'))), liveSha);
  assert.equal(sha(await readFile(join(dir, 'storage', 'tower.db'))), (await readSnapshot(dir, snapshotId)).file.sha256);
  assert.equal((await stat(join(dir, 'storage-recovery', 'barrier.json'))).mode & 0o777, 0o600);

  // The storage opens on the snapshot, but nothing durable may go ahead: core, the domain, and domains it never saw.
  const client = await openFixture(t, dir);
  await client.prepare({ allowMigration: false });
  assert.equal(client.status().recovery?.state, 'held');
  for (const scope of ['core', 'fixture', 'plain', 'remote-ledger']) assert.equal((await client.gate(scope)).open, false, scope);
  assert.equal(await client.read('fixture', 'get', { key: 'late' }), null, 'the snapshot predates the late row');
  assert.deepEqual(await client.receipt('late-1'), { found: false }, 'an absent receipt is not evidence that the work never ran');

  // A reboot: a new process reads the barrier from disk and still holds.
  const script = `
    const { readRecoveryBarrier, recoveryHold } = await import(${JSON.stringify(fileURLToPath(new URL('../../../server/storage/recovery.ts', import.meta.url)))});
    const read = await readRecoveryBarrier(${JSON.stringify(dir)});
    console.log(JSON.stringify(['core', 'fixture', 'later-domain'].map(scope => recoveryHold(read, scope).held)));`;
  const { stdout } = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: fileURLToPath(new URL('../../../', import.meta.url)) });
  assert.deepEqual(JSON.parse(stdout.trim()), [true, true, true]);

  // Replacing the database again (here: with the preserved original) does not lift the barrier: it lives outside it.
  await client.close();
  await copyFile(join(dir, 'storage-recovery', barrier.source.preservedDir, 'tower.db'), join(dir, 'storage', 'tower.db'));
  assert.equal(recoveryHold(await readRecoveryBarrier(dir), 'fixture').held, true);
  await client.reopen();
  assert.equal((await client.gate('fixture')).open, false);

  // The owner reconciles one scope with evidence, then the rest.
  await assert.rejects(reconcileRecovery(dir, { barrierId: barrier.id, scope: 'fixture', by: 'owner', evidence: ' ' }), { code: 'invalid-command' });
  await assert.rejects(reconcileRecovery(dir, { barrierId: 'other', scope: 'fixture', by: 'owner', evidence: 'x' }), { code: 'recovery-invalid' });
  await reconcileRecovery(dir, { barrierId: barrier.id, scope: 'fixture', by: 'owner', evidence: 'compared once-consumed IDs with the remote ledger' });
  await client.prepare({ allowMigration: false });
  assert.deepEqual(await client.gate('fixture'), { open: true, reasons: [] });
  assert.equal((await client.gate('core')).open, false);
  await reconcileRecovery(dir, { barrierId: barrier.id, scope: '*', by: 'owner', evidence: 'all scopes reviewed' });
  assert.equal((await client.gate('later-domain')).open, true);
  assert.deepEqual(client.status().recovery, { state: 'clear' });
});

test('live files that changed after the barrier was recorded are not moved; the barrier keeps holding; a retry continues', async t => {
  const { dir, build, known, snapshotId } = await historyAfterSnapshot(t);
  const recorded = await recordRecoveryBarrier(dir, { snapshotId, reason: 'test', build, known });
  assert.equal(recorded.state, 'recorded');
  // The worker opening the storage now is refused: activation has not finished.
  const before = await filesUnder(join(dir, 'storage'));
  const blocked = await openFixture(t, dir);
  assert.deepEqual([blocked.status().state, blocked.status().failure?.phase, blocked.status().failure?.code], ['unavailable', 'recovery', 'recovery-in-progress']);
  assert.deepEqual(await filesUnder(join(dir, 'storage')), before);
  assert.equal(recoveryHold(await readRecoveryBarrier(dir), 'core').held, true);

  // Someone writes to the live database between the steps.
  const live = new DatabaseSync(join(dir, 'storage', 'tower.db'));
  live.exec("INSERT INTO fixture_items (key, value) VALUES ('meanwhile', 'x')");
  live.close();
  const changed = await filesUnder(join(dir, 'storage'));
  await assert.rejects(activateRecoveryBarrier(dir, recorded.id), (error: unknown) => error instanceof StorageRecoveryError && error.code === 'source-changed');
  assert.deepEqual(await filesUnder(join(dir, 'storage')), changed, 'nothing moved');
  const still = await readRecoveryBarrier(dir);
  assert.ok(still.state === 'present' && still.barrier.state === 'recorded');

  // Another snapshot cannot start while this one is unfinished; the same one is re-recorded (nothing was moved yet).
  await assert.rejects(recordRecoveryBarrier(dir, { snapshotId: '20000101T000000Z-000000000000', reason: 'x', build }), { code: 'snapshot-invalid' });
  const again = await recordRecoveryBarrier(dir, { snapshotId, reason: 'retry', build, known });
  assert.equal(again.id, recorded.id);
  const activated = await activateRecoveryBarrier(dir, again.id);
  assert.equal(activated.state, 'activated');
  assert.equal((await activateRecoveryBarrier(dir, again.id)).activatedAt, activated.activatedAt, 'activating twice changes nothing');
});

test('a crash between moving the originals and installing the snapshot resumes from the preserved files', async t => {
  const { dir, build, snapshotId, liveSha } = await historyAfterSnapshot(t);
  const recorded = await recordRecoveryBarrier(dir, { snapshotId, reason: 'test', build });
  assert.ok(recorded.scopes.every(scope => scope.retreated), 'without evidence of the live database every scope counts as retreated');
  const preserved = join(dir, 'storage-recovery', recorded.source.preservedDir);
  await mkdir(preserved, { recursive: true, mode: 0o700 });
  for (const file of recorded.source.files) await rename(join(dir, 'storage', file.name), join(preserved, file.name));
  const activated = await activateRecoveryBarrier(dir, recorded.id);
  assert.equal(activated.state, 'activated');
  assert.equal(sha(await readFile(join(preserved, 'tower.db'))), liveSha);
  // Once activated, recording again is a new adoption: a new barrier that names the one it replaces.
  const next = await recordRecoveryBarrier(dir, { snapshotId, reason: 'second adoption', build });
  assert.notEqual(next.id, recorded.id);
  assert.deepEqual(next.previous, [recorded.id]);
  assert.equal(next.state, 'recorded');
});

test('an unreadable barrier holds everything and is left for the owner; a snapshot of another storage is refused', async t => {
  const { dir, build, snapshotId } = await historyAfterSnapshot(t);
  await mkdir(join(dir, 'storage-recovery'), { recursive: true, mode: 0o700 });
  await writeFile(join(dir, 'storage-recovery', 'barrier.json'), '{ not json', { mode: 0o600 });
  const read = await readRecoveryBarrier(dir);
  assert.equal(read.state, 'invalid');
  assert.equal(recoveryHold(read, 'core').held, true);
  const client = await openFixture(t, dir);
  await client.prepare({ allowMigration: false });
  assert.equal(client.status().recovery?.state, 'held');
  assert.equal((await client.gate('fixture')).open, false);
  await client.close();
  await assert.rejects(recordRecoveryBarrier(dir, { snapshotId, reason: 'x', build }), { code: 'recovery-invalid' });
  assert.equal(await readFile(join(dir, 'storage-recovery', 'barrier.json'), 'utf8'), '{ not json');
  // A barrier of an unknown version holds too.
  await writeFile(join(dir, 'storage-recovery', 'barrier.json'), JSON.stringify({ format: 'tower-storage-recovery-barrier', version: 2, state: 'activated', scopes: [], reconciled: [{ scope: '*' }] }));
  assert.equal(recoveryHold(await readRecoveryBarrier(dir), 'core').held, true);

  // A snapshot taken of another storage cannot become this one's database.
  const mine = await historyAfterSnapshot(t);
  const theirs = await historyAfterSnapshot(t);
  await rename(join(theirs.dir, 'storage-snapshots', theirs.snapshotId), join(mine.dir, 'storage-snapshots', theirs.snapshotId));
  await assert.rejects(recordRecoveryBarrier(mine.dir, { snapshotId: theirs.snapshotId, reason: 'x', build: mine.build }), { code: 'snapshot-foreign' });
  assert.equal((await readRecoveryBarrier(mine.dir)).state, 'absent');
});
