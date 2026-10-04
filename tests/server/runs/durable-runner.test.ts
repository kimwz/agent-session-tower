import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DurableRunManager } from '../../../server/runs/durable-runner.js';
import { RunManager } from '../../../server/runs/manager.js';
import { SessionService } from '../../../server/sessions/service.js';
import { startRunnerHost } from '../../../server/runs/worker.js';
import type { SlackService } from '../../../server/slack/service.js';
import { RUNNER_PROTOCOL, runnerPaths } from '../../../server/runs/runner-protocol.js';
import type { CodexBridgeOptions } from '../../../server/runs/codex-bridge.js';
import type { Session } from '../../../shared/types.js';
import { until } from '../../helpers/until.ts';
import { nativeHistory } from '../../../server/sessions/native-history.js';
import { startLegacyRunner } from './fixtures/legacy-runner.ts';
import { CapabilityRegistry } from '../../../server/api/mcp.js';
import { handoffHeld, updatePaths } from '../../../server/link/update.js';
import { runtimePaths } from '../../../server/link/service.js';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { acquireStateLock, MonitorAlreadyRunning } from '../../../server/instance/state-lock.js';
import { TriggerService, type TriggerExecutor } from '../../../server/triggers/service.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'tower-durable-fixture-'));
  const stateDir = join(directory, 'state');
  const id = '10000000-0000-4000-8000-000000000001';
  const session: Session = {
    id: `codex:${id}`, nativeId: id, provider: 'codex', title: 'Durable fixture', cwd: directory,
    project: 'fixture', status: 'idle', statusReason: 'Ready', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), lastMessage: '', messageCount: 1, isSubagent: false,
    resumable: true, activeProcess: true,
  };
  const sessions = new SessionService({ codexHome: join(directory, 'codex'), claudeHome: join(directory, 'claude'),
    inspectProcesses: async () => ({ claude: new Map(), codex: new Set(), providerRunning: { claude: false, codex: false } }),
  });
  sessions.list = () => [{ ...session }];
  sessions.get = value => value === session.id ? { ...session } : undefined;
  let bridge: Omit<CodexBridgeOptions, 'codexHome'> | undefined;
  let cancels = 0;
  let starts = 0;
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  const runs = new RunManager({ stateDir, getSession: value => sessions.get(value), refreshSessions: async () => {}, pollMs: 10,
    findExecutable: async () => '/fixture/codex',
    spawnProcess: () => { throw new Error('Native provider launch is forbidden in this fixture.'); },
    openCodexBridge: async options => {
      bridge = options;
      return { done, start: async () => { starts++; options.onStarted('fixture-turn'); },
        cancel: async () => { cancels++; options.onFinished({ status: 'cancelled' }); resolveDone(); },
        close: () => resolveDone(),
      };
    },
  });
  await runs.start();
  const host = await startRunnerHost({ stateDir, sessions, runs });
  const paths = await runnerPaths(stateDir);
  const clients: DurableRunManager[] = [];
  const connect = async () => {
    const client = new DurableRunManager({ stateDir, pollMs: 10 });
    clients.push(client);
    await client.start();
    return client;
  };
  /** Closes the clients, the fixture's own host, sessions and runs; `remove` then deletes its folders. */
  const close = async () => {
    await Promise.all(clients.map(client => client.close()));
    await host.close(); sessions.stop(); await runs.close();
  };
  const remove = async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(paths.directory, { recursive: true, force: true });
  };
  return { directory, stateDir, session, sessions, runs, host, paths, connect, starts: () => starts, cancels: () => cancels,
    output: (text: string) => { assert.ok(bridge); bridge.onOutput(text); },
    finish: () => { assert.ok(bridge); bridge.onFinished({ status: 'completed' }); resolveDone(); },
    cleanup: async () => { await close(); await remove(); },
    close, remove,
  };
}

test('UI disconnect and reconnect preserve a running provider turn and its output', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const first = await f.connect();
  const run = await first.enqueue(f.session.id, 'Continue through the Tower restart');
  await until(() => first.list().some(item => item.id === run.id && item.status === 'running'));
  assert.equal(f.starts(), 1);
  await first.close();
  f.output('Produced while the UI was disconnected.');
  assert.equal(f.cancels(), 0);
  assert.equal(f.runs.list()[0].status, 'running');

  const second = await f.connect();
  assert.equal(second.list()[0].id, run.id);
  assert.equal(second.list()[0].status, 'running');
  assert.equal(second.list()[0].output, 'Produced while the UI was disconnected.');
  assert.equal(f.starts(), 1, 'reconnecting must not submit the prompt again');
  f.finish();
  await until(() => second.list()[0]?.status === 'completed');
  assert.equal(f.cancels(), 0);
  assert.equal(second.getSession(f.session.id)?.nativeId, f.session.nativeId);
});

test('explicit cancellation after reconnect interrupts exactly the requested provider turn', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const first = await f.connect();
  const run = await first.enqueue(f.session.id, 'Wait for explicit cancellation');
  await until(() => f.starts() === 1);
  await first.close();
  assert.equal(f.cancels(), 0);
  const second = await f.connect();
  await second.cancel(run.id);
  await until(() => second.list()[0]?.status === 'cancelled');
  assert.equal(f.cancels(), 1);
  await second.close();
  assert.equal(f.cancels(), 1);
});

async function rpc(socketPath: string, token: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method: 'POST', path: '/rpc', headers: { authorization: `Bearer ${token}` } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('runner rejects unauthenticated cancellation and lifecycle method dispatch', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const client = await f.connect();
  const run = await client.enqueue(f.session.id, 'Remain running');
  await until(() => f.starts() === 1);
  const rejected = await rpc(f.host.socketPath, 'invalid', { protocol: RUNNER_PROTOCOL, method: 'cancel', args: [run.id] });
  assert.equal(rejected.status, 403);
  const token = await readFile(f.paths.token, 'utf8');
  for (const method of ['close', 'constructor', '__proto__']) {
    const response = await rpc(f.host.socketPath, token, { protocol: RUNNER_PROTOCOL, method, args: [] });
    assert.equal(JSON.parse(response.body).error.statusCode, 400);
  }
  assert.equal(f.cancels(), 0);
  assert.equal(f.runs.list()[0].status, 'running');
  f.finish();
});

test('closing the RPC host leaves the injected execution engine alive for adoption', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const client = await f.connect();
  const run = await client.enqueue(f.session.id, 'Survive connection host replacement');
  await until(() => f.starts() === 1);
  await client.close();
  await f.host.close();
  assert.equal(f.cancels(), 0);
  f.output('Still active');
  const replacement = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs });
  t.after(() => replacement.close());
  const reconnected = await f.connect();
  assert.equal(reconnected.list()[0].id, run.id);
  assert.equal(reconnected.list()[0].output, 'Still active');
  f.finish();
  await until(() => reconnected.list()[0]?.status === 'completed');
  assert.equal(f.starts(), 1);
  await reconnected.close();
  await replacement.close();
});

test('a stale client cannot send cancellation to a replacement runner instance', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const stale = await f.connect();
  const run = await stale.enqueue(f.session.id, 'Keep running across host adoption');
  await until(() => f.starts() === 1);
  await f.host.close();
  const replacement = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs });
  t.after(() => replacement.close());
  await assert.rejects(stale.cancel(run.id), /identity changed|incompatible/i);
  assert.equal(f.cancels(), 0);
  assert.equal(f.runs.list()[0].status, 'running');
  await stale.close();
  f.finish();
  await replacement.close();
});

for (const provider of ['claude', 'codex'] as const) {
  test(`detached ${provider} stdio task survives actual UI SIGTERM, retains approval, and supports explicit cancel`, { timeout: 30_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), `tower-process-${provider}-`));
    const stateDir = join(directory, 'state');
    for (const name of ['home', 'codex', 'claude']) await mkdir(join(directory, name));
    const paths = await runnerPaths(stateDir);
    const entry = fileURLToPath(new URL('./fixtures/durable-process.ts', import.meta.url));
    const ui = spawn(process.execPath, ['--import', 'tsx', entry, '--fixture-ui', stateDir], {
      env: { ...process.env, HOME: join(directory, 'home'), CODEX_HOME: join(directory, 'codex'), CLAUDE_CONFIG_DIR: join(directory, 'claude'),
        FIXTURE_PROVIDER: provider, FIXTURE_ROOT: directory },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    ui.stderr.on('data', data => { stderr += data; });
    let workerPid: number | undefined;
    let client: DurableRunManager | undefined;
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    t.after(async () => {
      await client?.close();
      if (ui.exitCode === null && ui.signalCode === null) ui.kill('SIGTERM');
      if (!workerPid && existsSync(join(directory, 'worker-pid'))) workerPid = Number(readFileSync(join(directory, 'worker-pid'), 'utf8'));
      if (workerPid && alive(workerPid)) {
        const fixtureWorkerPid = workerPid;
        process.kill(fixtureWorkerPid, 'SIGTERM');
        await until(() => !alive(fixtureWorkerPid), 5000).catch(() => { if (alive(fixtureWorkerPid)) process.kill(fixtureWorkerPid, 'SIGKILL'); });
      }
      await rm(directory, { recursive: true, force: true });
      await rm(paths.directory, { recursive: true, force: true });
    });
    await until(() => {
      if (ui.exitCode !== null || ui.signalCode !== null) throw new Error(`Fixture UI exited before ready: ${stderr}`);
      return existsSync(join(directory, 'ui-ready.json'));
    }, 15_000);
    const ready = JSON.parse(await readFile(join(directory, 'ui-ready.json'), 'utf8')) as { runId: string; sessionId: string };
    workerPid = Number(await readFile(join(directory, 'worker-pid'), 'utf8'));
    const providerPid = JSON.parse((await readFile(join(directory, 'provider-pids.jsonl'), 'utf8')).trim().split('\n')[0]).pid as number;
    assert.notEqual(workerPid, ui.pid);
    assert.equal(alive(providerPid), true);
    ui.kill('SIGTERM');
    await until(() => ui.exitCode !== null || ui.signalCode !== null);
    assert.equal(ui.exitCode, 0, stderr);
    assert.equal(alive(workerPid), true, 'detached worker must outlive the UI process');
    assert.equal(alive(providerPid), true, 'the same native stdio process must remain alive');

    client = new DurableRunManager({ stateDir, pollMs: 10 });
    await client.start();
    const resumed = client.list().find(run => run.id === ready.runId)!;
    assert.equal(resumed.status, 'running');
    assert.equal(resumed.approvals?.length, 1);
    assert.equal((await readFile(join(directory, 'provider-pids.jsonl'), 'utf8')).trim().split('\n').length, 1, 'UI reconnect must not spawn another provider');
    await client.respondToApproval(resumed.id, resumed.approvals![0].id, 'allow');
    await until(() => client!.list().find(run => run.id === resumed.id)?.status === 'completed');

    const waiting = await client.enqueue(ready.sessionId, 'hold-for-cancel');
    await until(() => {
      const active = client!.list().find(run => run.id === waiting.id);
      return active?.status === 'running' && (provider !== 'codex' || active.output.includes('fixture-holding'));
    });
    await client.cancel(waiting.id);
    await until(() => client!.list().find(run => run.id === waiting.id)?.status === 'cancelled');
    const transcript = await readFile(join(directory, 'transcript.jsonl'), 'utf8');
    if (provider === 'codex') assert.equal(transcript.split('\n').filter(line => line.includes('"method":"turn/interrupt"')).length, 1);
    assert.equal(alive(workerPid), true);
  });
}


