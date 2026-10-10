import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, cp, readdir, chmod, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { retentionBuild, protectedOld124, currentProductProfile } from '../storage/fixtures/retention-build.js';
import { RemoteRepository } from '../../../server/remote/storage-repository.js';
import { empty } from '../../../server/triggers/state.js';
import { parseSuccessor } from '../../../server/runs/handoff.js';
import { artifactStorageContract } from '../../../server/link/storage-update.js';
import type { OfflineActivationRecord } from '../../../server/link/storage-offline.js';

const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t:TestContext,fault='normal',product?:Parameters<typeof retentionBuild>[5]) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'offline-activation-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const stateDir=join(root,'state');await mkdir(stateDir,{mode:0o700});
  const full=process.env.TOWER_SQLITE_OLD124_ROOT ? await protectedOld124() : undefined;
  const old=full ?? await retentionBuild('1.124.0',join(root,'old-sdk'));
  const final=await retentionBuild('1.125.0',join(root,'final-sdk'),true,true,true,product);
  const oldDb=await old.storage.openStorage({stateDir,bundle:old.bundle()});
  await oldDb.prepare({allowMigration:true});
  const schema=(await oldDb.inspect()).schema;assert.notEqual(schema.kind,'empty');
  if(schema.kind==='empty') throw new Error('Prepared old fixture storage missing.');
  await oldDb.close();
  await mkdir(join(stateDir,'retention'),{mode:0o700});
  for(const [name,value] of Object.entries({
    'runs.json':[],'created-sessions.json':[],'run-instructions.json':{},
    'trigger-engine.json':empty(), 'permissions.json':{version:1,rules:[],requests:[],codex:[]},
    'retention/journal.json':{version:1,migratedAt:1,entries:[],policies:[]},
    'retention-observations.json':{version:1,entries:[]},
  })) await writeFile(join(stateDir,name),JSON.stringify(value),{mode:0o600});
  await writeFile(join(stateDir,'auth.json'),'excluded-auth',{mode:0o600});
  const packageRoot=full?.packageRoot ?? join(root,'protected');
  if(!full) for(const [member,capture] of Object.entries({
    'bin/agent-session-tower.mjs':'triggers-a124-package/bin-entry.mjs.txt',
    'dist/server/index.js':'triggers-a124-package/server-entry.js.txt',
    'dist/server/storage/build-identity.js':'triggers-a124-package/build-identity.js.txt',
    'dist/server/storage/generated/thread-bundle.json':'triggers-a124/thread-bundle.json',
    'dist/server/storage/schema.js':'triggers-a124/storage-schema.js.txt',
  })) {
    const path=join(packageRoot,member);await mkdir(dirname(path),{recursive:true,mode:0o700});
    await writeFile(path,await readFile(fileURLToPath(new URL(`../storage/fixtures/${capture}`,import.meta.url))),{mode:0o600});
  }
  const oldContext=old.storage.storageBuildContext(old.bundle());assert.ok(oldContext.ok);
  const oldContract=join(root,'old-contract.json');
  await writeFile(oldContract,full ? await readFile(join(full.directory,'storage-contract.json')) : JSON.stringify(artifactStorageContract(oldContext,await old.storage.preflightStorage({stateDir,bundle:old.bundle()}))),{mode:0o600});
  const context=final.storage.storageBuildContext(final.bundle(fault));assert.ok(context.ok);
  const entry=join(packageRoot,'bin/agent-session-tower.mjs');
  const activation:Omit<OfflineActivationRecord,'backup'>={format:'tower-offline-activation',version:1,
    activationId:'all-domains',stateDir,storageId:schema.storageId,build:context.identity,manifest:context.manifest,
    oldArtifact:{identity:oldContext.identity,entry:{path:entry,sha256:digest(await readFile(entry))},contract:{path:oldContract,sha256:digest(await readFile(oldContract))}},
    targets:['core',...context.manifest.domains.map(d=>d.scope)],domains:[],phase:'pending'};
  const input=join(root,'owner.json'),backupRoot=join(root,'consistent-backup');
  await writeFile(input,JSON.stringify({format:'tower-offline-owner',activation,backupRoot}),{mode:0o600});
  return {root,stateDir,old,final,input,backupRoot,activation};
}

