import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { SessionService } from '../../../server/sessions/service.js';

const id = '33333333-3333-4333-8333-333333333333';
const timestamp = '2026-10-01T00:00:00.000Z';
const lines = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const answer = (messageId: string, effort?: string, model = 'claude-opus-5-5') => ({ type: 'assistant', sessionId: id, timestamp, ...(effort ? { effort } : {}),
  message: { id: messageId, model, role: 'assistant', content: [{ type: 'text', text: `Answer ${messageId}` }] } });
const turn = (effort?: string, model = 'gpt-6.1-sol') => ({ type: 'turn_context', timestamp, payload: { model, cwd: '/work', ...(effort ? { effort } : {}) } });

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-effort-'));
  const codexHome = join(directory, 'codex'); const claudeHome = join(directory, 'claude');
  await Promise.all([mkdir(join(codexHome, 'sessions'), { recursive: true }), mkdir(join(claudeHome, 'projects', 'test'), { recursive: true })]);
  const service = new SessionService({ codexHome, claudeHome, inspectProcesses: async () => ({ claude: new Map(), codex: new Set(), providerRunning: { codex: false, claude: false } }) });
  t.after(async () => { service.stop(); await rm(directory, { recursive: true, force: true }); });
  return { service, codex: join(codexHome, 'sessions', `rollout-${id}.jsonl`), claude: join(claudeHome, 'projects', 'test', `${id}.jsonl`) };
}

test('a Claude session takes its effort from the latest answer, per answer and never from an older one', async t => {
  const f = await fixture(t);
  await writeFile(f.claude, lines({ type: 'user', sessionId: id, cwd: '/work', timestamp, message: { role: 'user', content: 'Go' } }, answer('a1', 'high')));
  await f.service.refresh();
  assert.equal(f.service.get(`claude:${id}`)?.effort, 'high');
  // A later row of the same answer without the field keeps it.
  await appendFile(f.claude, lines(answer('a1')));
  await f.service.refresh();
  assert.equal(f.service.get(`claude:${id}`)?.effort, 'high');
  // An API error row is no answer.
  await appendFile(f.claude, lines(answer('err', undefined, '<synthetic>')));
  await f.service.refresh();
  assert.equal(f.service.get(`claude:${id}`)?.effort, 'high');
  await appendFile(f.claude, lines(answer('a2', 'max')));
  await f.service.refresh();
  assert.equal(f.service.get(`claude:${id}`)?.effort, 'max');
  // A newer answer that states no effort leaves it unknown rather than reusing the older one.
  await appendFile(f.claude, lines(answer('a3')));
  await f.service.refresh();
  assert.equal(f.service.get(`claude:${id}`)?.effort, undefined);
  assert.equal(f.service.get(`claude:${id}`)?.model, 'claude-opus-5-5');
});

test('a Codex session takes its effort from each turn context', async t => {
  const f = await fixture(t);
  await writeFile(f.codex, lines({ type: 'session_meta', timestamp, payload: { id, cwd: '/work' } }, turn('xhigh')));
  await f.service.refresh();
  assert.deepEqual([f.service.get(`codex:${id}`)?.model, f.service.get(`codex:${id}`)?.effort], ['gpt-6.1-sol', 'xhigh']);
  await appendFile(f.codex, lines(turn(undefined, 'gpt-6.1-sol')));
  await f.service.refresh();
  assert.equal(f.service.get(`codex:${id}`)?.effort, undefined, 'a turn that states none is not given the previous one');
  await appendFile(f.codex, lines(turn('low')));
  await f.service.refresh();
  assert.equal(f.service.get(`codex:${id}`)?.effort, 'low');
});

test('the full-text read keeps what the person and the agent said whole; the page view keeps its cap', async t => {
  const f = await fixture(t);
  const long = `${'a'.repeat(150_000)}END-OF-REQUEST`;
  const output = `${'o'.repeat(150_000)}TOOL-END`;
  await writeFile(f.claude, lines({ type: 'user', sessionId: id, cwd: '/work', timestamp, message: { role: 'user', content: long } },
    { type: 'assistant', sessionId: id, timestamp, message: { id: 'b1', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', sessionId: id, timestamp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: output }] } }));
  await f.service.refresh();
  const shown = await f.service.detail(`claude:${id}`, undefined, 50);
  assert.ok(shown?.messages[0].text.endsWith('… [truncated]'), 'pages keep the display cap');
  const full = await f.service.detail(`claude:${id}`, undefined, 50, { fullText: true });
  assert.equal(full?.messages[0].text, long);
  assert.ok(!full?.messages.find(message => message.toolName === 'result')?.text.includes('TOOL-END'), 'tool output keeps the cap');
});

test('a background task notice keeps its whole result in the full-text read', async t => {
  const f = await fixture(t);
  const result = `${'r'.repeat(120_000)} PR https://github.com/o/r/pull/9`;
  const notice = `<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>Background command finished</summary>\n<result>${result}</result>\n</task-notification>`;
  await writeFile(f.claude, lines({ type: 'user', sessionId: id, cwd: '/work', timestamp, message: { role: 'user', content: 'Go' } },
    { type: 'user', sessionId: id, timestamp, origin: { kind: 'task-notification' }, message: { role: 'user', content: [{ type: 'text', text: notice }] } }));
  await f.service.refresh();
  const full = await f.service.detail(`claude:${id}`, undefined, 50, { fullText: true });
  assert.ok(full?.messages.some(message => message.role === 'system' && message.text.includes('pull/9')), JSON.stringify(full?.messages.map(message => message.text.slice(-80))));
});

test("Tower's hidden instructions come back only in the full read, as a message of their own", async t => {
  const f = await fixture(t);
  await writeFile(f.claude, lines({ type: 'user', sessionId: id, cwd: '/work', timestamp, message: { role: 'user', content: [{ type: 'text', text: 'Continue the work' },
    { type: 'text', text: '<tower-instructions>\nHidden note\n</tower-instructions>' }] } }));
  await f.service.refresh();
  const shown = await f.service.detail(`claude:${id}`, undefined, 50);
  assert.deepEqual(shown?.messages.map(message => message.text), ['Continue the work']);
  const full = await f.service.detail(`claude:${id}`, undefined, 50, { fullText: true });
  assert.deepEqual(full?.messages.map(message => [message.role, message.toolName, message.text]), [['user', undefined, 'Continue the work'], ['system', 'tower-instructions', 'Hidden note']]);
});
