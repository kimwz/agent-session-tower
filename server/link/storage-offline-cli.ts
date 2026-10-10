import { join, resolve } from 'node:path';
import { acquireStrictStateLock } from '../instance/state-lock.js';
import { captureStorageBundle, storageBuildContext, preflightStorage, openStorage, type StorageClient } from '../storage/index.js';
import { databaseSupported } from './storage-update.js';
import { readSnapshot, readStorageIdentity } from '../storage/recovery.js';
import { storageLayout } from '../storage/paths.js';
import { beginOfflineActivation, decodeOfflineActivation, prepareOfflineActivation, recordOfflineDomainCompletion, verifyProtectedOfflineArtifact, readOfflinePrivateBytes } from './storage-offline.js';
import { collectOfflineBackup, restoreOfflineBackup } from './storage-offline-backup.js';
import { workerLegacyFiles, importRuns } from '../runs/storage-transfer.js';
import { RunsRepository } from '../runs/storage-repository.js';
import { TriggersRepository } from '../triggers/storage-repository.js';
import { importTriggers } from '../triggers/storage-transfer.js';
import { importRetention } from '../sessions/retention/storage-transfer.js';
import { PermissionsRepository } from '../permissions/storage-repository.js';
import { importPermissions } from '../permissions/storage-transfer.js';

/** Explicit local command. A conflict refuses immediately; no PID cleanup, service stop, provider, or network calls. */
export async function runOfflineStorageCommand(args: string[]): Promise<unknown> {
  const [action, ...options]=args;
  if (!['backup','store','restore'].includes(action ?? '')) throw new Error('Usage: storage offline backup|store|restore --state-dir <path> --input <private-file-or-new-backup-root>');
  const values=new Map<string,string>();
  for(let i=0;i<options.length;i+=2) {
    if(!['--state-dir','--input'].includes(options[i]) || !options[i+1] || values.has(options[i])) throw new Error('Offline requires exact --state-dir and --input; no force option.');
    values.set(options[i],resolve(options[i+1]));
  }
  const stateDir=values.get('--state-dir'), input=values.get('--input');
  if(!stateDir || !input) throw new Error('Offline requires explicit state directory and input.');
  const layout=await storageLayout(stateDir);
  if(layout.stateDir!==stateDir) throw new Error('Offline state directory must be canonical.');
  const lease=await acquireStrictStateLock(join(stateDir,'runner-runtime'));
  let storage:StorageClient|undefined;
  try {
    const bundle=await captureStorageBundle(), context=storageBuildContext(bundle);
    if(!context.ok) throw new Error('Offline requires actual captured SDK.');
    const preflight=await preflightStorage({bundle,stateDir});
    const update={ stateDir,managed:false,legacyFiles:(domain:string)=>workerLegacyFiles(stateDir,domain),build:{ version:context.identity.appVersion,manifest:context.manifest,preflight } };
    if(action==='backup') {
      if(!preflight.supported || preflight.state?.problem) throw new Error('Backup storage preflight held.');
      storage=await openStorage({stateDir,bundle,limits:{maxPayloadBytes:16*1024*1024}});
      const snapshot=await storage.snapshot();
      const closed=await storage.close(); storage=undefined;
      if(!['closed','already-closed','thread-exited'].includes(closed.ack)) throw new Error('Snapshot SDK did not close.');
      return await collectOfflineBackup({stateDir,root:input,snapshotId:snapshot.id,lease});
    }
    const payload:unknown=JSON.parse((await readOfflinePrivateBytes(input)).toString('utf8'));
    if(action==='restore') {
      const activation=decodeOfflineActivation(payload);
      const descriptor=activation.backup;
      if(activation.stateDir!==stateDir) throw new Error('Restore activation directory mismatch.');
      const oldContract=await verifyProtectedOfflineArtifact(activation);
      const snapshot=await readSnapshot(descriptor.root,descriptor.snapshotId);
      const supported=databaseSupported(oldContract,{schema:{kind:'current',storageId:snapshot.storageId,applied:snapshot.schema},authority:snapshot.authority});
      if(!supported.ok) throw new Error(supported.reason);
      const identity=await readStorageIdentity(layout);
      if(identity.state!=='present' || identity.identity.state!=='created') throw new Error('Restore identity held.');
      storage=await openStorage({stateDir,bundle,limits:{maxPayloadBytes:16*1024*1024}});
      const inspection=await storage.inspect();
      const closed=await storage.close(); storage=undefined;
      if(!['closed','already-closed','thread-exited'].includes(closed.ack)) throw new Error('Restore SDK did not close.');
      return await restoreOfflineBackup({descriptor,stateDir,storageId:identity.identity.storageId,lease,context,known:{schema:inspection.schema.kind==='empty' ? [] : inspection.schema.applied.map(({scope,version})=>({scope,version})),authority:inspection.authority,ownerEpoch:inspection.ownerEpoch}});
    }
    const record=decodeOfflineActivation(payload);
    const owner=await beginOfflineActivation({lease,runtimeDir:join(stateDir,'runner-runtime'),record,update});
    storage=await openStorage({stateDir,bundle,limits:{maxPayloadBytes:16*1024*1024}});
    await prepareOfflineActivation(owner,storage,update);
    // The integrated C/T/P stores share one SDK and emit no runtime effects. E completion is deliberately unavailable here.
    for(const scope of ['retention','runs','triggers','permissions']) {
      const authority=(await storage.inspect()).authority.find(a=>a.domain===scope);
      const commandId=`offline-${record.activationId}-${scope}`;
      if(!authority) {
        if(scope==='retention') await importRetention({storage,stateDir,evidenceParent:join(stateDir,'storage-migrations'),commandId,update,activation:owner});
        if(scope==='runs') await importRuns({storage,stateDir,evidenceParent:join(stateDir,'runs-storage-migrations'),commandId,update,activation:owner,repository:new RunsRepository(storage)});
        if(scope==='triggers') await importTriggers({stateDir,evidenceParent:join(stateDir,'triggers-storage-migrations'),commandId,update,activation:owner,repository:new TriggersRepository(storage),now:Date.now});
        if(scope==='permissions') await importPermissions({stateDir,commandId,update,activation:owner,repository:new PermissionsRepository(storage,stateDir)});
      }
      await recordOfflineDomainCompletion(owner,storage,scope);
    }
    return { activationId:record.activationId,state:'held',completedStoreScopes:['retention','runs','triggers','permissions'],remaining:'E integration, final whole-domain completion and graceful scheduled handoff' };
  } finally {
    if(storage) { const result=await storage.close(); if(!['closed','already-closed','thread-exited'].includes(result.ack)) throw new Error('Offline SDK did not close; lease retained.'); }
    await lease.release();
  }
}
