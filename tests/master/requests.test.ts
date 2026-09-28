import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { masterAttachments, MASTER_CONVERSATION } from '../../server/master/attachments.js';
import { MasterJournal } from '../../server/master/journal.js';
import type { ModelCall, ModelRequest } from '../../server/master/model-openai.js';
import { MasterRoom } from '../../server/master/room.js';
import { MasterService } from '../../server/master/service.js';
import { MasterSettingsStore } from '../../server/master/settings.js';
import { TowerClient } from '../../server/master/tower-client.js';
import type { MasterEntry } from '../../shared/master.js';
import { until } from '../helpers/until.js';

const answer = (text: string) => ({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], text });
const b64 = (text: string) => Buffer.from(text).toString('base64');

/** A master whose model answers with `reply` (or fails when it throws), recording every request. */
async function master(t: test.TestContext, reply: (request: ModelRequest, index: number, signal: AbortSignal) => Promise<ReturnType<typeof answer>> | ReturnType<typeof answer>) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-master-requests-'));
  const store = await masterAttachments(dir);
  const settings = new MasterSettingsStore(dir);
  await settings.start();
  await settings.update({ apiKey: 'sk-test-0123456789abcdef' });
  const room = new MasterRoom(dir);
  await room.start();
  const journal = new MasterJournal(dir);
  await journal.start();
  const requests: ModelRequest[] = [];
  const model: ModelCall = async (request, _onText, signal) => { requests.push(structuredClone(request)); signal.throwIfAborted(); return reply(request, requests.length - 1, signal); };
  const service = new MasterService({ settings, room, journal, tower: new TowerClient(), model, attachments: store, taskPollMs: 1000, retryMs: 10 });
  await service.start();
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  const owner = (id: string) => room.get(id)?.data as Extract<MasterEntry['data'], { kind: 'owner' }>;
  return { service, room, store, requests, owner };
}

test('a PDF is read by the model itself, a short text file as its text with keys hidden, and other files by their path', async t => {
  const { service, store, requests } = await master(t, () => answer('봤습니다.'));
  const key = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD';
  const { attachments } = await store.prepare(MASTER_CONVERSATION, { attachments: [
    { name: 'report.pdf', mimeType: 'application/pdf', data: b64('%PDF-1.4\n%fake\n') },
    { name: 'config.yaml', mimeType: '', data: b64(`name: tower\ntoken: ${key}\n`) },
    { name: 'archive.zip', mimeType: 'application/zip', data: b64('PK\u0003\u0004binary') },
  ] });
  await service.send({ clientMessageId: 'files-00001', text: '이 파일들 봐줘', local: true, attachments });
  await until(() => requests.length === 1);
  const parts = requests[0].input.at(-1)!.content as Array<Record<string, string>>;
  assert.equal(parts.length, 2, 'the text, then the PDF');
  assert.deepEqual(parts[1], { type: 'input_file', filename: 'report.pdf', file_data: `data:application/pdf;base64,${b64('%PDF-1.4\n%fake\n')}` });
  const text = parts[0].text;
  assert.match(text, /"report\.pdf" \(application\/pdf, \d+ bytes\), attachment 1 below/);
  assert.match(text, /"config\.yaml" .*Its text:\n<file name="config\.yaml">\nname: tower\ntoken: /);
  assert.ok(!text.includes(key), 'a key in a text file never reaches the model');
  assert.match(text, /"archive\.zip" \(application\/zip, \d+ bytes\), kept on this computer at ".*archive\.zip"; its content is not shown to you/);
});

test('a message may choose its own model and reasoning, and shares a turn only with messages that chose the same', async t => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const { service, requests, owner } = await master(t, async (_request, index) => { if (index === 0) await held; return answer('네.'); });
  await service.send({ clientMessageId: 'first-00001', text: '먼저', local: true });
  await until(() => requests.length === 1);
  const chosen = await service.send({ clientMessageId: 'sol-000001', text: '자세히 봐줘', local: true, model: 'gpt-6-sol', effort: 'high' });
  await service.send({ clientMessageId: 'plain-00001', text: '그리고 이것도', local: true });
  assert.equal(owner(chosen.id).model, 'gpt-6-sol', 'the conversation shows the choice');
  assert.equal(owner(chosen.id).effort, 'high');
  release();
  await until(() => requests.length === 3);
  assert.deepEqual([requests[0].model, requests[0].effort], ['gpt-6-luna', 'low'], 'without a choice, the settings decide');
  const [second, third] = [requests[1], requests[2]];
  const asked = (request: ModelRequest) => String(request.input.at(-1)!.content);
  assert.deepEqual([second.model, second.effort, asked(second)], ['gpt-6-sol', 'high', '자세히 봐줘'], 'the chosen message has a turn of its own');
  assert.deepEqual([third.model, third.effort, asked(third)], ['gpt-6-luna', 'low', '그리고 이것도']);
});

test('a request that failed can be sent again, with its files and choices, once however often it is pressed', async t => {
  const { service, room, store, requests, owner } = await master(t, (_request, index) => { if (index < 2) throw new Error('OpenAI 오류 (500): busy'); return answer('이번엔 됐습니다.'); });
  const { attachments } = await store.prepare(MASTER_CONVERSATION, { attachments: [{ name: 'a.txt', mimeType: 'text/plain', data: b64('hello') }] });
  const sent = await service.send({ clientMessageId: 'fail-000001', text: '해 줘', local: true, attachments, model: 'gpt-6-sol' });
  // Tried once more by itself, then given up: only then may the owner send it again.
  await until(() => owner(sent.id).outcome === 'failed');
  assert.equal(requests.length, 2);
  await assert.rejects(service.retry(randomId(), { local: true }), /찾을 수 없습니다/);
  const [again, twice] = await Promise.all([service.retry(sent.id, { local: false, viewContext: { tabId: 'tab-2' } }), service.retry(sent.id, { local: false })]);
  assert.equal(again.id, twice.id, 'pressed twice, it is sent once');
  assert.equal(owner(sent.id).retried, true);
  await until(() => room.recent(20).some(entry => entry.data.kind === 'master' && entry.data.text === '이번엔 됐습니다.'));
  assert.equal(requests.length, 3);
  assert.equal(requests[2].model, 'gpt-6-sol');
  assert.match(String(requests[2].input.at(-1)!.content), /^해 줘\n\[attached files\]\n- "a\.txt"/);
  assert.deepEqual(owner(again.id).attachments, attachments);
  assert.equal(owner(again.id).outcome, undefined);
});

test('a stopped request is marked so it can be sent again', async t => {
  const { service, requests, owner } = await master(t, (_request, _index, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  const sent = await service.send({ clientMessageId: 'stop-000001', text: '오래 걸리는 일', local: true });
  await until(() => requests.length === 1);
  assert.equal(service.stop(), true);
  await until(() => owner(sent.id).outcome === 'cancelled');
  await assert.rejects(service.retry(randomId(), { local: true }), /찾을 수 없습니다/);
});

function randomId() { return '0b8f1c1e-5d0a-4f43-9c55-2a8d3f1b6e7a'; }
