import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { spawn as nodeSpawn } from 'node:child_process';
import { RunManager } from '../../../server/runs/manager.js';
import type { Run, Session } from '../../../shared/types.js';

const NATIVE = '30000000-0000-4000-8000-000000000001';
const OTHER = '30000000-0000-4000-8000-000000000002';
const now = '2026-09-23T00:00:00.000Z';
const nativeSession = (nativeId: string, cwd: string): Session => ({ id: `codex:${nativeId}`, nativeId, provider: 'codex', title: 'Native', cwd, project: 'fixture',
  status: 'completed', statusReason: 'Finished', createdAt: now, updatedAt: now, lastMessage: '', messageCount: 1, isSubagent: false, resumable: true });
const createdRecord = (id: string, runId: string, cwd: string, values: Record<string, unknown> = {}) => ({
  session: { id, nativeId: '', provider: 'codex', title: 'Created', cwd, project: 'fixture', status: 'idle', statusReason: '', createdAt: now, updatedAt: now,
    lastMessage: '', messageCount: 0, isSubagent: false, resumable: false }, runId, confirmed: false, ...values });
const savedRun = (id: string, sessionId: string, values: Omit<Partial<Run>, 'origin'> & Record<string, unknown> = {}) => ({
  id, sessionId, prompt: 'Earlier work', status: 'completed', createdAt: now, finishedAt: now, output: 'done', ...values });

