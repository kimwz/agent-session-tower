import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { constants } from 'node:fs';
import { open, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isStorageBuildContext, type StorageBuildContext } from './bundle.js';
import type { AppliedMigration, DomainAuthority, RecoveryHoldSummary, SnapshotThreadResult, StorageBuildIdentity, StorageBuildManifest, StorageErrorCode } from './contract.js';
import { CORE_SCOPE } from './schema.js';
import {
  generationOf, pathError, privateDirectory, privateFile, proveDurable, sameFile, sameGeneration, STORAGE_DATABASE_NAME, STORAGE_FILE_NAMES, storageFs, storageLayout, writePrivateDocument,
  type FileGeneration, type StorageFileName, type StorageLayout,
} from './paths.js';

/**
 * What survives outside the database: the storage's identity, verified snapshots, and the historical-recovery
 * barrier. All of it is owner-only under the state directory, beside the database (so replacing the database leaves
 * it), and none of it is part of the settings backup (server/backup lists its files by name).
 *
 * Adopting a snapshot is not a full recovery. Facts the snapshot predates (consumed once-triggers, receipts,
 * cancellations, revoked permissions) are not in it, so every scope stays held until the owner reconciles it by name
 * with independent evidence. The barrier is written and synced before the live files move. It holds every scope it
 * does not list as well, and a reconciliation names scopes this build supports, never "all", so an unknown or later
 * domain stays held. A barrier this build cannot read whole holds everything, and so does one whose evidence names a
 * scope or schema version beyond this build's own contract.
 *
 * A document that is there is not yet one that survives a crash: a publication whose rename landed and whose folder
 * sync failed is visible. Nothing relies on an identity or barrier (no claim, no move, no open, no released gate)
 * until its file and every folder link above it are proven durable again (proveDurable).
 *
 * Every step that writes here (record, activate, reconcile, an open that names the storage) runs under the worker's
 * runtime lock, the one writer of the state directory; nothing here takes a lock of its own.
 */

export class StorageRecoveryError extends Error {
  constructor(readonly code: StorageErrorCode, message: string, readonly retryable = false) { super(message); this.name = 'StorageRecoveryError'; }
}

const MAX_JSON_BYTES = 4 * 1024 * 1024;
const ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$/;
const SCOPE = /^[a-z][a-z0-9-]{0,47}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const STORAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const newId = () => `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomBytes(6).toString('hex')}`;

/** Reads an owner-only file without following a link or changing it, with the generation it was read at. */
async function readOwnerFile(path: string, maxBytes: number): Promise<{ bytes: Buffer; generation: FileGeneration } | undefined> {
  if (!(await privateFile(path))) return undefined;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (info.size > maxBytes) throw new StorageRecoveryError('recovery-invalid', `${path} is too large.`);
    return { bytes: await file.readFile(), generation: generationOf(info) };
  } finally { await file.close(); }
}
export async function fileSha256(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
    return hash.digest('hex');
  } finally { await file.close(); }
}
const writeJson = (path: string, value: unknown) => writePrivateDocument(path, JSON.stringify(value, null, 2));

