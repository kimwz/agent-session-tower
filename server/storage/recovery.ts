import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, open, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { writePrivateJson } from '../stores/private-json.js';
import type { AppliedMigration, DomainAuthority, RecoveryHoldSummary, SnapshotThreadResult, StorageBuildIdentity, StorageErrorCode } from './contract.js';
import { CORE_SCOPE } from './schema.js';
import { privateDirectory, privateFile, sameGeneration, storageLayout, syncDirectory, type FileGeneration, type StorageLayout } from './paths.js';

/**
 * What survives outside the database: the storage's identity, verified snapshots, and the historical-recovery
 * barrier. All of it is owner-only under the state directory, beside storage/ (so replacing the database or its
 * folder leaves it), and none of it is part of the settings backup (server/backup lists its files by name).
 *
 * Adopting a snapshot is not a full recovery. Facts the snapshot predates (consumed once-triggers, receipts,
 * cancellations, revoked permissions) are not in it, so every scope stays held until the owner reconciles it with
 * independent evidence. The barrier is written and synced before the live files move, and it holds every scope it does
 * not list as well, so an unknown or newer domain is held too.
 */

export class StorageRecoveryError extends Error {
  constructor(readonly code: StorageErrorCode, message: string, readonly retryable = false) { super(message); this.name = 'StorageRecoveryError'; }
}

const MAX_JSON_BYTES = 4 * 1024 * 1024;
const ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$/;
const SCOPE = /^(\*|[a-z][a-z0-9-]{0,47})$/;
const newId = () => `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomBytes(6).toString('hex')}`;

/** Reads an owner-only file without following a link or changing it. */
async function readOwnerFile(path: string, maxBytes: number): Promise<Buffer | undefined> {
  if (!(await privateFile(path))) return undefined;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (info.size > maxBytes) throw new StorageRecoveryError('recovery-invalid', `${path} is too large.`);
    return await file.readFile();
  } finally { await file.close(); }
}
async function fileSha256(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
    return hash.digest('hex');
  } finally { await file.close(); }
}
const writeJson = (path: string, value: unknown) => writePrivateJson(path, JSON.stringify(value, null, 2), { syncDirectory: true });

// ---- Storage identity: which database belongs here, so a missing one is not replaced by a new empty one. ----

export interface StorageIdentityRecord { format: 'tower-storage-identity'; version: 1; storageId: string; recordedAt: string }
export type StorageIdentityRead = { state: 'absent' } | { state: 'present'; identity: StorageIdentityRecord } | { state: 'invalid'; reason: string };

export async function readStorageIdentity(layout: StorageLayout): Promise<StorageIdentityRead> {
  try {
    const bytes = await readOwnerFile(join(layout.recoveryDir, 'identity.json'), 64 * 1024);
    if (!bytes) return { state: 'absent' };
    const value = JSON.parse(bytes.toString('utf8')) as StorageIdentityRecord;
    if (value?.format !== 'tower-storage-identity' || value.version !== 1 || typeof value.storageId !== 'string') return { state: 'invalid', reason: 'The storage identity has an unknown format.' };
    return { state: 'present', identity: value };
  } catch (error) { return { state: 'invalid', reason: error instanceof Error ? error.message : String(error) }; }
}
export async function recordStorageIdentity(layout: StorageLayout, storageId: string): Promise<void> {
  await privateDirectory(layout.recoveryDir, true);
  const record: StorageIdentityRecord = { format: 'tower-storage-identity', version: 1, storageId, recordedAt: new Date().toISOString() };
  await writeJson(join(layout.recoveryDir, 'identity.json'), record);
}

// ---- Snapshots ----

export interface SnapshotManifest {
  format: 'tower-storage-snapshot';
  version: 1;
  id: string;
  createdAt: string;
  build: StorageBuildIdentity;
  storageId: string;
  file: { name: 'snapshot.db'; size: number; sha256: string };
  schema: AppliedMigration[];
  ownerEpoch: number;
  authority: DomainAuthority[];
  checks: { quickCheck: string; foreignKeyViolations: number; journalMode: string };
}
export interface SnapshotTarget { id: string; dir: string; target: string }

/** A new private folder for one snapshot. The thread writes `target`; nothing else is there yet. */
export async function snapshotTarget(layout: StorageLayout): Promise<SnapshotTarget> {
  await privateDirectory(layout.snapshotsDir, true);
  const id = newId();
  const dir = join(layout.snapshotsDir, id);
  await mkdir(dir, { mode: 0o700 });
  await privateDirectory(dir, false);
  return { id, dir, target: join(dir, 'snapshot.db') };
}
/** Removes a snapshot folder this worker made and did not finish. */
export async function discardSnapshot(target: SnapshotTarget): Promise<void> {
  await rm(target.dir, { recursive: true, force: true });
}

