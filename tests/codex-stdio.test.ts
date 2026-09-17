import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { RunApproval } from '../shared/types.js';
import { openCodexStdioRun, type CodexStdioOptions, type CodexStdioResult } from '../server/codex-stdio.js';

const ID = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const TURN = '20000000-0000-4000-8000-000000000001';
type Frame = { id?: string | number; method?: string; params?: any; result?: any; error?: any };

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!check()) { if (Date.now() > deadline) assert.fail('Timed out waiting for the Codex stdio fixture.'); await delay(5); }
}

async function fixture(t: TestContext, mode = 'complete', overrides: Partial<CodexStdioOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-codex-stdio-'));
  const script = join(directory, 'provider.mjs');
  await writeFile(script, `
import readline from 'node:readline';
import { spawn } from 'node:child_process';
const mode = process.env.FIXTURE_MODE;
if (mode === 'ignore-stop') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
const threadId = '${ID}';
const turnId = '${TURN}';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const reply = (request, result) => send({ id: request.id, result });
const notice = (method, params) => send({ method, params: { threadId, turnId, ...params } });
const finish = (status='completed') => {
  notice('item/agentMessage/delta', { itemId: 'message', delta: 'Hello ' });
  notice('item/completed', { item: { id: 'message', type: 'agentMessage', text: 'Hello Codex' } });
  notice('turn/completed', { turn: { id: turnId, status, completedAt: 1789516801, items: [{ id: 'message', type: 'agentMessage', text: 'Hello Codex' }] } });
};
const approval = () => {
  let method = 'item/commandExecution/requestApproval';
  let params = { threadId, turnId, itemId: 'tool', command: 'printf safe-marker', cwd: '/tmp/fixture', environmentId: 'remote:command-fixture', reason: 'Need network access', networkApprovalContext: { host: 'api.github.com', protocol: 'https' }, availableDecisions: ['accept', 'decline'] };
  if (mode === 'file' || mode === 'file-without-patch') {
    method = 'item/fileChange/requestApproval';
    if (mode === 'file') notice('item/started', { item: { id: 'tool', type: 'fileChange', changes: [{ path: '/tmp/fixture/target.txt', kind: { type: 'add' }, diff: '+ original change' }] } });
    params = { threadId, turnId, itemId: 'tool', reason: 'Write outside the workspace', grantRoot: '/tmp/fixture' };
  }
  if (mode === 'permissions') { method = 'item/permissions/requestApproval'; params = { threadId, turnId, itemId: 'tool', cwd: '/tmp/fixture', environmentId: 'remote:permissions-fixture', reason: 'Read an external repository', permissions: { network: { enabled: true }, fileSystem: { read: ['/tmp/fixture/source'], write: null } } }; }
  if (['cached-command', 'command-without-details', 'subcommand-without-details', 'stdin-without-details'].includes(mode)) {
    params.command = null;
    params.networkApprovalContext = null;
    params.cwd = null;
    if (mode !== 'command-without-details') notice('item/started', { item: { id: 'tool', type: 'commandExecution', command: 'printf original-cached-command', cwd: '/tmp/fixture/cached' } });
    if (mode === 'subcommand-without-details') params.approvalId = 'distinct-native-subcommand';
    if (mode === 'stdin-without-details') params.kind = 'writeStdin';
  }
  if (mode === 'unknown') method = 'item/tool/requestUserInput';
  if (mode === 'amendment-only') params.availableDecisions = [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ['printf'] } }, 'decline'];
  if (mode === 'accept-only') params.availableDecisions = ['accept'];
  if (mode === 'network-cancel') {
    params.command = "/bin/zsh -lc 'gh pr view 4 --repo example/project --json number,title,state'";
    params.availableDecisions = ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['gh', 'pr', 'view', '4', '--repo', 'example/project', '--json', 'number,title,state'] } }, 'cancel'];
  }
  if (mode === 'other-thread') params.threadId = '${OTHER}';
  send({ id: mode === 'numeric-id' ? 0 : 'native-approval', method, params });
  if (mode === 'resolved') setTimeout(() => notice('serverRequest/resolved', { requestId: 'native-approval' }), 60);
};
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') { reply(request, {}); return; }
  if (request.method === 'initialized') return;
  if (request.method === 'thread/start' || request.method === 'thread/resume') {
    if (mode === 'writer-conflict') { send({ id: request.id, error: { code: -32000, message: 'thread-store conflict: already has an active writer' } }); return; }
    reply(request, { thread: { id: mode === 'mismatch' ? '${OTHER}' : threadId, status: { type: mode === 'active' ? 'active' : 'idle' } }, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false } }); return;
  }
  if (request.method === 'turn/start') {
    if (mode === 'lost-start') { process.exit(3); return; }
    if (mode === 'badframe') { process.stdout.write('null\\n'); return; }
    if (mode === 'early-approval') approval();
    if (mode === 'early-complete') finish();
    reply(request, { turn: { id: turnId, status: 'inProgress', startedAt: 1789516800, items: [] } });
    if (mode === 'early-approval' || mode === 'early-complete') return;
    if (mode === 'thread-closed') { notice('thread/closed', {}); return; }
    if (mode.startsWith('steer-') || mode === 'hold' || mode === 'cancel-no-ack' || mode === 'ignore-stop') return;
    if (mode === 'orphan') { spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', process.stdout, process.stderr] }); process.exit(0); return; }
    if (mode === 'premature-exit') { process.exit(0); return; }
    if (mode === 'complete') finish(); else approval();
    return;
  }
  if (request.method === 'turn/steer') {
    if (mode === 'steer-timeout') return;
    if (mode === 'steer-lost') { process.exit(3); return; }
    if (mode === 'steer-rejected') { send({ id: request.id, error: { message: 'active turn mismatch' } }); return; }
    reply(request, { turnId: mode === 'steer-mismatch' ? 'other-turn' : turnId });
    return;
  }
  if (request.method === 'turn/interrupt') {
    reply(request, {});
    if (mode !== 'cancel-no-ack') setTimeout(() => finish('interrupted'), 80);
    return;
  }
  if (request.id === 'native-approval' || request.id === 0) {
    if (mode === 'resolved') return;
    if (!request.error) finish();
    return;
  }
});
`);
  const sent: Frame[] = [];
  const launches: { executable: string; args: string[]; options: any }[] = [];
  const sessions: string[] = [];
  const output: string[] = [];
  const started: { turnId: string; at?: string }[] = [];
  const approvals: RunApproval[] = [];
  const cleared: string[] = [];
  const finished: CodexStdioResult[] = [];
  let child!: ChildProcessWithoutNullStreams;
  const run = await openCodexStdioRun({ executable: '/fixture/codex', cwd: directory, threadId: ID, prompt: 'Exact prompt $(never execute)\n원문',
    env: { ...process.env, FIXTURE_MODE: mode },
    spawnProcess(executable, args, options) {
      launches.push({ executable, args, options });
      child = spawn(process.execPath, [script, ...args], options);
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = ((chunk: any, ...rest: any[]) => { sent.push(JSON.parse(String(chunk))); return write(chunk, ...rest); }) as typeof child.stdin.write;
      return child;
    },
    onSession(id) { sessions.push(id); }, onStarted(turnId, at) { started.push({ turnId, at }); },
    onOutput(text) { output.push(text); }, onApproval(approval) { approvals.push(approval); },
    onApprovalCancelled(id) { cleared.push(id); }, onFinished(result) { finished.push(result); }, ...overrides });
  t.after(async () => { run.close(); await run.done; await rm(directory, { recursive: true, force: true }); });
  return { run, sent, launches, sessions, output, started, approvals, cleared, finished, directory, child: () => child };
}