// ---- Shape checks: a stored document is used only when every field is what this build writes. ----

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
/** Exactly these keys: an unknown field means another format, which this build does not interpret. */
const hasKeys = (value: unknown, required: string[], optional: string[] = []): value is Json =>
  isObject(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const isTime = (value: unknown) => typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
const isCount = (value: unknown, minimum = 0) => Number.isSafeInteger(value) && (value as number) >= minimum;
const isText = (value: unknown, maximum: number) => typeof value === 'string' && !!value.trim() && value.length <= maximum;
const isBuild = (value: unknown) => hasKeys(value, ['appVersion', 'protocol', 'sourceHash', 'manifestDigest'])
  && isText(value.appVersion, 64) && isText(value.protocol, 64) && SHA256.test(String(value.sourceHash)) && SHA256.test(String(value.manifestDigest));
const isGeneration = (value: unknown) => hasKeys(value, ['dev', 'ino', 'size', 'mtimeMs'])
  && isCount(value.dev) && isCount(value.ino) && isCount(value.size) && typeof value.mtimeMs === 'number' && Number.isFinite(value.mtimeMs) && value.mtimeMs >= 0;
const isSchemaRow = (value: unknown) => hasKeys(value, ['scope', 'version']) && SCOPE.test(String(value.scope)) && isCount(value.version, 1);
const isAuthorityRow = (value: unknown) => hasKeys(value, ['domain', 'authority', 'generation'])
  && SCOPE.test(String(value.domain)) && (value.authority === 'database' || value.authority === 'legacy-exported') && isCount(value.generation, 1);
const allOf = (value: unknown, check: (item: unknown) => boolean) => Array.isArray(value) && value.every(check);
const distinct = (values: unknown[]) => new Set(values).size === values.length;

// ---- Storage identity: which database belongs here, so a missing one is not replaced by a new empty one. ----

/**
 * `creating`: written before the first prepare that creates the storage in an empty file, so a storage that may have
 * been created is known even if that prepare's answer was lost. `created`: written once the creation committed; only
 * then may the worker publish its claim (see StorageClient.prepare).
 */
export interface StorageIdentityRecord { format: 'tower-storage-identity'; version: 1; storageId: string; state: 'creating' | 'created'; recordedAt: string }
export type StorageIdentityRead = { state: 'absent' } | { state: 'present'; identity: StorageIdentityRecord } | { state: 'invalid'; reason: string };

const identityPath = (layout: StorageLayout) => join(layout.recoveryDir, 'identity.json');

export async function readStorageIdentity(layout: StorageLayout): Promise<StorageIdentityRead> {
  try {
    if (!(await privateDirectory(layout.recoveryDir, false))) return { state: 'absent' };
    const read = await readOwnerFile(identityPath(layout), 64 * 1024);
    if (!read) return { state: 'absent' };
    const value: unknown = JSON.parse(read.bytes.toString('utf8'));
    if (!hasKeys(value, ['format', 'version', 'storageId', 'state', 'recordedAt']) || value.format !== 'tower-storage-identity' || value.version !== 1
      || !STORAGE_ID.test(String(value.storageId)) || (value.state !== 'creating' && value.state !== 'created') || !isTime(value.recordedAt)) {
      return { state: 'invalid', reason: 'The storage identity has an unknown format.' };
    }
    return { state: 'present', identity: value as unknown as StorageIdentityRecord };
  } catch (error) { return { state: 'invalid', reason: error instanceof Error ? error.message : String(error) }; }
}
/** Records the identity, synced with its folder and the folder with the state directory. Throws a StoragePathError. */
export async function recordStorageIdentity(layout: StorageLayout, storageId: string, state: StorageIdentityRecord['state']): Promise<void> {
  if (!STORAGE_ID.test(storageId)) throw new StorageRecoveryError('invalid-command', 'The storage ID is invalid.');
  await privateDirectory(layout.recoveryDir, true);
  const record: StorageIdentityRecord = { format: 'tower-storage-identity', version: 1, storageId, state, recordedAt: new Date().toISOString() };
  await writeJson(identityPath(layout), record);
}
/**
 * Proves the identity found beside the database durable before anything relies on it (a creation resumed, a claim):
 * the identity file, the recovery folder, and the state directory, which also holds the database's own link. An
 * earlier record that failed after its rename left a visible identity that may not survive a crash. Throws a StoragePathError.
 */
export async function proveStorageIdentity(layout: StorageLayout): Promise<void> {
  await proveDurable([identityPath(layout), layout.recoveryDir, layout.stateDir]);
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

/** A new private folder for one snapshot, its name synced. The thread writes `target`; nothing else is there yet. */
export async function snapshotTarget(layout: StorageLayout): Promise<SnapshotTarget> {
  await privateDirectory(layout.snapshotsDir, true);
  const id = newId();
  const dir = join(layout.snapshotsDir, id);
  await privateDirectory(dir, true);
  return { id, dir, target: join(dir, 'snapshot.db') };
}
/** Removes a snapshot folder this worker made and did not finish. */
export async function discardSnapshot(target: SnapshotTarget): Promise<void> {
  await rm(target.dir, { recursive: true, force: true });
}

/** Makes the copy owner-only and durable, then writes its manifest (synced with the folder). Answers the manifest. */
export async function sealSnapshot(target: SnapshotTarget, input: { build: StorageBuildIdentity; storageId: string; result: SnapshotThreadResult }): Promise<SnapshotManifest> {
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
  return manifest;
}

/** A snapshot whose files are private and whose copy still matches its manifest. */
export async function readSnapshot(stateDir: string, id: string): Promise<SnapshotManifest> {
  if (!ID.test(id)) throw new StorageRecoveryError('snapshot-invalid', 'The snapshot ID is invalid.');
  const layout = await storageLayout(stateDir);
  const dir = join(layout.snapshotsDir, id);
  if (!(await privateDirectory(layout.snapshotsDir, false)) || !(await privateDirectory(dir, false))) throw new StorageRecoveryError('snapshot-invalid', `There is no snapshot ${id}.`);
  const read = await readOwnerFile(join(dir, 'manifest.json'), MAX_JSON_BYTES);
  if (!read) throw new StorageRecoveryError('snapshot-invalid', `Snapshot ${id} has no manifest.`);
  const manifest = JSON.parse(read.bytes.toString('utf8')) as SnapshotManifest;
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
/** The owner's release of one named scope, with the evidence and the build (manifest digest) that judged it supported. */
export interface RecoveryReconciliation { scope: string; at: string; by: string; evidence: string; manifestDigest: string }
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
  /** The live files as they were when the barrier was recorded; activation moves exactly these into `preservedDir` (`<id>/source`). */
  source: { files: { name: StorageFileName; generation: FileGeneration; sha256: string }[]; known: KnownStorageEvidence | null; preservedDir: string };
  /** Scopes known to be affected, derived from the snapshot and the known evidence. Scopes not listed are held as well. */
  scopes: RecoveryScope[];
  reconciled: RecoveryReconciliation[];
  /** Earlier barriers this one replaced, newest first. */
  previous: string[];
}
/** `file`: the generation barrier.json was read at, so a proof is known to cover the document that was read. */
export type RecoveryBarrierRead = { state: 'absent' } | { state: 'present'; barrier: RecoveryBarrier; file: FileGeneration } | { state: 'invalid'; reason: string };
type PresentBarrier = Extract<RecoveryBarrierRead, { state: 'present' }>;

const barrierPath = (layout: StorageLayout) => join(layout.recoveryDir, 'barrier.json');

function affectedScopes(snapshot: Pick<RecoveryBarrier['snapshot'], 'schema' | 'authority'>, known: KnownStorageEvidence | null): RecoveryScope[] {
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

/** Why `value` is not a whole barrier as this build writes it, or undefined when it is one. */
function barrierProblem(value: unknown): string | undefined {
  if (!hasKeys(value, ['format', 'version', 'id', 'state', 'reason', 'recordedAt', 'recordedBy', 'snapshot', 'source', 'scopes', 'reconciled', 'previous'], ['activatedAt'])) return 'it has missing or unknown fields';
  if (value.format !== 'tower-storage-recovery-barrier' || value.version !== 1) return 'it has an unknown format or version';
  if (!ID.test(String(value.id))) return 'its ID is invalid';
  if (value.state !== 'recorded' && value.state !== 'activated') return 'its state is unknown';
  if (typeof value.reason !== 'string' || value.reason.length > 2000 || !isTime(value.recordedAt)) return 'its reason or time is invalid';
  if ((value.state === 'activated') !== isTime(value.activatedAt) || (value.state === 'recorded' && value.activatedAt !== undefined)) return 'its activation time does not match its state';
  if (!isBuild(value.recordedBy)) return 'the build that recorded it is invalid';
  const { snapshot, source } = value;
  if (!hasKeys(snapshot, ['id', 'createdAt', 'build', 'storageId', 'ownerEpoch', 'sha256', 'schema', 'authority'])
    || !ID.test(String(snapshot.id)) || !isTime(snapshot.createdAt) || !isBuild(snapshot.build) || !STORAGE_ID.test(String(snapshot.storageId))
    || !isCount(snapshot.ownerEpoch) || !SHA256.test(String(snapshot.sha256)) || !allOf(snapshot.schema, isSchemaRow) || !allOf(snapshot.authority, isAuthorityRow)) return 'its snapshot is invalid';
  if (!hasKeys(source, ['files', 'known', 'preservedDir'])) return 'its source is invalid';
  const files = source.files;
  if (!allOf(files, file => hasKeys(file, ['name', 'generation', 'sha256']) && (STORAGE_FILE_NAMES as readonly unknown[]).includes(file.name) && isGeneration(file.generation) && SHA256.test(String(file.sha256)))
    || !distinct((files as Json[]).map(file => file.name))) return 'its source files are invalid';
  const known = source.known;
  if (known !== null && !(hasKeys(known, ['schema', 'authority', 'ownerEpoch']) && allOf(known.schema, isSchemaRow) && allOf(known.authority, isAuthorityRow) && isCount(known.ownerEpoch))) return 'its known evidence is invalid';
  if (source.preservedDir !== `${value.id}/source`) return 'its preserved folder is not its own';
  if (!isDeepStrictEqual(value.scopes, affectedScopes(snapshot as unknown as RecoveryBarrier['snapshot'], known as KnownStorageEvidence | null))) return 'its scopes do not follow from its snapshot and evidence';
  if (!allOf(value.reconciled, entry => hasKeys(entry, ['scope', 'at', 'by', 'evidence', 'manifestDigest'])
    && SCOPE.test(String(entry.scope)) && isTime(entry.at) && isText(entry.by, 200) && isText(entry.evidence, 4096) && SHA256.test(String(entry.manifestDigest)))) return 'a reconciliation is invalid';
  if (value.state === 'recorded' && (value.reconciled as unknown[]).length) return 'it was reconciled before it was activated';
  if (!allOf(value.previous, id => ID.test(String(id)) && id !== value.id) || !distinct(value.previous as unknown[])) return 'its earlier barriers are invalid';
  return undefined;
}

/** The barrier as saved. Anything but a whole barrier as this build writes it is `invalid`, which holds everything. Never changes a file. */
export async function readRecoveryBarrier(stateDir: string | StorageLayout): Promise<RecoveryBarrierRead> {
  try {
    const layout = typeof stateDir === 'string' ? await storageLayout(stateDir) : stateDir;
    if (!(await privateDirectory(layout.recoveryDir, false))) return { state: 'absent' };
    const read = await readOwnerFile(barrierPath(layout), MAX_JSON_BYTES);
    if (!read) return { state: 'absent' };
    const value: unknown = JSON.parse(read.bytes.toString('utf8'));
    const problem = barrierProblem(value);
    if (problem) return { state: 'invalid', reason: `The recovery barrier cannot be used: ${problem}.` };
    return { state: 'present', barrier: value as RecoveryBarrier, file: read.generation };
  } catch (error) { return { state: 'invalid', reason: error instanceof Error ? error.message : String(error) }; }
}

/**
 * Proves a barrier read from disk durable before anything relies on it: syncs, deepest first, its preserved folder
 * and its own folder (when they exist), barrier.json, the recovery folder and the state directory. Deepest first, an
 * original an interrupted activation already moved is durable in its new folder before the state directory forgets
 * its old link. Throws when a sync fails (nothing counts the barrier then) or when the file is no longer the one read.
 */
export async function proveRecoveryBarrier(layout: StorageLayout, read: PresentBarrier): Promise<void> {
  const own = join(layout.recoveryDir, read.barrier.id);
  const preserved = join(layout.recoveryDir, read.barrier.source.preservedDir);
  const chain: string[] = [];
  if (await privateDirectory(preserved, false)) chain.push(preserved);
  if (await privateDirectory(own, false)) chain.push(own);
  await proveDurable([...chain, barrierPath(layout), layout.recoveryDir, layout.stateDir]);
  const now = await privateFile(barrierPath(layout));
  if (!now || !sameGeneration(now, read.file)) throw new StorageRecoveryError('recovery-in-progress', 'The recovery barrier changed while it was checked; read it again.', true);
}

/** The scopes a build supports: core and its domains, each with the schema version it knows. */
const supportedVersions = (manifest: StorageBuildManifest) => new Map<string, number>([[manifest.core.scope, manifest.core.schemaVersion], ...manifest.domains.map(domain => [domain.scope, domain.schemaVersion] as const)]);

/**
 * What of a barrier's evidence `manifest` does not cover: a scope it does not support or a schema version above its
 * own, in the snapshot's or the known live database's schema and authority rows and the scopes derived from them.
 * Such a barrier may record facts this build cannot judge, so it holds every scope here, reconciled ones included.
 * Builds are not compared: an older or newer build that covers all of it judges it as well. A reconciliation naming a
 * scope this build does not support is not evidence; it is ignored, never a reason to hold.
 */
function beyondBuild(barrier: RecoveryBarrier, manifest: StorageBuildManifest): string[] {
  const versions = supportedVersions(manifest);
  const beyond = new Set<string>();
  const { known } = barrier.source;
  for (const row of [...barrier.snapshot.schema, ...(known?.schema ?? [])]) {
    const version = versions.get(row.scope);
    if (version === undefined) beyond.add(row.scope);
    else if (row.version > version) beyond.add(`${row.scope} schema ${row.version}`);
  }
  for (const row of [...barrier.snapshot.authority, ...(known?.authority ?? [])]) if (!versions.has(row.domain)) beyond.add(row.domain);
  for (const entry of barrier.scopes) if (!versions.has(entry.scope)) beyond.add(entry.scope);
  return [...beyond].sort();
}

const untrustedContext = 'A recovery barrier is judged only against a storage contract this build trusts (storageBuildContext).';

/**
 * Whether work of `scope` (`core` or a domain) must stay held, judged by this build's trusted contract. Absence of a
 * barrier is the only state without holds. This reads the content only: StorageClient.gate also proves the barrier
 * durable before it opens.
 */
export function recoveryHold(read: RecoveryBarrierRead, scope: string, context: StorageBuildContext | undefined): { held: boolean; reason?: string } {
  if (read.state === 'absent') return { held: false };
  if (read.state === 'invalid') return { held: true, reason: read.reason };
  if (!isStorageBuildContext(context)) return { held: true, reason: untrustedContext };
  const { barrier } = read;
  const beyond = beyondBuild(barrier, context.manifest);
  if (beyond.length) return { held: true, reason: `Snapshot recovery ${barrier.id} holds every scope: this build does not understand its evidence of ${beyond.join(', ')}.` };
  if (barrier.state !== 'activated') return { held: true, reason: `Snapshot recovery ${barrier.id} has not finished.` };
  if (supportedVersions(context.manifest).has(scope) && barrier.reconciled.some(entry => entry.scope === scope)) return { held: false };
  return { held: true, reason: `Snapshot recovery ${barrier.id} holds ${scope} until the owner reconciles it by name.` };
}

/** `reconciled` lists the releases that take effect in this build; `unreconciled` the barrier's own scopes still held. */
export function recoverySummary(read: RecoveryBarrierRead, context: StorageBuildContext | undefined): RecoveryHoldSummary {
  if (read.state === 'absent') return { state: 'clear' };
  if (read.state === 'invalid') return { state: 'held', reason: read.reason, reconciled: [], unreconciled: [] };
  const { barrier } = read;
  const all = barrier.scopes.map(entry => entry.scope);
  if (!isStorageBuildContext(context)) return { state: 'held', barrierId: barrier.id, reason: untrustedContext, reconciled: [], unreconciled: all };
  const beyond = beyondBuild(barrier, context.manifest);
  if (beyond.length) return { state: 'held', barrierId: barrier.id, reason: `Snapshot recovery holds every scope: this build does not understand its evidence of ${beyond.join(', ')}; reconciliations do not apply.`, reconciled: [], unreconciled: all };
  const supported = supportedVersions(context.manifest);
  const reconciled = [...new Set(barrier.reconciled.map(entry => entry.scope).filter(scope => supported.has(scope)))].sort();
  const unreconciled = all.filter(scope => !reconciled.includes(scope));
  const reason = barrier.state !== 'activated' ? 'Snapshot recovery has not finished.'
    : `Snapshot recovery holds every scope not reconciled by name${unreconciled.length ? `, including ${unreconciled.join(', ')}` : ''}.`;
  return { state: 'held', barrierId: barrier.id, reason, reconciled, unreconciled };
}

/** What an owner's recovery step is asked, and the trusted build it runs as. */
export interface RecoveryInput { snapshotId: string; reason: string; context: StorageBuildContext; known?: KnownStorageEvidence }
const requireContext = (context: StorageBuildContext) => {
  if (!isStorageBuildContext(context)) throw new StorageRecoveryError('bundle-untrusted', untrustedContext);
};

/**
 * Step one of adopting a snapshot: verifies it and records (synced) the barrier with the live files' generations,
 * recorded by the trusted build `context`. Nothing moves yet. A barrier already recorded for the same snapshot is
 * answered as is once proven durable, so a failed adoption retries. The storage must be closed under the runtime lock:
 * no thread of this or another worker may hold it.
 */
export async function recordRecoveryBarrier(stateDir: string, input: RecoveryInput): Promise<RecoveryBarrier> {
  requireContext(input.context);
  const layout = await storageLayout(stateDir);
  const snapshot = await readSnapshot(stateDir, input.snapshotId);
  const identity = await readStorageIdentity(layout);
  if (identity.state === 'invalid') throw new StorageRecoveryError('recovery-invalid', identity.reason);
  if (identity.state === 'present' && identity.identity.storageId !== snapshot.storageId) throw new StorageRecoveryError('snapshot-foreign', 'The snapshot belongs to another storage.');
  const existing = await readRecoveryBarrier(layout);
  if (existing.state === 'invalid') throw new StorageRecoveryError('recovery-invalid', `The current recovery barrier is left for the owner: ${existing.reason}`);
  let id = newId();
  let previous = existing.state === 'present' ? [existing.barrier.id, ...existing.barrier.previous] : [];
  if (existing.state === 'present' && existing.barrier.state === 'recorded') {
    if (existing.barrier.snapshot.id !== snapshot.id) throw new StorageRecoveryError('barrier-in-progress', `Snapshot recovery ${existing.barrier.id} has not finished.`);
    // A retry. Once activation has moved a file the recorded sources are the truth; before that they are re-read,
    // so the owner can retry after the live files changed (the barrier keeps holding meanwhile).
    const preserved = join(layout.recoveryDir, existing.barrier.source.preservedDir);
    for (const name of STORAGE_FILE_NAMES) {
      // best-effort: a preserved file that cannot be checked counts as moved, so the recorded sources stay.
      if (await privateFile(join(preserved, name)).catch(() => true)) {
        await proveRecoveryBarrier(layout, existing);
        return existing.barrier;
      }
    }
    ({ id, previous } = existing.barrier);
  }
  await privateDirectory(layout.recoveryDir, true);
  const files: RecoveryBarrier['source']['files'] = [];
  for (const name of STORAGE_FILE_NAMES) {
    const path = join(layout.stateDir, name);
    const generation = await privateFile(path);
    if (generation) files.push({ name, generation, sha256: await fileSha256(path) });
  }
  const snapshotFacts = {
    id: snapshot.id, createdAt: snapshot.createdAt, build: snapshot.build, storageId: snapshot.storageId, ownerEpoch: snapshot.ownerEpoch, sha256: snapshot.file.sha256,
    schema: snapshot.schema.map(({ scope, version }) => ({ scope, version })), authority: snapshot.authority.map(({ domain, authority, generation }) => ({ domain, authority, generation })),
  };
  const known = input.known ? {
    schema: input.known.schema.map(({ scope, version }) => ({ scope, version })),
    authority: input.known.authority.map(({ domain, authority, generation }) => ({ domain, authority, generation })),
    ownerEpoch: input.known.ownerEpoch,
  } : null;
  const barrier: RecoveryBarrier = {
    format: 'tower-storage-recovery-barrier', version: 1, id, state: 'recorded', reason: input.reason.slice(0, 2000), recordedAt: new Date().toISOString(), recordedBy: { ...input.context.identity },
    snapshot: snapshotFacts,
    source: { files, known, preservedDir: `${id}/source` },
    scopes: affectedScopes(snapshotFacts, known),
    reconciled: [],
    previous,
  };
  const problem = barrierProblem(barrier);
  if (problem) throw new StorageRecoveryError('recovery-invalid', `The recovery barrier would not be readable: ${problem}.`);
  await writeJson(barrierPath(layout), barrier);
  return barrier;
}

/** Moves a file into a folder already linked durably, then syncs the folder it went to and the folder it left, in that order. */
async function moveDurably(from: string, fromDir: string, to: string, toDir: string): Promise<void> {
  try {
    await storageFs.rename(from, to);
    await storageFs.syncDirectory(toDir);
    await storageFs.syncDirectory(fromDir);
  } catch (error) { throw pathError(error, from); }
}

/**
 * Step two: moves the recorded live files aside (only if they are still exactly what was recorded) and installs the
 * snapshot copy as the database, then marks the barrier activated. Every step can be repeated after a crash: each
 * recorded file is found either live as recorded or preserved as recorded (generation and sha256), and a database
 * already in place counts as installed only when every original is preserved, it is the snapshot, and no sidecar is
 * live. Nothing is taken as durable for being there: before the first move of every attempt the recorded barrier and
 * whatever an earlier attempt linked (an original it moved, the database it installed) are proven durable, deepest
 * first; each folder is synced into its parent before anything moves into it; each move and the install sync as they
 * go. So the barrier says activated only over durable links, and an activated barrier is answered only once it is
 * proven durable itself.
 */
export async function activateRecoveryBarrier(stateDir: string, barrierId: string): Promise<RecoveryBarrier> {
  const layout = await storageLayout(stateDir);
  const read = await readRecoveryBarrier(layout);
  if (read.state === 'invalid') throw new StorageRecoveryError('recovery-invalid', read.reason);
  if (read.state !== 'present' || read.barrier.id !== barrierId) throw new StorageRecoveryError('recovery-invalid', `There is no recovery barrier ${barrierId}.`);
  const barrier = read.barrier;
  if (barrier.state === 'activated') {
    await proveRecoveryBarrier(layout, read);
    return barrier;
  }
  const snapshot = await readSnapshot(stateDir, barrier.snapshot.id);
  if (snapshot.file.sha256 !== barrier.snapshot.sha256) throw new StorageRecoveryError('snapshot-invalid', 'The snapshot changed after the barrier was recorded.');
  const preserved = join(layout.recoveryDir, barrier.source.preservedDir);
  const changed = (message: string) => new StorageRecoveryError('source-changed', message);

  // Every file is accounted for before anything is made or moved.
  const moves: { livePath: string; aside: string; generation: FileGeneration }[] = [];
  let databaseInPlace = false;
  for (const name of STORAGE_FILE_NAMES) {
    const recorded = barrier.source.files.find(file => file.name === name);
    const livePath = join(layout.stateDir, name);
    const aside = join(preserved, name);
    const live = await privateFile(livePath);
    const kept = await privateFile(aside);
    if (!recorded) {
      if (kept) throw changed(`${aside} was not recorded by this recovery.`);
      if (live && name !== STORAGE_DATABASE_NAME) throw changed(`${livePath} appeared after the barrier was recorded; nothing was moved.`);
      databaseInPlace ||= !!live;
      continue;
    }
    if (kept) {
      if (!sameGeneration(kept, recorded.generation) || await fileSha256(aside) !== recorded.sha256) throw changed(`The preserved ${name} is no longer the file this recovery recorded.`);
      // The live database may already be the installed snapshot (checked below); a live sidecar is new.
      if (live && name !== STORAGE_DATABASE_NAME) throw changed(`${livePath} appeared after the original was preserved.`);
      databaseInPlace ||= !!live;
      continue;
    }
    if (!live) throw changed(`${livePath} is gone and was not preserved by this recovery.`);
    if (!sameGeneration(live, recorded.generation) || await fileSha256(livePath) !== recorded.sha256) throw changed(`${livePath} changed after the barrier was recorded; nothing was moved.`);
    moves.push({ livePath, aside, generation: recorded.generation });
  }
  // A database left in place by an earlier attempt counts as installed only as the snapshot, never as the original.
  const original = barrier.source.files.find(file => file.name === STORAGE_DATABASE_NAME);
  const inPlace = async () => {
    const installed = await privateFile(layout.database);
    if (installed && ((original && sameFile(installed, original.generation)) || await fileSha256(layout.database) !== snapshot.file.sha256)) throw changed(`${layout.database} is not the snapshot this recovery installs.`);
    return !!installed;
  };
  if (databaseInPlace) await inPlace();

  await proveRecoveryBarrier(layout, read);
  const own = join(layout.recoveryDir, barrier.id);
  await privateDirectory(own, true);
  await privateDirectory(preserved, true);
  for (const move of moves) {
    const live = await privateFile(move.livePath);
    if (!live || !sameGeneration(live, move.generation)) throw changed(`${move.livePath} changed while the recovery ran.`);
    await moveDurably(move.livePath, layout.stateDir, move.aside, preserved);
  }

  if (await privateFile(layout.wal) || await privateFile(layout.shm)) throw changed('A database sidecar is live while the snapshot is installed; nothing was installed.');
  if (!(await inPlace())) {
    const temporary = `${layout.database}.restore-${barrier.id}`;
    await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    try { await storageFs.copyFile(join(layout.snapshotsDir, snapshot.id, 'snapshot.db'), temporary); } catch (error) { throw pathError(error, temporary); }
    if (await fileSha256(temporary) !== snapshot.file.sha256) throw new StorageRecoveryError('snapshot-invalid', 'The installed copy does not match the snapshot.', true);
    if (await privateFile(layout.database)) throw changed(`${layout.database} appeared while the snapshot was installed.`);
    try {
      await storageFs.rename(temporary, layout.database);
      await storageFs.syncDirectory(layout.stateDir);
    } catch (error) { throw pathError(error, layout.database); }
  }
  const activated: RecoveryBarrier = { ...barrier, state: 'activated', activatedAt: new Date().toISOString() };
  await writeJson(barrierPath(layout), activated);
  return activated;
}

/** Records the barrier, then activates it. The result is a held recovery, never a finished one. */
export async function adoptSnapshot(stateDir: string, input: RecoveryInput): Promise<RecoveryBarrier> {
  const barrier = await recordRecoveryBarrier(stateDir, input);
  return activateRecoveryBarrier(stateDir, barrier.id);
}

/**
 * The owner's reconciliation of the named scopes after checking independent evidence, made by the trusted build
 * `context`. Each scope must be one that build supports (`core` or one of its domains); there is no "all", so a scope
 * it does not know, or a later domain, stays held until a build that supports it reconciles it by name. A barrier
 * whose evidence that build does not understand is refused whole, and nothing is written. It releases the hold on the
 * named scopes only; it grants nothing and replays nothing. Owner-only callers, under the runtime lock.
 */
export async function reconcileRecovery(stateDir: string, input: { barrierId: string; scopes: string[]; by: string; evidence: string; context: StorageBuildContext }): Promise<RecoveryBarrier> {
  requireContext(input.context);
  if (!input.scopes.length || !distinct(input.scopes) || !input.scopes.every(scope => SCOPE.test(scope))) throw new StorageRecoveryError('invalid-command', 'Name each scope to reconcile once; there is no "all".');
  if (!isText(input.by, 200) || !isText(input.evidence, 4096)) throw new StorageRecoveryError('invalid-command', 'A reconciliation needs who made it and its evidence (at most 4096 characters).');
  const { manifest } = input.context;
  const supported = supportedVersions(manifest);
  const unknown = input.scopes.filter(scope => !supported.has(scope));
  if (unknown.length) throw new StorageRecoveryError('unknown-scope', `This build does not support ${unknown.join(', ')}; such a scope stays held.`);
  const layout = await storageLayout(stateDir);
  const read = await readRecoveryBarrier(layout);
  if (read.state === 'invalid') throw new StorageRecoveryError('recovery-invalid', read.reason);
  if (read.state !== 'present' || read.barrier.id !== input.barrierId) throw new StorageRecoveryError('recovery-invalid', `There is no recovery barrier ${input.barrierId}.`);
  if (read.barrier.state !== 'activated') throw new StorageRecoveryError('recovery-in-progress', 'The snapshot is not active yet; finish or retry the adoption first.');
  const beyond = beyondBuild(read.barrier, manifest);
  if (beyond.length) throw new StorageRecoveryError('unknown-scope', `This build does not understand the barrier's evidence of ${beyond.join(', ')}; nothing is reconciled until a build that does reconciles it.`);
  const at = new Date().toISOString();
  const entries = input.scopes.map(scope => ({ scope, at, by: input.by, evidence: input.evidence, manifestDigest: manifest.digest }));
  const reconciled: RecoveryBarrier = { ...read.barrier, reconciled: [...read.barrier.reconciled, ...entries] };
  // The recovery folder's own link, synced into the state directory, then the document with its folder.
  await privateDirectory(layout.recoveryDir, true);
  await writeJson(barrierPath(layout), reconciled);
  return reconciled;
}
