import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MasterHeartbeat } from '../../server/master/heartbeat.js';
import { MasterSettingsStore } from '../../server/master/settings.js';
import type { Followed, MasterSession } from '../../server/master/session.js';
import type { TowerClient } from '../../server/tower-tools/tower-client.js';
import type { AutoPromptModelRequest } from '../../server/auto-prompt/native.js';
import type { Run, Session, Snapshot } from '../../shared/types.js';
import { MASTER_HEARTBEAT_HEADER, MASTER_HEARTBEAT_MARK } from '../../shared/master.js';
const noop = { kind: 'noop', taskIds: [], evidenceIds: [], cause: 'Healthy progress', recommendation: '' };
const action = { kind: 'action', taskIds: ['task-1'], evidenceIds: ['task-1:transcript'], cause: 'Required deployment step was omitted after repeated review', recommendation: 'Ask existing assignee to use hosted CI and continue required deployment' };
async function harness(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-heartbeat-fixture-'));
  let now = Date.now(), calls = 0, stopped = false, online = true, result: unknown = noop;
  let invoke: ((request: AutoPromptModelRequest) => Promise<unknown>) | undefined;
  const settings = new MasterSettingsStore(dir); await settings.start();
  await settings.bind({ sessionId: 'codex:master', provider: 'codex', startedAt: new Date(now).toISOString() });
  const native = (id: string): Session => ({ id, nativeId: id, provider: 'codex', cwd: dir, title: id, project: 'fixture', status: 'idle', statusReason: '', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), lastMessage: 'review passed; deployment remains', messageCount: 2, isSubagent: false, resumable: true });
  const masterNative = native('codex:master'), target = native('codex:worker');
  const runs: Run[] = [{ id: 'worker-run', sessionId: target.id, createdAt: target.createdAt, prompt: 'Ship feature', output: 'Hosted CI test passed; deploy remains', status: 'running' }];
  const tasks: Followed[] = [{ id: 'task-1', kind: 'delegated', title: 'Ship feature', runId: 'worker-run', prompt: 'Implement, test, deploy', sessionId: target.id, createdAt: new Date(now).toISOString(), state: 'running' }];
  const posts: Array<{ prompt: string; headers: Record<string, string> }> = [];
  const accepted: Run[] = [];
  let modelName = 'fixture';
  let requests: Array<{sessionId: string; status: string; decidedBy?: string}> = [];
  let permissionFail = false;
  let permissionFailureTarget: string | undefined;
  let remoteProtection: boolean | undefined = false;
  let readHook: ((path: string, signal: AbortSignal) => Promise<void>) | undefined;
  let writeHook: (() => Promise<void>) | undefined;
  let captured: AutoPromptModelRequest | undefined;
  let userId = '1', userText = 'Ship feature', skipped = 0, previousUserOnly = false;
  let delivery: 'succeeded' | 'uncertain' | 'not-admitted' = 'succeeded';
  const snapshot = (): Snapshot => ({ sessions: [masterNative, target], runs, providers: [], hostname: 'fixture', version: 'fixture', scanning: false, updatedAt: new Date(now).toISOString() });
  const tower = { hasCredentials: () => online, call: async (method: string, path: string, body: { prompt: string } | undefined, options: { gate?: () => Promise<boolean>; headers?: Record<string,string>; signal?: AbortSignal }) => {
    if (options.signal) await readHook?.(path, options.signal);
    if (path.endsWith('/heartbeat-protection')) return remoteProtection === undefined ? { state: 'failed', body: {} } : { state: 'succeeded', body: { protected: remoteProtection } };
    if (path.includes('/api/nodes/') && path.endsWith('/snapshot')) return { state: 'succeeded', body: structuredClone(snapshot()) };
    if (path.endsWith('/permissions.overview') && (permissionFail || (permissionFailureTarget && (body as unknown as { cwd?: string })?.cwd === permissionFailureTarget))) return { state: 'failed', body: {} };
    if (path.endsWith('/runs.list')) return { state: 'succeeded', body: { result: { runs: structuredClone(runs) } } };
    if (path.endsWith('/permissions.overview')) return { state: 'succeeded', body: { result: { requests }  } };
    if (method === 'POST') {
      if (options.gate && !await options.gate()) return { state: 'not-admitted', status: 503 };
      posts.push({ prompt: body!.prompt, headers: options.headers! });
      await writeHook?.();
      const run: Run = { id: 'heartbeat-run', sessionId: masterNative.id, status: 'queued', origin: { kind: 'agent' }, createdAt: new Date(now).toISOString(), prompt: body!.prompt, output: '' };
      return { state: delivery, status: delivery === 'succeeded' ? 202 : 503, body: delivery === 'succeeded' ? { run } : {} };
    }
    if (path.startsWith('/api/snapshot')) return { state: 'succeeded', body: structuredClone({ ...snapshot(), runs: runs.map(run => ({ ...run, output: '' })) }) };
    const session = path.includes('codex%3Amaster') ? masterNative : target;
    const { outcome: _projection, ...nativeDetail } = session;
    const user = { id: session.id === target.id ? userId : 'master-user', role: 'user', timestamp: session.lastRequestAt ?? session.createdAt, text: session.id === target.id ? userText : 'Finish implementation, verify CI, deploy. Respect approval waits.' };
    const previous = previousUserOnly && session.id === target.id;
    return { state: 'succeeded', body: { session: structuredClone(nativeDetail), skipped, ...(previous ? { previousUser: user } : {}), messages: [...(previous ? [] : [user]), { id: '2', role: 'assistant', timestamp: session.updatedAt, text: 'Review passed but deployment remains.' }] } };
  } } as unknown as TowerClient;
  const master = { heartbeatTasks: () => structuredClone(tasks), heartbeatStopped: () => stopped, heartbeatAccepted: async (run: Run) => { accepted.push(run); } } as unknown as MasterSession;
  const options = { stateDir: dir, dataDir: dir, settings, tower, master, now: () => now, tickMs: 60_000, resolve: async () => ({ provider: 'codex' as const, model: modelName }), model: async (request: AutoPromptModelRequest) => { calls++; captured = request; return invoke ? invoke(request) : result; } };
  const heartbeat = new MasterHeartbeat(options); await heartbeat.start();
  t.after(async () => { await heartbeat.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, heartbeat, options, nativeUser: (id: string, text: string, unread = 0, previous = false) => { userId = id; userText = text; skipped = unread; previousUserOnly = previous; }, onWrite: (hook: typeof writeHook) => { writeHook = hook; }, onRead: (hook: typeof readHook) => { readHook = hook; }, model: (value: string) => { modelName = value; }, permissions: (value: typeof requests) => { requests = value; }, permissionFail: () => { permissionFail = true; }, failPermissionFor: (cwd: string) => { permissionFailureTarget = cwd; }, remoteProtection: (value: boolean | undefined) => { remoteProtection = value; }, settings, tasks, target, masterNative, runs, posts, accepted, advance: () => { now += 30 * 60_000; }, calls: () => calls, captured: () => captured, result: (value: unknown) => { result = value; }, invoke: (value: typeof invoke) => { invoke = value; }, stop: () => { stopped = true; }, offline: () => { online = false; }, delivery: (value: typeof delivery) => { delivery = value; } };
}
test('default enabled 30 minute inspection has no chat/run/voice effect on noop and bounds untrusted evidence', async t => {
  const h = await harness(t);
  assert.equal(h.settings.current().heartbeat.enabled, true); assert.equal(h.settings.current().heartbeat.intervalMinutes, 30);
  await h.heartbeat.tick(); assert.equal(h.calls(), 0);
  h.advance(); await h.heartbeat.tick();
  assert.equal(h.calls(), 1); assert.deepEqual(h.posts, []); assert.deepEqual(h.accepted, []);
  assert.equal(h.heartbeat.status().lastCheck?.state, 'noop');
  assert.ok(Buffer.byteLength(h.captured()!.prompt) < 60_000);
  assert.match(h.captured()!.systemPrompt, /UNTRUSTED DATA/); assert.equal(h.captured()!.readTools, undefined);
});
test('action uses only existing master message path and is never repeated for equivalent evidence, including restart', async t => {
  const h = await harness(t); h.result(action); h.advance(); await h.heartbeat.tick();
  assert.equal(h.posts.length, 1); assert.equal(h.accepted.length, 1);
  assert.ok(h.posts[0].prompt.startsWith(MASTER_HEARTBEAT_MARK));
  const guard = JSON.parse(h.posts[0].headers[MASTER_HEARTBEAT_HEADER]); assert.equal(guard.updatedAt, h.masterNative.updatedAt);
  assert.equal(h.heartbeat.status().actions[0].delivery, 'sent');
  h.advance(); await h.heartbeat.tick(); assert.equal(h.posts.length, 1);
  await h.heartbeat.close(); const restarted = new MasterHeartbeat(h.options); await restarted.start();
  t.after(() => restarted.close()); h.advance(); await restarted.tick(); assert.equal(h.posts.length, 1);
});
test('tick overlap joins one check, and settings changes invalidate in-flight model results', async t => {
  const h = await harness(t); let release!: (value: unknown) => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  h.invoke(async () => { entered(); return new Promise(resolve => { release = resolve; }); }); h.advance();
  const first = h.heartbeat.tick(); await started; const second = h.heartbeat.tick(); assert.equal(h.calls(), 1);
  await h.settings.update({ heartbeat: { prompt: 'new inspection constraints' } }); release(action); await Promise.all([first, second]);
  assert.equal(h.posts.length, 0); assert.equal(h.heartbeat.status().lastCheck?.state, 'interrupted');
});
test('owner stop, master busy, offline, target real approval wait and needsOwner prevent corrective messages', async t => {
  for (const protection of ['stop', 'busy', 'offline', 'approval', 'needsOwner'] as const) {
    const h = await harness(t); h.result(action);
    if (protection === 'stop') h.stop();
    if (protection === 'busy') h.masterNative.status = 'working';
    if (protection === 'offline') h.offline();
    if (protection === 'needsOwner') h.target.outcome = 'needsOwner';
    if (protection === 'approval') h.runs[0].approvals = [{ id: 'a', toolName: 'approval', input: {} }];
    h.advance(); await h.heartbeat.tick(); assert.equal(h.posts.length, 0, protection); assert.equal(h.calls(), 0, protection);
  }
});
test('strict action references reject malicious unrelated tasks and missing evidence; model failure remains internal', async t => {
  for (const invalid of [{ ...action, taskIds: ['unrelated'] }, { ...action, evidenceIds: ['fake'] }, { ...action, command: 'launch' }]) {
    const h = await harness(t); h.result(invalid); h.advance(); await h.heartbeat.tick(); assert.equal(h.posts.length, 0); assert.equal(h.heartbeat.status().lastCheck?.state, 'failed');
  }
});
test('changed progress and master watermark discard stale recommendations', async t => {
  for (const target of ['master', 'task'] as const) {
    const h = await harness(t); h.invoke(async () => { (target === 'master' ? h.masterNative : h.target).lastMessage = 'new progress'; (target === 'master' ? h.masterNative : h.target).updatedAt = new Date(Date.now() + 5000).toISOString(); return action; });
    h.advance(); await h.heartbeat.tick(); assert.equal(h.posts.length, 0); assert.equal(h.heartbeat.status().lastCheck?.state, 'skipped');
  }
});
test('uncertain delivery and interrupted saved claim are never blindly resent', async t => {
  const h = await harness(t); h.result(action); h.delivery('uncertain'); h.advance(); await h.heartbeat.tick();
  assert.equal(h.heartbeat.status().lastCheck?.state, 'uncertain'); h.advance(); await h.heartbeat.tick(); assert.equal(h.posts.length, 1);
  await h.heartbeat.close();
  const ledger = JSON.parse(await readFile(join(h.dir, 'heartbeat.json'), 'utf8')); ledger.checks.at(-1).state = 'checking'; ledger.actions[0].delivery = 'sending'; await writeFile(join(h.dir, 'heartbeat.json'), JSON.stringify(ledger));
  const restart = new MasterHeartbeat(h.options); await restart.start(); t.after(() => restart.close());
  assert.equal(restart.status().lastCheck?.state, 'interrupted'); assert.equal(restart.status().actions[0].delivery, 'uncertain'); await restart.tick(); assert.equal(h.posts.length, 1);
});
test('disable, model selection changes and corrupt ledger fail closed without a heartbeat run', async t => {
  const h = await harness(t); await h.settings.update({ heartbeat: { enabled: false } }); h.advance(); await h.heartbeat.tick(); assert.equal(h.calls(), 0);
  await h.heartbeat.close(); await writeFile(join(h.dir, 'heartbeat.json'), '{invalid');
  const restart = new MasterHeartbeat(h.options); await restart.start(); t.after(() => restart.close()); h.advance(); await restart.tick(); assert.ok(restart.status().problem); assert.equal(h.posts.length, 0);
});
test('model changes, owner stop and disable during inspection prevent stale action; model timeout is bounded', async t => {
  for (const change of ['model', 'stop', 'disable', 'failure'] as const) {
    const h = await harness(t);
    h.invoke(async () => {
      if (change === 'model') h.model('different');
      if (change === 'stop') h.stop();
      if (change === 'disable') await h.settings.update({ heartbeat: { enabled: false } });
      if (change === 'failure') throw new Error('model unavailable');
      return action;
    });
    h.advance(); await h.heartbeat.tick(); assert.equal(h.posts.length, 0, change);
  }
  const h = await harness(t); await h.heartbeat.close(); h.invoke(async () => new Promise(() => {}));
  const timeout = new MasterHeartbeat({ ...h.options, timeoutMs: 20 }); await timeout.start(); t.after(() => timeout.close()); h.advance(); await timeout.tick();
  assert.equal(timeout.status().lastCheck?.state, 'interrupted'); assert.equal(h.posts.length, 0);
});
test('Tower pending approvals and owner refusals are protected in code; unknown permission state fails closed', async t => {
  for (const protection of ['pending', 'denied', 'unknown'] as const) {
    const h = await harness(t); h.result(action);
    if (protection === 'unknown') h.permissionFail(); else h.permissions([{ sessionId: h.target.id, status: protection, decidedBy: 'owner' }]);
    h.advance(); await h.heartbeat.tick(); assert.equal(h.posts.length, 0, protection); assert.equal(h.calls(), 0, protection);
  }
  const h = await harness(t); h.target.outcome = 'blocked'; h.advance(); await h.heartbeat.tick(); assert.equal(h.calls(), 1, 'technical blocked work remains inspectable');
});
test('bounded input includes actual run output and previous evidence summaries; unrelated newer owner work is excluded', async t => {
  const h = await harness(t); h.advance(); await h.heartbeat.tick();
  assert.match(h.captured()!.prompt, /Hosted CI test passed/);
  h.advance(); await h.heartbeat.tick(); assert.match(h.captured()!.prompt, /previousObservations.*summary/);
  const calls = h.calls(); h.runs.push({ ...h.runs[0], id: 'new-owner-work', createdAt: new Date(Date.now() + 10_000).toISOString(), origin: { kind: 'owner' } });
  h.advance(); await h.heartbeat.tick(); assert.equal(h.calls(), calls);
});
test('per-task dedup survives changed selection combinations and audit history eviction', async t => {
  const h = await harness(t); h.result(action); h.advance(); await h.heartbeat.tick(); assert.equal(h.posts.length, 1);
  h.tasks.push({ ...h.tasks[0], id: 'task-2' });
  h.result({ ...action, taskIds: ['task-1', 'task-2'], evidenceIds: ['task-1:transcript', 'task-2:transcript'] });
  h.advance(); await h.heartbeat.tick(); assert.equal(h.posts.length, 1, 'same task cannot be instructed again by changing the selection');
  await h.heartbeat.close(); const ledger = JSON.parse(await readFile(join(h.dir, 'heartbeat.json'), 'utf8')); ledger.actions = []; await writeFile(join(h.dir, 'heartbeat.json'), JSON.stringify(ledger));
  const restarted = new MasterHeartbeat(h.options); await restarted.start(); t.after(() => restarted.close()); h.advance(); await restarted.tick(); assert.equal(h.posts.length, 1, 'audit eviction must not forget unchanged active task evidence');
});
test('owner stop evidence on latest tracked run and bounded six-task payload gate corrective messages', async t => {
  const h = await harness(t); h.runs[0].ownerStopped = true; h.advance(); await h.heartbeat.tick(); assert.equal(h.calls(), 0);
  delete h.runs[0].ownerStopped;
  for (let index = 2; index <= 10; index++) h.tasks.push({ ...h.tasks[0], id: `task-${index}`, prompt: 'x'.repeat(30_000), answer: 'y'.repeat(30_000) });
  h.advance(); await h.heartbeat.tick(); assert.ok(h.calls() > 0); const input = JSON.parse(h.captured()!.prompt);
  assert.ok(input.candidates.length <= 6); assert.ok(Buffer.byteLength(h.captured()!.prompt) <= 45_000);
});
test('proven non-admission has no immediate retry; later normal cadence can reassess unchanged work', async t => {
  const h = await harness(t); h.result(action); h.delivery('not-admitted'); h.advance(); await h.heartbeat.tick(); assert.equal(h.posts.length, 1);
  await h.heartbeat.tick(); assert.equal(h.posts.length, 1);
  h.delivery('succeeded'); h.advance(); await h.heartbeat.tick(); assert.equal(h.posts.length, 2); assert.equal(h.heartbeat.status().actions.at(-1)?.delivery, 'sent');
});

