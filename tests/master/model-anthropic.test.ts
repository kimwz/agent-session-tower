import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anthropicMessages, claudeInput, CLAUDE_ANSWER, routedModel } from '../../server/master/model-anthropic.js';
import type { ModelCall, ModelRequest } from '../../server/master/model-openai.js';
import { MasterJournal } from '../../server/master/journal.js';
import { MasterRoom } from '../../server/master/room.js';
import { MasterService } from '../../server/master/service.js';
import { MasterSettingsStore } from '../../server/master/settings.js';
import { TowerClient } from '../../server/master/tower-client.js';
import { until } from '../helpers/until.js';

const KEY = 'sk-ant-test-0123456789abcdef';

/** One streamed Claude answer: thinking, text, and optionally a tool call. */
function answer(text: string, call?: { id: string; name: string; input: unknown }, stop = call ? 'tool_use' : 'end_turn') {
  const events: Array<Record<string, unknown>> = [
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-kept-as-is' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    ...[...text].length ? [{ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: text.slice(0, 2) } }, { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: text.slice(2) } }] : [],
    { type: 'content_block_stop', index: 1 },
  ];
  if (call) events.push(
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } },
    { type: 'content_block_stop', index: 2 },
  );
  events.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } }, { type: 'message_stop' });
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

function fakeAnthropic(replies: Array<string | { status: number; body: unknown }>) {
  const sent: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    const reply = replies.shift();
    if (reply === undefined) throw new Error('no more replies');
    if (typeof reply !== 'string') return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
    return new Response(new ReadableStream({ start(controller) {
      // Split mid-event to prove events are reassembled.
      controller.enqueue(new TextEncoder().encode(reply.slice(0, 41)));
      controller.enqueue(new TextEncoder().encode(reply.slice(41)));
      controller.close();
    } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  return { fetcher, sent };
}

const request = (patch: Partial<ModelRequest> = {}): ModelRequest => ({ model: 'claude-opus-5', effort: 'low', instructions: 'standing instructions', input: [{ type: 'message', role: 'user', content: '안녕' }], tools: [], ...patch });

test('Claude streams text as it comes and gives its whole answer and calls in the turn\'s shape, with the key only in the header', async () => {
  const { fetcher, sent } = fakeAnthropic([answer('안녕하세요', { id: 'toolu_1', name: 'tower_api', input: { method: 'GET', path: '/api/snapshot' } })]);
  const deltas: string[] = [];
  const tools = [{ type: 'function' as const, name: 'tower_api', description: 'call', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, strict: true }];
  const result = await anthropicMessages(() => KEY, { fetch: fetcher })(request({ effort: 'none', tools, input: [{ type: 'message', role: 'developer', content: 'Now: t' }, { type: 'message', role: 'user', content: '안녕' }] }), delta => deltas.push(delta), new AbortController().signal);
  assert.deepEqual(deltas, ['안녕', '하세요']);
  assert.equal(result.text, '안녕하세요');
  assert.equal(result.output[0].type, CLAUDE_ANSWER);
  assert.deepEqual((result.output[0].content as Array<{ type: string }>).map(block => block.type), ['thinking', 'text', 'tool_use']);
  assert.deepEqual(result.output.slice(1), [{ type: 'function_call', call_id: 'toolu_1', name: 'tower_api', arguments: '{"method":"GET","path":"/api/snapshot"}', claude: true }]);
  const [{ url, headers, body }] = sent;
  assert.match(url, /^https:\/\/api\.anthropic\.com\/v1\/messages/);
  assert.equal(headers.get('x-api-key'), KEY);
  assert.equal(headers.get('authorization'), null);
  assert.doesNotMatch(JSON.stringify(body), /sk-ant/);
  assert.equal(body.model, 'claude-opus-5');
  assert.equal(body.stream, true);
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.deepEqual(body.output_config, { effort: 'low' }, '"none" is Claude\'s least effort; thinking is never turned off');
  assert.deepEqual(body.tool_choice, { type: 'auto' });
  assert.deepEqual(body.tools, [{ name: 'tower_api', description: 'call', input_schema: tools[0].parameters }]);
  assert.deepEqual(body.system, [{ type: 'text', text: 'standing instructions', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'Now: t' }]);
  assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'text', text: '안녕' }] }]);
});

