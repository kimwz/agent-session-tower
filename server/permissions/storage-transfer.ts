import { join } from 'node:path';
import { privateDirectory, storageFs } from '../storage/paths.js';
import { fileSha256 } from '../storage/recovery.js';
import { readOfflinePrivateBytes, checkStorageActivation, type OfflineActivationOwner } from '../link/storage-offline.js';
import type { StorageUpdateInput } from '../link/storage-update.js';
import { PermissionsRepository } from './storage-repository.js';
import { permissionRows } from './storage-codec.js';

/** First import is storage-only. The exact raw source and its seal survive unknown outcomes. */
export async function importPermissions(input: { repository: PermissionsRepository; stateDir: string; activation: OfflineActivationOwner; update: StorageUpdateInput; commandId: string }): Promise<void> {
  const { repository, stateDir, commandId }=input;
  if ((await repository.head()).authority) throw new Error('Permission authority exists; JSON replay forbidden.');
  const check=async()=> { const result=await checkStorageActivation({ kind:'offline',owner:input.activation,update:input.update,storage:repository.storage },'permissions'); if(!result.importAllowed) throw new Error('Permission offline store gate held.'); };
  await check();
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
