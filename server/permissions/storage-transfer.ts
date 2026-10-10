import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { privateDirectory, storageFs } from '../storage/paths.js';
import { fileSha256 } from '../storage/recovery.js';
import { readOfflinePrivateBytes, checkStorageActivation, type OfflineActivationOwner } from '../link/storage-offline.js';
import type { StorageUpdateInput } from '../link/storage-update.js';
import { PermissionsRepository } from './storage-repository.js';
import { permissionRows } from './storage-codec.js';

export async function holdPermissionsEvidence(stateDir: string): Promise<void> {
  const parent=join(stateDir,'permissions-storage-migrations');
  if (!await privateDirectory(parent,false)) return;
  const directory=await opendir(parent);
  try { if (await directory.read()) throw new Error('Permission seal without authority requires explicit recovery.'); }
  finally { await directory.close(); }
}

/** First import is storage-only. The exact raw source and its seal survive unknown outcomes. */
export async function importPermissions(input: { repository: PermissionsRepository; stateDir: string; activation: OfflineActivationOwner; update: StorageUpdateInput; commandId: string }): Promise<void> {
  const { repository, stateDir, commandId }=input;
  if ((await repository.head()).authority) throw new Error('Permission authority exists; JSON replay forbidden.');
  const check=async()=> { const result=await checkStorageActivation({ kind:'offline',owner:input.activation,update:input.update,storage:repository.storage },'permissions'); if(!result.importAllowed) throw new Error('Permission offline store gate held.'); };
  await check();
  await holdPermissionsEvidence(stateDir);
  const source=join(stateDir,'permissions.json'), bytes=await readOfflinePrivateBytes(source);
  const state:unknown=JSON.parse(bytes.toString('utf8')); permissionRows(state);
  const parent=join(stateDir,'permissions-storage-migrations');
  await privateDirectory(parent,true);
  const directory=join(parent,commandId);
  // Existing seal without authority is held for explicit receipt reconciliation, never replayed.
  if(await privateDirectory(directory,false)) throw new Error('Permission seal without authority requires explicit recovery.');
  await privateDirectory(directory,true);
  const raw=join(directory,'permissions.json');
  await storageFs.copyFile(source,raw); await storageFs.syncDirectory(directory);
  if(!(await readOfflinePrivateBytes(raw)).equals(bytes)) throw new Error('Permission raw seal readback mismatch.');
  const manifest=join(directory,'manifest.json');
  await storageFs.createFile(manifest,JSON.stringify({ version:1,domain:'permissions',kind:'first-import',build:repository.storage.identity,files:{ 'permissions.json':{ bytes:bytes.length,sha256:await fileSha256(raw) } } }));
  await storageFs.syncDirectory(directory);
  const manifestSha256=await fileSha256(manifest);
  await repository.importPrepared(state,manifestSha256,commandId,async()=>{
    if(!(await readOfflinePrivateBytes(source)).equals(bytes) || await fileSha256(manifest)!==manifestSha256) throw new Error('Permission sealed source changed.');
    await check();
  });
}

export async function permissionsLegacyFiles(stateDir: string): Promise<'absent' | 'present'> {
  for (const name of ['permissions.json', 'permissions-storage-migrations', 'storage-permissions-pending.json']) {
    try { await lstat(join(stateDir, name)); return 'present'; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'present'; }
  }
  return 'absent';
}

/** Only the worker's captured no-DB/no-history proof admits this normal bootstrap. */
export async function bootstrapFreshPermissions(repository: PermissionsRepository, stateDir: string, checkFresh: () => Promise<void>): Promise<void> {
  if ((await repository.head()).authority) return;
  await checkFresh();
  if (await permissionsLegacyFiles(stateDir) !== 'absent') throw new Error('Permission source/history appeared before fresh initialization.');
  await holdPermissionsEvidence(stateDir);
  const state = { version: 1, rules: [], requests: [], codex: [] };
  const commandId = `permissions-${randomUUID()}`;
  const parent = join(stateDir, 'permissions-storage-migrations');
  await privateDirectory(parent, true);
  const directory = join(parent, commandId);
  await privateDirectory(directory, true);
  const manifest = join(directory, 'manifest.json');
  await storageFs.createFile(manifest, JSON.stringify({ version: 1, domain: 'permissions', kind: 'fresh-initialization', build: repository.storage.identity, files: {} }));
  await storageFs.syncDirectory(directory);
  await storageFs.syncDirectory(parent);
  await storageFs.syncDirectory(stateDir);
  const manifestSha256 = await fileSha256(manifest);
  await repository.importPrepared(state, manifestSha256, commandId, async () => {
    for (const name of ['permissions.json', 'storage-permissions-pending.json']) {
      try { await lstat(join(stateDir, name)); throw new Error('Permission source/pending appeared during initialization.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (await fileSha256(manifest) !== manifestSha256) throw new Error('Permission fresh seal changed.');
    await checkFresh();
  });
}