/** Makes the copy owner-only and durable, then writes its manifest. Answers the manifest. */
export async function sealSnapshot(layout: StorageLayout, target: SnapshotTarget, input: { build: StorageBuildIdentity; storageId: string; result: SnapshotThreadResult }): Promise<SnapshotManifest> {
  const { result } = input;
  if (result.quickCheck !== 'ok' || result.foreignKeyViolations !== 0) throw new StorageRecoveryError('snapshot-invalid', `The snapshot failed its checks (quick_check ${result.quickCheck}, ${result.foreignKeyViolations} foreign key violations).`);
  if (result.schema.kind === 'empty' || result.schema.storageId !== input.storageId) throw new StorageRecoveryError('snapshot-invalid', 'The snapshot does not hold this storage.');
  const file = await open(target.target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid!()) throw new StorageRecoveryError('snapshot-invalid', 'The snapshot file is not the owner\'s regular file.');
    // VACUUM INTO creates the file with SQLite's default mode; the folder is already 0700, the file becomes 0600.
    await file.chmod(0o600);
    await file.sync();
  } finally { await file.close(); }
  const manifest: SnapshotManifest = {
    format: 'tower-storage-snapshot', version: 1, id: target.id, createdAt: new Date().toISOString(), build: input.build, storageId: input.storageId,
    file: { name: 'snapshot.db', size: (await privateFile(target.target))!.size, sha256: await fileSha256(target.target) },
    schema: result.schema.applied, ownerEpoch: result.ownerEpoch, authority: result.authority,
    checks: { quickCheck: result.quickCheck, foreignKeyViolations: result.foreignKeyViolations, journalMode: result.journalMode },
  };
  await writeJson(join(target.dir, 'manifest.json'), manifest);
  await syncDirectory(layout.snapshotsDir);
  return manifest;
}

/** A snapshot whose files are private and whose copy still matches its manifest. */
export async function readSnapshot(stateDir: string, id: string): Promise<SnapshotManifest> {
  if (!ID.test(id)) throw new StorageRecoveryError('snapshot-invalid', 'The snapshot ID is invalid.');
  const layout = await storageLayout(stateDir);
  const dir = join(layout.snapshotsDir, id);
  if (!(await privateDirectory(layout.snapshotsDir, false)) || !(await privateDirectory(dir, false))) throw new StorageRecoveryError('snapshot-invalid', `There is no snapshot ${id}.`);
  const bytes = await readOwnerFile(join(dir, 'manifest.json'), MAX_JSON_BYTES);
  if (!bytes) throw new StorageRecoveryError('snapshot-invalid', `Snapshot ${id} has no manifest.`);
  const manifest = JSON.parse(bytes.toString('utf8')) as SnapshotManifest;
  if (manifest?.format !== 'tower-storage-snapshot' || manifest.version !== 1 || manifest.id !== id || manifest.file?.name !== 'snapshot.db') throw new StorageRecoveryError('snapshot-invalid', `Snapshot ${id} has an unknown manifest.`);
  const copy = join(dir, 'snapshot.db');
  const info = await privateFile(copy);
  if (!info || info.size !== manifest.file.size || await fileSha256(copy) !== manifest.file.sha256) throw new StorageRecoveryError('snapshot-invalid', `Snapshot ${id} no longer matches its manifest.`);
  return manifest;
}

// ---- The historical-recovery barrier ----

