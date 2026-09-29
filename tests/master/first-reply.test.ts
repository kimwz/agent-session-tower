import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { acceptFirstReply, FirstReplyMaker, type FirstReplyOptions } from '../../server/master/first-reply.js';
import { until } from '../helpers/until.js';

/** A fake Claude Code process: answers each request line with what `answer` gives. */
class FakeClaude extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = undefined;
  killed: string[] = [];
  requests: string[] = [];
  constructor(readonly args: string[], readonly env: NodeJS.ProcessEnv, answer: (request: string, fake: FakeClaude) => string[] | undefined) {
    super();
    let buffer = '';
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        const request = message.message.content[0].text as string;
        this.requests.push(request);
        for (const frame of answer(request, this) ?? []) this.stdout.write(`${frame}\n`);
      }
    });
  }
  kill(signal: string) { this.killed.push(signal); if (this.killed.length === 1) setImmediate(() => this.emit('exit', null, signal)); return true; }
}

const init = (tools: string[] = []) => JSON.stringify({ type: 'system', subtype: 'init', tools, mcp_servers: [] });
const result = (text: string) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text });
const assistant = (content: unknown[]) => JSON.stringify({ type: 'assistant', message: { content } });

async function setup(answer: (request: string, fake: FakeClaude) => string[] | undefined, extra: Partial<FirstReplyOptions> = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'first-reply-'));
  const spawned: FakeClaude[] = [];
  const checks: NodeJS.ProcessEnv[] = [];
  const maker = new FirstReplyMaker({
    stateDir,
    env: { ANTHROPIC_API_KEY: 'sk-test', OPENAI_API_KEY: 'sk-test', CLAUDECODE: '1' },
    findExecutable: async () => '/x/claude',
    checkSubscription: async (_executable, _cwd, env) => { checks.push(env); },
    afterUpdating: (_dir, _provider, _signal, use) => use(),
    spawnProcess: ((_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      const fake = new FakeClaude(args, options.env, answer);
      spawned.push(fake);
      return fake;
    }) as unknown as FirstReplyOptions['spawnProcess'],
    ...extra,
  });
  return { maker, spawned, checks, stateDir, done: async () => { maker.close(); await rm(stateDir, { recursive: true, force: true }); } };
}

test('a waiting process answers the first reply once, and another waits for the next request', async () => {
  const { maker, spawned, checks, done } = await setup(() => [init(), assistant([{ type: 'text', text: 'SORI 광고 성과를 확인해 볼게요.' }]), result('SORI 광고 성과를 확인해 볼게요.')]);
  try {
    maker.prepare();
    await until(() => spawned.length === 1);
    const reply = await maker.make('SORI 광고 성과 어제 거 알려줘', new AbortController().signal);
    assert.deepEqual(reply, { text: 'SORI 광고 성과를 확인해 볼게요.', warm: true });
    assert.match(spawned[0].requests[0], /SORI 광고 성과 어제 거 알려줘/);
    // Used once, then stopped; a fresh one waits.
    assert.ok(spawned[0].killed.length);
    await until(() => spawned.length === 2);
    assert.equal(spawned[1].killed.length, 0);
    // Every process started only after its sign-in was checked.
    assert.equal(checks.length, 2);
    const { args, env } = spawned[0];
    for (const flag of ['--no-session-persistence', '--strict-mcp-config', '--safe-mode']) assert.ok(args.includes(flag), flag);
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.equal(args[args.indexOf('--model') + 1], 'haiku');
    assert.equal(env.MAX_THINKING_TOKENS, '0');
    for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDECODE']) assert.equal(env[name], undefined, name);
  } finally { await done(); }
});

test('without a waiting process a request starts one, and nothing waits once voice is off', async () => {
  const { maker, spawned, done } = await setup(() => [init(), result('배포 상태를 확인해 볼게요.')]);
  try {
    const reply = await maker.make('배포 상태 봐줘', new AbortController().signal);
    assert.deepEqual(reply, { text: '배포 상태를 확인해 볼게요.', warm: false });
    await new Promise(resolve => setTimeout(resolve, 20));
    // Voice was never on: no process is kept waiting.
    assert.equal(spawned.length, 1);
    maker.prepare();
    await until(() => maker.processes() === 1);
    maker.close();
    await until(() => maker.processes() === 0);
  } finally { await done(); }
});

test('no sign-in by subscription, no process and nothing said', async () => {
  const { maker, spawned, done } = await setup(() => [init(), result('확인해 볼게요.')], { checkSubscription: async () => { throw new Error('api key'); } });
  try {
    assert.deepEqual(await maker.make('배포 상태 봐줘', new AbortController().signal), { skipped: 'failed', warm: false });
    assert.equal(spawned.length, 0);
  } finally { await done(); }
});

test('a process that offers or uses a tool is stopped and says nothing', async () => {
  for (const frames of [[init(['Bash']), result('확인해 볼게요.')], [init(), assistant([{ type: 'tool_use', name: 'Bash' }]), result('확인해 볼게요.')], [init(), JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true })], ['not json']]) {
    const { maker, spawned, done } = await setup(() => frames);
    try {
      assert.deepEqual(await maker.make('배포 상태 봐줘', new AbortController().signal), { skipped: 'failed', warm: false });
      assert.ok(spawned[0].killed.length);
    } finally { await done(); }
  }
});

test('the model saying nothing, and a cancelled request, say nothing', async () => {
  const { maker, done } = await setup(request => request.includes('안녕') ? [init(), result('-')] : undefined);
  try {
    assert.deepEqual(await maker.make('안녕', new AbortController().signal), { skipped: 'model', warm: false });
    const controller = new AbortController();
    const asked = maker.make('배포 상태 봐줘', controller.signal);
    setTimeout(() => controller.abort(), 10);
    assert.deepEqual(await asked, { skipped: 'failed', warm: false });
  } finally { await done(); }
});

test('a waiting process too old for its sign-in check is replaced', async () => {
  const { maker, spawned, checks, done } = await setup(() => [init(), result('확인해 볼게요.')], { warmMs: 30 });
  try {
    maker.prepare();
    await until(() => spawned.length >= 2);
    assert.ok(spawned[0].killed.length);
    assert.ok(checks.length >= 2);
  } finally { await done(); }
});

test('only a short spoken sentence with no new number is said', () => {
  assert.equal(acceptFirstReply('"배포 상태를 확인해 볼게요."', '배포 상태 봐줘'), '배포 상태를 확인해 볼게요.');
  assert.equal(acceptFirstReply('-', '안녕'), undefined);
  assert.equal(acceptFirstReply('무엇을 볼까요?', '음'), undefined);
  assert.equal(acceptFirstReply('어제 매출은 30% 올랐어요.', '어제 매출 알려줘'), undefined);
  assert.equal(acceptFirstReply('3번 세션을 확인해 볼게요.', '3번 세션 봐줘'), '3번 세션을 확인해 볼게요.');
  assert.equal(acceptFirstReply('확인해 볼게요.\n그리고', '봐줘'), undefined);
  assert.equal(acceptFirstReply('가'.repeat(61), '봐줘'), undefined);
});

test('a process started to wait is dropped when voice went off while it started', async () => {
  let release: (() => void) | undefined;
  const { maker, spawned, done } = await setup(() => [init(), result('확인해 볼게요.')], { checkSubscription: () => new Promise<void>(resolve => { release = resolve; }) });
  try {
    maker.prepare();
    await until(() => release);
    maker.close();
    release!();
    await until(() => spawned.length === 1 && spawned[0].killed.length > 0);
    await until(() => maker.processes() === 0);
  } finally { await done(); }
});
