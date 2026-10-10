import test from 'node:test';
import assert from 'node:assert/strict';
import { realpath, mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireStrictStateLock, validateStrictStateLease } from '../../../server/instance/state-lock.js';
import { checkStorageActivation, decodeOfflineActivation, offlineBootstrapHeld, validateOwnerContext } from '../../../server/link/storage-offline.js';
import { evaluateStorageUpdate, type StorageUpdateInput } from '../../../server/link/storage-update.js';

// Isolated filesystem only. No native provider, process termination or operating Tower.
test('strict conflict leaves even an empty/stale owner untouched and never probes its PID', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'offline-lease-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lease = await acquireStrictStateLock(dir);
  await validateStrictStateLease(lease, dir);
  const lock = join(dir, '.instance-lock');
  const names = await readdir(lock);
  const bytes = await readFile(join(lock, names[0]));
  t.mock.method(process, 'kill', () => { throw new Error('PID probe forbidden'); });
  await assert.rejects(acquireStrictStateLock(dir), /conflict/);
  assert.deepEqual(await readdir(lock), names);
  assert.deepEqual(await readFile(join(lock, names[0])), bytes);
  await lease.release();
  await assert.rejects(validateStrictStateLease(lease, dir));
  await mkdir(lock);
  await assert.rejects(acquireStrictStateLock(dir), /conflict/);
  assert.deepEqual(await readdir(lock), []);
});
test('serialized owner and caller completion booleans confer no authority', async () => {
  await assert.rejects(validateOwnerContext({ kind: 'offline-owner' }), /forged owner/);
  assert.throws(() => decodeOfflineActivation({ complete: true, owner: true }), /invalid record/);
});
test('normal activation delegates the same refusal unchanged', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'offline-normal-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const update: StorageUpdateInput = { stateDir: dir, managed: false, now: 1000,
    build: { version: '1.125.1', preflight: { supported: false } } };
  assert.deepEqual(await checkStorageActivation({ kind: 'normal', update }), await evaluateStorageUpdate(update));
  assert.equal(await offlineBootstrapHeld(dir), false);
});
test('invalid durable activation cannot be treated as absent after restart', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'offline-restart-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'storage-offline-activation.json'), '{"phase":"schema-prepared"}', { mode: 0o600 });
  await assert.rejects(offlineBootstrapHeld(dir), /invalid record/);
});

test('actual offline CLI refuses a live lease before reading activation or creating SQL and releases no other owner', async t => {
  const dir=await realpath(await mkdtemp(join(tmpdir(),'offline-cli-conflict-')));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const runtime=join(dir,'runner-runtime');
  const lease=await acquireStrictStateLock(runtime);
  t.after(()=>lease.release());
  const { runOfflineStorageCommand }=await import('../../../server/link/storage-offline-cli.js');
  t.mock.method(process,'kill',()=>{throw new Error('PID signal forbidden');});
  await assert.rejects(runOfflineStorageCommand(['store','--state-dir',dir,'--input',join(dir,'must-not-read')]),/conflict/);
  await validateStrictStateLease(lease,runtime);
  await assert.rejects(readFile(join(dir,'state.sqlite')),{code:'ENOENT'});
});

for(const lock of ['12345 fixture-start','not-a-pid','unsafe-link'] as const) {
  test(`offline helper lock ${lock} holds with observe callback zero`,async t=>{
    const dir=await realpath(await mkdtemp(join(tmpdir(),'offline-helper-')));
    t.after(()=>rm(dir,{recursive:true,force:true}));
    const { updatePaths, readHelperLock }=await import('../../../server/link/storage-update.js');
    const path=updatePaths(dir).lock;
    // updatePaths is the owner of the lock name; no real process observation is made.
    await mkdir((await import('node:path')).dirname(path),{recursive:true,mode:0o700});
    if(lock==='unsafe-link') await (await import('node:fs/promises')).symlink('missing',path);
    else await writeFile(path,lock,{mode:0o600});
    let observes=0,starts=0;
    const helper=await readHelperLock(dir,async()=>{starts++;return 'fixture-start';},()=>{observes++;return {state:'present'};},'offline');
    assert.notEqual(helper.state,'absent');assert.equal(observes,0);assert.equal(starts,0);
    const update:StorageUpdateInput={stateDir:dir,managed:false,build:{version:'1.125.0',preflight:{supported:false}}};
    const result=await evaluateStorageUpdate(update,'offline');assert.equal(result.code,'offline-helper-held');assert.equal(result.importAllowed,false);
  });
}

