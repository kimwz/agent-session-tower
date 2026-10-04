import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir, stat, symlink, utimes, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AttachmentUploads } from '../../../server/stores/attachment-uploads.js';
import { ATTACHMENT_TTL_MS, AttachmentStore } from '../../../server/stores/attachments.js';
import { UPLOAD_CHUNK_BYTES } from '../../../shared/attachments.js';

async function* chunks(...values: Buffer[]) { yield* values; }
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'tower-upload-'));
  const chat = new AttachmentStore(root); const auto = new AttachmentStore(join(root, 'auto'));
  await chat.start(); await auto.start();
  const protectedChat = new Set<string>(); const protectedAuto = new Set<string>();
  const uploads = new AttachmentUploads(root, { chat, auto, protectedChat: () => protectedChat, protectedAuto: () => protectedAuto });
  await uploads.start();
  t.after(async () => { uploads.close(); await rm(root, { recursive: true, force: true }); });
  return { root, chat, auto, uploads, protectedChat, protectedAuto };
}
const target = { kind: 'chat' as const, sessionId: 'conversation' };
async function manifest(uploads: AttachmentUploads, id: string) { return JSON.parse(await readFile(join(uploads.directory, id, 'manifest.json'), 'utf8')); }
async function age(path: string) { const old = new Date(Date.now() - ATTACHMENT_TTL_MS - 60_000); await utimes(path, old, old); }

test('chunk upload roundtrip exceeds JSON limits and completion receipts survive restart', async t => {
  const { uploads, root, chat, auto } = await fixture(t);
  const size = UPLOAD_CHUNK_BYTES * 6 + 3;
  const started = await uploads.start(target, 'large.bin', 'application/octet-stream', size, 'controller');
  for (let offset = 0; offset < size; offset += UPLOAD_CHUNK_BYTES) {
    assert.deepEqual(await uploads.append(started.id, 'controller', offset, chunks(Buffer.alloc(Math.min(UPLOAD_CHUNK_BYTES, size - offset), 65))), { offset: Math.min(size, offset + UPLOAD_CHUNK_BYTES) });
  }
  const saved = await uploads.complete(started.id, 'controller');
  assert.equal(saved.size, size);
  assert.equal((await stat(join(uploads.directory, started.id))).mode & 0o777, 0o700);
  await assert.rejects(stat(join(uploads.directory, started.id, 'content')), { code: 'ENOENT' });
  uploads.close();
  const reopened = new AttachmentUploads(root, { chat, auto }); await reopened.start(); t.after(() => reopened.close());
  assert.deepEqual(await reopened.complete(started.id, 'controller'), saved);
  assert.deepEqual(await reopened.status(started.id, 'controller'), { offset: size, target });
  const file = await chat.openVerified(saved.id, target.sessionId);
  try { const content = await file.file.readFile(); assert.equal(content.length, size); assert.ok(content.every(byte => byte === 65)); }
  finally { await file.file.close(); }
});

test('failed chunks truncate, offsets recover interrupted prefixes and parallel appends serialize', async t => {
  const { uploads } = await fixture(t);
  const { id } = await uploads.start(target, 'file', 'text/plain', 10, 'local');
  async function* failed() { yield Buffer.from('abc'); throw new Error('interrupted'); }
  await assert.rejects(uploads.append(id, 'local', 0, failed()), /interrupted/);
  assert.equal((await uploads.status(id, 'local')).offset, 0);
  await appendFile(join(uploads.directory, id, 'content'), 'abc');
  assert.equal((await uploads.status(id, 'local')).offset, 3);
  await assert.rejects(uploads.append(id, 'local', 0, chunks(Buffer.from('abc'))), { kind: 'conflict', offset: 3 });
  const results = await Promise.allSettled([
    uploads.append(id, 'local', 3, chunks(Buffer.from('def'))),
    uploads.append(id, 'local', 3, chunks(Buffer.from('ghi'))),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await uploads.status(id, 'local')).offset, 6);
  await assert.rejects(uploads.complete(id, 'local'), { kind: 'conflict', offset: 6 });
  await uploads.append(id, 'local', 6, chunks(Buffer.from('ghij')));
  assert.equal((await uploads.complete(id, 'local')).size, 10);
});

