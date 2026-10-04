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

test('restored originals reverify changed fingerprints once and remain usable afterward', async t => {
  const { store, root } = await fixture(t);
  const { cp, open } = await import('node:fs/promises');
  const saved = await store.upload('one', 'original', 'text/plain', bytes(100));
  const restoredRoot = join(root, 'restored');
  await cp(store.directory, join(restoredRoot, 'attachments'), { recursive: true });
  const restored = new AttachmentStore(restoredRoot); await restored.start();
  assert.equal((await restored.read(saved.id)).content.toString(), 'A'.repeat(100));
  const originalManifest = JSON.parse(await readFile(join(store.directory, saved.id, '.metadata.json'), 'utf8'));
  const restoredManifest = JSON.parse(await readFile(join(restored.directory, saved.id, '.metadata.json'), 'utf8'));
  assert.deepEqual(restoredManifest, originalManifest);
  const probe = await open(join(restored.directory, saved.id, 'content', saved.name));
  const prototype = Object.getPrototypeOf(probe); await probe.close();
  const spy = t.mock.method(prototype, 'createReadStream', () => { throw new Error('Restored fingerprint should now be current'); });
  assert.equal((await restored.read(saved.id)).content.length, 100); assert.equal(spy.mock.callCount(), 0);
  spy.mock.restore();
  const opened = await restored.read(saved.id); await writeFile(opened.path, 'B'.repeat(100));
  await assert.rejects(restored.read(saved.id), { kind: 'not-found' });
});

test('GC tolerates publications disappearing during latest-write and protected-retain inspection', async t => {
  const { store } = await fixture(t);
  const { mkdir } = await import('node:fs/promises');
  const { randomUUID } = await import('node:crypto');
  const partial = join(store.directory, `.upload-${randomUUID()}`); await mkdir(partial);
  const originalLatest = (store as any).latestWrite.bind(store);
  const latest = t.mock.method(store as any, 'latestWrite', async (path: string) => { await rm(path, { recursive: true, force: true }); return originalLatest(path); });
  await store.sweepPending(); latest.mock.restore();
  const saved = await store.upload('one', 'pending', 'text/plain', bytes(1), { pending: true });
  const originalRetain = store.retain.bind(store);
  const retain = t.mock.method(store, 'retain', async (ids: readonly string[]) => { await store.rollback(ids); await originalRetain(ids); });
  await store.sweepPending(new Set([saved.id])); retain.mock.restore();
  const another = await store.upload('one', 'another', 'text/plain', bytes(1), { pending: true });
  t.mock.method(store, 'retain', () => Promise.reject(Object.assign(new Error('I/O'), { code: 'EIO' })));
  await assert.rejects(store.sweepPending(new Set([another.id])), { code: 'EIO' });
});

async function expire(store: AttachmentStore, id: string) {
  const path = join(store.directory, id, '.metadata.json');
  const value = JSON.parse(await readFile(path, 'utf8')); value.pendingUntil = Date.now() - 1;
  await writeFile(path, JSON.stringify(value));
  return path;
}

test('GC rechecks live admission protection after its manifest read and never retains failed admissions', async t => {
  const { store } = await fixture(t);
  const saved = await store.upload('one', 'pending', 'text/plain', bytes(1), { pending: true });
  const path = await expire(store, saved.id);
  let release!: () => void; let observed!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { observed = resolve; });
  const original = (store as any).manifest.bind(store);
  const spy = t.mock.method(store as any, 'manifest', async (id: string) => {
    const value = await original(id); observed(); await gate; return value;
  });
  const admissions = new Set<string>();
  const sweep = store.sweepPending(new Set(), new Set(), { isProtected: id => admissions.has(id) });
  await reading; admissions.add(saved.id); release(); await sweep; spy.mock.restore();
  assert.ok(JSON.parse(await readFile(path, 'utf8')).pendingUntil < Date.now());
  assert.equal((await store.prepare('one', { attachmentIds: [saved.id] })).attachments[0].id, saved.id);
  // A failed admission drops only its live protection; the original remains eligible for TTL.
  admissions.clear(); await store.sweepPending(new Set(), new Set(), { isProtected: id => admissions.has(id) });
  await assert.rejects(store.openVerified(saved.id), { kind: 'not-found' });
});

test('GC registers removal before a later admission can open the original', async t => {
  const { store } = await fixture(t);
  const saved = await store.upload('one', 'pending', 'text/plain', bytes(1), { pending: true });
  await expire(store, saved.id);
  const deletions = (store as any).pendingDeletions as Map<string, Promise<void>>;
  const set = deletions.set.bind(deletions);
  let admission: Promise<unknown> | undefined;
  t.mock.method(deletions, 'set', (id: string, deletion: Promise<void>) => {
    set(id, deletion);
    admission = assert.rejects(store.prepare('one', { attachmentIds: [id] }), { kind: 'not-found' });
    return deletions;
  });
  await store.sweepPending();
  assert.ok(admission); await admission;
});

