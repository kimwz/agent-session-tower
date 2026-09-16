import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runAutoPromptModel, type AutoPromptModelRequest, type AutoPromptNativeDependencies } from '../server/auto-prompt-native.js';

const DECISION = { action: 'existing', sessionId: 'fixture-A' };
const SCHEMA = { type: 'object', properties: { action: { const: 'existing' }, sessionId: { const: 'fixture-A' } }, required: ['action', 'sessionId'], additionalProperties: false };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
const CLAUDE_PROGRESS = [
  { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: null, error: 'unknown' },
  { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 12, estimated_tokens_delta: 4, user_message_uuid: 'fixture-message' },
  { type: 'system', subtype: 'thinking', content: 'Synthetic reasoning progress.' },
].map(frame => ({ ...frame, uuid: '11111111-1111-4111-8111-111111111111', session_id: 'fixture-session' }));

async function fixture(t: TestContext, provider: 'claude' | 'codex' = 'codex', mode = 'success', progress: object[] = []) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-native-router-'));
  const reportFile = join(directory, 'report.json');
  const script = join(directory, 'provider.mjs');
  await writeFile(script, `
import { writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const args = JSON.parse(process.env.ROUTER_ARGS);
const images = args.flatMap((arg, i) => arg === '--image' ? [{ path: args[i+1], base64: readFileSync(args[i+1]).toString('base64') }] : []);
writeFileSync(process.env.ROUTER_REPORT, JSON.stringify({ input, images, cwd: process.cwd(), pid: process.pid, instructions: readFileSync('instructions.txt','utf8'), schema: JSON.parse(readFileSync('schema.json','utf8')) }));
const mode = process.env.ROUTER_MODE;
const provider = process.env.ROUTER_PROVIDER;
const send = (value, newline = true) => process.stdout.write(JSON.stringify(value) + (newline ? '\\n' : ''));
const decision = ${JSON.stringify(DECISION)};
if (mode === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
else if (mode === 'orphan') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', process.stdout, process.stderr] });
  writeFileSync(process.env.ROUTER_ORPHAN, String(child.pid)); process.exit(0);
}
else if (mode === 'nonzero') { process.stderr.write('AUTH_SECRET_DO_NOT_EXPOSE=token-private'); process.exit(3); }
else if (mode === 'oversized') process.stdout.write('x'.repeat(1000001));
else if (mode === 'stderr') process.stderr.write('private'.repeat(10000));
else if (mode === 'malformed') process.stdout.write('not JSON');
else if (provider === 'claude') {
  send({type:'system', subtype:'init', tools: mode === 'tools' ? ['Bash'] : ['StructuredOutput'], mcp_servers:[]});
  for (const frame of JSON.parse(process.env.ROUTER_PROGRESS)) send(frame);
  if (mode === 'unknown-system') send({type:'system',subtype:'fixture_unknown',content:'private response content'});
  if (mode === 'unsafe-event-name') send({type:'private event content',subtype:'x'.repeat(65),content:'private response content'});
  if (mode === 'tool-call') send({type:'assistant',message:{content:[{type:'tool_use',name:'Bash',input:{command:'exit'}}]}});
  send({type:'assistant',message:{content:[{type:'tool_use',name:'StructuredOutput',input:decision}]}});
  for (const frame of JSON.parse(process.env.ROUTER_PROGRESS)) send(frame);
  const result = {type:'result',subtype:'success',is_error:false,structured_output:decision};
  if (mode === 'missing-structured') { delete result.structured_output; result.result = JSON.stringify(decision); }
  if (mode === 'error-result') { result.is_error=true; result.subtype='error_during_execution'; }
  if (mode !== 'incomplete') send(result, mode !== 'no-newline');
  if (mode === 'trailing') process.stdout.write('bad tail');
}
else {
  send({type:'thread.started',thread_id:'fixture-only'}); send({type:'turn.started'});
  if (mode === 'safe-warning') send({type:'item.completed',item:{type:'error',message:'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable \u0060features.code_mode_host\u0060 and install \u0060codex-code-mode-host\u0060.'}});
  if (mode === 'startup-error') send({type:'item.completed',item:{type:'error',message:'Unknown unsupported isolation setting.'}});
  if (mode === 'tools') send({type:'item.started',item:{type:'command_execution',command:'exit'}});
  send({type:'item.completed',item:{type:'agent_message',text: mode === 'bad-decision' ? 'prefix '+JSON.stringify(decision) : JSON.stringify(decision)}});
  if (mode !== 'incomplete') send({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}},mode !== 'no-newline');
  if (mode === 'trailing') process.stdout.write('bad tail');
}
`);
  let launched: { file: string; args: string[]; options: any; pid?: number } | undefined;
  const dependencies: AutoPromptNativeDependencies = {
    stateDir: join(directory, 'state'), timeoutMs: 3000, killGraceMs: 30,
    findExecutable: async () => '/fixture/native-cli',
    spawnProcess: (file, args, options) => {
      const child = spawn(process.execPath, [script], { ...options, env: { ...options.env, ROUTER_ARGS: JSON.stringify(args), ROUTER_REPORT: reportFile, ROUTER_ORPHAN: join(directory, 'orphan.pid'), ROUTER_MODE: mode, ROUTER_PROVIDER: provider, ROUTER_PROGRESS: JSON.stringify(progress) } });
      launched = { file, args, options, pid: child.pid };
      return child;
    },
  };
  const controller = new AbortController();
  const request: AutoPromptModelRequest = { provider, model: provider === 'claude' ? 'opus' : 'gpt-5.6-sol', systemPrompt: 'Choose only from the supplied IDs.', prompt: 'User input $(never execute) `literal`\nfixture-A', schema: SCHEMA, signal: controller.signal };
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  return { directory, dependencies, request, controller, launched: () => launched!, report: async () => JSON.parse(await readFile(reportFile, 'utf8')) };
}