test('an unavailable remote candidate is excluded without preventing healthy local inspection or action', async t => {
  const h = await harness(t); h.tasks.push({ ...h.tasks[0], id: 'remote-task', node: 'remote-node' }); h.remoteProtection(undefined); h.result(action);
  h.advance(); await h.heartbeat.tick(); assert.equal(h.posts.length, 1); assert.equal(h.calls(), 1);
  assert.deepEqual(JSON.parse(h.captured()!.prompt).candidates.map((item: { id: string }) => item.id), ['task-1']);
  assert.match(h.heartbeat.status().lastCheck?.reason ?? '', /candidate identity or protection states unavailable/);
});
test('remote session protection blocks pending or refused work and admits verified unprotected evidence', async t => {
  for (const protection of [true, false]) {
    const h = await harness(t); h.tasks[0].node = 'remote-node'; h.remoteProtection(protection); h.result(action); h.advance(); await h.heartbeat.tick();
    assert.equal(h.posts.length, protection ? 0 : 1); assert.equal(h.calls(), protection ? 0 : 1);
  }
});
test('unknown protection for one local candidate excludes that task without aborting another verified task', async t => {
  const h = await harness(t); h.target.cwd = `${h.dir}/target`; h.failPermissionFor(h.target.cwd);
  h.tasks.push({ ...h.tasks[0], id: 'verified-task', node: 'remote-node' }); h.remoteProtection(false);
  h.result({ ...action, taskIds: ['verified-task'], evidenceIds: ['verified-task:transcript'] }); h.advance(); await h.heartbeat.tick();
  assert.equal(h.posts.length, 1); assert.equal(h.calls(), 1); assert.match(h.heartbeat.status().lastCheck?.reason ?? '', /candidate identity or protection states unavailable/);
});