test('open waits for an existing deletion and forwards its I/O failure', async t => {
  const { store } = await fixture(t);
  const saved = await store.upload('one', 'pending', 'text/plain', bytes(1), { pending: true });
  const deletions = (store as any).pendingDeletions as Map<string, Promise<void>>;
  let release!: () => void;
  deletions.set(saved.id, new Promise<void>(resolve => { release = resolve; }));
  let finished = false;
  const opening = store.openVerified(saved.id).then(value => { finished = true; return value; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(finished, false);
  await store.rollback([saved.id]); release();
  await assert.rejects(opening, { kind: 'not-found' }); deletions.delete(saved.id);
  const another = await store.upload('one', 'another', 'text/plain', bytes(1), { pending: true });
  let fail!: (error: unknown) => void;
  deletions.set(another.id, new Promise<void>((_, reject) => { fail = reject; }));
  const io = Object.assign(new Error('delete failed'), { code: 'EIO' });
  const rejection = assert.rejects(store.openVerified(another.id), error => error === io);
  fail(io); await rejection; deletions.delete(another.id);
});

test('restored SHA cache survives retain without rewriting persistent retention metadata', async t => {
  const { store, root } = await fixture(t);
  const { cp, open } = await import('node:fs/promises');
  const saved = await store.upload('one', 'original', 'text/plain', bytes(100), { pending: true });
  const restoredRoot = join(root, 'restored-cache');
  await cp(store.directory, join(restoredRoot, 'attachments'), { recursive: true });
  const restored = new AttachmentStore(restoredRoot); await restored.start();
  const path = join(restored.directory, saved.id, '.metadata.json');
  const before = await readFile(path, 'utf8');
  const probe = await open(join(restored.directory, saved.id, 'content', saved.name));
  const prototype = Object.getPrototypeOf(probe); await probe.close();
  const streams = t.mock.method(prototype, 'createReadStream');
  assert.equal((await restored.read(saved.id)).content.length, 100);
  assert.equal(streams.mock.callCount(), 1); assert.equal(await readFile(path, 'utf8'), before);
  await restored.retain([saved.id]);
  assert.equal((await restored.read(saved.id)).content.length, 100);
  assert.equal(streams.mock.callCount(), 1);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).pendingUntil, undefined);
  await writeFile(join(restored.directory, saved.id, 'content', saved.name), 'B'.repeat(100));
  await assert.rejects(restored.read(saved.id), { kind: 'not-found' });
  assert.equal(streams.mock.callCount(), 2);
});

test('changing cached manifest SHA requires full verification even when the content fingerprint is unchanged', async t => {
  const { store } = await fixture(t);
  const saved = await store.upload('one', 'original', 'text/plain', bytes(100));
  await store.read(saved.id);
  const path = join(store.directory, saved.id, '.metadata.json');
  const value = JSON.parse(await readFile(path, 'utf8')); value.sha256 = '0'.repeat(64);
  await writeFile(path, JSON.stringify(value));
  await assert.rejects(store.read(saved.id), { kind: 'not-found' });
});

test('reference resolution accepts its open metadata snapshot when retain atomically replaces the manifest', async t => {
  const { store, root } = await fixture(t);
  const saved = await store.upload('one', 'pending', 'text/plain', bytes(100), { pending: true });
  const other = new AttachmentStore(root); await other.start();
  const { open } = await import('node:fs/promises');
  const path = join(store.directory, saved.id, '.metadata.json');
  const probe = await open(path);
  const inode = (await probe.stat()).ino;
  const prototype = Object.getPrototypeOf(probe); await probe.close();
  const originalStat = prototype.stat;
  let replaced = false;
  let unlinkedSnapshot = false;
  t.mock.method(prototype, 'stat', async function (this: import('node:fs/promises').FileHandle, ...args: any[]) {
    const before = await originalStat.apply(this, args);
    if (!replaced && before.ino === inode) {
      replaced = true;
      await other.retain([saved.id]);
      const after = await originalStat.apply(this, args);
      unlinkedSnapshot = after.nlink === 0;
      return after;
    }
    return before;
  });
  const resolved = await store.resolve('one', [saved]);
  assert.equal(replaced, true); assert.equal(unlinkedSnapshot, true);
  assert.equal(resolved[0].metadata.id, saved.id);
  assert.equal(resolved[0].content.toString(), 'A'.repeat(100));
  assert.equal(JSON.parse(await readFile(path, 'utf8')).pendingUntil, undefined);
});

test('metadata and original content still reject multiple hard links', async t => {
  const { store, root } = await fixture(t);
  const { link } = await import('node:fs/promises');
  const metadata = await store.upload('one', 'metadata', 'text/plain', bytes(10));
  await link(join(store.directory, metadata.id, '.metadata.json'), join(root, 'metadata-link'));
  await assert.rejects(store.openVerified(metadata.id), { kind: 'not-found' });
  const content = await store.upload('one', 'content', 'text/plain', bytes(10));
  await link(join(store.directory, content.id, 'content', content.name), join(root, 'content-link'));
  await assert.rejects(store.openVerified(content.id), { kind: 'not-found' });
});
