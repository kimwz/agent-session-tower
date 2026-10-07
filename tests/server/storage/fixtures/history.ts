import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { TestContext } from 'node:test';
import type { StorageBuildIdentity } from '../../../../server/storage/contract.js';
import { recordRecoveryBarrier, type KnownStorageEvidence, type RecoveryBarrier } from '../../../../server/storage/recovery.js';
import { crashWith, DATABASE, databasePath, openFixture, stateDir } from '../helpers.js';

export const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const hash = (char: string) => char.repeat(64);

export interface History { dir: string; build: StorageBuildIdentity; known: KnownStorageEvidence; snapshotId: string; liveSha: string }
/** Snapshot at generation 1, then more history (generation 2, rows, receipts) the snapshot will not have. Closed. */
export async function historyAfterSnapshot(t: TestContext): Promise<History> {
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
  return { dir, build, known, snapshotId: snapshot.id, liveSha: sha(await readFile(databasePath(dir))) };
}

/** The same history, then a connection that crashed and left a live WAL and shm: the barrier records all three files. */
export async function recordedWithSidecars(t: TestContext): Promise<History & { barrier: RecoveryBarrier }> {
  const history = await historyAfterSnapshot(t);
  await crashWith(databasePath(history.dir), "INSERT INTO fixture_items (key, value) VALUES ('crash', 'x')");
  const barrier = await recordRecoveryBarrier(history.dir, { snapshotId: history.snapshotId, reason: 'sidecars', build: history.build, known: history.known });
  assert.deepEqual(barrier.source.files.map(file => file.name).sort(), [DATABASE, `${DATABASE}-shm`, `${DATABASE}-wal`]);
  return { ...history, barrier };
}