test('Slack monitoring keeps execution worker alive without web clients until explicitly paused', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await f.host.close();
  let active = true;
  let idle = false;
  let checks = 0;
  const slack = { hasActive: () => { checks++; return active; } } as unknown as SlackService;
  const host = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs, slack, idleMs: 0, onIdle: () => { idle = true; } });
  t.after(() => host.close());
  await until(() => checks >= 1);
  assert.equal(idle, false, 'Slack owns its lifetime independently of any connected web client');
  active = false;
  await until(() => idle);
});

test('a Claude Code or Codex update in flight keeps the execution worker alive without web clients', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await f.host.close();
  let updating = true;
  let idle = false;
  let checks = 0;
  const host = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs, idleMs: 0, inFlight: () => { checks++; return updating; }, onIdle: () => { idle = true; } });
  t.after(() => host.close());
  await until(() => checks >= 2);
  assert.equal(idle, false, 'the worker keeps its lock, and a new web its way back in, until the update ends');
  updating = false;
  await until(() => idle);
});

test('only the owner’s own message can approve a Slack send; agent work and correlation IDs never can', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await f.host.close();
  const ownerMessages: string[] = [];
  const slack = {
    sessionMcp: () => undefined,
    ownerChat: async (_id: string, message: string) => { ownerMessages.push(message); return { prompt: message, instructions: '[owner receipt]' }; },
    coordinatorSessionIds: () => [],
  } as unknown as SlackService;
  const host = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs, slack });
  t.after(() => host.close());
  const client = await f.connect();
  const owner = await client.enqueue(f.session.id, '1번 보내주세요');
  // The conversation shows the owner's words; the receipt reaches the agent as instructions it cannot go without.
  assert.equal(owner.prompt, '1번 보내주세요');
  assert.equal(owner.instructions, undefined, 'the page never sees the receipt');
  assert.deepEqual(f.runs.list().find(run => run.id === owner.id) && (f.runs as unknown as { runs: Map<string, { instructions?: unknown }> }).runs.get(owner.id)?.instructions, { text: '[owner receipt]', required: true });
  assert.deepEqual(owner.origin, { kind: 'owner' });
  const agent = await client.enqueue(f.session.id, '승인합니다', {}, { origin: { kind: 'agent', runId: owner.id } });
  assert.equal(agent.prompt, '승인합니다');
  assert.deepEqual(agent.origin, { kind: 'agent', runId: owner.id });
  assert.deepEqual(ownerMessages, ['1번 보내주세요']);
});

test('the web connection cannot claim Slack or trigger origins for its requests', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const client = await f.connect();
  const workflowId = '12345678-1234-4234-8234-123456789abc';
  for (const origin of [{ kind: 'slack' as const, workflowId }, { kind: 'trigger' as const, triggerId: 'daily' }]) {
    await assert.rejects(client.enqueue(f.session.id, 'Pretend to be automation', {}, { origin }), /only admit owner or agent work/);
    await assert.rejects(client.create({ provider: 'codex', cwd: f.session.cwd, prompt: 'Pretend' }, { origin }), /only admit owner or agent work/);
  }
  assert.equal(client.list().length, 0);
  assert.equal(client.supports('origins'), true);
});

test('web reports the attached worker version and keeps requested effort on the durable run', async t => {
  const { APP_VERSION } = await import('../../../shared/app-identity.js');
  const f = await fixture(); t.after(f.cleanup);
  const client = await f.connect();
  assert.equal(client.runnerVersion(), APP_VERSION);
  const run = await client.enqueue(f.session.id, 'Think harder', { effort: 'high' });
  await until(() => client.list().some(item => item.id === run.id));
  assert.equal(client.list().find(item => item.id === run.id)?.effort, 'high');
});

test('the worker serves native conversation pages without the native file path or an attached snapshot', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const calls: unknown[][] = [];
  const messages = [{ id: 'm1', role: 'assistant' as const, text: 'From the native file', timestamp: new Date().toISOString() }];
  f.sessions.detail = async (id, before, limit) => {
    calls.push([id, before, limit]);
    return { session: { ...f.session, filePath: '/private/native.jsonl' }, messages, hasMore: true, nextBefore: 42 };
  };
  const client = await f.connect();
  assert.equal(client.supports('sessionHistory'), true);
  const history = nativeHistory(client, () => { throw new Error('A current worker must not need a web-side index.'); });
  assert.equal(history.indexing, false);
  assert.deepEqual(await history.read(f.session.nativeId, 100, 50), { messages, hasMore: true, nextBefore: 42 });
  assert.deepEqual(calls, [[f.session.nativeId, 100, 50]]);
  await assert.rejects(client.sessionHistory(''), { kind: 'invalid' });
  const token = await readFile(f.paths.token, 'utf8');
  const { instance } = JSON.parse((await rpc(f.host.socketPath, token, { protocol: RUNNER_PROTOCOL, method: 'snapshot', args: [] })).body) as { instance: string };
  const reply = JSON.parse((await rpc(f.host.socketPath, token, { protocol: RUNNER_PROTOCOL, method: 'sessionHistory', args: [f.session.nativeId, -1, 1.5], instance })).body);
  assert.equal(reply.snapshot, undefined, 'reading history does not resend engine state');
  assert.doesNotMatch(JSON.stringify(reply), /private\/native/);
  assert.deepEqual(calls.at(-1), [f.session.nativeId, undefined, undefined], 'invalid page values fall back to defaults');
});

test('a web process attached to a 1.12 worker reads conversations from its own index and never sends the missing operation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-legacy-worker-'));
  const stateDir = join(directory, 'state');
  const session: Session = { id: 'codex:legacy', nativeId: 'legacy', provider: 'codex', title: 'Legacy', cwd: directory, project: 'fixture', status: 'idle',
    statusReason: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastMessage: '', messageCount: 1, isSubagent: false, resumable: true };
  const legacy = await startLegacyRunner(stateDir, { runs: [], sessions: [session], nativeIds: { [session.id]: session.nativeId }, settled: [], autoPrompts: [] });
  const client = new DurableRunManager({ stateDir, pollMs: 10, workerEntry: '/nonexistent/must-not-spawn.js', startupTimeoutMs: 1000 });
  t.after(async () => { await client.close(); await legacy.close(); await rm(directory, { recursive: true, force: true }); await rm(legacy.directory, { recursive: true, force: true }); });
  await client.start();
  assert.equal(client.runnerVersion(), '1.12.3');
  assert.equal(client.supports('sessionHistory'), false);
  const messages = [{ id: 'm1', role: 'user' as const, text: 'Indexed by the web process', timestamp: new Date().toISOString() }];
  let indexes = 0, started = 0, stopped = 0;
  const index = { detail: async () => ({ session: { ...session, filePath: '/private/legacy.jsonl' }, messages, hasMore: false }),
    start: async () => { started++; }, stop: () => { stopped++; } } as unknown as SessionService;
  const history = nativeHistory(client, () => { indexes++; return index; });
  assert.equal(indexes, 1);
  assert.equal(history.indexing, true);
  await history.start();
  assert.equal(started, 1);
  assert.equal(history.indexing, false);
  assert.deepEqual(await history.read(session.nativeId, undefined, 60), { messages, hasMore: false });
  history.stop();
  assert.equal(stopped, 1);
  assert.ok(!legacy.methods.includes('sessionHistory'), `sent: ${legacy.methods.join(', ')}`);
  // Why the capability check exists: the old worker rejects the operation outright.
  await assert.rejects(client.sessionHistory(session.nativeId), { kind: 'invalid', message: 'Unknown runner operation.' });
});

test('an outdated worker is only given the owner’s own requests, never work on anyone else’s behalf', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-legacy-origin-'));
  const stateDir = join(directory, 'state');
  const session: Session = { id: 'codex:legacy', nativeId: 'legacy', provider: 'codex', title: 'Legacy', cwd: directory, project: 'fixture', status: 'idle',
    statusReason: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastMessage: '', messageCount: 1, isSubagent: false, resumable: true };
  const legacy = await startLegacyRunner(stateDir, { runs: [], sessions: [session], nativeIds: { [session.id]: session.nativeId }, settled: [], autoPrompts: [] });
  const client = new DurableRunManager({ stateDir, pollMs: 10, workerEntry: '/nonexistent/must-not-spawn.js', startupTimeoutMs: 1000 });
  t.after(async () => { await client.close(); await legacy.close(); await rm(directory, { recursive: true, force: true }); await rm(legacy.directory, { recursive: true, force: true }); });
  await client.start();
  assert.equal(client.supports('origins'), false);
  const agent = { kind: 'agent' as const, runId: '12345678-1234-4234-8234-123456789abc' };
  await assert.rejects(client.enqueue(session.id, '1번 보내주세요', {}, { origin: agent }), { kind: 'conflict', message: /outdated/ });
  await assert.rejects(client.create({ provider: 'codex', cwd: directory, prompt: 'Agent task' }, { origin: agent }), /outdated/);
  await assert.rejects(client.submitAutoPrompt({ requestId: '12345678-1234-4234-8234-123456789abd', provider: 'codex', prompt: 'Agent task' }, { origin: agent }), /outdated/);
  const caller = { callerCapability: 'a'.repeat(64) };
  await assert.rejects(client.enqueue(session.id, 'Tracked work', {}, caller), /cannot yet track/);
  await assert.rejects(client.create({ provider: 'codex', cwd: directory, prompt: 'Tracked work' }, caller), /cannot yet track/);
  await assert.rejects(client.submitAutoPrompt({ requestId: '12345678-1234-4234-8234-123456789abe', provider: 'codex', prompt: 'Tracked work' }, caller), /cannot yet track/);
  await assert.rejects(client.api('autoPrompt.submit', {}, caller), /not updated/);
  assert.deepEqual(legacy.methods.filter(method => method !== 'snapshot'), []);
  await client.enqueue(session.id, 'Owner message', {}, { origin: { kind: 'owner' } });
  assert.deepEqual(legacy.methods.filter(method => method !== 'snapshot'), ['enqueue']);
});

test('an older worker refuses attachment references before RPC while accepting legacy inline uploads', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-legacy-attachments-'));
  const stateDir = join(directory, 'state');
  const legacy = await startLegacyRunner(stateDir, { runs: [], sessions: [], nativeIds: {}, settled: [], autoPrompts: [] });
  const client = new DurableRunManager({ stateDir, pollMs: 10, workerEntry: '/nonexistent/must-not-spawn.js', startupTimeoutMs: 1000 });
  t.after(async () => { await client.close(); await legacy.close(); await rm(directory, { recursive: true, force: true }); await rm(legacy.directory, { recursive: true, force: true }); });
  await client.start();
  assert.equal(client.supports('attachmentReferences'), false);
  const attachmentIds = ['12345678-1234-4234-8234-123456789abc'];
  const input = { provider: 'codex' as const, cwd: directory, prompt: '', attachmentIds };
  await assert.rejects(client.create(input), { kind: 'unavailable', disposition: 'not-admitted' });
  await assert.rejects(client.enqueue('codex:legacy', '', { attachmentIds }), { kind: 'unavailable', disposition: 'not-admitted' });
  await assert.rejects(client.submitAutoPrompt({ ...input, requestId: '12345678-1234-4234-8234-123456789abd' }), { kind: 'unavailable', disposition: 'not-admitted' });
  assert.deepEqual(legacy.methods.filter(method => method !== 'snapshot'), []);
  await client.enqueue('codex:legacy', '', { attachments: [{ name: 'a.txt', mimeType: 'text/plain', data: 'YQ==' }] });
  assert.deepEqual(legacy.methods.filter(method => method !== 'snapshot'), ['enqueue']);
});

