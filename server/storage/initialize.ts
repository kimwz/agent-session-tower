import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AutoPromptRepository } from '../auto-prompt/storage-repository.js';
import { autoPromptRows } from '../auto-prompt/storage-codec.js';
import { PermissionsRepository } from '../permissions/storage-repository.js';
import { RemoteRepository } from '../remote/storage-repository.js';
import { remoteRows } from '../remote/storage-codec.js';
import { RunsRepository } from '../runs/storage-repository.js';
import { RetentionRepository } from '../sessions/retention/storage-repository.js';
import { journalDocument, observationDocument } from '../sessions/retention/storage-codec.js';
import { WorkflowRepository } from '../slack/storage-repository.js';
import { workflowRows } from '../slack/storage-codec.js';
import { TriggersRepository } from '../triggers/storage-repository.js';
import { empty } from '../triggers/state.js';
import type { StorageBundleCapture } from './bundle.js';
import { openStorage, type StorageClient } from './client.js';
import { StorageCommandError, type DomainAuthority, type StorageFailure, type StorageLimits, type StorageStatus } from './contract.js';
import { OCCUPIED_TABLES_COMMAND } from './domain.js';
import { requireDomainAuthority, stagesOf, STORAGE_DOMAINS, StorageInitializationError, type StorageDomainScope } from './domain-authority.js';
import type { StoragePreflight } from './preflight.js';

/**
 * How the execution worker comes to a ready storage, without migrating anything that exists. Its order:
 * storagePreopenRefusal (read-only, nothing opened) → openStorage({ refuseBehind }) (a behind storage is refused on
 * its private copy, before SQLite opens the live files) → prepare (creates the schema only in an empty file) →
 * gate('core') → initializeStorageDomains (a domain authority is created only where the domain holds nothing and
 * no legacy source or migration evidence of it is there) → gate('core'). Not part of the storage thread, and not
 * exported from storage/index.ts: it reaches the domains through their repositories.
 */

/** Why the worker's storage does not become ready. Data is never changed to get past one. */
export interface StorageRefusal {
  state: 'unavailable' | 'recovery-required';
  code: string;
  reason: string;
  healthStatus: 200 | 503;
  failure?: StorageFailure;
  scope?: StorageDomainScope;
}

/** The sha256 a fresh (empty) domain authority records as its source manifest. */
export const freshManifestSha256 = (scope: StorageDomainScope): string => createHash('sha256').update(`tower-fresh-initialization\n${scope}`).digest('hex');

/**
 * Each domain's legacy sources and migration evidence, by the names the JSON-era builds and their importers used. Any
 * of them (or a path that cannot be told absent) means the domain had state outside this database.
 */
const LEGACY_SOURCES: Readonly<Record<StorageDomainScope, readonly string[]>> = {
  runs: ['runs.json', 'created-sessions.json', 'run-instructions.json', 'runs-storage-migrations'],
  retention: ['retention', 'retention-observations.json', 'retention-cold', 'retention-originals', 'storage-migrations'],
  triggers: ['trigger-engine.json', 'triggers-storage-migrations'],
  permissions: ['permissions.json', 'permissions-storage-migrations', 'storage-permissions-pending.json'],
  remote: ['remote-requests.json', 'remote-storage-migrations'],
  'auto-prompt': ['auto-prompts.json', 'auto-prompt-storage-migrations'],
  'automation-workflows': ['slack-automation.json', 'github-automation.json', 'automation-workflows-storage-migrations'],
};
/** What only a storage that existed leaves beside a database: its migration history and the records of its activation. */
const HISTORY_FILES = ['storage-contracts', 'storage-offline-activation.json'];
const isMigrationFolder = (name: string) => name === 'storage-migrations' || name.endsWith('-storage-migrations');
/** Legacy JSON sources only: the migration folders count as history, and a pending permission record names a SQL storage. */
const isLegacySource = (name: string) => !isMigrationFolder(name) && name !== 'storage-permissions-pending.json';

