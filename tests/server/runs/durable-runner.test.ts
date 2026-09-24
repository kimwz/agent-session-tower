import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
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
  return { directory, stateDir, session, sessions, runs, host, paths, connect, starts: () => starts, cancels: () => cancels,
    output: (text: string) => { assert.ok(bridge); bridge.onOutput(text); },
    finish: () => { assert.ok(bridge); bridge.onFinished({ status: 'completed' }); resolveDone(); },
    cleanup: async () => {
      await Promise.all(clients.map(client => client.close()));
      await host.close(); sessions.stop(); await runs.close();
      await rm(directory, { recursive: true, force: true });
      await rm(paths.directory, { recursive: true, force: true });
    },
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

test('only the owner’s own message can approve a Slack send; agent work and correlation IDs never can', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await f.host.close();
  const ownerMessages: string[] = [];
  const slack = {
    sessionMcp: () => undefined,
    ownerChat: async (_id: string, message: string) => { ownerMessages.push(message); return `${message} [owner receipt]`; },
    coordinatorSessionIds: () => [],
  } as unknown as SlackService;
  const host = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs, slack });
  t.after(() => host.close());
  const client = await f.connect();
  const owner = await client.enqueue(f.session.id, '1번 보내주세요');
  assert.equal(owner.prompt, '1번 보내주세요 [owner receipt]');
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
  await assert.rejects(client.sessionHistory(''), { statusCode: 400 });
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
  await assert.rejects(client.sessionHistory(session.nativeId), { statusCode: 400, message: 'Unknown runner operation.' });
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
  await assert.rejects(client.enqueue(session.id, '1번 보내주세요', {}, { origin: agent }), { statusCode: 409, message: /outdated/ });
  await assert.rejects(client.create({ provider: 'codex', cwd: directory, prompt: 'Agent task' }, { origin: agent }), /outdated/);
  await assert.rejects(client.submitAutoPrompt({ requestId: '12345678-1234-4234-8234-123456789abd', provider: 'codex', prompt: 'Agent task' }, { origin: agent }), /outdated/);
  assert.deepEqual(legacy.methods.filter(method => method !== 'snapshot'), []);
  await client.enqueue(session.id, 'Owner message', {}, { origin: { kind: 'owner' } });
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
  const first = await startRunnerHost({ stateDir: f.stateDir, sessions: f.sessions, runs: f.runs,
    quiesce: async () => { handoffs++; },
    startSuccessor: (command, nonce) => {
      successors.push(command);
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
  await until(() => client.list().some(item => item.id === run.id) && client.supports('handoff') && (client as unknown as { snapshot: { instance: string } }).snapshot.instance === successor!.instance);
  const after = await client.enqueue(f.session.id, 'Sent after the handoff');
  assert.equal(after.origin?.kind, 'owner');
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
  await assert.rejects(client.enqueue(f.session.id, 'Arrives mid-handoff'), { statusCode: 503, disposition: 'handoff' });
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
  await assert.rejects(client.api('triggers.updateSettings', { settings: { maxTriggers: 0 } }), { statusCode: 400 });
  await assert.rejects(client.api('sessions.destroyEverything', {}), { statusCode: 404 });
  assert.equal(client.supports('triggers'), true);
});

test('with an outdated worker, trigger operations explain the pending update instead of failing oddly', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-legacy-triggers-'));
  const stateDir = join(directory, 'state');
  const legacy = await startLegacyRunner(stateDir, { runs: [], sessions: [], nativeIds: {}, settled: [], autoPrompts: [] });
  const client = new DurableRunManager({ stateDir, pollMs: 10, workerEntry: '/nonexistent/must-not-spawn.js', startupTimeoutMs: 1000 });
  t.after(async () => { await client.close(); await legacy.close(); await rm(directory, { recursive: true, force: true }); await rm(legacy.directory, { recursive: true, force: true }); });
  await client.start();
  await assert.rejects(client.api('triggers.list', {}), { statusCode: 503, message: /not updated yet/ });
  assert.equal(client.triggerOverview(), undefined);
  assert.ok(!legacy.methods.includes('api'));
});