test('stdio resumes the exact conversation with native settings, streams once, and reaps its process', async t => {
  const f = await fixture(t);
  await f.run.start(); await f.run.done;
  assert.deepEqual(f.launches[0].args, ['app-server', '--stdio']);
  assert.equal(f.launches[0].options.cwd, f.directory);
  assert.equal(f.launches[0].options.detached, true);
  assert.equal(f.launches[0].options.shell, false);
  assert.deepEqual(f.sent.find(frame => frame.method === 'thread/resume')?.params, { threadId: ID, excludeTurns: true });
  const turn = f.sent.find(frame => frame.method === 'turn/start')!;
  assert.deepEqual(turn.params, { threadId: ID, input: [{ type: 'text', text: 'Exact prompt $(never execute)\n원문', text_elements: [] }] });
  assert.deepEqual(f.sessions, [ID]);
  assert.equal(f.output.join(''), 'Hello Codex\n\n');
  assert.equal(f.started[0].at, new Date(1789516800 * 1000).toISOString());
  assert.equal(f.finished[0].finishedAt, new Date(1789516801 * 1000).toISOString());
  assert.equal(f.finished[0].status, 'completed');
  assert.equal(f.finished.length, 1);
  assert.ok(f.child().exitCode !== null || f.child().signalCode !== null);
});