test('Codex router preserves native auth location and supplies isolated strict reasoning settings', async t => {
  const f = await fixture(t);
  assert.deepEqual(await runAutoPromptModel(f.request, f.dependencies), DECISION);
  const launch = f.launched();
  for (const flag of ['--ephemeral', '--ignore-user-config', '--ignore-rules', '--strict-config', '--skip-git-repo-check', '--output-schema']) assert.ok(launch.args.includes(flag));
  for (const config of ['features.shell_tool=false', 'features.unified_exec=false', 'features.hooks=false', 'features.plugins=false', 'features.apps=false', 'orchestrator.mcp.enabled=false', 'orchestrator.skills.enabled=false', 'skills.include_instructions=false', 'project_doc_max_bytes=0', 'approval_policy="never"', 'web_search="disabled"']) assert.ok(launch.args.includes(config), config);
  assert.equal(launch.args[launch.args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(launch.args[launch.args.indexOf('--model') + 1], 'gpt-5.6-sol');
  assert.equal(launch.options.env.CODEX_HOME, process.env.CODEX_HOME);
  assert.equal(launch.options.env.HOME, process.env.HOME);
  assert.equal(launch.options.shell, false);
  assert.equal(launch.options.detached, true);
  assert.match(launch.options.cwd, /state\/tmp\/auto-prompt-/);
  const report = await f.report();
  assert.equal(report.input, f.request.prompt);
  assert.equal(report.instructions, f.request.systemPrompt);
  assert.deepEqual(report.schema, SCHEMA);
  assert.deepEqual(await readdir(join(f.directory, 'state', 'tmp')), []);
});

test('Claude router uses safe mode, no tools or persistence, and strict structured output', async t => {
  const f = await fixture(t, 'claude');
  assert.deepEqual(await runAutoPromptModel(f.request, f.dependencies), DECISION);
  const args = f.launched().args;
  for (const flag of ['--safe-mode', '--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config', '--json-schema']) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(!args.includes('--bare'));
  assert.ok(!args.includes('--resume'));
  assert.equal(JSON.parse((await f.report()).input).message.content[0].text, f.request.prompt);
});

for (const provider of ['codex', 'claude'] as const) {
  test(`${provider} routing images travel through private copies or base64 input`, async t => {
    const f = await fixture(t, provider);
    const path = join(f.directory, 'input.png');
    await writeFile(path, PNG);
    f.request.imagePaths = [path];
    assert.deepEqual(await runAutoPromptModel(f.request, f.dependencies), DECISION);
    const report = await f.report();
    if (provider === 'codex') {
      assert.notEqual(report.images[0].path, path);
      assert.equal(report.images[0].base64, PNG.toString('base64'));
    } else {
      const image = JSON.parse(report.input).message.content[1];
      assert.equal(image.type, 'image');
      assert.equal(image.source.media_type, 'image/png');
      assert.equal(image.source.data, PNG.toString('base64'));
    }
    assert.equal((await readFile(path)).toString('base64'), PNG.toString('base64'));
  });
  for (const mode of ['nonzero', 'malformed', 'incomplete', 'oversized', 'stderr', 'tools', 'trailing']) {
    test(`${provider} rejects ${mode} without accepting a routing decision or exposing stderr`, async t => {
      const f = await fixture(t, provider, mode);
      await assert.rejects(runAutoPromptModel(f.request, f.dependencies), error => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes('token-private'));
        return true;
      });
      assert.deepEqual(await readdir(join(f.directory, 'state', 'tmp')), []);
    });
  }
  test(`${provider} accepts complete final event without a trailing newline`, async t => {
    const f = await fixture(t, provider, 'no-newline');
    assert.deepEqual(await runAutoPromptModel(f.request, f.dependencies), DECISION);
  });
}