test('a web Auto Prompt is admitted as the owner’s request but never read as Slack send approval', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await f.host.close();
  const ownerMessages: string[] = [];
  const submitted: unknown[] = [];
  const slack = { sessionMcp: () => undefined, coordinatorSessionIds: () => [], ownerChat: async (_id: string, message: string) => { ownerMessages.push(message); return message; } } as unknown as SlackService;
  const { EventEmitter } = await import('node:events');
  const autoPrompts = Object.assign(new EventEmitter(), {
    list: () => [], updateContext: () => {}, cancel: async () => { throw new Error('unused'); },
    submit: async (input: { requestId: string; provider: 'codex'; prompt: string }, internal: unknown) => {
      submitted.push(internal);
      return { id: input.requestId, provider: input.provider, prompt: input.prompt, routerModel: 'gpt', status: 'queued' as const, createdAt: '', updatedAt: '' };
    },
  }) as unknown as import('../../../server/auto-prompt/manager.js').AutoPromptManager;
  const host = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs, slack, autoPrompts });
  t.after(() => host.close());
  const client = await f.connect();
  await client.submitAutoPrompt({ requestId: '12345678-1234-4234-8234-123456789abc', provider: 'codex', prompt: '1번 보내주세요' });
  assert.deepEqual(submitted, [{ origin: { kind: 'owner' } }]);
  assert.deepEqual(ownerMessages, []);
});

test('an outdated worker hands off only when nothing is running, and the web follows its successor', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await f.host.close();
  const successors: Array<{ execPath: string; args: string[] }> = [];
  let successor: Awaited<ReturnType<typeof startRunnerHost>> | undefined;
  let handoffs = 0;
  let credentialAtSpawn: boolean | undefined;
  let carried: string | undefined;
  const first = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs,
    quiesce: async () => { handoffs++; },
    handoffCarry: () => Buffer.from('open vault'),
    startSuccessor: (command, nonce, carry) => {
      successors.push(command); carried = carry?.toString();
      credentialAtSpawn = existsSync(f.paths.token);
      void startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs, handoffNonce: nonce }).then(host => { successor = host; });
    } });
  t.after(async () => { await first.close(); await successor?.close(); });
  const client = await f.connect();
  const run = await client.enqueue(f.session.id, 'Keep working through the deploy');
  await until(() => f.starts() === 1);
  assert.equal(await client.requestHandoff(true), true);
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(handoffs, 0, 'a running turn keeps the old worker in service');
  assert.equal(existsSync(join(f.stateDir, 'runner-runtime', 'handoff.json')), false);
  f.finish();
  await until(() => successors.length === 1 && successor);
  assert.equal(handoffs, 1);
  assert.equal(credentialAtSpawn, false, 'the old worker removed its own credential before the successor could write one');
  assert.deepEqual(successors[0].args.slice(-2), ['--runner-worker', f.paths.stateDir]);
  assert.equal(carried, 'open vault', 'the successor is started with the state only it may receive');
  await until(() => client.list().some(item => item.id === run.id) && client.supports('handoff') && (client as unknown as { snapshot: { instance: string } }).snapshot.instance === successor!.instance);
  const after = await client.enqueue(f.session.id, 'Sent after the handoff');
  assert.equal(after.origin?.kind, 'owner');
});

test('updating on request stops the running turn at the deadline, hands off, and leaves its continuation queued', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await f.host.close();
  let handoffs = 0;
  let successorStarted = 0;
  const host = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs, quiesce: async () => { handoffs++; }, startSuccessor: () => { successorStarted++; } });
  t.after(() => host.close());
  const client = new DurableRunManager({ stateDir: f.stateDir, pollMs: 10, version: '99.0.0' });
  t.after(() => client.close());
  await client.start();
  const run = await client.enqueue(f.session.id, 'Long work');
  await until(() => f.starts() === 1 && client.list().some(item => item.id === run.id && item.status === 'running'));
  const answer = await client.forceUpdate(300);
  assert.ok(Date.parse(answer.deadline) > Date.now() - 1000);
  await until(() => client.updateDrain() !== undefined);
  const queued = await client.enqueue(f.session.id, 'Sent while updating');
  await until(() => f.cancels() === 1 && successorStarted === 1, 5000);
  assert.equal(handoffs, 1);
  const read = () => JSON.parse(readFileSync(join(f.stateDir, 'runs.json'), 'utf8')) as Array<Record<string, any>>;
  // This fixture's quiesce does not flush; the real one waits for the save.
  await until(() => read().find(item => item.id === run.id)?.error !== undefined);
  const saved = read();
  const stopped = saved.find(item => item.id === run.id)!;
  assert.equal(stopped.status, 'cancelled');
  assert.match(stopped.error, /Tower update/);
  const resume = saved.find(item => item.scheduled?.resume === 'update');
  assert.equal(resume?.status, 'queued');
  assert.equal(resume?.scheduled.afterRunId, run.id);
  const carried = saved.find(item => item.id === queued.id)!;
  assert.equal(carried.status, 'queued');
  assert.equal(carried.keepQueued, true, 'the next worker keeps it queued');
});

test('updating on request is refused while the worker already runs this version', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const client = await f.connect();
  await assert.rejects(client.forceUpdate(), { kind: 'conflict' });
});

test('while an update of this computer is being tried, the new web does not take the worker over', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await f.host.close();
  let handoffs = 0;
  let handedOff = false;
  const host = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs, quiesce: async () => { handoffs++; }, startSuccessor: () => {}, onHandedOff: () => { handedOff = true; } });
  let held = true;
  const client = new DurableRunManager({ stateDir: f.stateDir, pollMs: 10, version: '99.0.0', handoffHeld: async () => held });
  // Closed here, before the fixture's own cleanup removes the folder they write to.
  try {
    await client.start();
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(handoffs, 0, 'going back to the previous version must still find the previous worker');
    held = false;
    await until(() => handedOff);
    assert.equal(handoffs, 1);
  } finally { await client.close(); await host.close(); }
});

test('while an update is verified, a restore or an update on request is refused with the verification message', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const client = new DurableRunManager({ stateDir: f.stateDir, pollMs: 10, version: '99.0.0', handoffHeld: async () => true });
  try {
    await client.start();
    await assert.rejects(client.restartWorker(), { kind: 'conflict', message: /still verifying/ });
    await assert.rejects(client.forceUpdate(), { kind: 'conflict', message: /still verifying/ });
  } finally { await client.close(); }
});

test('a hold that cannot be checked keeps the worker until the check works again', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await f.host.close();
  let handoffs = 0;
  let handedOff = false;
  // Quiesce runs before the handoff record is written; only onHandedOff says the worker has stopped writing here.
  const host = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs, quiesce: async () => { handoffs++; }, startSuccessor: () => {}, onHandedOff: () => { handedOff = true; } });
  let unreadable = true;
  const client = new DurableRunManager({ stateDir: f.stateDir, pollMs: 10, version: '99.0.0', handoffHeld: async () => { if (unreadable) throw new Error('ELOOP: too many symbolic links'); return false; } });
  try {
    await client.start();
    // The worker looks at a handoff request once a second.
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(handoffs, 0, 'whether an update is still tried cannot be told, so the previous worker stays');
    unreadable = false;
    await until(() => handedOff);
    assert.equal(handoffs, 1);
  } finally { await client.close(); await host.close(); }
});

test('with a live helper and a hold unreadable past 15 minutes, automatic handoff, restore and update on request are all refused, across a web restart', async t => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'log', () => {});
  const f = await fixture(); t.after(f.cleanup);
  await f.host.close();
  let handoffs = 0;
  let successors = 0;
  const run = await f.runs.enqueue(f.session.id, 'Keeps running while the hold cannot be read');
  await until(() => f.starts() === 1);
  let handedOff = false;
  const host = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs, quiesce: async () => { handoffs++; }, startSuccessor: () => { successors++; }, onHandedOff: () => { handedOff = true; } });
  const { hold, lock } = updatePaths(f.stateDir);
  await mkdir(runtimePaths(f.stateDir).root, { recursive: true });
  await symlink(hold, hold);
  await writeFile(lock, String(process.pid));
  const web = () => new DurableRunManager({ stateDir: f.stateDir, pollMs: 10, version: '99.0.0', handoffHeld: () => handoffHeld(f.stateDir, Date.now() + 16 * 60_000) });
  let client = web();
  try {
    await client.start();
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(handoffs, 0);
    await assert.rejects(client.restartWorker(), { kind: 'conflict', message: /could not check/ });
    await assert.rejects(client.forceUpdate(), { kind: 'conflict', message: /could not check/ });
    await client.close();
    client = web();
    await client.start();
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(handoffs, 0, 'a new web attached meanwhile does not take the worker either');
    assert.equal(successors, 0);
    assert.equal(f.cancels(), 0, 'the running turn is untouched');
    assert.equal(f.runs.list().find(item => item.id === run.id)?.status, 'running');
    await rm(hold);
    await rm(lock);
    f.finish();
    await until(() => handedOff);
    assert.equal(handoffs, 1);
  } finally { await client.close(); await host.close(); }
});

test('a worker newer than this web, left by an update that was undone, is not handed back to it', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await f.host.close();
  let handoffs = 0;
  const host = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs, quiesce: async () => { handoffs++; }, startSuccessor: () => {} });
  const client = new DurableRunManager({ stateDir: f.stateDir, pollMs: 10, version: '0.0.1' });
  try {
    await client.start();
    assert.equal(await client.requestHandoff(), false);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(handoffs, 0);
  } finally { await client.close(); await host.close(); }
});

test('a worker that has to start while an update is tried is the previous version’s', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-held-worker-'));
  const stateDir = join(directory, 'state');
  const spawned: Array<{ execPath: string; args: string[] }> = [];
  const client = new DurableRunManager({ stateDir, startupTimeoutMs: 200, heldWorkerEntry: async () => '/versions/1.0.0/bin/tower.mjs', spawn: command => spawned.push(command) });
  t.after(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); await rm((await runnerPaths(stateDir)).directory, { recursive: true, force: true }); });
  await assert.rejects(client.start());
  assert.deepEqual(spawned.map(command => command.args), [['/versions/1.0.0/bin/tower.mjs', '--runner-worker', await realpath(stateDir)]]);
});

test('requests that arrive while the worker hands off are refused, never half-accepted', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await f.host.close();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  let handedOff = false;
  const host = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs,
    quiesce: async () => { entered = true; await gate; }, startSuccessor: () => { handedOff = true; } });
  t.after(() => host.close());
  const client = await f.connect();
  await client.requestHandoff(true);
  await until(() => entered);
  await assert.rejects(client.enqueue(f.session.id, 'Arrives mid-handoff'), { kind: 'unavailable', disposition: 'handoff' });
  const token = await readFile(f.paths.token, 'utf8');
  const tool = JSON.parse((await rpc(f.paths.socket, token, { protocol: RUNNER_PROTOCOL, method: 'slackTool', args: ['workflow', 'slack_send', { text: 'hi' }] })).body);
  assert.equal(tool.error.disposition, 'handoff', 'coordinator tool calls are refused too');
  assert.equal(f.runs.list().length, 0);
  release();
  await until(() => handedOff);
});