test('actual offline CLI imports every registered domain, finalizes exact receipts and preserves excluded auth',async t=>{
  const f=await fixture(t);
  const result=await f.final.storage.runOfflineStorageCommand(['activate','--state-dir',f.stateDir,'--input',f.input]);
  assert.deepEqual(result,{activationId:'all-domains',state:'complete',completedStoreScopes:f.activation.manifest.domains.map(d=>d.scope),effectsStarted:false});
  const db=await f.final.storage.openStorage({stateDir:f.stateDir,bundle:f.final.bundle()});
  try {
    await db.prepare({allowMigration:false});
    assert.equal(await f.final.storage.offlineBootstrapHeld(f.stateDir,db.identity,f.activation.storageId,db),false);
    const record=await f.final.storage.readOfflineActivation(f.stateDir);assert.ok(record);
    assert.equal(record.domains.length,7);await f.final.storage.verifyOfflineCompletion(record,db);
    assert.equal((await db.inspect()).authority.length,7);
  } finally {await db.close();}
  assert.equal(await readFile(join(f.stateDir,'auth.json'),'utf8'),'excluded-auth');
  await assert.rejects(readFile(join(f.backupRoot,'auth.json')),{code:'ENOENT'});
  await assert.rejects(f.final.storage.runOfflineStorageCommand(['activate','--state-dir',f.stateDir,'--input',f.input]),/already exists|already complete|mismatch/);
});

for(const boundary of ['raw-seal','sql-commit','global-complete'] as const) {
  test(`actual activation interruption at ${boundary} leaves replay and effects closed`,async t=>{
    const f=await fixture(t);
    if(boundary==='raw-seal') {
      const copy=f.final.storage.storageFs.copyFile;
      t.mock.method(f.final.storage.storageFs,'copyFile',async(from:string,to:string)=>{
        await copy(from,to);
        if(to.includes('permissions-storage-migrations/')&&to.endsWith('/permissions.json')) throw new Error('fixture raw-seal crash');
      });
    } else {
      const rename=f.final.storage.storageFs.rename;
      t.mock.method(f.final.storage.storageFs,'rename',async(from:string,to:string)=>{
        if(to===join(f.stateDir,'storage-offline-activation.json')) {
          const next=JSON.parse(await readFile(from,'utf8')) as OfflineActivationRecord;
          if(boundary==='sql-commit' ? next.domains.length===1 : next.phase==='complete') throw new Error(`fixture ${boundary} crash`);
        }
        await rename(from,to);
      });
    }
    await assert.rejects(f.final.storage.runOfflineStorageCommand(['activate','--state-dir',f.stateDir,'--input',f.input]),/fixture/);
    const record=await f.final.storage.readOfflineActivation(f.stateDir);assert.ok(record);assert.notEqual(record.phase,'complete');
    const db=await f.final.storage.openStorage({stateDir:f.stateDir,bundle:f.final.bundle()});
    try {await db.prepare({allowMigration:false});assert.equal(await f.final.storage.offlineBootstrapHeld(f.stateDir,db.identity,record.storageId,db),true);}
    finally {await db.close();}
    // A new ID never turns a partial raw/SQL/global boundary into permission to replay.
    await assert.rejects(f.final.storage.runOfflineStorageCommand(['activate','--state-dir',f.stateDir,'--input',f.input]),/already exists|mismatch|retry/);
  });
}

test('offline successor fits unchanged patient handoff command contract',()=>{
  const stateDir='/fixture/state';
  const command={execPath:'/fixture/node',args:['/fixture/final-entry.mjs','--offline-owner','/fixture/owner.json','--runner-worker',stateDir]};
  assert.deepEqual(parseSuccessor(command,stateDir),command);
  assert.throws(()=>parseSuccessor({...command,args:[...command.args,'--force']},stateDir),/Invalid/);
});

