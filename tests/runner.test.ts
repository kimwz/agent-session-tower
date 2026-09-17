import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import { RunManager } from '../server/runs/manager.js';
import { buildCreateArgs, buildResumeArgs } from '../server/runs/claude-args.js';
import { findExecutable } from '../server/providers/discovery.js';
import type { Run, Session } from '../shared/types.js';

const ID = '10000000-0000-4000-8000-000000000001';
const ID2 = '10000000-0000-4000-8000-000000000002';
type OpenCodexBridge = NonNullable<ConstructorParameters<typeof RunManager>[0]['openCodexBridge']>;
type CodexBridgeOptions = Parameters<OpenCodexBridge>[0];

function makeSession(cwd: string, overrides: Partial<Session> = {}): Session {
  return { id: `codex:${ID}`, nativeId: ID, provider: 'codex', title: 'Runner fixture', cwd,
    project: 'fixture', status: 'completed', statusReason: 'Finished', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), lastMessage: '', messageCount: 1, isSubagent: false, resumable: true, ...overrides };
}

async function until<T>(read: () => T | undefined, timeout = 5000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for the run state.');
}

async function fixture(options: { mode?: string; provider?: 'codex' | 'claude'; busy?: boolean; maxConcurrent?: number; refreshError?: boolean; path?: string; shebang?: boolean; openCodexBridge?: OpenCodexBridge; contextFrames?: unknown[] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-monitor-runner-'));
  const script = join(directory, 'provider.mjs');
  await writeFile(script, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { startCodexFixture } from ${JSON.stringify(new URL('./fixtures/provider-stdio.mjs', import.meta.url).href)};
let prompt = '';
process.stdin.setEncoding('utf8');
const claudeInput = process.argv.includes('-p');
if (claudeInput) createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'control_request' && message.request.subtype === 'initialize') process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:{}}})+'\\n');
  else if (message.type === 'user') { prompt = line; processPrompt(); }
});
else startCodexFixture({defaultId:'${ID}',otherId:'${ID2}'});
function processPrompt() {
  const args = process.argv.slice(2);
  const id = args.find(value => /^10000000-/.test(value));
  const provider = args.includes('--resume') ? 'claude' : 'codex';
  const send = event => process.stdout.write(JSON.stringify(event) + '\\n');
  writeFileSync(process.env.RECEIVED_PATH, JSON.stringify({prompt,args,cwd:process.cwd(),nested:process.env.CLAUDECODE}));
  const mode = process.env.FIXTURE_MODE;
  if (mode === 'invalid-event') { process.stdout.write('null\\n'); return; }
  if (mode === 'orphan') { spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',process.stdout,process.stderr]}); process.exit(0); }
  if (mode === 'empty') { process.exit(0); return; }
  if (mode === 'fail') { process.stderr.write('authentication expired'); process.exit(2); return; }
  if (mode === 'hold') { setTimeout(() => send({type:'item.completed',item:{type:'agent_message',text:'too late'}}), 20000); return; }
  if (provider === 'claude') {
    send({type:'system',subtype:'init',session_id: mode === 'mismatch' ? '${ID2}' : id});
    if (process.env.FIXTURE_CONTEXT_FRAMES) { for (const frame of JSON.parse(process.env.FIXTURE_CONTEXT_FRAMES)) send(frame); return; }
    send({type:'stream_event',event:{type:'message_start'}});
    send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Hello '}}});
    send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Claude'}}});
    send({type:'stream_event',event:{type:'message_stop'}});
    send({type:'assistant',message:{content:[{type:'text',text:'Hello Claude'}]}});
    send({type:'result',is_error:mode==='stream-error',errors:mode==='stream-error'?['provider declined']:undefined,result:'Hello Claude'});
  }
}
`);
  await chmod(script, 0o700);
  let session = makeSession(directory, { provider: options.provider ?? 'codex', status: options.busy ? 'working' : 'completed' });
  const sessions = new Map([[session.id, session]]);
  const launches: Array<{ file: string; args: string[]; path?: string }> = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  let refreshes = 0;
  const stateDir = join(directory, 'state');
  const manager = new RunManager({
    getSession: (id) => sessions.get(id), refreshSessions: async () => { refreshes++; if(options.refreshError) throw new Error('activity unavailable'); }, stateDir,
    pollMs: 25, maxConcurrent: options.maxConcurrent, findExecutable: async (provider) => `/fixture/${provider}`,
    openCodexBridge: options.openCodexBridge,
    env: { FIXTURE_MODE: options.mode ?? '', RECEIVED_PATH: join(directory, 'received.json'), CLAUDECODE: '1', ...(options.path !== undefined ? { PATH: options.path } : {}),
      ...(options.contextFrames ? { FIXTURE_CONTEXT_FRAMES: JSON.stringify(options.contextFrames) } : {}) },
    spawnProcess: (file, args, spawnOptions) => {
      launches.push({file,args,path:spawnOptions.env?.PATH});
      const child=options.shebang ? spawn(script, args, spawnOptions) : spawn(process.execPath, [script, ...args], spawnOptions); children.push(child); return child;
    },
  });
  await manager.start();
  return { manager, sessions, session, launches, children, directory, stateDir, refreshes: () => refreshes,
    cleanup: async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); } };
}

const finished = (manager: RunManager, id: string) => until(() => {
  const run = manager.list().find((entry) => entry.id === id);
  return run && ['completed', 'error', 'cancelled'].includes(run.status) ? run : undefined;
});

test('Claude CLI model overrides are explicit; Codex uses its app-server protocol', () => {
  for (const provider of ['claude', 'codex'] as const) {
    const session = makeSession('/tmp', { provider, model: 'native-existing' });
    for (const build of [buildCreateArgs, buildResumeArgs]) {
      assert.equal(build(session).includes('--model'), false);
      const args = build(session, 'provider/model-v2[1m]');
      if (provider === 'claude') assert.equal(args[args.indexOf('--model') + 1], 'provider/model-v2[1m]');
      else assert.deepEqual(args, ['app-server', '--stdio']);
      assert.throws(() => build(session, '--config'), /Invalid model/);
    }
  }
});

test('model request is snapshotted, persisted and passed to the native thread', async t => {
  const f = await fixture({ busy: true }); t.after(f.cleanup);
  const request = { model: 'native-chosen' };
  const accepted = await f.manager.enqueue(f.session.id, 'Use the chosen model', request);
  request.model = 'changed-later';
  assert.equal(accepted.model, 'native-chosen');
  assert.equal(JSON.parse(await readFile(join(f.stateDir, 'runs.json'), 'utf8'))[0].model, 'native-chosen');
  f.sessions.set(f.session.id, { ...f.session, status: 'completed' });
  assert.equal((await finished(f.manager, accepted.id)).status, 'completed');
  const received = JSON.parse(await readFile(join(f.directory, 'received.json'), 'utf8'));
  assert.equal(received.threadParams.model, 'native-chosen');
});

test('invalid model is rejected before attachment preparation and queue admission', async t => {
  const f = await fixture(); t.after(f.cleanup);
  for (const model of ['', '--model', 'has space', 'x'.repeat(161), 42, null]) {
    await assert.rejects(f.manager.enqueue(f.session.id, 'test', { model: model as string, attachments: [{ name: 'invalid', mimeType: 'bad', data: 'bad' }] }), /Invalid model/);
  }
  assert.equal(f.manager.list().length, 0); assert.equal(f.launches.length, 0);
});

test('two queued model choices for one native session are bridged in order and never overlap', async t => {
  const starts: CodexBridgeOptions[] = [];
  const release = new Map<string, () => void>();
  const f = await fixture({ openCodexBridge: async options => {
    let resolve!: () => void;
    const done = new Promise<void>(accept => { resolve = accept; });
    const finish = () => { options.onFinished({ status: 'completed' }); resolve(); };
    release.set(options.runId, finish);
    return { start: async () => { starts.push(options); options.onStarted(`turn-${options.runId}`); },
      cancel: async () => { finish(); }, close: () => { finish(); }, done };
  } });
  t.after(f.cleanup);
  const first = await f.manager.enqueue(f.session.id, 'First instruction', { model: 'model-a' });
  const second = await f.manager.enqueue(f.session.id, 'Second instruction', { model: 'model-b' });
  await until(() => starts.length === 1 ? true : undefined);
  assert.equal(starts[0].model, 'model-a');
  assert.equal(f.manager.list().find(run => run.id === second.id)?.status, 'queued');
  release.get(first.id)!();
  await until(() => starts.length === 2 ? true : undefined);
  assert.deepEqual(starts.map(start => [start.prompt, start.model]), [['First instruction', 'model-a'], ['Second instruction', 'model-b']]);
  release.get(second.id)!(); await finished(f.manager, second.id);
  assert.equal(f.launches.length, 0);
});

test('resume commands keep prompts off argv and enable ordinary sandbox permissions', () => {
  const codex = buildResumeArgs(makeSession('/tmp'));
  assert.deepEqual(codex, ['app-server', '--stdio']);
  const claude = buildResumeArgs(makeSession('/tmp', {provider:'claude'}));
  assert.ok(claude.includes('--resume') && claude.includes(ID));
  assert.equal(claude.includes('--permission-mode'), false);
  assert.equal(claude[claude.indexOf('--permission-prompt-tool') + 1], 'stdio');
  assert.equal(claude[claude.indexOf('--permission-prompts') + 1], 'host');
  assert.ok(![...codex, ...claude].some((value) => value.includes('bypass') || value.includes('dangerously')));
});

test('resumes exact Codex session, streams output, and treats shell syntax as literal stdin', async () => {
  const f = await fixture();
  try {
    const prompt = 'Do not execute: $(touch INJECTION) `touch INJECTION2`\nhello';
    const run = await f.manager.enqueue(f.session.id, prompt);
    const result = await finished(f.manager, run.id);
    assert.equal(result.status, 'completed');
    assert.match(result.output, /Hello Codex/);
    const received = JSON.parse(await readFile(join(f.directory, 'received.json'), 'utf8'));
    assert.equal(received.prompt, prompt);
    assert.equal(received.cwd, await realpath(f.directory));
    assert.equal(received.nested, undefined);
    assert.ok(!received.args.includes(prompt));
    assert.ok(f.refreshes() > 0);
    await assert.rejects(stat(join(f.directory, 'INJECTION')), {code:'ENOENT'});
    await until(() => f.manager.list().find((entry) => entry.status === 'completed'));
  } finally { await f.cleanup(); }
});

test('Claude partial text is streamed without duplicating the final assistant message', async () => {
  const f = await fixture({ provider: 'claude' });
  try {
    const result = await finished(f.manager, (await f.manager.enqueue(f.session.id, 'hello')).id);
    assert.equal(result.status, 'completed');
    assert.equal(result.output.trim(), 'Hello Claude');
  } finally { await f.cleanup(); }
});

const contextAssistant = {
  type: 'assistant', session_id: ID, parent_tool_use_id: null,
  message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'Context fixture.' }],
    usage: { input_tokens: 5, cache_creation_input_tokens: 10, cache_read_input_tokens: 15, output_tokens: 50_000 } },
};
const contextResult = {
  type: 'result', session_id: ID, is_error: false, result: 'Done.',
  usage: { input_tokens: 9_000_000 },
  modelUsage: { 'claude-opus-5': { contextWindow: 200_000, inputTokens: 9_000_000 }, 'claude-haiku-other': { contextWindow: 100_000 } },
};

test('Claude retains exact root context, persists it, and enriches only the matching native observation', async t => {
  const f = await fixture({ provider: 'claude', contextFrames: [contextAssistant,
    { ...contextAssistant, parent_tool_use_id: 'child-tool', message: { ...contextAssistant.message, model: 'claude-haiku-other', usage: { input_tokens: 999 } } },
    { ...contextAssistant, isMeta: true, message: { ...contextAssistant.message, usage: { input_tokens: 888 } } },
    { ...contextAssistant, is_meta: true, message: { ...contextAssistant.message, usage: { input_tokens: 666 } } },
    { ...contextAssistant, message: { ...contextAssistant.message, model: '<synthetic>', usage: { input_tokens: 777 } } },
    contextResult,
  ] });
  let restored: RunManager | undefined;
  t.after(async () => { await restored?.close(); await f.cleanup(); });
  const usage = { usedTokens: 30, contextWindow: 1_000_000, usedPercent: 0.003, capacitySource: 'model-default' as const, updatedAt: '2026-01-01T00:00:00.000Z' };
  f.session.model = 'claude-opus-5'; f.session.contextUsage = usage;
  const accepted = await f.manager.enqueue(f.session.id, 'Synthetic context observation');
  const result = await finished(f.manager, accepted.id);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.contextUsage, { model: 'claude-opus-5', usedTokens: 30, contextWindow: 200_000, usedPercent: 0.015, updatedAt: result.contextUsage!.updatedAt });
  assert.equal(f.manager.getSession(f.session.id)?.contextUsage?.contextWindow, 200_000);
  assert.equal(f.manager.getSession(f.session.id)?.contextUsage?.capacitySource, undefined);
  assert.equal(f.manager.sessionList([f.session])[0]?.contextUsage?.contextWindow, 200_000);
  result.contextUsage!.contextWindow = 1;
  assert.equal(f.manager.list().find(run => run.id === accepted.id)?.contextUsage?.contextWindow, 200_000);
  await f.manager.close();
  const saved = JSON.parse(await readFile(join(f.stateDir, 'runs.json'), 'utf8'));
  assert.equal(saved[0].contextUsage.contextWindow, 200_000);
  restored = new RunManager({ getSession: id => f.sessions.get(id), refreshSessions: async () => {}, stateDir: f.stateDir });
  await restored.start();
  assert.equal(restored.getSession(f.session.id)?.contextUsage?.contextWindow, 200_000);
  const cases: Array<Partial<Session>> = [
    { contextUsage: undefined },
    { model: 'claude-fable-5', contextUsage: usage },
    { contextUsage: { ...usage, usedTokens: 31 } },
    { contextUsage: { ...usage, updatedAt: new Date(Date.parse(saved[0].contextUsage.updatedAt) + 1000).toISOString() } },
    { contextUsage: { ...usage, updatedAt: 'invalid' } },
    { contextUsage: { ...usage, contextWindow: 100_000, usedPercent: 0.03, capacitySource: undefined } },
  ];
  for (const patch of cases) {
    f.sessions.set(f.session.id, { ...f.session, ...patch });
    assert.deepEqual(restored.getSession(f.session.id)?.contextUsage, patch.contextUsage);
  }
});

test('Claude does not persist subagent, unconfirmed, compacted, mismatched-model or invalid-capacity context', async t => {
  const cases = [
    { mode: 'mismatch', frames: [contextAssistant, contextResult] },
    { frames: [{ ...contextAssistant, parent_tool_use_id: 'child-tool' }, contextResult] },
    { frames: [{ ...contextAssistant, session_id: ID2 }, contextResult] },
    { frames: [{ ...contextAssistant, isMeta: true }, contextResult] },
    { frames: [{ ...contextAssistant, is_meta: true }, contextResult] },
    { frames: [{ ...contextAssistant, message: { ...contextAssistant.message, model: '<synthetic>' } }, contextResult] },
    { frames: [contextAssistant, { type: 'system', subtype: 'compact_boundary', session_id: ID }, contextResult] },
    { frames: [contextAssistant, { ...contextAssistant, message: { model: 'claude-fable-5', content: [] } }, contextResult] },
    { frames: [contextAssistant, { ...contextAssistant, message: { content: [], usage: { input_tokens: 99 } } }, contextResult] },
    { frames: [contextAssistant, { ...contextResult, modelUsage: { 'claude-other': { contextWindow: 200_000 } } }] },
    { frames: [contextAssistant, { ...contextResult, modelUsage: { 'claude-opus-5': { contextWindow: '200000' } } }] },
    { frames: [contextAssistant, { ...contextResult, parent_tool_use_id: 'child-tool' }] },
  ];
  for (const entry of cases) {
    const f = await fixture({ provider: 'claude', mode: entry.mode, contextFrames: entry.frames }); t.after(f.cleanup);
    const accepted = await f.manager.enqueue(f.session.id, 'Synthetic context observation');
    const result = await finished(f.manager, accepted.id);
    assert.equal(result.contextUsage, undefined);
  }
});

test('invalid persisted context metadata is discarded without losing the saved run', async t => {
  const f = await fixture({ provider: 'claude', contextFrames: [contextAssistant, contextResult] }); t.after(f.cleanup);
  const accepted = await f.manager.enqueue(f.session.id, 'Synthetic context observation');
  await finished(f.manager, accepted.id); await f.manager.close();
  const path = join(f.stateDir, 'runs.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  const original = saved[0].contextUsage;
  for (const patch of [{ capacitySource: 'model-default' }, { model: '--invalid' }, { usedTokens: -1 }, { contextWindow: 0 }, { usedPercent: 25 }, { updatedAt: 'invalid' }]) {
    saved[0].contextUsage = { ...original, ...patch }; await writeFile(path, JSON.stringify(saved));
    const restored = new RunManager({ getSession: id => f.sessions.get(id), refreshSessions: async () => {}, stateDir: f.stateDir });
    try {
      await restored.start();
      assert.equal(restored.list().length, 1);
      assert.equal(restored.list()[0].contextUsage, undefined);
    } finally { await restored.close(); }
  }
});

for (const decision of ['allow', 'deny'] as const) test(`owned Codex exposes a live approval and sends exactly the selected ${decision}`, async t => {
  const f = await fixture({ mode: 'approval' }); t.after(f.cleanup);
  const accepted = await f.manager.enqueue(f.session.id, 'Run the approved command');
  const pending = await until(() => f.manager.list().find(run => run.id === accepted.id && run.approvals?.length));
  const approval = pending.approvals![0];
  assert.equal(pending.status, 'running');
  assert.equal(approval.input.command, 'gh pr view 1');
  assert.equal(JSON.parse(await readFile(join(f.directory, 'received.json'), 'utf8')).approvalResponse, undefined);
  approval.input.command = 'browser cannot change the requested command';
  assert.equal(f.manager.list().find(run => run.id === accepted.id)?.approvals?.[0].input.command, 'gh pr view 1');
  await (f.manager as unknown as { flush(): Promise<void> }).flush();
  assert.equal(JSON.parse(await readFile(join(f.stateDir, 'runs.json'), 'utf8'))[0].approvals, undefined);
  await f.manager.respondToApproval(accepted.id, approval.id, decision);
  await assert.rejects(f.manager.respondToApproval(accepted.id, approval.id, decision), { statusCode: 409 });
  const result = await finished(f.manager, accepted.id);
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.approvals, undefined);
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'received.json'), 'utf8')).approvalResponse, { decision: decision === 'allow' ? 'accept' : 'decline' });
});

const ATTACHED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2S8AAAAASUVORK5CYII=';
for (const provider of ['claude', 'codex'] as const) test(`${provider} receives native image input and readable general files in the exact resumed conversation`, async () => {
  const f = await fixture({ provider });
  try {
    const run = await f.manager.enqueue(f.session.id, '', { attachments: [
      { name: 'picture.png', mimeType: 'image/png', data: ATTACHED_PNG },
      { name: 'notes $(touch INJECTION).txt', mimeType: 'text/plain', data: Buffer.from('private attachment contents').toString('base64') },
    ] });
    assert.equal((await finished(f.manager, run.id)).status, 'completed');
    const received = JSON.parse(await readFile(join(f.directory, 'received.json'), 'utf8'));
    let prompt = received.prompt;
    if (provider === 'claude') {
      assert.ok(received.args.includes(ID));
      assert.equal(received.args[received.args.indexOf('--input-format') + 1], 'stream-json');
      const message = JSON.parse(received.prompt);
      assert.equal(message.session_id, ID);
      assert.deepEqual(message.message.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ATTACHED_PNG } });
      assert.equal(message.message.role, 'user');
      prompt = message.message.content[0].text;
      assert.ok(received.args.includes('--add-dir'));
    } else {
      assert.equal(received.threadParams.threadId, ID);
      const imagePath = received.input.find((item: { type: string }) => item.type === 'localImage').path;
      assert.equal((await readFile(imagePath)).toString('base64'), ATTACHED_PNG);
    }
    assert.match(prompt, /첨부한 파일을 확인/);
    assert.match(prompt, /notes \$\(touch INJECTION\)\.txt/);
    assert.doesNotMatch(JSON.stringify(f.manager.list()), /private attachment contents|base64|\/attachments\//);
    assert.equal(f.manager.list()[0].prompt, '');
    assert.deepEqual(Object.keys(run.attachments![0]).sort(), ['id', 'mimeType', 'name', 'size']);
    assert.equal((await f.manager.attachment(run.attachments![1].id)).content.toString(), 'private attachment contents');
    await assert.rejects(stat(join(f.directory, 'INJECTION')), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('native app bridge receives stored image paths without launching a second writer', async () => {
  let received: CodexBridgeOptions | undefined;
  const f = await fixture({ openCodexBridge: async options => {
    received = options;
    return { start: async () => { options.onStarted('owned'); options.onFinished({ status: 'completed' }); }, cancel: async () => {}, close: () => {}, done: Promise.resolve() };
  } });
  try {
    f.sessions.set(f.session.id, { ...f.session, activeProcess: true });
    const run = await f.manager.enqueue(f.session.id, 'explain picture', { attachments: [{ name: 'picture.png', mimeType: 'image/png', data: ATTACHED_PNG }] });
    assert.equal((await finished(f.manager, run.id)).status, 'completed');
    assert.equal(f.launches.length, 0);
    assert.equal(received?.threadId, ID);
    assert.match(received!.prompt, /^explain picture/);
    assert.equal((await readFile(received!.imagePaths![0])).toString('base64'), ATTACHED_PNG);
  } finally { await f.cleanup(); }
});

test('retries retain attachments after restart, enforce session ownership, and never auto-submit old runs', async () => {
  const f = await fixture({ busy: true });
  let reopened: RunManager | undefined;
  try {
    const run = await f.manager.enqueue(f.session.id, '', { attachments: [{ name: 'notes.txt', mimeType: 'text/plain', data: 'aGVsbG8=' }] });
    await f.manager.close();
    reopened = new RunManager({ getSession: id => f.sessions.get(id), refreshSessions: async () => {}, stateDir: f.stateDir, findExecutable: async () => '/fixture/codex' });
    await reopened.start();
    assert.equal(reopened.list()[0].status, 'cancelled');
    assert.deepEqual(reopened.list()[0].attachments, run.attachments);
    const retry = await reopened.enqueue(f.session.id, '', { attachmentIds: [run.attachments![0].id] });
    assert.deepEqual(retry.attachments, run.attachments);
    const other = makeSession(f.directory, { id: `codex:${ID2}`, nativeId: ID2 });
    f.sessions.set(other.id, other);
    await assert.rejects(reopened.enqueue(other.id, 'other session', { attachmentIds: [run.attachments![0].id] }), { statusCode: 404 });
    assert.equal(f.launches.length, 0);
  } finally { await reopened?.close(); await f.cleanup(); }
});

test('failed admission and full queues roll back only newly saved attachment files', async () => {
  const f = await fixture({ busy: true });
  try {
    const input = { name: 'notes.txt', mimeType: 'text/plain', data: 'aGVsbG8=' };
    const first = await f.manager.enqueue(f.session.id, 'first', { attachments: [input] });
    await rm(join(f.stateDir, 'runs.json'));
    await mkdir(join(f.stateDir, 'runs.json'));
    await assert.rejects(f.manager.enqueue(f.session.id, 'rejected', { attachmentIds: [first.attachments![0].id], attachments: [input] }), /Cannot save/);
    assert.deepEqual(await readdir(join(f.stateDir, 'attachments')), [first.attachments![0].id]);
    await rm(join(f.stateDir, 'runs.json'), { recursive: true });
    const results = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => f.manager.enqueue(f.session.id, `queued ${i}`, { attachments: [input] })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 31);
    assert.equal((await readdir(join(f.stateDir, 'attachments'))).length, 32);
    assert.equal(f.launches.length, 0);
  } finally { await rm(join(f.stateDir, 'runs.json'), { recursive: true, force: true }); await f.cleanup(); }
});

test('shutdown during attachment preparation rejects admission and cleans fresh files before any provider launch', async () => {
  const f = await fixture();
  const store = (f.manager as any).attachments;
  const prepare = store.prepare.bind(store);
  let prepared!: () => void;
  const preparedSignal = new Promise<void>(resolve => { prepared = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  store.prepare = async (...args: unknown[]) => { const result = await prepare(...args); prepared(); await gate; return result; };
  try {
    const pending = f.manager.enqueue(f.session.id, '', { attachments: [{ name: 'notes.txt', mimeType: 'text/plain', data: 'aGVsbG8=' }] });
    const rejected = assert.rejects(pending, /not accepting/);
    await preparedSignal;
    await f.manager.close();
    release(); await rejected;
    assert.equal(f.manager.list().length, 0);
    assert.equal(f.launches.length, 0);
    assert.deepEqual(await readdir(join(f.stateDir, 'attachments')), []);
  } finally { release(); await f.cleanup(); }
});

test('Finder-style PATH can run a Node CLI wrapper without searching its monitored working directory', async () => {
  const f = await fixture({ path: '/usr/bin:/bin:.:relative::', shebang: true });
  try {
    // An unsafe inherited PATH would choose this workspace executable before ~/.local/bin/node.
    await writeFile(join(f.directory, 'node'), '#!/bin/sh\nexit 88\n', { mode: 0o700 });
    const result = await finished(f.manager, (await f.manager.enqueue(f.session.id, 'continue from Finder')).id);
    assert.equal(result.status, 'completed', result.error);
    assert.match(result.output, /Hello Codex/);
    const directories = f.launches[0].path!.split(delimiter);
    assert.ok(directories.every(directory => directory && isAbsolute(directory)));
    assert.deepEqual(directories.slice(0, 2), ['/usr/bin', '/bin']);
    assert.ok(directories.includes(join(homedir(), '.local', 'bin')));
    assert.ok(directories.includes('/opt/homebrew/bin'));
  } finally { await f.cleanup(); }
});

test('busy native conversations wait and resume automatically after their writer exits', async () => {
  const f = await fixture({busy:true});
  try {
    const run = await f.manager.enqueue(f.session.id, 'next turn');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(f.launches.length, 0);
    assert.match(f.manager.list()[0].output, /current turn/);
    f.sessions.set(f.session.id, {...f.session, status:'idle', activeProcess:false});
    assert.equal((await finished(f.manager, run.id)).status, 'completed');
    assert.equal(f.launches.length, 1);
  } finally { await f.cleanup(); }
});

test('an idle Codex conversation with an active native writer cannot start a second writer', async () => {
  const f = await fixture();
  try {
    f.sessions.set(f.session.id, {...f.session, status:'idle', activeProcess:true});
    const run = await f.manager.enqueue(f.session.id, 'continue the desktop conversation');
    await until(() => f.launches.length > 0 || f.refreshes() >= 3 ? true : undefined);
    assert.equal(f.launches.length, 0, 'the idle desktop writer still owns the Codex conversation');
    assert.equal(f.manager.list().find(entry => entry.id === run.id)?.status, 'queued');
    f.sessions.set(f.session.id, {...f.session, status:'idle', activeProcess:false});
    assert.equal((await finished(f.manager, run.id)).status, 'completed');
    assert.equal(f.launches.length, 1, 'resume starts only after the native writer exits');
  } finally { await f.cleanup(); }
});

test('an idle Claude conversation with an active process retains its existing resume behavior', async () => {
  const f = await fixture({provider:'claude'});
  try {
    f.sessions.set(f.session.id, {...f.session, status:'idle', activeProcess:true});
    const run = await f.manager.enqueue(f.session.id, 'continue the idle Claude conversation');
    const result = await finished(f.manager, run.id);
    assert.equal(result.status, 'completed');
    assert.equal(result.output.trim(), 'Hello Claude');
    assert.equal(f.launches.length, 1);
    assert.ok(f.launches[0].args.includes('--resume'));
  } finally { await f.cleanup(); }
});

test('an idle Codex desktop writer receives the exact instruction through its bridge without a new CLI', async () => {
  let bridgeOptions: CodexBridgeOptions | undefined;
  let starts = 0;
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  const f = await fixture({openCodexBridge: async options => {
    bridgeOptions = options;
    return {
      done,
      start: async () => { starts++; },
      cancel: async () => { options.onFinished({status:'cancelled'}); resolveDone(); },
      close: () => resolveDone(),
    };
  }});
  try {
    f.sessions.set(f.session.id, {...f.session, status:'idle', activeProcess:true});
    const prompt = 'Continue this exact desktop thread.\nKeep $(commands) as literal text.';
    const run = await f.manager.enqueue(f.session.id, prompt);
    await until(() => starts === 1 ? true : undefined);
    assert.ok(bridgeOptions);
    assert.equal(bridgeOptions.threadId, f.session.nativeId);
    assert.equal(bridgeOptions.runId, run.id);
    assert.equal(bridgeOptions.prompt, prompt);
    assert.equal(f.manager.list().find(entry => entry.id === run.id)?.status, 'queued', 'opening the bridge does not claim the turn started');
    assert.equal(f.launches.length, 0);
    bridgeOptions.onStarted();
    const running = f.manager.list().find(entry => entry.id === run.id)!;
    assert.equal(running.status, 'running');
    assert.ok(running.startedAt);
    bridgeOptions.onOutput('Hello ');
    bridgeOptions.onOutput('desktop Codex');
    assert.equal(f.manager.list().find(entry => entry.id === run.id)?.output, 'Hello desktop Codex');
    bridgeOptions.onFinished({status:'completed'});
    resolveDone();
    const result = await finished(f.manager, run.id);
    assert.equal(result.status, 'completed');
    assert.equal(result.output, 'Hello desktop Codex');
    assert.ok(result.finishedAt);
    assert.equal(f.manager.settledRunIds().has(run.id), true);
    assert.equal(starts, 1);
    assert.equal(f.launches.length, 0);
    assert.equal(f.children.length, 0);
  } finally { await f.cleanup(); }
});

test('cancel during bridge startup interrupts only the bridged turn and ignores later output', async () => {
  let bridgeOptions: CodexBridgeOptions | undefined;
  let cancels = 0;
  let releaseStart!: () => void;
  const starting = new Promise<void>(resolve => { releaseStart = resolve; });
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  const f = await fixture({openCodexBridge: async options => {
    bridgeOptions = options;
    return {
      done,
      start: async () => { options.onStarted(); await starting; },
      cancel: async () => { cancels++; options.onFinished({status:'cancelled'}); resolveDone(); releaseStart(); },
      close: () => { resolveDone(); releaseStart(); },
    };
  }});
  try {
    f.sessions.set(f.session.id, {...f.session, status:'idle', activeProcess:true});
    const run = await f.manager.enqueue(f.session.id, 'cancel only this desktop turn');
    await until(() => f.manager.list().find(entry => entry.id === run.id && entry.status === 'running'));
    await f.manager.cancel(run.id);
    assert.equal(cancels, 1, 'the bridge must be registered before start() finishes');
    assert.equal((await finished(f.manager, run.id)).status, 'cancelled');
    bridgeOptions!.onStarted();
    bridgeOptions!.onOutput('late output after cancellation');
    const result = f.manager.list().find(entry => entry.id === run.id)!;
    assert.equal(result.status, 'cancelled');
    assert.doesNotMatch(result.output, /late output/);
    assert.equal(f.launches.length, 0);
    assert.equal(f.children.length, 0, 'there is no owned CLI process to signal');
  } finally { releaseStart(); await f.cleanup(); }
});

test('a bridge submission error after possible delivery never falls back to a second CLI writer', async () => {
  let starts = 0;
  let closes = 0;
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  const f = await fixture({openCodexBridge: async options => ({
    done,
    start: async () => { starts++; options.onStarted(); throw new Error('Desktop acknowledgement lost after possible delivery'); },
    cancel: async () => { options.onFinished({status:'cancelled'}); resolveDone(); },
    close: () => { closes++; resolveDone(); },
  })});
  try {
    f.sessions.set(f.session.id, {...f.session, status:'idle', activeProcess:true});
    const run = await f.manager.enqueue(f.session.id, 'submit exactly once');
    const result = await finished(f.manager, run.id);
    assert.equal(result.status, 'error');
    assert.match(result.error || '', /acknowledgement lost after possible delivery/);
    assert.equal(starts, 1);
    assert.equal(closes, 1);
    f.sessions.set(f.session.id, {...f.session, status:'idle', activeProcess:false});
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(f.launches.length, 0, 'even when the writer disappears, an uncertain delivery must never replay');
    assert.equal(f.children.length, 0);
    assert.equal(starts, 1);
  } finally { await f.cleanup(); }
});

test('Auto Prompt tasks in independent sessions start despite two active tasks, while the same session waits', async () => {
  const f = await fixture({ mode: 'hold' });
  try {
    const secondSession = makeSession(f.directory, { id: `codex:${ID2}`, nativeId: ID2 });
    const thirdId = '10000000-0000-4000-8000-000000000003';
    const thirdSession = makeSession(f.directory, { id: `codex:${thirdId}`, nativeId: thirdId });
    f.sessions.set(secondSession.id, secondSession);
    f.sessions.set(thirdSession.id, thirdSession);
    const first = await f.manager.enqueue(f.session.id, 'already running');
    const second = await f.manager.enqueue(secondSession.id, 'first auto prompt', {}, { autoPromptId: ID });
    await until(() => f.manager.list().filter(run => run.startedAt).length === 2 ? true : undefined);
    const queued = await f.manager.enqueue(secondSession.id, 'same agent follow-up');
    const third = await f.manager.enqueue(thirdSession.id, 'second auto prompt', {}, { autoPromptId: ID2 });
    await until(() => f.manager.list().find(run => run.id === third.id)?.startedAt);
    const runs = f.manager.list();
    for (const run of [first, second, third]) assert.equal(runs.find(value => value.id === run.id)?.status, 'running');
    assert.equal(runs.find(run => run.id === queued.id)?.status, 'queued');
    assert.equal(f.launches.length, 3);
    await f.manager.cancel(second.id);
    await until(() => f.manager.list().find(run => run.id === queued.id)?.startedAt);
    assert.equal(f.manager.list().find(run => run.id === queued.id)?.status, 'running');
    assert.equal(f.launches.length, 4);
  } finally { await f.cleanup(); }
});

test('serializes a conversation while allowing independent sessions up to concurrency limit', async () => {
  const f = await fixture({mode:'slow', maxConcurrent:2});
  try {
    const secondSession = makeSession(f.directory, {id:`codex:${ID2}`,nativeId:ID2});
    f.sessions.set(secondSession.id, secondSession);
    const one = await f.manager.enqueue(f.session.id, 'one');
    const two = await f.manager.enqueue(f.session.id, 'two');
    const three = await f.manager.enqueue(secondSession.id, 'three');
    await until(() => f.launches.length === 2 ? true : undefined);
    assert.equal(f.manager.list().find((run) => run.id === two.id)?.status, 'queued');
    assert.equal(f.manager.list().filter((run) => run.status === 'running').length, 2);
    await Promise.all([one,two,three].map((run) => finished(f.manager, run.id)));
    assert.equal(f.launches.length, 3);
    assert.ok(f.manager.list().every((run) => run.status === 'completed'));
  } finally { await f.cleanup(); }
});

for (const mode of ['fail', 'stream-error', 'mismatch', 'empty', 'invalid-event']) test(`provider ${mode} is an error, never false success`, async () => {
  const f = await fixture({mode});
  try {
    const result = await finished(f.manager, (await f.manager.enqueue(f.session.id, 'hello')).id);
    assert.equal(result.status, 'error');
    assert.match(result.error ?? '', mode === 'fail' ? /authentication expired/ : mode === 'mismatch' ? /different or invalid conversation/ : mode === 'empty' ? /exited/ : mode === 'invalid-event' ? /Invalid protocol frame/ : /provider declined/);
  } finally { await f.cleanup(); }
});

test('rejected persistence never launches an instruction later from the polling queue',async()=>{
  const f=await fixture();
  try{
    await rm(f.stateDir,{recursive:true,force:true});
    await assert.rejects(f.manager.enqueue(f.session.id,'must not run'),/Cannot save/);
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(f.launches.length,0);
    assert.equal(f.manager.list().length,0);
  }finally{await mkdir(f.stateDir,{recursive:true});await f.cleanup();}
});

test('an executable lookup finishing after shutdown cannot admit or launch work',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'agent-monitor-admission-'));
  let release!:(path:string)=>void;
  const lookup=new Promise<string>(resolve=>{release=resolve;});
  const session=makeSession(directory);
  const manager=new RunManager({getSession:()=>session,refreshSessions:async()=>{},stateDir:directory,findExecutable:()=>lookup});
  try{
    await manager.start();
    const admission=manager.enqueue(session.id,'too late');
    const rejected=assert.rejects(admission,/not accepting/);
    await manager.close();
    release('/fixture/codex');
    await rejected;
    assert.equal(manager.list().length,0);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('simultaneous admission cannot exceed the waiting queue capacity',async()=>{
  const f=await fixture({busy:true});
  try{
    const attempts=await Promise.allSettled(Array.from({length:40},(_,i)=>f.manager.enqueue(f.session.id,`task ${i}`)));
    assert.equal(attempts.filter(result=>result.status==='fulfilled').length,32);
    assert.equal(f.manager.list().length,32);
    assert.equal(f.launches.length,0);
  }finally{await f.cleanup();}
});

test('cancellation cleans owned descendants after leader exit and reports unconfirmed native completion',async()=>{
  const f=await fixture({mode:'orphan'});
  try{
    const run=await f.manager.enqueue(f.session.id,'orphan');
    await until(()=>f.children[0]?.exitCode===0?true:undefined);
    assert.equal(f.manager.settledRunIds().has(run.id),false,'the descendant still holds the owned pipe open');
    await assert.rejects(f.manager.cancel(run.id), /exited|connection|closed/);
    await until(()=>f.manager.settledRunIds().has(run.id)?true:undefined);
    assert.equal(f.manager.list()[0].status,'error');
    assert.match(f.manager.list()[0].error || '', /not resent automatically/);
  }finally{await f.cleanup();}
});

test('after an owned child closes, stale native working state cannot block the next instruction',async()=>{
  const f=await fixture({mode:'hold'});
  try{
    const first=await f.manager.enqueue(f.session.id,'first');
    await until(()=>f.manager.list().find(run => run.id === first.id)?.startedAt ? true : undefined);
    f.sessions.set(f.session.id,{...f.session,status:'working'});
    await f.manager.cancel(first.id);
    await until(()=>f.manager.settledRunIds().has(first.id)?true:undefined);
    const second=await f.manager.enqueue(f.session.id,'next');
    await until(()=>f.manager.list().find(run => run.id === second.id)?.startedAt ? true : undefined);
    await f.manager.cancel(second.id);
    await until(()=>f.manager.settledRunIds().has(second.id)?true:undefined);
    f.sessions.set(f.session.id,{...f.session,status:'working',updatedAt:new Date(Date.now()+1000).toISOString()});
    const third=await f.manager.enqueue(f.session.id,'external task wins');
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(f.children.length,2,'newer external turn still blocks another writer');
    await f.manager.cancel(third.id);
  }finally{await f.cleanup();}
});

test('failed activity refresh keeps instructions queued until explicitly cancelled', async () => {
  const f = await fixture({refreshError:true});
  try {
    const run = await f.manager.enqueue(f.session.id, 'hello');
    await until(() => f.manager.list()[0].output.includes('activity unavailable') ? true : undefined);
    assert.equal(f.launches.length, 0);
    assert.equal(f.manager.list()[0].status, 'queued');
    await f.manager.cancel(run.id);
    await new Promise(resolve=>setTimeout(resolve,75));
    assert.equal(f.launches.length, 0);
  } finally { await f.cleanup(); }
});

test('cancels only its owned process and persists private terminal run state', async () => {
  const f = await fixture({mode:'hold'});
  try {
    const run = await f.manager.enqueue(f.session.id, 'hold');
    await until(() => f.manager.list().find((entry) => entry.status === 'running'));
    await f.manager.cancel(run.id);
    assert.equal((await finished(f.manager, run.id)).status, 'cancelled');
    await assert.rejects(f.manager.cancel('unknown'), /Task not found/);
    const persisted: Run[] = JSON.parse(await readFile(join(f.stateDir, 'runs.json'), 'utf8'));
    assert.equal(persisted.find((entry) => entry.id === run.id)?.status, 'cancelled');
    assert.equal((await stat(join(f.stateDir, 'runs.json'))).mode & 0o777, 0o600);
  } finally { await f.cleanup(); }
});

test('bounds streamed history and rejects invalid or unavailable native sessions', async () => {
  const f = await fixture({mode:'large'});
  try {
    await assert.rejects(f.manager.enqueue('missing', 'hello'), /no longer exists/);
    await assert.rejects(f.manager.enqueue(f.session.id, '  '), /Enter an instruction/);
    await assert.rejects(f.manager.enqueue(f.session.id, 'x'.repeat(32001)), /at most/);
    const result = await finished(f.manager, (await f.manager.enqueue(f.session.id, 'hello')).id);
    assert.equal(result.status, 'completed');
    assert.equal(result.output.length, 64000);
    f.sessions.set(f.session.id, {...f.session, nativeId:'--malicious'});
    await assert.rejects(f.manager.enqueue(f.session.id, 'hello'), /ID is invalid/);
  } finally { await f.cleanup(); }
});

test('restart preserves finished history and never replays interrupted or queued tasks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-monitor-recovery-'));
  const records: Run[] = ['running','queued','completed'].map((status, index) => ({id:String(index),sessionId:`codex:${ID}`,prompt:'must not replay',status:status as Run['status'],createdAt:new Date().toISOString(),output:'history'}));
  await writeFile(join(directory, 'runs.json'), JSON.stringify(records));
  const manager = new RunManager({getSession:()=>undefined,refreshSessions:async()=>{},stateDir:directory});
  try {
    await manager.start();
    assert.deepEqual(manager.list().map((run)=>run.status), ['error','cancelled','completed']);
    assert.match(manager.list()[0].error ?? '', /not restarted/);
    assert.equal(manager.list()[2].output, 'history');
  } finally { await manager.close(); await rm(directory,{recursive:true,force:true}); }
});

test('executable discovery supports paths containing spaces without shell evaluation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent monitor path '));
  try {
    await writeFile(join(directory, 'claude'), '#!/bin/sh\nexit 0\n');
    await chmod(join(directory, 'claude'), 0o755);
    assert.equal(await findExecutable('claude', {PATH:directory}), join(directory,'claude'));
  } finally { await rm(directory,{recursive:true,force:true}); }
});