test('deadline reached during initial evidence reads records interrupted and never invokes model or submits a message', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const read of ['snapshot', 'master-detail', 'master-protection', 'target-detail', 'target-protection', 'target-output'] as const) {
    const h = await harness(t); let reached = false; let permissions = 0;
    h.onRead(async (path, signal) => {
      if (path.endsWith('/permissions.overview')) permissions++;
      const matches = read === 'snapshot' ? path === '/api/snapshot'
        : read === 'master-detail' ? path.includes('/sessions/codex%3Amaster?')
        : read === 'master-protection' ? path.endsWith('/permissions.overview') && permissions === 1
        : read === 'target-detail' ? path.includes('/sessions/codex%3Aworker?')
        : read === 'target-protection' ? path.endsWith('/permissions.overview') && permissions === 2
        : path.endsWith('/runs.list');
      if (matches && !reached) { reached = true; t.mock.timers.tick(90_000); assert.equal(signal.aborted, true); }
    });
    h.advance(); await h.heartbeat.tick();
    assert.equal(reached, true, read); assert.equal(h.heartbeat.status().lastCheck?.state, 'interrupted', read);
    assert.equal(h.calls(), 0, read); assert.deepEqual(h.posts, [], read); assert.deepEqual(h.accepted, [], read);
    await h.heartbeat.close();
  }
});
test('deadline reached while refreshing selected evidence records interrupted and prevents action delivery', async t => {
  const h = await harness(t); h.result(action); let targetReads = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  h.onRead(async (path, signal) => {
    if (path.includes('/sessions/codex%3Aworker?') && ++targetReads === 2) { t.mock.timers.tick(90_000); assert.equal(signal.aborted, true); }
  });
  h.advance(); await h.heartbeat.tick(); assert.equal(targetReads, 2); assert.equal(h.calls(), 1);
  assert.equal(h.heartbeat.status().lastCheck?.state, 'interrupted'); assert.deepEqual(h.posts, []); assert.deepEqual(h.accepted, []);
});