test('completed offline installation permits a compatible actual SDK successor and holds unknown scopes',async t=>{
  const f=await fixture(t);
  await f.final.storage.runOfflineStorageCommand(['activate','--state-dir',f.stateDir,'--input',f.input]);
  const next=await retentionBuild('1.125.1',join(f.root,'next-sdk'),true,true,true);
  const db=await next.storage.openStorage({stateDir:f.stateDir,bundle:next.bundle()});
  try {
    await db.prepare({allowMigration:false});
    const update={stateDir:f.stateDir,managed:false,build:{version:'1.125.1',manifest:next.manifest,preflight:await next.storage.preflightStorage({stateDir:f.stateDir,bundle:next.bundle()})}};
    assert.ok(await next.storage.completedOfflineCandidate(update));
    assert.equal(await next.storage.offlineBootstrapHeld(f.stateDir,db.identity,f.activation.storageId,db),false);
    assert.equal((await next.storage.evaluateCompletedOffline(update,db)).code,'offline-completion-verified');
  } finally {await db.close();}
  const missing=await retentionBuild('1.125.1',join(f.root,'missing-scope-sdk'),true,true,false);
  const held=await missing.storage.preflightStorage({stateDir:f.stateDir,bundle:missing.bundle()});
  await assert.rejects(missing.storage.completedOfflineCandidate({stateDir:f.stateDir,managed:false,build:{version:'1.125.1',manifest:missing.manifest,preflight:held}}));
});

for(const partial of [false,true]) test(`full restore explicit current SDK recovery ${partial?'keeps unnamed scopes held':'returns healthy completion'} without effects`,async t=>{
  const f=await fixture(t);
  await f.final.storage.runOfflineStorageCommand(['activate','--state-dir',f.stateDir,'--input',f.input]);
  const completed=await f.final.storage.readOfflineActivation(f.stateDir);assert.ok(completed);
  const restoreInput=join(f.root,'restore.json');await writeFile(restoreInput,JSON.stringify(completed),{mode:0o600});
  const restored=await f.final.storage.runOfflineStorageCommand(['restore','--state-dir',f.stateDir,'--input',restoreInput]) as {barrierId:string;state:string};
  assert.equal(restored.state,'held');
  const historical=await f.old.storage.openStorage({stateDir:f.stateDir,bundle:f.old.bundle()});
  try {await historical.prepare({allowMigration:false});assert.equal((await historical.gate('core')).open,false);}
  finally {await historical.close();}
  const request={format:'tower-offline-reconcile',activation:{...f.activation,backup:completed.backup},barrierId:restored.barrierId,
    scopes:partial?['core']:f.activation.targets,by:'fixture-owner',evidence:'Isolated fixture; no effects admitted after backup. All future rows inspected before restore.'};
  const reconcileInput=join(f.root,'reconcile.json');await writeFile(reconcileInput,JSON.stringify(request),{mode:0o600});
  const result=await f.final.storage.runOfflineStorageCommand(['reconcile','--state-dir',f.stateDir,'--input',reconcileInput]);
  if(partial) {
    assert.deepEqual(result,{barrierId:restored.barrierId,state:'held',effectsStarted:false});
    assert.equal(await f.final.storage.readOfflineActivation(f.stateDir),undefined);
    request.scopes=f.activation.targets;
    await writeFile(reconcileInput,JSON.stringify(request),{mode:0o600});
    await f.final.storage.runOfflineStorageCommand(['reconcile','--state-dir',f.stateDir,'--input',reconcileInput]);
  }
  const db=await f.final.storage.openStorage({stateDir:f.stateDir,bundle:f.final.bundle()});
  try {
    await db.prepare({allowMigration:false});
    const record=await f.final.storage.readOfflineActivation(f.stateDir);assert.ok(record);
    await f.final.storage.verifyOfflineCompletion(record,db);
    assert.equal(await f.final.storage.offlineBootstrapHeld(f.stateDir,db.identity,record.storageId,db),false);
    for(const scope of f.activation.targets) assert.equal((await db.gate(scope)).open,true);
    const ready=await f.final.storage.evaluateCompletedOffline({stateDir:f.stateDir,managed:false,build:{version:'1.125.0',manifest:f.final.manifest,preflight:await f.final.storage.preflightStorage({stateDir:f.stateDir,bundle:f.final.bundle()})}},db);
    assert.equal(ready.verdict,'ready');assert.equal(ready.code,'offline-completion-verified');
  } finally {await db.close();}
  const barrier=await f.final.storage.readRecoveryBarrier(f.stateDir);assert.equal(barrier.state,'present');
  if(barrier.state==='present') {assert.equal(barrier.barrier.id,restored.barrierId);assert.ok(barrier.barrier.reconciled.every(row=>row.by==='fixture-owner'));}
  assert.equal(await readFile(join(f.stateDir,'auth.json'),'utf8'),'excluded-auth');
  for(const name of ['remote-requests.json','auto-prompts.json','slack-automation.json','github-automation.json']) await assert.rejects(readFile(join(f.stateDir,name)),{code:'ENOENT'});
  // Future activity is never the evidence for an automatic release: restore itself always holds.
  await assert.rejects(f.final.storage.runOfflineStorageCommand(['reconcile','--state-dir',f.stateDir,'--input',restoreInput]),/invalid record|reconciliation/);
});

