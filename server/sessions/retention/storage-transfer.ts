import { checkStorageActivation, type OfflineActivationOwner } from '../../link/storage-offline.js';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StorageClient } from '../../storage/client.js';
import { storageFs } from '../../storage/paths.js';
import { evaluateStorageUpdate, type StorageUpdateInput } from '../../link/storage-update.js';
import { journalDocument, observationDocument, retentionHash, JOURNAL_BYTES, OBSERVATION_BYTES, CANONICAL_JOURNAL_BYTES, CANONICAL_OBSERVATION_BYTES, type RetentionDocuments } from './storage-codec.js';
import { RetentionRepository } from './storage-repository.js';
import { privateDirectory } from './store.js';

/** Only exact absence is fresh. Directories, backups and inaccessible paths are history/unknown. */
export async function retentionLegacyFiles(stateDir: string, domain: string): Promise<'absent' | 'present'> {
  if (domain !== 'retention') return 'present';
  for (const name of ['retention', 'retention-observations.json', 'retention-cold', 'retention-originals', 'storage-migrations']) {
    try { await lstat(join(stateDir, name)); return 'present'; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'present'; }
  }
  return 'absent';
}

/** Raw migration/export evidence is private, immutable and outside settings backup. Never opens native/cold objects. */
async function raw(path: string, budget: number): Promise<Buffer> {
  await privateFolder(dirname(path));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > budget || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error(`Unsafe retention source: ${path}`);
    const bytes = await file.readFile();
    if (bytes.length > budget) throw new Error('Retention source grew beyond its accepted budget.');
    return bytes;
  } finally { await file.close(); }
}
async function privateFolder(path: string): Promise<void> {
  const absolute = resolve(path); let current = '/';
  for (const piece of absolute.split('/').filter(Boolean)) {
    current = join(current, piece);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe retention evidence parent: ${current}`);
  }
  const info = await lstat(absolute);
  if (info.uid !== process.getuid?.() || info.mode & 0o077) throw new Error('Retention evidence directory must be owner-only.');
}
export async function holdRetentionEvidence(stateDir: string): Promise<void> {
  const evidenceParent = join(stateDir, 'storage-migrations');
  let evidenceExists = false;
  try { await lstat(evidenceParent); evidenceExists = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (evidenceExists) {
    await privateFolder(evidenceParent);
    const evidenceDirectory = await opendir(evidenceParent);
    try { if (await evidenceDirectory.read()) throw new Error('Retention import evidence exists without authority; explicit owner recovery required.'); }
    finally { await evidenceDirectory.close(); }
  }
}
async function seal(parent: string, id: string, files: Record<string, Buffer>, facts: Record<string, unknown>): Promise<{ directory: string; manifestSha256: string }> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid retention evidence ID.');
  await privateFolder(parent);
  const directory = join(parent, id);
  await mkdir(directory, { mode: 0o700 });
  const hashes: Record<string, { bytes: number; sha256: string }> = {};
  for (const [name, bytes] of Object.entries(files)) {
    const path = join(directory, name), file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    const readback = await raw(path, Math.max(JOURNAL_BYTES, bytes.length));
    if (!readback.equals(bytes)) throw new Error('Retention backup readback mismatch.');
    hashes[name] = { bytes: bytes.length, sha256: retentionHash(bytes) };
  }
  const manifest = Buffer.from(JSON.stringify({ version: 1, domain: 'retention', ...facts, files: hashes }));
  const handle = await open(join(directory, 'manifest.json'), 'wx', 0o600);
  try { await handle.writeFile(manifest); await handle.sync(); } finally { await handle.close(); }
  if (!(await raw(join(directory, 'manifest.json'), JOURNAL_BYTES)).equals(manifest)) throw new Error('Retention manifest readback mismatch.');
  for (const path of [directory, parent]) { const folder = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { await folder.sync(); } finally { await folder.close(); } }
  return { directory, manifestSha256: retentionHash(manifest) };
}
export interface RetentionImportInput {
  storage: StorageClient; stateDir: string; evidenceParent: string; commandId?: string;
  /** The actual shared evaluator input, using this client's captured build/preflight and existing artifact probe. */
  update: StorageUpdateInput; activation?: OfflineActivationOwner;
  /** Same bootstrap owner retains uncertain writes across explicit startup retries. */
  repository?: RetentionRepository;
}
/** Prepared only: production A's actual manifest refuses before any raw source backup or staging. */
export async function importRetention(input: RetentionImportInput): Promise<{ directory: string; manifestSha256: string }> {
  const repository = input.repository ?? new RetentionRepository(input.storage);
  if (repository.storage !== input.storage) throw new Error('Retention import repository belongs to another SDK owner.');
  if ((await repository.head()).authority) throw new Error('Retention marker exists; source JSON must never be reimported.');
  const context = input.storage.context;
  const domain = context?.manifest.domains.find(domain => domain.scope === 'retention');
  if (!domain?.cutover) throw Object.assign(new Error('Retention preparation has no cutover contract.'), { storageCode: 'no-cutover-contract' });
  if (input.update.stateDir !== input.stateDir || input.update.build.preflight.identity?.sourceHash !== context!.identity.sourceHash || input.update.build.manifest?.digest !== context!.manifest.digest || input.update.build.version !== context!.identity.appVersion) throw new Error('Retention import update evidence is for another captured build.');
  const check = async () => {
    const evaluation = await checkStorageActivation(input.activation ? { kind: 'offline', owner: input.activation, update: input.update, storage: input.storage } : { kind: 'normal', update: input.update }, 'retention');
    if (!evaluation.importAllowed || evaluation.verdict !== 'ready') throw new Error(`Retention import held: ${evaluation.code}: ${evaluation.reason}`);
    await repository.gate();
  };
  await check();
  const journalPath = join(input.stateDir, 'retention', 'journal.json'), observationsPath = join(input.stateDir, 'retention-observations.json');
  // Missing known sources are an error, never inferred to mean an empty retention history.
  const journal = await raw(journalPath, JOURNAL_BYTES), observations = await raw(observationsPath, OBSERVATION_BYTES);
  const documents: RetentionDocuments = { journal: journalDocument(JSON.parse(journal.toString('utf8'))), observations: observationDocument(JSON.parse(observations.toString('utf8'))) };
  const id = input.commandId ?? `retention-${randomUUID()}`;
  const evidence = await seal(input.evidenceParent, id, { 'journal.json': journal, 'retention-observations.json': observations }, { kind: 'first-import', build: context!.identity, canonicalSha256: retentionHash(JSON.stringify(documents)) });
  if (!journal.equals(await raw(journalPath, JOURNAL_BYTES)) || !observations.equals(await raw(observationsPath, OBSERVATION_BYTES))) throw new Error('Retention source changed after backup.');
  await check();
  await repository.importPrepared(documents, evidence.manifestSha256, id, async () => {
    if (!journal.equals(await raw(journalPath, JOURNAL_BYTES)) || !observations.equals(await raw(observationsPath, OBSERVATION_BYTES))) throw new Error('Retention source changed during staging.');
    await check();
  });
  return evidence;
}

/** One worker-owned continuation, shared by startup and journal retry. No lost intent is replayed. */
export function retentionBootstrap(storage: StorageClient, stateDir: string, update: () => Promise<StorageUpdateInput>, fresh: boolean): () => Promise<void> {
  const repository = new RetentionRepository(storage);
  let failedIntent: unknown;
  let pending: Promise<void> | undefined;
  const start = async () => {
    await repository.gate(); // SDK reopen alone cannot settle this owner's unknown result.
    if (await repository.databaseAuthority()) return;
    if (failedIntent) throw failedIntent;
    const current = await update();
    const context = storage.context;
    if (!context || current.stateDir !== stateDir || current.build.version !== context.identity.appVersion || current.build.preflight.identity?.sourceHash !== context.identity.sourceHash || current.build.manifest?.digest !== context.manifest.digest) throw new Error('Retention bootstrap evidence is for another captured build.');
    const evaluation = await evaluateStorageUpdate(current);
    if (!evaluation.importAllowed || evaluation.verdict !== 'ready') throw new Error(`Retention bootstrap held: ${evaluation.code}: ${evaluation.reason}`);
    const domain = storage.context?.manifest.domains.find(domain => domain.scope === 'retention');
    if (fresh && await retentionLegacyFiles(stateDir, 'retention') !== 'absent') throw new Error('Fresh retention state gained source history; initialization held.');
    const evidenceParent = join(stateDir, 'storage-migrations');
    // A sealed attempt survives a worker crash even without a final receipt/marker.
    // Preparation-only builds must keep the same recovery hold before JSON fallback.
    await holdRetentionEvidence(stateDir);
    if (!domain?.cutover) {
      // Known legacy history cannot become an empty journal through ENOENT fallback.
      if (await retentionLegacyFiles(stateDir, 'retention') === 'present') {
        journalDocument(JSON.parse((await raw(join(stateDir, 'retention', 'journal.json'), JOURNAL_BYTES)).toString('utf8')));
      }
      return;
    }
    await privateDirectory(evidenceParent);
    await storageFs.syncDirectory(stateDir);
    try {
      if (!fresh) await importRetention({ storage, stateDir, evidenceParent, update: current, repository });
      else {
        const documents: RetentionDocuments = {
          journal: journalDocument({ version: 1, migratedAt: Date.now(), entries: [], policies: [] }),
          observations: observationDocument({ version: 1, entries: [] }),
        };
        const id = `retention-${randomUUID()}`;
        const evidence = await seal(evidenceParent, id, {}, { kind: 'fresh-initialization', build: storage.identity, canonicalSha256: retentionHash(JSON.stringify(documents)) });
        await repository.importPrepared(documents, evidence.manifestSha256, id, async () => {
          // The evidence folder is ours; source paths must still be absent before final commit.
          for (const name of ['retention', 'retention-observations.json', 'retention-cold', 'retention-originals']) {
            try { await lstat(join(stateDir, name)); throw new Error('Fresh retention source appeared during initialization.'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          }
          const checked = await evaluateStorageUpdate(await update());
          if (!checked.importAllowed || checked.verdict !== 'ready') throw new Error(`Fresh retention initialization held: ${checked.code}`);
        });
      }
    } catch (error) {
      if (repository.lastIntent) failedIntent = error;
      throw error;
    }
  };
  return () => pending ??= start().finally(() => { pending = undefined; });
}
/** Current generation only. Seals private legacy files and manifest without changing authority or starting an old writer. */
export async function exportRetention(storage: StorageClient, evidenceParent: string, id = `retention-export-${randomUUID()}`): Promise<{ directory: string; manifestSha256: string }> {
  const repository = new RetentionRepository(storage), current = await repository.exportCurrent();
  const journal = Buffer.from(JSON.stringify(current.documents.journal)), observations = Buffer.from(JSON.stringify(current.documents.observations));
  if (journal.length > CANONICAL_JOURNAL_BYTES || observations.length > CANONICAL_OBSERVATION_BYTES) throw new Error('Current retention export exceeds its bounded canonical restore allowance.');
  const evidence = await seal(evidenceParent, id, {
    'journal.json': journal,
    'retention-observations.json': observations,
  }, { kind: 'current-db-export', head: current.head, canonicalSha256: current.sha256, build: storage.identity });
  const last = await repository.head();
  if (last.revision !== current.head.revision || last.authority?.generation !== current.head.authority?.generation) throw new Error('Retention changed before current export was sealed.');
  return evidence;
}

/** Explicit metadata restore from a sealed CURRENT DB export, using the same receipt transaction. */
export async function restoreRetention(storage: StorageClient, directory: string, commandId: string): Promise<void> {
  await privateFolder(directory);
  const manifest = JSON.parse((await raw(join(directory, 'manifest.json'), JOURNAL_BYTES)).toString('utf8')) as Record<string, unknown>;
  if (manifest.version !== 1 || manifest.domain !== 'retention' || manifest.kind !== 'current-db-export') throw new Error('Not a current retention DB export.');
  const repository = new RetentionRepository(storage), current = await repository.head();
  const exportedHead = manifest.head as { authority?: unknown } | undefined;
  if (!current.authority || JSON.stringify(exportedHead?.authority) !== JSON.stringify(current.authority)) throw new Error('Retention restore export belongs to another authority generation.');
  const facts = manifest.files as Record<string, { bytes: number; sha256: string }>;
  const read = async (name: string, budget: number) => {
    const bytes = await raw(join(directory, name), budget);
    if (!facts?.[name] || facts[name].bytes !== bytes.length || facts[name].sha256 !== retentionHash(bytes)) throw new Error('Retention restore source hash mismatch.');
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!bytes.equals(Buffer.from(JSON.stringify(value)))) throw new Error('Retention restore source is not the exact canonical export.');
    return value;
  };
  const documents = { journal: journalDocument(await read('journal.json', CANONICAL_JOURNAL_BYTES)), observations: observationDocument(await read('retention-observations.json', CANONICAL_OBSERVATION_BYTES)) };
  if (retentionHash(JSON.stringify(documents)) !== manifest.canonicalSha256) throw new Error('Retention restore canonical digest mismatch.');
  await repository.restore(documents, commandId, current.authority.generation);
}
