import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readlink, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { UpdateFailure, UpdateStage, UpdateStatus } from '../../shared/link.js';
import type { DomainManifest, RuntimeInfo, StorageBuildIdentity, StorageBuildManifest, StorageInspection } from '../storage/contract.js';
import type { StoragePreflight } from '../storage/preflight.js';
import { manifestDigest } from '../storage/schema.js';
import { privateDirectory, privateFile, storageLayout, writePrivateDocument } from '../storage/paths.js';
import { writePrivateJson } from '../stores/private-json.js';
import { processStart } from '../instance/process-start.js';
import { entryPoint, newerVersion, pointRollbackTarget, runtimePaths, versionDirectory } from './service.js';
import { readExact as readExactly, readStoragePin, storagePinPath, withStorageTransition, type PinRead, type StoragePin } from './storage-transition-lock.js';

export { readStoragePin, withStorageTransition, type PinRead, type StoragePin } from './storage-transition-lock.js';

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

/**
 * Why a candidate's storage check failed, as an update record keeps it. `previous-incompatible`: the version it would
 * go back to cannot take its storage over, and no release between them could prepare it (core, protocol, a scope).
 */
export type StorageUpdateFailure = 'prerequisite-required' | 'previous-incompatible' | 'contract-unverifiable' | 'target-runtime-unsupported';
/** What this computer keeps about its update; `controllers` (linked when it switched) stays here. */
export interface SavedUpdate extends UpdateStatus {
  controllers?: string[];
  /** Set when the target's storage contract stopped the update before anything switched. */
  storage?: { code: StorageUpdateFailure; prepare?: string; domains?: string[] };
}

const ACTIVE: ReadonlySet<UpdateStage> = new Set(['installing', 'checking', 'switching', 'verifying', 'rolling-back']);
const STAGES: ReadonlySet<string> = new Set([...ACTIVE, 'done', 'failed']);
const FAILURES: ReadonlySet<UpdateFailure> = new Set(['low-disk', 'install-failed', 'check-failed', 'switch-failed', 'start-failed', 'link-failed', 'rollback-failed', 'interrupted']);
const STORAGE_FAILURES: ReadonlySet<string> = new Set(['prerequisite-required', 'previous-incompatible', 'contract-unverifiable', 'target-runtime-unsupported']);
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
const readExact = (path: string, maxBytes = MAX_RECORD_BYTES) => readExactly(path, maxBytes);

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

/**
 * The handoff hold, without removing it however old it is. Only a plain file there is a hold: a link (even one to
 * nowhere, which looking through it would take for a missing hold) or anything else is `unreadable`, never absent or
 * present. A hold written just after the look found none is answered absent, as it was then; the next look sees it.
 */
export type HoldRead = { state: 'absent' } | { state: 'present'; ageMs: number } | { state: 'unreadable'; reason: string; error: unknown };
export async function readHold(stateDir: string, now = Date.now()): Promise<HoldRead> {
  const path = updatePaths(stateDir).hold;
  const unreadable = (error: unknown): HoldRead => ({ state: 'unreadable', reason: messageOf(error), error });
  const notAHold = (info: Stats) => unreadable(Object.assign(new Error(`${path} is ${info.isSymbolicLink() ? 'a link' : 'not a regular file'}; it is left as it is.`), { code: info.isSymbolicLink() ? 'ELOOP' : 'ENOTFILE' }));
  try { await stat(path); } catch (error) {
    if (!missing(error)) return unreadable(error);
    // Missing through the path: only the path itself tells a missing hold from a link to nowhere.
    const own = await lstat(path).catch((failure: unknown) => failure as NodeJS.ErrnoException);
    if (own instanceof Error) return missing(own) ? { state: 'absent' } : unreadable(own);
    return own.isSymbolicLink() || !own.isFile() ? notAHold(own) : { state: 'absent' };
  }
  let info: Stats;
  try { info = await lstat(path); } catch (error) { return missing(error) ? { state: 'absent' } : unreadable(error); }
  if (!info.isFile()) return notAHold(info);
  return { state: 'present', ageMs: Math.max(0, now - info.mtimeMs) };
}

/** Whether a process is still running. */
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
/**
 * The helper lock's owner: `running` while its pid runs as the process that took it (a pid whose start cannot be told
 * counts as running), `gone` once it does not. `invalid`: a lock without an owner in it; `unreadable`: one that is
 * there and cannot be read (a link, even to nowhere, included: it is never followed), which may still belong to a helper.
 */
export type HelperRead =
  | { state: 'absent' } | { state: 'running'; pid: number } | { state: 'gone'; pid: number }
  | { state: 'invalid'; reason: string } | { state: 'unreadable'; reason: string; error: unknown };