test('a stale handoff record never lets some other worker take over', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await f.host.close();
  let other: Awaited<ReturnType<typeof startRunnerHost>> | undefined;
  const first = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs, quiesce: async () => {},
    // A different worker starts instead of the one this worker recorded.
    startSuccessor: () => { void startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs, handoffNonce: 'f'.repeat(32) }).then(host => { other = host; }); } });
  t.after(async () => { await first.close(); await other?.close(); });
  const client = await f.connect();
  await client.requestHandoff(true);
  await until(() => other);
  await assert.rejects(client.enqueue(f.session.id, 'To an unproven worker'), { incompatible: true });
  assert.equal(f.runs.list().length, 0);
});

test('a handoff that cannot be recorded leaves the worker fully in service', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await f.host.close();
  await mkdir(join(f.paths.runtime, 'handoff.json'), { recursive: true });
  let quiesced = 0, resumed = 0, started = 0;
  const host = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs,
    quiesce: async () => { quiesced++; }, resume: () => { resumed++; }, startSuccessor: () => { started++; } });
  t.after(() => host.close());
  const client = await f.connect();
  await client.requestHandoff(true);
  await until(() => resumed >= 1);
  assert.equal(started, 0);
  assert.ok(quiesced >= 1);
  const run = await client.enqueue(f.session.id, 'Still accepted');
  assert.equal(run.status, 'queued');
});

test('a handoff record that cannot be flushed to disk leaves the worker fully in service', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await f.host.close();
  // Test-only: syncing the handoff record's temporary file fails, as on a disk error.
  const original = fsPromises.open;
  const record = join(f.paths.runtime, 'handoff.json');
  let failedSyncs = 0;
  t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof original>) => {
    const handle = await original(...args);
    if (String(args[0]).startsWith(`${record}.`) && String(args[0]).endsWith('.tmp')) handle.sync = async () => { failedSyncs++; throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' }); };
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(console, 'error', () => {});
  let quiesced = 0, resumed = 0, started = 0;
  const host = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs,
    quiesce: async () => { quiesced++; }, resume: () => { resumed++; }, startSuccessor: () => { started++; } });
  t.after(() => host.close());
  const client = await f.connect();
  await client.requestHandoff(true);
  await until(() => resumed >= 1);
  assert.equal(failedSyncs, 1);
  assert.equal(started, 0, 'no successor is started without a durable record');
  assert.ok(quiesced >= 1);
  assert.equal(existsSync(record), false);
  const run = await client.enqueue(f.session.id, 'Still accepted');
  assert.equal(run.status, 'queued');
  await until(() => f.starts() === 1);
  assert.equal(f.cancels(), 0);
});

test('the web starts a worker itself when a handed-off successor never answers', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await f.host.close();
  let replacement: Awaited<ReturnType<typeof startRunnerHost>> | undefined;
  const first = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs, quiesce: async () => {}, startSuccessor: () => {} });
  t.after(async () => { await first.close(); await replacement?.close(); });
  const spawned: string[][] = [];
  const client = new DurableRunManager({ stateDir: f.stateDir, pollMs: 20, successorTimeoutMs: 200,
    spawn: command => { spawned.push(command.args); void startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs }).then(host => { replacement = host; }); } });
  t.after(() => client.close());
  await client.start();
  await client.requestHandoff(true);
  await until(() => replacement && (client as unknown as { snapshot?: { instance: string } }).snapshot?.instance === replacement.instance, 10_000);
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].slice(-2), ['--runner-worker', f.paths.stateDir]);
});

test('a worker change without a recorded handoff still requires a restart', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const client = await f.connect();
  await f.host.close();
  const replacement = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs });
  t.after(() => replacement.close());
  await assert.rejects(client.enqueue(f.session.id, 'Unexplained worker'), { incompatible: true });
  assert.equal(f.runs.list().length, 0);
});

test('a handoff that waits too long only holds new automatic work; running turns continue', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await f.host.close();
  let holds = 0;
  const host = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs, handoffHoldMs: 0,
    holdIntake: () => { holds++; }, quiesce: async () => {}, startSuccessor: () => { handedOff = true; } });
  let handedOff = false;
  t.after(() => host.close());
  const client = await f.connect();
  await client.enqueue(f.session.id, 'Long turn');
  await until(() => f.starts() === 1);
  await client.requestHandoff(true);
  await until(() => holds === 1);
  assert.equal(f.runs.list()[0].status, 'running');
  assert.equal(f.cancels(), 0);
  f.finish();
  await until(() => handedOff);
});

test('a handoff asked only so a new worker reads settings again (a restore) never holds new work, however long it waits', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await f.host.close();
  let holds = 0;
  let handedOff = false;
  const host = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs, handoffHoldMs: 0,
    holdIntake: () => { holds++; }, quiesce: async () => {}, startSuccessor: () => { handedOff = true; } });
  t.after(() => host.close());
  const client = await f.connect();
  await client.enqueue(f.session.id, 'Long turn');
  await until(() => f.starts() === 1);
  assert.equal(await client.restartWorker(), true);
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(holds, 0);
  assert.equal(f.runs.list()[0].status, 'running');
  f.finish();
  await until(() => handedOff);
  assert.equal(f.cancels(), 0);
});

test('an ordinary handoff asked after a patient one waits its own long hold from when it is asked', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await f.host.close();
  let holds = 0;
  const host = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs, handoffHoldMs: 1500,
    holdIntake: () => { holds++; }, quiesce: async () => {}, startSuccessor: () => {} });
  t.after(() => host.close());
  const client = await f.connect();
  await client.enqueue(f.session.id, 'Long turn');
  await until(() => f.starts() === 1);
  await client.restartWorker();
  await new Promise(resolve => setTimeout(resolve, 2000));
  await client.requestHandoff(true);
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(holds, 0, 'not held at once for the time the patient request waited');
  await until(() => holds === 1);
  f.finish();
});

test('a turn that is still closing its provider keeps the old worker, whatever its status says', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await f.host.close();
  let closing = true;
  const busy = f.runs.busy.bind(f.runs);
  f.runs.busy = () => closing || busy();
  let started = 0;
  const host = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs, quiesce: async () => {}, startSuccessor: () => { started++; } });
  t.after(() => host.close());
  const client = await f.connect();
  await client.requestHandoff(true);
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(started, 0);
  closing = false;
  await until(() => started === 1);
});

/**
 * A worker with the production idle shutdown (onIdle, idleMs 0) and a real state lock, released through
 * releaseStateLock as the production worker does. `events` records each lifecycle step in order.
 */
async function idleWorker(f: Awaited<ReturnType<typeof fixture>>, options: Partial<Parameters<typeof startRunnerHost>[0]> = {}) {
  await f.host.close();
  const events: string[] = [];
  /** Per release, whether the handoff record was already on disk. */
  const recordAtRelease: boolean[] = [];
  const lock = await acquireStateLock(f.paths.runtime, 0);
  const host = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs, idleMs: 0,
    releaseStateLock: async () => { recordAtRelease.push(existsSync(join(f.paths.runtime, 'handoff.json'))); await lock(); events.push('release'); },
    onIdle: async () => { events.push('onIdle'); }, ...options });
  // A newer web asks for the handoff and goes away (a web replaced during an update), so nothing keeps the worker busy.
  const ask = async () => { const client = new DurableRunManager({ stateDir: f.stateDir, pollMs: 10, version: '99.0.0' }); await client.start(); await client.close(); };
  /**
   * Ends this worker before the fixture folder goes, whatever point a test stopped at: test gates opened, every handoff
   * attempt that paused finished or resumed (an earlier attempt's resume does not end a later one), then the worker
   * closed (a no-op when a handoff or idle shutdown already closes it) and its lock released. host.close() alone does
   * not wait for a close already under way, so the release is awaited.
   */
  const settle = async (...gates: Array<() => void>) => {
    for (const open of gates) open();
    // Each handoff attempt that paused ends with either a handoff or a resume; wait until every one has ended.
    const count = (name: string) => events.filter(event => event === name).length;
    await until(() => count('quiesce') === count('onHandedOff') + count('resume'));
    // Synchronous with the check above: a handoff not yet started finds the worker closing and never starts.
    await host.close();
    await until(() => events.includes('release'));
  };
  return { events, recordAtRelease, host, ask, settle };
}

test('an idle tick never closes a worker whose handoff is pausing: the state stays locked until the record is durable', { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.cleanup);
  let open!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  let atSuccessor: { record: boolean; socket: boolean; token: boolean; released: boolean } | undefined;
  let other: (() => Promise<void>) | undefined;
  const w = await idleWorker(f, {
    quiesce: async () => { w.events.push('quiesce'); await gate; w.events.push('quiesced'); },
    startSuccessor: () => {
      atSuccessor = { record: existsSync(join(f.paths.runtime, 'handoff.json')), socket: existsSync(f.paths.socket), token: existsSync(f.paths.token), released: w.events.includes('release') };
      w.events.push('startSuccessor');
    },
    onHandedOff: () => { w.events.push('onHandedOff'); } });
  try {
    await w.ask();
    await until(() => w.events.includes('quiesce'));
    // Two idle ticks pass while the handoff is pausing.
    await new Promise(resolve => setTimeout(resolve, 2200));
    assert.deepEqual(w.events, ['quiesce'], 'no idle shutdown and no lock release while the handoff owns shutdown');
    await assert.rejects(acquireStateLock(f.paths.runtime, 0).then(release => { other = release; }), MonitorAlreadyRunning);
    open();
    await until(() => w.events.includes('onHandedOff'));
    assert.deepEqual(w.events, ['quiesce', 'quiesced', 'release', 'startSuccessor', 'onHandedOff']);
    assert.deepEqual(atSuccessor, { record: true, socket: false, token: false, released: true }, 'the record is durable and the endpoint closed before the successor starts');
    // From here the successor may take the state.
    other = await acquireStateLock(f.paths.runtime, 0);
  } finally {
    await w.settle(open);
    await other?.();
  }
});

test('a handoff whose pause fails resumes the worker, which can then shut down when idle', { timeout: 20_000 }, async t => {
  t.mock.method(console, 'error', () => {});
  const f = await fixture(); t.after(f.cleanup);
  const w = await idleWorker(f, {
    quiesce: async () => { w.events.push('quiesce'); throw new Error('flush failed after intake paused'); },
    resume: () => { w.events.push('resume'); },
    startSuccessor: () => { w.events.push('startSuccessor'); },
    onHandedOff: () => { w.events.push('onHandedOff'); } });
  try {
    await w.ask();
    await until(() => w.events.includes('release'));
    assert.deepEqual(w.events, ['quiesce', 'resume', 'onIdle', 'release']);
    assert.equal(existsSync(join(f.paths.runtime, 'handoff.json')), false);
  } finally { await w.settle(); }
});

test('an idle shutdown that started first is never joined by a handoff', { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.cleanup);
  // Quiet is false (a provider is still closing) while the idle conditions hold, so the idle tick comes first.
  let closingProvider = true;
  const busy = f.runs.busy.bind(f.runs);
  f.runs.busy = () => closingProvider || busy();
  let open!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  const w = await idleWorker(f, {
    onIdle: async () => { w.events.push('onIdle'); await gate; w.events.push('idle done'); },
    quiesce: async () => { w.events.push('quiesce'); },
    startSuccessor: () => { w.events.push('startSuccessor'); },
    onHandedOff: () => { w.events.push('onHandedOff'); } });
  try {
    await w.ask();
    await until(() => w.events.includes('onIdle'));
    closingProvider = false;
    // Handoff ticks come while the idle shutdown is still under way.
    await new Promise(resolve => setTimeout(resolve, 1500));
    open();
    await until(() => w.events.includes('release'));
    assert.deepEqual(w.events, ['onIdle', 'idle done', 'release']);
    assert.equal(existsSync(join(f.paths.runtime, 'handoff.json')), false);
  } finally { await w.settle(open); }
});

