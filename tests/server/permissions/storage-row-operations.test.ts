import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionService, type PermissionState } from '../../../server/permissions/service.js';
import { permissionRows, permissionStateBytes, type PermissionChange } from '../../../server/permissions/storage-codec.js';
import { StorageCommandError } from '../../../server/storage/contract.js';
import { PermissionSQLFixture } from './storage-fixture.js';
import { DEFAULT_AUTO_REVIEW, type PermissionRequest, type PermissionRule } from '../../../shared/permissions.js';

const now = '2026-10-10T00:00:00.000Z';
const request = (id: string, status: PermissionRequest['status'] = 'pending'): PermissionRequest => ({
  id, status, sessionId:'session', cwd:'/fixture', provider:'claude', createdAt:now, reason:'fixture',
  rule:{ kind:'run', value:'git status', providers:['claude'], scope:'project', cwd:'/fixture' },
});
const rule = (id: string, value = 'git status'): PermissionRule => ({
  id, kind:'command', value, providers:['claude'], scope:'project', cwd:'/fixture', source:'owner', createdAt:now, updatedAt:now,
});
async function setup(t: TestContext, state: PermissionState, startRun?: () => void) {
  const fixture = new PermissionSQLFixture(); t.after(() => fixture.close());
  const repository = fixture.repository(); await repository.load();
  await repository.update(permissionRows(state).map(row => ({ ...row, previous:null })));
  const service = new PermissionService({ stateDir:'/fixture', repository, globalCodex:false, startRun, now:() => new Date(now), session:() => ({ cwd:'/fixture', provider:'claude' }) });
  await service.start(); t.after(() => service.close());
  return { fixture, repository, service };
}

test('actual SQL request update clones and serializes only its target plus explicit trim removals', async t => {
  const target = { ...request('target','approved'), run:{ status:'done' as const, delivered:false, finishedAt:now } };
  const unrelated = request('unrelated');
  const old = { ...request('old','denied'), decidedAt:'2020-01-01T00:00:00.000Z' };
  const notice = { ...request('notice','denied'), decidedAt:old.decidedAt, notification:{ state:'pending' as const, message:'retain' } };
  const waiting = { ...request('waiting','approved'), createdAt:old.decidedAt, run:{ status:'waiting' as const } };
  const { fixture,service } = await setup(t,{ version:1, rules:[rule('unrelated-rule')], requests:[target,unrelated,old,notice,waiting], codex:[] });
  const previous = service.overview().requests.find(row => row.id==='unrelated')!;
  Object.defineProperty(previous,'unrelatedProbe',{ enumerable:true, get:() => { throw new Error('unrelated request cloned/serialized'); } });
  const stringify = JSON.stringify;
  const serialized: string[] = [];
  t.mock.method(JSON,'stringify',(...args: Parameters<typeof JSON.stringify>) => {
    const value = args[0] as { id?:string } | undefined;
    if (value?.id) serialized.push(value.id);
    assert.notEqual(value?.id,'unrelated','SQL bounds must not reserialize another request');
    assert.notEqual(value?.id,'unrelated-rule','SQL bounds must not reserialize another rule');
    return stringify(...args);
  });
  let sent: PermissionChange[] = [];
  fixture.onWrite = payload => { sent = (payload as { changes:PermissionChange[] }).changes; };
  await service.markTold('target');
  assert.deepEqual(sent.map(row => [row.kind,row.id,Boolean(row.remove)]),[['request','target',false],['request','old',true]]);
  assert.ok(serialized.includes('target'));
  assert.equal(service.overview().requests.find(row => row.id==='unrelated'),previous);
  assert.equal(service.overview().requests.find(row => row.id==='target')!.run!.delivered,true);
  assert.deepEqual(service.overview().requests.map(row => row.id).sort(),['notice','target','unrelated','waiting']);
  const durable = await fixture.repository().load();
  assert.equal(durable.requests.find(row => row.id==='target')!.run!.delivered,true);
  assert.deepEqual(durable.requests.map(row => row.id),['target','unrelated','notice','waiting']);
});