test('declaration, per-request cap, magic validation and owner checks protect uploads', async t => {
  const { uploads, chat } = await fixture(t);
  for (const size of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(uploads.start(target, 'file', 'text/plain', size, 'local'), { kind: 'invalid' });
  await assert.rejects(uploads.start(target, '../file', 'text/plain', 0, 'local'), { kind: 'invalid' });
  const { id } = await uploads.start(target, 'file', 'text/plain', UPLOAD_CHUNK_BYTES * 2, 'one');
  for (const action of [() => uploads.status(id, 'two'), () => uploads.append(id, 'two', 0, chunks()), () => uploads.complete(id, 'two'), () => uploads.cancel(id, 'two')]) await assert.rejects(action(), { kind: 'not-found' });
  await assert.rejects(uploads.append(id, 'one', 0, chunks(Buffer.alloc(UPLOAD_CHUNK_BYTES + 1))), { kind: 'too-large' });
  assert.equal((await uploads.status(id, 'one')).offset, 0);
  const fake = await uploads.start(target, 'fake.png', 'image/png', 4, 'one');
  await uploads.append(fake.id, 'one', 0, chunks(Buffer.from('fake')));
  await assert.rejects(uploads.complete(fake.id, 'one'), { kind: 'invalid' });
  assert.deepEqual(await readdir(chat.directory), []);
  const empty = await uploads.start(target, 'empty', 'application/octet-stream', 0, 'one');
  assert.equal((await uploads.complete(empty.id, 'one')).size, 0);
});

test('Auto references check stored owner without exposing it and preserve legacy admission', async t => {
  const { uploads, auto } = await fixture(t);
  const scope = { kind: 'auto' as const, sessionId: 'request' };
  const started = await uploads.start(scope, 'file', 'text/plain', 5, 'controller-one');
  await uploads.append(started.id, 'controller-one', 0, chunks(Buffer.from('hello')));
  const saved = await uploads.complete(started.id, 'controller-one');
  await assert.rejects(auto.prepare('request', { attachmentIds: [saved.id] }, 'controller-two'), { kind: 'not-found' });
  assert.deepEqual((await auto.prepare('request', { attachmentIds: [saved.id] }, 'controller-one')).attachments, [saved]);
  assert.deepEqual(Object.keys((await auto.read(saved.id)).metadata).sort(), ['id', 'mimeType', 'name', 'size']);
  const legacy = await auto.prepare('request', { attachments: [{ name: 'legacy', mimeType: 'text/plain', data: Buffer.from('old').toString('base64') }] });
  assert.equal((await auto.prepare('request', { attachmentIds: [legacy.attachments[0].id] }, 'controller-two')).attachments.length, 1);
});

test('completion recovers published file and stale atomic temporary folder after a crash', async t => {
  const { uploads, chat } = await fixture(t);
  const started = await uploads.start(target, 'file', 'text/plain', 5, 'local');
  await uploads.append(started.id, 'local', 0, chunks(Buffer.from('hello')));
  const transaction = await manifest(uploads, started.id);
  const temporary = join(chat.directory, `.upload-${transaction.attachmentId}`);
  await mkdir(temporary); await writeFile(join(temporary, 'partial'), 'dead attempt');
  const saved = await uploads.complete(started.id, 'local');
  await assert.rejects(stat(temporary), { code: 'ENOENT' });
  const path = join(uploads.directory, started.id, 'manifest.json');
  delete transaction.receipt; await writeFile(path, JSON.stringify(transaction));
  await writeFile(join(uploads.directory, started.id, 'content'), 'hello');
  const recovered = await uploads.complete(started.id, 'local');
  assert.deepEqual(recovered, saved);
  assert.deepEqual(await readdir(chat.directory), [saved.id]);
});

test('TTL removes abandoned staging and pending originals but retains protected scopes and accepted originals', async t => {
  const { uploads, chat, auto, protectedChat, protectedAuto } = await fixture(t);
  const abandoned = await uploads.start(target, 'unused', 'text/plain', 0, 'local');
  const expired = await uploads.start(target, 'expired', 'text/plain', 0, 'local');
  const retained = await uploads.start(target, 'retained', 'text/plain', 0, 'local');
  const pinned = await uploads.start(target, 'pinned', 'text/plain', 0, 'local');
  const scope = await uploads.start({ kind: 'auto', sessionId: 'live-job' }, 'scope', 'text/plain', 0, 'local');
  const a = await uploads.complete(expired.id, 'local'); const b = await uploads.complete(retained.id, 'local');
  const c = await uploads.complete(pinned.id, 'local'); const d = await uploads.complete(scope.id, 'local');
  await chat.retain([b.id]); protectedChat.add(c.id); protectedAuto.add('live-job');
  for (const [store, saved] of [[chat, a], [chat, c], [auto, d]] as const) {
    const path = join(store.directory, saved.id, '.metadata.json'); const value = JSON.parse(await readFile(path, 'utf8'));
    value.pendingUntil = Date.now() - 1; await writeFile(path, JSON.stringify(value));
  }
  for (const started of [abandoned, expired, retained, pinned, scope]) {
    const value = await manifest(uploads, started.id); value.touched = Date.now() - ATTACHMENT_TTL_MS - 60_000;
    await writeFile(join(uploads.directory, started.id, 'manifest.json'), JSON.stringify(value));
    if (started === abandoned) await age(join(uploads.directory, started.id, 'content'));
    await age(join(uploads.directory, started.id));
  }
  await uploads.sweep();
  assert.deepEqual(await readdir(uploads.directory), []);
  await assert.rejects(chat.read(a.id), { kind: 'not-found' });
  for (const [store, saved] of [[chat, b], [chat, c], [auto, d]] as const) {
    assert.equal((await store.read(saved.id)).metadata.id, saved.id);
    assert.equal(JSON.parse(await readFile(join(store.directory, saved.id, '.metadata.json'), 'utf8')).pendingUntil, undefined);
  }
  await assert.rejects(uploads.complete(retained.id, 'local'), { kind: 'not-found' });
});

test('deleted pending original cannot be reissued by a receipt and cancel preserves accepted originals', async t => {
  const { uploads, chat } = await fixture(t);
  const one = await uploads.start(target, 'file', 'text/plain', 0, 'local'); const saved = await uploads.complete(one.id, 'local');
  await chat.rollback([saved.id]);
  await assert.rejects(uploads.complete(one.id, 'local'), { kind: 'not-found' });
  const two = await uploads.start(target, 'accepted', 'text/plain', 0, 'local'); const accepted = await uploads.complete(two.id, 'local');
  await chat.retain([accepted.id]); await uploads.cancel(two.id, 'local');
  assert.equal((await chat.read(accepted.id)).metadata.id, accepted.id);
});

test('staging roots and content reject symlink replacements', async t => {
  const { uploads, root } = await fixture(t);
  const started = await uploads.start(target, 'file', 'text/plain', 5, 'local');
  const content = join(uploads.directory, started.id, 'content'); const outside = join(root, 'outside'); await writeFile(outside, 'hello');
  await rm(content); await symlink(outside, content);
  await assert.rejects(uploads.append(started.id, 'local', 0, chunks(Buffer.from('hello'))));
  assert.equal(await readFile(outside, 'utf8'), 'hello');
  await rm(uploads.directory, { recursive: true }); await mkdir(join(root, 'other'));
  await symlink(join(root, 'other'), uploads.directory);
  await assert.rejects(uploads.start(), { kind: 'unavailable' });
});

test('sweep skips active append even with old manifest and removes it after it becomes idle', async t => {
  const { uploads } = await fixture(t);
  const started = await uploads.start(target, 'file', 'text/plain', 1, 'local');
  const value = await manifest(uploads, started.id); value.touched = Date.now() - ATTACHMENT_TTL_MS - 60_000;
  await writeFile(join(uploads.directory, started.id, 'manifest.json'), JSON.stringify(value));
  // Keep the prefix recent so load allows resuming the expired manifest.
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const enteredGate = new Promise<void>(resolve => { entered = resolve; });
  async function* slow() { entered(); await gate; yield Buffer.from('x'); }
  const append = uploads.append(started.id, 'local', 0, slow()); await enteredGate;
  await uploads.sweep(); release(); await append;
  assert.equal((await uploads.status(started.id, 'local')).offset, 1);
});

test('GC propagates unexpected manifest I/O errors without deleting originals or staging', async t => {
  const { uploads, chat } = await fixture(t);
  const { open } = await import('node:fs/promises');
  const started = await uploads.start(target, 'file', 'text/plain', 0, 'local');
  const saved = await chat.upload('conversation', 'retained', 'text/plain', chunks(Buffer.from('safe')));
  const probe = await open(join(chat.directory, saved.id, '.metadata.json'));
  const prototype = Object.getPrototypeOf(probe); await probe.close();
  const io = Object.assign(new Error('metadata disk I/O failed'), { code: 'EIO' });
  const spy = t.mock.method(prototype, 'readFile', () => Promise.reject(io));
  await assert.rejects(chat.sweepPending(), { code: 'EIO' });
  await assert.rejects(uploads.sweep(), { code: 'EIO' });
  spy.mock.restore();
  assert.equal((await chat.read(saved.id)).content.toString(), 'safe');
  assert.equal((await uploads.status(started.id, 'local')).offset, 0);
});

test('GC treats null and truncated staging manifests as old incomplete starts', async t => {
  const { uploads } = await fixture(t);
  for (const data of ['null', '{"id":']) {
    const id = randomUUID(); const path = join(uploads.directory, id);
    await mkdir(path); await writeFile(join(path, 'manifest.json'), data);
    await age(path);
  }
  await uploads.sweep();
  assert.deepEqual(await readdir(uploads.directory), []);
});
