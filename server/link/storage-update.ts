import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readFile, readlink, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { UpdateFailure, UpdateStage, UpdateStatus } from '../../shared/link.js';
import type { DomainManifest, RuntimeInfo, StorageBuildIdentity, StorageBuildManifest, StorageInspection } from '../storage/contract.js';
import type { StoragePreflight } from '../storage/preflight.js';
import { manifestDigest } from '../storage/schema.js';
import { privateDirectory, privateFile, storageLayout, writePrivateDocument } from '../storage/paths.js';
import { writePrivateJson } from '../stores/private-json.js';
import { processStart } from '../instance/process-start.js';
import { entryPoint, newerVersion, pointRollbackTarget, runtimePaths, storagePinPath, versionDirectory } from './service.js';

/**
 * How updates, direct starts and the owner's rollback decide whether this build may change its storage (import a
 * domain, migrate a schema) and whether it answers its health check. Everything here reads before it decides; only the
 * owner's explicit steps (a recovery receipt, a pin, a rollback) and a preparation release's worker (its evidence)
 * write, each to its own owner-only file under the state directory. Nothing here opens SQLite: a target build's
 * storage contract comes from running its installed artifact (`--storage-contract`), and the live database's schema
 * from the worker that owns it.
 *
 * A file that is there but cannot be read is never taken for one that is missing, and nothing is removed because it
 * is old: whatever cannot be told holds the storage back, and the health check fails only for a refusal (a runtime,
 * contract or prerequisite this build cannot work with), never for a wait.
 */

const run = promisify(execFile);
const RELEASE = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SCOPE = /^[a-z][a-z0-9-]{0,47}$/;
const MAX_RECORD_BYTES = 1024 * 1024;
const ARTIFACT_TIMEOUT_MS = 60_000;

export function updatePaths(stateDir: string) {
  const { root, logs } = runtimePaths(stateDir);
  return { status: join(root, 'update.json'), lock: join(root, 'update.lock'), hold: join(root, 'handoff-hold'), log: join(logs, 'update.log') };
}
/** The owner's recovery receipt and rollback, beside update.json. The pin's path is the service's (storagePinPath). */
export function storageUpdatePaths(stateDir: string) {
  const { root } = runtimePaths(stateDir);
  return { receipt: join(root, 'storage-update-receipt.json'), rollback: join(root, 'storage-rollback.json'), pin: storagePinPath(stateDir) };
}
/** A preparation release's evidence for one domain, read by a later direct start. */
export const preparationEvidencePath = (stateDir: string, domain: string) => join(stateDir, 'storage-contracts', `${domain}.json`);

/** Why a candidate's storage check failed, as an update record keeps it. */
export type StorageUpdateFailure = 'prerequisite-required' | 'contract-unverifiable' | 'target-runtime-unsupported';
/** What this computer keeps about its update; `controllers` (linked when it switched) stays here. */
export interface SavedUpdate extends UpdateStatus {
  controllers?: string[];
  /** Set when the target's storage contract stopped the update before anything switched. */
  storage?: { code: StorageUpdateFailure; prepare?: string; domains?: string[] };
}

const ACTIVE: ReadonlySet<UpdateStage> = new Set(['installing', 'checking', 'switching', 'verifying', 'rolling-back']);
const STAGES: ReadonlySet<string> = new Set([...ACTIVE, 'done', 'failed']);
const FAILURES: ReadonlySet<UpdateFailure> = new Set(['low-disk', 'install-failed', 'check-failed', 'switch-failed', 'start-failed', 'link-failed', 'rollback-failed', 'interrupted']);
const STORAGE_FAILURES: ReadonlySet<string> = new Set(['prerequisite-required', 'contract-unverifiable', 'target-runtime-unsupported']);
export const updateActive = (status: UpdateStatus | undefined): boolean => Boolean(status && ACTIVE.has(status.stage));

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const isTime = (value: unknown) => typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
const isText = (value: unknown, maximum: number) => typeof value === 'string' && !!value.trim() && value.length <= maximum;
const isCount = (value: unknown, minimum = 0) => Number.isSafeInteger(value) && (value as number) >= minimum;
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
/** `b` is `a` or newer, both released versions. */
const atLeast = (a: string, b: string) => RELEASE.test(a) && RELEASE.test(b) && !newerVersion(b, a);

/** An owner's file as it is: never followed through a link, never chmodded, at most `maxBytes`. Undefined when absent. */
async function readExact(path: string, maxBytes = MAX_RECORD_BYTES): Promise<Buffer | undefined> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error) { if (missing(error)) return undefined; throw error; }
  try {
    const info = await file.stat();
    if (!info.isFile()) throw Object.assign(new Error(`${path} is not a regular file.`), { code: 'ENOTFILE' });
    if (info.size > maxBytes) throw Object.assign(new Error(`${path} is too large.`), { code: 'EFBIG' });
    return await file.readFile();
  } finally { await file.close(); }
}

// ---- Strict reads of what an update leaves behind. ----

/**
 * update.json as it is. `unreadable`: it is there and could not be read (permissions, I/O, not a file); `invalid`: it
 * was read and is not a record this build understands (an unknown stage or failure included). Neither is missing.
 * Unknown extra fields are kept: older and newer helpers rewrite the record with fields they carry over.
 */
export type UpdateRecordRead =
  | { state: 'absent' }
  | { state: 'unreadable'; reason: string }
  | { state: 'invalid'; reason: string }
  | { state: 'active' | 'terminal'; update: SavedUpdate; sha256: string };

function updateProblem(value: unknown): string | undefined {
  if (!isObject(value)) return 'it is not an object';
  if (typeof value.version !== 'string' || !RELEASE.test(value.version)) return 'its version is not a release';
  if (typeof value.previous !== 'string' || !RELEASE.test(value.previous)) return 'its previous version is not a release';
  if (typeof value.stage !== 'string' || !STAGES.has(value.stage)) return 'its stage is unknown';
  if (!isTime(value.startedAt) || !isTime(value.updatedAt)) return 'its times are invalid';
  if (value.code !== undefined && !FAILURES.has(value.code as UpdateFailure)) return 'its failure is unknown';
  if (value.failedStage !== undefined && !STAGES.has(value.failedStage as string)) return 'its failed stage is unknown';
  if (value.controllers !== undefined && !(Array.isArray(value.controllers) && value.controllers.every(id => typeof id === 'string'))) return 'its controllers are invalid';
  const storage = value.storage;
  if (storage !== undefined && !(isObject(storage) && STORAGE_FAILURES.has(storage.code as string)
    && (storage.prepare === undefined || (typeof storage.prepare === 'string' && RELEASE.test(storage.prepare)))
    && (storage.domains === undefined || (Array.isArray(storage.domains) && storage.domains.every(domain => typeof domain === 'string' && SCOPE.test(domain)))))) return 'its storage failure is invalid';
  return undefined;
}

export async function readUpdateRecord(stateDir: string): Promise<UpdateRecordRead> {
  let bytes: Buffer | undefined;
  try { bytes = await readExact(updatePaths(stateDir).status); } catch (error) { return { state: 'unreadable', reason: messageOf(error) }; }
  if (!bytes) return { state: 'absent' };
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { return { state: 'invalid', reason: 'update.json is not JSON.' }; }
  const problem = updateProblem(value);
  if (problem) return { state: 'invalid', reason: `update.json cannot be used: ${problem}.` };
  const update = value as SavedUpdate;
  return { state: ACTIVE.has(update.stage) ? 'active' : 'terminal', update, sha256: sha256(bytes) };
}

/** The handoff hold, without removing it however old it is. */
export type HoldRead = { state: 'absent' } | { state: 'present'; ageMs: number } | { state: 'unreadable'; reason: string; error: unknown };
export async function readHold(stateDir: string, now = Date.now()): Promise<HoldRead> {
  let info: Stats;
  try { info = await stat(updatePaths(stateDir).hold); } catch (error) {
    if (missing(error)) return { state: 'absent' };
    return { state: 'unreadable', reason: messageOf(error), error };
  }
  return { state: 'present', ageMs: Math.max(0, now - info.mtimeMs) };
}

/** Whether a process is still running. */
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
/**
 * The helper lock's owner: `running` while its pid runs as the process that took it (a pid whose start cannot be told
 * counts as running), `gone` once it does not. `invalid`: a lock without an owner in it; `unreadable`: one that is
 * there and cannot be read, which may still belong to a helper.
 */
export type HelperRead =
  | { state: 'absent' } | { state: 'running'; pid: number } | { state: 'gone'; pid: number }
  | { state: 'invalid'; reason: string } | { state: 'unreadable'; reason: string; error: unknown };