test('official A124 npm package entry and captured SDK bind the contract; mismatched pairs refuse',async t=>{
  const { createHash }=await import('node:crypto');
  const { dirname }=await import('node:path');
  const { fileURLToPath }=await import('node:url');
  const { retentionBuild }=await import('../storage/fixtures/retention-build.js');
  const { verifyProtectedOfflineArtifact }=await import('../../../server/link/storage-offline.js');
  const root=await realpath(await mkdtemp(join(tmpdir(),'offline-a124-pair-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const old=await retentionBuild('1.124.0',join(root,'sdk'));
  const context=old.storage.storageBuildContext(old.bundle());assert.ok(context.ok);
  const packageRoot=join(root,'package');
  const members:Record<string,string>={
    'bin/agent-session-tower.mjs':'triggers-a124-package/bin-entry.mjs.txt',
    'dist/server/index.js':'triggers-a124-package/server-entry.js.txt',
    'dist/server/storage/build-identity.js':'triggers-a124-package/build-identity.js.txt',
    'dist/server/storage/generated/thread-bundle.json':'triggers-a124/thread-bundle.json',
    'dist/server/storage/schema.js':'triggers-a124/storage-schema.js.txt',
  };
  for(const [member,fixture] of Object.entries(members)) {
    const path=join(packageRoot,member);await mkdir(dirname(path),{recursive:true,mode:0o700});
    await writeFile(path,await readFile(fileURLToPath(new URL(`../storage/fixtures/${fixture}`,import.meta.url))),{mode:0o600});
  }
  const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
  const entry=join(packageRoot,'bin/agent-session-tower.mjs'),contractPath=join(root,'contract.json');
  const contract={format:'tower-artifact-storage-contract',version:1,appVersion:'1.124.0',supported:true,identity:context.identity,manifest:context.manifest};
  await writeFile(contractPath,JSON.stringify(contract),{mode:0o600});
  const record={oldArtifact:{identity:context.identity,entry:{path:entry,sha256:digest(await readFile(entry))},contract:{path:contractPath,sha256:digest(await readFile(contractPath))}}} as Parameters<typeof verifyProtectedOfflineArtifact>[0];
  assert.deepEqual(await verifyProtectedOfflineArtifact(record),contract);
  await writeFile(entry,'// another executable with a caller supplied valid contract',{mode:0o600});
  record.oldArtifact.entry.sha256=digest(await readFile(entry));
  await assert.rejects(verifyProtectedOfflineArtifact(record),/embedded identity\/entry mismatch/);
  await writeFile(entry,await readFile(fileURLToPath(new URL('../storage/fixtures/triggers-a124-package/bin-entry.mjs.txt',import.meta.url))),{mode:0o600});
  record.oldArtifact.entry.sha256=digest(await readFile(entry));
  await writeFile(join(packageRoot,'dist/server/storage/build-identity.js'),`export const BUILD_STORAGE = { contexts: [{sourceHash: '${context.identity.sourceHash}'}] };`,{mode:0o600});
  await assert.rejects(verifyProtectedOfflineArtifact(record),/embedded identity\/entry mismatch/,'same digest letters do not replace checked capture bytes');
});

for(const [scope,parent] of Object.entries({retention:'storage-migrations',runs:'runs-storage-migrations',triggers:'triggers-storage-migrations',permissions:'permissions-storage-migrations'})) {
  test(`offline ${scope} new ID cannot bypass another ID seal with no authority and SQL stage zero`,async t=>{
    const { retentionBuild }=await import('../storage/fixtures/retention-build.js');
    const { inspectOfflineImportHistory }=await import('../../../server/link/storage-offline-cli.js');
    const root=await realpath(await mkdtemp(join(tmpdir(),'offline-prior-seal-')));t.after(()=>rm(root,{recursive:true,force:true}));
    const build=await retentionBuild('1.125.0',join(root,'artifact'),true,true);
    const stateDir=join(root,'state');await mkdir(stateDir,{mode:0o700});
    const db=await build.storage.openStorage({stateDir,bundle:build.bundle()});t.after(()=>db.close());await db.prepare({allowMigration:true});
    assert.equal((await db.inspect()).authority.length,0);
    if(scope!=='permissions') assert.deepEqual(await db.read(scope,'bootstrapHistory',{}),{stages:0});
    await inspectOfflineImportHistory(db,stateDir,scope); // normal first import admission remains possible
    await mkdir(join(stateDir,parent,'different-command-id'),{recursive:true,mode:0o700});
    const identity=db.identity; assert.ok(identity,'prepared SDK identity is required');
  let imports=0,writes=0;const write=db.write.bind(db);
    t.mock.method(db,'write',async(...args:Parameters<typeof db.write>)=>{writes++;return write(...args);});
    const attempt=async()=>{await inspectOfflineImportHistory(db,stateDir,scope);imports++;};
    await assert.rejects(attempt(),/evidence|seal/);assert.equal(imports,0);assert.equal(writes,0);
    assert.equal((await db.inspect()).authority.length,0);
    if(scope!=='permissions') assert.deepEqual(await db.read(scope,'bootstrapHistory',{}),{stages:0});
  });
}

test('offline history admission refuses non-authority, unresolved stages and recovery holds before import',async t=>{
  const { retentionBuild }=await import('../storage/fixtures/retention-build.js');
  const { inspectOfflineImportHistory }=await import('../../../server/link/storage-offline-cli.js');
  const root=await realpath(await mkdtemp(join(tmpdir(),'offline-history-hold-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const build=await retentionBuild('1.125.0',join(root,'artifact'),true,true);
  const stateDir=join(root,'state');await mkdir(stateDir,{mode:0o700});
  const db=await build.storage.openStorage({stateDir,bundle:build.bundle()});t.after(()=>db.close());await db.prepare({allowMigration:true});
  const identity=db.identity; assert.ok(identity,'prepared SDK identity is required');
  let imports=0,writes=0;
  const write=db.write.bind(db);t.mock.method(db,'write',async(...args:Parameters<typeof db.write>)=>{writes++;return write(...args);});
  const attempt=async()=>{await inspectOfflineImportHistory(db,stateDir,'runs');imports++;};
  const inspection=await db.inspect();
  const authorityMock=t.mock.method(db,'inspect',async()=>({...inspection,authority:[{domain:'runs',authority:'legacy-exported' as const,generation:1,manifestSha256:'a'.repeat(64),readerContract:1,writerContract:1,committedAt:'fixture',appVersion:'1.125.0',sourceHash:identity.sourceHash,ownerEpoch:inspection.ownerEpoch}]}));
  await assert.rejects(attempt(),/prior authority/);authorityMock.mock.restore();
  assert.equal(imports,0);assert.equal(writes,0);
  await db.write('runs','begin',{intent:'unresolved-history',bytes:1,chunks:1,sha256:'a'.repeat(64)},'fixture-history-reserve');
  await assert.rejects(attempt(),/staged history/);
  const gateMock=t.mock.method(db,'gate',async()=>({open:false,reasons:['fixture unresolved recovery barrier'],scope:'runs',ownerEpoch:inspection.ownerEpoch}));
  await assert.rejects(attempt(),/history gate held/);gateMock.mock.restore();
  assert.equal(imports,0);assert.equal(writes,1,'only the fixture stage reservation; no import or replay');assert.deepEqual(await db.read('runs','bootstrapHistory',{}),{stages:1});
});

test('normal helper observation preserves injected EPERM/start identity contract',async t=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'normal-helper-observe-')));t.after(()=>rm(dir,{recursive:true,force:true}));
  const { updatePaths,readHelperLock }=await import('../../../server/link/storage-update.js');
  const { dirname }=await import('node:path');
  await mkdir(dirname(updatePaths(dir).lock),{recursive:true,mode:0o700});await writeFile(updatePaths(dir).lock,'12345 same-start',{mode:0o600});
  let observes=0,starts=0;
  const result=await readHelperLock(dir,async()=>{starts++;return 'same-start';},()=>{observes++;return {state:'present',code:'EPERM'};});
  assert.deepEqual(result,{state:'running',pid:12345});assert.equal(observes,1);assert.equal(starts,1);
});
