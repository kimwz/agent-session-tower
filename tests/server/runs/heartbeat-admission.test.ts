import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RunManager } from '../../../server/runs/manager.js';
import { MASTER_FOLDER, MASTER_HEARTBEAT_MARK } from '../../../shared/master.js';
import type { Run, Session } from '../../../shared/types.js';
import { SessionService } from '../../../server/sessions/service.js';
import { startRunnerHost } from '../../../server/runs/worker.js';
import { DurableRunManager } from '../../../server/runs/durable-runner.js';
import { CapabilityRegistry } from '../../../server/api/mcp.js';
import type { TowerApi } from '../../../server/api/tower-api.js';
async function fixture(t: test.TestContext, wait = false) {
  const root = await mkdtemp(join(tmpdir(), 'tower-heartbeat-admission-'));
  const id = 'codex:10000000-0000-4000-8000-000000000001';
  const native: Session = { id, nativeId: id.slice(6), provider: 'codex', title: 'master', cwd: join(root, MASTER_FOLDER), project: 'fixture', status: 'idle', statusReason: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastMessage: '', messageCount: 1, isSubagent: false, resumable: true };
  const target: Session = { ...native, id: 'codex:10000000-0000-4000-8000-000000000002', nativeId: '10000000-0000-4000-8000-000000000002', cwd: join(root, 'work') };
  let release!: () => void, entered!: () => void;
  const preparing = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const manager = new RunManager({ stateDir: root, getSession: requested => requested === id ? native : requested === target.id ? target : undefined, refreshSessions: async () => {}, holdUntilReady: true, findExecutable: async () => { entered(); if (wait) await held; return '/fixture/codex'; } });
  await manager.start(); t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const checkId = randomUUID();
  const guard = { checkId, sessionIds: [id], updatedAt: native.updatedAt };
  const prompt = `${MASTER_HEARTBEAT_MARK} (check ${checkId}) recommendation`;
  return { manager, native, target, guard, prompt, preparing, release };
}
test('heartbeat final admission is idle-only and records an agent origin without creating sessions', async t => {
  const h = await fixture(t);
  const run = await h.manager.enqueue(h.native.id, h.prompt, {}, { origin: { kind: 'agent' }, heartbeat: h.guard });
  assert.deepEqual(run.heartbeat, h.guard); assert.notEqual(run.heartbeat, h.guard);
  assert.equal(run.origin?.kind, 'agent'); assert.equal(run.sessionId, h.native.id); assert.equal(h.manager.list().length, 1);
  assert.equal(run.heartbeatRootRunId, run.id);
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
test('local target stop, native approval or disappearance during preparation blocks heartbeat final admission', async t => {
  for (const protection of ['stop', 'approval', 'missing'] as const) {
    const h = await fixture(t, true); h.guard.sessionIds.push(h.target.id);
    const pending = h.manager.enqueue(h.native.id, h.prompt, {}, { origin: { kind: 'agent' }, heartbeat: h.guard });
    await h.preparing;
    const original = h.manager.list.bind(h.manager);
    if (protection === 'stop' || protection === 'approval') h.manager.list = () => [...original(), {
      id: 'target-run', sessionId: h.target.id, createdAt: new Date().toISOString(), prompt: 'target work', output: '',
      status: protection === 'stop' ? 'cancelled' : 'running',
      ...(protection === 'stop' ? { ownerStopped: true as const } : { approvals: [{ id: 'approval', toolName: 'native approval', input: {} }] }),
    }];
    if (protection === 'missing') h.guard.sessionIds.push('codex:missing');
    h.release(); await assert.rejects(pending, /preconditions changed/, protection); assert.equal(original().length, 0);
  }
});
test('normal working local target is eligible for master direction assessment', async t => {
  const h = await fixture(t); h.target.status = 'working'; h.guard.sessionIds.push(h.target.id);
  const run = await h.manager.enqueue(h.native.id, h.prompt, {}, { origin: { kind: 'agent' }, heartbeat: h.guard });
  assert.equal(run.sessionId, h.native.id);
});

test('heartbeat provenance is refused by create and is preserved only by validated existing-master enqueue', async t => {
  const h = await fixture(t);
  await assert.rejects(h.manager.create({ provider: 'codex', cwd: h.native.cwd, prompt: h.prompt }, { origin: { kind: 'agent' }, heartbeat: h.guard }), /cannot create/);
  assert.equal(h.manager.list().length, 0);
});

test('actual worker RPC rechecks a corrective target watermark after async preparation', async t => {
  for (const change of ['native request', 'latest run'] as const) {
    const h = await fixture(t, true);
    const sessions = new SessionService({ codexHome: join(h.native.cwd, 'fixture-codex'), claudeHome: join(h.native.cwd, 'fixture-claude') });
    sessions.list = () => [h.native, h.target];
    sessions.get = id => sessions.list().find(item => item.id === id);
    const parent: Run = { id: 'heartbeat-root', sessionId: h.native.id, prompt: h.prompt, output: '', status: 'running', createdAt: new Date().toISOString(),
      origin: { kind: 'agent' }, heartbeatRootRunId: 'heartbeat-root', heartbeat: { ...h.guard, targets: [{ taskId: 'task', sessionId: h.target.id }] } };
    const actual = h.manager.list.bind(h.manager);
    const exposed = [parent];
    h.manager.list = () => [...actual(), ...exposed];
    const capabilities = new CapabilityRegistry();
    const host = await startRunnerHost({ stateDir: h.native.cwd, sessions, runs: h.manager, capabilities, api: { heartbeatBlocked: () => false } as unknown as TowerApi });
    const client = new DurableRunManager({ stateDir: h.native.cwd });
    t.after(async () => { await client.close(); await host.close(); sessions.stop(); });
    await client.start();
    const token = capabilities.issue({ kind: 'caller-run', runId: parent.id, sessionId: parent.sessionId });
    const pending = client.enqueue(h.target.id, 'Continue the selected assignment', {}, { callerCapability: token });
    const rejected = assert.rejects(pending, /protected/);
    await h.preparing;
    if (change === 'native request') h.target.lastRequestAt = new Date().toISOString();
    else exposed.push({ id: 'new-owner-task', sessionId: h.target.id, prompt: 'A different task', output: '', status: 'completed', createdAt: new Date().toISOString() });
    h.release(); await rejected;
    assert.equal(actual().length, 0, change);
  }
});
