import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileList, masterAttachments, MASTER_CONVERSATION } from '../../server/master/attachments.js';
import { MasterClient } from '../../server/master/client.js';
import { startMasterHost } from '../../server/master/host.js';
import type { MasterCheckpoint } from '../../shared/master.js';
import { MasterJournal } from '../../server/master/journal.js';
import type { ModelCall, ModelRequest } from '../../server/master/model-openai.js';
import { MasterRoom } from '../../server/master/room.js';
import { masterRoutes } from '../../server/master/routes.js';
import { MasterService } from '../../server/master/service.js';
import { MasterSettingsStore } from '../../server/master/settings.js';
import { TowerClient } from '../../server/master/tower-client.js';
import type { Attachment } from '../../shared/types.js';
import { until } from '../helpers/until.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** A folder for one test; what runs in it (`closing`) finishes its writes before the folder goes. */
async function folder(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-master-pictures-'));
  const closing: Array<() => Promise<unknown>> = [];
  t.after(async () => { for (const close of closing) await close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, closing };
}

test('a picture sent with a message reaches the model as an image with its text, and later turns only name it', async t => {
  const { dir, closing } = await folder(t);
  const store = await masterAttachments(dir);
  const { attachments } = await store.prepare(MASTER_CONVERSATION, { attachments: [{ name: 'screen.png', mimeType: 'image/png', data: PNG }] });
  const settings = new MasterSettingsStore(dir);
  await settings.start();
  await settings.update({ apiKey: 'sk-test-0123456789abcdef' });
  const room = new MasterRoom(dir);
  await room.start();
  const journal = new MasterJournal(dir);
  await journal.start();
  const requests: ModelRequest[] = [];
  const model: ModelCall = async request => { requests.push(structuredClone(request)); return { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '빨간 점이 보입니다.' }] }], text: '빨간 점이 보입니다.' }; };
  const service = new MasterService({ settings, room, journal, tower: new TowerClient(), model, attachments: store, taskPollMs: 1000 });
  await service.start();
  closing.push(() => service.close());

  const entry = await service.send({ clientMessageId: 'picture-0001', text: '', local: true, attachments });
  assert.deepEqual(entry.data.kind === 'owner' && entry.data.attachments, attachments, 'the conversation shows the picture with the message');
  await until(() => requests.length === 1);
  const asked = requests[0].input.at(-1)!;
  const parts = asked.content as Array<{ type: string; text?: string; image_url?: string }>;
  assert.equal(asked.role, 'user');
  assert.equal(parts[0].type, 'input_text');
  assert.match(parts[0].text!, /\[attached files\]\n- "screen\.png" \(image\/png, \d+ bytes\), attachment 1 below, kept on this computer at ".*screen\.png"/);
  assert.deepEqual(parts.slice(1), [{ type: 'input_image', image_url: `data:image/png;base64,${PNG}`, detail: 'auto' }]);

  await service.send({ clientMessageId: 'picture-0002', text: '방금 사진 다시 설명해 줘', local: true });
  await until(() => requests.length === 2);
  const later = JSON.stringify(requests[1].input);
  assert.ok(later.includes('[attached files, seen in that turn: \\"screen.png\\"]'), 'the history names the earlier picture');
  assert.ok(!later.includes('input_image'), 'an earlier picture is not sent again');
  assert.equal(typeof requests[1].input.at(-1)!.content, 'string', 'a message without pictures stays plain text');
});