async function selectedPackage(f:Awaited<ReturnType<typeof fixture>>) {
  const selectedRoot=join(f.final.storage.versionDirectory(f.stateDir,'1.125.0'),'node_modules','agent-session-tower');await mkdir(selectedRoot,{recursive:true,mode:0o700});
  for(const member of ['package.json','bin','dist/server','dist/shared','dist/client']) await cp(join(process.cwd(),member),join(selectedRoot,member),{recursive:true});
  const files:Record<string,string>={};
  async function visit(directory:string,prefix='') {
    await chmod(directory,0o700);
    for(const entry of await readdir(directory,{withFileTypes:true})) {
      const path=join(directory,entry.name), member=prefix+entry.name;
      if(entry.isDirectory()) await visit(path,`${member}/`);
      else {assert.ok(entry.isFile());await chmod(path,0o600);files[member]=digest(await readFile(path));}
    }
  }
  await visit(selectedRoot);await symlink(join(process.cwd(),'node_modules'),join(f.root,'node_modules'),'dir');
  return {selectedRoot,files};
}

test('full actual selected service package validates actual SDK and SQL completion before pointer use',async t=>{
  const f=await fixture(t,'normal',{...await currentProductProfile(),serviceFixture:{installed:true}});
  await f.final.storage.runOfflineStorageCommand(['activate','--state-dir',f.stateDir,'--input',f.input]);
  const record=await f.final.storage.readOfflineActivation(f.stateDir);assert.ok(record);
  const completionInput=join(f.root,'completion.json');await writeFile(completionInput,JSON.stringify(record),{mode:0o600});
  const {selectedRoot,files}=await selectedPackage(f);
  const request={format:'tower-offline-service-maintenance' as const,service:true as const,previousVersion:'1.124.0',stateDir:f.stateDir,version:'1.125.0',by:'owner',evidence:'Explicit stopped-service fixture',publishedPackageSHA256:'a'.repeat(64),files,completionInput:{path:completionInput,sha256:digest(await readFile(completionInput))}};
  await f.final.storage.verifyOfflineServiceSelection(selectedRoot,request,f.stateDir,'1.125.0');
  const entry=join(selectedRoot,'bin/agent-session-tower.mjs');
  const contract=JSON.parse((await promisify(execFile)(process.execPath,[entry,'--storage-contract'],{timeout:60_000,maxBuffer:16*1024*1024})).stdout);
  assert.equal(contract.supported,true);assert.deepEqual(contract.identity,record.build);
  const checked=JSON.parse((await promisify(execFile)(process.execPath,[entry,'storage','offline','check','--state-dir',f.stateDir,'--input',completionInput],{timeout:60_000,maxBuffer:16*1024*1024})).stdout);
  assert.deepEqual(checked,{activationId:record.activationId,state:'complete',identity:record.build,effectsStarted:false});
  await symlink(join('versions','1.124.0'),join(f.stateDir,'runtime','current'));
  const approval=join(f.root,'service-maintenance.json');await writeFile(approval,JSON.stringify(request),{mode:0o600});
  const command=['service','install','--state-dir',f.stateDir,'--offline-maintenance',approval];
  const indexPath=join(selectedRoot,'dist/server/index.js'), originalIndex=await readFile(indexPath);
  await writeFile(indexPath,'wrong existing installed bytes',{mode:0o600});
  await assert.rejects(f.final.storage.runLinkCommand(command),/bytes changed/);
  assert.equal(await f.final.storage.currentVersion(f.stateDir),'1.124.0');
  await assert.rejects(readFile(join(f.stateDir,'offline-service-fixture-start.json')),{code:'ENOENT'});
  await writeFile(indexPath,originalIndex,{mode:0o600});
  await writeFile(approval,'null',{mode:0o600});
  await assert.rejects(f.final.storage.runLinkCommand(command),/owner maintenance/);
  assert.equal(await f.final.storage.currentVersion(f.stateDir),'1.124.0');
  await writeFile(approval,JSON.stringify(request),{mode:0o600});
  await f.final.storage.runLinkCommand(command);
  assert.equal(await f.final.storage.currentVersion(f.stateDir),'1.125.0');
  const started=JSON.parse(await readFile(join(f.stateDir,'offline-service-fixture-start.json'),'utf8'));
  assert.equal(started.version,'1.125.0');assert.equal(started.input.start,true);
  const readySdk=await f.final.storage.openStorage({stateDir:f.stateDir,bundle:f.final.bundle()});
  try {
    await readySdk.prepare({allowMigration:false});
    const ready=await f.final.storage.evaluateCompletedOffline({stateDir:f.stateDir,managed:true,build:{version:'1.125.0',manifest:f.final.manifest,preflight:await f.final.storage.preflightStorage({stateDir:f.stateDir,bundle:f.final.bundle()})}},readySdk);
    assert.equal(ready.verdict,'ready');assert.equal(ready.code,'offline-completion-verified');
  } finally {await readySdk.close();}
  await writeFile(approval,JSON.stringify({...request,service:false}),{mode:0o600});
  await assert.rejects(f.final.storage.runLinkCommand(command),/owner maintenance/);
  await assert.rejects(f.final.storage.runLinkCommand([...command,'--no-service']),/Offline maintenance/);
  // The pre-existing selected directory can contain different bytes despite the same version string.
  await writeFile(join(selectedRoot,'dist/server/index.js'),'wrong already-installed version',{mode:0o600});
  await assert.rejects(f.final.storage.verifyOfflineServiceSelection(selectedRoot,request,f.stateDir,'1.125.0'),/bytes changed/);
  await assert.rejects(f.final.storage.verifyOfflineServiceSelection(selectedRoot,{...request,by:''},f.stateDir,'1.125.0'),/approval/);
  const source=await readFile('server/link/cli.ts','utf8');
  const service=source.slice(source.indexOf('async function runService'));
  assert.ok(service.indexOf('verifyOfflineServiceSelection')<service.indexOf('await useVersion'));
  assert.ok(service.indexOf("'offline','check'")<service.indexOf('await useVersion'));
  assert.match(service,/running \|\| !\(await serviceStatus\(stateDir\)\).installed/);
});