test('snapshot needsOwner projection is adopted only for matching native detail evidence', async t => {
  const h = await harness(t); h.target.outcome = 'needsOwner';
  h.onRead(async path => { if (path.includes('codex%3Aworker?')) { h.target.messageCount++; h.target.lastMessage = 'new native progress after projection'; } });
  h.advance(); await h.heartbeat.tick(); assert.equal(h.calls(), 1); assert.equal(h.heartbeat.status().lastCheck?.state, 'noop');
});
test('latest snapshot model outcome is a pre-send heuristic; native changes and true stops also block', async t => {
  for (const protection of ['needsOwner', 'stop', 'approval', 'progress'] as const) {
    const h = await harness(t); h.result(action); let snapshots = 0;
    h.onRead(async path => {
      if (path === '/api/snapshot' && ++snapshots === 3) {
        if (protection === 'needsOwner') h.target.outcome = 'needsOwner';
        if (protection === 'stop') h.runs[0].ownerStopped = true;
        if (protection === 'approval') h.runs[0].approvals = [{ id: 'pending', toolName: 'approval', input: {} }];
        if (protection === 'progress') h.target.lastMessage = 'new native progress';
      }
    });
    h.advance(); await h.heartbeat.tick(); assert.equal(h.posts.length, 0, protection);
    assert.equal(h.heartbeat.status().actions[0].delivery, 'not-sent');
  }
});
test('a read that ignores abort cannot outlive the inspection deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const h = await harness(t);
  h.onRead(async path => { if (path === '/api/snapshot') { t.mock.timers.tick(90_000); await new Promise(() => {}); } });
  h.advance(); await h.heartbeat.tick(); assert.equal(h.heartbeat.status().lastCheck?.state, 'interrupted'); assert.equal(h.calls(), 0); assert.equal(h.posts.length, 0);
});
test('a pending write is bounded without cancelling or replaying it and retains uncertain evidence claims', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const h = await harness(t); h.result(action);
  h.onWrite(async () => { t.mock.timers.tick(90_000); await new Promise(() => {}); });
  h.advance(); await h.heartbeat.tick();
  assert.equal(h.posts.length, 1); assert.equal(h.heartbeat.status().lastCheck?.state, 'uncertain'); assert.equal(h.heartbeat.status().actions[0].delivery, 'uncertain');
  const saved = JSON.parse(await readFile(join(h.dir, 'heartbeat.json'), 'utf8')); assert.equal(saved.actions[0].delivery, 'uncertain'); assert.ok(saved.acted['task-1']);
  h.advance(); await h.heartbeat.tick(); assert.equal(h.posts.length, 1); assert.equal(h.accepted.length, 0);
});