export interface KnownStorageEvidence {
  /** Taken from the live database before it failed (inspect()). Absent when it could not be read. */
  schema: { scope: string; version: number }[];
  authority: Pick<DomainAuthority, 'domain' | 'authority' | 'generation'>[];
  ownerEpoch: number;
}
export interface RecoveryScope { scope: string; snapshotGeneration?: number; knownGeneration?: number; retreated: boolean }
export interface RecoveryReconciliation { scope: string; at: string; by: string; evidence: string }
export interface RecoveryBarrier {
  format: 'tower-storage-recovery-barrier';
  version: 1;
  id: string;
  /** recorded: written before any live file moved; activated: the snapshot is the live database. Both hold. */
  state: 'recorded' | 'activated';
  reason: string;
  recordedAt: string;
  activatedAt?: string;
  recordedBy: StorageBuildIdentity;
  snapshot: Pick<SnapshotManifest, 'id' | 'createdAt' | 'build' | 'storageId' | 'ownerEpoch'> & { sha256: string; schema: { scope: string; version: number }[]; authority: Pick<DomainAuthority, 'domain' | 'authority' | 'generation'>[] };
  /** The live files as they were when the barrier was recorded; activation moves exactly these into `preservedDir`. */
  source: { files: { name: 'tower.db' | 'tower.db-wal' | 'tower.db-shm'; generation: FileGeneration; sha256: string }[]; known: KnownStorageEvidence | null; preservedDir: string };
  /** Scopes known to be affected. Scopes not listed are held as well. */
  scopes: RecoveryScope[];
  reconciled: RecoveryReconciliation[];
  /** Earlier barriers this one replaced, newest first. */
  previous: string[];
}
export type RecoveryBarrierRead = { state: 'absent' } | { state: 'present'; barrier: RecoveryBarrier } | { state: 'invalid'; reason: string };

const barrierPath = (layout: StorageLayout) => join(layout.recoveryDir, 'barrier.json');

/** The barrier as saved. An unreadable or unknown barrier is `invalid`, which holds everything. Never changes a file. */
export async function readRecoveryBarrier(stateDir: string | StorageLayout): Promise<RecoveryBarrierRead> {
  try {
    const layout = typeof stateDir === 'string' ? await storageLayout(stateDir) : stateDir;
    if (!(await privateDirectory(layout.recoveryDir, false))) return { state: 'absent' };
    const bytes = await readOwnerFile(barrierPath(layout), MAX_JSON_BYTES);
    if (!bytes) return { state: 'absent' };
    const barrier = JSON.parse(bytes.toString('utf8')) as RecoveryBarrier;
    if (barrier?.format !== 'tower-storage-recovery-barrier' || barrier.version !== 1 || !['recorded', 'activated'].includes(barrier.state) || !Array.isArray(barrier.scopes) || !Array.isArray(barrier.reconciled)) {
      return { state: 'invalid', reason: 'The recovery barrier has an unknown format or version.' };
    }
    return { state: 'present', barrier };
  } catch (error) { return { state: 'invalid', reason: error instanceof Error ? error.message : String(error) }; }
}

/** Whether work of `scope` (`core` or a domain) must stay held. Absence of a barrier is the only clear state. */
export function recoveryHold(read: RecoveryBarrierRead, scope: string): { held: boolean; reason?: string } {
  if (read.state === 'absent') return { held: false };
  if (read.state === 'invalid') return { held: true, reason: `The recovery barrier cannot be read: ${read.reason}` };
  const { barrier } = read;
  if (barrier.state !== 'activated') return { held: true, reason: `Snapshot recovery ${barrier.id} has not finished.` };
  if (barrier.reconciled.some(entry => entry.scope === '*' || entry.scope === scope)) return { held: false };
  return { held: true, reason: `Snapshot recovery ${barrier.id} holds ${scope} until the owner reconciles it.` };
}

export function recoverySummary(read: RecoveryBarrierRead): RecoveryHoldSummary {
  if (read.state === 'absent') return { state: 'clear' };
  if (read.state === 'invalid') return { state: 'held', reason: `The recovery barrier cannot be read: ${read.reason}`, reconciled: [] };
  const { barrier } = read;
  if (barrier.state === 'activated' && barrier.reconciled.some(entry => entry.scope === '*')) return { state: 'clear' };
  return { state: 'held', barrierId: barrier.id, reason: barrier.state === 'activated' ? 'Snapshot recovery waits for the owner to reconcile.' : 'Snapshot recovery has not finished.', reconciled: barrier.reconciled.map(entry => entry.scope) };
}

function affectedScopes(snapshot: SnapshotManifest, known: KnownStorageEvidence | null): RecoveryScope[] {
  const names = new Set([CORE_SCOPE, ...snapshot.schema.map(row => row.scope), ...snapshot.authority.map(row => row.domain), ...(known ? [...known.schema.map(row => row.scope), ...known.authority.map(row => row.domain)] : [])]);
  return [...names].sort().map(scope => {
    const snapshotGeneration = snapshot.authority.find(row => row.domain === scope)?.generation;
    const knownGeneration = known?.authority.find(row => row.domain === scope)?.generation;
    const snapshotVersion = Math.max(0, ...snapshot.schema.filter(row => row.scope === scope).map(row => row.version));
    const knownVersion = Math.max(0, ...(known?.schema.filter(row => row.scope === scope).map(row => row.version) ?? []));
    // Without evidence of the live database, every scope may have moved past the snapshot.
    const retreated = !known || (knownGeneration ?? 0) > (snapshotGeneration ?? 0) || knownVersion > snapshotVersion;
    return { scope, ...(snapshotGeneration !== undefined ? { snapshotGeneration } : {}), ...(knownGeneration !== undefined ? { knownGeneration } : {}), retreated };
  });
}

