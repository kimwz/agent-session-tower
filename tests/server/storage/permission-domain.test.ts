import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { PermissionService, type PermissionState } from '../../../server/permissions/service.js';
import { PermissionsRepository } from '../../../server/permissions/storage-repository.js';
import { permissionRows, permissionState, permissionHash, permissionStateBytes, checkPermissionBounds } from '../../../server/permissions/storage-codec.js';
import { StorageCommandError } from '../../../server/storage/contract.js';
import { PermissionSQLFixture } from '../permissions/storage-fixture.js';

const at='2026-10-10T00:00:00.000Z';
const rule={ id:'r',kind:'command' as const,value:'git status',providers:['claude' as const],scope:'global' as const,source:'owner' as const,createdAt:at,updatedAt:at };
const request={ id:'q',status:'pending' as const,rule:{ kind:'run' as const,value:'sudo rm -rf /unsafe-original',providers:['codex' as const],scope:'project' as const,cwd:'/fixture' },reason:'original',sessionId:'codex:fixture',provider:'codex' as const,cwd:'/fixture',createdAt:at,key:'key:original',keyExplicit:true,timeoutSeconds:10,review:{ status:'queued' as const,at } };
const state=():PermissionState=>({ version:1,rules:[{ ...rule }],requests:[structuredClone(request)],codex:[],autoReview:{ enabled:true,resume:true },lost:'original preserved' });
function fixture(t:TestContext) { const f=new PermissionSQLFixture(); t.after(()=>f.close()); return f; }
async function seed(f:PermissionSQLFixture,source:PermissionState) {
  const repo=f.repository(); await repo.load();
  await repo.update(permissionRows(source).map(r=>({ ...r,previous:null })));
}
function service(repo:PermissionsRepository, effects:{ starts:number; notices:number; gates:number }) {
  return new PermissionService({ stateDir:'/fixture-unused',repository:repo,globalCodex:false,session:()=>({ cwd:'/fixture',provider:'codex' }),now:()=>new Date(at),
    effectGate:async()=>{ effects.gates++; },startRun:()=>{ effects.starts++; },decision:async()=>{ effects.notices++; } });
}

test('lossless permission rows preserve IDs, provenance, notices, reviewed bindings and unknown JSON fields',()=>{
  const source={ ...state(),extra:{ quoted:'literal "\\n"',unicode:'한글' },requests:[{ ...request,status:'approved',decidedBy:'owner',decidedAt:at,run:{ status:'waiting',notify:true },notification:{ state:'pending',message:'original notice' },review:{ status:'done',verdict:'approve',files:[{ path:'/fixture/a',real:null,sha256:null }] } }],codex:[{ path:'/fixture/.codex/rules/tower.rules',scope:'project',cwd:'/fixture' }] };
  assert.deepEqual(JSON.parse(JSON.stringify(permissionState(permissionRows(source)))),source);
  assert.throws(()=>permissionRows({ ...source,rules:[{ ...rule,cwd:undefined,scope:'project' }] }));
  assert.throws(()=>permissionRows({ ...source,rules:[rule,rule] }));
  assert.throws(()=>permissionRows({ ...source,version:2 }));
});

test('startup SQL load has no effects and never executes a pending unsafe original',async t=>{
  const f=fixture(t); await seed(f,state()); const effects={ starts:0,notices:0,gates:0 };
  const p=service(f.repository(),effects); await p.start();
  assert.deepEqual(effects,{ starts:0,notices:0,gates:0 });
  assert.deepEqual(p.unfinishedRuns(),{ start:[],running:[] });
  assert.equal(await p.confirmReviewed('q'),false);
  await p.startReview('q'); await p.applyReview('q',{ verdict:'approve',reason:'untrusted model' });
  assert.equal(p.overview().requests[0].status,'pending'); assert.equal(effects.starts,0);
  assert.deepEqual(await f.repository().load(),{ ...state(),requests:[{ ...request,review:p.overview().requests[0].review }] });
});

test('historical barrier blocks startup apply, reviewer, unfinished run and continuation grants',async t=>{
  const f=fixture(t), s=state();
  s.requests[0]={ ...request,status:'approved',decidedBy:'owner',decidedAt:at,run:{ status:'waiting' },notification:{ state:'pending',message:'do not resume from historical snapshot' } };
  await seed(f,s); const effects={ starts:0,notices:0,gates:0 },p=service(f.repository(),effects); await p.start();
  const before=f.writes; f.held=true;
  assert.equal(p.claudeSettings('/fixture'),undefined); assert.equal(p.nextReview(),undefined); assert.deepEqual(p.unfinishedRuns(),{ start:[],running:[] });
  await assert.rejects(p.bootstrapEffects(new Set())); await assert.rejects(p.startReview('q')); await assert.rejects(p.confirmReviewed('q')); await assert.rejects(p.deliverNotification('q'));
  assert.deepEqual(effects,{ starts:0,notices:0,gates:0 }); assert.equal(f.writes,before);
  const restarted=service(f.repository(),effects); await assert.rejects(restarted.start());
});