test('remote final gate reuses each node snapshot and blocks its latest model outcome before sending', async t => {
  const h = await harness(t); h.tasks[0].node = 'remote-node'; h.result(action); let snapshots = 0;
  h.onRead(async path => { if (path === '/api/nodes/remote-node/snapshot' && ++snapshots === 3) h.target.outcome = 'needsOwner'; });
  h.advance(); await h.heartbeat.tick(); assert.equal(snapshots, 3); assert.equal(h.posts.length, 0); assert.equal(h.heartbeat.status().actions[0].delivery, 'not-sent');
});


test('native request identity survives queue and CLI startup delay, but excludes a separate native follow-up', async t => {
  const h = await harness(t);
  h.target.lastRequestAt = new Date(Date.parse(h.runs[0].createdAt) + 30_000).toISOString();
  h.runs[0].startedAt = new Date(Date.parse(h.runs[0].createdAt) + 25_000).toISOString();
  h.advance(); await h.heartbeat.tick(); assert.equal(h.calls(), 1);
  h.target.lastMessage = 'new progress'; h.advance(); await h.heartbeat.tick(); assert.equal(h.calls(), 2);
  h.nativeUser('new-turn', 'Ship feature'); h.advance(); await h.heartbeat.tick();
  assert.equal(h.calls(), 2, 'a newly observed identical prompt is still a separate native request');
  h.nativeUser('other-turn', 'Ship feature with a different goal'); h.advance(); await h.heartbeat.tick(); assert.equal(h.calls(), 2);
});
test('bounded previousUser and delivered steering identify the tracked native request; unread identity fails closed', async t => {
  const h = await harness(t);
  h.advance(); await h.heartbeat.tick(); assert.equal(h.calls(), 1);
  h.runs.push({ ...h.runs[0], id: 'steering-run', createdAt: new Date(Date.now() + 10_000).toISOString(), prompt: 'Use hosted CI', steering: { state: 'delivered', targetRunId: 'worker-run', requestedAt: new Date().toISOString() } });
  h.target.lastRequestAt = new Date(Date.parse(h.runs.at(-1)!.createdAt) + 5000).toISOString();
  h.nativeUser('steered-user', 'Use hosted CI', 0, true); h.advance(); await h.heartbeat.tick(); assert.equal(h.calls(), 2);
  h.nativeUser('steered-user', 'Use hosted CI', 1); h.advance(); await h.heartbeat.tick(); assert.equal(h.calls(), 2);
});
test('model role resolution shares the inspection deadline even if its local read never completes', async t => {
  const h = await harness(t); await h.heartbeat.close(); t.mock.timers.enable({ apis: ['setTimeout'] });
  const heartbeat = new MasterHeartbeat({ ...h.options, resolve: async () => { t.mock.timers.tick(90_000); return new Promise(() => {}); } });
  await heartbeat.start(); t.after(() => heartbeat.close()); h.advance(); await heartbeat.tick();
  assert.equal(heartbeat.status().lastCheck?.state, 'interrupted'); assert.equal(h.calls(), 0); assert.deepEqual(h.posts, []);
});
test('a durable ledger write drains serially after expiry; overlapping tick and close cannot race it or dispatch', async t => {
  const h = await harness(t); await h.heartbeat.close(); t.mock.timers.enable({ apis: ['setTimeout'] });
  const { writePrivateJson } = await import('../../server/stores/private-json.js');
  let hold = false, active = 0, maximum = 0, entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const heartbeat = new MasterHeartbeat({ ...h.options, write: async (path, data) => {
    active++; maximum = Math.max(maximum, active);
    if (hold) { hold = false; entered(); await blocked; }
    await writePrivateJson(path, data); active--;
  } });
  await heartbeat.start(); t.after(() => heartbeat.close()); hold = true; h.advance();
  const first = heartbeat.tick(); await started; const overlap = heartbeat.tick(); let closed = false;
  t.mock.timers.tick(90_000); const closing = heartbeat.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false); assert.equal(active, 1); assert.equal(h.calls(), 0);
  release(); await Promise.all([first, overlap, closing]);
  assert.equal(maximum, 1); assert.equal(heartbeat.status().lastCheck?.state, 'interrupted'); assert.deepEqual(h.posts, []);
  const saved = JSON.parse(await readFile(join(h.dir, 'heartbeat.json'), 'utf8')); assert.equal(saved.checks.at(-1).state, 'interrupted');
});