test('new native identity is durable before prompt admission, with only an explicit model override', async t => {
  let release!: () => void;
  let saving = false;
  const saved = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, 'complete', { threadId: undefined, model: 'native/model', imagePaths: ['/tmp/exact image.png'], onSession: async id => { assert.equal(id, ID); saving = true; await saved; } });
  const start = f.run.start();
  await until(() => saving);
  assert.equal(f.sent.some(frame => frame.method === 'turn/start'), false);
  release(); await start; await f.run.done;
  assert.deepEqual(f.sent.find(frame => frame.method === 'thread/start')?.params, { cwd: f.directory, model: 'native/model' });
  assert.deepEqual(f.sent.find(frame => frame.method === 'turn/start')?.params.input[1], { type: 'localImage', path: '/tmp/exact image.png' });
  assert.equal(f.sent.some(frame => frame.method === 'thread/resume'), false);
});

test('identity persistence failure and resume ownership conflicts never submit a prompt', async t => {
  for (const mode of ['save-failure', 'mismatch', 'active', 'writer-conflict']) await t.test(mode, async t => {
    const f = await fixture(t, mode, mode === 'save-failure' ? { onSession: async () => { throw new Error('Cannot save native identity.'); } } : {});
    await assert.rejects(f.run.start()); await f.run.done;
    assert.equal(f.sent.some(frame => frame.method === 'turn/start'), false);
    assert.equal(f.finished[0].status, 'error');
    assert.equal(f.launches.length, 1);
  });
});

test('command approvals are correlated, retain network details, and grant only one command', async t => {
  for (const mode of ['approval', 'numeric-id', 'early-approval']) await t.test(mode, async t => {
    const f = await fixture(t, mode);
    await f.run.start(); await until(() => f.approvals.length === 1);
    const approval = f.approvals[0];
    assert.equal(approval.input.command, 'printf safe-marker');
    assert.equal(approval.input.environmentId, 'remote:command-fixture');
    assert.equal((approval.input.networkApprovalContext as any).host, 'api.github.com');
    await assert.rejects(f.run.respondToApproval('not-pending', 'allow'), { statusCode: 409 });
    await f.run.respondToApproval(approval.id, 'allow');
    await assert.rejects(f.run.respondToApproval(approval.id, 'allow'), { statusCode: 409 });
    await f.run.done;
    assert.deepEqual(f.sent.find(frame => frame.id === (mode === 'numeric-id' ? 0 : 'native-approval'))?.result, { decision: 'accept' });
    assert.deepEqual(f.cleared, [approval.id]);
    assert.equal(f.finished[0].status, 'completed');
  });
});

test('ordinary command approvals retain an omitted command and cwd from the exact started item', async t => {
  const f = await fixture(t, 'cached-command');
  await f.run.start(); await until(() => f.approvals.length === 1);
  const approval = f.approvals[0];
  assert.equal(approval.input.command, 'printf original-cached-command');
  assert.equal(approval.input.cwd, '/tmp/fixture/cached');
  await f.run.respondToApproval(approval.id, 'deny'); await f.run.done;
  assert.deepEqual(f.sent.find(frame => frame.id === 'native-approval')?.result, { decision: 'decline' });
});