for (const mode of ['missing-structured', 'error-result', 'tool-call']) {
  test(`Claude rejects ${mode} even if result text resembles JSON`, async t => {
    const f = await fixture(t, 'claude', mode);
    await assert.rejects(runAutoPromptModel(f.request, f.dependencies));
  });
}
test('Claude reports only bounded event names for unsupported protocol frames', async t => {
  const knownName = await fixture(t, 'claude', 'unknown-system');
  await assert.rejects(runAutoPromptModel(knownName.request, knownName.dependencies), {
    message: 'Auto Prompt: Claude Code returned an unsupported routing event (system/fixture_unknown).',
  });
  const unsafeName = await fixture(t, 'claude', 'unsafe-event-name');
  await assert.rejects(runAutoPromptModel(unsafeName.request, unsafeName.dependencies), {
    message: 'Auto Prompt: Claude Code returned an unsupported routing event (unknown/unknown).',
  });
});
test('Claude accepts documented retry and thinking progress before and between response frames', async t => {
  const f = await fixture(t, 'claude', 'success', [
    ...CLAUDE_PROGRESS,
    { ...CLAUDE_PROGRESS[0], error_status: 429, error: 'rate_limit', no_response: { waited_ms: 10000, retry_wait_ms: 20000 } },
  ]);
  assert.deepEqual(await runAutoPromptModel(f.request, f.dependencies), DECISION);
});
for (const mode of ['incomplete', 'error-result', 'tool-call', 'unknown-system']) {
  test(`Claude progress cannot hide ${mode}`, async t => {
    const f = await fixture(t, 'claude', mode, CLAUDE_PROGRESS);
    await assert.rejects(runAutoPromptModel(f.request, f.dependencies));
    assert.deepEqual(await readdir(join(f.directory, 'state', 'tmp')), []);
  });
}
test('Claude rejects malformed progress and execution events', async t => {
  const invalid = [
    { ...CLAUDE_PROGRESS[0], attempt: '1' },
    { ...CLAUDE_PROGRESS[0], error_status: '429' },
    { ...CLAUDE_PROGRESS[0], error: 'private diagnostic text' },
    { ...CLAUDE_PROGRESS[0], no_response: { waited_ms: 1 } },
    { ...CLAUDE_PROGRESS[1], estimated_tokens_delta: 0.5 },
    { ...CLAUDE_PROGRESS[1], user_message_uuid: {} },
    { ...CLAUDE_PROGRESS[2], content: {} },
    { ...CLAUDE_PROGRESS[2], uuid: undefined },
    { ...CLAUDE_PROGRESS[0], subtype: 'api_error' },
    { ...CLAUDE_PROGRESS[2], subtype: 'hook_started', hook_name: 'fixture' },
    { ...CLAUDE_PROGRESS[2], type: 'tool_progress', tool_name: 'Bash' },
  ];
  for (const frame of invalid) {
    const f = await fixture(t, 'claude', 'success', [frame]);
    await assert.rejects(runAutoPromptModel(f.request, f.dependencies), /unsupported routing event/);
  }
});
test('Codex never extracts a JSON substring from a malformed decision', async t => {
  const f = await fixture(t, 'codex', 'bad-decision');
  await assert.rejects(runAutoPromptModel(f.request, f.dependencies), /malformed structured/);
});