test('after a pause fails and the worker resumes, the same worker hands off on its next try', { timeout: 20_000 }, async t => {
  t.mock.method(console, 'error', () => {});
  // The worker waits a minute before trying a handoff it could not record again; the clock is moved past that.
  let skew = 0;
  const now = Date.now.bind(Date);
  t.mock.method(Date, 'now', () => now() + skew);
  const f = await fixture(); t.after(f.cleanup);
  let failures = 1;
  let atSuccessor: { record: boolean; socket: boolean; token: boolean; released: boolean } | undefined;
  const w = await idleWorker(f, {
    // Idle shutdown stays possible but not yet due, so only the handoff can end this worker.
    idleMs: 10 * 60_000,
    quiesce: async () => { w.events.push('quiesce'); if (failures-- > 0) throw new Error('flush failed after intake paused'); },
    resume: () => { w.events.push('resume'); },
    startSuccessor: () => {
      atSuccessor = { record: existsSync(join(f.paths.runtime, 'handoff.json')), socket: existsSync(f.paths.socket), token: existsSync(f.paths.token), released: w.events.includes('release') };
      w.events.push('startSuccessor');
    },
    onHandedOff: () => { w.events.push('onHandedOff'); } });
  try {
    await w.ask();
    await until(() => w.events.includes('resume'));
    assert.deepEqual(w.events, ['quiesce', 'resume']);
    skew = 61_000;
    await until(() => w.events.includes('onHandedOff'));
    assert.deepEqual(w.events, ['quiesce', 'resume', 'quiesce', 'release', 'startSuccessor', 'onHandedOff']);
    assert.deepEqual(atSuccessor, { record: true, socket: false, token: false, released: true });
  } finally { await w.settle(); }
});

test('cleanup during a second handoff attempt waits for that attempt, not for the first one that resumed', { timeout: 20_000 }, async t => {
  t.mock.method(console, 'error', () => {});
  let skew = 0;
  const now = Date.now.bind(Date);
  t.mock.method(Date, 'now', () => now() + skew);
  const f = await fixture(); t.after(f.cleanup);
  let attempts = 0;
  let openFirst!: () => void, openSecond!: () => void;
  const first = new Promise<void>(resolve => { openFirst = resolve; });
  const second = new Promise<void>(resolve => { openSecond = resolve; });
  const w = await idleWorker(f, { idleMs: 10 * 60_000,
    // The second attempt pauses in two steps: cleanup opens the first, the test holds the second.
    quiesce: async () => { w.events.push('quiesce'); if (attempts++ === 0) throw new Error('flush failed after intake paused'); await first; w.events.push('quiesced'); await second; },
    resume: () => { w.events.push('resume'); },
    startSuccessor: () => { w.events.push('startSuccessor'); },
    onHandedOff: () => { w.events.push('onHandedOff'); } });
  let settling: Promise<void> | undefined;
  try {
    await w.ask();
    await until(() => w.events.includes('resume'));
    skew = 61_000;
    await until(() => w.events.filter(event => event === 'quiesce').length === 2);
    settling = w.settle(openFirst);
    await until(() => w.events.includes('quiesced'));
    // The second attempt is still under way: cleanup must not close the worker and release its lock meanwhile.
    await until(() => w.events.includes('release'), 500).then(() => {}, () => {});
    assert.deepEqual(w.events, ['quiesce', 'resume', 'quiesce', 'quiesced'], 'nothing is closed or released while the current attempt has not finished');
    openSecond();
    await settling;
    assert.deepEqual(w.events, ['quiesce', 'resume', 'quiesce', 'quiesced', 'release', 'startSuccessor', 'onHandedOff']);
    assert.deepEqual(w.recordAtRelease, [true], 'the lock is released only after the record is on disk');
  } finally {
    openSecond();
    await (settling ?? w.settle(openFirst));
  }
});

test('an idle-shutdown fixture that fails before any handoff still closes its worker and frees the lock', { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.cleanup);
  let w: Awaited<ReturnType<typeof idleWorker>> | undefined;
  let open!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  // A test body that fails right after the worker started, before it asked for anything.
  await assert.rejects((async () => {
    w = await idleWorker(f, { idleMs: 10 * 60_000, quiesce: async () => { w!.events.push('quiesce'); await gate; } });
    try { throw new Error('early failure'); } finally { await w.settle(open); }
  })(), /early failure/);
  assert.deepEqual(w!.events, ['release']);
  assert.equal(existsSync(f.paths.socket), false);
  assert.equal(existsSync(f.paths.token), false);
  const again = await acquireStateLock(f.paths.runtime, 0);
  await again();
});

test('a pause that fails halfway is undone and the worker stays in service', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await f.host.close();
  let resumed = 0, started = 0;
  const host = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs,
    quiesce: async () => { throw new Error('flush failed after intake paused'); }, resume: () => { resumed++; }, startSuccessor: () => { started++; } });
  t.after(() => host.close());
  const client = await f.connect();
  await client.requestHandoff(true);
  await until(() => resumed === 1);
  assert.equal(started, 0);
  assert.equal((await client.enqueue(f.session.id, 'Accepted after the failed pause')).status, 'queued');
});

test('the web keeps trying to start a worker until one answers after a silent successor', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await f.host.close();
  let replacement: Awaited<ReturnType<typeof startRunnerHost>> | undefined;
  const first = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs, quiesce: async () => {}, startSuccessor: () => {} });
  t.after(async () => { await first.close(); await replacement?.close(); });
  let attempts = 0;
  const client = new DurableRunManager({ stateDir: f.stateDir, pollMs: 20, successorTimeoutMs: 100, startupTimeoutMs: 200,
    spawn: () => { attempts++; if (attempts === 2) void startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs }).then(host => { replacement = host; }); } });
  t.after(() => client.close());
  await client.start();
  await client.requestHandoff(true);
  await until(() => replacement && (client as unknown as { snapshot?: { instance: string } }).snapshot?.instance === replacement.instance, 15_000);
  assert.equal(attempts, 2, 'the first failed start was retried after a pause');
});

test('trigger operations run in the worker as the owner and their state reaches the web snapshot', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await f.host.close();
  const { TriggerService } = await import('../../../server/triggers/service.js');
  const { TowerApi } = await import('../../../server/api/tower-api.js');
  const triggers = new TriggerService({ stateDir: f.stateDir, tickMs: 60_000, executor: {
    submitAutoPrompt: async () => { throw new Error('unused'); }, getAutoPrompt: () => undefined,
    create: (input, internal) => f.runs.create(input, internal), enqueue: (id, prompt, request, internal) => f.runs.enqueue(id, prompt, request, internal),
    runs: () => f.runs.list(), session: id => f.runs.getSession(id) } });
  await triggers.start();
  t.after(() => triggers.close());
  const host = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs, triggers, api: new TowerApi({ stateDir: f.stateDir, triggers }) });
  t.after(() => host.close());
  const client = await f.connect();
  const input = { name: 'Nightly', enabled: true, source: { kind: 'schedule', schedule: { type: 'interval', everySeconds: 3600 }, catchUp: 'skip' },
    handler: { kind: 'task', instructions: 'Check the build', provider: 'codex', approvals: 'auto', target: { mode: 'folder', cwd: f.directory } }, policy: { overlap: 'skip', maxEventsPerHour: 5 } };
  const { trigger } = await client.api('triggers.create', { trigger: input }) as { trigger: { id: string; createdBy: { kind: string } } };
  assert.equal(trigger.createdBy.kind, 'owner');
  await until(() => client.triggerOverview()?.triggers.some(item => item.id === trigger.id));
  await assert.rejects(client.api('triggers.updateSettings', { settings: { maxTriggers: 0 } }), { kind: 'invalid' });
  await assert.rejects(client.api('sessions.destroyEverything', {}), { kind: 'not-found' });
  assert.equal(client.supports('triggers'), true);
});

test('with an outdated worker, trigger operations explain the pending update instead of failing oddly', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-legacy-triggers-'));
  const stateDir = join(directory, 'state');
  const legacy = await startLegacyRunner(stateDir, { runs: [], sessions: [], nativeIds: {}, settled: [], autoPrompts: [] });
  const client = new DurableRunManager({ stateDir, pollMs: 10, workerEntry: '/nonexistent/must-not-spawn.js', startupTimeoutMs: 1000 });
  t.after(async () => { await client.close(); await legacy.close(); await rm(directory, { recursive: true, force: true }); await rm(legacy.directory, { recursive: true, force: true }); });
  await client.start();
  await assert.rejects(client.api('triggers.list', {}), { kind: 'unavailable', message: /not updated yet/ });
  assert.equal(client.triggerOverview(), undefined);
  assert.ok(!legacy.methods.includes('api'));
});

test('an outdated worker is never given a request that names its place, since it would route it elsewhere', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-legacy-target-'));
  const stateDir = join(directory, 'state');
  const legacy = await startLegacyRunner(stateDir, { runs: [], sessions: [], nativeIds: {}, settled: [], autoPrompts: [] });
  const client = new DurableRunManager({ stateDir, pollMs: 10, workerEntry: '/nonexistent/must-not-spawn.js', startupTimeoutMs: 1000 });
  t.after(async () => { await client.close(); await legacy.close(); await rm(directory, { recursive: true, force: true }); await rm(legacy.directory, { recursive: true, force: true }); });
  await client.start();
  assert.equal(client.supports('autoPromptTargets'), false);
  const base = { provider: 'codex' as const, prompt: 'Continue', cwd: directory };
  await assert.rejects(client.submitAutoPrompt({ ...base, requestId: '12345678-1234-4234-8234-123456789abd', targetSessionId: 'codex:legacy' }), { kind: 'unavailable', disposition: 'not-admitted' });
  await assert.rejects(client.submitAutoPrompt({ ...base, requestId: '12345678-1234-4234-8234-123456789abe', sessionMode: 'new' }), { kind: 'unavailable', disposition: 'not-admitted' });
  assert.deepEqual(legacy.methods.filter(method => method !== 'snapshot'), []);
});

test('the current worker says it takes requests that name their place', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const client = await f.connect();
  assert.equal(client.supports('autoPromptTargets'), true);
});

test('an outdated worker is never asked to insert into a chosen turn, since it would insert into any', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-legacy-steer-'));
  const stateDir = join(directory, 'state');
  const legacy = await startLegacyRunner(stateDir, { runs: [], sessions: [], nativeIds: {}, settled: [], autoPrompts: [] });
  const client = new DurableRunManager({ stateDir, pollMs: 10, workerEntry: '/nonexistent/must-not-spawn.js', startupTimeoutMs: 1000 });
  t.after(async () => { await client.close(); await legacy.close(); await rm(directory, { recursive: true, force: true }); await rm(legacy.directory, { recursive: true, force: true }); });
  await client.start();
  assert.equal(client.supports('steerTargets'), false);
  await assert.rejects(client.steer('queued-run', { targetRunId: 'turn' }), { kind: 'unavailable', disposition: 'not-admitted' });
  assert.deepEqual(legacy.methods.filter(method => method !== 'snapshot'), []);
});

