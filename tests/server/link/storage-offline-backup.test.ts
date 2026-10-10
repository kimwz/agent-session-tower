import test from 'node:test';
import assert from 'node:assert/strict';
import { realpath, mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retentionBuild } from '../storage/fixtures/retention-build.js';

// Actual captured A124 SDK bytes and the existing final fixture builder. Hosted supported runtimes only.
test('full offline backup/readback/restore preserves originals and a new historical barrier; old SDK stays held', async t => {
  const root=await realpath(await mkdtemp(join(tmpdir(),'tower-offline-backup-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const old=await retentionBuild('1.124.0',join(root,'old'));
  const final=await retentionBuild('1.125.0',join(root,'final'),true,true);
  const stateDir=join(root,'state'); await mkdir(stateDir,{mode:0o700});
  const client=await old.storage.openStorage({stateDir,bundle:old.bundle()});
  await client.prepare({allowMigration:true});
  const snapshot=await client.snapshot(); await client.close();
  await writeFile(join(stateDir,'permissions.json'),'{"fixture":"before"}',{mode:0o600});
  await writeFile(join(stateDir,'auth.json'),'NEVER COPY',{mode:0o600});
  const lease=await final.storage.acquireStrictStateLock(join(stateDir,'runner-runtime'));
  t.after(()=>lease.release());
  const descriptor=await final.storage.collectOfflineBackup({stateDir,root:join(root,'backup'),snapshotId:snapshot.id,lease});
  const backup=await final.storage.verifyOfflineBackup(descriptor,stateDir,snapshot.storageId,true);
  assert.ok(backup.entries.some(e=>e.name==='runs.json' && e.kind==='absent'));
  assert.ok(backup.entries.some(e=>e.name==='state.sqlite' && e.kind==='file'));
  await assert.rejects(readFile(join(descriptor.root,'auth.json')),{code:'ENOENT'});
  const db=await final.storage.openStorage({stateDir,bundle:final.bundle()});
  await db.prepare({allowMigration:true}); const known=await db.inspect(); await db.close();
  await writeFile(join(stateDir,'permissions.json'),'{"fixture":"after"}',{mode:0o600});
  const context=final.storage.storageBuildContext(final.bundle()); assert.ok(context.ok);
  const result=await final.storage.restoreOfflineBackup({descriptor,stateDir,storageId:snapshot.storageId,lease,context,known:{schema:known.schema.kind==='empty'?[]:known.schema.applied,authority:known.authority,ownerEpoch:known.ownerEpoch}});
  assert.equal(result.state,'held');
  assert.equal(await readFile(join(stateDir,'permissions.json'),'utf8'),'{"fixture":"before"}');
  assert.equal(await readFile(join(stateDir,'auth.json'),'utf8'),'NEVER COPY');
  const barrier=JSON.parse(await readFile(join(stateDir,'storage-recovery','barrier.json'),'utf8'));
  assert.equal(barrier.id,result.barrierId);
  assert.equal(barrier.state,'activated');
  const historical=await old.storage.openStorage({stateDir,bundle:old.bundle()});
  try { await historical.prepare({allowMigration:false}); assert.equal((await historical.gate('core')).open,false,'old SDK cannot reconcile unknown permissions scope'); }
  finally { await historical.close(); }
});

test('inventory refuses private-boundary links and records named absence without reading credentials', async t => {
  const root=await realpath(await mkdtemp(join(tmpdir(),'tower-offline-inventory-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const build=await retentionBuild('1.125.0',join(root,'artifact'));
  const stateDir=join(root,'state'); await mkdir(stateDir,{mode:0o700});
  await writeFile(join(stateDir,'auth.json'),'credential sentinel',{mode:0o600});
  await symlink('auth.json',join(stateDir,'permissions.json'));
  await assert.rejects(build.storage.offlineInventory(stateDir),/symlink/);
});

test('DB/WAL streaming inventory accepts data larger than the JSON document limit and catches missing entries', async t => {
  const root=await realpath(await mkdtemp(join(tmpdir(),'tower-offline-large-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const build=await retentionBuild('1.125.0',join(root,'artifact'));
  const stateDir=join(root,'state'); await mkdir(stateDir,{mode:0o700});
  const { open }=await import('node:fs/promises');
  const file=await open(join(stateDir,'state.sqlite'),'wx',0o600);
  try { await file.truncate(64*1024*1024+1); await file.sync(); } finally { await file.close(); }
  const entries=await build.storage.offlineInventory(stateDir);
  assert.equal(entries.find(e=>e.name==='state.sqlite')!.bytes,64*1024*1024+1);
  assert.equal(entries.find(e=>e.name==='state.sqlite-wal')!.kind,'absent');
  assert.equal(entries.some(e=>e.name==='auth.json'),false);
});

for(const boundary of ['before-copy','after-copy','manifest-sync'] as const) {
  test(`actual SQLite backup interruption at ${boundary} cannot publish a usable inventory`, async t => {
    const root=await realpath(await mkdtemp(join(tmpdir(),'tower-offline-fault-')));
    t.after(()=>rm(root,{recursive:true,force:true}));
    const build=await retentionBuild('1.125.0',join(root,'artifact'));
    const stateDir=join(root,'state');await mkdir(stateDir,{mode:0o700});
    const db=await build.storage.openStorage({stateDir,bundle:build.bundle()});
    await db.prepare({allowMigration:true});const snapshot=await db.snapshot();await db.close();
    const lease=await build.storage.acquireStrictStateLock(join(stateDir,'runner-runtime'));t.after(()=>lease.release());
    const backup=join(root,'backup');
    if(boundary==='manifest-sync') {
      const original=build.storage.storageFs.syncDirectory;
      t.mock.method(build.storage.storageFs,'syncDirectory',async (path: string)=>{ if(path===backup) { const exists=await readFile(join(backup,'manifest.json')).then(()=>true,()=>false);if(exists) throw new Error('fixture manifest fsync interruption'); } await original(path); });
    } else {
      const original=build.storage.storageFs.copyFile;let first=true;
      t.mock.method(build.storage.storageFs,'copyFile',async(from: string,to: string)=>{ if(!first) return original(from,to);first=false;if(boundary==='after-copy') await original(from,to);throw new Error('fixture copy interruption'); });
    }
    await assert.rejects(build.storage.collectOfflineBackup({stateDir,root:backup,snapshotId:snapshot.id,lease}),/fixture/);
    assert.equal(await build.storage.offlineBootstrapHeld(stateDir),false,'a failed backup never fabricated a completed activation');
    assert.equal(await readFile(join(stateDir,'storage-offline-activation.json')).then(()=>true,()=>false),false);
    await assert.rejects(build.storage.collectOfflineBackup({stateDir,root:backup,snapshotId:snapshot.id,lease}),/already exists/,'partial directories are preserved, never trusted as a complete backup');
  });
}
