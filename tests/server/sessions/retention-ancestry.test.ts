import { actualStorage, prepareActualStorage, closeActualStorage } from './retention-actual-storage.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from '../../../shared/types.js';
import { selectRetention } from '../../../server/sessions/retention/policy.js';
const now=Date.UTC(2026,9,8),day=86_400_000;
function session(id:string,parentId?:string):Session{return{id,nativeId:id.split(':')[1],provider:'claude',title:id,cwd:'/fixture',project:'fixture',status:'completed',statusReason:'',createdAt:new Date(now-30*day).toISOString(),updatedAt:new Date(now-8*day).toISOString(),lastMessage:'',messageCount:1,isSubagent:Boolean(parentId),resumable:true,parentId};}
const A=session('claude:A'),C=session('claude:C','claude:B');
test('hot child expiry crosses a cold intermediate without adding the cold node to execution targets',()=>{
 const observation={now,migratedAt:now-10*day,complete:true,protectedIds:new Set<string>(),records:[{session:A,kind:'parent' as const,projectKey:'fixture',latestTaskEndedAt:new Date(now-8*day).toISOString()},{session:C,kind:'subagent' as const,projectKey:'fixture',latestTaskEndedAt:new Date(now-8*day).toISOString()}],ancestry:[{id:'claude:B',provider:'claude' as const,nativeId:'B',parentId:'claude:A',isSubagent:true}]};
 assert.deepEqual(selectRetention(observation).candidates.map(value=>value.ids),[['claude:C']]);
});

