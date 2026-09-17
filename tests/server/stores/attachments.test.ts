import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { AttachmentStore, attachmentPrompt } from '../../../server/stores/attachments.js';
import { MAX_ATTACHMENT_BYTES, MAX_IMAGE_ATTACHMENT_BYTES } from '../../../shared/attachments.js';
import type { AttachmentInput } from '../../../shared/types.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2S8AAAAASUVORK5CYII=', 'base64');
const upload = (name = 'hello.txt', content = Buffer.from('hello'), mimeType = 'text/plain'): AttachmentInput => ({ name, mimeType, data: content.toString('base64') });
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'monitor-attachments-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AttachmentStore(directory);
  await store.start();
  return { store, directory };
}

test('attachments persist privately, preserve names and verify content after restart', async t => {
  const { store, directory } = await fixture(t);
  const input = upload('.metadata.json', Buffer.from('secret document'));
  const result = await store.prepare('session-one', { attachments: [input, upload('이미지.png', PNG, '')] });
  assert.equal(result.attachments[1].mimeType, 'image/png');
  assert.deepEqual(Object.keys(result.attachments[0]).sort(), ['id', 'mimeType', 'name', 'size']);
  assert.equal((await stat(store.directory)).mode & 0o777, 0o700);
  const reopened = new AttachmentStore(directory);
  await reopened.start();
  const resolved = await reopened.resolve('session-one', result.attachments);
  assert.equal(resolved[0].content.toString(), 'secret document');
  assert.equal((await stat(resolved[0].path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(store.directory, result.attachments[0].id, '.metadata.json'))).mode & 0o777, 0o600);
  const retry = await reopened.prepare('session-one', { attachmentIds: [result.attachments[0].id], attachments: [upload()] });
  assert.equal(retry.attachments[0].id, result.attachments[0].id);
  assert.equal(retry.createdIds.length, 1);
  await reopened.rollback(retry.createdIds);
  assert.equal((await reopened.read(result.attachments[0].id)).content.toString(), 'secret document');
  const prompt = attachmentPrompt('', resolved);
  assert.match(prompt, /첨부한 파일을 확인/);
  assert.ok(prompt.includes(JSON.stringify(resolved[0].path)));
});

test('attachment IDs are scoped to the original session and cannot reference arbitrary files', async t => {
  const { store } = await fixture(t);
  const saved = await store.prepare('one', { attachments: [upload()] });
  await assert.rejects(store.prepare('two', { attachmentIds: [saved.attachments[0].id] }), { statusCode: 404 });
  for (const id of ['../runs.json', '/etc/passwd', '', '00000000-0000-4000-8000-000000000000']) await assert.rejects(store.read(id), { statusCode: 404 });
  await assert.rejects(store.prepare('one', { attachmentIds: [saved.attachments[0].id, saved.attachments[0].id] }), { statusCode: 400 });
});

test('validation rejects malformed names, MIME, base64 and disguised images without creating files', async t => {
  const { store } = await fixture(t);
  const bad: AttachmentInput[] = [
    ...['../file', '/file', 'C:\\file', '.', '..', 'a\nfile', '\ud800', 'a'.repeat(241)].map(name => upload(name)),
    { ...upload(), mimeType: 'text/plain\r\nInjected: true' },
    ...['eA', 'eA===', 'eA==\n', 'eB==', 'data:text/plain;base64,eA==', '!!!!'].map(data => ({ ...upload(), data })),
    upload('fake.png', Buffer.from('<html>active content</html>'), 'image/png'),
    upload('wrong.jpg', PNG, 'image/jpeg'),
  ];
  for (const input of bad) await assert.rejects(store.prepare('one', { attachments: [input] }), { statusCode: 400 });
  await assert.rejects(store.prepare('one', { attachments: null } as never), { statusCode: 400 });
  assert.deepEqual(await readdir(store.directory), []);
});

test('limits cover large valid files, image bytes, combined retries and uploads', async t => {
  const { store } = await fixture(t);
  const large = upload('large.bin', Buffer.alloc(MAX_ATTACHMENT_BYTES), 'application/octet-stream');
  const saved = await store.prepare('one', { attachments: [large] });
  assert.equal(saved.attachments[0].size, MAX_ATTACHMENT_BYTES);
  await assert.rejects(store.prepare('one', { attachments: [upload('large.bin', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1))] }), { statusCode: 413 });
  const image = Buffer.alloc(MAX_IMAGE_ATTACHMENT_BYTES + 1); PNG.copy(image);
  await assert.rejects(store.prepare('one', { attachments: [upload('big.png', image, 'image/png')] }), { statusCode: 413 });
  await assert.rejects(store.prepare('one', { attachments: Array.from({ length: 11 }, () => upload()) }), { statusCode: 413 });
  await assert.rejects(store.prepare('one', { attachmentIds: [saved.attachments[0].id], attachments: [large, upload()] }), { statusCode: 413 });
  assert.deepEqual(await readdir(store.directory), saved.createdIds);
});

test('owned downloads reject tampered content, replaced files, symlinks and invalid manifests', async t => {
  const { store, directory } = await fixture(t);
  const { attachments } = await store.prepare('one', { attachments: [upload('first'), upload('second'), upload('third')] });
  const first = await store.read(attachments[0].id);
  await writeFile(first.path, 'other');
  await assert.rejects(store.read(attachments[0].id), { statusCode: 404 });
  const second = await store.read(attachments[1].id);
  const outside = join(directory, 'outside'); await writeFile(outside, 'hello');
  await rm(second.path); await symlink(outside, second.path);
  await assert.rejects(store.read(attachments[1].id), { statusCode: 404 });
  const manifestPath = join(store.directory, attachments[2].id, '.metadata.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, name: '../../outside' }));
  await assert.rejects(store.read(attachments[2].id), { statusCode: 404 });
});

test('attachment storage refuses a symlink root and rolls back partial writes', async t => {
  const { store, directory } = await fixture(t);
  const originalWrite = (store as any).write.bind(store);
  let writes = 0;
  (store as any).write = async (path: string, content: Buffer) => {
    if (++writes === 3) throw new Error('disk full');
    return originalWrite(path, content);
  };
  await assert.rejects(store.prepare('one', { attachments: [upload('first'), upload('second')] }), /disk full/);
  assert.deepEqual(await readdir(store.directory), []);
  await rm(store.directory, { recursive: true });
  const outside = join(directory, 'outside'); await mkdir(outside);
  await symlink(outside, store.directory);
  await assert.rejects(store.start(), { statusCode: 503 });
});
