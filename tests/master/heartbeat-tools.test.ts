import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HeartbeatTools, HEARTBEAT_TOOLS, type HeartbeatToolContext } from '../../server/master/heartbeat-tools.js';
import { MasterSettingsStore } from '../../server/master/settings.js';
import { MASTER_FOLDER, type HeartbeatAdmission } from '../../shared/master.js';
import type { Run, Session } from '../../shared/types.js';
import type { MasterSession } from '../../server/master/session.js';
import type { TowerClient } from '../../server/tower-tools/tower-client.js';
import { CapabilityRegistry, handleMcpRequest } from '../../server/api/mcp.js';
import { runToolResolver } from '../../server/api/run-tools.js';
import { inheritedRunFields } from '../../server/runs/continuations.js';
import { CALLER_CAPABILITY_HEADER } from '../../server/runs/session-mcp.js';
async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-heartbeat-tools-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const settings = new MasterSettingsStore(dir); await settings.start(); await settings.bind({ sessionId: 'codex:master', provider: 'codex', startedAt: new Date().toISOString() });
  const at = new Date().toISOString();
  const heartbeat: HeartbeatAdmission = { checkId: randomUUID(), updatedAt: at, sessionIds: ['codex:master', 'codex:worker'], targets: [{ taskId: 'task', sessionId: 'codex:worker', nativeRequestId: 'u', latestRunId: 'worker-run' }] };
  const run: Run = { id: 'master-run', sessionId: 'codex:master', origin: { kind: 'agent' }, heartbeat, status: 'running', prompt: 'recommendation', createdAt: at, output: '' };
  const target: Session = { id: 'codex:worker', nativeId: 'worker', provider: 'codex', cwd: dir, project: 'fixture', title: 'worker', status: 'working', statusReason: '', createdAt: at, updatedAt: at, messageCount: 2, lastMessage: 'progress', isSubagent: false, resumable: true };
  const targetRun: Run = { id: 'worker-run', sessionId: target.id, createdAt: at, status: 'running', prompt: 'old work', output: '' };
  let denied = false, stopped = false, untrusted = false;
  let newer = false, nativeRequest: string | undefined, uncertain = false, nativeId = 'u';
  let remote: string | undefined;
  let readHook: ((path: string) => Promise<void>) | undefined;
  const posts: Array<Record<string, unknown>> = [], followed: unknown[] = [];
  const registry = new CapabilityRegistry(); const capability = registry.issue({ kind: 'caller-run', runId: run.id, sessionId: run.sessionId });
  const context = async (token: string) => await handleMcpRequest({ capabilities: registry, run: id => id === run.id ? run : undefined, heartbeatAllowed: () => !untrusted }, token, { method: 'heartbeat/context' }) as HeartbeatToolContext;
  const tower = { call: async (method: string, path: string, body: unknown, options: { gate?: () => Promise<boolean>; headers?: Record<string, string> }) => {
    if (method === 'GET' || path.endsWith('/permissions.overview')) await readHook?.(path);
    if (path.endsWith('/snapshot')) return { state: 'succeeded', body: { sessions: [target], runs: [targetRun, ...(newer ? [{ ...targetRun, id: 'unrelated-new-run', createdAt: new Date(Date.parse(at) + 5000).toISOString() }] : [])] } };
    if (path.includes('?limit=')) return { state: 'succeeded', body: { session: target, messages: [{ id: nativeId, role: 'user', timestamp: at, text: nativeRequest ?? targetRun.prompt }, { id: 'a', role: 'assistant', timestamp: at, text: 'x'.repeat(2000) }] } };
    if (path.endsWith('/heartbeat-protection')) return { state: 'succeeded', body: { protected: denied } };
    if (path.endsWith('/permissions.overview')) return { state: 'succeeded', body: { result: { requests: denied ? [{ sessionId: target.id, status: 'denied', decidedBy: 'owner' }] : [] } } };
    if (options.gate) await options.gate(); posts.push({ method, path, body, headers: options.headers });
    return uncertain ? { state: 'uncertain', body: {} } : { state: 'succeeded', body: { run: { ...targetRun, id: 'correction-run' } } };
  } } as unknown as TowerClient;
  const master = { heartbeatTasks: () => [{ id: 'task', runId: targetRun.id, sessionId: target.id, node: remote }], heartbeatStopped: () => stopped, started: async (...args: unknown[]) => { followed.push(args); } } as unknown as MasterSession;
  const options = { stateDir: dir, dataDir: dir, tower, settings, master, context, status: () => ({ actions: [{ checkId: heartbeat.checkId, runId: 'master-run', taskIds: ['task'], delivery: 'sent' as const, at, cause: '', evidence: '', recommendation: '' }] }) };
  const tools = new HeartbeatTools(options); await tools.start(); t.after(() => tools.close());
  return { dir, run, onRead: (hook: typeof readHook) => { readHook = hook; }, target, targetRun, newer: () => { newer = true; }, native: () => { nativeRequest = 'Owner has started another task'; }, nativeId: () => { nativeId = 'new-u'; }, uncertain: () => { uncertain = true; }, registry, capability, context, settings, tools, options, posts, followed, denied: () => { denied = true; }, stopped: () => { stopped = true; }, untrusted: () => { untrusted = true; }, remote: () => { remote = 'a'.repeat(32); heartbeat.targets![0].node = remote; } };
}
test('only verified running local heartbeat provenance grants two narrow tools; generic agent, forged prompt, remote and untrusted turns do not', async t => {
  const h = await fixture(t); const session = { ...h.target, id: h.run.sessionId, cwd: join(h.dir, MASTER_FOLDER) };
  let outside = false;
  const resolve = runToolResolver({ stateDir: h.dir, capabilities: h.registry, runs: { sessionOrigin: () => outside ? { kind: 'owner', untrustedInput: true } : undefined }, browsers: () => ({ playwright: false, claudeInChrome: false }) });
  const tools = resolve(h.run, session); assert.equal(tools.required, true); assert.deepEqual(Object.keys(tools.servers!), ['tower_master']); assert.ok(tools.servers!.tower_master.args.includes('--heartbeat'));
  assert.deepEqual(HEARTBEAT_TOOLS.map(item => item.name), ['heartbeat_read', 'heartbeat_correct']); assert.equal((await h.context(h.capability)).heartbeat.checkId, h.run.heartbeat!.checkId);
  for (const altered of [{ ...h.run, heartbeat: undefined, prompt: '[Tower heartbeat]' }, { ...h.run, origin: { kind: 'agent' as const, controllerId: 'controller' } }, { ...h.run, ownerStopped: true as const }]) assert.equal(resolve(altered, session).servers?.tower_master, undefined);
  outside = true; assert.equal(resolve(h.run, session).servers?.tower_master, undefined);
  h.untrusted(); await assert.rejects(h.context(h.capability), /reporting credential/);
  await assert.rejects(handleMcpRequest({ capabilities: h.registry, run: () => h.run }, h.capability, { method: 'tools/call', name: 'sessions_create' }), /reporting credential/);
});
test('host validates selected scope and protects stops, owner refusals, native approval and current binding', async t => {
  const h = await fixture(t);
  await assert.rejects(h.tools.call('tower_api', { taskId: 'task', path: '/api/sessions' }, h.capability), /Unknown/);
  await assert.rejects(h.tools.call('heartbeat_correct', { taskId: 'other', prompt: 'go' }, h.capability), /authority/);
  h.targetRun.approvals = [{ id: 'approval', toolName: 'approval', input: {} }]; await assert.rejects(h.tools.call('heartbeat_correct', { taskId: 'task', prompt: 'go' }, h.capability), /awaiting/); delete h.targetRun.approvals;
  h.targetRun.ownerStopped = true; await assert.rejects(h.tools.call('heartbeat_correct', { taskId: 'task', prompt: 'go' }, h.capability), /stopped/); delete h.targetRun.ownerStopped;
  h.denied(); await assert.rejects(h.tools.call('heartbeat_correct', { taskId: 'task', prompt: 'go' }, h.capability), /protected/);
  h.stopped(); await assert.rejects(h.tools.call('heartbeat_read', { taskId: 'task' }, h.capability), /authority/);
  assert.equal(h.posts.length, 0);
  const changed = await fixture(t); await changed.settings.bind({ sessionId: 'codex:other-master', provider: 'codex', startedAt: new Date().toISOString() });
  await assert.rejects(changed.tools.call('heartbeat_read', { taskId: 'task' }, changed.capability), /authority/);
  const expired = await fixture(t); expired.run.status = 'completed'; await assert.rejects(expired.context(expired.capability), /reporting credential/);
});
test('correction delegates once through the existing message/follow path and durable check-target intent survives restart', async t => {
  const h = await fixture(t); const value = await h.tools.call('heartbeat_read', { taskId: 'task' }, h.capability) as { messages: Array<{text:string}> };
  assert.equal(value.messages[1].text.length, 700);
  await Promise.all([h.tools.call('heartbeat_correct', { taskId: 'task', prompt: 'Use hosted CI for the existing work' }, h.capability), h.tools.call('heartbeat_correct', { taskId: 'task', prompt: 'Different wording must not duplicate' }, h.capability)]);
  assert.equal(h.posts.length, 1); assert.equal(h.followed.length, 1); assert.equal((h.posts[0].headers as Record<string,string>)[CALLER_CAPABILITY_HEADER], h.capability);
  const ledger = JSON.parse(await readFile(join(h.dir, 'heartbeat-corrections.json'), 'utf8')); assert.equal(ledger.intents[0].delivery, 'sent');
  const restarted = new HeartbeatTools(h.options); await restarted.start(); await restarted.call('heartbeat_correct', { taskId: 'task', prompt: 'repeat' }, h.capability); assert.equal(h.posts.length, 1);
});
test('remote correction carries only an authority-reducing marker and its own durable request ID', async t => {
  const h = await fixture(t); h.remote(); await h.tools.call('heartbeat_correct', { taskId: 'task', prompt: 'Continue existing work' }, h.capability);
  const headers = h.posts[0].headers as Record<string,string>; assert.equal(headers['X-Tower-Heartbeat-Corrective'], '1'); assert.equal(headers[CALLER_CAPABILITY_HEADER], undefined); assert.notEqual(headers['X-Tower-Request-Id'], h.run.heartbeat!.checkId);
});

