import { AutoPromptRepository } from '../../../server/auto-prompt/storage-repository.js';
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
import { APP_VERSION } from '../../../shared/app-identity.js';
import { retentionBuild, protectedOld124, currentProductProfile, type OfflineServiceFixture } from '../storage/fixtures/retention-build.js';
import { RemoteRepository } from '../../../server/remote/storage-repository.js';
import { empty } from '../../../server/triggers/state.js';
import { parseSuccessor } from '../../../server/runs/handoff.js';
import { artifactStorageContract } from '../../../server/link/storage-update.js';
import type { OfflineActivationRecord } from '../../../server/link/storage-offline.js';

const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export async function fixture(t:TestContext,fault='normal',product?:Parameters<typeof retentionBuild>[5]) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'offline-activation-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const stateDir=join(root,'state');await mkdir(stateDir,{mode:0o700});
  const full=process.env.TOWER_SQLITE_OLD124_ROOT ? await protectedOld124() : undefined;
  const old=full ?? await retentionBuild('1.124.0',join(root,'old-sdk'));
  const final=await retentionBuild(product ? APP_VERSION : '1.125.0',join(root,'final-sdk'),true,true,true,product,false,fault);
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

async function selectedPackage(f:Awaited<ReturnType<typeof fixture>>) {
  const selectedRoot=join(f.final.storage.versionDirectory(f.stateDir,f.final.version),'node_modules','agent-session-tower');await mkdir(selectedRoot,{recursive:true,mode:0o700});
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

export function serviceCases(boundaries: readonly ('stopped' | 'loaded-http-unavailable' | 'owner-http-unavailable' | 'manager-read-unavailable' | 'manager-query-unavailable' | 'owner-read-unavailable' | 'lease-loaded' | 'lease-new-owner')[]) {
for (const boundary of boundaries)
test(`full actual selected service package ${boundary} validates actual SDK and SQL completion before pointer use`,async t=>{
  const serviceFixture:OfflineServiceFixture={installed:true,
    ...(boundary==='loaded-http-unavailable'?{loadedAtCheck:1}:{}),
    ...(boundary==='owner-http-unavailable'?{ownerAtCheck:1}:{}),
    ...(boundary==='manager-read-unavailable'?{readFailure:true}:{}),
    ...(boundary==='manager-query-unavailable'?{managerQueryFailure:true}:{}),
    ...(boundary==='owner-read-unavailable'?{ownerReadFailure:true}:{}),
    ...(boundary==='lease-loaded'?{loadedAtCheck:3}:{}),
    ...(boundary==='lease-new-owner'?{ownerAtCheck:6}:{})};
  const f=await fixture(t,'normal',{...await currentProductProfile(),serviceFixture});
  await f.final.storage.runOfflineStorageCommand(['activate','--state-dir',f.stateDir,'--input',f.input]);
  const record=await f.final.storage.readOfflineActivation(f.stateDir);assert.ok(record);
  const completionInput=join(f.root,'completion.json');await writeFile(completionInput,JSON.stringify(record),{mode:0o600});
  const {selectedRoot,files}=await selectedPackage(f);
  const request={format:'tower-offline-service-maintenance' as const,service:true as const,previousVersion:'1.124.0',stateDir:f.stateDir,version:f.final.version,by:'owner',evidence:'Explicit stopped-service fixture',publishedPackageSHA256:'a'.repeat(64),files,completionInput:{path:completionInput,sha256:digest(await readFile(completionInput))}};
  await f.final.storage.verifyOfflineServiceSelection(selectedRoot,request,f.stateDir,f.final.version);
  const entry=join(selectedRoot,'bin/agent-session-tower.mjs');
  const contract=JSON.parse((await promisify(execFile)(process.execPath,[entry,'--storage-contract'],{timeout:60_000,maxBuffer:16*1024*1024})).stdout);
  assert.equal(contract.supported,true);assert.deepEqual(contract.identity,record.build);
  const checked=JSON.parse((await promisify(execFile)(process.execPath,[entry,'storage','offline','check','--state-dir',f.stateDir,'--input',completionInput],{timeout:60_000,maxBuffer:16*1024*1024})).stdout);
  assert.deepEqual(checked,{activationId:record.activationId,state:'complete',identity:record.build,effectsStarted:false});
  await symlink(join('versions','1.124.0'),join(f.stateDir,'runtime','current'));
  const approval=join(f.root,'service-maintenance.json');await writeFile(approval,JSON.stringify(request),{mode:0o600});
  const command=['service','install','--state-dir',f.stateDir,'--offline-maintenance',approval];
  if(boundary!=='stopped') {
    const before=await readFile(join(f.stateDir,'state.sqlite'));
    await assert.rejects(f.final.storage.runLinkCommand(command),/explicitly stopped|manager read unavailable|manager query unavailable|owner read unavailable/);
    assert.equal(await f.final.storage.currentVersion(f.stateDir),'1.124.0');
    if(!boundary.startsWith('lease-')) assert.deepEqual(await readFile(join(f.stateDir,'state.sqlite')),before);
    assert.deepEqual(await f.final.storage.readOfflineActivation(f.stateDir),record);
    await assert.rejects(readFile(join(f.stateDir,'offline-service-fixture-start.json')),{code:'ENOENT'});
    return;
  }
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
  assert.equal(await f.final.storage.currentVersion(f.stateDir),f.final.version);
  const started=JSON.parse(await readFile(join(f.stateDir,'offline-service-fixture-start.json'),'utf8'));
  assert.equal(started.version,f.final.version);assert.equal(started.input.start,true);
  const readySdk=await f.final.storage.openStorage({stateDir:f.stateDir,bundle:f.final.bundle()});
  try {
    await readySdk.prepare({allowMigration:false});
    const ready=await f.final.storage.evaluateCompletedOffline({stateDir:f.stateDir,managed:true,build:{version:f.final.version,manifest:f.final.manifest,preflight:await f.final.storage.preflightStorage({stateDir:f.stateDir,bundle:f.final.bundle()})}},readySdk);
    assert.equal(ready.verdict,'ready');assert.equal(ready.code,'offline-completion-verified');
  } finally {await readySdk.close();}
  await writeFile(approval,JSON.stringify({...request,service:false}),{mode:0o600});
  await assert.rejects(f.final.storage.runLinkCommand(command),/owner maintenance/);
  await assert.rejects(f.final.storage.runLinkCommand([...command,'--no-service']),/Offline maintenance/);
  // The pre-existing selected directory can contain different bytes despite the same version string.
  await writeFile(join(selectedRoot,'dist/server/index.js'),'wrong already-installed version',{mode:0o600});
  await assert.rejects(f.final.storage.verifyOfflineServiceSelection(selectedRoot,request,f.stateDir,f.final.version),/bytes changed/);
  await assert.rejects(f.final.storage.verifyOfflineServiceSelection(selectedRoot,{...request,by:''},f.stateDir,f.final.version),/approval/);
  const source=await readFile('server/link/cli.ts','utf8');
  const service=source.slice(source.indexOf('async function runService'));
  assert.ok(service.indexOf('verifyOfflineServiceSelection')<service.indexOf('await useVersion'));
  assert.ok(service.indexOf("'offline','check'")<service.indexOf('await useVersion'));
  assert.ok(service.lastIndexOf('await requireStoppedInstalledService(stateDir)')<service.indexOf('await useVersion'));
});

}