test('a picture that can no longer be read is named for the model instead of failing the turn', async t => {
  const { dir, closing } = await folder(t);
  const store = await masterAttachments(dir);
  const settings = new MasterSettingsStore(dir);
  await settings.start();
  await settings.update({ apiKey: 'sk-test-0123456789abcdef' });
  const room = new MasterRoom(dir);
  await room.start();
  const journal = new MasterJournal(dir);
  await journal.start();
  const requests: ModelRequest[] = [];
  const model: ModelCall = async request => { requests.push(structuredClone(request)); return { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '다시 보내 주세요.' }] }], text: '다시 보내 주세요.' }; };
  const service = new MasterService({ settings, room, journal, tower: new TowerClient(), model, attachments: store, taskPollMs: 1000 });
  await service.start();
  closing.push(() => service.close());
  const gone: Attachment = { id: '0b8f1c1e-5d0a-4f43-9c55-2a8d3f1b6e7a', name: 'gone.png', mimeType: 'image/png', size: 70 };
  await service.send({ clientMessageId: 'picture-0003', text: '이거 봐줘', local: true, attachments: [gone] });
  await until(() => requests.length === 1);
  const asked = requests[0].input.at(-1)!;
  assert.equal(typeof asked.content, 'string');
  assert.match(String(asked.content), /이거 봐줘\n\[attached files\]\n- "gone\.png" \(image\/png, 70 bytes\): could not be read/);
});

test('the host takes only well-formed file records', () => {
  assert.deepEqual(fileList(undefined), []);
  const picture = { id: '0b8f1c1e-5d0a-4f43-9c55-2a8d3f1b6e7a', name: 'a.png', mimeType: 'image/png', size: 10 };
  assert.deepEqual(fileList([picture, { ...picture, mimeType: 'application/pdf', name: 'a.pdf' }]).length, 2);
  assert.throws(() => fileList([{ ...picture, id: '../x' }]), /첨부 파일/);
  assert.throws(() => fileList([{ ...picture, name: '../a.png' }]), /첨부 파일/);
  assert.throws(() => fileList('nope'), /첨부 파일/);
});