test('reasoning levels map to Claude effort', async () => {
  for (const [effort, expected] of [['low', 'low'], ['medium', 'medium'], ['high', 'high']]) {
    const { fetcher, sent } = fakeAnthropic([answer('ok')]);
    await anthropicMessages(() => KEY, { fetch: fetcher })(request({ effort, model: 'claude-opus-5-5' }), () => {}, new AbortController().signal);
    assert.deepEqual(sent[0].body.output_config, { effort: expected });
    assert.equal(sent[0].body.model, 'claude-opus-5-5');
  }
});

test('a missing, refused or rate-limited key says so in the owner\'s words', async () => {
  await assert.rejects(anthropicMessages(() => undefined)(request(), () => {}, new AbortController().signal), /Anthropic API 키가 설정되지 않았습니다/);
  const refused = fakeAnthropic([{ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }]);
  await assert.rejects(anthropicMessages(() => KEY, { fetch: refused.fetcher })(request(), () => {}, new AbortController().signal), (error: Error & { status?: number }) => /키를 거부/.test(error.message) && error.status === 401);
  const missing = fakeAnthropic([{ status: 404, body: { type: 'error', error: { type: 'not_found_error', message: 'model: claude-opus-9' } } }]);
  await assert.rejects(anthropicMessages(() => KEY, { fetch: missing.fetcher })(request(), () => {}, new AbortController().signal), /Anthropic 오류 \(404\): model: claude-opus-9/);
});

test('a refusal is an error, and a call cut off by the length limit is not run', async () => {
  const refusal = fakeAnthropic([answer('', undefined, 'refusal')]);
  await assert.rejects(anthropicMessages(() => KEY, { fetch: refusal.fetcher })(request(), () => {}, new AbortController().signal), /답하지 않았습니다/);
  const cut = fakeAnthropic([answer('긴 답', { id: 'toolu_x', name: 'tower_api', input: {} }, 'max_tokens')]);
  const result = await anthropicMessages(() => KEY, { fetch: cut.fetcher })(request(), () => {}, new AbortController().signal);
  assert.equal(result.output.length, 1);
  assert.deepEqual((result.output[0].content as Array<{ type: string }>).map(block => block.type), ['thinking', 'text']);
  assert.equal(result.text, '긴 답');
});