import { mkdtemp,mkdir,writeFile,readFile,rm,stat,realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRetentionLineage, retentionNodeMap } from '../../../server/sessions/retention/ancestry.js';
import { RetentionObserver } from '../../../server/sessions/retention/observer.js';
import { RetentionStore } from '../../../server/sessions/retention/store.js';
import { RetentionArchive } from '../../../server/sessions/retention/archive.js';
import { RetentionService } from '../../../server/sessions/retention/service.js';
import { createNativeRetentionAdapter } from '../../../server/sessions/retention/provider.js';
import { SessionService } from '../../../server/sessions/service.js';
import { RunManager } from '../../../server/runs/manager.js';
import type { RetentionMember } from '../../../shared/retention.js';
function member(parent=session('claude:B','claude:A')):RetentionMember{return{sessionId:parent.id,provider:parent.provider,nativeId:parent.nativeId,parentId:parent.parentId,isSubagent:true,parentLink:'exec',createdAt:parent.createdAt,operationId:'old',state:'cold',originalPath:'/hot/B',coldPath:'/cold/B',identity:{dev:1,ino:2,size:3,mtimeMs:4},relationships:[{id:C.id,provider:C.provider,nativeId:C.nativeId,parentId:parent.id,isSubagent:true,parentLink:'exec',createdAt:C.createdAt}]};}
test('policy-only durable proof restores lost exec linkage and normal parentless roots remain unchanged',()=>{
 const lost={...C,isSubagent:false,parentId:undefined,parentLink:undefined};const normal={...session('claude:root'),launchedByAgent:true};
 const result=resolveRetentionLineage([A,lost,normal],[member()],new Map([[lost.id,['claude:B','claude:A']]]));
 assert.equal(result.sessions.find(value=>value.id===C.id)?.parentId,'claude:B');assert.equal(result.sessions.find(value=>value.id===C.id)?.isSubagent,true);
 assert.equal(lost.parentId,undefined,'ordinary session metadata stays untouched');assert.equal(result.sessions.find(value=>value.id===normal.id)?.isSubagent,false);assert.equal(result.blockedIds.size,0,'matching ledger chooses its proven parent even with multiple launchers');
 const mismatch=resolveRetentionLineage([A,{...lost,createdAt:new Date(now).toISOString()},normal],[member()]);assert.ok(mismatch.blockedIds.has(C.id));assert.equal(mismatch.blockedIds.has(normal.id),false);
 const contradictory=resolveRetentionLineage([A,{...C,isSubagent:false}],[member()]);assert.ok(contradictory.blockedIds.has(C.id),'explicit child parent with root role is inconsistent');
 const coldCollision=resolveRetentionLineage([A,{...session('claude:B','claude:A'),isSubagent:false}],[member()]);assert.ok(coldCollision.blockedIds.has('claude:B'));
});
test('node alias canonicalization copies frozen inputs and shares only its own mutable node',()=>{
 const parent=Object.freeze({...A,id:'monitor-A'});const child=Object.freeze({...C,parentId:'claude:A'});const cold=Object.freeze({...member(),sessionId:'monitor-B'});
 const ancestry=Object.freeze([{id:cold.sessionId,provider:cold.provider,nativeId:cold.nativeId,parentId:parent.id,isSubagent:true}]);
 const map=retentionNodeMap({records:[{session:parent,kind:'parent'},{session:child,kind:'subagent'}],ancestry});
 assert.equal(map.get(C.id)?.parentId,parent.id);assert.equal(child.parentId,'claude:A');assert.equal(map.get(parent.id),map.get('claude:A'));assert.notEqual(map.get(parent.id),parent);assert.equal(ancestry[0].parentId,parent.id);
});
test('native identity and incarnation preserve proofs when the local session alias changes',()=>{
 const current={...C,id:'monitor-current',isSubagent:false,parentId:undefined,parentLink:undefined};
 const direct=resolveRetentionLineage([A,current],[member()]);assert.equal(direct.sessions.find(value=>value.id===current.id)?.parentId,'claude:B');assert.equal(direct.blockedIds.size,0);
 const owned={...member(C),state:'restored' as const,parentId:'claude:B',relationships:[]};
 const restored=resolveRetentionLineage([A,current],[member(),owned]);assert.equal(restored.sessions.find(value=>value.id===current.id)?.parentId,'claude:B');assert.equal(restored.blockedIds.size,0);
 const changed=resolveRetentionLineage([A,{...current,createdAt:new Date(now).toISOString()}],[member(),owned]);assert.ok(changed.blockedIds.has(current.id),'matching native alias never permits a different incarnation');
});
test('parent limits and protected descendants traverse cold intermediates but count and execute only hot records',()=>{
 const parents=Array.from({length:20},(_,index)=>session('claude:P'+index));const hot=[A,...parents];
 const records=hot.map((value,index)=>({session:value,kind:'parent' as const,projectKey:'fixture',lastActivityAt:new Date(now-(index?index/30:20)*day).toISOString(),latestTaskEndedAt:new Date(now-8*day).toISOString()}));
 const child={session:C,kind:'subagent' as const,projectKey:'fixture',lastActivityAt:new Date(now-day).toISOString(),latestTaskEndedAt:new Date(now-day).toISOString()};
 const obs={now,migratedAt:now-10*day,complete:true,protectedIds:new Set<string>(),records:[...records,child],ancestry:[{id:'claude:B',provider:'claude' as const,nativeId:'B',parentId:A.id,isSubagent:true}]};
 assert.ok(selectRetention(obs).deferred.some(item=>item.id===A.id&&item.reason==='young-descendant'));
 obs.protectedIds.add(C.id);child.latestTaskEndedAt=new Date(now-8*day).toISOString();child.lastActivityAt=child.latestTaskEndedAt;
 assert.ok(selectRetention(obs).deferred.some(item=>item.id===A.id&&item.reason==='protected'));
 obs.protectedIds.clear();child.lastActivityAt=new Date(now).toISOString();assert.equal(selectRetention(obs).candidates.some(item=>item.rootId===A.id),false,'hot child activity reaches its real family root');
 assert.equal(selectRetention(obs).candidates.some(item=>item.ids.includes('claude:B')),false);
});
test('manager reservation follows lost hot child lineage through cold nodes to the active admission boundary',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'tower-retention-ancestry-')));const lost={...C,isSubagent:false,parentId:undefined};const native=new Map([{...A,nativeId:'10000000-0000-4000-8000-000000000001'},lost].map(value=>[value.id,value]));
 const manager=new RunManager({stateDir:join(root,'state'),getSession:id=>native.get(id),refreshSessions:async()=>{},holdUntilReady:true,findExecutable:async()=>'/fixture/claude'});await manager.start();t.after(async()=>{await manager.close();await rm(root,{recursive:true,force:true});});
 manager.setRetentionLineage([member()]);const release=manager.reserveRetention([C.id]);assert.ok(release);assert.ok(manager.retentionReservedIds().has(A.id));assert.ok(manager.retentionReservedIds().has('claude:B'));
 let admitted=false;const pending=manager.enqueue(A.id,'owner instruction').then(run=>{admitted=true;return run;});await new Promise(resolve=>setTimeout(resolve,10));assert.equal(admitted,false);release();assert.equal((await pending).status,'queued');assert.equal(manager.getSession('claude:B'),undefined);
});
test('manager reserves consecutive lost hot ancestors through separate cold proofs',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'tower-retention-ancestry-')));
 const R=session('claude:R'),P=session('claude:P',R.id),linkedA=session(A.id,P.id),B=session('claude:B',A.id);
 const lostA={...linkedA,isSubagent:false,parentId:undefined,parentLink:undefined};const lostC={...C,isSubagent:false,parentId:undefined,parentLink:undefined};
 const unrelated=session('claude:unrelated');const reads=new Set<string>();const native=new Map([R,lostA,lostC,unrelated].map(value=>[value.id,value]));
 const manager=new RunManager({stateDir:join(root,'state'),getSession:id=>{reads.add(id);return native.get(id);},refreshSessions:async()=>{},holdUntilReady:true});await manager.start();t.after(async()=>{await manager.close();await rm(root,{recursive:true,force:true});});
 const Pmember={...member(P),relationships:[{id:A.id,provider:A.provider,nativeId:A.nativeId,parentId:P.id,isSubagent:true as const,parentLink:'exec' as const,createdAt:A.createdAt}]};
 manager.setRetentionLineage([Pmember,member(B)]);const release=manager.reserveRetention([C.id]);assert.ok(release);
 for(const id of [C.id,B.id,A.id,P.id,R.id])assert.ok(manager.retentionReservedIds().has(id),id+' must remain reserved across both lost hot edges');
 assert.equal(reads.has(unrelated.id),false,'reachable metadata lookup does not scan unrelated hot sessions');assert.equal(lostA.parentId,undefined);assert.equal(lostC.parentId,undefined);release();
});
test('native scanner launcher snapshot keeps interactive roots and restores only eligible cold-parent children',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'tower-retention-ancestry-')));const claudeHome=join(root,'claude'),codexHome=join(root,'codex'),native=join(claudeHome,'projects','fixture');await mkdir(native,{recursive:true});await mkdir(join(codexHome,'sessions'),{recursive:true});
 const created=new Date(now-30*day).toISOString();
 for(const [id,entrypoint] of [['B','sdk-cli'],['I','cli'],['E','sdk-cli']])await writeFile(join(native,id+'.jsonl'),JSON.stringify({type:'user',sessionId:id,cwd:root,entrypoint,timestamp:created,message:{role:'user',content:id}})+'\n');
 const sessions=new SessionService({claudeHome,codexHome,inspectProcesses:async()=>({claude:new Map(),codex:new Set<string>(),providerRunning:{claude:false,codex:false},launchers:new Map([['claude:I',['claude:B']],['claude:E',['claude:B']]])})});t.after(async()=>{sessions.stop();await rm(root,{recursive:true,force:true});});
 await sessions.refresh(true);let snapshot=sessions.retentionRecords();assert.equal(snapshot.launchers.has('claude:I'),false);assert.equal(snapshot.launchers.has('claude:E'),true);assert.equal(sessions.get('claude:I')?.isSubagent,false);
 const cold={...member(session('claude:B',A.id)),createdAt:created,relationships:[]};sessions.setColdRegistry([join(native,'B.jsonl')],['claude:B']);await sessions.refresh(true);snapshot=sessions.retentionRecords();
 assert.equal(sessions.get('claude:I')?.isSubagent,false);assert.equal(sessions.get('claude:E')?.isSubagent,false,'ordinary lost exec linkage is unchanged');
 const resolved=resolveRetentionLineage(snapshot.records.map(value=>value.session),[cold],snapshot.launchers);assert.equal(resolved.sessions.find(value=>value.id==='claude:I')?.parentId,undefined);assert.equal(resolved.sessions.find(value=>value.id==='claude:I')?.isSubagent,false);assert.equal(resolved.sessions.find(value=>value.id==='claude:E')?.parentId,'claude:B');assert.equal(sessions.get('claude:E')?.parentId,undefined);
});
for(const mode of ['automatic','explicit'] as const)test(`actual Claude scan cold parent -> lost exec child -> ${mode} archive, restore and later expiry`,async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'tower-retention-ancestry-')));await prepareActualStorage(root);const claudeHome=join(root,'claude'),codexHome=join(root,'codex'),native=join(claudeHome,'projects','fixture');await mkdir(native,{recursive:true});await mkdir(join(codexHome,'sessions'),{recursive:true});
 const created=Date.now()-20*day;let clock=Date.now();const ended=new Map([['claude:A',clock-9*day],['claude:B',clock-8*day],['claude:C',clock-day]]);
 for(const id of ['A','B','C'])await writeFile(join(native,id+'.jsonl'),JSON.stringify({type:'user',sessionId:id,cwd:root,entrypoint:id==='A'?'cli':'sdk-cli',timestamp:new Date(created).toISOString(),message:{role:'user',content:id+' review'}})+'\n'+JSON.stringify({type:'assistant',timestamp:new Date(clock-8*day).toISOString(),message:{role:'assistant',content:'finished',stop_reason:'end_turn'}})+'\n');
 const sessions=new SessionService({claudeHome,codexHome,inspectProcesses:async()=>({claude:new Map(),codex:new Set<string>(),providerRunning:{claude:false,codex:false},launchers:new Map([['claude:B',['claude:A']],['claude:C',['claude:B']]])})});
 const store=new RetentionStore(join(root,'state'), { storage: actualStorage(join(root,'state')) });await store.start(clock-10*day);const originals=join(root,'originals');let protectedIds=new Set<string>();
 await mkdir(join(root,'observer'));const observer=new RetentionObserver({ stateDir: join(root,'observer'), storage: actualStorage(join(root,'observer')),now:()=>clock,journalMembers:()=>store.list().flatMap(entry=>entry.members||[]),snapshot:async()=>{const snapshot=await sessions.completedRetentionRecords();return{...snapshot,records:snapshot.records.map(value=>({...value,latestTaskEndedAt:new Date(ended.get(value.session.id)!).toISOString()}))};},reconcile:value=>value,runs:()=>[],settled:()=>new Set(),protectedIds:()=>protectedIds,projectIdentity:async()=>'fixture'});await observer.start();
 const adapter=createNativeRetentionAdapter({claude:[join(claudeHome,'projects')],codex:[join(codexHome,'sessions'),join(codexHome,'archived_sessions')]},{coldRoot:originals,claudeHome,codexHome,inspect:async()=>({complete:true,activeIds:new Set<string>(),issues:[]})});
 const archive=new RetentionArchive(join(root,'bundles'),[join(claudeHome,'projects')],[originals]);
 const service=new RetentionService({store,archive,adapter,observe:()=>observer.observe(),refresh:()=>sessions.refresh(true),onColdChanged:members=>sessions.setColdRegistry(members.flatMap(member=>[member.originalPath,...(member.coldPath?[member.coldPath]:[])]),members.map(member=>member.sessionId))});await service.start();t.after(async()=>{await service.quiesce();sessions.stop();await closeActualStorage(root); await rm(root,{recursive:true,force:true});});
 assert.equal(sessions.get('claude:C'),undefined);await service.cycle();const Bentry=store.list().find(entry=>entry.members?.some(member=>member.sessionId==='claude:B'))!;assert.ok(Bentry);assert.equal(Bentry.members![0].relationships?.[0].id,'claude:C');
 assert.equal(sessions.get('claude:B'),undefined);assert.equal(sessions.get('claude:C')?.isSubagent,false,'ordinary exec-lineage actually clears a missing hot parent');
 let observed=await observer.observe();assert.equal(observed.records.find(value=>value.session.id==='claude:C')?.session.parentId,'claude:B');assert.equal(observed.records.some(value=>value.session.id==='claude:B'),false);
 for(const active of ['claude:A','claude:B']){protectedIds=new Set([active]);observed=await observer.observe();assert.ok(observed.protectedIds.has('claude:C'));}protectedIds.clear();
 if(mode==='automatic'){ended.set('claude:C',clock-8*day);await service.cycle();}else await service.archiveSession('claude:C');
 const Centry=store.list().find(entry=>entry.members?.some(member=>member.sessionId==='claude:C'))!;assert.equal(Centry.members![0].state,'cold');assert.equal(sessions.get('claude:C'),undefined);
 await service.restore(Centry.id);assert.ok(sessions.get('claude:C'));assert.equal(sessions.get('claude:B'),undefined);assert.match(await readFile(join(native,'C.jsonl'),'utf8'),/C review/);
 await service.cycle();assert.equal(store.list().filter(entry=>entry.members?.some(member=>member.sessionId==='claude:C'&&member.state==='cold')).length,0,'restored child grace is respected while its parent remains cold');
 clock+=8*day;await service.cycle();assert.ok(store.list().some(entry=>entry.members?.some(member=>member.sessionId==='claude:C'&&member.state==='cold')),'restored child later expires through the same cold ancestry');
});

