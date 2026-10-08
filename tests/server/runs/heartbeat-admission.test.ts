import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RunManager } from '../../../server/runs/manager.js';
import { MASTER_FOLDER, MASTER_HEARTBEAT_MARK } from '../../../shared/master.js';
import type { Session } from '../../../shared/types.js';
async function fixture(t: test.TestContext, wait = false) {
  const root = await mkdtemp(join(tmpdir(), 'tower-heartbeat-admission-'));
  const id = 'codex:10000000-0000-4000-8000-000000000001';
  const native: Session = { id, nativeId: id.slice(6), provider: 'codex', title: 'master', cwd: join(root, MASTER_FOLDER), project: 'fixture', status: 'idle', statusReason: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastMessage: '', messageCount: 1, isSubagent: false, resumable: true };
  let release!: () => void, entered!: () => void;
  const preparing = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const manager = new RunManager({ stateDir: root, getSession: requested => requested === id ? native : undefined, refreshSessions: async () => {}, holdUntilReady: true, findExecutable: async () => { entered(); if (wait) await held; return '/fixture/codex'; } });
  await manager.start(); t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const checkId = randomUUID();
  const guard = { checkId, sessionIds: [id], updatedAt: native.updatedAt };
  const prompt = `${MASTER_HEARTBEAT_MARK} (check ${checkId}) recommendation`;
  return { manager, native, guard, prompt, preparing, release };
}
test('heartbeat final admission is idle-only and records an agent origin without creating sessions', async t => {
  const h = await fixture(t);
  const run = await h.manager.enqueue(h.native.id, h.prompt, {}, { origin: { kind: 'agent' }, heartbeat: h.guard });
  assert.equal(run.origin?.kind, 'agent'); assert.equal(run.sessionId, h.native.id); assert.equal(h.manager.list().length, 1);
  await assert.rejects(h.manager.enqueue(h.native.id, h.prompt, {}, { origin: { kind: 'agent' }, heartbeat: h.guard }), /preconditions changed/);
  assert.equal(h.manager.list().length, 1);
});
test('native master changes during async preparation reject admission atomically', async t => {
  const h = await fixture(t, true);
  const pending = h.manager.enqueue(h.native.id, h.prompt, {}, { origin: { kind: 'agent' }, heartbeat: h.guard });
  await h.preparing; h.native.lastRequestAt = new Date().toISOString(); h.release();
  await assert.rejects(pending, /preconditions changed/); assert.equal(h.manager.list().length, 0);
});
test('heartbeat cannot enter a working native master or a non-master conversation', async t => {
  const h = await fixture(t); h.native.status = 'working';
  await assert.rejects(h.manager.enqueue(h.native.id, h.prompt, {}, { origin: { kind: 'agent' }, heartbeat: h.guard }), /preconditions changed/);
  h.native.status = 'idle'; h.native.cwd = tmpdir();
  await assert.rejects(h.manager.enqueue(h.native.id, h.prompt, {}, { origin: { kind: 'agent' }, heartbeat: h.guard }), /preconditions changed/);
  assert.equal(h.manager.list().length, 0);
});
