import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { validateStrictStateLease, type StrictStateLease } from '../instance/state-lock.js';
import { fileSha256, readStorageIdentity } from '../storage/recovery.js';
import { StorageClient } from '../storage/client.js';
import type { StorageBuildIdentity, StorageBuildManifest } from '../storage/contract.js';
import { manifestDigest } from '../storage/schema.js';
import { privateDirectory, privateFile, sameGeneration, storageLayout, writePrivateDocument } from '../storage/paths.js';
import { evaluateStorageUpdate, parseArtifactStorageContract, recordPreparationEvidence, type StorageUpdateInput, type StorageUpdateEvaluation } from './storage-update.js';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const refuse: (reason: string) => never = (reason) => { throw new Error(`Offline activation held: ${reason}`); };
export const offlineActivationPath = (stateDir: string) => join(stateDir, 'storage-offline-activation.json');

export type { OfflineBackupDescriptor } from './storage-offline-backup.js';
import { verifyOfflineBackup, type OfflineBackupDescriptor } from './storage-offline-backup.js';
export interface OfflineFileDescriptor { path: string; sha256: string }
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
  corePrepared?: { commandId: string; payloadSha256: string };
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
    || typeof r.backup.root !== 'string' || !r.backup.snapshotId
    || r.phase !== 'pending' && (!r.corePrepared?.commandId || !sha(r.corePrepared.payloadSha256))
    || !Array.isArray(r.targets) || !r.targets.length || new Set(r.targets).size !== r.targets.length
    || r.targets.length !== 1 + r.manifest.domains.length || r.targets.some(s => ![r.manifest.core.scope, ...r.manifest.domains.map(d => d.scope)].includes(s))
    || !Array.isArray(r.domains) || r.domains.length > r.manifest.domains.length || r.phase === 'complete' && r.domains.length !== r.manifest.domains.length || new Set(r.domains.map(d => d.scope)).size !== r.domains.length
    || r.domains.some(d => d.scope === r.manifest.core.scope || !r.targets.includes(d.scope) || !d.commandId || d.command !== 'commit' || d.completionCommand !== 'offlineCompletion' || !sha(d.typeHash) || !sha(d.inputSha256))) refuse('invalid record');
  return structuredClone(r);
}
export async function readOfflinePrivateBytes(path: string): Promise<Buffer> {
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
  const parent=dirname(file.path);
  if(await realpath(parent)!==parent || !await privateDirectory(parent,false)) refuse('file parent boundary');
  const before=await privateFile(file.path);
  if(!before || await fileSha256(file.path)!==file.sha256) refuse('file hash');
  const after=await privateFile(file.path);
  if(!after || !sameGeneration(before,after)) refuse('file changed');
}
export async function readOfflineActivation(stateDir: string): Promise<OfflineActivationRecord | undefined> {
  try {
    const r = decodeOfflineActivation(JSON.parse((await readOfflinePrivateBytes(offlineActivationPath(stateDir))).toString('utf8')));
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
  await verifyProtectedOfflineArtifact(record);
  const previous = await readOfflineActivation(record.stateDir);
  await verifyOfflineBackup(record.backup, record.stateDir, record.storageId, !previous);
  await offlineEvaluation(input.update, record);
  if (previous && !same({ ...previous, phase: 'pending', corePrepared: undefined, domains: [] }, { ...record, corePrepared: undefined, domains: [] })) refuse('explicit retry identity');
  if (previous?.phase === 'complete') refuse('already complete; no replay');
  await writePrivateDocument(offlineActivationPath(record.stateDir), JSON.stringify(previous ?? record));
  const owner: OfflineActivationOwner = Object.freeze({ kind: 'offline-owner' });
  owners.set(owner, { lease: input.lease, runtimeDir: input.runtimeDir, record: previous ?? record });
  return owner;
}
// Official A124 package member capture (asset 626540259), never executed here.
// Only the unpacked npm package layout is supported; SEA/arbitrary entries are held.
const protectedA124 = {
  "identity": {
    "appVersion": "1.124.0",
    "protocol": "tower-storage/1",
    "sourceHash": "5318990f15be1bbe73ba69c390c4b5ae32c7ee4ca61ba89f4d34241723936a0a",
    "manifestDigest": "7cd7d758851f5ef047450f63d372660ccc8a36f41af5b736274d00bbd2fdccc0"
  },
  "members": {
    "bin/agent-session-tower.mjs": "94350c0830e305fd67d19fd8db7840f1628684bf13e82147e531e392ee3cec4e",
    "dist/server/index.js": "1ac0a3eabfdc77b30740efa6401e660c976f66255b9534c177e324a7fb7cd948",
    "dist/server/storage/generated/thread-bundle.json": "80664388b126c95cf5355cdf7636900c0254a7dc3c72693d6ef6176e10c02432",
    "dist/server/storage/build-identity.js": "3104832e07e143d7b31931b818aa853bf1eef6615a8b299179a483eb716af41c",
    "dist/server/storage/schema.js": "faf9155abfeca96948f76649267a2c28d3fbadac45ed22c44a7faa499b8a3b34"
  }
};
export async function verifyProtectedOfflineArtifact(record: OfflineActivationRecord) {
  await verifyFile(record.oldArtifact.entry);
  await verifyFile(record.oldArtifact.contract);
  const contractBytes=await readOfflinePrivateBytes(record.oldArtifact.contract.path);
  if (hash(contractBytes)!==record.oldArtifact.contract.sha256) refuse('old artifact contract changed');
  const old = parseArtifactStorageContract(contractBytes.toString('utf8'), record.oldArtifact.identity.appVersion);
  if (old.state !== 'contract' || !same(old.contract.identity, record.oldArtifact.identity)) refuse('old artifact contract');
  if (!same(old.contract.identity, protectedA124.identity)) refuse('unsupported protected artifact profile');
  const root = resolve(dirname(record.oldArtifact.entry.path), '..');
  if (record.oldArtifact.entry.path !== join(root, 'bin/agent-session-tower.mjs')) refuse('unsupported protected artifact entry');
  for (const [member, digest] of Object.entries(protectedA124.members)) {
    const bytes = await readOfflinePrivateBytes(join(root, member));
    if (member === 'bin/agent-session-tower.mjs' && hash(bytes)!==record.oldArtifact.entry.sha256) refuse('old artifact entry changed');
    if (hash(bytes) !== digest) refuse('old artifact embedded identity/entry mismatch');
    if (member === 'dist/server/storage/generated/thread-bundle.json') {
      const bundle = JSON.parse(bytes.toString('utf8')) as { format: string; source: string; sourceHash: string };
      const first = `var __TOWER_STORAGE_SOURCE_HASH__ = "${protectedA124.identity.sourceHash}";\n`;
      if (bundle.format !== 'tower-storage-thread-bundle/2' || bundle.sourceHash !== old.contract.identity.sourceHash
        || !bundle.source.startsWith(first) || hash(bundle.source.slice(first.length)) !== bundle.sourceHash) refuse('old artifact SDK source');
    }
  }
  // Recheck descriptors after the member reads; both proofs cover the same bytes.
  await verifyFile(record.oldArtifact.entry);
  await verifyFile(record.oldArtifact.contract);
  return old.contract;
}
async function offlineEvaluation(update: StorageUpdateInput, record: OfflineActivationRecord): Promise<StorageUpdateEvaluation> {
  const result = await evaluateStorageUpdate(update, 'offline');
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
  const commandId = `offline-${held.record.activationId}-prepare`;
  const payloadSha256 = hash(JSON.stringify({ allowMigration: true, storageId: held.record.storageId }));
  const receipt = await storage.receipt(commandId);
  if (!receipt.found || receipt.receipt.scope !== 'core' || receipt.receipt.command !== 'prepare' || receipt.receipt.payloadSha256 !== payloadSha256
    || !prepared.claimed || !gate.open) refuse('actual core prepare receipt');
  held.record.corePrepared = { commandId, payloadSha256 };
  held.record.phase = 'schema-prepared';
  await writePrivateDocument(offlineActivationPath(held.record.stateDir), JSON.stringify(held.record));
}
export async function recordOfflineDomainCompletion(owner: OfflineActivationOwner, storage: StorageClient, scope: string): Promise<void> {
  const held = await validateOwnerContext(owner, storage);
  if (held.record.phase !== 'schema-prepared' || !held.record.manifest.domains.some(d => d.scope === scope)) refuse('domain store phase');
  const completion = await storage.read<OfflineDomainCompletion>(scope, 'offlineAuthorityReceipt', {});
  if (completion.scope !== scope || completion.completionCommand !== 'offlineCompletion') refuse('registered domain descriptor');
  const record = { ...held.record, domains: [...held.record.domains.filter(d => d.scope !== scope), completion] };
  // Validate the actual registered query before publishing any domain evidence.
  const inspection = await storage.inspect();
  const authority = inspection.authority.find(a => a.domain === scope);
  if (!authority) refuse('domain authority');
  const result = await storage.read(scope, completion.completionCommand, { commandId: completion.commandId, inputSha256: completion.inputSha256 });
  if (!same(result, { commandId: completion.commandId, command: completion.command, typeHash: completion.typeHash, inputSha256: completion.inputSha256,
    authorityGeneration: authority.generation, restore: 'complete', unresolvedIntents: 0 })) refuse('domain completion query');
  await writePrivateDocument(offlineActivationPath(record.stateDir), JSON.stringify(record));
  held.record = record;
}
export async function finishOfflineActivation(owner: OfflineActivationOwner, storage: StorageClient) {
  const held = await validateOwnerContext(owner, storage);
  if (held.record.phase !== 'schema-prepared' || held.record.domains.length !== held.record.manifest.domains.length) refuse('schema not prepared');
  await verifyOfflineCompletion(held.record, storage);
  await validateOwnerContext(owner, storage);
  const completed = { ...held.record, phase: 'complete' as const };
  await writePrivateDocument(offlineActivationPath(held.record.stateDir), JSON.stringify(completed));
  held.record = completed;
}
export async function verifyOfflineCompletion(record: OfflineActivationRecord, storage: StorageClient): Promise<void> {
  if (record.domains.length !== record.manifest.domains.length || await privateFile(join(record.stateDir,'storage-permissions-pending.json'))) refuse('global store completion/pending intent');
  if (!same(storage.identity, record.build)) refuse('completion SDK identity');
  const core = record.corePrepared;
  if (!core || core.commandId !== `offline-${record.activationId}-prepare` || core.payloadSha256 !== hash(JSON.stringify({ allowMigration: true, storageId: record.storageId }))) refuse('core prepared receipt missing/mismatch');
  const prepared = await storage.receipt(core.commandId);
  if (!prepared.found || prepared.receipt.scope !== 'core' || prepared.receipt.command !== 'prepare'
    || prepared.receipt.payloadSha256 !== core.payloadSha256 || !(await storage.gate('core')).open) refuse('core prepared receipt/gate');
  const inspection = await storage.inspect();
  for (const d of record.domains) {
    if (!(await storage.gate(d.scope)).open) refuse('historical/domain gate');
    const authority = inspection.authority.find(a => a.domain === d.scope);
    const receipt = await storage.receipt(d.commandId);
    if (!authority || authority.authority !== 'database' || authority.manifestSha256 !== d.inputSha256 || !receipt.found
      || receipt.receipt.scope !== d.scope || receipt.receipt.command !== d.command || receipt.receipt.payloadSha256 !== d.typeHash) refuse('authority/receipt');
    const completion = await storage.read(d.scope, d.completionCommand, { commandId: d.commandId, inputSha256: d.inputSha256 });
    if (!same(completion, { commandId: d.commandId, command: d.command, typeHash: d.typeHash, inputSha256: d.inputSha256,
      authorityGeneration: authority.generation, restore: 'complete', unresolvedIntents: 0 })) refuse('registered completion evidence');
  }
  if (inspection.schema.kind !== 'current' || inspection.schema.storageId !== record.storageId) refuse('completion schema identity');
}
/** Restart never infers completion from preparation files or worker ready. */
export async function offlineBootstrapHeld(stateDir: string, build?: StorageBuildIdentity, storageId?: string, storage?: StorageClient): Promise<boolean> {
  const record = await readOfflineActivation(stateDir);
  if (!record) return false;
  if (!storageId) {
    const identity = await readStorageIdentity(await storageLayout(stateDir));
    if (identity.state === 'present' && identity.identity.state === 'created') storageId = identity.identity.storageId;
  }
  if (record.phase !== 'complete' || !build || !same(record.build, build) || storageId !== record.storageId || !storage) return true;
  try { await verifyOfflineCompletion(record, storage); return false; } catch { return true; }
}

/** Normal guards remain intact; only a bound, previously finished installation may consume this explicit proof. */
export async function completedOfflineCandidate(update: StorageUpdateInput): Promise<OfflineActivationRecord | undefined> {
  const record = await readOfflineActivation(update.stateDir);
  if (!record || record.phase !== 'complete') return undefined;
  await offlineEvaluation(update, record);
  return record;
}
export async function evaluateCompletedOffline(update: StorageUpdateInput, storage: StorageClient): Promise<StorageUpdateEvaluation> {
  const record = await completedOfflineCandidate(update);
  if (!record || await offlineBootstrapHeld(update.stateDir, record.build, record.storageId, storage)) refuse('completed SDK proof held');
  const evaluation = await offlineEvaluation(update, record);
  return { ...evaluation, code:'offline-completion-verified', reason:'Exact offline installation receipts and current storage gates verified.' };
}
