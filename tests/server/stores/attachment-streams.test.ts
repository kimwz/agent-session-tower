import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachmentStore, imagePaths, claudeImageBlocks } from '../../../server/stores/attachments.js';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'tower-stream-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new AttachmentStore(root); await store.start();
  return { root, store };
}
async function* bytes(count: number, byte = 65) {
  for (let offset = 0; offset < count; offset += 65536) yield Buffer.alloc(Math.min(65536, count - offset), byte);
}
test('stream uploads exceed legacy per-file and aggregate limits and references stay session-bound', async t => {
  const { store } = await fixture(t);
  const size = 21 * 1024 * 1024 + 1;
  const saved = await store.upload('one', 'large.bin', 'application/octet-stream', bytes(size));
  assert.equal(saved.size, size);
  const prepared = await store.prepare('one', { attachmentIds: [saved.id] });
  assert.deepEqual(prepared.attachments, [saved]);
  const opened = await store.openVerified(saved.id, 'one');
  let total = 0;
  try { for await (const chunk of opened.file.createReadStream({ start: 0, autoClose: false })) { total += chunk.length; assert.ok(chunk.every((byte: number) => byte === 65)); } }
  finally { await opened.file.close(); }
  assert.equal(total, size);
  const resolved = await store.resolve('one', [saved]);
  assert.ok(resolved[0].content.length <= 5_000_000);
  await assert.rejects(store.prepare('two', { attachmentIds: [saved.id] }), { kind: 'not-found' });
  await writeFile(resolved[0].path, 'tampered');
  await assert.rejects(store.openVerified(saved.id), { kind: 'not-found' });
});
test('interrupted streams remove partial files and reject bad metadata before reading bytes', async t => {
  const { store } = await fixture(t);
  async function* broken() { yield Buffer.from('partial'); throw new Error('connection lost'); }
  await assert.rejects(store.upload('one', 'partial', 'text/plain', broken()), /connection lost/);
  assert.deepEqual(await readdir(store.directory), []);
  await assert.rejects(store.upload('one', '../escape', 'text/plain', bytes(1)), { kind: 'invalid' });
  assert.deepEqual(await readdir(store.directory), []);
});
test('large raster uploads retain their type but are passed to providers only as file paths', async t => {
  const { store } = await fixture(t);
  const header = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2S8AAAAASUVORK5CYII=', 'base64');
  async function* image() { yield header; yield* bytes(6_000_000); }
  const saved = await store.upload('one', 'big.png', 'image/png', image());
  const resolved = await store.resolve('one', [saved]);
  assert.equal(saved.mimeType, 'image/png');
  assert.deepEqual(imagePaths(resolved), []);
  assert.deepEqual(claudeImageBlocks(resolved), []);
});
test('staged originals transfer to a new conversation without base64 or caller supplied paths', async t => {
  const { store, root } = await fixture(t);
  const staging = new AttachmentStore(join(root, 'staging')); await staging.start();
  const saved = await staging.upload('request', 'file.txt', 'text/plain', bytes(11 * 1024 * 1024));
  const copied = await store.import('conversation', staging, 'request', [saved.id]);
  assert.equal(copied.attachments[0].size, saved.size);
  assert.notEqual(copied.attachments[0].id, saved.id);
  const resolved = await store.resolve('conversation', copied.attachments);
  assert.equal((await readFile(resolved[0].path)).length, saved.size);
  await assert.rejects(store.import('conversation', staging, 'wrong', [saved.id]), { kind: 'not-found' });
  await staging.rollback([saved.id]);
  assert.equal((await store.read(copied.attachments[0].id)).metadata.size, saved.size);
});

