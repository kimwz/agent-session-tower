import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { externalStorageFixture } from './external-storage-fixture.js';
import { RemoteRequestLedger, remoteRequestTime, requestFingerprint, REMOTE_REQUEST_RETENTION_MS, type RemoteResult } from '../../../server/remote/request-ledger.js';
import { RemoteRepository } from '../../../server/remote/storage-repository.js';
import { importRemote, bootstrapExternal } from '../../../server/remote/storage-transfer.js';
import { importAutoPrompts } from '../../../server/auto-prompt/storage-transfer.js';
import { AutoPromptManager } from '../../../server/auto-prompt/manager.js';
import { SlackAutomationManager, slackRequestId } from '../../../server/slack/automation.js';
import { collectAutomationSettings, guardSlackConnectionRestore } from '../../../server/slack/backup.js';
import { canonical } from '../../../server/remote/storage-rows.js';
import { workflowRows } from '../../../server/slack/storage-codec.js';
import type { SlackMention, SlackWorkflow } from '../../../shared/slack.js';
import type { Entry } from '../../../server/auto-prompt/storage-codec.js';
import type { Snapshot } from '../../../shared/types.js';
async function folder(t:TestContext) {const dir=await realpath(await mkdtemp(join(tmpdir(),'tower-external-rows-')));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
const now=Date.parse('2026-10-10T00:00:00Z');
const uuid=(at:number,tail='0123456789ab')=>{const hex=at.toString(16).padStart(12,'0');return `${hex.slice(0,8)}-${hex.slice(8)}-7123-8abc-${tail}`;};
const record=(r:{runId:string}):RemoteResult=>({kind:'run',runId:r.runId});
const replay=(r:RemoteResult)=>r.kind==='run'?{runId:r.runId}:undefined;
const mention:SlackMention={id:'event',teamId:'T1',channel:'C1',user:'U1',ts:'1',threadTs:'1',text:'fixture'};
function workflow():SlackWorkflow {return {id:slackRequestId(mention),mention,rules:[],mode:'conversation',status:'reply-uncertain',createdAt:'2026-10-10T00:00:00Z',updatedAt:'2026-10-10T00:00:00Z',replies:[{requestKey:'fixed-send',text:'one reply',status:'sending'}]};}
const entry=():Entry=>({fingerprint:'a'.repeat(64),staged:[],job:{id:'10000000-0000-4000-8000-000000000001',provider:'codex',prompt:'fixture',routerModel:'fixture',status:'dispatching',createdAt:'2026-10-10T00:00:00Z',updatedAt:'2026-10-10T00:00:00Z'},selection:{decision:{action:'create',cwd:'/fixture',reason:'fixture'},relation:'new'}});

test('actual row authority wins over changed/missing source; raw remote legacy fields/issue fallback remain lossless',async t=>{
 const dir=await folder(t),id=uuid(now),legacy={key:`owner\nenqueue\n${id}`,fingerprint:requestFingerprint({}),at:now,result:{kind:'run',runId:'retained'},extra:{lost:true}};
 await writeFile(join(dir,'remote-requests.json'),JSON.stringify([legacy]),{mode:0o600});
 const f=await externalStorageFixture(t,dir);
 assert.equal((await f.remote.load())[0].entry.issued,remoteRequestTime(id));
 assert.deepEqual((await f.remote.loadRows()).map(r=>JSON.parse(r.json)),[{...legacy,issued:now}]);
 assert.deepEqual(JSON.parse(await readFile(join(dir,'remote-storage-migrations','fixture-remote','remote-requests.json'),'utf8')),[legacy]);
 assert.equal((await f.storage.receipt('fixture-remote-commit')).found,true);
 await writeFile(join(dir,'remote-requests.json'),'{broken');await rm(join(dir,'auto-prompts.json'),{force:true});
 await bootstrapExternal(f.remote,dir);assert.equal((await f.remote.load())[0].entry.result?.kind,'run');
 const ledger=new RemoteRequestLedger(dir,()=>now,20_000,f.remote,f.effectGate);await ledger.start();let executions=0;
 assert.deepEqual(await ledger.once('owner','enqueue',id,{},async()=>{executions++;return {runId:'duplicate'};},record,replay),{runId:'retained'});assert.equal(executions,0);
 await assert.rejects(ledger.once('owner','enqueue',id,{changed:true},async()=>({runId:'bad'}),record,replay),/다른 내용/);
 await assert.rejects(importRemote({repository:f.remote,stateDir:dir,evidenceParent:join(dir,'remote-storage-migrations'),commandId:'reimport',checkActivation:f.checkActivation}),/reimport/);
});

test('actual remote scoped concurrency, pruning and future clock keep dedup capacity; only definite rejection permits deletion',async t=>{
 const dir=await folder(t),f=await externalStorageFixture(t,dir);let clock=now,calls=0;const ledger=new RemoteRequestLedger(dir,()=>clock,2,f.remote,f.effectGate);await ledger.start();
 const id=uuid(now);let release!:()=>void;const waiting=new Promise<void>(r=>release=r);
 const execute=async()=>{calls++;await waiting;return {runId:'fixed'};};
 const first=ledger.once('owner','enqueue',id,{},execute,record,replay);const second=ledger.once('owner','enqueue',id,{},execute,record,replay);release();assert.deepEqual(await first,await second);assert.equal(calls,1);
 const rejectId=uuid(now,'1123456789ab');await assert.rejects(ledger.once('owner','enqueue',rejectId,{},async()=>{throw Object.assign(new Error('definitely refused'),{disposition:'not-admitted'});},record,replay),/refused/);
 await ledger.once('owner','enqueue',rejectId,{},async()=>({runId:'allowed'}),record,replay);
 await assert.rejects(ledger.once('other','enqueue',id,{},execute,record,replay),/많이/);
 clock+=REMOTE_REQUEST_RETENTION_MS+1;
 await assert.rejects(ledger.once('owner','enqueue',id,{},execute,record,replay),(e:unknown)=>(e as {disposition:string}).disposition==='uncertain');
 await ledger.once('other','enqueue',uuid(clock),{},async()=>({runId:'new'}),record,replay);assert.equal((await f.remote.load()).length,1);
 await assert.rejects(ledger.once('other','enqueue',uuid(clock+25*3600000),{},execute,record,replay),/앞서/);
});

test('actual unknown remote admission never executes after commit-response loss, and pending receipt resolves without replay',async t=>{
 const dir=await folder(t),f=await externalStorageFixture(t,dir);await f.storage.close();
 const lost=await externalStorageFixture(t,dir,false,'after');
 // Force the existing commit fault through bounded staging using a large unknown legacy field.
 const id=uuid(now),large={key:`owner\nenqueue\n${id}`,fingerprint:requestFingerprint({}),at:now,issued:now,padding:'x'.repeat(220_000)},row=lost.remote.row(large,0);
 await assert.rejects(lost.remote.update([{...row,previous:null}],'lost-intent'),(e:unknown)=>(e as {disposition:string}).disposition==='uncertain');
 assert.equal(lost.remote.pending()?.finalSent,true);
 await lost.storage.reopen();await lost.storage.prepare({allowMigration:false});assert.equal(await lost.remote.resolveUnknown(),'committed');await lost.storage.close();
 const successor=await externalStorageFixture(t,dir);const ledger=new RemoteRequestLedger(dir,()=>now,20_000,successor.remote,successor.effectGate);await ledger.start();let calls=0;
 await assert.rejects(ledger.once('owner','enqueue',id,{},async()=>{calls++;return {runId:'bad'};},record,replay),/확실하지/);assert.equal(calls,0);
 assert.equal((await successor.storage.receipt('lost-intent-commit')).found,true);
});

test('raw source change and pre-commit crash keep seal/stage hold instead of empty fallback',async t=>{
 const dir=await folder(t);await writeFile(join(dir,'remote-requests.json'),'[]',{mode:0o600});const f=await externalStorageFixture(t,dir,false);let checks=0;
 await assert.rejects(importRemote({repository:f.remote,stateDir:dir,evidenceParent:join(dir,'remote-storage-migrations'),commandId:'changed',checkActivation:async()=>{await f.checkActivation();if(++checks===1) return;await writeFile(join(dir,'remote-requests.json'),'[null]',{mode:0o600});}}),/source changed|uncertain|불확실/);
 // The injected activation change happens after the first comparison; a second source comparison is required.
 assert.equal((await f.storage.read<{authority:unknown}>('remote','head',{})).authority,null);
 await assert.rejects(bootstrapExternal(new RemoteRepository(f.storage),dir),/seal|stages/);
 assert.ok((await readdir(join(dir,'remote-storage-migrations'))).includes('changed'));
});

test('actual AP import/load retains every checkpoint and separates held model/provider/attachment effects',async t=>{
 const dir=await folder(t),e=entry();e.job.cwd='/fixture';const f=await externalStorageFixture(t,dir,false);
 await writeFile(join(dir,'auto-prompts.json'),JSON.stringify([e]),{mode:0o600});
 await importAutoPrompts({repository:f.autoPrompt,stateDir:dir,evidenceParent:join(dir,'auto-prompt-storage-migrations'),commandId:'ap-raw',checkActivation:f.checkActivation});
 assert.deepEqual((await f.autoPrompt.load())[0].entry,e);let effects=0;
 const snapshot={sessions:[],runs:[],providers:[],scanning:false,updatedAt:'',hostname:'fixture',version:'test'} as Snapshot;
 const manager=new AutoPromptManager({stateDir:dir,repository:f.autoPrompt,effectGate:async()=>{throw new Error('historical held');},snapshot:()=>snapshot,detail:async()=>undefined,refresh:async()=>{},model:async()=>{effects++;return {};},runs:{list:()=>[],create:async()=>{effects++;throw new Error('must not run');},enqueue:async()=>{effects++;throw new Error('must not run');}}});
 await manager.load();assert.equal(manager.get(e.job.id)?.status,'dispatching');assert.equal(effects,0);await assert.rejects(manager.startRuntimeEffects(),/held/);assert.equal(effects,0);
 await writeFile(join(dir,'auto-prompts.json'),'[]');assert.deepEqual((await f.autoPrompt.load())[0].entry,e);
 const next={...e,job:{...e.job,status:'uncertain' as const,error:'unknown dispatch'}};await f.autoPrompt.update([{...f.autoPrompt.row(next,0),previous:canonical(e)}],'ap-uncertain');
 assert.equal((await f.storage.receipt('ap-uncertain-commit')).found,true);
});

test('actual Slack/GitHub channel PK, owner settings DTO, retained run/notification and SQL uncertain account guard',async t=>{
 const dir=await folder(t),w=workflow();w.ownerConditionalReply={requestId:'fixed-task',requestKey:'permission',text:'approved',authorizedAt:'2026-10-10T00:00:00Z',status:'pending'};w.delegatedTasks=[{requestKey:'task',requestId:'fixed-task',prompt:'fixture',provider:'codex',delegatedRunId:'retained-run',notificationClaimed:true,notificationError:'uncertain notification'}];
 await writeFile(join(dir,'slack-automation.json'),JSON.stringify({rules:[],workflows:[w],lost:{preserve:true}}),{mode:0o600});
 await writeFile(join(dir,'github-automation.json'),JSON.stringify({rules:[],workflows:[w],wrapper:'github'}),{mode:0o600});
 const f=await externalStorageFixture(t,dir),rows=await f.workflows.loadRows();assert.equal(rows.filter(r=>r.id===w.id).length,2);
 assert.deepEqual(f.workflows.source(rows,'slack').lost,{preserve:true});assert.equal(f.workflows.source(rows,'github').wrapper,'github');
 await rm(join(dir,'slack-automation.json'));assert.deepEqual(await collectAutomationSettings(f.workflows,'slack'),{rules:[]});
 await assert.rejects(guardSlackConnectionRestore(f.workflows,{account:{teamId:'T1',userId:'U1'}},{account:{teamId:'T1',userId:'U2'}}),/Unfinished/);
 await assert.rejects(f.workflows.assertAccountTeam('slack','T2'),/another Slack account/);
 let effects=0;const manager=new SlackAutomationManager({stateDir:dir,repository:f.workflows,effectGate:async()=>{throw new Error('historical held');},fetchThread:async()=>{effects++;return [];},match:async()=>{effects++;return {};},submitAutoPrompt:async()=>{effects++;throw new Error('no');},getAutoPrompt:()=>undefined,getRun:()=>undefined,composeReply:async()=>{effects++;return {};},sendReply:async()=>{effects++;return {ts:'duplicate'};}});
 await manager.load();await manager.tick();assert.equal(effects,0);assert.deepEqual(manager.retainedRuns(),['retained-run']);await assert.rejects(manager.startRuntimeEffects(),/held/);assert.equal(effects,0);
 const rule={id:'first',name:'first',enabled:true,condition:'fixture',instructions:'fixture',replyInstructions:'fixture',provider:'codex' as const};
 await f.workflows.replaceRules('slack',[rule,{...rule,id:'second'}]);await f.workflows.replaceRules('slack',[{...rule,id:'second'},rule]);assert.deepEqual((await collectAutomationSettings(f.workflows,'slack')).rules,[{...rule,id:'second'},rule]);
 assert.equal(f.workflows.source(await f.workflows.loadRows(),'slack').workflows[0].replies?.[0].requestKey,'fixed-send');
});

test('actual SDK historical barrier holds every external owner command and model/provider/send boundary',async t=>{
 const dir=await folder(t),f=await externalStorageFixture(t,dir);let effects=0;
 const snapshot={sessions:[],runs:[],providers:[],scanning:false,updatedAt:'',hostname:'fixture',version:'test'} as Snapshot;
 const ap=new AutoPromptManager({stateDir:dir,repository:f.autoPrompt,effectGate:f.effectGate,snapshot:()=>snapshot,detail:async()=>undefined,refresh:async()=>{},model:async()=>{effects++;return {};},runs:{list:()=>[],create:async()=>{effects++;throw new Error('no');},enqueue:async()=>{effects++;throw new Error('no');}}});
 const automation=new SlackAutomationManager({stateDir:dir,repository:f.workflows,effectGate:f.effectGate,fetchThread:async()=>{effects++;return [];},match:async()=>{effects++;return {};},submitAutoPrompt:async()=>{effects++;throw new Error('no');},getAutoPrompt:()=>undefined,getRun:()=>undefined,composeReply:async()=>{effects++;return {};},sendReply:async()=>{effects++;return {ts:'no'};}});
 await ap.load();await automation.load();
 const backup=await f.storage.snapshot();
 await f.captured.storage.recordRecoveryBarrier(dir,{snapshotId:backup.id,reason:'external historical fixture',context:f.storage.context!});
 assert.equal((await f.storage.gate('core')).open,false);
 await assert.rejects(ap.startRuntimeEffects());await assert.rejects(automation.startRuntimeEffects());
 const id=uuid(now);await assert.rejects(f.remote.put({key:`owner\ncreate\n${id}`,fingerprint:requestFingerprint({}),at:now,issued:now},0,null));
 await assert.rejects(f.workflows.replaceRules('github',[]));assert.equal(effects,0);
});

test('malformed AP raw source is preserved without authority, receipt or external calls',async t=>{
 const dir=await folder(t),f=await externalStorageFixture(t,dir,false),source='[{"job":null}]';
 await writeFile(join(dir,'auto-prompts.json'),source,{mode:0o600});
 await assert.rejects(importAutoPrompts({repository:f.autoPrompt,stateDir:dir,evidenceParent:join(dir,'auto-prompt-storage-migrations'),commandId:'malformed-ap',checkActivation:f.checkActivation}));
 assert.equal(await readFile(join(dir,'auto-prompts.json'),'utf8'),source);assert.equal((await f.autoPrompt.head()).authority,null);assert.equal((await f.storage.receipt('malformed-ap-commit')).found,false);
});

test('actual pre-commit thread exit leaves a staged hold and never retries the request on startup',async t=>{
 const dir=await folder(t),f=await externalStorageFixture(t,dir);await f.storage.close();
 const lost=await externalStorageFixture(t,dir,false,'before'),ledger=new RemoteRequestLedger(dir,()=>now,20_000,lost.remote,lost.effectGate);await ledger.start();let effects=0;
 await assert.rejects(ledger.once('owner','enqueue',uuid(now),{},async()=>{effects++;return {runId:'never'};},record,replay));assert.equal(effects,0);
 await lost.storage.reopen();await lost.storage.prepare({allowMigration:false});assert.equal(await lost.remote.resolveUnknown(),'not-committed');
 await assert.rejects(bootstrapExternal(new RemoteRepository(lost.storage),dir),/stages/);
 assert.equal((await lost.storage.receipt(lost.remote.pending()!.commandId)).found,false);
});

test('actual bounded pages/chunks retain source order and immutable receipt payload identity',async t=>{
 const dir=await folder(t),source=Array.from({length:65},(_,i)=>({key:`owner\nenqueue\n${uuid(now+i,i.toString(16).padStart(12,'0'))}`,fingerprint:requestFingerprint({}),at:now+i,issued:now+i,padding:'한'.repeat(2_000)}));
 await writeFile(join(dir,'remote-requests.json'),JSON.stringify(source),{mode:0o600});const f=await externalStorageFixture(t,dir);
 const loaded=await f.remote.loadRows();assert.equal(loaded.length,65);assert.deepEqual(loaded.map(row=>JSON.parse(row.json)),source);assert.deepEqual(loaded.map(row=>row.ordinal),Array.from({length:65},(_,i)=>i));
 const previous=loaded[0],next={...previous,json:canonical({...source[0],result:{kind:'run',runId:'fixed-result'}})};
 await f.remote.update([{...next,previous:previous.json}],'fixed-result');const head=await f.remote.head();
 await f.remote.update([{...next,previous:previous.json}],'fixed-result');assert.equal((await f.remote.head()).revision,head.revision);
 await assert.rejects(f.remote.update([{...next,json:canonical({...source[0],result:{kind:'run',runId:'changed'}}),previous:previous.json}],'fixed-result'),/conflicts/);
});