const LIVE_FILES = [['tower.db', 'database'], ['tower.db-wal', 'wal'], ['tower.db-shm', 'shm']] as const;

/**
 * Step one of adopting a snapshot: verifies it and records (synced) the barrier with the live files' generations.
 * Nothing moves yet. A barrier already recorded for the same snapshot is answered as is, so a failed adoption retries.
 * The storage must be closed under the runtime lock: no thread of this or another worker may hold it.
 */
export async function recordRecoveryBarrier(stateDir: string, input: { snapshotId: string; reason: string; build: StorageBuildIdentity; known?: KnownStorageEvidence }): Promise<RecoveryBarrier> {
  const layout = await storageLayout(stateDir);
  const snapshot = await readSnapshot(stateDir, input.snapshotId);
  const identity = await readStorageIdentity(layout);
  if (identity.state === 'invalid') throw new StorageRecoveryError('recovery-invalid', identity.reason);
  if (identity.state === 'present' && identity.identity.storageId !== snapshot.storageId) throw new StorageRecoveryError('snapshot-foreign', 'The snapshot belongs to another storage.');
  const existing = await readRecoveryBarrier(layout);
  if (existing.state === 'invalid') throw new StorageRecoveryError('recovery-invalid', `The current recovery barrier cannot be read, so it is left for the owner: ${existing.reason}`);
  let id = newId();
  let previous = existing.state === 'present' ? [existing.barrier.id, ...existing.barrier.previous] : [];
  if (existing.state === 'present' && existing.barrier.state === 'recorded') {
    if (existing.barrier.snapshot.id !== snapshot.id) throw new StorageRecoveryError('barrier-in-progress', `Snapshot recovery ${existing.barrier.id} has not finished.`);
    // A retry. Once activation has moved a file the recorded sources are the truth; before that they are re-read,
    // so the owner can retry after the live files changed (the barrier keeps holding meanwhile).
    const preserved = join(layout.recoveryDir, existing.barrier.source.preservedDir);
    for (const [name] of LIVE_FILES) {
      // best-effort: a preserved file that cannot be checked counts as moved, so the recorded sources stay.
      if (await privateFile(join(preserved, name)).catch(() => true)) return existing.barrier;
    }
    ({ id, previous } = existing.barrier);
  }
  await privateDirectory(layout.recoveryDir, true);
  const files: RecoveryBarrier['source']['files'] = [];
  for (const [name, key] of LIVE_FILES) {
    const generation = await privateFile(layout[key]);
    if (generation) files.push({ name, generation, sha256: await fileSha256(layout[key]) });
  }
  const barrier: RecoveryBarrier = {
    format: 'tower-storage-recovery-barrier', version: 1, id, state: 'recorded', reason: input.reason.slice(0, 2000), recordedAt: new Date().toISOString(), recordedBy: input.build,
    snapshot: {
      id: snapshot.id, createdAt: snapshot.createdAt, build: snapshot.build, storageId: snapshot.storageId, ownerEpoch: snapshot.ownerEpoch, sha256: snapshot.file.sha256,
      schema: snapshot.schema.map(({ scope, version }) => ({ scope, version })), authority: snapshot.authority.map(({ domain, authority, generation }) => ({ domain, authority, generation })),
    },
    source: { files, known: input.known ?? null, preservedDir: join(id, 'source') },
    scopes: affectedScopes(snapshot, input.known ?? null),
    reconciled: [],
    previous,
  };
  await writeJson(barrierPath(layout), barrier);
  return barrier;
}

/**
 * Step two: moves the recorded live files aside (only if they are still exactly what was recorded) and installs the
 * snapshot copy as the database, then marks the barrier activated. Every step can be repeated after a crash.
 */