import { DatabaseSync } from 'node:sqlite';
import { rename } from 'node:fs/promises';
test('Codex cold parent survives child-only native restore, explicit archive and grace expiry',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'tower-retention-ancestry-')));await prepareActualStorage(root);const codexHome=join(root,'codex'),claudeHome=join(root,'claude'),hot=join(codexHome,'sessions'),archived=join(codexHome,'archived_sessions');await mkdir(hot,{recursive:true});await mkdir(archived);await mkdir(join(claudeHome,'projects'),{recursive:true});
 let clock=Date.now();const created=new Date(clock-20*day).toISOString(),ended=new Date(clock-8*day).toISOString();
 const db=new DatabaseSync(join(codexHome,'state_5.sqlite'));db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,archived INTEGER); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT,status TEXT)');
 for(const id of ['A','B','C']){const parent=id==='B'?'A':id==='C'?'B':undefined;const path=join(hot,id+'.jsonl');await writeFile(path,JSON.stringify({type:'session_meta',timestamp:created,payload:{id,timestamp:created,cwd:root,thread_source:parent?'subagent':'user',parent_thread_id:parent,source:parent?{subagent:{thread_spawn:{parent_thread_id:parent}}}:'cli'}})+'\n'+JSON.stringify({type:'response_item',timestamp:ended,payload:{type:'message',role:'user',content:[{type:'input_text',text:id+' task'}]}})+'\n'+JSON.stringify({type:'event_msg',timestamp:ended,payload:{type:'task_complete'}})+'\n');db.prepare('INSERT INTO threads VALUES (?,?,?)').run(id,path,0);if(parent)db.prepare('INSERT INTO thread_spawn_edges VALUES (?,?,?)').run(parent,id,'closed');}
 const move=async(id:string,cold:boolean)=>{const row=db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(id)!;const path=join(cold?archived:hot,id+'.jsonl');await rename(String(row.rollout_path),path);db.prepare('UPDATE threads SET rollout_path=?,archived=? WHERE id=?').run(path,Number(cold),id);};
 const sessions=new SessionService({codexHome,claudeHome,inspectProcesses:async()=>({claude:new Map(),codex:new Set<string>(),providerRunning:{claude:false,codex:false}})});
 const store=new RetentionStore(join(root,'state'), { storage: actualStorage(join(root,'state')) });await store.start(clock-10*day);await mkdir(join(root,'observer'));const observer=new RetentionObserver({ stateDir: join(root,'observer'), storage: actualStorage(join(root,'observer')),now:()=>clock,snapshot:()=>sessions.completedRetentionRecords(),journalMembers:()=>store.list().flatMap(entry=>entry.members||[]),reconcile:value=>value,runs:()=>[],settled:()=>new Set(),protectedIds:()=>[],projectIdentity:async()=>'fixture'});await observer.start();
 const originals=join(root,'originals'),adapter=createNativeRetentionAdapter({claude:[join(claudeHome,'projects')],codex:[hot,archived]},{coldRoot:originals,codexHome,claudeHome,inspect:async()=>({complete:true,activeIds:new Set<string>(),issues:[]}),codexClient:()=>({metadata:async id=>({id,path:String(db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(id)!.rollout_path)}),archive:async id=>move(id,true),unarchive:async id=>move(id,false),close:async()=>{}})});
 const service=new RetentionService({store,archive:new RetentionArchive(join(root,'bundles'),[hot,archived],[originals]),adapter,observe:()=>observer.observe(),refresh:()=>sessions.refresh(true),onColdChanged:members=>sessions.setColdRegistry(members.flatMap(member=>[member.originalPath,...(member.coldPath?[member.coldPath]:[])]),members.map(member=>member.sessionId))});await service.start();t.after(async()=>{await service.quiesce();sessions.stop();db.close();await closeActualStorage(root); await rm(root,{recursive:true,force:true});});
 await service.cycle();await service.cycle();const Bentry=store.list().find(entry=>entry.members?.some(member=>member.sessionId==='codex:B'&&member.state==='cold'));assert.ok(Bentry);const Centry=store.list().find(entry=>entry.members?.some(member=>member.sessionId==='codex:C'&&member.state==='cold'))!;assert.ok(Centry);
 await service.restore(Centry.id);assert.equal(sessions.get('codex:B'),undefined);assert.ok(sessions.get('codex:C'));assert.equal(db.prepare('SELECT archived FROM threads WHERE id=?').get('B')!.archived,1);
 const observed=await observer.observe();assert.equal(observed.records.find(value=>value.session.id==='codex:C')?.session.parentId,'codex:B');await service.cycle();assert.equal(store.list().some(entry=>entry.members?.some(member=>member.sessionId==='codex:C'&&member.state==='cold')),false,'service applies the durable restore grace');
 await service.archiveSession('codex:C');const explicit=store.list().find(entry=>entry.members?.some(member=>member.sessionId==='codex:C'&&member.state==='cold'))!;assert.ok(explicit);await service.restore(explicit.id);
 clock+=8*day;await service.cycle();assert.ok(store.list().some(entry=>entry.members?.some(member=>member.sessionId==='codex:C'&&member.state==='cold')));assert.equal(db.prepare('SELECT archived FROM threads WHERE id=?').get('B')!.archived,1);
});