test('new unrelated Tower or native owner instructions prevent a correction to the reused assignee session', async t => {
  for (const newer of ['tower', 'native', 'identical-native'] as const) {
    const h = await fixture(t); if (newer === 'tower') h.newer(); else if (newer === 'native') h.native(); else h.nativeId();
    await assert.rejects(h.tools.call('heartbeat_correct', { taskId: 'task', prompt: 'Go back to the old task' }, h.capability), /unrelated|native request/);
    assert.equal(h.posts.length, 0);
  }
});
test('uncertain corrective delivery remains claimed and is never repeated, including restart', async t => {
  const h = await fixture(t); h.uncertain();
  await h.tools.call('heartbeat_correct', { taskId: 'task', prompt: 'Continue' }, h.capability);
  const restarted = new HeartbeatTools(h.options); await restarted.start(); await restarted.call('heartbeat_correct', { taskId: 'task', prompt: 'Try another wording' }, h.capability);
  assert.equal(h.posts.length, 1); assert.equal(h.followed.length, 0);
  assert.equal(JSON.parse(await readFile(join(h.dir, 'heartbeat-corrections.json'), 'utf8')).intents[0].delivery, 'uncertain');
});

test('disable, release, close and owner stop during the final evidence read invalidate an unsent correction', async t => {
  for (const change of ['disable', 'release', 'close', 'stop'] as const) {
    const h = await fixture(t); let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    h.onRead(async path => { if (path.endsWith('/permissions.overview') && ++reads === 2) { enter(); await held; } });
    const correcting = h.tools.call('heartbeat_correct', { taskId: 'task', prompt: 'Continue' }, h.capability);
    const failure = assert.rejects(correcting);
    await entered;
    let closing: Promise<void> | undefined;
    if (change === 'disable') await h.settings.update({ heartbeat: { enabled: false } });
    if (change === 'release') await h.settings.bind(undefined);
    if (change === 'close') closing = h.tools.close();
    if (change === 'stop') h.run.ownerStopped = true;
    release(); await failure; await closing;
    assert.equal(h.posts.length, 0, change);
  }
});
test('managed update and permission continuations retain narrow heartbeat authority, root lineage and the same target intent', async t => {
  const h = await fixture(t);
  await h.tools.call('heartbeat_correct', { taskId: 'task', prompt: 'Continue' }, h.capability);
  for (const resume of ['update', 'permission'] as const) {
    const previous = { ...h.run };
    Object.assign(h.run, inheritedRunFields(previous), { id: `continuation-${resume}`, scheduled: { at: new Date().toISOString(), afterRunId: previous.id, resume } });
    assert.equal(h.run.heartbeatRootRunId, 'master-run'); assert.notEqual(h.run.heartbeat, previous.heartbeat);
    const capability = h.registry.issue({ kind: 'caller-run', runId: h.run.id, sessionId: h.run.sessionId });
    await h.tools.call('heartbeat_correct', { taskId: 'task', prompt: 'Repeated recommendation' }, capability);
    assert.equal(h.posts.length, 1);
    const session = { ...h.target, id: h.run.sessionId, cwd: join(h.dir, MASTER_FOLDER) };
    const tools = runToolResolver({ stateDir: h.dir, capabilities: h.registry, runs: { sessionOrigin: () => undefined } })(h.run, session);
    assert.deepEqual(Object.keys(tools.servers!), ['tower_master']);
  }
  h.run.heartbeatRootRunId = 'forged-root';
  const capability = h.registry.issue({ kind: 'caller-run', runId: h.run.id, sessionId: h.run.sessionId });
  await assert.rejects(h.tools.call('heartbeat_read', { taskId: 'task' }, capability), /authority/);
});