async function fixture(t: TestContext, saved: { created?: unknown[]; runs?: unknown[] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-run-origin-'));
  const stateDir = join(directory, 'state');
  await mkdir(stateDir, { recursive: true });
  if (saved.created) await writeFile(join(stateDir, 'created-sessions.json'), JSON.stringify(saved.created), { mode: 0o600 });
  if (saved.runs) await writeFile(join(stateDir, 'runs.json'), JSON.stringify(saved.runs), { mode: 0o600 });
  const natives = new Map([NATIVE, OTHER].map(id => [`codex:${id}`, nativeSession(id, directory)]));
  const managers: RunManager[] = [];
  const open = async () => {
    const manager = new RunManager({ stateDir, getSession: id => natives.get(id), refreshSessions: async () => {}, pollMs: 60_000,
      findExecutable: async () => '/fixture/codex',
      spawnProcess: () => { throw new Error('Provenance fixtures never launch providers.'); },
      openCodexStdio: async () => { throw new Error('Provenance fixtures never launch providers.'); } });
    await manager.start();
    managers.push(manager);
    return manager;
  };
  t.after(async () => { for (const manager of managers) await manager.close(); await rm(directory, { recursive: true, force: true }); });
  const createdFile = async () => JSON.parse(await readFile(join(stateDir, 'created-sessions.json'), 'utf8')) as Array<{ session: { id: string }; origin?: unknown }>;
  return { directory, stateDir, open, createdFile };
}

test('a new session records who created it before any provider starts', async t => {
  const f = await fixture(t);
  const manager = await f.open();
  const owner = await manager.create({ provider: 'codex', cwd: f.directory, prompt: 'Owner task' }, { origin: { kind: 'owner' } });
  const workflowId = randomUUID();
  const slack = await manager.create({ provider: 'codex', cwd: f.directory, prompt: 'Slack thread' }, { origin: { kind: 'slack', workflowId }, untrustedInput: true });
  const unmarked = await manager.create({ provider: 'codex', cwd: f.directory, prompt: 'Internal caller' });
  assert.deepEqual(owner.run.origin, { kind: 'owner' });
  const saved = new Map((await f.createdFile()).map(record => [record.session.id, record.origin]));
  assert.deepEqual(saved.get(owner.session.id), { kind: 'owner', untrustedInput: false });
  assert.deepEqual(saved.get(slack.session.id), { kind: 'slack', workflowId, untrustedInput: true });
  assert.deepEqual(saved.get(unmarked.session.id), { kind: 'unknown', untrustedInput: false });
});

test('external content marks a conversation for good, through owner follow-ups, native IDs and restarts', async t => {
  const monitorId = `codex:monitor-${randomUUID()}`;
  const runId = randomUUID();
  const f = await fixture(t, {
    created: [{ ...createdRecord(monitorId, runId, '/'), confirmed: true, session: { ...createdRecord(monitorId, runId, '/').session, nativeId: NATIVE }, origin: { kind: 'owner', untrustedInput: false } }],
    runs: [savedRun(runId, monitorId, { origin: { kind: 'owner' } })],
  });
  let manager = await f.open();
  assert.deepEqual(manager.sessionOrigin(monitorId), { kind: 'owner', untrustedInput: false });
  const workflowId = randomUUID();
  const external = await manager.enqueue(monitorId, 'Slack thread content', {}, { origin: { kind: 'slack', workflowId }, untrustedInput: true });
  assert.deepEqual(external.origin, { kind: 'slack', workflowId });
  await manager.enqueue(monitorId, 'Owner follow-up', {}, { origin: { kind: 'owner' } });
  assert.equal(manager.sessionOrigin(monitorId)?.untrustedInput, true);
  assert.equal(manager.sessionOrigin(`codex:${NATIVE}`)?.untrustedInput, true, 'the native alias is the same conversation');
  await manager.close();
  manager = await f.open();
  assert.equal(manager.sessionOrigin(monitorId)?.untrustedInput, true);
});

test('external trigger content cannot continue a conversation Tower did not create', async t => {
  const f = await fixture(t);
  const manager = await f.open();
  await assert.rejects(manager.enqueue(`codex:${OTHER}`, 'Issue body from GitHub', {}, { origin: { kind: 'trigger', triggerId: 'issues' }, untrustedInput: true }),
    /only continue a conversation Tower created/);
  assert.equal(manager.list().length, 0);
  assert.equal(manager.sessionOrigin(`codex:${OTHER}`), undefined, 'a native session stays the owner’s own conversation');
});

test('an upgrade keeps every session and run and classifies old sessions only from surviving evidence', async t => {
  const ids = Array.from({ length: 5 }, () => `codex:monitor-${randomUUID()}`);
  const runIds = Array.from({ length: 5 }, () => randomUUID());
  const slackRequest = randomUUID();
  const webRequest = randomUUID();
  const f = await fixture(t, {
    created: ids.map((id, index) => createdRecord(id, runIds[index], '/')),
    runs: [savedRun(runIds[0], ids[0]), savedRun(runIds[1], ids[1], { autoPromptId: slackRequest }), savedRun(runIds[4], ids[4], { autoPromptId: webRequest })],
  });
  const manager = await f.open();
  const classified = manager.backfillSessionOrigins({ sessionIds: new Set([ids[2]]), requestIds: new Set([slackRequest]) });
  assert.equal(classified, 5);
  assert.deepEqual(ids.map(id => manager.sessionOrigin(id)), [
    { kind: 'owner', untrustedInput: false },
    { kind: 'slack', untrustedInput: true },
    { kind: 'slack', untrustedInput: true },
    { kind: 'unknown', untrustedInput: true },
    { kind: 'owner', untrustedInput: false },
  ]);
  assert.equal(manager.backfillSessionOrigins({ sessionIds: new Set(), requestIds: new Set() }), 0, 'classification happens once');
  assert.equal(manager.list().length, 3);
  await manager.close();
  const saved = await f.createdFile();
  assert.equal(saved.length, 5);
  assert.ok(saved.every(record => record.origin));
  const restarted = await f.open();
  assert.deepEqual(ids.map(id => restarted.sessionOrigin(id)?.kind), ['owner', 'slack', 'slack', 'unknown', 'owner'], 'classified Slack sessions stay Slack after a restart');
  assert.equal(restarted.backfillSessionOrigins({ sessionIds: new Set(), requestIds: new Set() }), 0);
});

test('a session is not started when its provenance cannot be saved', async t => {
  const f = await fixture(t);
  let launches = 0;
  const manager = new RunManager({ stateDir: f.stateDir, getSession: () => undefined, refreshSessions: async () => {}, pollMs: 60_000,
    findExecutable: async () => '/fixture/codex', spawnProcess: () => { launches++; throw new Error('never'); }, openCodexStdio: async () => { launches++; throw new Error('never'); } });
  await manager.start();
  const registry = join(f.stateDir, 'created-sessions.json');
  await rm(registry, { force: true });
  await mkdir(registry);
  try {
    await assert.rejects(manager.create({ provider: 'codex', cwd: f.directory, prompt: 'Owner task' }, { origin: { kind: 'owner' } }), /Cannot save/);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(launches, 0);
  } finally {
    await rm(registry, { recursive: true, force: true });
    await manager.close().catch(() => {});
  }
});

test('a session linked to Slack work later is treated as external input even if its record says otherwise', async t => {
  const monitorId = `codex:monitor-${randomUUID()}`;
  const f = await fixture(t, { created: [createdRecord(monitorId, randomUUID(), '/', { origin: { kind: 'owner', untrustedInput: false } })] });
  const manager = await f.open();
  let linked = false;
  manager.setExternalLinkResolver(ids => linked && ids.includes(monitorId));
  assert.equal(manager.sessionOrigin(monitorId)?.untrustedInput, false);
  linked = true;
  assert.equal(manager.sessionOrigin(monitorId)?.untrustedInput, true);
  await manager.close();
  const restarted = await f.open();
  assert.equal(restarted.sessionOrigin(monitorId)?.untrustedInput, true, 'the mark outlives the ledger link that revealed it');
});

test('a damaged origin record never reads back as owner work', async t => {
  const [a, b] = [`codex:monitor-${randomUUID()}`, `codex:monitor-${randomUUID()}`];
  const runId = randomUUID();
  const f = await fixture(t, {
    created: [createdRecord(a, randomUUID(), '/', { origin: { kind: 'owner', untrustedInput: 'no' } }), createdRecord(b, randomUUID(), '/', { origin: { kind: 'root', untrustedInput: false } })],
    runs: [savedRun(runId, a, { origin: { kind: 'owner', grant: 'everything' } })],
  });
  const manager = await f.open();
  assert.deepEqual(manager.sessionOrigin(a), { kind: 'unknown', untrustedInput: true });
  assert.deepEqual(manager.sessionOrigin(b), { kind: 'unknown', untrustedInput: true });
  assert.deepEqual(manager.list().find(run => run.id === runId)?.origin, { kind: 'unknown' }, 'the run itself is kept');
});

test('trigger sessions never create folders, pre-trust only chosen folders, and run Claude in auto mode when unattended', async t => {
  const f = await fixture(t);
  const launches: string[][] = [];
  const trusted: string[] = [];
  const manager = new RunManager({ stateDir: f.stateDir, getSession: () => undefined, refreshSessions: async () => {}, pollMs: 60_000,
    findExecutable: async provider => `/fixture/${provider}`, trustWorkspace: async (_provider, cwd) => { trusted.push(cwd); },
    spawnProcess: (_file, args) => { launches.push(args); throw new Error('stop after recording arguments'); } });
  await manager.start();
  t.after(async () => { await manager.close().catch(() => {}); });
  const origin = { kind: 'trigger' as const, triggerId: 'daily', eventId: 'slot' };
  await assert.rejects(manager.create({ provider: 'claude', cwd: join(f.directory, 'missing'), prompt: 'x' }, { origin, createFolder: false }), /does not exist/);
  const untrusted = await manager.create({ provider: 'claude', cwd: f.directory, prompt: 'Scheduled work' }, { origin, createFolder: false, trustWorkspace: false, unattended: true });
  const chosen = await manager.create({ provider: 'claude', cwd: f.directory, prompt: 'Owner-chosen folder' }, { origin, createFolder: false, trustWorkspace: true });
  assert.deepEqual(trusted, [f.directory]);
  assert.equal(untrusted.run.unattended, true);
  assert.equal(chosen.run.unattended, undefined);
  assert.deepEqual(untrusted.session.launchedBy, { kind: 'trigger', triggerId: 'daily' });
  const { until } = await import('../../helpers/until.ts');
  await until(() => launches.length === 2);
  const unattendedArgs = launches.find(args => args.includes('--permission-mode'))!;
  assert.equal(unattendedArgs[unattendedArgs.indexOf('--permission-mode') + 1], 'auto');
  assert.equal(launches.filter(args => args.includes('--permission-mode')).length, 1);
  await manager.close();
});

test('a slow folder trust answer never lets the same request ID be admitted twice', async t => {
  const f = await fixture(t);
  let release!: () => void;
  const trusting = new Promise<void>(resolve => { release = resolve; });
  const manager = new RunManager({ stateDir: f.stateDir, getSession: () => undefined, refreshSessions: async () => {}, pollMs: 60_000,
    findExecutable: async provider => `/fixture/${provider}`, trustWorkspace: () => trusting,
    spawnProcess: () => { throw new Error('never launched in this test'); } });
  await manager.start();
  try {
    const autoPromptId = randomUUID();
    const first = manager.create({ provider: 'claude', cwd: f.directory, prompt: 'One' }, { autoPromptId, origin: { kind: 'owner' } });
    await new Promise(resolve => setTimeout(resolve, 20));
    await assert.rejects(manager.create({ provider: 'claude', cwd: f.directory, prompt: 'One' }, { autoPromptId, origin: { kind: 'owner' } }), { statusCode: 409 });
    release();
    await first;
    assert.equal(manager.list().filter(run => run.autoPromptId === autoPromptId).length, 1);
  } finally { await manager.close(); }
});

test('Slack and trigger work share one limit on turns running at once; owner work is never held back', async t => {
  const f = await fixture(t);
  const launches: string[] = [];
  const children: ReturnType<typeof spawnHold>[] = [];
  const manager = new RunManager({ stateDir: f.stateDir, getSession: () => undefined, refreshSessions: async () => {}, pollMs: 20,
    findExecutable: async provider => `/fixture/${provider}`,
    spawnProcess: (_file, args) => { const id = args[args.indexOf('--session-id') + 1]; launches.push(id); const child = spawnHold(id); children.push(child); return child; } });
  await manager.start();
  try {
    manager.setAutomationLimit(1);
    const { until } = await import('../../helpers/until.ts');
    const slack = await manager.create({ provider: 'claude', cwd: f.directory, prompt: 'Slack work' }, { origin: { kind: 'slack', workflowId: randomUUID() } });
    await until(() => launches.length === 1);
    const trigger = await manager.create({ provider: 'claude', cwd: f.directory, prompt: 'Trigger work' }, { origin: { kind: 'trigger', triggerId: 'daily' } });
    const owner = await manager.create({ provider: 'claude', cwd: f.directory, prompt: 'My work' }, { origin: { kind: 'owner' } });
    await until(() => launches.length === 2);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(launches, [slack.session.nativeId, owner.session.nativeId]);
    assert.match(manager.list().find(run => run.id === trigger.run.id)?.output ?? '', /limit set in Triggers/);
  } finally { for (const child of children) child.kill(); await manager.close().catch(() => {}); }
});

/** A Claude-like child that confirms its conversation and then keeps working, so the turn stays running. */
function spawnHold(sessionId: string) {
  const script = `const rl=require('node:readline').createInterface({input:process.stdin});const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
rl.on('line',line=>{const m=JSON.parse(line);if(m.type==='control_request'&&m.request.subtype==='initialize')send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}});
else if(m.type==='user'){send({type:'system',subtype:'init',session_id:${JSON.stringify(sessionId)}});}});setInterval(()=>{},1000);`;
  return nodeSpawn(process.execPath, ['-e', script], { stdio: 'pipe' });
}

test('a queued trigger run whose trigger was turned off never starts', async t => {
  const f = await fixture(t);
  let launches = 0;
  const manager = new RunManager({ stateDir: f.stateDir, getSession: () => undefined, refreshSessions: async () => {}, pollMs: 20,
    findExecutable: async provider => `/fixture/${provider}`, spawnProcess: () => { launches++; throw new Error('never'); } });
  await manager.start();
  try {
    manager.setLaunchGate(run => run.origin?.kind === 'trigger' ? 'The trigger was turned off before this run started, so it did not run.' : undefined);
    const { run } = await manager.create({ provider: 'claude', cwd: f.directory, prompt: 'Scheduled' }, { origin: { kind: 'trigger', triggerId: 'daily' } });
    const { until } = await import('../../helpers/until.ts');
    const ended = await until(() => manager.list().find(item => item.id === run.id && item.status === 'cancelled'));
    assert.match(ended.error ?? '', /turned off/);
    assert.equal(launches, 0);
  } finally { await manager.close(); }
});

test('a trigger turned off while its run is being prepared stops it before the provider starts', async t => {
  const f = await fixture(t);
  let allowed = true;
  let spawned = 0;
  const manager = new RunManager({ stateDir: f.stateDir, getSession: () => undefined, refreshSessions: async () => {}, pollMs: 20,
    // The owner turns the trigger off while Tower is still looking for the provider executable.
    findExecutable: async provider => { await new Promise(resolve => setTimeout(resolve, 30)); if (spawned === 0 && !allowed) return `/fixture/${provider}`; allowed = false; return `/fixture/${provider}`; },
    spawnProcess: () => { spawned++; throw new Error('never'); } });
  await manager.start();
  try {
    manager.setLaunchGate(run => run.origin?.kind === 'trigger' && !allowed ? 'The trigger was turned off before this run started, so it did not run.' : undefined);
    const { run } = await manager.create({ provider: 'claude', cwd: f.directory, prompt: 'Scheduled' }, { origin: { kind: 'trigger', triggerId: 'daily' } });
    const { until } = await import('../../helpers/until.ts');
    const ended = await until(() => manager.list().find(item => item.id === run.id && ['cancelled', 'error', 'running'].includes(item.status)));
    assert.equal(ended.status, 'cancelled');
    assert.equal(spawned, 0);
  } finally { await manager.close(); }
});
