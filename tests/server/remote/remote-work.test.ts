import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableRunManager } from '../../../server/runs/durable-runner.js';
import { RunManager } from '../../../server/runs/manager.js';
import { parseRunOrigin, sameOrigin } from '../../../server/runs/origin.js';
import { SessionService } from '../../../server/sessions/service.js';
import { startRunnerHost } from '../../../server/runs/worker.js';
import { runnerPaths } from '../../../server/runs/runner-protocol.js';
import { RemoteRequestLedger } from '../../../server/remote/request-ledger.js';
import { RemoteExclusionStore } from '../../../server/remote/exclusions.js';
import { AutoPromptManager } from '../../../server/auto-prompt/manager.js';
import { runToolResolver } from '../../../server/api/run-tools.js';
import { CapabilityRegistry } from '../../../server/api/mcp.js';
import type { SlackService } from '../../../server/slack/service.js';
import type { Session } from '../../../shared/types.js';

const CONTROLLER = 'controllera1b2c3d4e5f6';
const remote = { kind: 'owner' as const, controllerId: CONTROLLER };
const v7 = (tail: string) => `${Date.now().toString(16).padStart(12, '0').replace(/^(.{8})(.{4})$/, '$1-$2')}-7123-8abc-${tail}`;

test('only the owner’s own work and the agents it starts can come from a controller', () => {
  assert.deepEqual(parseRunOrigin(remote), remote);
  assert.deepEqual(parseRunOrigin({ kind: 'agent', controllerId: CONTROLLER }), { kind: 'agent', controllerId: CONTROLLER });
  for (const value of [{ kind: 'trigger', triggerId: 't', controllerId: CONTROLLER }, { kind: 'slack', workflowId: '10000000-0000-4000-8000-000000000001', controllerId: CONTROLLER },
    { kind: 'owner', controllerId: 'Not-Valid!' }, { kind: 'owner', controllerId: 42 }]) assert.equal(parseRunOrigin(value), undefined, JSON.stringify(value));
});

test('remote work is inserted only into remote work from the same controller', () => {
  assert.equal(sameOrigin(remote, remote), true);
  assert.equal(sameOrigin(remote, { kind: 'owner' }), false, 'never into a local turn with wider tools');
  assert.equal(sameOrigin({ kind: 'owner' }, remote), false);
  assert.equal(sameOrigin(remote, { kind: 'owner', controllerId: 'controllerffffffffffff' }), false);
});

test('remote turns never receive Tower’s or a coordinator’s tools, whatever conversation they reach', () => {
  const session = { id: 'codex:coordinator' } as Session;
  const slack = { sessionMcp: () => ({ tower_slack: { command: 'x', args: ['--slack-mcp', 'state', '10000000-0000-4000-8000-000000000001'], env: {} } }) } as unknown as Pick<SlackService, 'sessionMcp'>;
  const resolve = runToolResolver({ stateDir: '/state', runs: { sessionOrigin: () => ({ kind: 'owner', untrustedInput: false }) }, slack, capabilities: new CapabilityRegistry(() => true) });
  const tools = resolve({ id: 'run', sessionId: session.id, origin: remote, prompt: 'x', status: 'queued', createdAt: '', output: '' }, session);
  assert.deepEqual(tools, { required: false, towerTools: 'remote' });
});

test('a remote origin is kept with the run and the conversation across a restart', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-remote-origin-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const open = async () => {
    const manager = new RunManager({ stateDir, getSession: () => undefined, refreshSessions: async () => {}, pollMs: 60_000, findExecutable: async () => '/fixture/codex',
      spawnProcess: () => { throw new Error('No provider starts in this fixture.'); }, openCodexStdio: async () => { throw new Error('No provider starts in this fixture.'); } });
    await manager.start();
    return manager;
  };
  const first = await open();
  const created = await first.create({ provider: 'codex', cwd: stateDir, prompt: 'remote task' }, { origin: remote, trustWorkspace: false });
  await first.close();
  const second = await open();
  t.after(() => second.close());
  assert.deepEqual(second.list().find(run => run.id === created.run.id)?.origin, remote);
  assert.equal(second.sessionOrigin(created.session.id)?.controllerId, CONTROLLER);
});

async function worker(t: TestContext, coordinators: string[] = []) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-remote-worker-'));
  const stateDir = join(directory, 'state');
  const id = '10000000-0000-4000-8000-000000000001';
  const session: Session = { id: `codex:${id}`, nativeId: id, provider: 'codex', title: 'fixture', cwd: directory, project: 'fixture', status: 'idle', statusReason: '',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastMessage: '', messageCount: 1, isSubagent: false, resumable: true };
  const sessions = new SessionService({ codexHome: join(directory, 'codex'), claudeHome: join(directory, 'claude'),
    inspectProcesses: async () => ({ claude: new Map(), codex: new Set(), providerRunning: { claude: false, codex: false } }) });
  sessions.list = () => [{ ...session }];
  sessions.get = value => value === session.id ? { ...session } : undefined;
  const runs = new RunManager({ stateDir, getSession: value => sessions.get(value), refreshSessions: async () => {}, pollMs: 60_000, findExecutable: async () => '/fixture/codex',
    spawnProcess: () => { throw new Error('No provider starts in this fixture.'); }, openCodexStdio: async () => { throw new Error('No provider starts in this fixture.'); } });
  await runs.start();
  const ledger = new RemoteRequestLedger(stateDir);
  await ledger.start();
  const slack = { sessionMcp: () => undefined, coordinatorSessionIds: () => coordinators, ownerChat: async (_id: string, message: string) => message } as unknown as SlackService;
  const host = await startRunnerHost({ stateDir, sessions, runs, ledger, slack });
  const client = new DurableRunManager({ stateDir, pollMs: 10 });
  await client.start();
  const paths = await runnerPaths(stateDir);
  t.after(async () => { await client.close(); await host.close(); sessions.stop(); await runs.close(); await rm(directory, { recursive: true, force: true }); await rm(paths.directory, { recursive: true, force: true }); });
  return { session, runs, client };
}

