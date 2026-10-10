import { checkStorageActivation, type OfflineActivationOwner } from '../link/storage-offline.js';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { evaluateStorageUpdate, type StorageUpdateInput } from '../link/storage-update.js';
import { parseState, serializeState, empty, type EngineState } from './state.js';
import { documentsHash, rowsOf, stateOf, triggerHash, TRIGGER_INTENT_BYTES } from './storage-codec.js';
import { TriggersRepository } from './storage-repository.js';

export async function triggersLegacyFiles(stateDir: string): Promise<'absent' | 'present'> {
  for (const name of ['trigger-engine.json','triggers-storage-migrations']) {
    try { await lstat(join(stateDir,name)); return 'present'; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'present'; }
  }
  return 'absent';
}
async function privateFolder(path: string): Promise<void> {
  let current = '/';
  for (const piece of resolve(path).split('/').filter(Boolean)) {
    current = join(current,piece); const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe trigger evidence parent.');
  }
  const info = await lstat(path);
  if (info.uid !== process.getuid?.() || info.mode & 0o077) throw new Error('Trigger evidence must be owner-only.');
}
async function raw(path: string): Promise<Buffer> {
  await privateFolder(dirname(path));
  const file = await open(path,constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > TRIGGER_INTENT_BYTES) throw new Error('Unsafe trigger source.');
    const bytes = await file.readFile();
    if (bytes.length > TRIGGER_INTENT_BYTES || !Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new Error('Invalid trigger source bytes.');
    return bytes;
  } finally { await file.close(); }
}
export async function holdTriggersEvidence(stateDir: string): Promise<void> {
  const parent = join(stateDir,'triggers-storage-migrations');
  try { await lstat(parent); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  await privateFolder(parent); const directory = await opendir(parent);
  try { if (await directory.read()) throw new Error('Trigger seal exists without authority; explicit owner recovery required.'); }
  finally { await directory.close(); }
}
/** DB authority precedes every legacy read. A never imports; sealed/staged history holds fallback. */
export async function bootstrapTriggers(repository: TriggersRepository, stateDir: string, input?: { update: () => Promise<StorageUpdateInput>; now: () => number }): Promise<boolean> {
  if (await repository.databaseAuthority()) return true;
  await holdTriggersEvidence(stateDir);
  if ((await repository.storage.read<{ stages: number }>('triggers','bootstrapHistory',{})).stages !== 0) throw new Error('Trigger stages exist without authority; explicit owner recovery required.');
  const context = repository.storage.context;
  if (!context?.manifest.domains.find(domain => domain.scope === 'triggers')?.cutover) return false;
  if (!input) throw new Error('Trigger cutover requires worker bootstrap evidence; JSON fallback forbidden.');
  const current = await input.update();
  const check = async () => {
    const update = await input.update();
    if (update.stateDir !== stateDir || update.build.version !== context.identity.appVersion || update.build.preflight.identity?.sourceHash !== context.identity.sourceHash || update.build.manifest?.digest !== context.manifest.digest) throw new Error('Trigger bootstrap belongs to another captured build.');
    const result = await evaluateStorageUpdate(update);
    if (!result.importAllowed || result.verdict !== 'ready') throw new Error(`Trigger bootstrap held: ${result.code}`);
    await repository.gate();
  };
  await check();
  // Decide before our evidence directory exists; missing source amid legacy history is not empty proof.
  const fresh = await triggersLegacyFiles(stateDir) === 'absent';
  const evidenceParent = join(stateDir,'triggers-storage-migrations');
  await privateFolder(stateDir);
  await mkdir(evidenceParent,{ mode: 0o700,recursive: true });
  const commandId = `triggers-${randomUUID()}`;
  if (!fresh) await importTriggers({ repository,stateDir,evidenceParent,commandId,update: current,now: input.now });
  else {
    const state = empty();
    const evidence = await seal(evidenceParent,commandId,Buffer.from(serializeState(state)),{ kind: 'fresh-initialization',build: context.identity,canonicalSha256: documentsHash(state) });
    await repository.importPrepared(state,evidence.manifestSha256,commandId,async () => {
      try { await lstat(join(stateDir,'trigger-engine.json')); throw new Error('Fresh trigger source appeared during initialization.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await check();
    });
  }
  return true;
}
async function seal(parent: string, id: string, bytes: Buffer, facts: Record<string, unknown>, state?: EngineState): Promise<{ directory: string; manifestSha256: string }> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid trigger evidence ID.');
  await privateFolder(parent); const directory = join(parent,id); await mkdir(directory,{ mode: 0o700 });
  const save = async (name: string, data: Buffer) => {
    const path = join(directory,name), file = await open(path,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o600);
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    if (!(await raw(path)).equals(data)) throw new Error('Trigger seal readback mismatch.');
  };
  await save('trigger-engine.json',bytes);
  const files: Record<string,{ bytes: number; sha256: string }> = { 'trigger-engine.json': { bytes: bytes.length,sha256: triggerHash(bytes) } };
  if (state) { const rows = Buffer.from(rowsOf(state).map(row => JSON.stringify(row)).join('\n') + '\n'); await save('rows.ndjson',rows); files['rows.ndjson'] = { bytes: rows.length,sha256: triggerHash(rows) }; }
  const manifest = Buffer.from(JSON.stringify({ version: 1,domain: 'triggers',...facts,files }));
  await save('manifest.json',manifest);
  for (const path of [directory,parent,dirname(parent)]) { const folder = await open(path,constants.O_RDONLY | constants.O_NOFOLLOW); try { await folder.sync(); } finally { await folder.close(); } }
  return { directory,manifestSha256: triggerHash(manifest) };
}
/** B entry only. Raw backup is sealed before import, and source bytes are rechecked before the receipt transaction. */
export async function importTriggers(input: { repository: TriggersRepository; stateDir: string; evidenceParent: string; commandId: string; update: StorageUpdateInput; activation?: OfflineActivationOwner; now: () => number }): Promise<{ directory: string; manifestSha256: string }> {
  const { repository } = input, context = repository.storage.context;
  if (!context?.manifest.domains.find(domain => domain.scope === 'triggers')?.cutover) throw new Error('Trigger preparation has no cutover contract.');
  if ((await repository.head()).authority) throw new Error('Trigger authority exists; reimport forbidden.');
  await holdTriggersEvidence(input.stateDir);
  if ((await repository.storage.read<{ stages: number }>('triggers','bootstrapHistory',{})).stages !== 0) throw new Error('Trigger stages exist without authority; explicit owner recovery required.');
  if (input.update.stateDir !== input.stateDir || input.update.build.manifest?.digest !== context.manifest.digest || input.update.build.preflight.identity?.sourceHash !== context.identity.sourceHash || input.update.build.version !== context.identity.appVersion) throw new Error('Trigger import belongs to another captured build.');
  const check = async () => { const result = await checkStorageActivation(input.activation ? { kind: 'offline', owner: input.activation, update: input.update, storage: repository.storage } : { kind: 'normal', update: input.update }, 'triggers'); if (!result.importAllowed || result.verdict !== 'ready') throw new Error(`Trigger import held: ${result.code}`); await repository.gate(); };
  await check(); const path = join(input.stateDir,'trigger-engine.json'), bytes = await raw(path);
  const state = parseState(JSON.parse(bytes.toString('utf8')),input.now,false,true);
  if (!state) throw new Error('Invalid trigger source; preserved without import.');
  const evidence = await seal(input.evidenceParent,input.commandId,bytes,{ kind: 'raw-import',build: context.identity,canonicalSha256: documentsHash(state) });
  await repository.importPrepared(state,evidence.manifestSha256,input.commandId,async () => { if (!(await raw(path)).equals(bytes)) throw new Error('Trigger source changed after sealing.'); await check(); });
  return evidence;
}
/** Lossless current legacy projection, including independent once consumption. Does not transfer authority to JSON. */
export async function exportTriggers(repository: TriggersRepository, parent: string, id: string): Promise<{ directory: string; manifestSha256: string }> {
  const current = await repository.exportCurrent();
  return seal(parent,id,Buffer.from(serializeState(current.documents)),{ kind: 'current-export',storageId: current.head.storageId,authorityManifestSha256: current.head.authority!.manifestSha256,generation: current.head.authority!.generation,canonicalSha256: current.sha256,build: repository.storage.context!.identity },current.documents);
}
export async function restoreTriggers(repository: TriggersRepository, directory: string, commandId: string): Promise<void> {
  const manifest = JSON.parse((await raw(join(directory,'manifest.json'))).toString('utf8'));
  const head = await repository.head();
  if (manifest.version !== 1 || manifest.domain !== 'triggers' || manifest.kind !== 'current-export' || manifest.generation !== head.authority?.generation || manifest.storageId !== head.storageId || manifest.authorityManifestSha256 !== head.authority?.manifestSha256) throw new Error('Trigger restore belongs to another authority generation.');
  const bytes = await raw(join(directory,'trigger-engine.json')), fact = manifest.files?.['trigger-engine.json'];
  if (!fact || fact.bytes !== bytes.length || fact.sha256 !== triggerHash(bytes)) throw new Error('Trigger restore source hash mismatch.');
  const rows = await raw(join(directory,'rows.ndjson')), rowFact = manifest.files?.['rows.ndjson'];
  if (!rowFact || rowFact.bytes !== rows.length || rowFact.sha256 !== triggerHash(rows) || rows.at(-1) !== 10) throw new Error('Trigger restore row source mismatch.');
  const state = stateOf(rows.toString('utf8').slice(0,-1).split('\n').map(line => JSON.parse(line)));
  if (documentsHash(state) !== manifest.canonicalSha256 || serializeState(state) !== bytes.toString('utf8')) throw new Error('Trigger restore row digest/projection mismatch.');
  await repository.restore(state,commandId,head.authority!.generation);
}
