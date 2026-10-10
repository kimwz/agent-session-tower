import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { validateStrictStateLease, type StrictStateLease } from '../instance/state-lock.js';
import { readStorageIdentity } from '../storage/recovery.js';
import { StorageClient } from '../storage/client.js';
import type { StorageBuildIdentity, StorageBuildManifest } from '../storage/contract.js';
import { manifestDigest } from '../storage/schema.js';
import { privateDirectory, storageLayout, writePrivateDocument } from '../storage/paths.js';
import { evaluateStorageUpdate, parseArtifactStorageContract, recordPreparationEvidence, type StorageUpdateInput, type StorageUpdateEvaluation } from './storage-update.js';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const refuse = (reason: string): never => { throw new Error(`Offline activation held: ${reason}`); };
export const offlineActivationPath = (stateDir: string) => join(stateDir, 'storage-offline-activation.json');

/** I supplies a sealed, consistent full inventory; C verifies the named private files, never scans the host. */
export interface OfflineFileDescriptor { path: string; sha256: string }
export interface OfflineBackupDescriptor {
  root: string;
  manifest: OfflineFileDescriptor;
  files: Array<OfflineFileDescriptor & { role: 'database' | 'wal' | 'domain-json' | 'recovery' | 'migration' | 'preparation' }>;
}
export interface OfflineDomainCompletion {
  scope: string;
  commandId: string;
  command: string;
  typeHash: string;
  inputSha256: string;
  /** Registered SDK read command; its result must bind the receipt and authority, not a caller boolean. */
  completionCommand: string;
}
export interface OfflineActivationRecord {
  format: 'tower-offline-activation'; version: 1; activationId: string; stateDir: string; storageId: string;
  build: StorageBuildIdentity; manifest: StorageBuildManifest;
  oldArtifact: { identity: StorageBuildIdentity; entry: OfflineFileDescriptor; contract: OfflineFileDescriptor };
  backup: OfflineBackupDescriptor; targets: string[]; domains: OfflineDomainCompletion[];
  phase: 'pending' | 'schema-prepared' | 'complete';
}
export function decodeOfflineActivation(value: unknown): OfflineActivationRecord {
  const r = value as OfflineActivationRecord;
  if (!r || r.format !== 'tower-offline-activation' || r.version !== 1 || !/^[a-zA-Z0-9-]{1,100}$/.test(r.activationId)
    || typeof r.stateDir !== 'string' || resolve(r.stateDir) !== r.stateDir || !r.storageId
    || !['pending', 'schema-prepared', 'complete'].includes(r.phase) || !r.build || !sha(r.build.sourceHash)
    || !r.manifest || manifestDigest(r.manifest) !== r.manifest.digest || r.build.manifestDigest !== r.manifest.digest
    || r.build.appVersion !== r.manifest.appVersion || r.build.protocol !== r.manifest.protocol
    || !r.oldArtifact?.identity || !sha(r.oldArtifact.identity.sourceHash) || !sha(r.oldArtifact.identity.manifestDigest)
    || !sha(r.oldArtifact.contract?.sha256) || !sha(r.oldArtifact.entry?.sha256) || !r.backup || !sha(r.backup.manifest?.sha256)
    || !Array.isArray(r.backup.files) || !r.backup.files.length || r.backup.files.some(f => !sha(f.sha256)
      || !['database', 'wal', 'domain-json', 'recovery', 'migration', 'preparation'].includes(f.role))
    || !Array.isArray(r.targets) || !r.targets.length || new Set(r.targets).size !== r.targets.length
    || r.targets.length !== 1 + r.manifest.domains.length || r.targets.some(s => ![r.manifest.core.scope, ...r.manifest.domains.map(d => d.scope)].includes(s))
    || !Array.isArray(r.domains) || r.domains.length !== r.targets.length || new Set(r.domains.map(d => d.scope)).size !== r.targets.length
    || r.domains.some(d => !r.targets.includes(d.scope) || !d.commandId || !d.command || !d.completionCommand || !sha(d.typeHash) || !sha(d.inputSha256))) refuse('invalid record');
  return structuredClone(r);
}
async function privateBytes(path: string): Promise<Buffer> {
  const parent = dirname(resolve(path));
  if (await realpath(parent) !== parent) refuse('linked parent');
  // Check every ancestor below the filesystem root without reading unrelated files.
  for (let p = parent; dirname(p) !== p; p = dirname(p)) {
    const s = await lstat(p);
    if (!s.isDirectory() || s.isSymbolicLink()) refuse('directory boundary');
  }
  await privateDirectory(parent, false);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (before.size > 64 * 1024 * 1024) refuse('file size limit');
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0
      || process.getuid && before.uid !== process.getuid()) refuse('file ownership/privacy');
    const bytes = await file.readFile();
    const after = await file.stat();
    const named = await lstat(path);
    if (before.ino !== named.ino || before.dev !== named.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs) refuse('file changed');
    return bytes;
  } finally { await file.close(); }
}
async function verifyFile(file: OfflineFileDescriptor, root?: string) {
  if (resolve(file.path) !== file.path || root && (relative(root, file.path).startsWith('..') || file.path === root)) refuse('file boundary');
  if (hash(await privateBytes(file.path)) !== file.sha256) refuse('file hash');
}
export async function readOfflineActivation(stateDir: string): Promise<OfflineActivationRecord | undefined> {
  try {
    const r = decodeOfflineActivation(JSON.parse((await privateBytes(offlineActivationPath(stateDir))).toString('utf8')));
    if (r.stateDir !== resolve(stateDir)) refuse('state directory mismatch');
    return r;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export interface OfflineActivationOwner { readonly kind: 'offline-owner' }
const owners = new WeakMap<OfflineActivationOwner, { lease: StrictStateLease; runtimeDir: string; record: OfflineActivationRecord; storage?: StorageClient }>();
export async function beginOfflineActivation(input: { lease: StrictStateLease; runtimeDir: string; record: OfflineActivationRecord; update: StorageUpdateInput }): Promise<OfflineActivationOwner> {
  await validateStrictStateLease(input.lease, input.runtimeDir);
  const record = decodeOfflineActivation(input.record);
  if (resolve(input.runtimeDir) !== join(record.stateDir, 'runner-runtime') || record.phase !== 'pending' || record.stateDir !== resolve(input.update.stateDir)) refuse('begin context');
  await verifyFile(record.oldArtifact.entry);
  await verifyFile(record.oldArtifact.contract);
  const old = parseArtifactStorageContract((await privateBytes(record.oldArtifact.contract.path)).toString('utf8'), record.oldArtifact.identity.appVersion);
  if (old.state !== 'contract' || !same(old.contract.identity, record.oldArtifact.identity)) refuse('old artifact contract');
  await verifyFile(record.backup.manifest, record.backup.root);
  if (!same(JSON.parse((await privateBytes(record.backup.manifest.path)).toString('utf8')), { storageId: record.storageId, files: record.backup.files })) refuse('backup manifest inventory');
  if (!record.backup.files.some(f => f.role === 'database') || new Set(record.backup.files.map(f => f.path)).size !== record.backup.files.length) refuse('backup inventory');
  for (const f of record.backup.files) {
    const name = relative(record.backup.root, f.path);
    const allowed = f.role === 'database' ? name === 'state.sqlite' : f.role === 'wal' ? name === 'state.sqlite-wal'
      : f.role === 'domain-json' ? ['runs.json', 'created-sessions.json', 'run-instructions.json', 'trigger-engine.json', 'permissions.json', 'remote-requests.json', 'remote-exclusions.json', 'retention/journal.json', 'retention-observations.json'].includes(name)
      : f.role === 'preparation' ? /^storage-contracts\/[a-z][a-z0-9-]{0,47}\.json$/.test(name)
      : f.role === 'recovery' ? /^storage-recovery\/(identity|barrier)\.json$/.test(name)
      : false;
    if (!allowed) refuse('backup file outside explicit whitelist; I must register remaining metadata');
    await verifyFile(f, record.backup.root);
  }
  await offlineEvaluation(input.update, record);
  const previous = await readOfflineActivation(record.stateDir);
  if (previous && !same({ ...previous, phase: 'pending' }, record)) refuse('explicit retry identity');
  if (previous?.phase === 'complete') refuse('already complete; no replay');
  await writePrivateDocument(offlineActivationPath(record.stateDir), JSON.stringify(record));
  const owner: OfflineActivationOwner = Object.freeze({ kind: 'offline-owner' });
  owners.set(owner, { lease: input.lease, runtimeDir: input.runtimeDir, record });
  return owner;
}
async function offlineEvaluation(update: StorageUpdateInput, record: OfflineActivationRecord): Promise<StorageUpdateEvaluation> {
  const result = await evaluateStorageUpdate(update);
  if (!same(update.build.preflight.identity, record.build) || !same(update.build.manifest, record.manifest)
    || !update.build.preflight.state || update.build.preflight.state.problem || !update.build.preflight.supported) refuse('trusted build/preflight');
  // Only the direct-start preparation prerequisite is replaceable by this same artifact's actual prepare.
  if (!result.importAllowed && (result.code !== 'prerequisite-required' || result.evidence.previous !== undefined)) refuse(result.code);
  const e = result.evidence;
  if (!['absent', 'terminal'].includes(e.update.state) || e.update.state === 'terminal' && e.update.update.stage !== 'done'
    || e.hold.state !== 'absent' || e.helper.state !== 'absent' || e.rollback.state !== 'absent' || e.pin.state !== 'absent') refuse('update owner state');
  return { ...result, verdict: 'ready', code: 'offline-store-only', reason: 'Explicit offline owner; external effects held.', importAllowed: true };
}
export type StorageActivationInput = { kind: 'normal'; update: StorageUpdateInput } | { kind: 'offline'; owner: OfflineActivationOwner; update: StorageUpdateInput; storage: StorageClient };
export async function validateOwnerContext(owner: OfflineActivationOwner, storage?: StorageClient) {
  const held = owners.get(owner);
  if (!held) refuse('forged owner');
  await validateStrictStateLease(held.lease, held.runtimeDir);
  if (!same(await readOfflineActivation(held.record.stateDir), held.record)) refuse('durable owner record changed');
  if (storage) {
    if (!(storage instanceof StorageClient) || held.storage && held.storage !== storage || !same(storage.identity, held.record.build)) refuse('SDK identity');
    const inspected = await storage.inspect();
    if (inspected.schema.kind === 'empty' || inspected.schema.storageId !== held.record.storageId) refuse('live storage identity');
    held.storage = storage;
  }
  return held;
}
export async function checkStorageActivation(input: StorageActivationInput, scope = 'core'): Promise<StorageUpdateEvaluation> {
  if (input.kind === 'normal') return evaluateStorageUpdate(input.update);
  const held = await validateOwnerContext(input.owner, input.storage);
  if (!held.record.targets.includes(scope) || !(await input.storage.gate(scope)).open) refuse('scope gate');
  return offlineEvaluation(input.update, held.record);
}
export async function prepareOfflineActivation(owner: OfflineActivationOwner, storage: StorageClient, update: StorageUpdateInput) {
  const held = await validateOwnerContext(owner, storage);
  await offlineEvaluation(update, held.record);
  const prepared = await storage.prepare({ allowMigration: true, commandId: `offline-${held.record.activationId}-prepare` });
  const gate = await storage.gate('core');
  await recordPreparationEvidence(held.record.stateDir, { context: { identity: held.record.build, manifest: held.record.manifest }, preflight: update.build.preflight, prepared, gate });
  held.record.phase = 'schema-prepared';
  await writePrivateDocument(offlineActivationPath(held.record.stateDir), JSON.stringify(held.record));
}
export async function finishOfflineActivation(owner: OfflineActivationOwner, storage: StorageClient) {
  const held = await validateOwnerContext(owner, storage);
  if (held.record.phase !== 'schema-prepared') refuse('schema not prepared');
  const inspection = await storage.inspect();
  for (const d of held.record.domains) {
    if (!(await storage.gate(d.scope)).open) refuse('historical/domain gate');
    const authority = inspection.authority.find(a => a.domain === d.scope);
    const receipt = await storage.receipt(d.commandId);
    if (!authority || authority.authority !== 'database' || authority.manifestSha256 !== d.inputSha256 || !receipt.found
      || receipt.receipt.scope !== d.scope || receipt.receipt.command !== d.command || receipt.receipt.payloadSha256 !== d.typeHash) refuse('authority/receipt');
    const completion = await storage.read(d.scope, d.completionCommand, { commandId: d.commandId, inputSha256: d.inputSha256 });
    if (!same(completion, { commandId: d.commandId, command: d.command, typeHash: d.typeHash, inputSha256: d.inputSha256,
      authorityGeneration: authority.generation, restore: 'complete', unresolvedIntents: 0 })) refuse('registered completion evidence');
  }
  await validateOwnerContext(owner, storage);
  const completed = { ...held.record, phase: 'complete' as const };
  await writePrivateDocument(offlineActivationPath(held.record.stateDir), JSON.stringify(completed));
  held.record = completed;
}
/** Restart never infers completion from preparation files or worker ready. */
export async function offlineBootstrapHeld(stateDir: string, build?: StorageBuildIdentity, storageId?: string): Promise<boolean> {
  const record = await readOfflineActivation(stateDir);
  if (!record) return false;
  if (!storageId) {
    const identity = await readStorageIdentity(await storageLayout(stateDir));
    if (identity.state === 'present' && identity.identity.state === 'created') storageId = identity.identity.storageId;
  }
  return record.phase !== 'complete' || !build || !same(record.build, build) || storageId !== record.storageId;
}