test('an outdated worker is never given the master, which it would run on whatever sign-in its CLI has', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-legacy-master-'));
  const stateDir = join(directory, 'state');
  const legacy = await startLegacyRunner(stateDir, { runs: [], sessions: [], nativeIds: {}, settled: [], autoPrompts: [] });
  const client = new DurableRunManager({ stateDir, pollMs: 10, workerEntry: '/nonexistent/must-not-spawn.js', startupTimeoutMs: 1000 });
  t.after(async () => { await client.close(); await legacy.close(); await rm(directory, { recursive: true, force: true }); await rm(legacy.directory, { recursive: true, force: true }); });
  await client.start();
  assert.equal(client.supports('subscriptionOnly'), false);
  const master = join(stateDir, 'master-session');
  await assert.rejects(client.create({ provider: 'claude', prompt: 'hello', cwd: master }), { kind: 'unavailable', disposition: 'not-admitted' });
  await assert.rejects(client.submitAutoPrompt({ provider: 'claude', prompt: 'hello', cwd: master, requestId: '12345678-1234-4234-8234-123456789abf' }), { kind: 'unavailable', disposition: 'not-admitted' });
  assert.deepEqual(legacy.methods.filter(method => method !== 'snapshot'), []);
});

test('while an outdated worker has a master session, it is not asked to route work by itself, since it would not keep it out of the master', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-legacy-master-route-'));
  const stateDir = join(directory, 'state');
  const master: Session = { id: 'claude:master', nativeId: 'm', provider: 'claude', title: '마스터', cwd: join(stateDir, 'master-session'), project: 'master-session', status: 'idle', statusReason: '', createdAt: '', updatedAt: '', lastMessage: '', messageCount: 1, isSubagent: false, resumable: true };
  const legacy = await startLegacyRunner(stateDir, { runs: [], sessions: [master], nativeIds: {}, settled: [], autoPrompts: [] });
  const client = new DurableRunManager({ stateDir, pollMs: 10, workerEntry: '/nonexistent/must-not-spawn.js', startupTimeoutMs: 1000 });
  t.after(async () => { await client.close(); await legacy.close(); await rm(directory, { recursive: true, force: true }); await rm(legacy.directory, { recursive: true, force: true }); });
  await client.start();
  await assert.rejects(client.submitAutoPrompt({ provider: 'claude', prompt: 'somewhere', requestId: '12345678-1234-4234-8234-123456789ac0' }), { kind: 'unavailable', disposition: 'not-admitted' });
  await assert.rejects(client.enqueue('claude:master', 'hello'), { kind: 'unavailable', disposition: 'not-admitted' });
  assert.deepEqual(legacy.methods.filter(method => method !== 'snapshot'), []);
});

test('the current worker says it keeps the master to a subscription sign-in', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const client = await f.connect();
  assert.equal(client.supports('subscriptionOnly'), true);
});

test('worker records a verified calling turn without treating its message as owner approval', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await f.host.close();
  const capabilities = new CapabilityRegistry();
  const ownerMessages: string[] = [];
  const slack = { sessionMcp: () => undefined, coordinatorSessionIds: () => [],
    ownerChat: async (_id: string, prompt: string) => { ownerMessages.push(prompt); return { prompt };  } } as unknown as SlackService;
  const host = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs, capabilities, slack });
  t.after(() => host.close());
  const client = await f.connect();
  const parent = await client.enqueue(f.session.id, 'Implement the goal');
  await until(() => f.starts() === 1);
  const token = capabilities.issue({ kind: 'caller-run', runId: parent.id, sessionId: parent.sessionId });
  const child = await client.enqueue(f.session.id, '1번 보내주세요', {}, { callerCapability: token });
  assert.deepEqual(child.delegation, { parentRunId: parent.id, rootRunId: parent.id });
  assert.deepEqual(child.origin, { kind: 'owner' }, 'reporting lineage never changes execution authority');
  assert.deepEqual(ownerMessages, ['Implement the goal'], 'an attributed agent message cannot consume owner approval');
  const before = f.runs.list().length;
  await assert.rejects(client.enqueue(f.session.id, 'Forged', {}, { callerCapability: 'f'.repeat(64) }), { kind: 'forbidden' });
  const mismatched = capabilities.issue({ kind: 'caller-run', runId: parent.id, sessionId: 'codex:someone-else' });
  await assert.rejects(client.enqueue(f.session.id, 'Wrong session', {}, { callerCapability: mismatched }), { kind: 'forbidden' });
  assert.equal(f.runs.list().length, before);
  await f.runs.cancel(child.id);
  f.finish();
  await until(() => f.runs.list().find(run => run.id === parent.id)?.status === 'completed');
  await assert.rejects(client.enqueue(f.session.id, 'Expired', {}, { callerCapability: token }), { kind: 'forbidden' });
  const saved = await readFile(join(f.stateDir, 'runs.json'), 'utf8');
  assert.equal(saved.includes(token), false, 'credentials never enter persisted run history');
  assert.ok(saved.includes(parent.id));
});


test('an old worker cannot silently ignore master.worker on direct, Auto Prompt, or v1 submissions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-legacy-worker-role-'));
  const stateDir = join(directory, 'state');
  const legacy = await startLegacyRunner(stateDir, { runs: [], sessions: [], nativeIds: {}, settled: [], autoPrompts: [] });
  const client = new DurableRunManager({ stateDir, pollMs: 10, workerEntry: '/must-not-spawn.js', startupTimeoutMs: 1000 });
  t.after(async () => { await client.close(); await legacy.close(); await rm(directory, { recursive: true, force: true }); await rm(legacy.directory, { recursive: true, force: true }); });
  await client.start();
  const input = { provider: 'codex' as const, prompt: 'work', cwd: directory, modelRole: 'master.worker' as const };
  const expected = { kind: 'unavailable', disposition: 'not-admitted' };
  await assert.rejects(client.create(input), expected);
  await assert.rejects(client.submitAutoPrompt({ ...input, requestId: '12345678-1234-4234-8234-123456789abd' }), expected);
  await assert.rejects(client.api('autoPrompt.submit', { ...input, requestId: '12345678-1234-4234-8234-123456789abe' }), expected);
  assert.deepEqual(legacy.methods.filter(method => method !== 'snapshot'), []);
});


test('the receiving worker resolves master.worker for direct creation before RunManager admission', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const received: unknown[] = [];
  f.runs.create = async input => {
    received.push(input);
    return { session: f.session, run: { id: 'role-fixture', sessionId: f.session.id, prompt: input.prompt, status: 'queued', output: '', createdAt: '' } };
  };
  const client = await f.connect();
  assert.equal(client.supports('masterWorker'), true);
  await client.create({ modelRole: 'master.worker', cwd: f.directory, prompt: 'new work' });
  assert.deepEqual(received[0], { provider: 'codex', model: 'gpt-6.1-sol', cwd: f.directory, prompt: 'new work' });
  await client.create({ provider: 'codex', cwd: f.directory, prompt: 'ordinary' });
  assert.deepEqual(received[1], { provider: 'codex', cwd: f.directory, prompt: 'ordinary' });
});

/** Failures a test injects into a trigger handoff fixture, and where it sees the fixture's parts even if building it fails. */
interface HandoffInjection {
  /** Each submission takes this much longer after its barrier opens. */
  submitDelayMs?: number;
  /** Runs after the first engine started and before its host starts (a test may hold the state lock here). */
  beforeHost?: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>;
  /** Starts the successor's engine in place of `engine.start()`; a rejection fails that start with the engine created. */
  startSuccessorEngine?: (engine: TriggerService) => Promise<void>;
  /** Runs after the successor's engine started and before its host starts; a rejection fails the successor's start. */
  beforeSuccessorHost?: () => Promise<void>;
  seen?: { f?: Awaited<ReturnType<typeof fixture>>; cleanup?: (options?: CleanupOptions) => Promise<void>; engines?: () => TriggerService[] };
}

/** `waitMs` bounds each wait; `keep` leaves the folder for the test to inspect (a later cleanup removes it). */
interface CleanupOptions { waitMs?: number; keep?: boolean }

/** The tick an engine has under way, read from its engine (the service's settle does not wait for it). */
const tickUnderWay = (service: TriggerService) => (service as unknown as { engine: { ticking?: Promise<void> } }).engine.ticking;

