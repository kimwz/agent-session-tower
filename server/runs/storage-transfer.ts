import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StorageClient } from '../storage/client.js';
import { evaluateStorageUpdate, type StorageUpdateInput } from '../link/storage-update.js';
import { retentionLegacyFiles } from '../sessions/retention/storage-transfer.js';
import { canonical, documentsHash, parseRunDocuments, runHash, RUN_SOURCE_BYTES, RUN_DEPENDENCY_BYTES } from './storage-codec.js';
import { RunsRepository } from './storage-repository.js';
/** Exact domain-specific probes; a different domain's evidence never proves runs absent. */
export async function runsLegacyFiles(stateDir: string): Promise<'absent' | 'present'> {
  for (const name of ['runs.json','created-sessions.json','run-instructions.json','runs-storage-migrations']) {
    try { await lstat(join(stateDir,name)); return 'present'; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'present'; }
  }
  return 'absent';
}
export async function workerLegacyFiles(stateDir: string, domain: string): Promise<'absent' | 'present'> {
  if (domain === 'runs') return runsLegacyFiles(stateDir);
  if (domain === 'retention') return retentionLegacyFiles(stateDir,domain);
  return 'present';
}
/** Raw migration/export evidence is private, immutable and outside settings backup. Never opens native/cold objects. */
async function raw(path: string, budget: number): Promise<Buffer> {
  await privateFolder(dirname(path));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > budget || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error(`Unsafe runs source: ${path}`);
    const bytes = await file.readFile();
    if (bytes.length > budget) throw new Error('Runs source grew beyond its accepted budget.');
    return bytes;
  } finally { await file.close(); }
}
async function privateFolder(path: string): Promise<void> {
  const absolute = resolve(path); let current = '/';
  for (const piece of absolute.split('/').filter(Boolean)) {
    current = join(current, piece);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe runs evidence parent: ${current}`);
  }
  const info = await lstat(absolute);
  if (info.uid !== process.getuid?.() || info.mode & 0o077) throw new Error('Runs evidence directory must be owner-only.');
}
/** A prior seal holds JSON fallback even when the final SQL transaction never committed. */
export async function holdRunsEvidence(stateDir: string): Promise<void> {
  const parent = join(stateDir, 'runs-storage-migrations');
  try { await lstat(parent); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  await privateFolder(parent);
  const directory = await opendir(parent);
  try { if (await directory.read()) throw new Error('Runs import evidence exists without authority; explicit owner recovery required.'); }
  finally { await directory.close(); }
}
async function seal(parent: string, id: string, files: Record<string, Buffer>, facts: Record<string, unknown>): Promise<{ directory: string; manifestSha256: string }> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid runs evidence ID.');
  await privateFolder(parent);
  const directory = join(parent, id);
  await mkdir(directory, { mode: 0o700 });
  const hashes: Record<string, { bytes: number; sha256: string }> = {};
  for (const [name, bytes] of Object.entries(files)) {
    const path = join(directory, name), file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    const readback = await raw(path, Math.max(RUN_SOURCE_BYTES, bytes.length));
    if (!readback.equals(bytes)) throw new Error('Runs backup readback mismatch.');
    hashes[name] = { bytes: bytes.length, sha256: runHash(bytes) };
  }
  const manifest = Buffer.from(JSON.stringify({ version: 1, domain: 'runs', ...facts, files: hashes }));
  const handle = await open(join(directory, 'manifest.json'), 'wx', 0o600);
  try { await handle.writeFile(manifest); await handle.sync(); } finally { await handle.close(); }
  if (!(await raw(join(directory, 'manifest.json'), RUN_SOURCE_BYTES)).equals(manifest)) throw new Error('Runs manifest readback mismatch.');
  for (const path of [directory, parent]) { const folder = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { await folder.sync(); } finally { await folder.close(); } }
  return { directory, manifestSha256: runHash(manifest) };
}
export interface RunsImportInput {
  storage: StorageClient; stateDir: string; evidenceParent: string; commandId: string;
  update: StorageUpdateInput; repository: RunsRepository;
}
/** Prepared import entry for B. Production A never calls this and refuses before source access. */
export async function importRuns(input: RunsImportInput): Promise<{ directory: string; manifestSha256: string }> {
  const { repository, storage } = input;
  if (repository.storage !== storage) throw new Error('Runs import belongs to another SDK owner.');
  const context = storage.context;
  if (!context?.manifest.domains.find(domain => domain.scope === 'runs')?.cutover) throw new Error('Runs preparation has no cutover contract.');
  if ((await repository.head()).authority) throw new Error('Runs marker exists; source JSON must never be reimported.');
  if (input.update.stateDir !== input.stateDir || input.update.build.preflight.identity?.sourceHash !== context.identity.sourceHash || input.update.build.manifest?.digest !== context.manifest.digest || input.update.build.version !== context.identity.appVersion) throw new Error('Runs import evidence belongs to another captured build.');
  const check = async () => {
    const evaluation = await evaluateStorageUpdate(input.update);
    if (!evaluation.importAllowed || evaluation.verdict !== 'ready') throw new Error(`Runs import held: ${evaluation.code}: ${evaluation.reason}`);
    await repository.gate();
  };
  await check();
  // Missing known dependencies are never inferred empty. Explicit fresh initialization
  // belongs to B's bootstrap, not the raw legacy importer.
  const sources = {
    runs: await raw(join(input.stateDir,'runs.json'),RUN_SOURCE_BYTES),
    created: await raw(join(input.stateDir,'created-sessions.json'),RUN_DEPENDENCY_BYTES),
    instructions: await raw(join(input.stateDir,'run-instructions.json'),RUN_DEPENDENCY_BYTES),
  };
  const documents = parseRunDocuments(sources);
  const evidence = await seal(input.evidenceParent,input.commandId,{
    'runs.json': sources.runs, 'created-sessions.json': sources.created, 'run-instructions.json': sources.instructions,
  },{ kind: 'first-import', build: context.identity, canonicalSha256: documentsHash(documents) });
  const unchanged = async () => {
    for (const [key,name,limit] of [['runs','runs.json',RUN_SOURCE_BYTES],['created','created-sessions.json',RUN_DEPENDENCY_BYTES],['instructions','run-instructions.json',RUN_DEPENDENCY_BYTES]] as const) {
      if (!sources[key].equals(await raw(join(input.stateDir,name),limit))) throw new Error('Runs source changed after immutable backup.');
    }
    await check();
  };
  await unchanged();
  await repository.importPrepared(documents,evidence.manifestSha256,input.commandId,unchanged);
  return evidence;
}
/** Sealed current generation projection only; never switches authority to legacy JSON. */
export async function exportRuns(repository: RunsRepository, evidenceParent: string, id = `runs-export-${randomUUID()}`): Promise<{ directory: string; manifestSha256: string }> {
  const current = await repository.exportCurrent();
  const evidence = await seal(evidenceParent,id,{
    'runs.json': Buffer.from(canonical(current.documents.runs)),
    'created-sessions.json': Buffer.from(canonical(current.documents.created)),
    'run-instructions.json': Buffer.from(canonical(current.documents.instructions)),
  },{ kind: 'current-db-export', head: current.head, canonicalSha256: current.sha256, build: repository.storage.identity });
  const last = await repository.head();
  if (last.revision !== current.head.revision || last.authority?.generation !== current.head.authority?.generation) throw new Error('Runs changed before current export was sealed.');
  return evidence;
}
/** Explicit metadata restore. No restart reconciliation or provider execution in the importer. */
export async function restoreRunsStorage(repository: RunsRepository, directory: string, commandId: string): Promise<void> {
  await privateFolder(directory);
  const manifest = JSON.parse((await raw(join(directory,'manifest.json'),RUN_SOURCE_BYTES)).toString('utf8')) as Record<string, unknown>;
  if (manifest.version !== 1 || manifest.domain !== 'runs' || manifest.kind !== 'current-db-export') throw new Error('Not a current runs DB export.');
  const head = await repository.head(), exported = manifest.head as { authority?: unknown } | undefined;
  if (!head.authority || canonical(exported?.authority) !== canonical(head.authority)) throw new Error('Runs restore belongs to another authority generation.');
  const facts = manifest.files as Record<string, { bytes: number; sha256: string }>;
  const read = async (name: string,limit: number) => {
    const bytes = await raw(join(directory,name),6 * limit);
    if (!facts?.[name] || facts[name].bytes !== bytes.length || facts[name].sha256 !== runHash(bytes)) throw new Error('Runs restore source hash mismatch.');
    if (!bytes.equals(Buffer.from(canonical(JSON.parse(bytes.toString('utf8')))))) throw new Error('Runs restore source is not the exact canonical export.');
    return bytes;
  };
  const documents = parseRunDocuments({ runs: await read('runs.json',RUN_SOURCE_BYTES), created: await read('created-sessions.json',RUN_DEPENDENCY_BYTES), instructions: await read('run-instructions.json',RUN_DEPENDENCY_BYTES) },true);
  if (documentsHash(documents) !== manifest.canonicalSha256) throw new Error('Runs restore canonical digest mismatch.');
  await repository.restore(documents,commandId,head.authority.generation);
}
