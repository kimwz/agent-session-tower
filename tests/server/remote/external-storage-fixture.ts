import { after, type TestContext } from 'node:test';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { retentionBuild } from '../storage/fixtures/retention-build.js';
import { RemoteRepository } from '../../../server/remote/storage-repository.js';
import { AutoPromptRepository } from '../../../server/auto-prompt/storage-repository.js';
import { WorkflowRepository } from '../../../server/slack/storage-repository.js';
import { importRemote } from '../../../server/remote/storage-transfer.js';
import { importAutoPrompts } from '../../../server/auto-prompt/storage-transfer.js';
import { importWorkflows } from '../../../server/slack/storage-transfer.js';
/** Existing actual SDK/artifact fixture, extended with the three owner registries. No second harness. */
let build: ReturnType<typeof retentionBuild> | undefined;
let buildDirectory: string | undefined;
after(async()=> { if(buildDirectory) await rm(buildDirectory,{recursive:true,force:true}); });
async function artifact() {
 if(!build) build=(async()=> {buildDirectory=await realpath(await mkdtemp(join(tmpdir(),'tower-external-artifact-')));return retentionBuild('1.125.0',buildDirectory,true,true);})();return build;
}
export async function externalStorageFixture(t:TestContext,stateDir:string,importDomains=true,fault='normal') {
 await mkdir(stateDir,{recursive:true,mode:0o700}); stateDir = await realpath(stateDir);
 const captured=await artifact(),storage=await captured.storage.openStorage({stateDir,bundle:captured.bundle(fault)});t.after(()=>storage.close());
 await storage.prepare({allowMigration:true});
 const remote=new RemoteRepository(storage),autoPrompt=new AutoPromptRepository(storage),workflows=new WorkflowRepository(storage);
 const checkActivation=async()=> {
  // The fixture invokes domain import directly; it is not a replacement for C's product offline owner checker.
  if(storage.context?.manifest.digest!==captured.manifest.digest||storage.context.identity.appVersion!=='1.125.0') throw new Error('External fixture identity mismatch.');
  for(const scope of ['core','remote','auto-prompt','automation-workflows']) if(!(await storage.gate(scope)).open) throw new Error('Fixture actual SDK gate closed.');
 };
 if(importDomains) for(const [repository,importer] of [[remote,importRemote],[autoPrompt,importAutoPrompts],[workflows,importWorkflows]] as const) {
  if(!(await repository.head()).authority) await importer({repository,stateDir,evidenceParent:join(stateDir,`${repository.codec.scope}-storage-migrations`),commandId:`fixture-${repository.codec.scope}`,checkActivation});
 }
 return {storage,remote,autoPrompt,workflows,captured,checkActivation,effectGate:checkActivation};
}

/** Fixture setup/probes use owner commands; stale runtime JSON is never an observation API. */
export async function readAutoPromptFixture(repository:AutoPromptRepository):Promise<string> {
 return JSON.stringify((await repository.load()).map(({entry})=>entry));
}
export async function writeAutoPromptFixture(repository:AutoPromptRepository,json:string):Promise<void> {
 const {autoPromptRows}=await import('../../../server/auto-prompt/storage-codec.js');
 const current=await repository.loadRows(),next=autoPromptRows(JSON.parse(json));
 const changes=next.map(row=>({...row,previous:current.find(old=>old.id===row.id)?.json??null}));
 for(const old of current) if(!next.some(row=>row.id===old.id)) changes.push({...old,previous:old.json,remove:true} as typeof changes[number]);
 await repository.update(changes);
}
export async function readWorkflowFixture(repository:WorkflowRepository,channel:'slack'|'github'='slack'):Promise<string> {
 return JSON.stringify(repository.source(await repository.loadRows(),channel));
}
export async function writeWorkflowFixture(repository:WorkflowRepository,json:string,channel:'slack'|'github'='slack'):Promise<void> {
 const {workflowRows}=await import('../../../server/slack/storage-codec.js');
 const current=(await repository.loadRows()).filter(row=>row.channel===channel),next=workflowRows(JSON.parse(json),channel);
 const changes=next.map(row=>({...row,previous:current.find(old=>old.id===row.id&&old.kind===row.kind)?.json??null}));
 for(const old of current) if(!next.some(row=>row.id===old.id&&row.kind===old.kind)) changes.push({...old,previous:old.json,remove:true} as typeof changes[number]);
 await repository.update(changes);
}