test('file approvals show the actual patch and denying never grants a root or persists a rule', async t => {
  const f = await fixture(t, 'file');
  await f.run.start(); await until(() => f.approvals.length === 1);
  const approval = f.approvals[0];
  assert.equal((approval.input.changes as any[])[0].path, '/tmp/fixture/target.txt');
  assert.equal((approval.input.changes as any[])[0].diff, '+ original change');
  await f.run.respondToApproval(approval.id, 'deny'); await f.run.done;
  assert.deepEqual(f.sent.find(frame => frame.id === 'native-approval')?.result, { decision: 'decline' });
});

test('native network approvals accept once or use the advertised cancel decision without amending policy', async t => {
  for (const decision of ['allow', 'deny'] as const) await t.test(decision, async t => {
    const f = await fixture(t, 'network-cancel');
    await f.run.start(); await until(() => f.approvals.length === 1);
    const approval = f.approvals[0];
    assert.equal(approval.input.command, "/bin/zsh -lc 'gh pr view 4 --repo example/project --json number,title,state'");
    await f.run.respondToApproval(approval.id, decision); await f.run.done;
    assert.deepEqual(f.sent.find(frame => frame.id === 'native-approval')?.result, { decision: decision === 'allow' ? 'accept' : 'cancel' });
    assert.deepEqual(f.cleared, [approval.id]);
  });
});

test('permission profiles are granted for this turn only from retained native input, or denied as empty', async t => {
  for (const decision of ['allow', 'deny'] as const) await t.test(decision, async t => {
    const f = await fixture(t, 'permissions');
    await f.run.start(); await until(() => f.approvals.length === 1);
    const approval = f.approvals[0];
    assert.equal((approval as RunApproval & { scope?: string }).scope, 'turn');
    assert.equal(approval.input.scope, 'turn');
    assert.equal(approval.input.environmentId, 'remote:permissions-fixture');
    // UI consumers cannot replace the internally retained permission request.
    (approval.input.permissions as any).fileSystem.write = ['/changed-by-consumer'];
    await f.run.respondToApproval(approval.id, decision); await f.run.done;
    assert.deepEqual(f.sent.find(frame => frame.id === 'native-approval')?.result, { permissions: decision === 'allow' ? { network: { enabled: true }, fileSystem: { read: ['/tmp/fixture/source'], write: null } } : {}, scope: 'turn' });
  });
});

test('unsupported interactions, persistent-only decisions, and approvals for another turn fail without hanging', async t => {
  for (const mode of ['unknown', 'amendment-only', 'accept-only', 'file-without-patch', 'command-without-details', 'subcommand-without-details', 'stdin-without-details']) await t.test(mode, async t => {
    const f = await fixture(t, mode);
    await f.run.start(); await f.run.done;
    assert.equal(f.approvals.length, 0);
    assert.equal(f.finished[0].status, 'error');
    assert.match(f.finished[0].error!, /unsupported interaction/);
    assert.ok(f.sent.find(frame => frame.id === 'native-approval')?.error);
  });
});

test('lost acknowledgement, invalid frames and exit without terminal status never retry admission', async t => {
  for (const mode of ['lost-start', 'badframe', 'premature-exit']) await t.test(mode, async t => {
    const f = await fixture(t, mode);
    await f.run.start().catch(() => {}); await f.run.done;
    assert.equal(f.finished[0].status, 'error');
    assert.equal(f.sent.filter(frame => frame.method === 'turn/start').length, 1);
    assert.equal(f.launches.length, 1);
    if (mode !== 'badframe') assert.match(f.finished[0].error!, /not resent automatically/);
  });
});

test('early turn completion is correlated and emitted once', async t => {
  const f = await fixture(t, 'early-complete');
  await f.run.start(); await f.run.done;
  assert.equal(f.output.join(''), 'Hello Codex\n\n');
  assert.equal(f.finished[0].status, 'completed');
});

test('a closed native thread fails explicitly instead of keeping the run open', async t => {
  const f = await fixture(t, 'thread-closed');
  await f.run.start(); await f.run.done;
  assert.equal(f.finished[0].status, 'error');
  assert.match(f.finished[0].error!, /conversation closed/);
});