test('unknown durable write blocks retry/new ID/effects and reload never starts the committed original',async t=>{
  const f=fixture(t); await seed(f,state()); const repo=f.repository(),effects={ starts:0,notices:0,gates:0 },p=service(repo,effects); await p.start();
  f.lostAnswer=true; await assert.rejects(p.decide('q',true),e=>e instanceof StorageCommandError && e.disposition==='unknown');
  const pending=repo.pending()!,before=f.writes; assert.ok(pending.commandId); assert.equal(effects.starts,0);
  await assert.rejects(p.decide('q',true)); await assert.rejects(p.requestRun({ command:'new command',reason:'retry' },{ kind:'agent',sessionId:'codex:fixture' }));
  assert.equal(f.writes,before); assert.equal(repo.pending()!.commandId,pending.commandId); assert.deepEqual(p.unfinishedRuns(),{ start:[],running:[] });
  assert.equal(await repo.resolvePending(),'committed'); assert.equal(repo.effectsAvailable(),false);
  await p.start(); assert.equal(p.overview().requests[0].status,'approved'); assert.equal(effects.starts,0);
  assert.deepEqual(p.unfinishedRuns(),{ start:[],running:[] }); await assert.rejects(p.bootstrapEffects(new Set()));
  assert.equal(await repo.resolvePending(),'committed'); assert.equal(f.writes,before);
});

test('unknown receipt hash conflict remains held; absence resolves without automatic replay',async t=>{
  const f=fixture(t); await seed(f,state()); const repo=f.repository(); await repo.load();
  f.onWrite=()=>{ throw new StorageCommandError({ phase:'deadline',code:'deadline-exceeded',message:'unknown before acknowledgement',disposition:'unknown',retryable:false }); };
  const change=repo.change('rule','r',{ ...rule,value:'git diff' },[])!;
  await assert.rejects(repo.update([change])); const pending=repo.pending()!;
  f.onWrite=undefined;
  f.receipts.set(pending.commandId,{ commandId:pending.commandId,scope:'permissions',command:'commit',payloadSha256:permissionHash('foreign'),ownerEpoch:1,committedAt:at,result:{ state:'included',value:{} } });
  await assert.rejects(repo.resolvePending()); assert.equal(repo.pending()!.commandId,pending.commandId);
  f.receipts.delete(pending.commandId); const before=f.writes;
  assert.equal(await repo.resolvePending(),'not-committed'); assert.equal(f.writes,before);
  assert.equal((await repo.load()).rules[0].value,'git status');
});

test('stale generation/revision or row contents roll back without replacing authoritative rows',async t=>{
  const f=fixture(t); await seed(f,state()); const one=f.repository(),two=f.repository(); await one.load(); await two.load();
  const stale=two.change('rule','r',{ ...rule,value:'git log' },[])!;
  await one.update([one.change('rule','r',{ ...rule,value:'git diff' },[])!]);
  await assert.rejects(two.update([stale])); assert.equal((await f.repository().load()).rules[0].value,'git diff');
  const h=await one.head(); assert.throws(()=>f.command('commit',{ mode:'update',revision:h.revision,generation:h.authority!.generation+1,changes:[] }));
  const bad={ ...one.change('rule','r',{ ...rule,value:'git status' },[])!,previous:'{}' };
  await assert.rejects(one.update([bad])); assert.equal((await f.repository().load()).rules[0].value,'git diff');
});