for(const damage of ['receipt-mismatch','reader-future','schema-future'] as const) test(`actual all-domain SQLite ${damage} keeps restart held`,async t=>{
  const f=await fixture(t);
  await f.final.storage.runOfflineStorageCommand(['activate','--state-dir',f.stateDir,'--input',f.input]);
  const record=await f.final.storage.readOfflineActivation(f.stateDir);assert.ok(record);
  const sql=new DatabaseSync(join(f.stateDir,'state.sqlite'));
  try {
    if(damage==='receipt-mismatch') sql.prepare('UPDATE operation_receipts SET payload_sha256=? WHERE command_id=?').run('f'.repeat(64),record.domains[0].commandId);
    else if(damage==='reader-future') sql.exec('UPDATE domain_imports SET reader_contract=999');
    else sql.exec("UPDATE schema_migrations SET version=999 WHERE scope='core' AND version=1");
  } finally {sql.close();}
  const db=await f.final.storage.openStorage({stateDir:f.stateDir,bundle:f.final.bundle()});
  try {
    await db.prepare({allowMigration:false}).catch(error=>assert.ok(error)); // Refusal is expected for future schema/reader; never substitutes a gate.
    assert.equal(await f.final.storage.offlineBootstrapHeld(f.stateDir,db.identity,record.storageId,db),true);
    await assert.rejects(f.final.storage.verifyOfflineCompletion(record,db));
  } finally {await db.close();}
});

