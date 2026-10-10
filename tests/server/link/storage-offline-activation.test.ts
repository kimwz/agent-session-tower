import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { retentionBuild } from '../storage/fixtures/retention-build.js';
import { empty } from '../../../server/triggers/state.js';
import { parseSuccessor } from '../../../server/runs/handoff.js';
import { artifactStorageContract } from '../../../server/link/storage-update.js';
import type { OfflineActivationRecord } from '../../../server/link/storage-offline.js';

const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t:TestContext,fault='normal') {
  const root=await realpath(await mkdtemp(join(tmpdir(),'offline-activation-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const stateDir=join(root,'state');await mkdir(stateDir,{mode:0o700});
  const old=await retentionBuild('1.124.0',join(root,'old-sdk'));
  const final=await retentionBuild('1.125.0',join(root,'final-sdk'),true,true,true);
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
  const packageRoot=join(root,'protected');
  for(const [member,capture] of Object.entries({
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
  await writeFile(oldContract,JSON.stringify(artifactStorageContract(oldContext,await old.storage.preflightStorage({stateDir,bundle:old.bundle()}))),{mode:0o600});
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