test('Codex accepts only the known fail-closed code-mode startup warning', async t => {
  const safe = await fixture(t, 'codex', 'safe-warning');
  assert.deepEqual(await runAutoPromptModel(safe.request, safe.dependencies), DECISION);
  const unknown = await fixture(t, 'codex', 'startup-error');
  await assert.rejects(runAutoPromptModel(unknown.request, unknown.dependencies), /unsupported routing configuration/);
});

test('native interpreter PATH retains only absolute entries and Finder fallback locations', async t => {
  const f = await fixture(t);
  f.dependencies.env = { PATH: ':relative:/fixture/absolute', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'unrelated' };
  await runAutoPromptModel(f.request, f.dependencies);
  const env = f.launched().options.env;
  assert.ok(env.PATH.includes('/fixture/absolute'));
  assert.ok(env.PATH.includes('/usr/local/bin'));
  assert.ok(env.PATH.includes('/opt/homebrew/bin'));
  assert.ok(!env.PATH.split(':').some((entry: string) => !entry.startsWith('/')));
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
});

for (const abort of [false, true]) {
  test(`${abort ? 'cancellation' : 'timeout'} waits for process termination and temp cleanup`, async t => {
    const f = await fixture(t, 'codex', 'hang');
    f.dependencies.timeoutMs = abort ? 3000 : 150;
    const result = runAutoPromptModel(f.request, f.dependencies);
    if (abort) setTimeout(() => f.controller.abort(), 150);
    await assert.rejects(result, abort ? { name: 'AbortError' } : /timed out/);
    assert.throws(() => process.kill(f.launched().pid!, 0));
    assert.deepEqual(await readdir(join(f.directory, 'state', 'tmp')), []);
  });
}

test('orphaned descendant holding stdout is terminated before routing settles', async t => {
  const f = await fixture(t, 'codex', 'orphan');
  await assert.rejects(runAutoPromptModel(f.request, f.dependencies), /unfinished routing process/);
  const pid = Number(await readFile(join(f.directory, 'orphan.pid'), 'utf8'));
  for (let attempt = 0; attempt < 20; attempt++) {
    try { process.kill(pid, 0); await delay(10); } catch { return; }
  }
  assert.fail('orphan process survived routing cleanup');
});

test('already cancelled and unsupported-model requests never launch a native process', async t => {
  const f = await fixture(t);
  f.controller.abort();
  await assert.rejects(runAutoPromptModel(f.request, f.dependencies), { name: 'AbortError' });
  await assert.rejects(runAutoPromptModel({ ...f.request, signal: new AbortController().signal, model: 'automatic-fallback' }, f.dependencies), /unsupported/);
  assert.equal(f.launched(), undefined);
});

test('invalid images fail before native launch and temporary data is removed', async t => {
  const f = await fixture(t);
  const path = join(f.directory, 'not-an-image');
  await writeFile(path, 'not an image');
  await assert.rejects(runAutoPromptModel({ ...f.request, imagePaths: [path] }, f.dependencies), /unsupported/);
  assert.equal(f.launched(), undefined);
  assert.deepEqual(await readdir(join(f.directory, 'state', 'tmp')), []);
  assert.equal((await stat(path)).isFile(), true);
});