test('the turn reads into Claude messages: its answer as it came, a step\'s results together, pictures and PDFs as blocks', () => {
  const kept = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'a', input: {} }, { type: 'tool_use', id: 't2', name: 'b', input: {} }];
  const { system, messages } = claudeInput(request({ input: [
    { type: 'message', role: 'developer', content: 'Now: t' },
    { type: 'message', role: 'assistant', content: '이전 답' },
    { type: 'message', role: 'user', content: '' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '이 사진' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' }, { type: 'input_file', filename: 'a.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' }, { type: 'input_image', image_url: 'data:image/tiff;base64,AAAA' }] },
    { type: CLAUDE_ANSWER, content: kept },
    { type: 'function_call', call_id: 't1', name: 'a', arguments: '{}', claude: true },
    { type: 'function_call', call_id: 't2', name: 'b', arguments: '{}', claude: true },
    { type: 'function_call_output', call_id: 't1', output: '{"ok":true}' },
    { type: 'function_call_output', call_id: 't2', output: '' },
    { type: 'reasoning', encrypted_content: 'x' },
  ] }));
  assert.equal(system.length, 2);
  assert.deepEqual(messages, [
    { role: 'user', content: '(The conversation so far:)' },
    { role: 'assistant', content: [{ type: 'text', text: '이전 답' }] },
    { role: 'user', content: [{ type: 'text', text: '이 사진' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' }, title: 'a.pdf' }] },
    { role: 'assistant', content: kept },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"ok":true}' }, { type: 'tool_result', tool_use_id: 't2', content: '(empty)' }] },
  ]);
});

test('requests go to the API their model belongs to', async () => {
  const seen: string[] = [];
  const fake = (name: string): ModelCall => async () => { seen.push(name); return { output: [], text: '' }; };
  const model = routedModel(fake('openai'), fake('anthropic'));
  for (const name of ['gpt-6-luna', 'claude-opus-5', 'claude-opus-5-5', 'gpt-6-sol']) await model(request({ model: name }), () => {}, new AbortController().signal);
  assert.deepEqual(seen, ['openai', 'anthropic', 'anthropic', 'openai']);
});

test('the Anthropic key is kept in its own file, never shown, and a Claude model needs it while GPT keeps its own key', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-master-claude-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const settings = new MasterSettingsStore(dir);
  await settings.start();
  await settings.update({ apiKey: 'sk-openai-0123456789' });
  const room = new MasterRoom(dir); await room.start();
  const journal = new MasterJournal(dir); await journal.start();
  const { fetcher, sent } = fakeAnthropic([
    answer('', { id: 'toolu_1', name: 'tower_query', input: { sql: 'select 1' } }),
    answer('세션이 없습니다.'),
  ]);
  const openai: ModelCall = async () => ({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'GPT 답' }] }], text: 'GPT 답' });
  const service = new MasterService({ settings, room, journal, tower: new TowerClient(), readDb: { query: async () => ({ rows: [{ one: 1 }] }) } as never, model: routedModel(openai, anthropicMessages(() => settings.anthropicKey(), { fetch: fetcher })), taskPollMs: 1000 });
  await service.start();
  t.after(() => service.close());

  let overview = await service.updateSettings({ model: 'claude-opus-5' });
  assert.equal(overview.configured, false, 'a Claude model with only an OpenAI key cannot answer');
  assert.equal(overview.state, 'unconfigured');
  assert.equal(overview.keyHint, '…6789');
  assert.equal(overview.anthropicKeyHint, undefined);

  overview = await service.updateSettings({ anthropicKey: KEY });
  assert.equal(overview.configured, true);
  assert.equal(overview.anthropicKeyHint, '…cdef');
  assert.equal(overview.keyHint, '…6789', 'the OpenAI key stays');
  assert.doesNotMatch(JSON.stringify(overview), /sk-ant|sk-openai/);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'anthropic-key.json'), 'utf8')), { apiKey: KEY });
  assert.doesNotMatch(await readFile(join(dir, 'settings.json'), 'utf8'), /sk-/);

  await service.send({ clientMessageId: 'message-claude-1', text: '세션 있어?', local: true });
  await until(() => room.recent(20).find(entry => entry.data.kind === 'master' && entry.data.final));
  const final = room.recent(20).find(entry => entry.data.kind === 'master' && entry.data.final)!;
  assert.equal(final.data.kind === 'master' && final.data.text, '세션이 없습니다.');
  assert.equal(sent.length, 2);
  // The second step sends Claude's first answer back unchanged (thinking signature included) and the tool result after it.
  const second = sent[1].body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  const [assistant, results] = second.slice(-2);
  assert.equal(assistant.role, 'assistant');
  assert.deepEqual(assistant.content.map(block => block.type), ['thinking', 'text', 'tool_use']);
  assert.equal(assistant.content[0].signature, 'sig-kept-as-is');
  assert.equal(results.role, 'user');
  assert.equal(results.content[0].type, 'tool_result');
  assert.equal(results.content[0].tool_use_id, 'toolu_1');

  // A message may still choose a GPT model; it goes to OpenAI with the OpenAI key untouched.
  await service.send({ clientMessageId: 'message-gpt-1', text: 'GPT로', local: true, model: 'gpt-6-luna' });
  await until(() => room.recent(20).find(entry => entry.data.kind === 'master' && entry.data.text === 'GPT 답'));
  assert.equal(sent.length, 2);

  // Removing the key leaves the OpenAI key, and the Claude model waits for a key again.
  overview = await service.updateSettings({ anthropicKey: null });
  assert.equal(overview.configured, false);
  assert.equal(overview.keyHint, '…6789');
  const reread = new MasterSettingsStore(dir); await reread.start();
  assert.equal(reread.anthropicKey(), undefined);
  assert.equal(reread.key(), 'sk-openai-0123456789');
  await assert.rejects(service.updateSettings({ anthropicKey: 'short' }), /Anthropic API 키 형식/);
});