/** Whether `name` exists in `stateDir`. Only ENOENT is absence: anything else that cannot be told counts as present. */
async function exists(stateDir: string, name: string): Promise<boolean> {
  try { await lstat(join(stateDir, name)); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
}
/** A folder with entries, or a path that is not a readable folder (which cannot be told empty). Absent: false. */
async function nonEmpty(path: string): Promise<boolean> {
  try { return (await readdir(path)).length > 0; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
}
async function firstPresent(stateDir: string, names: readonly string[]): Promise<string | undefined> {
  for (const name of names) if (await exists(stateDir, name)) return name;
  return undefined;
}
async function legacySource(stateDir: string, scope: StorageDomainScope): Promise<string | undefined> {
  return firstPresent(stateDir, LEGACY_SOURCES[scope]);
}

/**
 * Read-only, before the live database is opened: a runtime this build cannot use, a state directory openStorage would
 * refuse, or a database that is not there while something says one was. A missing database is replaced by a new one
 * only in a state directory with no storage identity, sidecar, migration history (storage-contracts/,
 * storage-offline-activation.json, a non-empty *-storage-migrations/, storage-migrations/ or storage-snapshots/) or
 * legacy JSON source. Creates, opens and changes nothing.
 */
export async function storagePreopenRefusal(stateDir: string, preflight: StoragePreflight): Promise<StorageRefusal | undefined> {
  if (!preflight.supported) return { state: 'unavailable', code: 'runtime-unsupported', reason: preflight.refusal?.message ?? 'This build\'s storage runtime did not pass its preflight.', healthStatus: 503 };
  const state = preflight.state;
  if (!state) return { state: 'recovery-required', code: 'storage-state-unobserved', reason: 'The preflight did not look at the state directory\'s storage files.', healthStatus: 200 };
  if (state.problem) return { state: 'unavailable', code: 'storage-state-invalid', reason: state.problem.message, healthStatus: 503 };
  if (state.database === 'present') return undefined;
  const missing = (why: string): StorageRefusal => ({ state: 'recovery-required', code: 'known-storage-missing', reason: `The storage this state directory records is missing (${why}); it is not replaced by a new one.`, healthStatus: 200 });
  if (state.identity !== 'absent') return missing(`its storage identity is ${state.identity}`);
  if (state.sidecars.length) return missing(`its ${state.sidecars.join(' and ')} file is there`);
  const history = await firstPresent(stateDir, [...HISTORY_FILES, 'storage-permissions-pending.json']);
  if (history) return missing(`${history} is there`);
  let names: string[];
  try { names = await readdir(stateDir); } catch (error) { return { state: 'unavailable', code: 'storage-state-invalid', reason: `The state directory cannot be listed: ${(error as Error).message}`, healthStatus: 503 }; }
  for (const name of names.filter(name => isMigrationFolder(name) || name === 'storage-snapshots').sort()) {
    if (await nonEmpty(join(stateDir, name))) return missing(`${name} holds migration history`);
  }
  for (const scope of STORAGE_DOMAINS) {
    const source = await firstPresent(stateDir, LEGACY_SOURCES[scope].filter(isLegacySource));
    if (source) return { state: 'unavailable', code: 'migration-required', reason: `${source} holds ${scope} state from before the SQLite storage; this build does not import it. Start a release that imports it first.`, healthStatus: 503, scope };
  }
  return undefined;
}

const failureRefusal = (failure: StorageFailure | undefined, fallback: string): StorageRefusal => failure
  ? { state: 'unavailable', code: failure.code, reason: failure.message, healthStatus: 503, failure }
  : { state: 'unavailable', code: 'not-ready', reason: fallback, healthStatus: 503 };
function errorRefusal(error: unknown, database: StorageClient): StorageRefusal {
  if (error instanceof StorageInitializationError) return { state: 'recovery-required', code: error.code, reason: error.message, healthStatus: 200, scope: error.scope };
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof StorageCommandError) {
    const at = new Date().toISOString();
    return { state: 'unavailable', code: error.code, reason: message, healthStatus: 503,
      failure: { phase: error.phase, code: error.code, message, retryable: error.retryable, sourcePreserved: database.status().failure?.sourcePreserved ?? error.disposition === 'not-committed', at } };
  }
  return { state: 'unavailable', code: 'storage-initialization-failed', reason: message, healthStatus: 503 };
}

export interface OpenWorkerStorageInput {
  stateDir: string;
  bundle: StorageBundleCapture;
  preflight: StoragePreflight;
  /** The client of an earlier attempt: reopened (with `reopen`) when it is not ready, prepared again only when unclaimed. */
  database?: StorageClient;
  reopen?: boolean;
  limits?: Partial<StorageLimits>;
  onUnavailable?: (status: StorageStatus) => void;
  /** Asked between steps; false stops the attempt (the caller's hold moved on), answering `aborted`. */
  proceed?: () => boolean;
}
export interface OpenWorkerStorageResult {
  database?: StorageClient;
  refusal?: StorageRefusal;
  aborted?: true;
  domains?: { scope: StorageDomainScope; result: 'present' | 'created' }[];
}

/**
 * The worker's storage start (and its explicit retry). Never migrates an existing storage: a behind one is refused
 * unchanged at open; only an empty file is given the schema. Answers the client (whenever one was opened, so a retry
 * can reopen it) with either the domains, a refusal, or `aborted`.
 */
export async function openWorkerStorage(input: OpenWorkerStorageInput): Promise<OpenWorkerStorageResult> {
  const proceed = input.proceed ?? (() => true);
  let database = input.database;
  const result = (extra: Omit<OpenWorkerStorageResult, 'database'>): OpenWorkerStorageResult => ({ ...(database ? { database } : {}), ...extra });
  const refusal = await storagePreopenRefusal(input.stateDir, input.preflight);
  if (refusal) return result({ refusal });
  if (!proceed()) return result({ aborted: true });
  if (!database) database = await openStorage({ stateDir: input.stateDir, bundle: input.bundle, limits: input.limits, onUnavailable: input.onUnavailable, refuseBehind: true });
  else if (database.status().state !== 'ready') {
    if (!input.reopen) return result({ refusal: failureRefusal(database.status().failure, 'Storage is not open.') });
    await database.reopen();
  }
  if (!proceed()) return result({ aborted: true });
  if (database.status().state !== 'ready') return result({ refusal: failureRefusal(database.status().failure, 'Storage did not open.') });
  try {
    if (database.status().ownerEpoch === undefined) {
      await database.prepare({ allowMigration: database.status().schema?.kind === 'empty' });
      if (!proceed()) return result({ aborted: true });
    }
    const held = async (): Promise<StorageRefusal | undefined> => {
      const gate = await database!.gate('core');
      if (gate.open) return undefined;
      if (database!.status().state !== 'ready') return failureRefusal(database!.status().failure, gate.reasons.join(', '));
      return { state: 'recovery-required', code: 'storage-gate-held', reason: gate.reasons.join(', '), healthStatus: 200 };
    };
    const first = await held();
    if (first) return result({ refusal: first });
    if (!proceed()) return result({ aborted: true });
    const domains = await initializeStorageDomains(database, input.stateDir);
    if (!proceed()) return result({ aborted: true });
    const last = await held();
    if (last) return result({ refusal: last });
    return result({ domains });
  } catch (error) {
    return result({ refusal: errorRefusal(error, database) });
  }
}

interface DomainCheck { scope: StorageDomainScope; authority?: DomainAuthority }

/** What each domain's first authority holds: nothing. */
function creator(storage: StorageClient, scope: StorageDomainScope, now: () => number): (id: string, verify: () => Promise<void>) => Promise<unknown> {
  const manifest = freshManifestSha256(scope);
  switch (scope) {
    case 'runs': return (id, verify) => new RunsRepository(storage).importPrepared({ runs: [], created: [], instructions: {} }, manifest, id, verify);
    case 'retention': return (id, verify) => new RetentionRepository(storage).importPrepared({
      journal: journalDocument({ version: 1, migratedAt: now(), entries: [], policies: [] }), observations: observationDocument({ version: 1, entries: [] }),
    }, manifest, id, verify);
    case 'triggers': return (id, verify) => new TriggersRepository(storage).importPrepared(empty(), manifest, id, verify);
    // No state folder: a fresh authority leaves no pending record behind, and an unknown commit is settled by the next start's check.
    case 'permissions': return (id, verify) => new PermissionsRepository(storage).importPrepared({ version: 1, rules: [], requests: [], codex: [] }, manifest, id, verify);
    case 'remote': return (id, verify) => new RemoteRepository(storage).importPrepared(remoteRows([]), manifest, id, verify);
    case 'auto-prompt': return (id, verify) => new AutoPromptRepository(storage).importPrepared(autoPromptRows([]), manifest, id, verify);
    case 'automation-workflows': return (id, verify) => new WorkflowRepository(storage).importPrepared(
      [...workflowRows({ rules: [], workflows: [] }, 'slack'), ...workflowRows({ rules: [], workflows: [] }, 'github')], manifest, id, verify);
  }
}

/**
 * Makes every domain's authority present on a prepared storage whose core gate is open. All seven are checked before
 * anything is written; any refusal throws StorageInitializationError and nothing is written. A domain is present when
 * the database holds it (authority `database`) with no stranded stages. A missing authority is created, empty, only
 * when the domain's tables hold no row (state and stages included) and none of its legacy sources or migration
 * evidence is there. Idempotent: a second run finds all present. Every creation uses new command IDs.
 */
export async function initializeStorageDomains(storage: StorageClient, stateDir: string, options: { now?: () => number } = {}): Promise<{ scope: StorageDomainScope; result: 'present' | 'created' }[]> {
  const now = options.now ?? Date.now;
  const authorities = new Map((await storage.inspect()).authority.map(authority => [authority.domain, authority]));
  const checks: DomainCheck[] = [];
  for (const scope of STORAGE_DOMAINS) {
    const authority = authorities.get(scope);
    if (authority?.authority === 'legacy-exported') throw new StorageInitializationError('legacy-exported', scope, `${scope} was exported back to its legacy files; only the owner can recover it.`);
    const stages = await stagesOf(storage, scope);
    if (stages) throw new StorageInitializationError('stages-held', scope, `${scope} holds ${stages} unfinished staged write(s); they need explicit owner recovery.`);
    if (authority) {
      // The domain's own head validates its authority and state together.
      await storage.read(scope, 'head', {});
      checks.push({ scope, authority });
      continue;
    }
    const occupied = await storage.read<string[]>(scope, OCCUPIED_TABLES_COMMAND, {});
    if (occupied.length) throw new StorageInitializationError('authority-missing', scope, `${scope} has rows (${occupied.join(', ')}) but no authority; they are not adopted or replaced.`);
    const source = await legacySource(stateDir, scope);
    if (source) throw new StorageInitializationError('legacy-source-present', scope, `${scope} has no authority while ${source} is there; this build does not import it.`);
    checks.push({ scope });
  }
  const results: { scope: StorageDomainScope; result: 'present' | 'created' }[] = [];
  for (const { scope, authority } of checks) {
    if (authority) { results.push({ scope, result: 'present' }); continue; }
    await creator(storage, scope, now)(`fresh-${scope}-${randomUUID()}`, async () => {
      const source = await legacySource(stateDir, scope);
      if (source) throw new StorageInitializationError('legacy-source-present', scope, `${source} appeared while ${scope} was being initialized.`);
    });
    await requireDomainAuthority(storage, scope);
    results.push({ scope, result: 'created' });
  }
  return results;
}
