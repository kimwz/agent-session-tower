import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RunManager } from './sql-fixture.js';
import type { Session } from '../../../shared/types.js';
import { MASTER_FOLDER } from '../../../shared/master.js';
import { SessionService } from '../../../server/sessions/service.js';
import { startRunnerHost } from '../../../server/runs/worker.js';
import { DurableRunManager } from '../../../server/runs/durable-runner.js';
import { CapabilityRegistry } from '../../../server/api/mcp.js';
import { CALLER_CAPABILITY_HEADER } from '../../../server/runs/session-mcp.js';
import { createMonitorServer } from '../../../server/http/server.js';
import { createRemoteAuthFixture } from '../../helpers/auth.js';
import type { RequestContext } from '../../../server/http/request-context.js';

test('only a request that proves it is the master is marked as sent by the master', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-master-sender-http-'));
  const { auth, cookie } = await createRemoteAuthFixture(dir);
  const contexts: Record<string, Array<RequestContext | undefined>> = { create: [], enqueue: [], api: [], autoPrompt: [] };
  const masterCredential = 'fixture-master-credential';
  const app = createMonitorServer({ port: 0, clientDir: dir, auth, master: { callerSecret: masterCredential, handle: async () => false }, backend: {
    snapshot: () => ({ sessions: [], runs: [], providers: [], scanning: false, hostname: 'fixture', version: 'fixture', updatedAt: '' }),
    detail: async () => undefined, cancel: async () => {}, subscribe: () => () => {},
    createSession: async (_input, context) => { contexts.create.push(context); return { session: { id: 'codex:new' }, run: { id: 'fixture-run' } } as never; },
    enqueue: async (_id, _prompt, _attachments, context) => { contexts.enqueue.push(context); return { id: 'fixture-run' } as never; },
    api: async (_operation, _input, context) => { contexts.api.push(context); return {}; },
    startAutoPrompt: async (_request, context) => { contexts.autoPrompt.push(context); return { id: 'fixture-job' } as never; },
  } });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.dispose(); auth.close(); await auth.flush(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const { token } = await (await fetch(`${base}/api/bootstrap`)).json();
  const post = (path: string, body: unknown, extra: Record<string, string>) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Agent-Monitor-Token': token, ...extra }, body: JSON.stringify(body) });
  const master = { 'X-Tower-Master': masterCredential };
  const prompt = () => ({ requestId: randomUUID(), provider: 'codex', prompt: 'Fixture request' });
  assert.equal((await post('/api/sessions/codex:fixture/messages', { prompt: 'Next step', sender: 'master' }, master)).status, 202);
  assert.equal(contexts.enqueue.at(-1)?.sender, 'master');
  assert.equal((await post('/api/sessions', { provider: 'codex', cwd: dir, prompt: 'New work' }, master)).status, 202);
  assert.equal(contexts.create.at(-1)?.sender, 'master');
  assert.equal((await post('/api/auto-prompts', prompt(), master)).status, 202);
  assert.equal(contexts.autoPrompt.at(-1)?.sender, 'master');
  assert.equal((await post('/api/v1/autoPrompt.submit', prompt(), master)).status, 200);
  assert.equal(contexts.api.at(-1)?.sender, 'master');
  // A heartbeat correction carries its calling turn's credential with the master's.
  assert.equal((await post('/api/sessions/codex:fixture/messages', { prompt: 'Correct course' }, { ...master, [CALLER_CAPABILITY_HEADER]: 'e'.repeat(64) })).status, 202);
  assert.equal(contexts.enqueue.at(-1)?.sender, 'master'); assert.equal(contexts.enqueue.at(-1)?.callerCapability, 'e'.repeat(64));
  // The owner's own page, a body field, a wrong credential or a local agent are never the master.
  for (const headers of [{ cookie }, {}, { cookie, 'X-Tower-Master': 'invalid' }, { cookie, 'X-Tower-Agent': 'local' }] as Record<string, string>[]) {
    assert.equal((await post('/api/sessions/codex:fixture/messages', { prompt: 'Next step', sender: 'master' }, headers)).status, 202);
    assert.equal(contexts.enqueue.at(-1)?.sender, undefined, JSON.stringify(Object.keys(headers)));
  }
});

