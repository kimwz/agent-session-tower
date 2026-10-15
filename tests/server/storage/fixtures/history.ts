import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, constants, copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

/** A copy of a closed state directory in a new one, removed after the test: the same files, at new inodes. */
export async function cloneStateDir(t: TestContext, source: string): Promise<string> {
  const dir = await stateDir(t);
  const copy = async (from: string, to: string): Promise<void> => {
    await Promise.all((await readdir(from, { withFileTypes: true })).map(async entry => {
      if (!entry.isDirectory()) return copyFile(join(from, entry.name), join(to, entry.name), constants.COPYFILE_FICLONE);
      await mkdir(join(to, entry.name), { mode: 0o700 });
      await copy(join(from, entry.name), join(to, entry.name));
    }));
  };
  await copy(source, dir);
  return dir;
}

/** A copy of a closed history in a new state directory: the same database, sidecars and snapshot, at new inodes. */
export async function cloneHistory(t: TestContext, history: History): Promise<History> {
  return { ...history, dir: await cloneStateDir(t, history.dir) };
}

/** The history with sidecars, and its barrier recorded: the barrier records all three files. */
export async function recordedWithSidecars(t: TestContext): Promise<History & { barrier: RecoveryBarrier }> {
  const history = await historyWithSidecars(t);
  const barrier = await storage.recordRecoveryBarrier(history.dir, { snapshotId: history.snapshotId, reason: 'sidecars', context: history.context, known: history.known });
  assert.deepEqual(barrier.source.files.map(file => file.name).sort(), [DATABASE, `${DATABASE}-shm`, `${DATABASE}-wal`]);
  return { ...history, barrier };
}

/**
 * storageFs without its fsyncs: the same files, links and modes. For tests of what the storage decides, never of what
 * a disk keeps: each adoption makes dozens of fsyncs, slow on a busy disk.
 */
export const unsyncedStorageFs = {
  createFile: (path: string, data: string | Uint8Array) => writeFile(path, data, { flag: 'wx', mode: 0o600 }),
  copyFile: async (from: string, to: string) => { await copyFile(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE); await chmod(to, 0o600); },
  syncFile: async (_path: string) => {},
  syncDirectory: async (_path: string) => {},
};
/** Runs the rest of the test on `unsyncedStorageFs`. */
export function withoutFsync(t: TestContext): void {
  for (const [op, run] of Object.entries(unsyncedStorageFs)) t.mock.method(storage.storageFs, op as keyof typeof unsyncedStorageFs, run);
}