test('full official old124 SDK reader/writer/export/restore keeps the actual old classes and captured identity',async t=>{
  const old=await protectedOld124();
  const root=await realpath(await mkdtemp(join(tmpdir(),'offline-full-old-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const stateDir=join(root,'state');await mkdir(stateDir,{mode:0o700});await mkdir(join(stateDir,'retention'),{mode:0o700});
  await writeFile(join(stateDir,'retention/journal.json'),JSON.stringify({version:1,migratedAt:1,entries:[{id:'operation',phase:'blocked-provider',candidate:{ids:['codex:fixture']},error:'before'}],policies:[]}),{mode:0o600});
  await writeFile(join(stateDir,'retention-observations.json'),JSON.stringify({version:1,entries:[]}),{mode:0o600});
  const a=await retentionBuild('1.120.2',join(root,'a')), b=await retentionBuild('1.121.0',join(root,'b'));
  let db=await a.storage.openStorage({stateDir,bundle:a.bundle()});
  const {recordPreparationEvidence}=await import('../../../server/link/storage-update.js');
  const prepared=await db.prepare({allowMigration:true});
  await recordPreparationEvidence(stateDir,{context:db.context!,prepared,preflight:await a.storage.preflightStorage({stateDir,bundle:a.bundle()}),gate:await db.gate('core')});await db.close();
  db=await b.storage.openStorage({stateDir,bundle:b.bundle()});await db.prepare({allowMigration:false});
  const evidenceParent=join(stateDir,'storage-migrations');await mkdir(evidenceParent,{mode:0o700});
  const {importRetention}=await import('../../../server/sessions/retention/storage-transfer.js');
  await importRetention({storage:db,stateDir,evidenceParent,commandId:'fixture-import',update:{stateDir,managed:false,build:{version:b.version,manifest:b.manifest,preflight:await b.storage.preflightStorage({stateDir,bundle:b.bundle()})}}});await db.close();
  db=await old.storage.openStorage({stateDir,bundle:old.bundle()});
  try {
    await db.prepare({allowMigration:true});assert.deepEqual(db.identity,old.contract.identity);
    const store=new old.RetentionStore(join(stateDir,'retention'),{storage:db});await store.start();
    assert.equal(store.get('operation')!.error,'before');
    const transfer=await import(pathToFileURL(join(old.packageRoot,'dist/server/sessions/retention/storage-transfer.js')).href) as typeof import('../../../server/sessions/retention/storage-transfer.js');
    const exported=await transfer.exportRetention(db,evidenceParent,'full-old-export');
    await store.put({...store.get('operation')!,error:'actual old writer'});
    await transfer.restoreRetention(db,exported.directory,'full-old-restore');
    const reopened=new old.RetentionStore(join(stateDir,'retention'),{storage:db});await reopened.start();assert.equal(reopened.get('operation')!.error,'before');
    assert.equal((await db.gate('core')).open,true);
  } finally {await db.close();}
});

test('final actual CLI source and optional Node26 SEA perform offline activation/check/fullrestore/reconcile with identical SDK bytes',async t=>{
  const profile=await currentProductProfile(), f=await fixture(t,'normal',profile);
  const binary=process.env.TOWER_SQLITE_FINAL_BINARY;
  const entry=binary ?? join(process.cwd(),'bin/agent-session-tower.mjs');
  const execute=async(args:string[])=>JSON.parse((await promisify(execFile)(binary?entry:process.execPath,binary?args:[entry,...args],{timeout:120_000,maxBuffer:16*1024*1024})).stdout);
  const contract=await execute(['--storage-contract']);
  assert.equal(contract.supported,true);assert.deepEqual(contract.identity,f.activation.build);assert.deepEqual(contract.manifest,profile.manifest);
  const offline=async(action:string,input:string)=>execute(['storage','offline',action,'--state-dir',f.stateDir,'--input',input]);
  assert.equal((await offline('activate',f.input)).state,'complete');
  const completed=await f.final.storage.readOfflineActivation(f.stateDir);assert.ok(completed);
  const completedInput=join(f.root,'completed.json');await writeFile(completedInput,JSON.stringify(completed),{mode:0o600});
  assert.equal((await offline('check',completedInput)).state,'complete');
  const restored=await offline('restore',completedInput);assert.equal(restored.state,'held');
  const reconciledInput=join(f.root,'explicit-recovery.json');
  await writeFile(reconciledInput,JSON.stringify({format:'tower-offline-reconcile',activation:{...f.activation,backup:completed.backup},barrierId:restored.barrierId,scopes:f.activation.targets,by:'isolated-owner',evidence:'Actual CLI fixture admits zero effects after full backup; inspected SQL and verified raw absence.'}),{mode:0o600});
  assert.equal((await offline('reconcile',reconciledInput)).state,'complete');
  const recovered=await f.final.storage.readOfflineActivation(f.stateDir);assert.ok(recovered);
  await writeFile(completedInput,JSON.stringify(recovered),{mode:0o600});assert.equal((await offline('check',completedInput)).state,'complete');
  if(binary) {
    const hash=digest(await readFile(binary));
    const source=await readFile('dist/executable/monitor.mjs');
    await writeFile(join(process.env.VALIDATION_ROOT!,'reports','sea-offline-identity.json'),JSON.stringify({binarySHA256:hash,compiledSourceSHA256:digest(source),identity:contract.identity,activationId:recovered.activationId,effectsStarted:false}));
  }
});

test('full backup verified optional absence matches sealed raw absence; added backup raw cannot become proof',async t=>{
  const f=await fixture(t);
  await f.final.storage.runOfflineStorageCommand(['activate','--state-dir',f.stateDir,'--input',f.input]);
  const record=await f.final.storage.readOfflineActivation(f.stateDir);assert.ok(record);
  const backup=await f.final.storage.verifyOfflineBackup(record.backup,f.stateDir,record.storageId);
  for(const [scope,name] of [['remote','remote-requests.json'],['auto-prompt','auto-prompts.json'],['automation-workflows','slack-automation.json'],['automation-workflows','github-automation.json']]) {
    assert.ok(backup.entries.some(entry=>entry.name===name && entry.kind==='absent'));
    const sealed=JSON.parse(await readFile(join(f.stateDir,`${scope}-storage-migrations`,`offline-${record.activationId}-${scope}`,'manifest.json'),'utf8'));
    assert.deepEqual(sealed.files[name],{absent:true});
    await assert.rejects(readFile(join(record.backup.root,name)),{code:'ENOENT'});
  }
  await writeFile(join(record.backup.root,'auto-prompts.json'),'[]',{mode:0o600});
  await assert.rejects(f.final.storage.verifyOfflineBackup(record.backup,f.stateDir,record.storageId),/inventory mismatch/);
});
for(const boundary of ['prior-seal','unsafe','malformed','unknown'] as const) test(`optional external raw ${boundary} preserves held source rather than empty recovery`,async t=>{
  const f=await fixture(t), path=join(f.stateDir,'auto-prompts.json');
  if(boundary==='prior-seal') {
    const parent=join(f.stateDir,'auto-prompt-storage-migrations','prior');await mkdir(parent,{recursive:true,mode:0o700});await writeFile(join(parent,'manifest.json'),'{}',{mode:0o600});
  } else if(boundary==='unsafe') await symlink('auth.json',path);
  else await writeFile(path,boundary==='malformed'?'{':'[{}]',{mode:0o600});
  await assert.rejects(f.final.storage.runOfflineStorageCommand(['activate','--state-dir',f.stateDir,'--input',f.input]));
  if(boundary==='malformed' || boundary==='unknown') assert.equal(await readFile(path,'utf8'),boundary==='malformed'?'{':'[{}]');
  if(boundary==='unsafe') {assert.equal(await f.final.storage.readOfflineActivation(f.stateDir),undefined);return;}
  const db=await f.final.storage.openStorage({stateDir:f.stateDir,bundle:f.final.bundle()});
  try {
    await db.prepare({allowMigration:false});
    assert.equal(await f.final.storage.offlineBootstrapHeld(f.stateDir,db.identity,f.activation.storageId,db),true);
    const head=await db.read<{authority:unknown}>('auto-prompt','head',{});assert.equal(head.authority,null);
    assert.equal((await db.receipt('offline-all-domains-auto-prompt-commit')).found,false);
  } finally {await db.close();}
  assert.equal(await readFile(join(f.stateDir,'auth.json'),'utf8'),'excluded-auth');
});

test('post-backup uncertain effect receipt is preserved and current SDK remains held without explicit remote reconciliation',async t=>{
  const f=await fixture(t);
  await f.final.storage.runOfflineStorageCommand(['activate','--state-dir',f.stateDir,'--input',f.input]);
  const completed=await f.final.storage.readOfflineActivation(f.stateDir);assert.ok(completed);
  let db=await f.final.storage.openStorage({stateDir:f.stateDir,bundle:f.final.bundle()});
  await db.prepare({allowMigration:false});
  const remote=new RemoteRepository(db);
  await remote.put({key:'owner\nenqueue\n019a0000-0000-7000-8000-0123456789ab',fingerprint:'a'.repeat(64),at:1,issued:1},0,null);
  await db.close();
  db=await f.final.storage.openStorage({stateDir:f.stateDir,bundle:f.final.bundle()});
  try {await db.prepare({allowMigration:false});assert.equal(await f.final.storage.offlineBootstrapHeld(f.stateDir,db.identity,completed.storageId,db),true);}
  finally {await db.close();}
  const input=join(f.root,'uncertain-restore.json');await writeFile(input,JSON.stringify(completed),{mode:0o600});
  const restored=await f.final.storage.runOfflineStorageCommand(['restore','--state-dir',f.stateDir,'--input',input]) as {barrierId:string;state:string};
  assert.equal(restored.state,'held');
  const original=new DatabaseSync(join(f.stateDir,'storage-recovery',restored.barrierId,'source','state.sqlite'),{readOnly:true});
  try {assert.equal((original.prepare("SELECT count(*) AS n FROM remote_rows WHERE status='uncertain'").get() as {n:number}).n,1);}
  finally {original.close();}
  const reconcile=join(f.root,'named-only.json');
  await writeFile(reconcile,JSON.stringify({format:'tower-offline-reconcile',activation:{...f.activation,backup:completed.backup},barrierId:restored.barrierId,scopes:f.activation.targets.filter(scope=>scope!=='remote'),by:'owner',evidence:'Remote admission outcome still unknown; intentionally not reconciled.'}),{mode:0o600});
  assert.deepEqual(await f.final.storage.runOfflineStorageCommand(['reconcile','--state-dir',f.stateDir,'--input',reconcile]),{barrierId:restored.barrierId,state:'held',effectsStarted:false});
  db=await f.final.storage.openStorage({stateDir:f.stateDir,bundle:f.final.bundle()});
  try {await db.prepare({allowMigration:false});assert.equal((await db.gate('remote')).open,false);assert.equal(await f.final.storage.offlineBootstrapHeld(f.stateDir,db.identity,completed.storageId,db),true);}
  finally {await db.close();}
});

test('explicit maintenance refuses an absent service instead of converting service:false',async t=>{
  const f=await fixture(t,'normal',{...await currentProductProfile(),serviceFixture:{installed:false}});
  await assert.rejects(f.final.storage.runLinkCommand(['service','install','--state-dir',f.stateDir,'--offline-maintenance',join(f.root,'never-read.json')]),/already installed/);
  assert.equal(await f.final.storage.currentVersion(f.stateDir),undefined);
  await assert.rejects(readFile(join(f.stateDir,'offline-service-fixture-start.json')),{code:'ENOENT'});
});