test('cancel waits for the exact terminal notification and closes only the owned process', async t => {
  const f = await fixture(t, 'hold');
  await f.run.start();
  let cancelled = false;
  const cancel = f.run.cancel().then(() => { cancelled = true; });
  await until(() => f.sent.some(frame => frame.method === 'turn/interrupt'));
  await delay(15);
  assert.equal(cancelled, false);
  await cancel;
  assert.deepEqual(f.sent.find(frame => frame.method === 'turn/interrupt')?.params, { threadId: ID, turnId: TURN });
  assert.equal(f.finished[0].status, 'cancelled');
  assert.ok(f.child().signalCode || f.child().exitCode !== null);
});

test('closing an approval clears it and prevents stale responses or automatic resubmission', async t => {
  const f = await fixture(t, 'approval');
  await f.run.start(); await until(() => f.approvals.length === 1);
  f.run.close(); await f.run.done;
  assert.equal(f.finished[0].status, 'error');
  assert.deepEqual(f.cleared, [f.approvals[0].id]);
  await assert.rejects(f.run.respondToApproval(f.approvals[0].id, 'allow'), { statusCode: 409 });
  assert.equal(f.sent.filter(frame => frame.method === 'turn/start').length, 1);
});

test('server-resolved approvals are removed before a stale browser response can grant them', async t => {
  const f = await fixture(t, 'resolved');
  await f.run.start(); await until(() => f.approvals.length === 1);
  await until(() => f.cleared.length === 1);
  await assert.rejects(f.run.respondToApproval(f.approvals[0].id, 'allow'), { statusCode: 409 });
  assert.equal(f.sent.some(frame => frame.id === 'native-approval'), false);
});

test('owned processes that ignore termination or leave stdout descendants are reaped', async t => {
  for (const mode of ['ignore-stop', 'orphan']) await t.test(mode, async t => {
    const f = await fixture(t, mode);
    await f.run.start();
    if (mode === 'ignore-stop') f.run.close();
    await f.run.done;
    assert.equal(f.finished[0].status, 'error');
    assert.ok(f.child().exitCode !== null || f.child().signalCode !== null);
    if (mode === 'ignore-stop') assert.equal(f.child().signalCode, 'SIGKILL');
  });
});

for (const mode of ['steer-ok', 'steer-rejected', 'steer-mismatch', 'steer-lost', 'steer-timeout']) {
  test(`stdio steering ${mode} preserves identity and delivery certainty`, async t => {
    const f = await fixture(t, mode);
    assert.equal(f.run.canSteer!(), false);
    await assert.rejects(f.run.steer!({ id: 'queued', prompt: 'later' }), { disposition: 'rejected' });
    await f.run.start();
    assert.equal(f.run.canSteer!(), true);
    const result = f.run.steer!({ id: 'queued', prompt: 'New instruction', imagePaths: ['/tmp/image path.png'] });
    assert.equal(f.run.canSteer!(), false);
    await assert.rejects(f.run.steer!({ id: 'duplicate', prompt: 'later' }), { disposition: 'rejected' });
    if (mode === 'steer-ok') await result;
    else await assert.rejects(result, { disposition: mode === 'steer-rejected' ? 'rejected' : 'uncertain' });
    assert.deepEqual(f.sent.find(frame => frame.method === 'turn/steer')?.params, {
      threadId: ID, expectedTurnId: TURN, clientUserMessageId: 'queued',
      input: [{ type: 'text', text: 'New instruction', text_elements: [] }, { type: 'localImage', path: '/tmp/image path.png' }],
    });
    assert.equal(f.sent.filter(frame => frame.method === 'turn/start').length, 1);
    assert.equal(f.sent.some(frame => frame.method === 'turn/interrupt'), false);
    if (mode !== 'steer-lost') {
      assert.equal(f.finished.length, 0);
      assert.equal(f.run.canSteer!(), true);
      await f.run.cancel(); // The original live turn can still be controlled after rejection.
    } else await f.run.done;
    assert.equal(f.run.canSteer!(), false);
    await assert.rejects(f.run.steer!({ id: 'late', prompt: 'later' }), { disposition: 'rejected' });
    assert.equal(f.sent.filter(frame => frame.method === 'turn/steer').length, 1);
  });
}
