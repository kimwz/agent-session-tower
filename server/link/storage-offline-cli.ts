import { RemoteRepository } from '../remote/storage-repository.js';
import { AutoPromptRepository } from '../auto-prompt/storage-repository.js';
import { WorkflowRepository } from '../slack/storage-repository.js';
import { importRemote } from '../remote/storage-transfer.js';
import { importAutoPrompts } from '../auto-prompt/storage-transfer.js';
import { importWorkflows } from '../slack/storage-transfer.js';
import { join, resolve } from 'node:path';
import { acquireStrictStateLock } from '../instance/state-lock.js';
import { captureStorageBundle, storageBuildContext, preflightStorage, openStorage, type StorageClient } from '../storage/index.js';
import { databaseSupported } from './storage-update.js';
import { readSnapshot, readStorageIdentity, readRecoveryBarrier, reconcileRecovery, recoveryHold } from '../storage/recovery.js';
import { storageLayout } from '../storage/paths.js';
import { beginOfflineActivation, checkStorageActivation, finishOfflineActivation, decodeOfflineActivation, prepareOfflineActivation, recordOfflineDomainCompletion, verifyProtectedOfflineArtifact, readOfflinePrivateBytes, verifyOfflineCompletion, readOfflineActivation, verifyOfflineRecoverySnapshot } from './storage-offline.js';
import { collectOfflineBackup, restoreOfflineBackup, verifyOfflineBackup, verifyOfflineRestoredInventory } from './storage-offline-backup.js';
import { workerLegacyFiles, importRuns, holdRunsEvidence } from '../runs/storage-transfer.js';
import { RunsRepository } from '../runs/storage-repository.js';
import { TriggersRepository } from '../triggers/storage-repository.js';
import { importTriggers, holdTriggersEvidence } from '../triggers/storage-transfer.js';
import { importRetention, holdRetentionEvidence } from '../sessions/retention/storage-transfer.js';
import { PermissionsRepository } from '../permissions/storage-repository.js';
import { importPermissions, holdPermissionsEvidence } from '../permissions/storage-transfer.js';

/** Before creating any new seal, retain each domain owner's no-authority history hold. */
export async function inspectOfflineImportHistory(storage: StorageClient, stateDir: string, scope: string): Promise<void> {
  for (const domain of ['core',scope]) {
    const gate=await storage.gate(domain);
    if (!gate.open) throw new Error(`Offline ${scope} history gate held: ${gate.reasons.join('; ')}`);
  }
  const authority=(await storage.inspect()).authority.find(a=>a.domain===scope);
  if (authority) throw new Error('Offline prior authority requires owner recovery; no import.');
  if (scope==='retention') await holdRetentionEvidence(stateDir);
  else if (scope==='runs') await holdRunsEvidence(stateDir);
  else if (scope==='triggers') await holdTriggersEvidence(stateDir);
  else if (scope==='permissions') {
    const head=await new PermissionsRepository(storage,stateDir).head(); // durable pending / revision / recovery owner
    if (head.authority || head.revision!==null) throw new Error('Permission SQL history without authority requires owner recovery.');
    await holdPermissionsEvidence(stateDir);
  } else throw new Error('Unknown offline import scope.');
  if (scope!=='permissions') {
    const history=await storage.read<{ stages: number }>(scope,'bootstrapHistory',{});
    if (history.stages!==0) throw new Error('Offline staged history requires owner recovery; no import.');
  }
}