test('unknown cold role is policy-blocked while reservation and automatic restore remain compatible',async t=>{
 const unknown={...member(),isSubagent:undefined};const lost={...C,isSubagent:false,parentId:undefined};
 const resolved=resolveRetentionLineage([A,lost],[unknown]);const obs={now,migratedAt:now-10*day,complete:true,protectedIds:new Set<string>(),ancestry:resolved.ancestry,blockedIds:resolved.blockedIds,records:resolved.sessions.map(value=>({session:value,kind:value.isSubagent?'subagent' as const:'parent' as const,latestTaskEndedAt:new Date(now-8*day).toISOString()}))};
 assert.ok(selectRetention(obs).deferred.some(value=>value.id===C.id&&value.reason==='unknown-relationship'));
 const root=await realpath(await mkdtemp(join(tmpdir(),'tower-retention-ancestry-')));await prepareActualStorage(root);const source={...lost,nativeId:'10000000-0000-4000-8000-000000000003'};const native=new Map([A,source].map(value=>[value.id,value]));
 const manager=new RunManager({stateDir:join(root,'state'),getSession:id=>native.get(id),refreshSessions:async()=>{},holdUntilReady:true,findExecutable:async()=>'/fixture/claude'});await manager.start();t.after(async()=>{await manager.close();await closeActualStorage(root); await rm(root,{recursive:true,force:true});});
 const ownedC={...member(source),provider:source.provider,nativeId:source.nativeId,parentId:'claude:B',sessionId:C.id,createdAt:source.createdAt,isSubagent:true,relationships:[]};
 manager.setRetentionLineage([unknown,ownedC]);manager.setColdSessions([C.id],async()=>{manager.setColdSessions([]);manager.setRetentionLineage([unknown,{...ownedC,state:'restored'}]);});
 const release=manager.reserveRetention([C.id]);assert.ok(release);assert.ok(manager.retentionReservedIds().has(A.id));release();assert.equal((await manager.enqueue(C.id,'new task after native restore')).status,'queued');
});