test('rules-only SQL restore never writes local requests, Codex files, notices or lost metadata', async t => {
  const local = { ...request('local','approved'), run:{ status:'done' as const, notify:true, delivered:false, finishedAt:now }, notification:{ state:'pending' as const, message:'local notice' } };
  const { fixture,repository,service } = await setup(t,{ version:1, rules:[rule('old-rule')], requests:[local], codex:[{ path:'/fixture/codex.rules', scope:'project', cwd:'/fixture' }], lost:'local loss', autoReview:{ enabled:true,resume:true } });
  const before = service.overview().requests[0];
  Object.defineProperty(before,'toJSON',{ value:() => { throw new Error('restore serialized a local request'); } });
  const stringify = JSON.stringify;
  t.mock.method(JSON,'stringify',(...args: Parameters<typeof JSON.stringify>) => {
    assert.notEqual((args[0] as { id?:string } | undefined)?.id,'local','SQL restore bounds cannot reserialize local rows');
    return stringify(...args);
  });
  const localRows = () => ['permission_requests','permission_codex_files'].map(table => fixture.db.prepare(`SELECT id,ordinal,json FROM ${table} ORDER BY ordinal`).all());
  const saved = localRows();
  for (const table of ['permission_requests','permission_codex_files']) for (const operation of ['INSERT','UPDATE','DELETE']) fixture.db.exec(`CREATE TEMP TRIGGER guard_${table}_${operation} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'local restore write'); END;`);
  fixture.db.exec("CREATE TEMP TRIGGER guard_lost_delete BEFORE DELETE ON permission_metadata WHEN OLD.id!='autoReview' BEGIN SELECT RAISE(ABORT,'local metadata restore write'); END;");
  let sent: PermissionChange[] = []; fixture.onWrite = payload => { sent = (payload as { changes:PermissionChange[] }).changes; };
  await service.restoreBackup({ rules:[rule('new-rule')], autoReview:{ enabled:false,resume:false }, requests:[], codex:[], lost:'foreign loss' },'restore-settings',1);
  assert.deepEqual(sent.map(row => [row.kind,row.id]),[['rule','new-rule'],['meta','autoReview']]);
  assert.deepEqual(localRows(),saved);
  assert.equal(service.overview().requests[0],before);
  assert.equal(service.overview().lost,'local loss');
  assert.deepEqual(service.overview().rules.map(row => row.id),['new-rule']);
  assert.deepEqual(service.autoReview(),{ enabled:false,resume:false });
  assert.equal(repository.effectsAvailable(),true);
  const durable = await fixture.repository().load();
  assert.deepEqual(durable.requests,[local]); assert.equal(durable.lost,'local loss');
  assert.deepEqual(durable.codex,[{ path:'/fixture/codex.rules',scope:'project',cwd:'/fixture' }]);
  await assert.rejects(service.restoreBackup({ rules:[] },'stale-restore',2),/stale/);
  assert.deepEqual(service.overview().rules.map(row => row.id),['new-rule']);
  await service.restoreBackup({ rules:[] },'restore-no-settings',1);
  assert.deepEqual(service.autoReview(),DEFAULT_AUTO_REVIEW);
  assert.deepEqual(localRows(),saved);
  assert.equal(service.overview().requests[0],before);
  assert.equal(fixture.db.prepare("SELECT count(*) AS count FROM permission_metadata WHERE id='autoReview'").get()!.count,0);
});

test('known refusal and unknown SQL result retain prior projection and admit zero effects', async t => {
  for (const disposition of ['not-committed','unknown'] as const) {
    let effects=0; let changes: PermissionChange[] = [];
    const { fixture,repository,service } = await setup(t,{ version:1, rules:[], requests:[request(disposition)], codex:[] },() => { effects++; });
    const before = service.overview().requests[0];
    fixture.onWrite = payload => {
      changes=(payload as { changes:PermissionChange[] }).changes;
      if (disposition==='not-committed') throw new StorageCommandError({ phase:'command',code:'domain-failed',message:'known refusal',disposition,retryable:false });
    };
    if (disposition==='unknown') fixture.lostAnswer=true;
    await assert.rejects(service.decide(disposition,true),disposition==='unknown' ? /acknowledgement lost/ : /known refusal/);
    assert.equal(service.overview().requests[0],before);
    assert.equal(before.status,'pending');
    assert.equal(changes.length,1);
    assert.equal(effects,0);
    const durable=await fixture.repository().load();
    assert.equal(durable.requests[0].status,disposition==='unknown' ? 'approved' : 'pending');
    if (disposition==='unknown') {
      const pending=repository.pending()!;
      assert.ok(pending.commandId); assert.match(pending.payloadSha256,/^[a-f0-9]{64}$/);
      const writes=fixture.writes;
      await assert.rejects(service.decide(disposition,true),/acknowledgement lost/);
      assert.equal(fixture.writes,writes);
      assert.equal(repository.pending()!.commandId,pending.commandId);
      assert.equal(repository.pending()!.payloadSha256,pending.payloadSha256);
      assert.equal(repository.effectsAvailable(),false);
    }
  }
});

test('owner grant, overlap removal and request decision use one SQL intent', async t => {
  const pending = { ...request('grant'), rule:{ kind:'command' as const, value:'git log --oneline', providers:['claude' as const], scope:'project' as const,cwd:'/fixture' } };
  const automatic = { ...rule('auto','git log'), source:'auto' as const };
  const { fixture,service } = await setup(t,{ version:1, rules:[automatic], requests:[pending], codex:[] });
  const priorWrites=fixture.writes;
  let changes: PermissionChange[] = []; fixture.onWrite=payload => { changes=(payload as { changes:PermissionChange[] }).changes; };
  await service.decide('grant',true);
  assert.equal(fixture.writes,priorWrites+1);
  assert.equal(changes.length,3);
  assert.equal(changes.find(row => row.id==='auto')!.remove,true);
  const approved=service.overview().requests[0];
  assert.equal(approved.status,'approved'); assert.equal(approved.decidedBy,'owner');
  const made=service.overview().rules[0];
  assert.equal(made.id,approved.ruleId); assert.equal(made.value,'git log --oneline'); assert.equal(made.source,'request');
  const durable=await fixture.repository().load();
  assert.deepEqual(durable.rules,[made]); assert.deepEqual(durable.requests,[approved]);
});

test('row byte accounting retains the exact existing pretty JSON budget', () => {
  const state: PermissionState = { version:1, rules:[rule('unicode','git log')], requests:[{ ...request('quoted'), reason:'한글\n"quoted"\t', run:{ status:'waiting', preview:{ stdout:'a\nb',stderr:'' } }, review:{ status:'running', files:[{ path:'/a',real:null,sha256:null }] } }], codex:[], autoReview:{ enabled:true,resume:false }, lost:'notice' };
  assert.equal(permissionStateBytes(state),Buffer.byteLength(JSON.stringify(state,null,2)));
  const extensions={ ...state, extra:{ empty:{}, list:[[],null,true,5,'😀',{'a"b':'line\nend'}] } };
  assert.equal(permissionStateBytes(extensions),Buffer.byteLength(JSON.stringify(extensions,null,2)));
});
