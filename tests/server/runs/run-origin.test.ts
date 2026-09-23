import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
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
