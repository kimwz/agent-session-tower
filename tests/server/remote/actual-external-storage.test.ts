import { applyWorkerFiles, collectWorkerFiles } from '../../../server/backup/payload.js';
import { takeWorkerRestore, writePendingWorker } from '../../../server/backup/restore-files.js';
import { restoreAutomationSettings } from '../../../server/slack/backup.js';
import { PermissionsRepository } from '../../../server/permissions/storage-repository.js';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, readFile, rm, writeFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { externalStorageFixture, writeWorkflowFixture } from './external-storage-fixture.js';
import { freshManifestSha256 } from '../../../server/storage/initialize.js';
import { remoteRows } from '../../../server/remote/storage-codec.js';
import { RemoteRequestLedger, requestFingerprint, REMOTE_REQUEST_RETENTION_MS, type RemoteResult } from '../../../server/remote/request-ledger.js';
import { AutoPromptManager } from '../../../server/auto-prompt/manager.js';
import { SlackAutomationManager, slackRequestId } from '../../../server/slack/automation.js';
import { collectAutomationSettings, guardSlackConnectionRestore } from '../../../server/slack/backup.js';
import { canonical } from '../../../server/remote/storage-rows.js';
import type { SlackMention, SlackWorkflow } from '../../../shared/slack.js';
import type { Snapshot } from '../../../shared/types.js';
async function folder(t:TestContext) {const dir=await realpath(await mkdtemp(join(tmpdir(),'tower-external-rows-')));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
const now=Date.parse('2026-10-10T00:00:00Z');
const uuid=(at:number,tail='0123456789ab')=>{const hex=at.toString(16).padStart(12,'0');return `${hex.slice(0,8)}-${hex.slice(8)}-7123-8abc-${tail}`;};
const record=(r:{runId:string}):RemoteResult=>({kind:'run',runId:r.runId});
const replay=(r:RemoteResult)=>r.kind==='run'?{runId:r.runId}:undefined;
const mention:SlackMention={id:'event',teamId:'T1',channel:'C1',user:'U1',ts:'1',threadTs:'1',text:'fixture'};
function workflow():SlackWorkflow {return {id:slackRequestId(mention),mention,rules:[],mode:'conversation',status:'reply-uncertain',createdAt:'2026-10-10T00:00:00Z',updatedAt:'2026-10-10T00:00:00Z',replies:[{requestKey:'fixed-send',text:'one reply',status:'sending'}]};}

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

test('actual Slack/GitHub channel PK, owner settings DTO, retained run/notification and SQL uncertain account guard',async t=>{
 const dir=await folder(t),w=workflow();w.ownerConditionalReply={requestId:'fixed-task',requestKey:'permission',text:'approved',authorizedAt:'2026-10-10T00:00:00Z',status:'pending'};w.delegatedTasks=[{requestKey:'task',requestId:'fixed-task',prompt:'fixture',provider:'codex',delegatedRunId:'retained-run',notificationClaimed:true,notificationError:'uncertain notification'}];
 const f=await externalStorageFixture(t,dir);
 await writeWorkflowFixture(f.workflows,JSON.stringify({rules:[],workflows:[w],lost:{preserve:true}}),'slack');
 await writeWorkflowFixture(f.workflows,JSON.stringify({rules:[],workflows:[w],wrapper:'github'}),'github');
 const rows=await f.workflows.loadRows();assert.equal(rows.filter(r=>r.id===w.id).length,2);
 assert.deepEqual(f.workflows.source(rows,'slack').lost,{preserve:true});assert.equal(f.workflows.source(rows,'github').wrapper,'github');
 assert.deepEqual(await collectAutomationSettings(f.workflows,'slack'),{rules:[]});
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

test('actual bounded pages/chunks retain source order and immutable receipt payload identity',async t=>{
 const dir=await folder(t),source=Array.from({length:65},(_,i)=>({key:`owner\nenqueue\n${uuid(now+i,i.toString(16).padStart(12,'0'))}`,fingerprint:requestFingerprint({}),at:now+i,issued:now+i,padding:'한'.repeat(2_000)}));
 const f=await externalStorageFixture(t,dir,false);await f.remote.importPrepared(remoteRows(source),'a'.repeat(64),'bounded-seed',f.checkActivation);
 const loaded=await f.remote.loadRows();assert.equal(loaded.length,65);assert.deepEqual(loaded.map(row=>JSON.parse(row.json)),source);assert.deepEqual(loaded.map(row=>row.ordinal),Array.from({length:65},(_,i)=>i));
 const previous=loaded[0],next={...previous,json:canonical({...source[0],result:{kind:'run',runId:'fixed-result'}})};
 await f.remote.update([{...next,previous:previous.json}],'fixed-result');const head=await f.remote.head();
 await f.remote.update([{...next,previous:previous.json}],'fixed-result');assert.equal((await f.remote.head()).revision,head.revision);
 await assert.rejects(f.remote.update([{...next,json:canonical({...source[0],result:{kind:'run',runId:'changed'}}),previous:previous.json}],'fixed-result'),/conflicts/);
});

test('initialization creates the permissions and three external authorities empty, in the same SDK, with no migration evidence', async t => {
 const dir = await folder(t), f = await externalStorageFixture(t, dir);
 assert.deepEqual((await new PermissionsRepository(f.storage, dir).load()).rules, []);
 const authorities = (await f.storage.inspect()).authority;
 for (const scope of ['permissions', 'remote', 'auto-prompt', 'automation-workflows'] as const) {
  const authority = authorities.find(entry => entry.domain === scope);
  assert.equal(authority?.authority, 'database', scope); assert.equal(authority.generation, 1);
  assert.equal(authority.manifestSha256, freshManifestSha256(scope));
 }
 assert.deepEqual(await f.remote.loadRows(), []); assert.deepEqual(await f.autoPrompt.loadRows(), []);
 assert.deepEqual((await f.workflows.loadRows()).map(row => [row.channel, row.kind]).sort(), [['github', 'settings'], ['slack', 'settings']]);
 assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('storage-migrations') || name.startsWith('storage-offline')), []);
});

test('public worker files consume SQL rules, commit restores, preserve local workflow metadata and guard credentials from SQL', async t => {
 const dir = await folder(t);
 const original = { rules: [], workflows: [workflow()], extensions: { keep: true } };
 const f = await externalStorageFixture(t, dir);
 await writeWorkflowFixture(f.workflows, JSON.stringify(original), 'slack');
 // This stale source would previously bypass the unfinished SQL account check.
 await writeFile(join(dir, 'slack-automation.json'), '{"rules":[],"workflows":[]}', { mode: 0o600 });
 const connection = { enabled: false, appToken: 'fixture-app', userToken: 'fixture-user', account: { teamId: 'T1', userId: 'U1' } };
 await writeFile(join(dir, 'slack-connection.json'), JSON.stringify(connection), { mode: 0o600 });
 const rule = { id: 'sql-rule', name: 'fixture', enabled: true, condition: 'fixture', instructions: 'fixture', replyInstructions: 'fixture', provider: 'codex' as const };
 await f.workflows.replaceRules('slack', [rule]);
 const currentRules = await collectAutomationSettings(f.workflows, 'slack');
 const exportOwner = async () => ({ 'permissions.json': { rules: [] }, 'slack-automation.json': await collectAutomationSettings(f.workflows, 'slack'), 'github-automation.json': await collectAutomationSettings(f.workflows, 'github') });
 const owner = { restore: async (name: string, incoming: unknown) => {
  if (name === 'permissions.json') throw new Error('permission owner is not part of this fixture');
  await restoreAutomationSettings(f.workflows, name === 'slack-automation.json' ? 'slack' : 'github', incoming);
 }, guardSlackConnection: (existing: unknown, incoming: unknown) => guardSlackConnectionRestore(f.workflows, existing, incoming) };
 const files = await collectWorkerFiles(dir, exportOwner);
 assert.deepEqual(files['slack-automation.json'], currentRules);
 const before = f.workflows.source(await f.workflows.loadRows(), 'slack');
 const result = await applyWorkerFiles(dir, { 'slack-automation.json': { rules: [{ ...rule, instructions: 'restored' }] } }, owner);
 assert.deepEqual(result, { parts: ['slack'], errors: [] });
 assert.deepEqual(f.workflows.source(await f.workflows.loadRows(), 'slack'), { ...before, rules: [{ ...rule, instructions: 'restored' }] });
 assert.deepEqual(JSON.parse(await readFile(join(dir, 'slack-automation.json'), 'utf8')), { rules: [], workflows: [] });
 await writePendingWorker(dir, { id: '10000000-0000-4000-8000-000000000001', files: { 'slack-connection.json': { ...connection, account: { teamId: 'T1', userId: 'U2' } } } });
 const restore = await takeWorkerRestore(dir, owner);
 assert.ok(restore);
 await restore.finish({ parts: [], errors: [] });
 const outcome = JSON.parse(await readFile(join(dir, 'restore', 'outcome-10000000-0000-4000-8000-000000000001.json'), 'utf8'));
 assert.equal(outcome.parts.includes('slack'), false);
 assert.match(outcome.errors.join(' '), /Unfinished/);
 assert.deepEqual(JSON.parse(await readFile(join(dir, 'slack-connection.json'), 'utf8')), connection);
 await assert.rejects(collectWorkerFiles(dir, async () => { throw new Error('owner held'); }), /owner held/);
 const held = await applyWorkerFiles(dir, { 'slack-automation.json': currentRules }, { ...owner, restore: async () => { throw new Error('owner held'); } });
 assert.deepEqual(held.parts, []);
 assert.match(held.errors.join(' '), /owner held/);
});