test('the worker runs a retried remote message once and answers the retry with the same run', async t => {
  const f = await worker(t);
  const requestId = v7('000000000001');
  const first = await f.client.enqueue(f.session.id, 'hello', {}, { origin: remote, requestId });
  const again = await f.client.enqueue(f.session.id, 'hello', {}, { origin: remote, requestId });
  assert.equal(again.id, first.id);
  assert.equal(f.runs.list().filter(run => run.prompt === 'hello').length, 1);
  await assert.rejects(f.client.enqueue(f.session.id, 'hello', {}, { origin: remote }), /요청 ID/);
  assert.deepEqual(f.client.coordinators(), new Set());
});

test('the worker refuses remote work in a coordinator conversation', async t => {
  const f = await worker(t, ['codex:10000000-0000-4000-8000-000000000001']);
  await assert.rejects(f.client.enqueue(f.session.id, 'hello', {}, { origin: remote, requestId: v7('000000000002') }), (error: { statusCode?: number }) => error.statusCode === 404);
  assert.deepEqual([...f.client.coordinators() ?? []], [f.session.id]);
  assert.equal(f.runs.list().length, 0);
});

test('remote work is not sent to a worker that cannot tell it apart from local work', async () => {
  const client = new DurableRunManager({ stateDir: '/nonexistent-tower-state' });
  await assert.rejects(client.enqueue('codex:x', 'hello', {}, { origin: remote, requestId: v7('000000000003') }),
    (error: { statusCode?: number; disposition?: string }) => error.statusCode === 503 && error.disposition === 'not-admitted');
  assert.equal(client.coordinators(), undefined, 'an unknown worker cannot keep coordinator conversations private');
});



test('a worker keeps following the exclusion list the web process saves after it started', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-remote-worker-exclusions-'));
  const stateDir = join(directory, 'state');
  const folder = join(directory, 'project'), other = join(directory, 'other');
  await mkdir(folder, { recursive: true });
  await mkdir(other, { recursive: true });
  const sessions = new SessionService({ codexHome: join(directory, 'codex'), claudeHome: join(directory, 'claude'),
    inspectProcesses: async () => ({ claude: new Map(), codex: new Set(), providerRunning: { claude: false, codex: false } }) });
  const now = new Date().toISOString();
  const native = (id: string, cwd: string) => ({ id: `codex:${id}`, nativeId: id, provider: 'codex' as const, title: 't', cwd, project: 'project',
    status: 'idle' as const, statusReason: '', createdAt: now, updatedAt: now, lastMessage: '', messageCount: 1, isSubagent: false, resumable: true });
  sessions.list = () => [native('10000000-0000-4000-8000-000000000009', folder), native('10000000-0000-4000-8000-000000000010', other)];
  sessions.refresh = async () => {};
  const runs = new RunManager({ stateDir, getSession: () => undefined, refreshSessions: async () => {}, pollMs: 60_000, findExecutable: async () => '/fixture/codex',
    spawnProcess: () => { throw new Error('No provider starts in this fixture.'); }, openCodexStdio: async () => { throw new Error('No provider starts in this fixture.'); } });
  await runs.start();
  const exclusions = new RemoteExclusionStore(stateDir);
  await exclusions.start();
  const autoPrompts = new AutoPromptManager({ stateDir, runs, snapshot: () => ({ sessions: [], runs: [], providers: [], scanning: false, hostname: 'x', version: 'x', updatedAt: now }),
    detail: async () => undefined, refresh: async () => {}, model: async () => ({ directoryId: 'd1', reason: 'fits' }),
    remote: { prepare: paths => exclusions.prepare(paths), matcher: () => exclusions.matcher(), coordinators: () => new Set() } });
  await autoPrompts.start();
  const ledger = new RemoteRequestLedger(stateDir);
  await ledger.start();
  const host = await startRunnerHost({ stateDir, sessions, runs, autoPrompts, ledger, exclusions });
  const client = new DurableRunManager({ stateDir, pollMs: 10 });
  await client.start();
  const paths = await runnerPaths(stateDir);
  t.after(async () => { await client.close(); await host.close(); sessions.stop(); await autoPrompts.close(); await runs.close(); await rm(directory, { recursive: true, force: true }); await rm(paths.directory, { recursive: true, force: true }); });
  // The web process owns the list; the worker has its own copy.
  const web = new RemoteExclusionStore(stateDir);
  await web.start();
  await web.add(folder);
  await assert.rejects(client.submitAutoPrompt({ requestId: v7('000000000009'), provider: 'codex', prompt: 'go', cwd: folder }, { origin: remote, requestId: v7('000000000009') }),
    /목록에 있는 작업 폴더/);
});