export async function readHelperLock(stateDir: string, started: (pid: number) => Promise<string | undefined> = processStart): Promise<HelperRead> {
  let text: string;
  try { text = await readFile(updatePaths(stateDir).lock, 'utf8'); } catch (error) {
    if (missing(error)) return { state: 'absent' };
    return { state: 'unreadable', reason: messageOf(error), error };
  }
  const [pidText, ...rest] = text.split(' ');
  const pid = Number(pidText);
  if (!(pid > 0) || !Number.isInteger(pid)) return { state: 'invalid', reason: 'The update helper lock names no process.' };
  if (!alive(pid)) return { state: 'gone', pid };
  if (!rest.length) return { state: 'running', pid };
  const now = await started(pid);
  return now === undefined || now === rest.join(' ') ? { state: 'running', pid } : { state: 'gone', pid };
}

/** Where `current` points: only `versions/<release>`, as pointCurrent writes it, names a version. */
export type PointerRead = { state: 'absent' } | { state: 'version'; version: string } | { state: 'invalid'; reason: string } | { state: 'unreadable'; reason: string };
export async function readCurrentPointer(stateDir: string): Promise<PointerRead> {
  const { current } = runtimePaths(stateDir);
  let info: Stats;
  try { info = await lstat(current); } catch (error) { return missing(error) ? { state: 'absent' } : { state: 'unreadable', reason: messageOf(error) }; }
  if (!info.isSymbolicLink()) return { state: 'invalid', reason: `${current} is not a link to an installed version.` };
  let target: string;
  try { target = await readlink(current); } catch (error) { return { state: 'unreadable', reason: messageOf(error) }; }
  const version = /^versions\/(\d+\.\d+\.\d+)$/.exec(target)?.[1];
  return version ? { state: 'version', version } : { state: 'invalid', reason: `${current} points at ${target.slice(0, 200)}, not an installed version.` };
}

// ---- A build's storage contract, as its installed artifact states it. ----

/**
 * What `agent-session-tower --storage-contract` prints: the contract the artifact's own build binds to its storage
 * thread, and whether that thread runs on this execPath (an in-memory probe; no state directory is read). It claims
 * nothing about a live database: that build's support of a database is judged from this manifest and the database's
 * own schema rows.
 */
export interface ArtifactStorageContract {
  format: 'tower-artifact-storage-contract';
  version: 1;
  appVersion: string;
  supported: boolean;
  identity: StorageBuildIdentity;
  manifest: StorageBuildManifest;
  refusal?: { phase: string; code: string; message: string };
  runtime?: Pick<RuntimeInfo, 'node' | 'sqlite' | 'platform' | 'arch'>;
}
/**
 * `legacy`: an artifact that answers its version and has no storage contract (every JSON-only release). `unverifiable`:
 * one whose contract could not be told (it did not run, timed out, or printed something else); never a legacy one.
 */
export type ArtifactRead =
  | { state: 'missing' }
  | { state: 'legacy'; version: string }
  | { state: 'contract'; contract: ArtifactStorageContract }
  | { state: 'unverifiable'; reason: string };
export type ArtifactProbe = (directory: string, version: string) => Promise<ArtifactRead>;

/** The contract an artifact prints, from its build's trusted context and its runtime preflight. */
export function artifactStorageContract(context: { identity: StorageBuildIdentity; manifest: StorageBuildManifest }, preflight: StoragePreflight): ArtifactStorageContract {
  const runtime = preflight.runtime;
  return {
    format: 'tower-artifact-storage-contract', version: 1, appVersion: context.manifest.appVersion,
    supported: preflight.supported && preflight.identity?.sourceHash === context.identity.sourceHash,
    identity: { ...context.identity }, manifest: structuredClone(context.manifest),
    ...(preflight.refusal ? { refusal: { ...preflight.refusal } } : {}),
    ...(runtime ? { runtime: { node: runtime.node, ...(runtime.sqlite ? { sqlite: runtime.sqlite } : {}), platform: runtime.platform, arch: runtime.arch } } : {}),
  };
}

/** This build's own contract, as `--storage-contract` prints it. Undefined (with the reason) when its bundle is not one it trusts. */
export async function describeArtifactStorageContract(): Promise<{ contract: ArtifactStorageContract } | { error: string }> {
  const { captureStorageBundle, preflightStorage, storageBuildContext } = await import('../storage/index.js');
  const bundle = await captureStorageBundle();
  const context = storageBuildContext(bundle);
  if (!context.ok) return { error: context.failure.message };
  return { contract: artifactStorageContract(context, await preflightStorage({ bundle })) };
}
/** The `--storage-contract` command: one JSON line on stdout, or an error and exit code 2. */
export async function printArtifactStorageContract(): Promise<void> {
  const answer = await describeArtifactStorageContract();
  if ('error' in answer) { console.error(`Agent Session Tower: ${answer.error}`); process.exitCode = 2; return; }
  process.stdout.write(`${JSON.stringify(answer.contract)}\n`);
}

function domainProblem(domain: unknown): boolean {
  if (!isObject(domain) || !SCOPE.test(String(domain.scope)) || !isCount(domain.schemaVersion, 1) || !SHA256.test(String(domain.schemaDigest))) return true;
  const preparation = domain.preparation;
  if (!isObject(preparation) || typeof preparation.requiredArtifactVersion !== 'string' || !isCount(preparation.readerContract, 1) || !isCount(preparation.writerContract, 1)) return true;
  const cutover = domain.cutover;
  return cutover !== undefined && !(isObject(cutover) && typeof cutover.artifactVersion === 'string' && isCount(cutover.importContract, 1));
}

/** Checks a printed contract whole: of `version`, its manifest's digest recomputed, its identity bound to that manifest. */
export function parseArtifactStorageContract(text: string, version: string): ArtifactRead {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { state: 'unverifiable', reason: 'The artifact printed no storage contract.' }; }
  if (!isObject(value) || value.format !== 'tower-artifact-storage-contract' || value.version !== 1) return { state: 'unverifiable', reason: 'The artifact printed an unknown storage contract format.' };
  const { manifest, identity } = value;
  if (value.appVersion !== version || typeof value.supported !== 'boolean' || !isObject(manifest) || !isObject(identity)) return { state: 'unverifiable', reason: `The artifact's storage contract is not one of ${version}.` };
  const core = manifest.core;
  const coreValid = isObject(core) && core.scope === 'core' && isCount(core.schemaVersion, 1) && SHA256.test(String(core.schemaDigest));
  if (manifest.appVersion !== version || identity.appVersion !== version || !coreValid || !Array.isArray(manifest.domains) || manifest.domains.some(domainProblem)) {
    return { state: 'unverifiable', reason: 'The artifact\'s storage manifest is malformed.' };
  }
  let digest: string | undefined;
  try { digest = manifestDigest(manifest as unknown as StorageBuildManifest); } catch { digest = undefined; }
  if (!digest || digest !== manifest.digest || identity.manifestDigest !== digest || identity.protocol !== manifest.protocol || !SHA256.test(String(identity.sourceHash))) {
    return { state: 'unverifiable', reason: 'The artifact\'s storage identity does not match its manifest.' };
  }
  return { state: 'contract', contract: value as unknown as ArtifactStorageContract };
}

/** Answers per installed artifact, kept while its files are the same ones (an install replaces the whole folder). */
const artifactCache = new Map<string, { stamp: string; read: ArtifactRead }>();

/**
 * Runs an installed artifact's `--storage-contract` with this process's Node. A JSON-only release refuses the option
 * as unknown and still answers `--version`: that alone makes it `legacy`. Anything else that fails is `unverifiable`.
 */