for(const direction of ['ordinary','restore-race'] as const)test(`durable intent publication preserves launcher proofs through ${direction}`,async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'tower-retention-ancestry-')));await prepareActualStorage(root);const claudeHome=join(root,'claude'),codexHome=join(root,'codex'),native=join(claudeHome,'projects','fixture');await mkdir(native,{recursive:true});await mkdir(join(codexHome,'sessions'),{recursive:true});await mkdir(join(root,'observer'));
 const clock=Date.now(),created=new Date(clock-20*day).toISOString(),ended=new Date(clock-8*day).toISOString();
 for(const id of ['A','B','C'])await writeFile(join(native,id+'.jsonl'),JSON.stringify({type:'user',sessionId:id,cwd:root,entrypoint:id==='A'?'cli':'sdk-cli',timestamp:created,message:{role:'user',content:id}})+'\n'+JSON.stringify({type:'assistant',timestamp:ended,message:{role:'assistant',content:'finished',stop_reason:'end_turn'}})+'\n');
 let inspections=0;const proofs=join(root,'launch-proofs.json');const sessions=new SessionService({claudeHome,codexHome,launchProofs:proofs,inspectProcesses:async()=>({claude:new Map(),codex:new Set<string>(),providerRunning:{claude:false,codex:false},launchers:++inspections===1?new Map([['claude:B',['claude:A']],['claude:C',['claude:B']]]):new Map()})});await sessions.refresh(true);
 const store=new RetentionStore(join(root,'state'), { storage: actualStorage(join(root,'state')) });await store.start(clock-10*day);const observer=new RetentionObserver({ stateDir: join(root,'observer'), storage: actualStorage(join(root,'observer')),now:()=>clock,snapshot:()=>sessions.completedRetentionRecords(),journalMembers:()=>store.list().flatMap(entry=>entry.members||[]),reconcile:value=>value,runs:()=>[],settled:()=>new Set(),protectedIds:()=>[],projectIdentity:async()=>'fixture'});await observer.start();const originals=join(root,'originals');
 let beginRestore=false,raceStarted=false,barrierEnabled=false;let pendingScan:Promise<void>|undefined;let entered!:()=>void,release!:()=>void;
 const atBarrier=new Promise<void>(resolve=>{entered=resolve;}),continueScan=new Promise<void>(resolve=>{release=resolve;});const originalStat=fsPromises.stat;
 const adapter=createNativeRetentionAdapter({claude:[join(claudeHome,'projects')],codex:[join(codexHome,'sessions'),join(codexHome,'archived_sessions')]},{coldRoot:originals,claudeHome,codexHome,inspect:async()=>{if(direction==='restore-race'&&beginRestore&&!raceStarted){raceStarted=true;barrierEnabled=true;pendingScan=sessions.refresh();await atBarrier;}return{complete:true,activeIds:new Set(),issues:[]};}});
 const service=new RetentionService({store,archive:new RetentionArchive(join(root,'bundles'),[join(claudeHome,'projects')],[originals]),adapter,observe:()=>observer.observe(),refresh:()=>sessions.refresh(true),onColdChanged:members=>{
   sessions.setColdRegistry(members.flatMap(member=>[member.originalPath,...member.coldPath?[member.coldPath]:[]]),store.list().flatMap(entry=>entry.members||[]).filter(member=>member.state!=='restored').map(member=>`${member.provider}:${member.nativeId}`));
   if(raceStarted&&store.list().some(entry=>entry.members?.some(member=>member.state==='restored'))){barrierEnabled=false;release();}
 }});await service.start();t.after(async()=>{barrierEnabled=false;release();fsPromises.stat=originalStat;syncBuiltinESMExports();await pendingScan;await service.quiesce();sessions.stop();await closeActualStorage(root); await rm(root,{recursive:true,force:true});});

 await service.verifyBackups();await service.archiveSession('claude:B');const entry=store.list().find(entry=>entry.members?.length===2)!;assert.ok(entry);assert.ok(entry.members!.every(member=>member.state==='cold'));
 await sessions.quiesce();sessions.resume();const persisted=JSON.parse(await readFile(proofs,'utf8'));assert.deepEqual(persisted.launches['claude:B'],['claude:A']);assert.deepEqual(persisted.launches['claude:C'],['claude:B']);
 if(direction==='restore-race'){
   fsPromises.stat=(async(...args:Parameters<typeof fsPromises.stat>)=>{if(barrierEnabled&&String(args[0])===join(native,'A.jsonl')){entered();await continueScan;}return originalStat(...args);}) as typeof fsPromises.stat;syncBuiltinESMExports();beginRestore=true;
 }
 await service.restore(entry.id);assert.equal(sessions.get('claude:B')?.parentId,'claude:A');assert.equal(sessions.get('claude:C')?.parentId,'claude:B');assert.equal(sessions.get('claude:B')?.isSubagent,true);assert.equal(sessions.get('claude:C')?.isSubagent,true);
 await sessions.quiesce();const restoredProofs=JSON.parse(await readFile(proofs,'utf8'));assert.deepEqual(restoredProofs.launches['claude:B'],['claude:A']);assert.deepEqual(restoredProofs.launches['claude:C'],['claude:B']);if(direction==='restore-race')assert.equal(raceStarted,true);

});

import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