test('the page\'s route keeps pictures, hands the host their records, shows them, and lets refused ones go', async t => {
  const { dir, closing } = await folder(t);
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  let refuse = false;
  let stale = false;
  let pictures: Awaited<ReturnType<typeof masterAttachments>> | undefined;
  const client = {
    attachments: async () => pictures ??= await masterAttachments(dir),
    sameBuild: async () => !stale,
    call: async (method: string, args: Record<string, unknown>) => {
      calls.push({ method, args });
      if (refuse) throw Object.assign(new Error('메시지가 비었거나 너무 깁니다.'), { statusCode: 400 });
      return { id: 'entry', data: { kind: 'owner', text: args.text, attachments: args.attachments } };
    },
  } as unknown as MasterClient;
  const handle = masterRoutes(client);
  const server = createServer((req, res) => { const url = new URL(req.url!, 'http://tower.invalid'); void handle(req, res, url.pathname, url, { local: true }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const send = (body: unknown) => fetch(`${base}/api/master/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const plain = await send({ clientMessageId: 'plain-00001', text: '안녕' });
  assert.equal(plain.status, 200);
  assert.deepEqual(calls.at(-1)!.args, { clientMessageId: 'plain-00001', text: '안녕', viewContext: undefined, local: true }, 'a message without pictures goes as before');

  const note = await send({ clientMessageId: 'file-000001', text: '', attachments: [{ name: 'notes.txt', mimeType: 'text/plain', data: 'aGk=' }] });
  assert.equal(note.status, 200, 'any kind of file is kept');
  const noteRecord = (calls.at(-1)!.args.attachments as Attachment[])[0];
  const download = await fetch(`${base}/api/master/attachments/${noteRecord.id}`);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream', 'a file that is not a picture is only downloaded');
  assert.match(download.headers.get('content-disposition')!, /^attachment;/);

  const chosen = await send({ clientMessageId: 'model-00001', text: '자세히', model: 'gpt-6-sol', effort: 'high' });
  assert.equal(chosen.status, 200);
  assert.deepEqual(calls.at(-1)!.args, { clientMessageId: 'model-00001', text: '자세히', viewContext: undefined, local: true, model: 'gpt-6-sol', effort: 'high' });

  const again = await send({ clientMessageId: 'again-00001', text: '또', attachmentIds: [noteRecord.id] });
  assert.equal(again.status, 200);
  assert.deepEqual(calls.at(-1)!.args.attachments, [noteRecord], 'a kept file goes again by its id, without uploading it again');
  assert.equal((await send({ clientMessageId: 'again-00002', text: '또', attachmentIds: ['0b8f1c1e-5d0a-4f43-9c55-2a8d3f1b6e7a'] })).status, 404);
  calls.length = 1;

  const sent = await send({ clientMessageId: 'image-00001', text: '', attachments: [{ name: 'screen.png', mimeType: 'image/png', data: PNG }] });
  assert.equal(sent.status, 200);
  const records = calls.at(-1)!.args.attachments as Attachment[];
  assert.equal(records.length, 1);
  assert.equal(records[0].name, 'screen.png');
  assert.ok(!JSON.stringify(calls.at(-1)!.args).includes(PNG), 'only the record goes to the host, not the bytes');

  const shown = await fetch(`${base}/api/master/attachments/${records[0].id}`);
  assert.equal(shown.status, 200);
  assert.equal(shown.headers.get('content-type'), 'image/png');
  assert.equal(shown.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(Buffer.from(await shown.arrayBuffer()).toString('base64'), PNG);
  assert.equal((await fetch(`${base}/api/master/attachments/0b8f1c1e-5d0a-4f43-9c55-2a8d3f1b6e7a`)).status, 404);

  stale = true;
  const waiting = await send({ clientMessageId: 'image-00003', text: '', attachments: [{ name: 'old.png', mimeType: 'image/png', data: PNG }] });
  assert.equal(waiting.status, 503, 'an older host still at work would drop the picture: the owner is told to wait');
  assert.equal(calls.length, 2);
  stale = false;

  refuse = true;
  const before = (await readdir(join(dir, 'attachments'))).length;
  const refused = await send({ clientMessageId: 'image-00002', text: '', attachments: [{ name: 'again.png', mimeType: 'image/png', data: PNG }] });
  assert.equal(refused.status, 400);
  assert.equal((await readdir(join(dir, 'attachments'))).length, before, 'a picture the host refused is not kept');
});

test('through the host, a picture the web kept reaches the model, an empty message still needs a file, and choices are checked', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-master-host-pictures-'));
  const cleanup: Array<() => unknown> = [];
  t.after(async () => { for (const step of cleanup.reverse()) await step(); await rm(stateDir, { recursive: true, force: true }); });
  const requests: ModelRequest[] = [];
  const model: ModelCall = async request => { requests.push(structuredClone(request)); return { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '봤습니다.' }] }], text: '봤습니다.' }; };
  const host = await startMasterHost({ stateDir, model, idleMs: 60_000 });
  cleanup.push(() => host.close());
  const client = new MasterClient({ stateDir, credentials: () => ({ port: 1, token: 'a'.repeat(64), callerSecret: 'b'.repeat(64) }) });
  cleanup.push(() => client.dispose());
  await client.call('settings', { body: { apiKey: 'sk-test-0123456789abcdef' } });

  await assert.rejects(client.call('send', { clientMessageId: 'empty-00001', text: '  ', local: true }), /비었거나/);
  const { attachments } = await (await client.attachments()).prepare(MASTER_CONVERSATION, { attachments: [{ name: 'screen.png', mimeType: 'image/png', data: PNG }] });
  await client.call('send', { clientMessageId: 'image-00001', text: '', local: true, attachments });
  await until(() => requests.length === 1);
  assert.ok(JSON.stringify(requests[0].input.at(-1)).includes(`"image_url":"data:image/png;base64,${PNG}"`));
  const checkpoint = await client.call('checkpoint') as MasterCheckpoint;
  assert.deepEqual(checkpoint.entries.find(entry => entry.data.kind === 'owner')?.data, { kind: 'owner', text: '', attachments });
  await assert.rejects(client.call('send', { clientMessageId: 'image-00002', text: '', local: true, attachments: [{ ...attachments[0], id: 'nope' }] }), /첨부 파일/);
  await assert.rejects(client.call('send', { clientMessageId: 'model-00002', text: '안녕', local: true, model: 'a b' }), /모델/);
  await assert.rejects(client.call('send', { clientMessageId: 'model-00003', text: '안녕', local: true, effort: 'extreme' }), /추론/);
});