test('an older identical native request is not attached to a newly queued tracked run', async t => {
  const h = await harness(t); h.target.lastRequestAt = new Date(Date.parse(h.runs[0].createdAt) - 30_000).toISOString();
  h.advance(); await h.heartbeat.tick(); assert.equal(h.calls(), 0); assert.deepEqual(h.posts, []);
});

test('inspection follows a system-notice continuation and includes final target admission watermark', async t => {
  const h = await harness(t); h.result(action);
  h.target.lastRequestAt = h.target.createdAt;
  const resumed: Run = { ...h.runs[0], id: 'worker-resumed', createdAt: new Date(Date.parse(h.target.createdAt) + 1000).toISOString(), prompt: '[Tower notice] Continue after approval', scheduled: { at: h.target.createdAt, afterRunId: h.runs[0].id, resume: 'permission' } };
  h.runs[0].status = 'completed'; h.runs.push(resumed); h.tasks[0].currentRunId = resumed.id;
  h.advance(); await h.heartbeat.tick();
  assert.equal(h.posts.length, 1);
  const guard = JSON.parse(h.posts[0].headers[MASTER_HEARTBEAT_HEADER]);
  assert.equal(guard.targets[0].latestRunId, resumed.id);
  assert.equal(guard.targets[0].nativeRequestId, '1');
  assert.equal(guard.targets[0].lastRequestAt, h.target.lastRequestAt);
});
