import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunManager } from './sql-fixture.js';
import type { Session } from '../../../shared/types.js';
function session(id: string): Session {
  return { id, nativeId: id.slice(6), provider: 'codex', title: 'fixture', cwd: tmpdir(), project: 'fixture', status: 'completed', statusReason: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastMessage: '', messageCount: 1, isSubagent: false, resumable: true };
}
test('retention admission waits for exact maintenance targets and rechecks after asynchronous preparation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tower-retention-admission-'));
  const id = 'codex:10000000-0000-4000-8000-000000000001', other = 'codex:10000000-0000-4000-8000-000000000002';
  let releaseExecutable!: () => void, reached!: () => void;
  const prepared = new Promise<void>(resolve => { reached = resolve; });
  const executable = new Promise<void>(resolve => { releaseExecutable = resolve; });
  const native = new Map([id, other].map(id => [id, session(id)]));
  const manager = new RunManager({ stateDir: join(root, 'state'), getSession: id => native.get(id), refreshSessions: async () => {}, holdUntilReady: true,
    findExecutable: async () => { reached(); await executable; return '/fixture/codex'; } });
  await manager.start(); t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const pending = manager.enqueue(id, 'fixture instruction'); await prepared;
  const unlock = manager.reserveRetention([id]); assert.ok(unlock);
  let accepted = false; void pending.then(() => { accepted = true; });
  releaseExecutable(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(accepted, false);
  assert.equal(manager.list().length, 0, 'maintenance must hold admission without rejecting the instruction');
  const unrelated = await manager.enqueue(other, 'unrelated instruction'); assert.equal(unrelated.status, 'queued');
  assert.equal(manager.reserveRetention([other]), undefined, 'queued work prevents cold transfer');
  assert.equal(manager.list().some(run => run.status === 'cancelled'), false);
  let restores = 0; manager.setColdSessions([id], async () => { restores++; manager.setColdSessions([]); });
  unlock(); const admitted = await pending; assert.equal(admitted.status, 'queued');
  assert.equal(restores, 1, 'maintenance may make the session cold while the message waits');
  assert.equal(manager.list().filter(run => run.sessionId === id).length, 1);
});
test('managed cold native records and created-session placeholders stay out of normal session lists', () => {
  const id = 'codex:10000000-0000-4000-8000-000000000001'; const native = session(id);
  const manager = new RunManager({ getSession: requested => requested === id ? native : undefined, refreshSessions: async () => {} });
  assert.equal(manager.sessionList([native]).length, 1);
  manager.setColdSessions([id]); assert.equal(manager.getSession(id), undefined); assert.equal(manager.sessionList([native]).length, 0);
  manager.setColdSessions([]); assert.equal(manager.getSession(id)?.nativeId, native.nativeId);
});


test('terminal restored run history does not permanently reserve its session after restart', async t => {
  const root=await mkdtemp(join(tmpdir(),'tower-retention-admission-'));const id='codex:10000000-0000-4000-8000-000000000001';
  const options={stateDir:join(root,'state'),getSession:(requested:string)=>requested===id?session(id):undefined,refreshSessions:async()=>{},holdUntilReady:true,findExecutable:async()=>'/fixture/codex'};
  const first=new RunManager(options);await first.start();const run=await first.enqueue(id,'fixture instruction');await first.cancel(run.id);await first.close();
  const second=new RunManager(options);await second.start();t.after(async()=>{await second.close();await rm(root,{recursive:true,force:true});});
  assert.equal(second.list()[0].status,'cancelled');assert.equal(second.settledRunIds().has(run.id),true);
  const unlock=second.reserveRetention([id]);assert.ok(unlock);unlock();
});

test('bounded retention wait reports retryable non-admission without leaving a queued task', async t => {
  const root=await mkdtemp(join(tmpdir(),'tower-retention-admission-'));const id='codex:10000000-0000-4000-8000-000000000001';
  const manager=new RunManager({stateDir:join(root,'state'),getSession:requested=>requested===id?session(id):undefined,refreshSessions:async()=>{},holdUntilReady:true,findExecutable:async()=>'/fixture/codex'});
  await manager.start();t.after(async()=>{await manager.close();await rm(root,{recursive:true,force:true});});const unlock=manager.reserveRetention([id]);assert.ok(unlock);
  t.mock.timers.enable({apis:['setTimeout']});
  const pending=manager.enqueue(id,'fixture instruction');const rejection=assert.rejects(pending,(error:unknown)=>Boolean(error && typeof error==='object' && (error as {retryable?:boolean}).retryable));
  t.mock.timers.tick(30_000);await rejection;assert.equal(manager.list().length,0);unlock();
});