test('search projection corruption and payload identity corruption refuse load, never empty authority',async t=>{
  const f=fixture(t); await seed(f,state());
  f.db.prepare('UPDATE permission_requests SET status=? WHERE id=?').run('approved','q');
  await assert.rejects(f.repository().load(),/projection/);
  f.db.prepare('UPDATE permission_requests SET status=?,json=? WHERE id=?').run('pending',JSON.stringify({ ...request,id:'other' }),'q');
  await assert.rejects(f.repository().load(),/identity/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM permission_requests').get()!.n,1);
});

test('expiry and closed session deletion stay durable; surviving row order remains stable',async t=>{
  const f=fixture(t),s=state(); s.rules=[{ ...rule,scope:'conversation',cwd:'/fixture',sessionId:'claude:one',expiresAt:'2026-10-09T00:00:00.000Z' },{ ...rule,id:'r2',value:'git diff' }];
  await seed(f,s); const effects={ starts:0,notices:0,gates:0 },p=service(f.repository(),effects); await p.start();
  assert.deepEqual(JSON.parse(p.claudeSettings('/fixture','claude:one')!).permissions.allow,['Bash(git diff *)']);
  await p.expire(new Set(['claude:one'])); assert.deepEqual((await f.repository().load()).rules.map(r=>r.id),['r2']);
  await p.save({ kind:'command',value:'git log',scope:'global',providers:['claude'] });
  assert.deepEqual((await f.repository().load()).rules.map(r=>r.value),['git diff','git log']);
});

test('settings restore preserves local requests, notices, output refs and lost note; stale generation refused',async t=>{
  const f=fixture(t); await seed(f,state()); const repo=f.repository(),effects={ starts:0,notices:0,gates:0 },p=service(repo,effects); await p.start();
  const head=await repo.head(); await assert.rejects(p.restoreBackup({ rules:[] },'restore-stale',head.authority!.generation+1));
  await p.restoreBackup({ rules:[{ ...rule,value:'git log' }],requests:[],codex:[],lost:'injected' },'restore-valid',head.authority!.generation);
  const saved=await repo.load(); assert.deepEqual(saved.requests,state().requests); assert.equal(saved.lost,state().lost); assert.equal(saved.rules[0].value,'git log');
  assert.deepEqual(effects,{ starts:0,notices:0,gates:0 });
  const h=await repo.head(); const malicious={ ...saved,requests:[] };
  assert.throws(()=>f.command('commit',{ mode:'restore',revision:h.revision,generation:h.authority!.generation,changes:permissionRows(malicious).map(r=>({ ...r,previous:null })) }));
  assert.deepEqual((await f.repository().load()).requests,state().requests);
});

test('4MB, pending count and reviewed attachment bounds reject atomically',async t=>{
  const f=fixture(t),s=state(); await seed(f,s); const repo=f.repository(); await repo.load();
  const oversized={ ...s,extra:'x'.repeat(4_000_000) }; assert.throws(()=>permissionRows(oversized));
  assert.throws(()=>checkPermissionBounds(permissionRows(s).concat(Array.from({ length:51 },(_,i)=>({ kind:'request' as const,id:`q${i}`,ordinal:i+1,json:JSON.stringify({ ...request,id:`q${i}` }) })))));
  const h=await repo.head(),before=f.db.prepare('SELECT revision FROM permission_state').get()!.revision;
  assert.throws(()=>f.command('commit',{ mode:'update',revision:h.revision,generation:h.authority!.generation,changes:[{ kind:'meta',id:'extensions',ordinal:0,json:JSON.stringify({ extra:'x'.repeat(3_999_990) }),previous:null }] }));
  assert.equal(f.db.prepare('SELECT revision FROM permission_state').get()!.revision,before);
  assert.deepEqual(await repo.load(),s);
});

test('row-wise pretty JSON size accounting matches the existing 4MB guard including unicode and extension metadata',()=>{
  for (const s of [state(),{ ...state(),rules:[],requests:[],codex:[] },{ ...state(),extra:{ multiline:['한글','"\\', { nested:true }] },codex:[{ path:'/fixture/a',scope:'global' }] }]) {
    assert.equal(permissionStateBytes(s),Buffer.byteLength(JSON.stringify(s,null,2)));
    checkPermissionBounds(permissionRows(s));
  }
});

test('permission pruning deletes decided rows only after commit and preserves unfinished/output notice references',async t=>{
  const f=fixture(t),s=state();
  s.requests=[{ ...request,id:'old',status:'denied',decidedAt:'2026-08-01T00:00:00.000Z',decidedBy:'owner' },{ ...request,id:'unfinished',status:'approved',decidedAt:'2026-08-01T00:00:00.000Z',decidedBy:'owner',run:{ status:'running',pid:999999,started:'fixture' } },{ ...request,id:'notice',status:'approved',decidedBy:'owner',run:{ status:'done',finishedAt:'2026-08-01T00:00:00.000Z',notify:true },notification:{ state:'pending',message:'result' } }];
  await seed(f,s); const p=service(f.repository(),{ starts:0,notices:0,gates:0 }); await p.start();
  await p.acknowledge();
  assert.deepEqual((await f.repository().load()).requests.map(r=>r.id),['unfinished','notice']);
});

test('SQL preparation refuses malformed first imports and existing authority never reimports original JSON',async t=>{
  const f=fixture(t),repo=f.repository(); await repo.load(); const writes=f.writes;
  await assert.rejects(repo.importPrepared(state(),f.sourceSha,'forbidden-reimport',async()=>{}));
  assert.equal(f.writes,writes);
  assert.throws(()=>permissionRows({ ...state(),rules:[{ ...rule,scope:'project' }] }));
  assert.equal((await repo.load()).rules.length,0);
});

test('current source and closed-session gates are independent of imported/native grant evidence',async t=>{
  const f=fixture(t); await seed(f,state()); let closed=false,skip:string|undefined;
  const p=new PermissionService({ stateDir:'/fixture-unused',repository:f.repository(),globalCodex:false,session:()=>({ cwd:'/fixture',provider:'codex' }),now:()=>new Date(at),
    autoReviewSkip:()=>skip,requestGate:async()=>{ if (closed) throw new Error('fixture session closed'); },startRun:()=>assert.fail('original command must not execute') });
  await p.start(); closed=true; await assert.rejects(p.startReview('q')); await assert.rejects(p.decide('q',true));
  assert.equal((await f.repository().load()).requests[0].status,'pending');
  closed=false; skip='current untrusted source'; assert.equal(await p.startReview('q'),false);
  assert.equal((await f.repository().load()).requests[0].review!.status,'skipped');
  skip=undefined; await p.bootstrapEffects(new Set(['codex:fixture']));
  assert.equal((await f.repository().load()).requests[0].status,'withdrawn');
});