export async function readHelperLock(stateDir: string, started: (pid: number) => Promise<string | undefined> = processStart): Promise<HelperRead> {
  let text: string;
  try {
    const bytes = await readExact(updatePaths(stateDir).lock, 4096);
    if (!bytes) return { state: 'absent' };
    text = bytes.toString('utf8');
  } catch (error) {
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
  /**
   * `not-required`: the build imports no domain. Only `not-required` and `satisfied` let it go ahead.
   * `prerequisite-required`: a release between the two prepares what is missing. `incompatible`: none could.
   */
  state: 'not-required' | 'satisfied' | 'prerequisite-required' | 'incompatible' | 'missing' | 'unverifiable' | 'runtime-unsupported';
  /** The preparation release to install first: the newest one an unsatisfied scope requires. */
  prepare?: string;
  /** The scopes concerned: the domains target imports, or those the previous version does not take over. */
  domains: string[];
  reason?: string;
}

/**
 * What `previous` (a build's manifest, of version `previousVersion`) lacks to take over the storage `target` applies once
 * it imports: the same storage protocol, the same core schema, and every scope target declares (cutover or not: its
 * thread applies them all) at exactly target's version and digest, with at least target's reader and writer contracts;
 * for a domain target imports, `previous` must also be that domain's preparation release or later. A gap names the
 * release that prepares it when that release lies strictly between the two versions.
 */
function takeoverGaps(target: StorageBuildManifest, previous: StorageBuildManifest, previousVersion: string): { scope: string; reason: string; prepare?: string }[] {
  const between = (version: string) => RELEASE.test(version) && newerVersion(version, previousVersion) && newerVersion(target.appVersion, version) ? version : undefined;
  const gaps: { scope: string; reason: string; prepare?: string }[] = [];
  if (previous.protocol !== target.protocol) gaps.push({ scope: 'protocol', reason: `it speaks storage protocol ${previous.protocol}, not ${target.protocol}` });
  if (previous.core.schemaVersion !== target.core.schemaVersion || previous.core.schemaDigest !== target.core.schemaDigest) gaps.push({ scope: 'core', reason: `its core schema is version ${previous.core.schemaVersion}, not this build's ${target.core.schemaVersion} with the same migrations` });
  for (const domain of target.domains) {
    const own = previous.domains.find(item => item.scope === domain.scope);
    const prepared = !!own && own.schemaVersion === domain.schemaVersion && own.schemaDigest === domain.schemaDigest
      && own.preparation.readerContract >= domain.preparation.readerContract && own.preparation.writerContract >= domain.preparation.writerContract
      && (!domain.cutover || atLeast(previousVersion, domain.preparation.requiredArtifactVersion));
    if (!prepared) gaps.push({ scope: domain.scope, reason: `it does not read and write ${domain.scope} as this build stores it`, prepare: between(domain.preparation.requiredArtifactVersion) });
  }
  return gaps;
}

/**
 * Whether the build that would run instead of `target` (the previous version an update goes back to) can take over
 * the storage `target` makes once it imports a domain. A build that imports nothing asks nothing (PR0, and every
 * preparation release: their storage stays where the previous version left it). Otherwise the artifact must state a
 * contract, run on this execPath, and leave no gap (takeoverGaps): the whole schema, not only the imported domains.
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
  if (artifact.state === 'legacy') {
    return newerVersion(newest, artifact.version) && newerVersion(target.appVersion, newest)
      ? { state: 'prerequisite-required', prepare: newest, domains: names, reason: `${artifact.version} keeps its state in JSON only; ${newest} has to run first.` }
      : { state: 'incompatible', domains: names, reason: `${artifact.version} keeps its state in JSON only, and no release between it and ${target.appVersion} prepares ${names.join(', ')}.` };
  }
  const { contract } = artifact;
  const gaps = takeoverGaps(target, contract.manifest, contract.appVersion);
  if (gaps.length) {
    const domains = gaps.map(gap => gap.scope);
    const why = gaps.map(gap => `${gap.scope}: ${gap.reason}`).join('; ');
    if (gaps.some(gap => !gap.prepare)) return { state: 'incompatible', domains, reason: `${contract.appVersion} cannot take this build's storage over, and no release between them prepares it (${why}).` };
    const prepare = gaps.map(gap => gap.prepare!).reduce((a, b) => newerVersion(b, a) ? b : a);
    return { state: 'prerequisite-required', prepare, domains, reason: `${contract.appVersion} cannot take this build's storage over yet (${why}); ${prepare} has to run first.` };
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
 * went back to it (`overwritten-done`), an update left active where no helper can settle it (`stale-active`), or this
 * build's own update that failed before it imported anything, once the owner has it running again (`own-failed`). It
 * names the record (by its bytes), the build and the pointer it was verified with; any change to them voids it.
 */
export type RecoveryReceiptKind = 'overwritten-done' | 'stale-active' | 'own-failed';
const RECEIPT_KINDS: ReadonlySet<string> = new Set<RecoveryReceiptKind>(['overwritten-done', 'stale-active', 'own-failed']);
export interface UpdateRecoveryReceipt {
  format: 'tower-update-recovery-receipt';
  version: 1;
  kind: RecoveryReceiptKind;
  recordSha256: string;
  update: SavedUpdate;
  build: StorageBuildIdentity;
  pointer: string | null;
  /** `own-failed`: the worker's reading of this build's cutover markers when it was verified (none for a build without cutover). */
  cutoverMarkers?: 'absent' | 'not-applicable';
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
  if (!isObject(value) || value.format !== 'tower-update-recovery-receipt' || value.version !== 1 || !RECEIPT_KINDS.has(String(value.kind))
    || (value.cutoverMarkers !== undefined && value.cutoverMarkers !== 'absent' && value.cutoverMarkers !== 'not-applicable') || (value.kind === 'own-failed' && value.cutoverMarkers === undefined)
    || !SHA256.test(String(value.recordSha256)) || updateProblem(value.update) || !isObject(value.build) || !SHA256.test(String(value.build.sourceHash)) || !SHA256.test(String(value.build.manifestDigest))
    || !(value.pointer === null || (typeof value.pointer === 'string' && RELEASE.test(value.pointer))) || !isText(value.by, 200) || !isText(value.evidence, 4096) || !isTime(value.recordedAt)) {
    return { state: 'invalid', reason: 'The recovery receipt has an unknown format.' };
  }
  return { state: 'present', receipt: value as unknown as UpdateRecoveryReceipt };
}

// ---- The owner's pin. ----

/**
 * What an update request, the scheduler, a controller and pruning must respect (the pin itself: StoragePin, read by
 * readStoragePin). `pinned` names the version kept; a pin that cannot be read keeps everything (`unknown`).
 */
export async function pinnedVersion(stateDir: string): Promise<{ state: 'none' } | { state: 'pinned'; version: string } | { state: 'unknown'; reason: string }> {
  const read = await readStoragePin(stateDir);
  if (read.state === 'absent') return { state: 'none' };
  if (read.state === 'present') return { state: 'pinned', version: read.pin.pinned };
  return { state: 'unknown', reason: read.reason };
}

/**
 * The owner releases the pin on `version` (and only that pin). Nothing else changes: the service stays where it is.
 * Only once the rollback that wrote it is over (its record readable, ended, with its admission hold confirmed released)
 * and in the computer's transition turn, so no rollback step or install sees the pin half gone.
 */
export async function releaseStoragePin(stateDir: string, input: { version: string }): Promise<{ released: boolean; reason?: string }> {
  if (inflight.has(resolve(stateDir))) return { released: false, reason: 'A rollback is being carried out right now; ask again once it answers.' };
  return withStorageTransition(stateDir, async () => {
    const read = await readStoragePin(stateDir);
    if (read.state === 'absent') return { released: false, reason: 'No version is pinned.' };
    if (read.state !== 'present') return { released: false, reason: `The pin is left for the owner to inspect: ${read.reason}` };
    if (read.pin.pinned !== input.version) return { released: false, reason: `The pin keeps ${read.pin.pinned}, not ${input.version}.` };
    const rollback = await readRollbackRecord(stateDir);
    if (rollback.state !== 'present') return { released: false, reason: `The rollback record that wrote the pin is ${rollback.state}; the owner inspects it first.` };
    const record = rollback.record;
    if (record.id !== read.pin.rollbackId) return { released: false, reason: `The pin belongs to rollback ${read.pin.rollbackId}, but the record is ${record.id}; the owner inspects them first.` };
    if (rollbackActive(record)) return { released: false, reason: `Rollback ${record.id} to ${record.target} is still under way.` };
    if (record.held) return { released: false, reason: `Rollback ${record.id}'s admission hold was not confirmed released; withdraw it again first.` };
    await rm(storagePinPath(stateDir));
    await syncDirectory(dirname(storagePinPath(stateDir)));
    return { released: true };
  });
}
async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
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
  rollback: RollbackRead;
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

/** Whether the owner's receipt of `kind` covers exactly this record, this build and where `current` points now. */
function receiptCovers(receipt: ReceiptRead, kind: RecoveryReceiptKind, update: UpdateRecordRead, build: { version: string; identity: StorageBuildIdentity }, current: PointerRead): boolean {
  if (receipt.state !== 'present' || (update.state !== 'active' && update.state !== 'terminal')) return false;
  const value = receipt.receipt;
  return value.kind === kind && value.recordSha256 === update.sha256 && value.build.appVersion === build.version
    && value.build.sourceHash === build.identity.sourceHash && value.build.manifestDigest === build.identity.manifestDigest
    && value.pointer === (current.state === 'version' ? current.version : null);
}

/**
 * The owner's rollback to `build`, when its record is about this very build and the update record it was reserved
 * over: the durable authority a rollback target starts on. Undefined when the record is about another build.
 */
function rollbackTo(rollback: RollbackRead, update: UpdateRecordRead, build: { version: string; identity: StorageBuildIdentity }): RollbackRecord | undefined {
  if (rollback.state !== 'present') return undefined;
  const record = rollback.record;
  const updateSha256 = update.state === 'active' || update.state === 'terminal' ? update.sha256 : update.state === 'absent' ? null : undefined;
  return record.target === build.version && record.sourceHash === build.identity.sourceHash && record.manifestDigest === build.identity.manifestDigest
    && updateSha256 !== undefined && record.updateSha256 === updateSha256 && (record.switched || record.state === 'switching') ? record : undefined;
}
/** A rollback to `build` that its worker answered as the pinned build and whose admission hold is released. */
const rollbackKept = (record: RollbackRecord | undefined, identity: StorageBuildIdentity): boolean =>
  record?.state === 'completed' && !record.held && record.worker?.version === record.target && record.worker.sourceHash === identity.sourceHash;

/**
 * Evaluates, read-only, whether this build may change its storage, and what its health answers. One evaluation reads
 * the update record, hold, helper lock, current pointer, recovery receipt, pin and the owner's rollback record, and the
 * installed artifacts it needs (the current one, to know this build is what the service runs; the previous one, when
 * this build imports a domain).
 */
export async function evaluateStorageUpdate(input: StorageUpdateInput): Promise<StorageUpdateEvaluation> {
  const { stateDir, build, managed } = input;
  const now = input.now ?? Date.now();
  const probe = input.probe ?? probeInstalledArtifact;
  const [update, hold, helper, current, receipt, pin, rollback] = await Promise.all([
    readUpdateRecord(stateDir), readHold(stateDir, now), readHelperLock(stateDir), readCurrentPointer(stateDir), readRecoveryReceipt(stateDir), readStoragePin(stateDir), readRollbackRecord(stateDir),
  ]);
  const identity = build.preflight.identity;
  const evidence: StorageUpdateEvidence = {
    build: { version: build.version, ...(identity ? { identity: { ...identity } } : {}), supported: build.preflight.supported, ...(build.preflight.refusal ? { refusal: build.preflight.refusal } : {}) },
    managed, update, hold: publicRead(hold), helper: publicRead(helper), current, receipt, pin, rollback,
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
  const receiptFor = (kind: RecoveryReceiptKind) => receiptCovers(receipt, kind, update, { version: build.version, identity }, current);

  if (managed) {
    // The owner's pin and rollback decide which build the service keeps; what cannot be read of them holds everything.
    if (pin.state === 'unreadable' || pin.state === 'invalid') return answer('recovery-required', 'pin-unreadable', `The version pin cannot be used: ${pin.reason}`);
    if (rollback.state === 'unreadable' || rollback.state === 'invalid') return answer('recovery-required', 'rollback-record-unreadable', `The owner's rollback record cannot be used: ${rollback.reason}`);
    if (rollback.state === 'present' && rollback.record.from === build.version && !rollback.record.switched && rollbackActive(rollback.record)) {
      return answer('update-held', 'rollback-under-way', `The owner's rollback to ${rollback.record.target} is under way; storage changes wait.`);
    }
    // The rollback target: its record is the durable authority this build starts on. It boots and answers while the
    // worker is handed over (no import, no migration), and is kept only once its worker answered as the pinned build.
    const target = rollbackTo(rollback, update, { version: build.version, identity });
    if (target) {
      if (rollbackKept(target, identity)) return await settled() ?? answer('ready', 'owner-rollback', `The owner rolled the service back to ${build.version}, and its worker answered as this build.`);
      if (target.state === 'failed') return answer('recovery-required', 'rollback-failed', `The owner's rollback to ${build.version} stopped (${target.failure?.phase ?? 'unknown'}); the owner decides how it goes on.`);
      const pinned = pin.state === 'present' && pin.pin.pinned === build.version && pin.pin.rollbackId === target.id;
      if (target.state !== 'completed' && !pinned) return answer('recovery-required', 'rollback-pin', 'The pin of the rollback under way is not there; the owner inspects it first.');
      return await settled() ?? answer('update-held', target.state === 'completed' ? 'rollback-hold-release' : 'rollback-handoff', target.state === 'completed'
        ? `The rollback to ${build.version} is done; its admission hold is released before storage changes.` : `The worker is being handed over to ${build.version}; storage changes wait until the rollback is kept.`);
    }
  }

  if (managed && record) {
    if (record.version === build.version) {
      // A refusal decides even while verifying: the helper must see it and go back before anything is imported.
      const check = await previousCheck(record.previous);
      if (check.state !== 'not-required' && check.state !== 'satisfied') return refusedFor(check);
      if (update.state === 'active') return answer('update-held', 'update-verifying', `The update to ${record.version} is still being verified; storage changes wait until it is kept.`);
      if (record.stage === 'failed') {
        if (receiptFor('own-failed')) return await settled() ?? answer('ready', 'owner-receipt', 'The owner verified this build again after its own update failed before it imported anything.');
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
  const ownRecovered = !!record && record.version === build.version && record.stage === 'failed' && receiptFor('own-failed');
  if (!managed && record) {
    if (update.state === 'active' && !receiptFor('stale-active')) return answer('recovery-required', 'stale-active-update', `An update to ${record.version} is recorded as under way, and nothing here settles it; the owner verifies it first.`);
    if (record.version === build.version && record.stage === 'failed' && !ownRecovered) return answer('recovery-required', 'own-update-failed', 'This build\'s own update failed; only the owner can recover it.');
  }
  if (record && record.stage === 'failed' && record.code === 'rollback-failed' && !ownRecovered) return answer('recovery-required', 'rollback-failed-recorded', 'The last update could not go back; the owner verifies the service first.');

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
 *
 * `own-failed` is this build's own failed update (any failure, a back that did not come back included), once the owner
 * has this build running again: the record must be this build's and terminal-failed; no hold, no live helper; the
 * service's `current` and its installed artifact must be this very build (managed), and `cutoverMarkers` must be the
 * worker's reading of the database: `absent` for every domain this build imports (a build without cutover needs none).
 * A marker that is there, or one that cannot be told, records nothing. The receipt only lets the evaluator go on with
 * its other rules: a managed build still needs its previous version to take its storage over, a direct start still
 * needs its preparation evidence.
 */
export async function recordUpdateRecoveryReceipt(input: StorageUpdateInput & { kind: RecoveryReceiptKind; by: string; evidence: string }): Promise<ReceiptOutcome> {
  const refuse = (code: string, reason: string): ReceiptOutcome => ({ recorded: false, code, reason });
  if (!RECEIPT_KINDS.has(input.kind)) return refuse('invalid-request', 'Unknown receipt kind.');
  if (!isText(input.by, 200) || !isText(input.evidence, 4096)) return refuse('invalid-request', 'A receipt needs who verified it and the evidence (at most 4096 characters).');
  const { stateDir, build } = input;
  const identity = build.preflight.identity;
  if (!build.preflight.supported || !identity || !build.manifest || identity.manifestDigest !== build.manifest.digest || identity.appVersion !== build.version || build.preflight.state?.problem) {
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
  } else if (input.kind === 'own-failed') {
    if (update.state !== 'terminal' || record.stage !== 'failed' || record.version !== build.version) return refuse('not-own-failed', 'Only this build\'s own failed update is verified this way.');
    if (cutoverDomains(build.manifest).length && input.cutoverMarkers !== 'absent') {
      return refuse('cutover-markers', `This build's cutover markers are ${input.cutoverMarkers ?? 'not told'}; only a build that imported nothing is recovered this way.`);
    }
    if (input.managed) {
      if (current.state !== 'version' || current.version !== build.version) return refuse('current-pointer', 'The service does not start this build.');
      const artifact = await probe(versionDirectory(stateDir, build.version), build.version);
      if (artifact.state !== 'contract' || artifact.contract.identity.sourceHash !== identity.sourceHash || artifact.contract.identity.manifestDigest !== identity.manifestDigest) return refuse('current-artifact', 'The installed current version is not the build running here.');
    }
  } else {
    if (input.managed) return refuse('service', 'The service settles its own interrupted updates; a stale record is verified only where nothing does.');
    if (update.state !== 'active') return refuse('not-active', 'The update record is not left active.');
  }
  const receipt: UpdateRecoveryReceipt = {
    format: 'tower-update-recovery-receipt', version: 1, kind: input.kind, recordSha256: update.sha256, update: record, build: { ...identity },
    pointer: current.state === 'version' ? current.version : null,
    ...(input.kind === 'own-failed' ? { cutoverMarkers: cutoverDomains(build.manifest).length ? 'absent' as const : 'not-applicable' as const } : {}),
    by: input.by, evidence: input.evidence, recordedAt: new Date(input.now ?? Date.now()).toISOString(),
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
  | { action: 'blocked'; code: 'prerequisite-required' | 'previous-incompatible' | 'attempts-exhausted' | 'invalid-chain'; version?: string; reason: string };
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
  if (update?.stage === 'failed' && update.version === progress.target && update.storage?.code === 'previous-incompatible') {
    return { action: 'blocked', code: 'previous-incompatible', version: progress.target, reason: `${running} cannot take ${progress.target}'s storage over, and no release prepares it; the owner decides what happens next.` };
  }
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

/**
 * What the rollback needs from the worker and the service. None of these cancels a provider, a turn or a shell.
 * W0I implements them for the real web/worker; each must keep the contract written here.
 */
export interface RollbackPorts {
  /**
   * The live database as its worker sees it (StorageClient.inspect): its whole schema and domain authority. Throws when
   * it cannot be read: never an empty one.
   */
  inspectStorage(): Promise<Pick<StorageInspection, 'schema' | 'authority'>>;
  /**
   * Holds new admissions and automation pumps (no cancel, no force deadline). Durable and keyed by `id`: asking again
   * with the same ID is the same one hold, and it survives a worker handoff until released by that ID.
   */
  holdAdmission(id: string, reason: string): Promise<void>;
  /** Releases the hold `id`, whichever worker serves now; releasing one that is not there succeeds. */
  releaseAdmission(id: string): Promise<void>;
  /**
   * Waits for running providers and transient calls to end by themselves. `pending` while a legacy worker's terminal
   * lives (its input and attach go on) or work still runs: the rollback waits and is asked again later. Asked anew
   * every time: an earlier answer is never taken for the present.
   */
  waitQuiet(id: string): Promise<{ state: 'quiet' } | { state: 'pending'; reason: string }>;
  /** Restarts the service's web, which then starts from `current`. */
  restartWeb(): Promise<void>;
  /**
   * The lower-version patient handoff to the target's worker; answers the worker that runs afterwards, with the
   * storage identity (source hash) it actually runs. Asked again when the target's worker already runs, it answers it.
   */
  handoff(target: { version: string; entry: string; sourceHash: string }): Promise<{ version: string; sourceHash?: string; pid: number }>;
}
export interface RollbackContext {
  stateDir: string;
  /** The build whose web carries this out: the version rolled back from, or (continuing after the switch) the target. */
  running: RunningBuild;
  managed: boolean;
  ports: RollbackPorts;
  /** Runs `work` in turn with update requests and pruning (Updates.exclusive), so neither moves the target meanwhile. */
  serialize<T>(work: () => Promise<T>): Promise<T>;
  probe?: ArtifactProbe;
  now?: () => number;
}

/**
 * Where a rollback stands. Every step records its intent before it acts (`pinning` before the pin, `holding` before the
 * hold, `switching` before the pointer, `handing-off` before the handoff), so whatever stops it in between leaves a
 * record that names what may have happened; the next attempt compares that with what is actually there.
 */
export type RollbackState = 'pinning' | 'pinned' | 'holding' | 'held' | 'waiting' | 'switching' | 'switched' | 'handing-off' | 'completed' | 'failed' | 'withdrawn';
const ROLLBACK_ENDED: ReadonlySet<string> = new Set(['completed', 'failed', 'withdrawn']);
const ROLLBACK_STATES: ReadonlySet<string> = new Set(['pinning', 'pinned', 'holding', 'held', 'waiting', 'switching', 'switched', 'handing-off', ...ROLLBACK_ENDED]);
/** A rollback that has not ended: it holds update requests back, and its pin is not released. */
export const rollbackActive = (record: Pick<RollbackRecord, 'state'>) => !ROLLBACK_ENDED.has(record.state);
export interface RollbackRecord {
  format: 'tower-storage-rollback';
  version: 1;
  /** One ID for the whole rollback: its pin, its admission hold and every retry use it. */
  id: string;
  from: string;
  target: string;
  /** The target build validated: its storage identity and its entry point's bytes. */
  sourceHash: string;
  manifestDigest: string;
  entrySha256: string;
  /** sha256 of update.json when the rollback was reserved (null: there was none). The target starts on exactly that record. */
  updateSha256: string | null;
  state: RollbackState;
  by: string;
  reason: string;
  /** An admission hold with this ID may be in place: set before it is asked for, cleared only once its release succeeded. */
  held: boolean;
  /** `current` was confirmed at the target. */
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
  const worker = isObject(value) ? value.worker : undefined;
  const failure = isObject(value) ? value.failure : undefined;
  if (!isObject(value) || value.format !== 'tower-storage-rollback' || value.version !== 1 || !isText(value.id, 64) || !RELEASE.test(String(value.from)) || !RELEASE.test(String(value.target))
    || !SHA256.test(String(value.sourceHash)) || !SHA256.test(String(value.manifestDigest)) || !SHA256.test(String(value.entrySha256))
    || !(value.updateSha256 === null || SHA256.test(String(value.updateSha256))) || !ROLLBACK_STATES.has(String(value.state))
    || typeof value.held !== 'boolean' || typeof value.switched !== 'boolean' || !isText(value.by, 200) || typeof value.reason !== 'string' || value.reason.length > 2000
    || (worker !== undefined && !(isObject(worker) && typeof worker.version === 'string' && SHA256.test(String(worker.sourceHash)) && isCount(worker.pid, 1)))
    || (failure !== undefined && !(isObject(failure) && typeof failure.phase === 'string' && typeof failure.message === 'string'))
    || !isTime(value.startedAt) || !isTime(value.updatedAt)) {
    return { state: 'invalid', reason: 'The rollback record has an unknown format.' };
  }
  return { state: 'present', record: value as unknown as RollbackRecord };
}
const saveRollback = (stateDir: string, record: RollbackRecord) => writePrivateJson(storageUpdatePaths(stateDir).rollback, JSON.stringify(record, null, 2), { syncDirectory: true });
const stamp = (context: { now?: () => number }) => new Date(context.now?.() ?? Date.now()).toISOString();

/** A rollback step found the record (or what it stands on) other than it expected: nothing more is done this time. */
class RollbackConflict extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
/**
 * Writes `next` over the record only while it is still rollback `id` in one of `states`, in the computer's transition
 * turn: a step never overwrites what another attempt, a withdrawal or another process recorded meanwhile.
 */
async function transition(context: { stateDir: string; now?: () => number }, id: string, states: readonly RollbackState[], next: Partial<RollbackRecord>): Promise<RollbackRecord> {
  return withStorageTransition(context.stateDir, async () => {
    const read = await readRollbackRecord(context.stateDir);
    if (read.state !== 'present' || read.record.id !== id || !states.includes(read.record.state)) {
      throw new RollbackConflict('rollback-changed', `The rollback record changed meanwhile (${read.state === 'present' ? `${read.record.id} is ${read.record.state}` : read.state}).`);
    }
    const record: RollbackRecord = { ...read.record, ...next, updatedAt: stamp(context) };
    await saveRollback(context.stateDir, record);
    return record;
  });
}

/**
 * The rollback this process is carrying out, per state directory. A second request for the same target shares it (one
 * record, one hold); a request for another target, a withdrawal or a pin release meanwhile is refused.
 */
const inflight = new Map<string, { target: string; promise: Promise<RollbackOutcome> }>();
function oneAtATime(stateDir: string, target: string, work: () => Promise<RollbackOutcome>): Promise<RollbackOutcome> {
  const key = resolve(stateDir);
  const running = inflight.get(key);
  if (running) {
    return running.target === target ? running.promise
      : Promise.resolve({ state: 'refused', code: 'rollback-in-progress', reason: `A rollback to ${running.target} is being carried out.` });
  }
  const promise = (async (): Promise<RollbackOutcome> => {
    try { return await work(); } catch (error) {
      if (error instanceof RollbackConflict) return { state: 'refused', code: error.code, reason: error.message };
      throw error;
    }
  })();
  const entry = { target, promise };
  inflight.set(key, entry);
  promise.finally(() => { if (inflight.get(key) === entry) inflight.delete(key); }).catch(() => {});
  return promise;
}

export type RollbackValidation =
  | { ok: true; target: { version: string; directory: string; entry: string; entrySha256: string; contract: ArtifactStorageContract }; updateSha256: string | null }
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

/**
 * Whether the service is settled on the running build, so nothing about an update is uncertain when it rolls back: the
 * running build's runtime and contract passed; no snapshot recovery holds the storage; the update record is readable,
 * not under way, and proves this build (its own `done`, or the owner's verification where it does not: an own failed
 * update or a later one that went back here need the owner's receipt, a later update kept and then rolled back here
 * needs that rollback completed); no hold and no live helper; and `current` with its installed artifact is this very
 * build. Inspecting the target and the database never stands in for any of these.
 */
async function serviceReadiness(context: RollbackContext): Promise<{ ok: true; updateSha256: string | null } | { ok: false; code: string; reason: string }> {
  const { stateDir, running } = context;
  const refuse = (code: string, reason: string) => ({ ok: false as const, code, reason });
  const identity = running.preflight.identity;
  if (!running.preflight.supported || !identity || !running.manifest || identity.manifestDigest !== running.manifest.digest || identity.appVersion !== running.version) {
    return refuse('runtime-unsupported', 'This build\'s storage runtime and contract did not pass their preflight; its database cannot be compared.');
  }
  if (running.preflight.state?.recovery && running.preflight.state.recovery.state !== 'clear') return refuse('recovery-held', 'A snapshot recovery holds the storage; it is finished first.');
  const [update, hold, helper, current, receipt, rollback] = await Promise.all([readUpdateRecord(stateDir), readHold(stateDir), readHelperLock(stateDir), readCurrentPointer(stateDir), readRecoveryReceipt(stateDir), readRollbackRecord(stateDir)]);
  if (update.state === 'unreadable' || update.state === 'invalid') return refuse('update-status', `The update record is ${update.state}; recover it first.`);
  if (update.state === 'active') return refuse('update-active', `An update to ${update.update.version} is under way; it is settled first.`);
  if (helper.state === 'running' || helper.state === 'unreadable' || helper.state === 'invalid') return refuse('update-helper', `The update helper is ${helper.state}; it is settled first.`);
  if (hold.state !== 'absent') return refuse('update-hold', `The update hold is ${hold.state}; it is settled first.`);
  if (current.state !== 'version' || current.version !== running.version) return refuse('current-pointer', `The service starts ${current.state === 'version' ? current.version : `nothing it can tell (${current.state})`}, not ${running.version}.`);
  const artifact = await (context.probe ?? probeInstalledArtifact)(versionDirectory(stateDir, running.version), running.version);
  if (artifact.state !== 'contract' || artifact.contract.identity.sourceHash !== identity.sourceHash || artifact.contract.identity.manifestDigest !== identity.manifestDigest) {
    return refuse('current-artifact', 'The installed current version is not the build running here.');
  }
  if (update.state === 'terminal') {
    const record = update.update;
    const build = { version: running.version, identity };
    const covers = (kind: RecoveryReceiptKind) => receiptCovers(receipt, kind, update, build, current);
    const ownRecovered = record.version === running.version && record.stage === 'failed' && covers('own-failed');
    if (record.stage === 'failed' && record.code === 'rollback-failed' && !ownRecovered) return refuse('update-uncertain', `The update to ${record.version} could not go back; the owner verifies the service first.`);
    if (record.version === running.version && record.stage === 'failed' && !ownRecovered) return refuse('own-update-failed', 'This build\'s own update failed; the owner verifies it first.');
    if (record.version !== running.version && record.previous === running.version) {
      const verified = record.stage === 'failed' ? covers('overwritten-done') : rollbackKept(rollbackTo(rollback, update, build), identity);
      if (!verified) return refuse('owner-verification-required', `The last update (${record.version}) started from this build; the owner verifies this build first.`);
    }
  }
  return { ok: true, updateSha256: update.state === 'terminal' ? update.sha256 : null };
}

/** Everything a rollback to `target` needs, read-only: nothing is pinned, held, pointed or handed over. */
export async function validateRollback(context: RollbackContext, request: { target: string }): Promise<RollbackValidation> {
  const { stateDir, running } = context;
  const refuse = (code: string, reason: string): RollbackValidation => ({ ok: false, code, reason });
  if (!context.managed) return refuse('not-service', 'Only the background service rolls back; a Tower run by hand starts the older version directly instead.');
  if (!RELEASE.test(request.target) || !newerVersion(running.version, request.target)) return refuse('not-lower', 'A rollback goes to an older released version; a newer one is an update.');
  const [pin, rollback] = await Promise.all([readStoragePin(stateDir), readRollbackRecord(stateDir)]);
  if (pin.state === 'unreadable' || pin.state === 'invalid') return refuse('pin', `The version pin is ${pin.state}; the owner inspects it first.`);
  if (pin.state === 'present' && pin.pin.pinned !== request.target) return refuse('pinned-elsewhere', `The service is pinned to ${pin.pin.pinned}; the owner releases that pin first.`);
  if (rollback.state === 'unreadable' || rollback.state === 'invalid') return refuse('rollback-record', `The rollback record is ${rollback.state}; the owner inspects it first.`);
  if (rollback.state === 'present' && rollbackActive(rollback.record) && rollback.record.target !== request.target) return refuse('rollback-in-progress', `Rollback ${rollback.record.id} to ${rollback.record.target} is under way.`);
  const readiness = await serviceReadiness(context);
  if (!readiness.ok) return refuse(readiness.code, readiness.reason);
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
  return { ok: true, target: { version: request.target, directory, entry, entrySha256, contract: artifact.contract }, updateSha256: readiness.updateSha256 };
}

/**
 * The target as the rollback validated it, checked again after a wait: the same build installed with the same entry
 * point, still running here, and the live database (inspected again) still within its contract.
 */
async function recheckTarget(context: RollbackContext, record: RollbackRecord): Promise<{ ok: true } | { ok: false; reason: string }> {
  const directory = versionDirectory(context.stateDir, record.target);
  const artifact = await (context.probe ?? probeInstalledArtifact)(directory, record.target);
  if (artifact.state !== 'contract' || artifact.contract.identity.sourceHash !== record.sourceHash || artifact.contract.identity.manifestDigest !== record.manifestDigest) {
    return { ok: false, reason: `${record.target}'s installed build is no longer the one validated (${artifact.state}).` };
  }
  if (!artifact.contract.supported) return { ok: false, reason: `${record.target}'s storage no longer runs here.` };
  if (await entryHash(entryPoint(directory)).catch(() => '') !== record.entrySha256) return { ok: false, reason: `${record.target}'s installed files changed after they were validated.` };
  let inspection: Pick<StorageInspection, 'schema' | 'authority'>;
  try { inspection = await context.ports.inspectStorage(); } catch (error) { return { ok: false, reason: `The database could not be read to compare again: ${messageOf(error)}` }; }
  const supported = databaseSupported(artifact.contract, inspection);
  return supported.ok ? { ok: true } : { ok: false, reason: supported.reason };
}

/** Where a rollback stands, or why nothing was done. A withdrawal that could not release the pin says so in `pin`. */
export type RollbackOutcome =
  | { state: RollbackState; record: RollbackRecord; pin?: { released: boolean; reason?: string } }
  | { state: 'refused'; code: string; reason: string };
const refusal = (code: string, reason: string): RollbackOutcome => ({ state: 'refused', code, reason });
const failureOf = (phase: string, error: unknown) => ({ phase, message: messageOf(error).slice(0, 2000) });

/**
 * The owner's rollback, one shared executor: validate (read-only), reserve it (one record and one ID, and the pin over
 * the very artifact validated), hold new admissions and automation, wait for running work to end by itself, validate
 * the database and the artifact again, point `current` at the target and restart the web; the target's web then
 * hands the worker over (resumeRollback). Reserving and switching are taken in turn with update requests and pruning
 * (`serialize`) and in the computer's transition turn; waiting is not, so a long wait holds no request back.
 *
 * A failure releases the admission hold it took; the pin stays until the owner releases it, so nothing reinstalls the
 * newer version meanwhile. Asking again continues the same rollback from where its record and the actual state stand.
 * Two requests for the same target at once are one rollback; one for another target is refused while it runs.
 */
export function runRollback(context: RollbackContext, request: { target: string; by: string; reason: string }): Promise<RollbackOutcome> {
  if (!isText(request.by, 200) || typeof request.reason !== 'string' || request.reason.length > 2000) return Promise.resolve(refusal('invalid-request', 'A rollback names who asked for it.'));
  if (!RELEASE.test(request.target)) return Promise.resolve(refusal('not-lower', 'A rollback goes to an older released version.'));
  return oneAtATime(context.stateDir, request.target, () => carryOut(context, request));
}

async function carryOut(context: RollbackContext, request: { target: string; by: string; reason: string }): Promise<RollbackOutcome> {
  const { stateDir, running } = context;
  let seen = await readRollbackRecord(stateDir);
  if (seen.state === 'unreadable' || seen.state === 'invalid') return refusal('rollback-record', `The rollback record is ${seen.state}; the owner inspects it first.`);
  let continuing: RollbackRecord | undefined;
  if (seen.state === 'present') {
    const record = seen.record;
    if (record.target !== request.target) {
      if (rollbackActive(record)) return refusal('rollback-in-progress', `Rollback ${record.id} to ${record.target} is under way.`);
      if (record.held) return refusal('hold-not-released', `Rollback ${record.id}'s admission hold was not confirmed released; withdraw it again first.`);
    } else if (record.switched || record.state === 'switching') {
      if (running.version === record.target) return continueOnTarget(context, record);
      if (running.version !== record.from || !rollbackActive(record)) return refusal('not-target', `Rollback ${record.id} switched to ${record.target}; it goes on from ${record.target}'s web.`);
      const settled = await settleSwitching(context, record);
      if (settled.state === 'failed') return { state: 'failed', record: settled };
      if (settled.switched) {
        // The web that switched still serves: its restart did not take. It is asked again; the target's web goes on.
        try { await context.ports.restartWeb(); } catch (error) {
          const noted = await transition(context, settled.id, [settled.state], { failure: failureOf('restart', error) }).catch(() => settled);
          return { state: noted.state, record: noted };
        }
        return { state: settled.state, record: settled };
      }
      continuing = settled;
      seen = { state: 'present', record: settled };
    } else if (record.state === 'withdrawn') {
      if (record.held) return refusal('hold-not-released', `Rollback ${record.id}'s admission hold was not confirmed released; withdraw it again first.`);
    } else continuing = record;
  }
  const validation = await validateRollback(context, request);
  if (!validation.ok) {
    // A rollback already holding admissions is not left holding them on a target it can no longer take.
    if (continuing?.held) return failWith(context, continuing, 'validate', validation.reason);
    return refusal(validation.code, validation.reason);
  }
  let record = await context.serialize(() => withStorageTransition(stateDir, () => reserve(context, request, validation, seen, continuing)));

  // Hold new admissions and automation: the intent is durable first, so a hold asked for is never unaccounted for.
  record = await transition(context, record.id, ['pinned', 'holding', 'held', 'waiting', 'failed'], { state: 'holding', held: true, failure: undefined, pending: undefined });
  try { await context.ports.holdAdmission(record.id, `Rolling back to ${record.target}`); } catch (error) { return failWith(context, record, 'hold', error); }
  record = await transition(context, record.id, ['holding'], { state: 'held' });
  // Running work ends by itself; nothing is cancelled, and nothing else waits in turn meanwhile.
  let quiet: Awaited<ReturnType<RollbackPorts['waitQuiet']>>;
  try { quiet = await context.ports.waitQuiet(record.id); } catch (error) { return failWith(context, record, 'quiet', error); }
  if (quiet.state === 'pending') {
    record = await transition(context, record.id, ['held'], { state: 'waiting', pending: quiet.reason.slice(0, 500) });
    return { state: 'waiting', record };
  }
  const recheck = await recheckTarget(context, record);
  if (!recheck.ok) return failWith(context, record, 'revalidate', recheck.reason);

  const switched = await context.serialize(() => withStorageTransition(stateDir, () => switchTo(context, record)));
  if (!switched.ok) return switched.uncertain ? { state: 'failed', record: switched.record } : failWith(context, switched.record, switched.phase, switched.reason);
  record = switched.record;
  try { await context.ports.restartWeb(); } catch (error) {
    // launchd starts the web again by itself; whether the target's web goes on decides.
    record = await transition(context, record.id, ['switched'], { failure: failureOf('restart', error) }).catch(() => record);
  }
  return { state: 'switched', record };
}

const sameRead = (a: RollbackRead, b: RollbackRead) => a.state === b.state
  && (a.state !== 'present' || (b.state === 'present' && a.record.id === b.record.id && a.record.state === b.record.state && a.record.updatedAt === b.record.updatedAt));

/**
 * Reserves the rollback, in turn with update requests and pruning and in the transition turn: nothing it was validated
 * on moved meanwhile (the rollback record, update.json, the hold and helper, `current`, the target's build and entry
 * point), and the pin is this rollback's own (written now, after the record names it: `pinning` first). Throws a
 * conflict for anything else: no pin, no record change.
 */
async function reserve(context: RollbackContext, request: { target: string; by: string; reason: string }, validation: Extract<RollbackValidation, { ok: true }>, seen: RollbackRead, continuing?: RollbackRecord): Promise<RollbackRecord> {
  const { stateDir, running } = context;
  const { target } = validation;
  if (!sameRead(seen, await readRollbackRecord(stateDir))) throw new RollbackConflict('rollback-changed', 'Another rollback request changed the record meanwhile.');
  const [update, hold, helper, current, pin] = await Promise.all([readUpdateRecord(stateDir), readHold(stateDir), readHelperLock(stateDir), readCurrentPointer(stateDir), readStoragePin(stateDir)]);
  const updateSha256 = update.state === 'active' || update.state === 'terminal' ? update.sha256 : update.state === 'absent' ? null : undefined;
  if (updateSha256 !== validation.updateSha256) throw new RollbackConflict('update-changed', 'An update was asked for while the rollback was validated; it is settled first.');
  if (hold.state !== 'absent' || helper.state === 'running' || helper.state === 'unreadable' || helper.state === 'invalid') throw new RollbackConflict('update-hold', 'An update hold or helper appeared while the rollback was validated.');
  if (current.state !== 'version' || current.version !== running.version) throw new RollbackConflict('current-pointer', 'The service\'s current version changed while the rollback was validated.');
  const sourceHash = target.contract.identity.sourceHash;
  const manifestDigest = target.contract.identity.manifestDigest;
  const again = await (context.probe ?? probeInstalledArtifact)(target.directory, target.version);
  if (again.state !== 'contract' || again.contract.identity.sourceHash !== sourceHash || again.contract.identity.manifestDigest !== manifestDigest
    || await entryHash(target.entry).catch(() => '') !== target.entrySha256) throw new RollbackConflict('target-changed', `${target.version} changed while the rollback was validated; nothing was pinned.`);
  if (pin.state === 'unreadable' || pin.state === 'invalid') throw new RollbackConflict('pin', `The version pin is ${pin.state}; the owner inspects it first.`);
  if (pin.state === 'present' && pin.pin.pinned !== target.version) throw new RollbackConflict('pinned-elsewhere', `The service is pinned to ${pin.pin.pinned}; the owner releases that pin first.`);
  // A pin left on this version stands only over the very build just validated.
  if (pin.state === 'present' && (pin.pin.sourceHash !== sourceHash || pin.pin.manifestDigest !== manifestDigest || pin.pin.entrySha256 !== target.entrySha256)) {
    throw new RollbackConflict('target-changed', `The pin on ${target.version} stands over another build than the one installed now.`);
  }
  const at = stamp(context);
  let record: RollbackRecord = continuing && continuing.sourceHash === sourceHash && continuing.entrySha256 === target.entrySha256
    ? { ...continuing, updateSha256: validation.updateSha256, failure: undefined, pending: undefined, updatedAt: at }
    : {
      format: 'tower-storage-rollback', version: 1, id: `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`, from: running.version, target: target.version,
      sourceHash, manifestDigest, entrySha256: target.entrySha256, updateSha256: validation.updateSha256, state: 'pinning', by: request.by, reason: request.reason,
      held: continuing?.held ?? false, switched: false, startedAt: at, updatedAt: at,
    };
  if (continuing && record.id !== continuing.id && continuing.held) throw new RollbackConflict('target-changed', `${target.version} was reinstalled while rollback ${continuing.id} still holds admissions; withdraw it first.`);
  if (pin.state !== 'present' || pin.pin.rollbackId !== record.id) {
    record = { ...record, state: 'pinning' };
    await saveRollback(stateDir, record);
    const value: StoragePin = { format: 'tower-storage-pin', version: 1, pinned: target.version, sourceHash, manifestDigest, entrySha256: target.entrySha256,
      rollbackId: record.id, by: request.by, reason: request.reason.slice(0, 2000), at };
    await writePrivateJson(storagePinPath(stateDir), JSON.stringify(value, null, 2), { syncDirectory: true });
  }
  record = { ...record, state: record.state === 'pinning' ? 'pinned' : record.state, updatedAt: stamp(context) };
  await saveRollback(stateDir, record);
  return record;
}

type SwitchResult = { ok: true; record: RollbackRecord } | { ok: false; uncertain: boolean; phase: string; reason: string; record: RollbackRecord };
/**
 * Points `current` at the target, in turn with requests and pruning and in the transition turn: once more over the
 * facts the switch stands on (the record held, the pin this rollback's, update.json as reserved, no hold or helper,
 * `current` still the version rolled back from); `switching` is recorded before the pointer moves and `switched` after.
 * A pointer that answers neither version after a failed switch is uncertain: the record fails and its hold stays.
 */
async function switchTo(context: RollbackContext, held: RollbackRecord): Promise<SwitchResult> {
  const { stateDir } = context;
  const read = await readRollbackRecord(stateDir);
  if (read.state !== 'present' || read.record.id !== held.id || read.record.state !== 'held') throw new RollbackConflict('rollback-changed', 'The rollback record changed while running work ended.');
  let record = read.record;
  const stop = (phase: string, reason: string): SwitchResult => ({ ok: false, uncertain: false, phase, reason, record });
  const [pin, update, hold, helper, current] = await Promise.all([readStoragePin(stateDir), readUpdateRecord(stateDir), readHold(stateDir), readHelperLock(stateDir), readCurrentPointer(stateDir)]);
  if (pin.state !== 'present' || pin.pin.rollbackId !== record.id || pin.pin.pinned !== record.target || pin.pin.sourceHash !== record.sourceHash || pin.pin.entrySha256 !== record.entrySha256) {
    return stop('pin', 'The pin no longer keeps this rollback\'s target.');
  }
  const updateSha256 = update.state === 'active' || update.state === 'terminal' ? update.sha256 : update.state === 'absent' ? null : undefined;
  if (updateSha256 !== record.updateSha256) return stop('update-changed', 'The update record changed while running work ended.');
  if (hold.state !== 'absent' || helper.state === 'running' || helper.state === 'unreadable' || helper.state === 'invalid') return stop('update-hold', 'An update hold or helper appeared while running work ended.');
  if (current.state !== 'version' || current.version !== record.from) return stop('pointer', `The service starts ${current.state === 'version' ? current.version : current.state}, not ${record.from}, before the switch.`);
  record = await transition(context, record.id, ['held'], { state: 'switching' });
  try { await pointRollbackTarget(stateDir, record.target, record.id); } catch (error) {
    const pointer = await readCurrentPointer(stateDir);
    if (pointer.state === 'version' && pointer.version === record.from) {
      record = await transition(context, record.id, ['switching'], { state: 'held' });
      return stop('switch', messageOf(error));
    }
    if (!(pointer.state === 'version' && pointer.version === record.target)) {
      record = await transition(context, record.id, ['switching'], { state: 'failed', failure: failureOf('switch', `current is ${describePointer(pointer)} after a failed switch (${messageOf(error)}); the owner inspects it`) });
      return { ok: false, uncertain: true, phase: 'switch', reason: record.failure!.message, record };
    }
    // The pointer moved although the call failed: the switch took.
  }
  record = await transition(context, record.id, ['switching'], { state: 'switched', switched: true });
  return { ok: true, record };
}
const describePointer = (pointer: PointerRead) => pointer.state === 'version' ? pointer.version : pointer.state;

/**
 * Ends a step that failed with nothing uncertain: the admission hold is released (and recorded as released only when
 * that succeeded), the pin stays, and the record says where it stopped. Asking again continues the same rollback.
 */
async function failWith(context: Pick<RollbackContext, 'stateDir' | 'ports' | 'now'>, record: RollbackRecord, phase: string, error: unknown): Promise<RollbackOutcome> {
  let held = record.held;
  if (held) held = !await context.ports.releaseAdmission(record.id).then(() => true, () => false);
  const failed = await transition(context, record.id, [record.state], { state: 'failed', held, pending: undefined, failure: failureOf(phase, error) });
  return { state: 'failed', record: failed };
}

/**
 * Continues the owner's rollback from where its record and the actual state stand. The web calls it when it starts
 * (W0I): the target's web, once `current` points at it, hands the worker over; the web rolled back from goes on with a
 * rollback that has not switched (validated again from the start). Nothing is taken for done on the record alone.
 */
export async function resumeRollback(context: RollbackContext): Promise<RollbackOutcome> {
  const read = await readRollbackRecord(context.stateDir);
  if (read.state !== 'present') return refusal('rollback-record', `There is no rollback to continue (${read.state}).`);
  const record = read.record;
  if (context.running.version === record.target && (record.switched || record.state === 'switching')) {
    return oneAtATime(context.stateDir, record.target, () => continueOnTarget(context, record));
  }
  if (context.running.version === record.from && rollbackActive(record)) return runRollback(context, { target: record.target, by: record.by, reason: record.reason });
  return refusal('nothing-to-continue', `Rollback ${record.id} (${record.from} → ${record.target}) is ${record.state}; there is nothing for ${context.running.version} to continue.`);
}

/**
 * The rollback after the switch, on the target's web: `switching` is settled by the actual pointer; then the pointer,
 * the pin and the target's artifact are verified as they are now (a mismatch fails it and keeps its hold: what serves
 * cannot be told); admissions are held and running work ended again (whatever an earlier attempt saw); the database is
 * checked again; the worker is handed over; and the rollback is kept only when the worker that answers is the pinned
 * build, with its storage identity, while `current` still starts it. Its admission hold is released last.
 */
async function continueOnTarget(context: RollbackContext, seen: RollbackRecord): Promise<RollbackOutcome> {
  const { stateDir, running } = context;
  const identity = running.preflight.identity;
  if (running.version !== seen.target || identity?.sourceHash !== seen.sourceHash || identity.manifestDigest !== seen.manifestDigest) {
    return refusal('not-target', `Rollback ${seen.id} goes on from ${seen.target}'s web (${seen.sourceHash.slice(0, 12)}…), not this build.`);
  }
  let record = await settleSwitching(context, seen);
  if (record.state === 'failed' && !seen.switched) return { state: 'failed', record };
  if (!record.switched) return refusal('not-switched', 'The switch did not happen; the rollback goes on from the web it was asked on.');
  if (record.state === 'completed') return releaseCompleted(context, record);
  const verified = await withStorageTransition(stateDir, () => verifyTarget(context, record));
  if (!verified.ok) {
    record = await transition(context, record.id, [record.state], { state: 'failed', pending: undefined, failure: failureOf('verify', verified.reason) });
    return { state: 'failed', record };
  }
  record = await transition(context, record.id, ['switched', 'holding', 'held', 'waiting', 'handing-off', 'failed'], { state: 'holding', held: true, failure: undefined, pending: undefined });
  try { await context.ports.holdAdmission(record.id, `Rolling back to ${record.target}`); } catch (error) { return failWith(context, record, 'hold', error); }
  record = await transition(context, record.id, ['holding'], { state: 'held' });
  let quiet: Awaited<ReturnType<RollbackPorts['waitQuiet']>>;
  try { quiet = await context.ports.waitQuiet(record.id); } catch (error) { return failWith(context, record, 'quiet', error); }
  if (quiet.state === 'pending') {
    record = await transition(context, record.id, ['held'], { state: 'waiting', pending: quiet.reason.slice(0, 500) });
    return { state: 'waiting', record };
  }
  const recheck = await recheckTarget(context, record);
  if (!recheck.ok) return failWith(context, record, 'revalidate', recheck.reason);
  record = await transition(context, record.id, ['held'], { state: 'handing-off' });
  const entry = entryPoint(versionDirectory(stateDir, record.target));
  let worker: Awaited<ReturnType<RollbackPorts['handoff']>>;
  try { worker = await context.ports.handoff({ version: record.target, entry, sourceHash: record.sourceHash }); } catch (error) { return failWith(context, record, 'handoff', error); }
  const pointer = await readCurrentPointer(stateDir);
  if (worker.version !== record.target || worker.sourceHash !== record.sourceHash || !(pointer.state === 'version' && pointer.version === record.target)) {
    // Which worker serves, or what the service starts, cannot be told: nothing is kept, and the hold stays.
    const message = worker.version !== record.target || worker.sourceHash !== record.sourceHash
      ? `The worker answers as ${worker.version}${worker.sourceHash ? ` (${worker.sourceHash.slice(0, 12)}…)` : ' without a storage identity'}, not the pinned build.`
      : `current is ${describePointer(pointer)} after the handoff, not ${record.target}.`;
    record = await transition(context, record.id, ['handing-off'], { state: 'failed', failure: failureOf('worker', message) });
    return { state: 'failed', record };
  }
  record = await transition(context, record.id, ['handing-off'], { state: 'completed', worker: { version: worker.version, sourceHash: worker.sourceHash, pid: worker.pid } });
  return releaseCompleted(context, record);
}

/**
 * A switch that was asked for and whose outcome was not recorded (`switching`) is settled by the pointer itself: at the
 * target it switched, at the version rolled back from it did not (the rollback is `held` again: its hold may be in
 * place), anywhere else it is uncertain and fails with its hold kept. Any other record is answered as it is.
 */
async function settleSwitching(context: Pick<RollbackContext, 'stateDir' | 'now'>, record: RollbackRecord): Promise<RollbackRecord> {
  if (record.state !== 'switching') return record;
  return withStorageTransition(context.stateDir, async () => {
    const pointer = await readCurrentPointer(context.stateDir);
    if (pointer.state === 'version' && pointer.version === record.target) return transition(context, record.id, ['switching'], { state: 'switched', switched: true });
    if (pointer.state === 'version' && pointer.version === record.from) return transition(context, record.id, ['switching'], { state: 'held' });
    return transition(context, record.id, ['switching'], { state: 'failed', failure: failureOf('switch', `current is ${describePointer(pointer)} after a switch whose outcome was not recorded; the owner inspects it`) });
  });
}

/** Everything the switch stood on, as it is now: `current` at the target, this rollback's pin, the very build validated. */
async function verifyTarget(context: RollbackContext, record: RollbackRecord): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { stateDir } = context;
  const [pointer, pin] = await Promise.all([readCurrentPointer(stateDir), readStoragePin(stateDir)]);
  if (!(pointer.state === 'version' && pointer.version === record.target)) return { ok: false, reason: `current is ${describePointer(pointer)}, not ${record.target}.` };
  if (pin.state !== 'present' || pin.pin.rollbackId !== record.id || pin.pin.pinned !== record.target || pin.pin.sourceHash !== record.sourceHash
    || pin.pin.manifestDigest !== record.manifestDigest || pin.pin.entrySha256 !== record.entrySha256) return { ok: false, reason: 'The pin no longer keeps this rollback\'s target.' };
  const directory = versionDirectory(stateDir, record.target);
  const artifact = await (context.probe ?? probeInstalledArtifact)(directory, record.target);
  if (artifact.state !== 'contract' || artifact.contract.identity.sourceHash !== record.sourceHash || artifact.contract.identity.manifestDigest !== record.manifestDigest) {
    return { ok: false, reason: `${record.target}'s installed build is no longer the one validated (${artifact.state}).` };
  }
  if (await entryHash(entryPoint(directory)).catch(() => '') !== record.entrySha256) return { ok: false, reason: `${record.target}'s installed files changed after they were validated.` };
  return { ok: true };
}

/** Releases a completed rollback's admission hold; the record says `held` until the release succeeded. */
async function releaseCompleted(context: Pick<RollbackContext, 'stateDir' | 'ports' | 'now'>, record: RollbackRecord): Promise<RollbackOutcome> {
  if (!record.held) return { state: 'completed', record };
  try { await context.ports.releaseAdmission(record.id); } catch { return { state: 'completed', record }; }
  record = await transition(context, record.id, ['completed'], { held: false });
  return { state: 'completed', record };
}

/**
 * The owner withdraws a rollback that has not switched the service (one that stopped included): its admission hold is
 * released, and the withdrawal is reported only once that succeeded; asked again, the release is retried, whatever
 * the record says already. The pin stays unless the owner releases it too, as a separate explicit step (`releasePin`).
 */
export async function withdrawRollback(context: Pick<RollbackContext, 'stateDir' | 'ports' | 'now'>, input: { releasePin?: boolean } = {}): Promise<RollbackOutcome> {
  if (inflight.has(resolve(context.stateDir))) return refusal('rollback-busy', 'The rollback is being carried out right now; ask again once it answers.');
  const read = await readRollbackRecord(context.stateDir);
  if (read.state !== 'present') return refusal('rollback-record', `There is no rollback to withdraw (${read.state}).`);
  let record = read.record;
  if (record.switched || record.state === 'switching') return refusal('rollback-switched', 'The service already starts the rollback target (or may); moving on is an update once the owner releases the pin.');
  let held = record.held;
  if (held) held = !await context.ports.releaseAdmission(record.id).then(() => true, () => false);
  try {
    record = await transition(context, record.id, [record.state], { state: 'withdrawn', held, pending: undefined });
  } catch (error) {
    if (error instanceof RollbackConflict) return refusal(error.code, error.message);
    throw error;
  }
  if (held) return refusal('hold-not-released', 'The rollback is withdrawn, but its admission hold could not be released; ask again.');
  if (!input.releasePin) return { state: 'withdrawn', record };
  return { state: 'withdrawn', record, pin: await releaseStoragePin(context.stateDir, { version: record.target }) };
}

/** Versions pruning keeps for the storage: the pinned one, and the target of a rollback that has not ended. A pin or rollback that cannot be read keeps everything. */
export async function storageKeptVersions(stateDir: string): Promise<{ keep: string[] } | { unknown: string }> {
  const [pin, rollback] = await Promise.all([readStoragePin(stateDir), readRollbackRecord(stateDir)]);
  if (pin.state === 'unreadable' || pin.state === 'invalid') return { unknown: `The version pin is ${pin.state}.` };
  if (rollback.state === 'unreadable' || rollback.state === 'invalid') return { unknown: `The rollback record is ${rollback.state}.` };
  return { keep: [...pin.state === 'present' ? [pin.pin.pinned] : [], ...rollback.state === 'present' && rollback.record.state !== 'withdrawn' ? [rollback.record.target, rollback.record.from] : []] };
}