/** Waits for `work` up to `ms`; past that it fails with `what` rather than going on as if the work had ended. */
async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not end within ${ms}ms`)), ms); })]); }
  finally { clearTimeout(timer); }
}

/**
 * Something the fixture starts. Recorded before its start is awaited; three things are kept apart: its start settles
 * once (with the created value, without one, or failed), a failed start is reported once, and the value is closed.
 */
interface Started<T> { name: string; value?: T; settled: Promise<void>; isSettled: boolean; failure?: { error: unknown; reported: boolean }; closed: boolean; settle(failure?: { error: unknown; reported: boolean }): void }
function started<T>(name: string): Started<T> {
  let done!: () => void;
  const record: Started<T> = { name, settled: new Promise<void>(resolve => { done = resolve; }), isSettled: false, closed: false,
    settle: failure => { if (record.isSettled) return; record.isSettled = true; record.failure = failure; done(); } };
  return record;
}

/**
 * A trigger engine on the fixture's runs, handed over the way the production worker does it (hold, wait for nothing in
 * flight, pause and flush, close; the successor starts its own engine on the same state). `enqueues` counts submissions;
 * `hold()` holds submissions until the returned release; `delaySuccessor()` holds the successor's start the same way.
 * Each host takes the state lock itself and releases it when it closes.
 *
 * The folder is removed only once everything this fixture started is confirmed to have ended (see `cleanup`). Cleanup is
 * registered as the test's after hook as soon as the fixture exists, so a failure while building it is cleaned up too.
 */
async function triggerHandoff(t: test.TestContext, inject: HandoffInjection = {}) {
  const f = await fixture();
  const events: string[] = [];
  let enqueues = 0;
  let gate: Promise<void> | undefined;
  let successorGate: Promise<void> | undefined;
  /** Every barrier a test set; cleanup opens them all, whatever point the test stopped at. */
  const barriers: Array<() => void> = [];
  const barrier = () => {
    let open!: () => void;
    const held = new Promise<void>(resolve => { open = resolve; });
    barriers.push(open);
    return { held, open };
  };
  type Host = Awaited<ReturnType<typeof startRunnerHost>>;
  // The first engine and host are recorded together before anything is awaited; the successor's two are recorded
  // together when the first host asks for a successor, before its start awaits anything. Only the first host can ask,
  // so once it is closed no new record can appear.
  const engineRecords: Array<Started<TriggerService>> = [];
  const hostRecords: Array<Started<Host>> = [];
  const firstEngine = started<TriggerService>('first engine');
  const firstHost = started<Host>('first host');
  engineRecords.push(firstEngine); hostRecords.push(firstHost);
  let b: TriggerService | undefined;
  let successor: Host | undefined;
  const engines = () => engineRecords.flatMap(record => record.value ? [record.value] : []);
  const busy = (item: TriggerService) => item.inFlight() || Boolean(tickUnderWay(item));
  const count = (name: string) => events.filter(event => event === name).length;
  /** Every tick seen under way, with how it settled; kept across cleanups so a rejection after a timeout is still reported. */
  const ticks = new Map<Promise<void>, { settled: boolean; failure?: { error: unknown; reported: boolean } }>();
  const observeTicks = () => {
    for (const item of engines()) {
      const tick = tickUnderWay(item);
      if (!tick || ticks.has(tick)) continue;
      const seen: { settled: boolean; failure?: { error: unknown; reported: boolean } } = { settled: false };
      ticks.set(tick, seen);
      tick.then(() => { seen.settled = true; }, error => { seen.settled = true; seen.failure = { error, reported: false }; });
    }
  };
  /** Waits until no engine has work and every tick seen has settled; repeatable, so an engine started later is seen too. */
  const engineWork = async (ms: number) => {
    const deadline = Date.now() + ms;
    for (;;) {
      observeTicks();
      if (!engines().some(busy) && [...ticks.values()].every(seen => seen.settled)) return;
      if (Date.now() > deadline) throw new Error(`engine work did not end within ${ms}ms`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  /** Closes what a record started, once its start has settled; a close that fails is tried again by the next cleanup. */
  const close = async <T>(record: Started<T>, ms: number, end: (value: T) => Promise<void>) => {
    if (record.closed) return;
    await within(record.settled, ms, `${record.name} start`);
    if (record.value !== undefined) await end(record.value);
    record.closed = true;
  };
  const closeHost = (record: Started<Host>, ms: number) => close(record, ms, async host => {
    // Every paused handoff ends first; the close follows the check without a turn of the event loop in between, so a
    // handoff not yet started finds the worker closing and never starts.
    if (record === firstHost) await until(() => count('quiesce') === count('onHandedOff') + count('resume'), ms).catch(() => { throw new Error(`a paused handoff did not end within ${ms}ms`); });
    await host.close();
  });
  const closeEngine = (record: Started<TriggerService>, ms: number) => close(record, ms, async engine => {
    engine.close();
    await within(engine.settle(), ms, `${record.name} settle`);
    if (busy(engine)) throw new Error(`${record.name} still had work after it settled`);
  });
  let fixtureClosed = false;
  let running: Promise<void> | undefined;
  /**
   * Ends everything this fixture started, then removes its folder unless `keep`. Each part that fails or cannot be
   * confirmed in time is reported and the parts that do not depend on it still run; engines are closed only after every
   * host (and so no new record can appear), the fixture's runs after the engines, and the state lock is then taken
   * back. A failed start or tick is reported once. Any report keeps the folder and fails; calling again resumes what
   * did not end, and removes the folder only when everything has.
   */
  const cleanup = (options: CleanupOptions = {}) => running ??= (async () => {
    const ms = options.waitMs ?? 8000;
    const errors: Error[] = [];
    const attempt = async (name: string, work: () => Promise<void>) => {
      try { await work(); } catch (error) { errors.push(Object.assign(new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`), { cause: error })); }
    };
    for (const open of barriers) open();
    gate = undefined; successorGate = undefined;
    await attempt('engine work', () => engineWork(ms));
    await attempt('first host', () => closeHost(firstHost, ms));
    for (const record of hostRecords.slice(1)) await attempt(record.name, () => closeHost(record, ms));
    const hostsClosed = hostRecords.every(record => record.closed);
    if (hostsClosed) {
      // An engine that started late (the successor's) may have work of its own by now.
      await attempt('engine work', () => engineWork(ms));
      for (const record of engineRecords) await attempt(record.name, () => closeEngine(record, ms));
    }
    const enginesClosed = hostsClosed && engineRecords.every(record => record.closed);
    if (enginesClosed && !fixtureClosed) await attempt('fixture runs and clients', async () => { await f.close(); fixtureClosed = true; });
    // Confirms both hosts let go of the state.
    if (fixtureClosed) await attempt('state lock', async () => { await (await acquireStateLock(f.paths.runtime, 0))(); });
    // What failed along the way, each reported once: in this cleanup's error, which keeps the folder.
    for (const record of [...engineRecords, ...hostRecords]) {
      if (record.failure && !record.failure.reported) { record.failure.reported = true; errors.push(Object.assign(new Error(`${record.name} start failed: ${String(record.failure.error)}`), { cause: record.failure.error })); }
    }
    for (const seen of ticks.values()) {
      if (seen.failure && !seen.failure.reported) { seen.failure.reported = true; errors.push(Object.assign(new Error(`a tick failed: ${String(seen.failure.error)}`), { cause: seen.failure.error })); }
    }
    if (!errors.length && !(enginesClosed && fixtureClosed)) errors.push(new Error('not everything this fixture started was confirmed to have ended'));
    if (errors.length) throw new AggregateError(errors, `The trigger handoff fixture could not confirm that everything ended; ${f.directory} is kept.`);
    if (!options.keep) await f.remove();
  })().finally(() => { running = undefined; });
  t.after(() => cleanup());
  if (inject.seen) Object.assign(inject.seen, { f, cleanup, engines });

  const executor: TriggerExecutor = {
    submitAutoPrompt: async () => { throw new Error('unused'); }, getAutoPrompt: () => undefined,
    create: async () => { throw new Error('unused'); },
    enqueue: async (sessionId, prompt, request, internal) => { enqueues++; await gate; if (inject.submitDelayMs) await new Promise(resolve => setTimeout(resolve, inject.submitDelayMs)); return f.runs.enqueue(sessionId, prompt, request, internal); },
    runs: () => f.runs.list(), session: id => f.runs.getSession(id),
  };
  const engine = () => new TriggerService({ stateDir: f.stateDir, executor, tickMs: 3_600_000 });
  let first: TriggerService;
  try {
    await f.host.close();
    first = firstEngine.value = engine();
    // A failure while building is thrown to the test, which counts as its report.
    try { await first.start(); firstEngine.settle(); } catch (error) { firstEngine.settle({ error, reported: true }); throw error; }
    try { await inject.beforeHost?.(f); } catch (error) { firstHost.settle({ error, reported: true }); throw error; }
    const engineA = first;
    try {
      firstHost.value = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs, triggers: engineA,
        inFlight: () => engineA.inFlight(), transient: () => engineA.inFlight(),
        quiesce: async () => { events.push('quiesce'); engineA.pause(); await engineA.flush(); },
        resume: () => { events.push('resume'); engineA.resume(); },
        onHandedOff: () => { events.push('onHandedOff'); engineA.close(); },
        startSuccessor: (_command, nonce) => {
          events.push('startSuccessor');
          const nextEngine = started<TriggerService>('successor engine');
          const nextHost = started<Host>('successor host');
          engineRecords.push(nextEngine); hostRecords.push(nextHost);
          const next = b = nextEngine.value = engine();
          void (async () => {
            await successorGate;
            try { await (inject.startSuccessorEngine ?? (item => item.start()))(next); nextEngine.settle(); }
            // Its host is then never started: settled without a value.
            catch (error) { nextEngine.settle({ error, reported: false }); nextHost.settle(); return; }
            try {
              await inject.beforeSuccessorHost?.();
              successor = nextHost.value = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs, triggers: next, handoffNonce: nonce });
              events.push('successorStarted');
              nextHost.settle();
            } catch (error) { nextHost.settle({ error, reported: false }); }
          })();
        } });
      firstHost.settle();
    } catch (error) { firstHost.settle({ error, reported: true }); throw error; }
  } finally {
    // Whatever was not started because something before it failed is settled without a value.
    firstEngine.settle(); firstHost.settle();
  }
  const trigger = await first.create({ name: 'Session follow-up', enabled: true, source: { kind: 'schedule', schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' }, catchUp: 'latest' },
    handler: { kind: 'task', instructions: 'Continue the work', provider: 'codex', approvals: 'auto', target: { node: 'local', mode: 'session', sessionId: f.session.id } },
    policy: { overlap: 'skip', maxEventsPerHour: 20 } }, { kind: 'owner', via: 'ui' });
  return { f, a: first, b: () => b, successor: () => successor, events, trigger, enqueues: () => enqueues, cleanup, engines,
    hold: () => { const { held, open } = barrier(); gate = held; return () => { open(); gate = undefined; }; },
    delaySuccessor: () => { const { held, open } = barrier(); successorGate = held; return open; } };
}

/** After cleanup: the state lock is free, no engine has work in flight, and nothing changes the engine file later. */
async function nothingLeft(h: Awaited<ReturnType<typeof triggerHandoff>>) {
  const f = h.f;
  const release = await acquireStateLock(f.paths.runtime, 0);
  await release();
  assert.deepEqual(h.engines().map(item => item.inFlight()), h.engines().map(() => false));
  const file = join(f.stateDir, 'trigger-engine.json');
  const before = await readFile(file, 'utf8');
  const enqueues = h.enqueues();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await readFile(file, 'utf8'), before, 'nothing writes the engine file after cleanup');
  assert.equal(h.enqueues(), enqueues, 'nothing is submitted after cleanup');
}

test('cleanup during a trigger handoff whose claim is still held opens it, ends both workers and frees the state lock', { timeout: 20_000 }, async t => {
  const h = await triggerHandoff(t);
  h.hold();
  const fired = await h.a.run(h.trigger.id, { kind: 'owner', via: 'ui' });
  await until(() => h.enqueues() === 1 && h.a.event(fired.id).status === 'claimed');
  const client = await h.f.connect();
  assert.equal(await client.requestHandoff(true), true);
  // The test stops here, the claim still held.
  await h.cleanup({ keep: true });
  assert.equal(h.a.event(fired.id).status, 'running', 'the held submission finished before the workers closed');
  await nothingLeft(h);
  assert.equal(h.enqueues(), 1);
});

test('cleanup during a trigger handoff whose successor is still starting waits for it, then frees the state lock', { timeout: 20_000 }, async t => {
  const h = await triggerHandoff(t);
  h.delaySuccessor();
  const client = await h.f.connect();
  assert.equal(await client.requestHandoff(true), true);
  await until(() => h.events.includes('onHandedOff'));
  assert.equal(h.successor(), undefined, 'the successor is still starting');
  // The test stops here, the successor not yet started.
  await h.cleanup({ keep: true });
  assert.ok(h.events.includes('successorStarted'), 'cleanup let the successor start and then closed it');
  await nothingLeft(h);
});

test('cleanup during a slow trigger tick waits for the tick itself to end', { timeout: 20_000 }, async t => {
  const h = await triggerHandoff(t, { submitDelayMs: 2500 });
  const fired = await h.a.run(h.trigger.id, { kind: 'owner', via: 'ui' });
  await until(() => h.enqueues() === 1);
  assert.ok(tickUnderWay(h.a), 'a tick is under way, submitting');
  await h.cleanup({ keep: true });
  assert.equal(tickUnderWay(h.a), undefined, 'the tick ended before cleanup did');
  assert.equal(h.a.event(fired.id).status, 'running', 'its submission was recorded');
  await nothingLeft(h);
});

test('a cleanup that cannot confirm the end of a tick in time fails, keeps the folder, and can be run again', { timeout: 20_000 }, async t => {
  const h = await triggerHandoff(t, { submitDelayMs: 1500 });
  await h.a.run(h.trigger.id, { kind: 'owner', via: 'ui' });
  await until(() => h.enqueues() === 1);
  await assert.rejects(h.cleanup({ waitMs: 200 }), (error: unknown) => error instanceof AggregateError && error.errors.some(item => /engine work did not end within 200ms/.test(String(item))));
  assert.ok(existsSync(h.f.directory), 'the fixture folder is kept while work may still run in it');
  await h.cleanup({ keep: true });
  assert.equal(tickUnderWay(h.a), undefined);
  await nothingLeft(h);
  await h.cleanup();
  assert.ok(!existsSync(h.f.directory), 'removed once everything is confirmed to have ended');
});

