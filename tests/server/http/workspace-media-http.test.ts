import { createRemoteAuthFixture } from '../../helpers/auth.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitorServer } from '../../../server/http/server.js';
import { byteRange } from '../../../server/http/sinks.js';
import type { Snapshot } from '../../../shared/types.js';

test('a player’s byte range is read as one inclusive span, the whole file, or one past the end', () => {
  assert.equal(byteRange(undefined, 10), undefined);
  assert.deepEqual(byteRange('bytes=2-5', 10), { start: 2, end: 5 });
  assert.deepEqual(byteRange('bytes=4-', 10), { start: 4, end: 9 });
  assert.deepEqual(byteRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(byteRange('bytes=-30', 10), { start: 0, end: 9 }, 'a suffix longer than the file is the whole file');
  assert.deepEqual(byteRange('bytes=8-99', 10), { start: 8, end: 9 }, 'an end past the file stops at its last byte');
  assert.equal(byteRange('bytes=10-', 10), null);
  assert.equal(byteRange('bytes=-0', 10), null);
  assert.equal(byteRange('bytes=0-', 0), undefined, 'an empty file is sent whole, as players ask for it');
  for (const header of ['bytes=5-2', 'bytes=0-1,4-5', 'items=0-1', 'bytes=-', 'bytes=x-1', 'bytes=99999999999999999999-']) {
    assert.equal(byteRange(header, 10), undefined, `${header} is answered with the whole file`);
  }
});

test('workspace media streams to a signed-in page with ranges, and never as a page of its own', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'tower-media-http-'));
  const snapshot: Snapshot = { sessions: [], runs: [], providers: [], scanning: false, hostname: 'fixture', version: 'test', updatedAt: new Date().toISOString(), groups: [{ cwd, title: '', pinned: true }] };
  const authDir = await mkdtemp(join(tmpdir(), 'tower-media-auth-'));
  t.after(() => rm(authDir, { recursive: true, force: true }));
  const { auth, origins, cookie, fetch } = await createRemoteAuthFixture(authDir);
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: cwd, auth, remote: { origins },
    backend: { snapshot: () => snapshot, detail: async () => undefined, enqueue: async () => { throw new Error('unused'); }, cancel: async () => {}, subscribe: () => () => {} },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(cwd, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const bytes = Buffer.from('0123456789');
  await writeFile(join(cwd, 'clip.mp4'), bytes);
  await writeFile(join(cwd, 'empty.mp3'), '');
  await writeFile(join(cwd, 'notes.txt'), 'text');
  const media = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    fetch(`${base}/api/workspace/media?${new URLSearchParams({ cwd, path })}`, { method, headers: { cookie, ...headers } });

  assert.equal((await media('clip.mp4', { cookie: '' })).status, 401);
  const whole = await media('clip.mp4');
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-type'), 'video/mp4');
  assert.equal(whole.headers.get('content-length'), '10');
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.equal(whole.headers.get('content-disposition'), 'inline');
  assert.equal(whole.headers.get('x-content-type-options'), 'nosniff');
  assert.match(whole.headers.get('content-security-policy') ?? '', /^sandbox;/);
  assert.equal(whole.headers.get('cache-control'), 'no-store');
  assert.ok(Buffer.from(await whole.arrayBuffer()).equals(bytes));

  for (const [range, body, content] of [['bytes=2-5', '2345', 'bytes 2-5/10'], ['bytes=4-', '456789', 'bytes 4-9/10'], ['bytes=-3', '789', 'bytes 7-9/10']]) {
    const part = await media('clip.mp4', { Range: range });
    assert.equal(part.status, 206, range);
    assert.equal(part.headers.get('content-range'), content);
    assert.equal(part.headers.get('content-length'), String(body.length));
    assert.equal(await part.text(), body);
  }
  const past = await media('clip.mp4', { Range: 'bytes=10-' });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get('content-range'), 'bytes */10');
  const head = await media('clip.mp4', { Range: 'bytes=0-0' }, 'HEAD');
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-length'), '1');
  assert.equal(await head.text(), '');
  const empty = await media('empty.mp3', { Range: 'bytes=0-' });
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get('content-type'), 'audio/mpeg');
  assert.equal(await empty.text(), '');

  assert.equal((await media('notes.txt')).status, 415);
  assert.equal((await media('missing.mp4')).status, 404);
  assert.equal((await media('../clip.mp4')).status, 400);
});

test('a player leaving mid-file, or a sign-out while the file opens, ends the answer without sending it or failing the server', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'tower-media-leave-'));
  const authDir = await mkdtemp(join(tmpdir(), 'tower-media-leave-auth-'));
  t.after(() => rm(authDir, { recursive: true, force: true }));
  const { auth, origins, cookie, fetch } = await createRemoteAuthFixture(authDir);
  let signOutOnRead = false;
  const snapshot: Snapshot = { sessions: [], runs: [], providers: [], scanning: false, hostname: 'fixture', version: 'test', updatedAt: new Date().toISOString(), groups: [{ cwd, title: '', pinned: true }] };
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: cwd, auth, remote: { origins },
    backend: {
      // Reading the folder list is the media route's first step; signing out there lands while the file is opened.
      snapshot: () => { if (signOutOnRead) { signOutOnRead = false; auth.logout(cookie.slice('tower_session='.length)); } return snapshot; },
      detail: async () => undefined, enqueue: async () => { throw new Error('unused'); }, cancel: async () => {}, subscribe: () => () => {},
    },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', record);
  t.after(async () => { process.off('unhandledRejection', record); dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(cwd, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const size = 32 * 1024 * 1024;
  await writeFile(join(cwd, 'long.mp4'), Buffer.alloc(size));
  const url = `${base}/api/workspace/media?${new URLSearchParams({ cwd, path: 'long.mp4' })}`;

  const leaving = new AbortController();
  const started = await fetch(url, { headers: { cookie }, signal: leaving.signal });
  assert.equal(started.status, 200);
  await started.body!.getReader().read();
  leaving.abort();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(unhandled, [], 'a player that leaves is not a server failure');

  signOutOnRead = true;
  let received = 0;
  await fetch(url, { headers: { cookie } }).then(async response => {
    const reader = response.body!.getReader();
    for (;;) { const next = await reader.read(); if (next.done) break; received += next.value.length; }
  }).catch(() => {});
  assert.equal(received, 0, `a sign-out while the file opened still sent ${received} bytes`);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(unhandled, []);
  assert.equal((await fetch(url, { headers: { cookie } })).status, 401, 'the sign-out took effect');
});
