import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,realpath,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retentionBuild } from '../storage/fixtures/retention-build.js';

test('permission commit response loss keeps the same ID/hash and holds restart/effects after exact receipt resolution', async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'tower-permission-pending-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const build=await retentionBuild('1.125.0',join(root,'artifact'),true,true);
  const stateDir=join(root,'state');await mkdir(stateDir,{mode:0o700});
  const first=await build.storage.openStorage({stateDir,bundle:build.bundle()});await first.prepare({allowMigration:true});
  const repository=new build.storage.PermissionsRepository(first,stateDir);
  const write=first.write.bind(first);let sent=0;
  const mock=t.mock.method(first,'write',async(...args:Parameters<typeof first.write>)=>{
    sent++;await write(...args);
    throw new build.storage.StorageCommandError({phase:'command',code:'thread-exited',message:'fixture response lost after real SQL receipt',disposition:'unknown',retryable:false,commandId:args[3]});
  });
  const commandId='permissions-fixed-import';
  await assert.rejects(repository.importPrepared({version:1,rules:[],requests:[],codex:[]},'a'.repeat(64),commandId,async()=>{}),/response lost/);
  assert.equal(sent,1);mock.mock.restore();
  const before=JSON.parse(await readFile(join(stateDir,'storage-permissions-pending.json'),'utf8'));
  assert.equal(before.commandId,commandId);assert.equal(before.phase,'pending');
  await first.close();
  const second=await build.storage.openStorage({stateDir,bundle:build.bundle()});t.after(()=>second.close());await second.prepare({allowMigration:false});
  const restarted=new build.storage.PermissionsRepository(second,stateDir);
  await assert.rejects(restarted.load(),/unresolved/);
  assert.equal(restarted.pending()!.commandId,commandId);
  assert.equal(restarted.pending()!.payloadSha256,before.payloadSha256);
  assert.equal(await restarted.resolvePending(),'committed');
  await restarted.load();assert.equal(restarted.effectsAvailable(),false,'receipt lookup/reload cannot release effects');
  assert.equal(JSON.parse(await readFile(join(stateDir,'storage-permissions-pending.json'),'utf8')).phase,'resolved');
  await assert.rejects(restarted.gate(),/reconciliation/);
  await second.close();
  const third=await build.storage.openStorage({stateDir,bundle:build.bundle()});t.after(()=>third.close());await third.prepare({allowMigration:false});
  const again=new build.storage.PermissionsRepository(third,stateDir);await again.load();
  assert.equal(again.effectsAvailable(),false,'the reconciliation hold also survives another restart');
  assert.equal(sent,1,'no resend, new command ID or provider effect occurred');
});

test('known SQL permission commit plus clear fsync fault retains exact pending receipt through restart', async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'tower-permission-clear-fault-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const build=await retentionBuild('1.125.0',join(root,'artifact'),true,true);
  const stateDir=join(root,'state');await mkdir(stateDir,{mode:0o700});
  const first=await build.storage.openStorage({stateDir,bundle:build.bundle()});await first.prepare({allowMigration:true});
  const repository=new build.storage.PermissionsRepository(first,stateDir);
  let known=false, sent=0, effects=0;
  const write=first.write.bind(first);
  const writeMock=t.mock.method(first,'write',async(...args:Parameters<typeof first.write>)=>{
    sent++;const answer=await write(...args);known=true;return answer;
  });
  const sync=build.storage.storageFs.syncDirectory;
  const syncMock=t.mock.method(build.storage.storageFs,'syncDirectory',async(path:string)=>{
    if(known && path===stateDir) throw new Error('fixture clear fsync fault after known SQL response');
    await sync(path);
  });
  const id='permissions-known-clear-fault';
  await assert.rejects(repository.importPrepared({version:1,rules:[],requests:[],codex:[]},'b'.repeat(64),id,async()=>{}),/clear fsync fault/);
  assert.equal(known,true);assert.equal(repository.effectsAvailable(),false);
  const marker=JSON.parse(await readFile(join(stateDir,'storage-permissions-pending.json'),'utf8'));
  assert.equal(marker.commandId,id);assert.equal(marker.phase,'pending');
  syncMock.mock.restore();writeMock.mock.restore();await first.close();
  const second=await build.storage.openStorage({stateDir,bundle:build.bundle()});t.after(()=>second.close());await second.prepare({allowMigration:false});
  const restarted=new build.storage.PermissionsRepository(second,stateDir);
  await assert.rejects(restarted.load(),/unresolved/);
  assert.equal(restarted.pending()!.payloadSha256,marker.payloadSha256);
  assert.equal(await restarted.resolvePending(),'committed');
  await restarted.load();if(restarted.effectsAvailable()) effects++;
  assert.equal(effects,0);await assert.rejects(restarted.gate(),/reconciliation/);
  await restarted.releaseReconciledEffects();await restarted.gate();
  assert.equal(sent,1,'no new ID/import/write or replay during receipt reconciliation');
});