test('cleanup after a successor that failed to start reports it, still ends everything, and removes the folder when run again', { timeout: 20_000 }, async t => {
  const h = await triggerHandoff(t, { beforeSuccessorHost: async () => { throw new Error('successor host failed to start'); } });
  const client = await h.f.connect();
  assert.equal(await client.requestHandoff(true), true);
  await until(() => h.events.includes('onHandedOff') && h.b());
  await assert.rejects(h.cleanup({ keep: true }), (error: unknown) => error instanceof AggregateError && error.errors.some(item => /successor host failed to start/.test(String(item))));
  assert.ok(existsSync(h.f.directory), 'kept after a failure');
  assert.deepEqual(h.engines().map(tickUnderWay), [undefined, undefined]);
  await nothingLeft(h);
  await h.cleanup();
  assert.ok(!existsSync(h.f.directory), 'the failure was reported once; with everything ended the folder goes');
});

test('a trigger handoff fixture whose first host cannot start still ends the engine it started', { timeout: 20_000 }, async t => {
  const seen: NonNullable<HandoffInjection['seen']> = {};
  let held: (() => Promise<void>) | undefined;
  await assert.rejects(triggerHandoff(t, { seen, beforeHost: async f => { held = await acquireStateLock(f.paths.runtime, 0); } }), MonitorAlreadyRunning);
  await held!();
  assert.ok(seen.cleanup && seen.engines, 'the cleanup was registered before the host started');
  await seen.cleanup({ keep: true });
  const [a] = seen.engines();
  assert.equal((a as unknown as { engine: { timer?: unknown } }).engine.timer, undefined, "the engine's timer is stopped");
  assert.equal(a.inFlight(), false);
  await (await acquireStateLock(seen.f!.paths.runtime, 0))();
});

test('a successor host that starts after its start timed out is still closed by a later cleanup', { timeout: 20_000 }, async t => {
  const h = await triggerHandoff(t, { beforeSuccessorHost: () => new Promise(resolve => setTimeout(resolve, 600)) });
  const client = await h.f.connect();
  assert.equal(await client.requestHandoff(true), true);
  await until(() => h.events.includes('onHandedOff') && h.b());
  try {
    await assert.rejects(h.cleanup({ keep: true, waitMs: 200 }), (error: unknown) => error instanceof AggregateError && error.errors.some(item => /successor host start did not end within 200ms/.test(String(item))));
    // The late host now holds the state lock; a later cleanup must close it.
    await until(() => h.successor());
    await h.cleanup({ keep: true });
    await nothingLeft(h);
    await h.cleanup();
    assert.ok(!existsSync(h.f.directory));
  } finally {
    // Repro safety net only: never leave the late host (and its lock) behind whatever the cleanup did.
    await h.successor()?.close();
  }
});

test('a tick that rejects while cleanup waits for it is reported, and the folder is kept until a later cleanup', { timeout: 20_000 }, async t => {
  const h = await triggerHandoff(t);
  // Stands in for a tick of the first engine that fails while cleanup watches it; like the engine's own tick, it
  // clears itself when it settles (engine.ts: this.ticking ??= this.step().finally(() => { this.ticking = undefined; })).
  const engine = (h.a as unknown as { engine: { ticking?: Promise<void> } }).engine;
  const failing = new Promise<void>((_, reject) => setTimeout(() => reject(new Error('tick failed')), 300)).finally(() => { engine.ticking = undefined; });
  failing.catch(() => {});
  engine.ticking = failing;
  await assert.rejects(h.cleanup({ keep: true }), (error: unknown) => error instanceof AggregateError && error.errors.some(item => /tick failed/.test(String(item))));
  assert.ok(existsSync(h.f.directory), 'kept after a tick failed');
  await h.cleanup();
  assert.ok(!existsSync(h.f.directory));
});

test('a tick that rejects after cleanup gave up waiting for it is reported by the next cleanup', { timeout: 20_000 }, async t => {
  const h = await triggerHandoff(t);
  const engine = (h.a as unknown as { engine: { ticking?: Promise<void> } }).engine;
  const failing = new Promise<void>((_, reject) => setTimeout(() => reject(new Error('late tick failed')), 500)).finally(() => { engine.ticking = undefined; });
  failing.catch(() => {});
  engine.ticking = failing;
  await assert.rejects(h.cleanup({ keep: true, waitMs: 100 }), (error: unknown) => error instanceof AggregateError
    && error.errors.some(item => /engine work did not end within 100ms/.test(String(item))) && !error.errors.some(item => /late tick failed/.test(String(item))));
  await until(() => !tickUnderWay(h.a));
  // The tick is gone from the engine, but the cleanup that saw it keeps its outcome.
  await assert.rejects(h.cleanup({ keep: true }), (error: unknown) => error instanceof AggregateError && error.errors.some(item => /a tick failed: Error: late tick failed/.test(String(item))));
  assert.ok(existsSync(h.f.directory), 'kept by the cleanup that reported it');
  await h.cleanup();
  assert.ok(!existsSync(h.f.directory), 'reported once; the next cleanup removes the folder');
});

test('a successor engine whose start fails is reported once and still closed', { timeout: 20_000 }, async t => {
  const h = await triggerHandoff(t, { startSuccessorEngine: async engine => { await engine.start(); throw new Error('successor engine start failed'); } });
  const client = await h.f.connect();
  assert.equal(await client.requestHandoff(true), true);
  await until(() => h.events.includes('onHandedOff') && h.b());
  const b = h.b()!;
  await until(() => (b as unknown as { engine: { timer?: unknown } }).engine.timer !== undefined);
  await assert.rejects(h.cleanup({ keep: true }), (error: unknown) => error instanceof AggregateError
    && error.errors.filter(item => /successor engine start failed/.test(String(item))).length === 1);
  assert.equal((b as unknown as { engine: { timer?: unknown } }).engine.timer, undefined, 'the engine it created is closed');
  assert.equal(h.successor(), undefined, 'its host never started');
  await nothingLeft(h);
  await h.cleanup();
  assert.ok(!existsSync(h.f.directory));
});

test('a cleanup while the first host is still starting waits for it, and a later cleanup closes it', { timeout: 20_000 }, async t => {
  const seen: NonNullable<HandoffInjection['seen']> = {};
  let open!: () => void;
  const starting = triggerHandoff(t, { seen, beforeHost: () => new Promise<void>(resolve => { open = resolve; }) });
  await until(() => seen.cleanup && open);
  await assert.rejects(seen.cleanup!({ keep: true, waitMs: 200 }), (error: unknown) => error instanceof AggregateError && error.errors.some(item => /first host start did not end within 200ms/.test(String(item))));
  open();
  const h = await starting;
  await h.cleanup({ keep: true });
  await nothingLeft(h);
});

test('a trigger run in flight survives a worker handoff and is not submitted again', { timeout: 20_000 }, async t => {
  const h = await triggerHandoff(t);
  const f = h.f;
  const fired = await h.a.run(h.trigger.id, { kind: 'owner', via: 'ui' });
  await until(() => f.starts() === 1 && h.a.event(fired.id).status === 'running');
  const runId = h.a.event(fired.id).dispatch?.runId;
  const client = await f.connect();
  assert.equal(await client.requestHandoff(true), true);
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.deepEqual(h.events, [], 'a running turn keeps the old worker and its engine in service');
  f.finish();
  await until(() => h.events.includes('onHandedOff') && h.successor());
  assert.equal((h.a as unknown as { engine: { timer?: unknown } }).engine.timer, undefined, "the old engine's timer is stopped");
  const b = h.b()!;
  for (let i = 0; i < 200 && b.event(fired.id).status !== 'completed'; i++) { await b.tick(); await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(b.event(fired.id).status, 'completed');
  assert.equal(b.event(fired.id).dispatch?.runId, runId, 'the successor follows the same run');
  assert.equal(h.enqueues(), 1, 'submitted exactly once');
  assert.equal(f.cancels(), 0, 'nothing is cancelled');
});

test('a handoff asked for while a trigger run is being claimed waits until the claim is recorded', { timeout: 20_000 }, async t => {
  const h = await triggerHandoff(t);
  const f = h.f;
  const release = h.hold();
  const fired = await h.a.run(h.trigger.id, { kind: 'owner', via: 'ui' });
  await until(() => h.enqueues() === 1 && h.a.event(fired.id).status === 'claimed');
  const client = await f.connect();
  assert.equal(await client.requestHandoff(true), true);
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.deepEqual(h.events, [], 'the claim keeps the old worker in service');
  release();
  await until(() => h.a.event(fired.id).status === 'running' && f.starts() === 1);
  f.finish();
  await until(() => h.events.includes('onHandedOff') && h.successor());
  const b = h.b()!;
  for (let i = 0; i < 200 && b.event(fired.id).status !== 'completed'; i++) { await b.tick(); await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(b.event(fired.id).status, 'completed');
  assert.equal(h.enqueues(), 1, 'submitted exactly once');
  assert.equal(f.cancels(), 0);
});

test('worker error replies keep their status, message and disposition across the runner wire', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const client = await f.connect();
  const { errorDisposition, errorStatus } = await import('../../../server/http/requests.js');
  const { RunError } = await import('../../../server/runs/run-records.js');
  const { SteeringError } = await import('../../../server/runs/steering.js');
  const plain = (message: string, fields: Record<string, unknown>) => Object.assign(new Error(message), fields);
  const cases: Array<[name: string, thrown: unknown, expected: { status: number; message: string; disposition?: string; edge?: string }]> = [
    ['mapped status', plain('a', { statusCode: 404 }), { status: 404, message: 'a' }],
    ['unmapped status', plain('b', { statusCode: 599 }), { status: 599, message: 'b' }],
    ['zero', plain('c', { statusCode: 0 }), { status: 0, message: 'c' }],
    ['NaN travels as null and reads as 0', plain('d', { statusCode: Number.NaN }), { status: 0, message: 'd' }],
    ['numeric string', plain('e', { statusCode: '404' }), { status: 404, message: 'e' }],
    ['no status is 500', new Error('f'), { status: 500, message: 'f' }],
    ['not an Error', 'boom', { status: 500, message: 'Runner operation failed.' }],
    ['rejected is carried but not shown', plain('g', { statusCode: 409, disposition: 'rejected' }), { status: 409, message: 'g', disposition: 'rejected' }],
    ['uncertain', plain('h', { statusCode: 503, disposition: 'uncertain' }), { status: 503, message: 'h', disposition: 'uncertain', edge: 'uncertain' }],
    ['handoff', plain('i', { statusCode: 503, disposition: 'handoff' }), { status: 503, message: 'i', disposition: 'handoff', edge: 'not-admitted' }],
    ['a disposition without a status', plain('j', { disposition: 'not-admitted' }), { status: 500, message: 'j', disposition: 'not-admitted', edge: 'not-admitted' }],
    ['RunError', new RunError('k', 'not-found'), { status: 404, message: 'k' }],
    ['SteeringError', new SteeringError('l', 'rejected'), { status: 409, message: 'l', disposition: 'rejected' }],
  ];
  for (const [name, thrown, expected] of cases) {
    f.runs.create = async () => { throw thrown; };
    const error = await client.create({ provider: 'codex', cwd: f.directory, prompt: 'x' }).then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof Error, name);
    assert.deepEqual({ status: errorStatus(error), message: error.message, disposition: (error as { disposition?: string }).disposition, edge: errorDisposition(error) },
      { status: expected.status, message: expected.message, disposition: expected.disposition, edge: expected.edge }, name);
  }
});