/** Explicit local command. A conflict refuses immediately; no PID cleanup, service stop, provider, or network calls. */
export async function runOfflineStorageCommand(args: string[]): Promise<unknown> {
  const [action, ...options]=args;
  if (!['backup','store','restore','activate','reconcile','check'].includes(action ?? '')) throw new Error('Usage: storage offline backup|store|restore|activate|reconcile|check --state-dir <path> --input <private-file-or-new-backup-root>');
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
    let recovery:{barrierId:string;context:typeof context}|undefined;
    let payload:unknown=JSON.parse((await readOfflinePrivateBytes(input)).toString('utf8'));
    if(action==='check') {
      const record=decodeOfflineActivation(payload);
      if(record.stateDir!==stateDir || record.phase!=='complete' || JSON.stringify(record.build)!==JSON.stringify(context.identity) || JSON.stringify(await readOfflineActivation(stateDir))!==JSON.stringify(record)) throw new Error('Exact completed candidate required.');
      await verifyProtectedOfflineArtifact(record);
      await verifyOfflineBackup(record.backup,stateDir,record.storageId);
      storage=await openStorage({stateDir,bundle,limits:{maxPayloadBytes:16*1024*1024}});
      await storage.prepare({allowMigration:false});
      await verifyOfflineCompletion(record,storage);
      return {activationId:record.activationId,state:'complete',identity:storage.identity,effectsStarted:false};
    }
    if(action==='reconcile') {
      const request=payload as {format?:unknown;activation?:unknown;barrierId?:unknown;scopes?:unknown;by?:unknown;evidence?:unknown};
      const record=decodeOfflineActivation(request.activation);
      if(request.format!=='tower-offline-reconcile' || record.phase!=='pending' || record.stateDir!==stateDir
        || typeof request.barrierId!=='string' || !Array.isArray(request.scopes) || !request.scopes.every(scope=>typeof scope==='string')
        || typeof request.by!=='string' || typeof request.evidence!=='string'
        || JSON.stringify(record.build)!==JSON.stringify(context.identity) || JSON.stringify(record.manifest)!==JSON.stringify(context.manifest)) throw new Error('Exact explicit current SDK reconciliation required.');
      const oldContract=await verifyProtectedOfflineArtifact(record);
      await verifyOfflineBackup(record.backup,stateDir,record.storageId);
      const snapshot=await readSnapshot(record.backup.root,record.backup.snapshotId);
      const compatible=databaseSupported(oldContract,{schema:{kind:'current',storageId:snapshot.storageId,applied:snapshot.schema},authority:snapshot.authority});
      if(!compatible.ok) throw new Error(compatible.reason);
      if(!await readOfflineActivation(stateDir)) await verifyOfflineRestoredInventory(record.backup,stateDir,record.storageId);
      const barrier=await readRecoveryBarrier(stateDir);
      if(barrier.state!=='present' || barrier.barrier.id!==request.barrierId || barrier.barrier.snapshot.id!==record.backup.snapshotId
        || barrier.barrier.snapshot.storageId!==record.storageId) throw new Error('Recovery backup/barrier binding mismatch.');
      await verifyOfflineRecoverySnapshot(record,barrier.barrier);
      await reconcileRecovery(stateDir,{barrierId:request.barrierId,scopes:request.scopes as string[],by:request.by,evidence:request.evidence,context});
      // Reconciliation records judgment only. Never replay effects or infer unnamed releases.
      const reconciled=await readRecoveryBarrier(stateDir);
      for(const scope of record.targets) if(recoveryHold(reconciled,scope,context).held) return {barrierId:request.barrierId,state:'held',effectsStarted:false};
      recovery={barrierId:request.barrierId,context};
      payload=record; // Same fixed installation intents; store-only reimport uses the existing owners.
    }
    if(action==='activate') {
      const request=payload as {format?:unknown;activation?:Omit<import('./storage-offline.js').OfflineActivationRecord,'backup'>;backupRoot?:unknown};
      if(request.format!=='tower-offline-owner' || !request.activation || request.activation.phase!=='pending' || request.activation.stateDir!==stateDir || typeof request.backupRoot!=='string' || resolve(request.backupRoot)!==request.backupRoot) throw new Error('Exact offline scheduled owner input required.');
      if(!context.ok || JSON.stringify(context.identity)!==JSON.stringify(request.activation.build) || JSON.stringify(context.manifest)!==JSON.stringify(request.activation.manifest)) throw new Error('Offline successor artifact mismatch.');
      storage=await openStorage({stateDir,bundle,limits:{maxPayloadBytes:16*1024*1024}});
      const snapshot=await storage.snapshot();
      const closed=await storage.close();storage=undefined;
      if(!['closed','already-closed','thread-exited'].includes(closed.ack)) throw new Error('Offline backup SDK did not close.');
      const backup=await collectOfflineBackup({stateDir,root:request.backupRoot,snapshotId:snapshot.id,lease});
      payload={...request.activation,backup};
    }
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
    const owner=await beginOfflineActivation({lease,runtimeDir:join(stateDir,'runner-runtime'),record,update,...(recovery?{recovery}:{})});
    storage=await openStorage({stateDir,bundle,limits:{maxPayloadBytes:16*1024*1024}});
    await prepareOfflineActivation(owner,storage,update);
    // All stores share this SDK; completion is verified before any runtime effects.
    for(const scope of ['retention','runs','triggers','permissions','remote','auto-prompt','automation-workflows']) {
      const authority=(await storage.inspect()).authority.find(a=>a.domain===scope);
      const commandId=`offline-${record.activationId}-${scope}`;
      if(authority && authority.authority!=='database') throw new Error('Offline non-database authority requires owner recovery.');
      if(!authority) {
        if(['retention','runs','triggers','permissions'].includes(scope)) await inspectOfflineImportHistory(storage,stateDir,scope);
        if(scope==='retention') await importRetention({storage,stateDir,evidenceParent:join(stateDir,'storage-migrations'),commandId,update,activation:owner});
        if(scope==='runs') await importRuns({storage,stateDir,evidenceParent:join(stateDir,'runs-storage-migrations'),commandId,update,activation:owner,repository:new RunsRepository(storage)});
        if(scope==='triggers') await importTriggers({stateDir,evidenceParent:join(stateDir,'triggers-storage-migrations'),commandId,update,activation:owner,repository:new TriggersRepository(storage),now:Date.now});
        if(scope==='permissions') await importPermissions({stateDir,commandId,update,activation:owner,repository:new PermissionsRepository(storage,stateDir)});
        if(['remote','auto-prompt','automation-workflows'].includes(scope)) {
          const repository=scope==='remote' ? new RemoteRepository(storage) : scope==='auto-prompt' ? new AutoPromptRepository(storage) : new WorkflowRepository(storage);
          const importer=scope==='remote' ? importRemote : scope==='auto-prompt' ? importAutoPrompts : importWorkflows;
          const sdk=storage;
          await importer({repository,stateDir,commandId,evidenceParent:join(stateDir,`${scope}-storage-migrations`),checkActivation:async()=>{await checkStorageActivation({kind:'offline',owner,storage:sdk,update},scope);}});
        }
      }
      await recordOfflineDomainCompletion(owner,storage,scope);
    }
    await finishOfflineActivation(owner,storage);
    return { activationId:record.activationId,state:'complete',completedStoreScopes:record.manifest.domains.map(d=>d.scope),effectsStarted:false };
  } finally {
    if(storage) { const result=await storage.close(); if(!['closed','already-closed','thread-exited'].includes(result.ack)) throw new Error('Offline SDK did not close; lease retained.'); }
    await lease.release();
  }
}