export const probeInstalledArtifact: ArtifactProbe = async (directory, version) => {
  const entry = entryPoint(directory);
  let stamp: string;
  try {
    const [folder, file] = await Promise.all([lstat(directory), lstat(entry)]);
    stamp = `${folder.ino}:${file.ino}:${file.size}:${file.mtimeMs}`;
  } catch (error) { return missing(error) ? { state: 'missing' } : { state: 'unverifiable', reason: messageOf(error) }; }
  const key = `${directory}\0${version}`;
  const cached = artifactCache.get(key);
  if (cached?.stamp === stamp) return cached.read;
  let read: ArtifactRead;
  try {
    const { stdout } = await run(process.execPath, [entry, '--storage-contract'], { timeout: ARTIFACT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
    read = parseArtifactStorageContract(stdout.trim(), version);
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: unknown; killed?: boolean };
    const unknownOption = typeof failure.code === 'number' && !failure.killed && String(failure.stderr ?? '').includes('Unknown option: --storage-contract');
    if (!unknownOption) return { state: 'unverifiable', reason: `The artifact's storage contract could not be read: ${messageOf(error).split('\n')[0]}` };
    const answered = await run(process.execPath, [entry, '--version'], { timeout: ARTIFACT_TIMEOUT_MS }).then(result => result.stdout.trim(), () => undefined);
    read = answered === version ? { state: 'legacy', version } : { state: 'unverifiable', reason: `The artifact reports ${answered?.slice(0, 40) || 'no version'}, not ${version}.` };
  }
  if (read.state !== 'unverifiable') artifactCache.set(key, { stamp, read });
  return read;
};

// ---- Preparation: whether an earlier build can take over a later build's storage. ----

/** Domains `manifest` imports (its release B), each needing its release A's reader/writer first. */
const cutoverDomains = (manifest: StorageBuildManifest) => manifest.domains.filter(domain => domain.cutover);

/** Whether one preparation build's domain contract reads and writes `domain` as the cutover build declares it. */
function preparesDomain(domain: DomainManifest, prepared: { appVersion: string; schemaVersion: number; schemaDigest: string; readerContract: number; writerContract: number } | undefined): boolean {
  return !!prepared && prepared.schemaVersion === domain.schemaVersion && prepared.schemaDigest === domain.schemaDigest
    && prepared.readerContract >= domain.preparation.readerContract && prepared.writerContract >= domain.preparation.writerContract
    && atLeast(prepared.appVersion, domain.preparation.requiredArtifactVersion);
}

export interface PreparationCheck {
  /** `not-required`: the build imports no domain. Only `not-required` and `satisfied` let it go ahead. */
  state: 'not-required' | 'satisfied' | 'prerequisite-required' | 'missing' | 'unverifiable' | 'runtime-unsupported';
  /** The preparation release to install first: the newest one an unsatisfied domain requires. */
  prepare?: string;
  domains: string[];
  reason?: string;
}

/**
 * Whether the build that would run instead of `target` (the previous version an update goes back to, or a rollback's
 * own target) reads and writes every domain `target` imports. Its artifact must state a contract, run on this execPath,
 * and declare each domain's schema exactly with at least the reader/writer contracts target requires.
 */
export function preparationCheck(target: StorageBuildManifest, artifact: ArtifactRead): PreparationCheck {
  const needed = cutoverDomains(target);
  if (!needed.length) return { state: 'not-required', domains: [] };
  const names = needed.map(domain => domain.scope);
  const releases = needed.map(domain => domain.preparation.requiredArtifactVersion);
  if (!releases.every(version => RELEASE.test(version))) return { state: 'unverifiable', domains: names, reason: 'The target names a preparation release that is not a released version.' };
  const newest = releases.reduce((a, b) => newerVersion(b, a) ? b : a);
  if (artifact.state === 'missing') return { state: 'missing', prepare: newest, domains: names, reason: 'The version that would run instead is not installed.' };
  if (artifact.state === 'unverifiable') return { state: 'unverifiable', domains: names, reason: artifact.reason };
  if (artifact.state === 'legacy') return { state: 'prerequisite-required', prepare: newest, domains: names, reason: `${artifact.version} keeps its state in JSON only; ${newest} has to run first.` };
  const { contract } = artifact;
  const unmet = needed.filter(domain => {
    const own = contract.manifest.domains.find(item => item.scope === domain.scope);
    return !preparesDomain(domain, own && { appVersion: contract.appVersion, schemaVersion: own.schemaVersion, schemaDigest: own.schemaDigest, ...own.preparation });
  });
  if (unmet.length) {
    const prepare = unmet.map(domain => domain.preparation.requiredArtifactVersion).reduce((a, b) => newerVersion(b, a) ? b : a);
    return { state: 'prerequisite-required', prepare, domains: unmet.map(domain => domain.scope), reason: `${contract.appVersion} does not read and write ${unmet.map(domain => domain.scope).join(', ')} as this build stores them; ${prepare} has to run first.` };
  }
  if (!contract.supported) return { state: 'runtime-unsupported', domains: names, reason: `${contract.appVersion}'s storage does not run here${contract.refusal ? `: ${contract.refusal.message}` : '.'}` };
  return { state: 'satisfied', domains: names };
}

/**
 * A preparation release's evidence for one domain, written by its worker under the runtime lock once its storage
 * contract was checked: the bootstrap fact a later direct start compares with its own manifest. Not business state,
 * not an import authority, not part of the settings backup.
 */
export interface PreparationEvidence {
  format: 'tower-storage-preparation';
  version: 1;
  domain: string;
  build: StorageBuildIdentity;
  preparationVersion: string;
  readerContract: number;
  writerContract: number;
  schema: { version: number; digest: string };
  runtime: Pick<RuntimeInfo, 'node' | 'sqlite' | 'platform' | 'arch' | 'execPath'>;
  recordedAt: string;
}
export type EvidenceRead = { state: 'absent' } | { state: 'present'; evidence: PreparationEvidence } | { state: 'invalid'; reason: string } | { state: 'unreadable'; reason: string };

/**
 * Records this build's evidence for every domain its manifest declares (none in a build without domains). The caller
 * is the execution worker, after it took the runtime lock and checked its captured bundle: `context` is the trusted
 * StorageBuildContext's identity and manifest, `preflight` that bundle's runtime preflight on this execPath.
 */
export async function recordPreparationEvidence(stateDir: string, input: { context: { identity: StorageBuildIdentity; manifest: StorageBuildManifest }; preflight: StoragePreflight; now?: () => Date }): Promise<PreparationEvidence[]> {
  const { identity, manifest } = input.context;
  const { preflight } = input;
  if (manifestDigest(manifest) !== manifest.digest || identity.manifestDigest !== manifest.digest) throw new Error('The storage contract to record does not match its own manifest.');
  if (!preflight.supported || !preflight.runtime || preflight.identity?.sourceHash !== identity.sourceHash || preflight.identity.manifestDigest !== identity.manifestDigest) {
    throw new Error('Preparation evidence is recorded only for a storage runtime that passed its preflight as this build.');
  }
  if (!manifest.domains.length) return [];
  const layout = await storageLayout(stateDir);
  const folder = join(layout.stateDir, 'storage-contracts');
  await privateDirectory(folder, true);
  const { node, sqlite, platform, arch, execPath } = preflight.runtime;
  const recorded: PreparationEvidence[] = [];
  for (const domain of manifest.domains) {
    const evidence: PreparationEvidence = {
      format: 'tower-storage-preparation', version: 1, domain: domain.scope, build: { ...identity }, preparationVersion: manifest.appVersion,
      readerContract: domain.preparation.readerContract, writerContract: domain.preparation.writerContract,
      schema: { version: domain.schemaVersion, digest: domain.schemaDigest },
      runtime: { node, ...(sqlite ? { sqlite } : {}), platform, arch, execPath }, recordedAt: (input.now?.() ?? new Date()).toISOString(),
    };
    await writePrivateDocument(join(folder, `${domain.scope}.json`), JSON.stringify(evidence, null, 2));
    recorded.push(evidence);
  }
  return recorded;
}

export async function readPreparationEvidence(stateDir: string, domain: string): Promise<EvidenceRead> {
  if (!SCOPE.test(domain)) return { state: 'invalid', reason: 'The domain name is invalid.' };
  let bytes: Buffer | undefined;
  try {
    const layout = await storageLayout(stateDir);
    if (!(await privateDirectory(join(layout.stateDir, 'storage-contracts'), false))) return { state: 'absent' };
    const path = preparationEvidencePath(layout.stateDir, domain);
    if (!(await privateFile(path))) return { state: 'absent' };
    bytes = await readExact(path, 64 * 1024);
  } catch (error) { return { state: 'unreadable', reason: messageOf(error) }; }
  if (!bytes) return { state: 'absent' };
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { return { state: 'invalid', reason: 'The preparation evidence is not JSON.' }; }
  if (!isObject(value) || value.format !== 'tower-storage-preparation' || value.version !== 1 || value.domain !== domain || !isObject(value.build) || !SHA256.test(String(value.build.sourceHash))
    || typeof value.preparationVersion !== 'string' || !RELEASE.test(value.preparationVersion) || !isCount(value.readerContract, 1) || !isCount(value.writerContract, 1)
    || !isObject(value.schema) || !isCount(value.schema.version, 1) || !SHA256.test(String(value.schema.digest)) || !isObject(value.runtime) || !isTime(value.recordedAt)) {
    return { state: 'invalid', reason: 'The preparation evidence has an unknown format.' };
  }
  return { state: 'present', evidence: value as unknown as PreparationEvidence };
}

// ---- The owner's recovery receipt. ----

/**
 * The owner's re-verification of an update record that does not prove this build kept: a later update's failure that
 * went back to it (`overwritten-done`), or an update left active where no helper can settle it (`stale-active`). It
 * names the record (by its bytes), the build and the pointer it was verified with; any change to them voids it.
 */
export interface UpdateRecoveryReceipt {
  format: 'tower-update-recovery-receipt';
  version: 1;
  kind: 'overwritten-done' | 'stale-active';
  recordSha256: string;
  update: SavedUpdate;
  build: StorageBuildIdentity;
  pointer: string | null;
  by: string;
  evidence: string;
  recordedAt: string;
}
export type ReceiptRead = { state: 'absent' } | { state: 'present'; receipt: UpdateRecoveryReceipt } | { state: 'invalid'; reason: string } | { state: 'unreadable'; reason: string };
export async function readRecoveryReceipt(stateDir: string): Promise<ReceiptRead> {
  let bytes: Buffer | undefined;
  try { bytes = await readExact(storageUpdatePaths(stateDir).receipt); } catch (error) { return { state: 'unreadable', reason: messageOf(error) }; }
  if (!bytes) return { state: 'absent' };
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { return { state: 'invalid', reason: 'The recovery receipt is not JSON.' }; }
  if (!isObject(value) || value.format !== 'tower-update-recovery-receipt' || value.version !== 1 || (value.kind !== 'overwritten-done' && value.kind !== 'stale-active')
    || !SHA256.test(String(value.recordSha256)) || updateProblem(value.update) || !isObject(value.build) || !SHA256.test(String(value.build.sourceHash))
    || !(value.pointer === null || (typeof value.pointer === 'string' && RELEASE.test(value.pointer))) || !isText(value.by, 200) || !isText(value.evidence, 4096) || !isTime(value.recordedAt)) {
    return { state: 'invalid', reason: 'The recovery receipt has an unknown format.' };
  }
  return { state: 'present', receipt: value as unknown as UpdateRecoveryReceipt };
}

// ---- The owner's pin. ----

/** Keeps the service on one version: no update, scheduler or controller moves it, and pruning keeps its artifact. */
export interface StoragePin {
  format: 'tower-storage-pin';
  version: 1;
  pinned: string;
  sourceHash: string;
  manifestDigest: string;
  /** sha256 of the artifact's entry point when it was validated. */
  entrySha256: string;
  rollbackId: string;
  by: string;
  reason: string;
  at: string;
}
export type PinRead = { state: 'absent' } | { state: 'present'; pin: StoragePin } | { state: 'invalid'; reason: string } | { state: 'unreadable'; reason: string };
export async function readStoragePin(stateDir: string): Promise<PinRead> {
  let bytes: Buffer | undefined;
  try { bytes = await readExact(storagePinPath(stateDir), 64 * 1024); } catch (error) { return { state: 'unreadable', reason: messageOf(error) }; }
  if (!bytes) return { state: 'absent' };
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { return { state: 'invalid', reason: 'The version pin is not JSON.' }; }
  if (!isObject(value) || value.format !== 'tower-storage-pin' || value.version !== 1 || typeof value.pinned !== 'string' || !RELEASE.test(value.pinned)
    || !SHA256.test(String(value.sourceHash)) || !SHA256.test(String(value.manifestDigest)) || !SHA256.test(String(value.entrySha256))
    || !isText(value.rollbackId, 64) || !isText(value.by, 200) || typeof value.reason !== 'string' || value.reason.length > 2000 || !isTime(value.at)) {
    return { state: 'invalid', reason: 'The version pin has an unknown format.' };
  }
  return { state: 'present', pin: value as unknown as StoragePin };
}
/**
 * What an update request, the scheduler, a controller and pruning must respect. `pinned` names the version kept;
 * a pin that cannot be read keeps everything (`unknown`).
 */
export async function pinnedVersion(stateDir: string): Promise<{ state: 'none' } | { state: 'pinned'; version: string } | { state: 'unknown'; reason: string }> {
  const read = await readStoragePin(stateDir);
  if (read.state === 'absent') return { state: 'none' };
  if (read.state === 'present') return { state: 'pinned', version: read.pin.pinned };
  return { state: 'unknown', reason: read.reason };
}

/** The owner releases the pin on `version` (and only that pin). Nothing else changes: the service stays where it is. */
export async function releaseStoragePin(stateDir: string, input: { version: string }): Promise<{ released: boolean; reason?: string }> {
  const read = await readStoragePin(stateDir);
  if (read.state === 'absent') return { released: false, reason: 'No version is pinned.' };
  if (read.state !== 'present') return { released: false, reason: `The pin is left for the owner to inspect: ${read.reason}` };
  if (read.pin.pinned !== input.version) return { released: false, reason: `The pin keeps ${read.pin.pinned}, not ${input.version}.` };
  const rollback = await readRollbackRecord(stateDir);
  if (rollback.state === 'present' && ROLLBACK_ACTIVE.has(rollback.record.state)) return { released: false, reason: `Rollback ${rollback.record.id} to ${rollback.record.target} is still under way.` };
  await rm(storagePinPath(stateDir));
  return { released: true };
}

// ---- One evaluation of everything that decides. ----

/** The build running here: its version, its trusted manifest (storageBuildContext) and its runtime preflight on this execPath. */
export interface RunningBuild { version: string; manifest?: StorageBuildManifest; preflight: StoragePreflight }

export interface StorageUpdateInput {
  stateDir: string;
  build: RunningBuild;
  /** Runs as the background service's own install (managedByService). */
  managed: boolean;
  probe?: ArtifactProbe;
  now?: number;
  /**
   * Whether a domain's JSON files are there, from that domain's owner. A domain without an answer is not taken for a
   * new state directory.
   */
  legacyFiles?: (domain: string) => Promise<'absent' | 'present'>;
  /** The cutover markers of this build's domains, as the worker read them from the database (pre-import-refused). */
  cutoverMarkers?: 'absent' | 'present' | 'unknown';
}

/**
 * `ready`: this build may import and migrate. `update-held`: an update of this build is still being verified (or one
 * is under way, or its hold or helper remains); it answers health and waits. `refused`: the runtime, contract or
 * preparation this build needs is not there (health 503, identity kept). `recovery-required`: what happened cannot be
 * told without the owner (health answers, nothing is imported).
 */
export type StorageUpdateVerdict = 'ready' | 'update-held' | 'refused' | 'recovery-required';
export interface StorageUpdateEvidence {
  build: { version: string; identity?: StorageBuildIdentity; supported: boolean; refusal?: StoragePreflight['refusal'] };
  managed: boolean;
  update: UpdateRecordRead;
  hold: Exclude<HoldRead, { error: unknown }> | { state: 'unreadable'; reason: string };
  helper: Exclude<HelperRead, { error: unknown }> | { state: 'unreadable'; reason: string };
  current: PointerRead;
  currentArtifact?: ArtifactRead;
  previous?: { version: string; check: PreparationCheck };
  preparation?: { domain: string; read: EvidenceRead }[];
  receipt: ReceiptRead;
  pin: PinRead;
}
export interface StorageUpdateEvaluation {
  verdict: StorageUpdateVerdict;
  code: string;
  reason: string;
  importAllowed: boolean;
  /** Owner recovery is needed for this build's own failed update, which went back before it imported anything. */
  preImportRefused?: boolean;
  /** The preparation release to install first. */
  prepare?: string;
  evidence: StorageUpdateEvidence;
  evaluatedAt: string;
}

const publicRead = <T extends { state: string }>(read: T): Exclude<T, { error: unknown }> => {
  const { error: _, ...rest } = read as T & { error?: unknown };
  return rest as Exclude<T, { error: unknown }>;
};

/**
 * Evaluates, read-only, whether this build may change its storage, and what its health answers. One evaluation reads
 * the update record, hold, helper lock, current pointer, recovery receipt and pin, and the installed artifacts it needs
 * (the current one, to know this build is what the service runs; the previous one, when this build imports a domain).
 */
export async function evaluateStorageUpdate(input: StorageUpdateInput): Promise<StorageUpdateEvaluation> {
  const { stateDir, build, managed } = input;
  const now = input.now ?? Date.now();
  const probe = input.probe ?? probeInstalledArtifact;
  const [update, hold, helper, current, receipt, pin] = await Promise.all([
    readUpdateRecord(stateDir), readHold(stateDir, now), readHelperLock(stateDir), readCurrentPointer(stateDir), readRecoveryReceipt(stateDir), readStoragePin(stateDir),
  ]);
  const identity = build.preflight.identity;
  const evidence: StorageUpdateEvidence = {
    build: { version: build.version, ...(identity ? { identity: { ...identity } } : {}), supported: build.preflight.supported, ...(build.preflight.refusal ? { refusal: build.preflight.refusal } : {}) },
    managed, update, hold: publicRead(hold), helper: publicRead(helper), current, receipt, pin,
  };
  const answer = (verdict: StorageUpdateVerdict, code: string, reason: string, extra: Partial<StorageUpdateEvaluation> = {}): StorageUpdateEvaluation =>
    ({ verdict, code, reason, importAllowed: verdict === 'ready', ...extra, evidence, evaluatedAt: new Date(now).toISOString() });

  // The runtime and the contract this build binds to its storage.
  const manifest = build.manifest;
  if (!build.preflight.supported || !identity || !manifest) return answer('refused', 'runtime-unsupported', build.preflight.refusal?.message ?? 'This build\'s storage runtime did not pass its preflight.');
  if (identity.manifestDigest !== manifest.digest || identity.appVersion !== build.version || manifest.appVersion !== build.version) return answer('refused', 'contract-mismatch', 'The storage preflight does not describe this build.');
  if (build.preflight.state?.problem) return answer('refused', 'storage-state-invalid', build.preflight.state.problem.message);
  const cutover = cutoverDomains(manifest);

  /** The version that runs instead of this build (an update's previous) must take over every domain it imports. */
  const previousCheck = async (version: string) => {
    const check = cutover.length ? preparationCheck(manifest, await probe(versionDirectory(stateDir, version), version)) : preparationCheck(manifest, { state: 'missing' });
    evidence.previous = { version, check };
    return check;
  };
  const refusedFor = (check: PreparationCheck) => answer('refused', check.state === 'prerequisite-required' ? 'prerequisite-required' : `previous-${check.state}`, check.reason ?? 'The previous version cannot take this build\'s storage over.', check.prepare ? { prepare: check.prepare } : {});
  /** No hold, no helper, and `current` running this very build: the state an update leaves once it is kept. */
  const settled = async (): Promise<StorageUpdateEvaluation | undefined> => {
    if (hold.state === 'unreadable') return answer('recovery-required', 'hold-unreadable', `The update hold cannot be read: ${hold.reason}`);
    if (hold.state === 'present') return answer('update-held', 'hold-present', 'The update hold is still in place.');
    if (helper.state === 'unreadable' || helper.state === 'invalid') return answer('recovery-required', 'helper-unreadable', `The update helper lock cannot be told: ${helper.reason}`);
    if (helper.state === 'running') return answer('update-held', 'helper-running', `Update helper ${helper.pid} still runs.`);
    if (!managed) return undefined;
    if (current.state !== 'version') return answer('recovery-required', 'current-pointer', `The service's current version cannot be told (${current.state}).`);
    if (current.version !== build.version) return answer('recovery-required', 'current-pointer', `The service starts ${current.version}, not this build.`);
    const artifact = await probe(versionDirectory(stateDir, build.version), build.version);
    evidence.currentArtifact = artifact;
    if (artifact.state !== 'contract' || artifact.contract.identity.sourceHash !== identity.sourceHash || artifact.contract.identity.manifestDigest !== identity.manifestDigest) {
      return answer('recovery-required', 'current-artifact', artifact.state === 'contract' ? 'The installed current version is another build than the one running.' : `The installed current version's storage contract cannot be confirmed (${artifact.state}).`);
    }
    return undefined;
  };

  if (update.state === 'unreadable') return answer('recovery-required', 'update-status-unreadable', `The update record cannot be read: ${update.reason}`);
  if (update.state === 'invalid') return answer('recovery-required', 'update-status-invalid', update.reason);
  const record = update.state === 'absent' ? undefined : update.update;
  const receiptFor = (kind: UpdateRecoveryReceipt['kind']) => receipt.state === 'present' && update.state !== 'absent' && receipt.receipt.kind === kind
    && receipt.receipt.recordSha256 === update.sha256 && receipt.receipt.build.sourceHash === identity.sourceHash && receipt.receipt.build.appVersion === build.version
    && receipt.receipt.pointer === (current.state === 'version' ? current.version : null);

  if (managed && record) {
    if (record.version === build.version) {
      // A refusal decides even while verifying: the helper must see it and go back before anything is imported.
      const check = await previousCheck(record.previous);
      if (check.state !== 'not-required' && check.state !== 'satisfied') return refusedFor(check);
      if (update.state === 'active') return answer('update-held', 'update-verifying', `The update to ${record.version} is still being verified; storage changes wait until it is kept.`);
      if (record.stage === 'failed') {
        const back = record.code !== 'rollback-failed' && current.state === 'version' && current.version === record.previous;
        const preImportRefused = back && input.cutoverMarkers === 'absent';
        return answer('recovery-required', preImportRefused ? 'pre-import-refused' : record.code === 'rollback-failed' ? 'own-update-rollback-failed' : 'own-update-failed',
          preImportRefused ? `This build's own update failed and went back to ${record.previous} before it imported anything.` : 'This build\'s own update failed; only the owner can recover it.',
          preImportRefused ? { preImportRefused } : {});
      }
      return await settled() ?? answer('ready', 'service-update-done', `The update to ${build.version} was kept, and the service runs this build.`);
    }
    if (update.state === 'active') return answer('update-held', 'other-update-active', `An update to ${record.version} is under way.`);
    if (record.previous === build.version) {
      // A later update that ended here: it does not prove this build was ever kept. The owner verifies it again.
      if (receiptFor('overwritten-done')) return await settled() ?? answer('ready', 'owner-receipt', 'The owner verified this build again after a later update went back to it.');
      return answer('recovery-required', record.stage === 'failed' && record.code !== 'rollback-failed' ? 'done-overwritten' : 'later-update-recorded',
        `The last update (${record.version}) started from this build; whether this build was kept has to be verified by the owner.`);
    }
    // The record belongs to builds unrelated to this one (a service installed by hand): this start is a direct one.
  }
  if (!managed && record) {
    if (update.state === 'active' && !receiptFor('stale-active')) return answer('recovery-required', 'stale-active-update', `An update to ${record.version} is recorded as under way, and nothing here settles it; the owner verifies it first.`);
    if (record.version === build.version && record.stage === 'failed') return answer('recovery-required', 'own-update-failed', 'This build\'s own update failed; only the owner can recover it.');
  }
  if (record && record.stage === 'failed' && record.code === 'rollback-failed') return answer('recovery-required', 'rollback-failed-recorded', 'The last update could not go back; the owner verifies the service first.');

  // A direct start: no update record of this build, or a verified terminal one of another build.
  const unsettled = await settled();
  if (unsettled) return unsettled;
  if (!cutover.length) return answer('ready', 'no-cutover', 'This build imports no domain; its own storage may be prepared.');
  const preparation = await Promise.all(cutover.map(async domain => ({ domain: domain.scope, read: await readPreparationEvidence(stateDir, domain.scope) })));
  evidence.preparation = preparation;
  const unproven = preparation.filter(({ domain, read }) => {
    const declared = cutover.find(item => item.scope === domain)!;
    return read.state !== 'present' || !preparesDomain(declared, { appVersion: read.evidence.preparationVersion, schemaVersion: read.evidence.schema.version, schemaDigest: read.evidence.schema.digest, readerContract: read.evidence.readerContract, writerContract: read.evidence.writerContract });
  });
  if (!unproven.length) return answer('ready', 'direct-evidence', 'A preparation release recorded evidence for every domain this build imports.');
  const unreadable = unproven.find(item => item.read.state === 'unreadable' || item.read.state === 'invalid');
  if (unreadable) return answer('recovery-required', 'preparation-evidence-unreadable', `The preparation evidence of ${unreadable.domain} cannot be used.`);
  const state = build.preflight.state;
  const fresh = state && !state.problem && state.database === 'absent' && !state.sidecars.length && state.identity === 'absent' && input.legacyFiles
    && (await Promise.all(unproven.map(item => input.legacyFiles!(item.domain).catch(() => 'present' as const)))).every(found => found === 'absent');
  if (fresh) return answer('ready', 'new-state', 'A new state directory: there is nothing to import.');
  if (state && state.database === 'absent' && state.identity !== 'absent') return answer('recovery-required', 'known-storage-missing', 'The storage this state directory records is missing; it is not replaced by a new one.');
  const prepare = unproven.map(item => cutover.find(domain => domain.scope === item.domain)!.preparation.requiredArtifactVersion).reduce((a, b) => newerVersion(b, a) ? b : a);
  return answer('refused', 'prerequisite-required', `Run ${prepare} here first: no preparation evidence covers ${unproven.map(item => item.domain).join(', ')}.`, { prepare });
}

/** What `/api/health` adds, and its status: 503 only for a refusal, with the identity kept beside it. */
export interface StorageHealth { state: StorageUpdateVerdict; code: string; importAllowed: boolean; reason: string; prepare?: string }
export function storageHealth(evaluation: StorageUpdateEvaluation): { status: 200 | 503; storage: StorageHealth } {
  return {
    status: evaluation.verdict === 'refused' ? 503 : 200,
    storage: { state: evaluation.verdict, code: evaluation.code, importAllowed: evaluation.importAllowed, reason: evaluation.reason, ...(evaluation.prepare ? { prepare: evaluation.prepare } : {}) },
  };
}

// ---- Owner recovery of an update record that does not prove this build. ----

export type ReceiptOutcome = { recorded: true; receipt: UpdateRecoveryReceipt } | { recorded: false; code: string; reason: string };

/**
 * The owner's explicit re-verification: checks the record, the service's pointer and installed build, the helper,
 * hold and lock, and this build's runtime and contract, and records a receipt only when every one of them holds. No
 * failure is ignored by a flag: a record of another shape, or anything that cannot be read, records nothing.
 */
export async function recordUpdateRecoveryReceipt(input: StorageUpdateInput & { kind: UpdateRecoveryReceipt['kind']; by: string; evidence: string }): Promise<ReceiptOutcome> {
  const refuse = (code: string, reason: string): ReceiptOutcome => ({ recorded: false, code, reason });
  if (!isText(input.by, 200) || !isText(input.evidence, 4096)) return refuse('invalid-request', 'A receipt needs who verified it and the evidence (at most 4096 characters).');
  const { stateDir, build } = input;
  const identity = build.preflight.identity;
  if (!build.preflight.supported || !identity || !build.manifest || identity.manifestDigest !== build.manifest.digest || identity.appVersion !== build.version) {
    return refuse('runtime-unsupported', 'This build\'s storage runtime and contract did not pass their preflight.');
  }
  const probe = input.probe ?? probeInstalledArtifact;
  const [update, hold, helper, current] = await Promise.all([readUpdateRecord(stateDir), readHold(stateDir, input.now), readHelperLock(stateDir), readCurrentPointer(stateDir)]);
  if (update.state === 'absent' || update.state === 'unreadable' || update.state === 'invalid') return refuse('update-status', `The update record is ${update.state}; there is nothing this receipt could verify.`);
  if (hold.state !== 'absent') return refuse('hold', `The update hold is ${hold.state}.`);
  if (helper.state !== 'absent' && helper.state !== 'gone') return refuse('helper', `The update helper lock is ${helper.state}.`);
  if (current.state === 'unreadable' || current.state === 'invalid') return refuse('current-pointer', `The service's current version is ${current.state}.`);
  const record = update.update;
  if (input.kind === 'overwritten-done') {
    if (!input.managed) return refuse('not-service', 'Only the background service keeps a current version to verify.');
    if (update.state !== 'terminal' || record.stage !== 'failed' || record.code === 'rollback-failed') return refuse('not-overwritten', 'Only a later update that failed and went back is verified this way.');
    if (record.previous !== build.version || !newerVersion(record.version, build.version)) return refuse('not-overwritten', `The last update went back to ${record.previous}, not to this build.`);
    if (current.state !== 'version' || current.version !== build.version) return refuse('current-pointer', 'The service does not start this build.');
    const artifact = await probe(versionDirectory(stateDir, build.version), build.version);
    if (artifact.state !== 'contract' || artifact.contract.identity.sourceHash !== identity.sourceHash || artifact.contract.identity.manifestDigest !== identity.manifestDigest) return refuse('current-artifact', 'The installed current version is not the build running here.');
  } else {
    if (input.managed) return refuse('service', 'The service settles its own interrupted updates; a stale record is verified only where nothing does.');
    if (update.state !== 'active') return refuse('not-active', 'The update record is not left active.');
  }
  const receipt: UpdateRecoveryReceipt = {
    format: 'tower-update-recovery-receipt', version: 1, kind: input.kind, recordSha256: update.sha256, update: record, build: { ...identity },
    pointer: current.state === 'version' ? current.version : null, by: input.by, evidence: input.evidence, recordedAt: new Date(input.now ?? Date.now()).toISOString(),
  };
  await writePrivateJson(storageUpdatePaths(stateDir).receipt, JSON.stringify(receipt, null, 2), { syncDirectory: true });
  return { recorded: true, receipt };
}

// ---- Staged updates: a preparation release before the release that imports. ----

/** How far one computer got toward `target` through its preparation release; kept by whoever asks (controller, deploy agent). */
export interface ChainProgress { target: string; prerequisite?: string; attempts: Record<string, number> }
export type ChainStep =
  | { action: 'done' }
  | { action: 'wait'; reason: string }
  | { action: 'request'; version: string }
  | { action: 'blocked'; code: 'prerequisite-required' | 'attempts-exhausted' | 'invalid-chain'; version?: string; reason: string };
export const CHAIN_ATTEMPTS = 3;

/**
 * What to ask a computer next. A target that needs its preparation release first (its own failed update says so, or
 * the caller knows it from the target's manifest) is asked for only after that release runs there; a computer already
 * past it goes to the target directly. Versions only move forward, and each version is asked for at most `limit` times;
 * after that the chain waits for the owner (prerequisite-required stays an owner action).
 */
export function nextChainStep(input: { running: string; update?: SavedUpdate; progress: ChainProgress; limit?: number }): ChainStep {
  const { running, update, progress } = input;
  const limit = input.limit ?? CHAIN_ATTEMPTS;
  if (!RELEASE.test(progress.target) || !RELEASE.test(running)) return { action: 'blocked', code: 'invalid-chain', reason: 'Only released versions are asked for.' };
  if (!newerVersion(progress.target, running)) return { action: 'done' };
  if (updateActive(update)) return { action: 'wait', reason: `An update to ${update!.version} is under way.` };
  const learned = update?.stage === 'failed' && update.version === progress.target && update.storage?.code === 'prerequisite-required' ? update.storage.prepare : undefined;
  const prerequisite = progress.prerequisite ?? learned;
  if (prerequisite && !newerVersion(progress.target, prerequisite)) return { action: 'blocked', code: 'invalid-chain', version: prerequisite, reason: `The preparation release ${prerequisite} is not older than ${progress.target}.` };
  const version = prerequisite && newerVersion(prerequisite, running) ? prerequisite : progress.target;
  if ((progress.attempts[version] ?? 0) >= limit) {
    return { action: 'blocked', code: version === prerequisite ? 'prerequisite-required' : 'attempts-exhausted', version, reason: `${version} was asked for ${limit} times; the owner decides what happens next.` };
  }
  return { action: 'request', version };
}
/** The progress after asking for `version`, with what the computer's failed update taught about its prerequisite. */
export function chainAsked(progress: ChainProgress, version: string, update?: SavedUpdate): ChainProgress {
  const learned = update?.stage === 'failed' && update.version === progress.target && update.storage?.code === 'prerequisite-required' ? update.storage.prepare : undefined;
  return { ...progress, ...(progress.prerequisite ?? learned ? { prerequisite: progress.prerequisite ?? learned } : {}), attempts: { ...progress.attempts, [version]: (progress.attempts[version] ?? 0) + 1 } };
}

// ---- The owner's validated rollback. ----

/** What the rollback needs from the worker and the service. None of these cancels a provider, a turn or a shell. */
export interface RollbackPorts {
  /** The live database as its worker sees it (StorageClient.inspect). Throws when it cannot be read: never an empty one. */
  inspectStorage(): Promise<Pick<StorageInspection, 'schema' | 'authority'>>;
  /** Holds new admissions and automation pumps (no cancel, no force deadline). Repeating it with the same ID is one hold. */
  holdAdmission(id: string, reason: string): Promise<void>;
  releaseAdmission(id: string): Promise<void>;
  /**
   * Waits for running providers and transient calls to end by themselves. `pending` while a legacy worker's terminal
   * lives (its input and attach go on) or work still runs: the rollback waits and is asked again later.
   */
  waitQuiet(id: string): Promise<{ state: 'quiet' } | { state: 'pending'; reason: string }>;
  /** Restarts the service's web, which then starts from `current`. */
  restartWeb(): Promise<void>;
  /** The lower-version patient handoff to the target's worker; answers the worker that runs afterwards. */
  handoff(target: { version: string; entry: string; sourceHash: string }): Promise<{ version: string; sourceHash?: string; pid: number }>;
}
export interface RollbackContext {
  stateDir: string;
  running: RunningBuild;
  managed: boolean;
  ports: RollbackPorts;
  /** Runs `work` in turn with update requests and pruning (Updates.exclusive), so neither moves the target meanwhile. */
  serialize<T>(work: () => Promise<T>): Promise<T>;
  probe?: ArtifactProbe;
  now?: () => number;
}

export type RollbackState = 'pinned' | 'held' | 'waiting' | 'switched' | 'handing-off' | 'completed' | 'failed' | 'withdrawn';
const ROLLBACK_ACTIVE: ReadonlySet<RollbackState> = new Set(['pinned', 'held', 'waiting', 'switched', 'handing-off']);
const ROLLBACK_STATES: ReadonlySet<string> = new Set([...ROLLBACK_ACTIVE, 'completed', 'failed', 'withdrawn']);
export interface RollbackRecord {
  format: 'tower-storage-rollback';
  version: 1;
  id: string;
  from: string;
  target: string;
  sourceHash: string;
  state: RollbackState;
  by: string;
  reason: string;
  /** Set once admissions were held; cleared when they were released. */
  held: boolean;
  /** Set once `current` was pointed at the target. */
  switched: boolean;
  pending?: string;
  failure?: { phase: string; message: string };
  worker?: { version: string; sourceHash: string; pid: number };
  startedAt: string;
  updatedAt: string;
}
export type RollbackRead = { state: 'absent' } | { state: 'present'; record: RollbackRecord } | { state: 'invalid'; reason: string } | { state: 'unreadable'; reason: string };
export async function readRollbackRecord(stateDir: string): Promise<RollbackRead> {
  let bytes: Buffer | undefined;
  try { bytes = await readExact(storageUpdatePaths(stateDir).rollback); } catch (error) { return { state: 'unreadable', reason: messageOf(error) }; }
  if (!bytes) return { state: 'absent' };
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { return { state: 'invalid', reason: 'The rollback record is not JSON.' }; }
  if (!isObject(value) || value.format !== 'tower-storage-rollback' || value.version !== 1 || !isText(value.id, 64) || !RELEASE.test(String(value.from)) || !RELEASE.test(String(value.target))
    || !SHA256.test(String(value.sourceHash)) || !ROLLBACK_STATES.has(String(value.state)) || typeof value.held !== 'boolean' || typeof value.switched !== 'boolean' || !isTime(value.startedAt) || !isTime(value.updatedAt)) {
    return { state: 'invalid', reason: 'The rollback record has an unknown format.' };
  }
  return { state: 'present', record: value as unknown as RollbackRecord };
}
const saveRollback = (stateDir: string, record: RollbackRecord) => writePrivateJson(storageUpdatePaths(stateDir).rollback, JSON.stringify(record, null, 2), { syncDirectory: true });

export type RollbackValidation =
  | { ok: true; target: { version: string; directory: string; entry: string; entrySha256: string; contract: ArtifactStorageContract } }
  | { ok: false; code: string; reason: string };

const entryHash = async (entry: string) => sha256((await readExact(entry, 64 * 1024 * 1024))!);

/**
 * Whether the live database's whole schema and authority are within what `contract` reads and writes, without
 * migrating, importing or recovering anything: every applied scope at exactly the target's version and digest, and
 * every domain the database is authoritative for with reader and writer contracts the target covers.
 */
export function databaseSupported(contract: ArtifactStorageContract, inspection: Pick<StorageInspection, 'schema' | 'authority'>): { ok: true } | { ok: false; reason: string } {
  const scopes = new Map([[contract.manifest.core.scope, contract.manifest.core] as const, ...contract.manifest.domains.map(domain => [domain.scope, domain] as const)]);
  const applied = inspection.schema.kind === 'empty' ? [] : inspection.schema.applied;
  if (inspection.schema.kind === 'behind') return { ok: false, reason: 'The database has migrations pending; it is not rolled back mid-migration.' };
  const byScope = new Map<string, typeof applied>();
  for (const row of applied) byScope.set(row.scope, [...(byScope.get(row.scope) ?? []), row]);
  for (const [scope, rows] of byScope) {
    const declared = scopes.get(scope);
    if (!declared) return { ok: false, reason: `${contract.appVersion} does not know the database's ${scope} tables.` };
    const ordered = [...rows].sort((a, b) => a.version - b.version);
    if (ordered.some((row, index) => row.version !== index + 1)) return { ok: false, reason: `The database's ${scope} migrations are not 1..n.` };
    if (ordered.length !== declared.schemaVersion || sha256(ordered.map(row => row.checksum).join('\n')) !== declared.schemaDigest) {
      return { ok: false, reason: `${contract.appVersion} declares ${scope} at version ${declared.schemaVersion} with other migrations than the database's ${ordered.length}.` };
    }
  }
  for (const row of inspection.authority) {
    const declared = contract.manifest.domains.find(domain => domain.scope === row.domain);
    if (!declared) return { ok: false, reason: `${contract.appVersion} does not know the ${row.domain} domain the database holds.` };
    if (row.authority === 'database' && (declared.preparation.readerContract < row.readerContract || declared.preparation.writerContract < row.writerContract)) {
      return { ok: false, reason: `${contract.appVersion} does not read and write ${row.domain} as the database stores it.` };
    }
  }
  return { ok: true };
}

/** Everything a rollback to `target` needs, read-only: nothing is pinned, held, pointed or handed over. */
export async function validateRollback(context: RollbackContext, request: { target: string }): Promise<RollbackValidation> {
  const { stateDir, running } = context;
  const refuse = (code: string, reason: string): RollbackValidation => ({ ok: false, code, reason });
  if (!context.managed) return refuse('not-service', 'Only the background service rolls back; a Tower run by hand starts the older version directly instead.');
  if (!RELEASE.test(request.target) || !newerVersion(running.version, request.target)) return refuse('not-lower', 'A rollback goes to an older released version; a newer one is an update.');
  const [update, helper, hold, pin] = await Promise.all([readUpdateRecord(stateDir), readHelperLock(stateDir), readHold(stateDir), readStoragePin(stateDir)]);
  if (update.state === 'unreadable' || update.state === 'invalid') return refuse('update-status', `The update record is ${update.state}; recover it first.`);
  if (update.state === 'active') return refuse('update-active', `An update to ${update.update.version} is under way; it is settled first.`);
  if (helper.state === 'running' || helper.state === 'unreadable' || helper.state === 'invalid') return refuse('update-helper', `The update helper is ${helper.state}; it is settled first.`);
  if (hold.state !== 'absent') return refuse('update-hold', `The update hold is ${hold.state}; it is settled first.`);
  if (pin.state === 'unreadable' || pin.state === 'invalid') return refuse('pin', `The version pin is ${pin.state}; the owner inspects it first.`);
  if (pin.state === 'present' && pin.pin.pinned !== request.target) return refuse('pinned-elsewhere', `The service is pinned to ${pin.pin.pinned}; the owner releases that pin first.`);
  if (running.preflight.state?.recovery && running.preflight.state.recovery.state !== 'clear') return refuse('recovery-held', 'A snapshot recovery holds the storage; it is finished first.');
  const directory = versionDirectory(stateDir, request.target);
  const artifact = await (context.probe ?? probeInstalledArtifact)(directory, request.target);
  if (artifact.state === 'missing') return refuse('target-missing', `${request.target} is not installed.`);
  if (artifact.state === 'legacy') return refuse('target-no-contract', `${request.target} keeps its state in JSON only and cannot read this storage.`);
  if (artifact.state === 'unverifiable') return refuse('target-unverifiable', artifact.reason);
  if (!artifact.contract.supported) return refuse('target-runtime-unsupported', `${request.target}'s storage does not run here${artifact.contract.refusal ? `: ${artifact.contract.refusal.message}` : '.'}`);
  let inspection: Pick<StorageInspection, 'schema' | 'authority'>;
  try { inspection = await context.ports.inspectStorage(); } catch (error) { return refuse('storage-uninspectable', `The database could not be read to compare: ${messageOf(error)}`); }
  const supported = databaseSupported(artifact.contract, inspection);
  if (!supported.ok) return refuse('target-incompatible', supported.reason);
  const entry = entryPoint(directory);
  let entrySha256: string;
  try { entrySha256 = await entryHash(entry); } catch (error) { return refuse('target-unverifiable', messageOf(error)); }
  return { ok: true, target: { version: request.target, directory, entry, entrySha256, contract: artifact.contract } };
}

export type RollbackOutcome = { state: RollbackState; record: RollbackRecord } | { state: 'refused'; code: string; reason: string };

/**
 * The owner's rollback, one shared executor: validate (read-only), pin the target privately and durably, hold new
 * admissions and automation, wait for running work to end by itself, point `current` at the target and restart the
 * web, then hand the worker over to the target's (a patient lower-version handoff) and check the worker that answers.
 * The web restart ends the web that started it; the target's web resumes from the record (resumeRollback).
 *
 * A failure releases the admission hold it took; the pin stays until the owner releases it, so nothing reinstalls the
 * newer version meanwhile. Asking again retries from where the record stands.
 */
export async function runRollback(context: RollbackContext, request: { target: string; by: string; reason: string }): Promise<RollbackOutcome> {
  const { stateDir } = context;
  const now = () => new Date(context.now?.() ?? Date.now()).toISOString();
  const existing = await readRollbackRecord(stateDir);
  if (existing.state === 'unreadable' || existing.state === 'invalid') return { state: 'refused', code: 'rollback-record', reason: `The rollback record is ${existing.state}; the owner inspects it first.` };
  if (existing.state === 'present') {
    const record = existing.record;
    if (ROLLBACK_ACTIVE.has(record.state) && record.target !== request.target) return { state: 'refused', code: 'rollback-in-progress', reason: `Rollback ${record.id} to ${record.target} is under way.` };
    if (record.target === request.target && (record.state === 'completed' || record.switched)) return record.state === 'completed' ? { state: 'completed', record } : resumeRollback(context);
  }
  if (!isText(request.by, 200) || typeof request.reason !== 'string' || request.reason.length > 2000) return { state: 'refused', code: 'invalid-request', reason: 'A rollback names who asked for it.' };
  const validation = await validateRollback(context, request);
  if (!validation.ok) return { state: 'refused', code: validation.code, reason: validation.reason };
  const { target } = validation;
  const resumed = existing.state === 'present' && existing.record.target === request.target && existing.record.state !== 'withdrawn' ? existing.record : undefined;
  let record: RollbackRecord = resumed ? { ...resumed, failure: undefined, pending: undefined } : {
    format: 'tower-storage-rollback', version: 1, id: `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`, from: context.running.version, target: target.version,
    sourceHash: target.contract.identity.sourceHash, state: 'pinned', by: request.by, reason: request.reason, held: false, switched: false, startedAt: now(), updatedAt: now(),
  };
  const save = async (next: Partial<RollbackRecord>) => { record = { ...record, ...next, updatedAt: now() }; await saveRollback(stateDir, record); };
  // The pin first, in turn with pruning and update requests, over the artifact just validated.
  const pinned = await context.serialize(async () => {
    const again = await (context.probe ?? probeInstalledArtifact)(target.directory, target.version);
    const sameBuild = again.state === 'contract' && again.contract.identity.sourceHash === target.contract.identity.sourceHash;
    if (!sameBuild || await entryHash(target.entry).catch(() => '') !== target.entrySha256) return false;
    const pin = await readStoragePin(stateDir);
    // A pin left on this version by an earlier rollback stands only over the very build just validated.
    if (pin.state !== 'absent' && !(pin.state === 'present' && pin.pin.pinned === target.version
      && pin.pin.sourceHash === target.contract.identity.sourceHash && pin.pin.entrySha256 === target.entrySha256)) return false;
    if (pin.state === 'absent') {
      const value: StoragePin = { format: 'tower-storage-pin', version: 1, pinned: target.version, sourceHash: target.contract.identity.sourceHash, manifestDigest: target.contract.identity.manifestDigest,
        entrySha256: target.entrySha256, rollbackId: record.id, by: request.by, reason: request.reason.slice(0, 2000), at: now() };
      await writePrivateJson(storagePinPath(stateDir), JSON.stringify(value, null, 2), { syncDirectory: true });
    }
    await save({ state: 'pinned' });
    return true;
  });
  if (!pinned) return { state: 'refused', code: 'target-changed', reason: `${target.version} changed while the rollback was validated; nothing was pinned.` };
  const fail = async (phase: string, error: unknown): Promise<RollbackOutcome> => {
    let held = record.held;
    if (held) held = !await context.ports.releaseAdmission(record.id).then(() => true, () => false);
    await save({ state: 'failed', held, failure: { phase, message: messageOf(error).slice(0, 2000) } });
    return { state: 'failed', record };
  };
  try { await context.ports.holdAdmission(record.id, `Rolling back to ${target.version}`); } catch (error) { await save({ held: true }); return fail('hold', error); }
  await save({ state: 'held', held: true });
  let quiet: Awaited<ReturnType<RollbackPorts['waitQuiet']>>;
  try { quiet = await context.ports.waitQuiet(record.id); } catch (error) { return fail('quiet', error); }
  if (quiet.state === 'pending') { await save({ state: 'waiting', pending: quiet.reason.slice(0, 500) }); return { state: 'waiting', record }; }
  try { await context.serialize(() => pointRollbackTarget(stateDir, target.version)); } catch (error) { return fail('switch', error); }
  await save({ state: 'switched', switched: true, pending: undefined });
  try { await context.ports.restartWeb(); } catch (error) {
    // launchd starts the web again by itself; whether the target's web resumes decides.
    await save({ failure: { phase: 'restart', message: messageOf(error).slice(0, 2000) } });
  }
  return { state: 'switched', record };
}

/**
 * Continues a rollback whose `current` already points at its target: the target's web calls this when it starts. It
 * hands the worker over (patiently) and keeps the rollback only when the worker that answers is the pinned build.
 */
export async function resumeRollback(context: Omit<RollbackContext, 'running' | 'managed'> & { running?: RunningBuild; managed?: boolean }): Promise<RollbackOutcome> {
  const { stateDir } = context;
  const now = () => new Date(context.now?.() ?? Date.now()).toISOString();
  const read = await readRollbackRecord(stateDir);
  if (read.state !== 'present') return { state: 'refused', code: 'rollback-record', reason: `There is no rollback to continue (${read.state}).` };
  let record = read.record;
  if (record.state === 'completed') return { state: 'completed', record };
  if (!record.switched) return { state: 'refused', code: 'not-switched', reason: 'The rollback has not switched the service yet.' };
  const save = async (next: Partial<RollbackRecord>) => { record = { ...record, ...next, updatedAt: now() }; await saveRollback(stateDir, record); };
  const pin = await readStoragePin(stateDir);
  if (pin.state !== 'present' || pin.pin.pinned !== record.target || pin.pin.sourceHash !== record.sourceHash) {
    await save({ state: 'failed', failure: { phase: 'pin', message: 'The pin no longer keeps the rollback target.' } });
    return { state: 'failed', record };
  }
  const entry = entryPoint(versionDirectory(stateDir, record.target));
  if (await entryHash(entry).catch(() => '') !== pin.pin.entrySha256) {
    await save({ state: 'failed', failure: { phase: 'artifact', message: `${record.target}'s installed files changed after they were validated.` } });
    return { state: 'failed', record };
  }
  await save({ state: 'handing-off', failure: undefined });
  let worker: Awaited<ReturnType<RollbackPorts['handoff']>>;
  try { worker = await context.ports.handoff({ version: record.target, entry, sourceHash: record.sourceHash }); } catch (error) {
    let held = record.held;
    if (held) held = !await context.ports.releaseAdmission(record.id).then(() => true, () => false);
    await save({ state: 'failed', held, failure: { phase: 'handoff', message: messageOf(error).slice(0, 2000) } });
    return { state: 'failed', record };
  }
  if (worker.version !== record.target || worker.sourceHash !== record.sourceHash) {
    await save({ state: 'failed', failure: { phase: 'worker', message: `The worker answers as ${worker.version}${worker.sourceHash ? ` (${worker.sourceHash.slice(0, 12)}…)` : ' without a storage identity'}, not the pinned build.` } });
    return { state: 'failed', record };
  }
  // The hold belonged to the worker that handed over; its successor starts with its own admission.
  await save({ state: 'completed', held: false, worker: { version: worker.version, sourceHash: worker.sourceHash, pid: worker.pid } });
  return { state: 'completed', record };
}

/**
 * The owner withdraws a rollback that has not switched the service: the admission hold is released and the pin stays
 * unless the owner releases it too, as a separate explicit step (`releasePin`).
 */
export async function withdrawRollback(context: Pick<RollbackContext, 'stateDir' | 'ports' | 'now'>, input: { releasePin?: boolean } = {}): Promise<RollbackOutcome> {
  const read = await readRollbackRecord(context.stateDir);
  if (read.state !== 'present') return { state: 'refused', code: 'rollback-record', reason: `There is no rollback to withdraw (${read.state}).` };
  let record = read.record;
  if (record.switched) return { state: 'refused', code: 'rollback-switched', reason: 'The service already starts the rollback target; moving on is an update once the owner releases the pin.' };
  if (record.state === 'withdrawn' || record.state === 'completed') return { state: record.state, record };
  let held = record.held;
  if (held) held = !await context.ports.releaseAdmission(record.id).then(() => true, () => false);
  record = { ...record, state: 'withdrawn', held, pending: undefined, updatedAt: new Date(context.now?.() ?? Date.now()).toISOString() };
  await saveRollback(context.stateDir, record);
  if (held) return { state: 'refused', code: 'hold-not-released', reason: 'The rollback is withdrawn, but the admission hold could not be released; ask again.' };
  if (input.releasePin) await releaseStoragePin(context.stateDir, { version: record.target });
  return { state: 'withdrawn', record };
}

/** Versions pruning keeps for the storage: the pinned one, and the target of a rollback that has not ended. A pin or rollback that cannot be read keeps everything. */
export async function storageKeptVersions(stateDir: string): Promise<{ keep: string[] } | { unknown: string }> {
  const [pin, rollback] = await Promise.all([readStoragePin(stateDir), readRollbackRecord(stateDir)]);
  if (pin.state === 'unreadable' || pin.state === 'invalid') return { unknown: `The version pin is ${pin.state}.` };
  if (rollback.state === 'unreadable' || rollback.state === 'invalid') return { unknown: `The rollback record is ${rollback.state}.` };
  return { keep: [...pin.state === 'present' ? [pin.pin.pinned] : [], ...rollback.state === 'present' && rollback.record.state !== 'withdrawn' ? [rollback.record.target, rollback.record.from] : []] };
}
