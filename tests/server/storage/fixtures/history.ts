import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { TestContext } from 'node:test';
import type { StorageBuildContext } from '../../../../server/storage/bundle.js';
import type { KnownStorageEvidence, RecoveryBarrier } from '../../../../server/storage/recovery.js';
import { contextOf, crashWith, DATABASE, databasePath, openFixture, stateDir, storage } from '../helpers.js';

export const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const hash = (char: string) => char.repeat(64);

/** `context`: the trusted fixture build that runs the owner's recovery steps. */
export interface History { dir: string; context: StorageBuildContext; known: KnownStorageEvidence; snapshotId: string; liveSha: string }
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
  await client.close();
  return { dir, context: contextOf('fixture'), known, snapshotId: snapshot.id, liveSha: sha(await readFile(databasePath(dir))) };
}

/** The same history, then a connection that crashed and left a live WAL and shm. Nothing recorded yet. */
export async function historyWithSidecars(t: TestContext): Promise<History> {
  const history = await historyAfterSnapshot(t);
  await crashWith(databasePath(history.dir), "INSERT INTO fixture_items (key, value) VALUES ('crash', 'x')");
  return history;
}

/** The history with sidecars, and its barrier recorded: the barrier records all three files. */
export async function recordedWithSidecars(t: TestContext): Promise<History & { barrier: RecoveryBarrier }> {
  const history = await historyWithSidecars(t);
  const barrier = await storage.recordRecoveryBarrier(history.dir, { snapshotId: history.snapshotId, reason: 'sidecars', context: history.context, known: history.known });
  assert.deepEqual(barrier.source.files.map(file => file.name).sort(), [DATABASE, `${DATABASE}-shm`, `${DATABASE}-wal`]);
  return { ...history, barrier };
}