test('the web passes the master mark to the worker with every admission', async () => {
  const manager = new DurableRunManager({ stateDir: join(tmpdir(), `tower-master-sender-${randomUUID()}`) });
  const calls: Array<[string, unknown[]]> = [];
  Object.assign(manager, { snapshot: { capabilities: ['delegation', 'origins', 'remoteOrigins', 'triggers', 'remoteTriggers', 'autoPromptTargets'], sessions: [], runs: [], nativeIds: {} },
    call: async (method: string, args: unknown[]) => { calls.push([method, args]); return {}; } });
  const admission = (method: string) => { const [, args] = calls.findLast(([name]) => name === method)!; return args.at(-1) as Record<string, unknown> | undefined; };
  const internal = { origin: { kind: 'owner' as const }, sender: 'master' as const };
  await manager.create({ provider: 'codex', cwd: '/fixture', prompt: 'New work' }, internal); assert.equal(admission('create')?.sender, 'master');
  await manager.enqueue('codex:fixture', 'Follow-up', {}, internal); assert.equal(admission('enqueue')?.sender, 'master');
  await manager.api('autoPrompt.submit', { requestId: randomUUID(), provider: 'codex', prompt: 'Work' }, internal); assert.equal(admission('api')?.sender, 'master');
  await manager.submitAutoPrompt({ requestId: randomUUID(), provider: 'codex', prompt: 'Work' }, internal); assert.equal(admission('submitAutoPrompt')?.sender, 'master');
  await manager.enqueue('codex:fixture', 'Follow-up', {}, { origin: { kind: 'owner' } }); assert.equal(admission('enqueue')?.sender, undefined);
});

test('the worker saves the master mark on the turn it admits and refuses any other value', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tower-master-sender-worker-'));
  const id = 'codex:10000000-0000-4000-8000-000000000003';
  const session: Session = { id, nativeId: id.slice(6), provider: 'codex', title: 'work', cwd: join(root, 'work'), project: 'fixture', status: 'idle', statusReason: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastMessage: '', messageCount: 1, isSubagent: false, resumable: true };
  const master: Session = { ...session, id: 'codex:10000000-0000-4000-8000-000000000004', nativeId: '10000000-0000-4000-8000-000000000004', title: 'master', cwd: join(root, MASTER_FOLDER) };
  const known = [session, master];
  const runs = new RunManager({ stateDir: root, getSession: requested => known.find(item => item.id === requested), refreshSessions: async () => {}, holdUntilReady: true, findExecutable: async () => '/fixture/codex' });
  await runs.start();
  const sessions = new SessionService({ codexHome: join(root, 'fixture-codex'), claudeHome: join(root, 'fixture-claude') });
  sessions.list = () => known;
  sessions.get = requested => sessions.list().find(item => item.id === requested);
  const host = await startRunnerHost({ stateDir: root, sessions, runs, capabilities: new CapabilityRegistry() });
  const client = new DurableRunManager({ stateDir: root });
  t.after(async () => { await client.close(); await host.close(); sessions.stop(); await runs.close(); await rm(root, { recursive: true, force: true }); });
  await client.start();
  const fromMaster = await client.enqueue(id, 'From the master', {}, { origin: { kind: 'owner' }, sender: 'master' });
  assert.equal(fromMaster.sender, 'master');
  assert.deepEqual(fromMaster.origin, { kind: 'owner' }, 'the mark changes no authority');
  assert.equal(runs.list().find(run => run.id === fromMaster.id)?.sender, 'master');
  const own = await client.enqueue(id, 'From the owner', {}, { origin: { kind: 'owner' } });
  assert.equal(own.sender, undefined);
  // The owner's words reach the master's own conversation through the master host; they stay the owner's.
  assert.equal((await client.enqueue(master.id, 'From the owner to the master', {}, { origin: { kind: 'owner' }, sender: 'master' })).sender, undefined);
  await assert.rejects(client.enqueue(id, 'Forged', {}, { origin: { kind: 'owner' }, sender: 'owner' as never }), /Invalid sender/);
});