test('new originals verify references after restart without reading the whole file', async t => {
  const { root, store } = await fixture(t);
  const saved = await store.upload('one', 'large', 'application/octet-stream', bytes(24 * 1024 * 1024));
  const { open } = await import('node:fs/promises');
  const handle = await open(join(store.directory, saved.id, 'content', saved.name));
  const prototype = Object.getPrototypeOf(handle); await handle.close();
  const spy = t.mock.method(prototype, 'createReadStream', () => { throw new Error('Reference verification must not read the whole new original'); });
  const reopened = new AttachmentStore(root); await reopened.start();
  assert.equal((await reopened.prepare('one', { attachmentIds: [saved.id] })).attachments[0].size, saved.size);
  assert.equal((await reopened.read(saved.id)).content.length, 4000);
  assert.equal(spy.mock.callCount(), 0);
});

test('legacy originals without fingerprints still verify SHA and preserve the fd read cursor', async t => {
  const { store } = await fixture(t);
  const saved = await store.upload('one', 'legacy', 'text/plain', bytes(100));
  const path = join(store.directory, saved.id, '.metadata.json');
  const metadata = JSON.parse(await readFile(path, 'utf8')); delete metadata.fingerprint;
  await writeFile(path, JSON.stringify(metadata));
  const opened = await store.openVerified(saved.id, 'one');
  try { assert.equal((await opened.file.readFile()).length, 100); } finally { await opened.file.close(); }
  const original = await store.read(saved.id);
  await writeFile(original.path, Buffer.alloc(100, 66));
  await assert.rejects(store.read(saved.id), { kind: 'not-found' });
});

test('pending sweep cleans old partial UUID publications and atomic folders while protecting recent writes and retained originals', async t => {
  const { store } = await fixture(t);
  const { mkdir, utimes, lstat, symlink } = await import('node:fs/promises');
  const { randomUUID } = await import('node:crypto');
  const { ATTACHMENT_TTL_MS } = await import('../../../server/stores/attachments.js');
  const old = new Date(Date.now() - ATTACHMENT_TTL_MS - 60_000);
  const partials: string[] = [];
  for (const name of [randomUUID(), randomUUID(), `.upload-${randomUUID()}`]) {
    const path = join(store.directory, name); await mkdir(path); await mkdir(join(path, 'content'));
    await writeFile(join(path, 'content', 'partial'), 'partial');
    if (partials.length === 1) { await writeFile(join(path, '.metadata.json'), '{"id":'); await utimes(join(path, '.metadata.json'), old, old); }
    await utimes(join(path, 'content', 'partial'), old, old); await utimes(join(path, 'content'), old, old); await utimes(path, old, old);
    partials.push(name);
  }
  const recent = `.upload-${randomUUID()}`; const recentPath = join(store.directory, recent);
  await mkdir(recentPath); await mkdir(join(recentPath, 'content')); await writeFile(join(recentPath, 'content', 'active'), 'recent');
  await utimes(join(recentPath, 'content'), old, old); await utimes(recentPath, old, old);
  const retained = await store.upload('one', 'retained', 'text/plain', bytes(1));
  const symbolic = randomUUID(); await symlink(recentPath, join(store.directory, symbolic));
  const unrelated = join(store.directory, 'unrelated'); await mkdir(unrelated); await utimes(unrelated, old, old);
  await store.sweepPending();
  for (const name of partials) await assert.rejects(lstat(join(store.directory, name)), { code: 'ENOENT' });
  assert.equal((await lstat(recentPath)).isDirectory(), true);
  assert.equal((await lstat(join(store.directory, symbolic))).isSymbolicLink(), true);
  assert.equal((await store.read(retained.id)).metadata.id, retained.id);
  assert.equal((await lstat(unrelated)).isDirectory(), true);
});

test('native image selectors agree on per-image and aggregate limits', async t => {
  const { store } = await fixture(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2S8AAAAASUVORK5CYII=', 'base64');
  const saved = [];
  for (let i = 0; i < 5; i++) {
    async function* image() { yield png; yield* bytes(5_000_000 - png.length); }
    saved.push(await store.upload('one', `image-${i}.png`, 'image/png', image()));
  }
  const resolved = await store.resolve('one', saved);
  assert.deepEqual(imagePaths(resolved), resolved.slice(0, 4).map(item => item.path));
  assert.equal(claudeImageBlocks(resolved).length, 4);
});
