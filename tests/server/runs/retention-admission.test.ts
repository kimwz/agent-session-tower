import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunManager } from '../../../server/runs/manager.js';
import type { Session } from '../../../shared/types.js';
function session(id: string): Session {
  return { id, nativeId: id.slice(6), provider: 'codex', title: 'fixture', cwd: tmpdir(), project: 'fixture', status: 'completed', statusReason: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastMessage: '', messageCount: 1, isSubagent: false, resumable: true };
}
test('retention admission refuses only its exact targets and rechecks after asynchronous preparation', async t => {
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
  releaseExecutable(); await assert.rejects(pending, /cold storage/);
  assert.equal(manager.list().length, 0, 'the race must not admit a durable run');
  const unrelated = await manager.enqueue(other, 'unrelated instruction'); assert.equal(unrelated.status, 'queued');
  assert.equal(manager.reserveRetention([other]), undefined, 'queued work prevents cold transfer');
  assert.equal(manager.list().some(run => run.status === 'cancelled'), false);
  unlock(); const admitted = await manager.enqueue(id, 'instruction after release'); assert.equal(admitted.status, 'queued');
});
test('managed cold native records and created-session placeholders stay out of normal session lists', () => {
  const id = 'codex:10000000-0000-4000-8000-000000000001'; const native = session(id);
  const manager = new RunManager({ getSession: requested => requested === id ? native : undefined, refreshSessions: async () => {} });
  assert.equal(manager.sessionList([native]).length, 1);
  manager.setColdSessions([id]); assert.equal(manager.getSession(id), undefined); assert.equal(manager.sessionList([native]).length, 0);
  manager.setColdSessions([]); assert.equal(manager.getSession(id)?.nativeId, native.nativeId);
});