export async function activateRecoveryBarrier(stateDir: string, barrierId: string): Promise<RecoveryBarrier> {
  const layout = await storageLayout(stateDir);
  const read = await readRecoveryBarrier(layout);
  if (read.state !== 'present' || read.barrier.id !== barrierId) throw new StorageRecoveryError('recovery-invalid', `There is no recovery barrier ${barrierId}.`);
  const barrier = read.barrier;
  if (barrier.state === 'activated') return barrier;
  const snapshot = await readSnapshot(stateDir, barrier.snapshot.id);
  if (snapshot.file.sha256 !== barrier.snapshot.sha256) throw new StorageRecoveryError('snapshot-invalid', 'The snapshot changed after the barrier was recorded.');
  const preserved = join(layout.recoveryDir, barrier.source.preservedDir);
  await privateDirectory(join(layout.recoveryDir, barrier.id), true);
  await privateDirectory(preserved, true);
  await privateDirectory(layout.storageDir, true);
  const installed = await privateFile(layout.database);
  const alreadyInstalled = !!installed && !(await privateFile(layout.wal)) && await fileSha256(layout.database) === snapshot.file.sha256
    && barrier.source.files.every(file => file.name !== 'tower.db' || !sameGeneration(file.generation, installed));
  if (!alreadyInstalled) {
    for (const [name, key] of LIVE_FILES) {
      const recorded = barrier.source.files.find(file => file.name === name);
      const live = await privateFile(layout[key]);
      const aside = join(preserved, name);
      if (!recorded) {
        if (live) throw new StorageRecoveryError('source-changed', `${layout[key]} appeared after the barrier was recorded; nothing was moved.`);
        continue;
      }
      if (live) {
        if (!sameGeneration(live, recorded.generation) || await fileSha256(layout[key]) !== recorded.sha256) throw new StorageRecoveryError('source-changed', `${layout[key]} changed after the barrier was recorded; it was left in place.`);
        await rename(layout[key], aside);
      } else if (!(await privateFile(aside)) || await fileSha256(aside) !== recorded.sha256) {
        throw new StorageRecoveryError('source-changed', `${layout[key]} is gone and was not preserved by this recovery.`);
      }
    }
    await syncDirectory(preserved);
    await syncDirectory(layout.storageDir);
    const temporary = `${layout.database}.restore-${barrier.id}`;
    await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    await copyFile(join(layout.snapshotsDir, snapshot.id, 'snapshot.db'), temporary, constants.COPYFILE_EXCL);
    const file = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await file.chmod(0o600); await file.sync(); } finally { await file.close(); }
    if (await fileSha256(temporary) !== snapshot.file.sha256) throw new StorageRecoveryError('snapshot-invalid', 'The installed copy does not match the snapshot.', true);
    if (await privateFile(layout.database)) throw new StorageRecoveryError('source-changed', `${layout.database} appeared while the snapshot was installed.`);
    await rename(temporary, layout.database);
    await syncDirectory(layout.storageDir);
  }
  const activated: RecoveryBarrier = { ...barrier, state: 'activated', activatedAt: new Date().toISOString() };
  await writeJson(barrierPath(layout), activated);
  return activated;
}

/** Records the barrier, then activates it. The result is a held recovery, never a finished one. */
export async function adoptSnapshot(stateDir: string, input: { snapshotId: string; reason: string; build: StorageBuildIdentity; known?: KnownStorageEvidence }): Promise<RecoveryBarrier> {
  const barrier = await recordRecoveryBarrier(stateDir, input);
  return activateRecoveryBarrier(stateDir, barrier.id);
}

/**
 * The owner's reconciliation of one scope (or `*` for all, unlisted ones included) after checking independent
 * evidence. It releases the hold on that scope only; it grants nothing and replays nothing. Owner-only callers.
 */
export async function reconcileRecovery(stateDir: string, input: { barrierId: string; scope: string; by: string; evidence: string }): Promise<RecoveryBarrier> {
  if (!SCOPE.test(input.scope)) throw new StorageRecoveryError('invalid-command', 'The scope is invalid.');
  if (!input.by.trim() || input.by.length > 200 || !input.evidence.trim() || input.evidence.length > 4096) throw new StorageRecoveryError('invalid-command', 'A reconciliation needs who made it and its evidence (at most 4096 characters).');
  const layout = await storageLayout(stateDir);
  const read = await readRecoveryBarrier(layout);
  if (read.state !== 'present' || read.barrier.id !== input.barrierId) throw new StorageRecoveryError('recovery-invalid', `There is no recovery barrier ${input.barrierId}.`);
  if (read.barrier.state !== 'activated') throw new StorageRecoveryError('recovery-in-progress', 'The snapshot is not active yet; finish or retry the adoption first.');
  const reconciled: RecoveryBarrier = { ...read.barrier, reconciled: [...read.barrier.reconciled, { scope: input.scope, at: new Date().toISOString(), by: input.by, evidence: input.evidence }] };
  await writeJson(barrierPath(layout), reconciled);
  return reconciled;
}
