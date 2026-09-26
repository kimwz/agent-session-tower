import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatImageReference, MAX_CHAT_IMAGE_BYTES, readChatImage, withChatImages } from '../../../server/http/chat-images.js';
import { createMonitorServer } from '../../../server/http/server.js';
import type { Session, SessionDetail } from '../../../shared/types.js';
import { createRemoteAuthFixture } from '../../helpers/auth.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'tower-images-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project'); await mkdir(cwd);
  const session = { id: 'image-session', provider: 'codex', cwd, filePath: join(root, 'codex/sessions/session.jsonl') } as Session;
  const image = join(cwd, '한 글.png'); await writeFile(image, png);
  const page: SessionDetail = { session, hasMore: false, messages: [{ id: 'm', role: 'assistant', text: `![시안](<${image}>)`, timestamp: '' }] };
  return { root, cwd, session, image, page };
}
test('conversation references receive signed URLs; generated result paths and relative links work', async t => {
  const { session, image, page } = await fixture(t);
  const result = withChatImages(page).messages[0].images!;
  assert.equal(result.length, 1);
  assert.deepEqual(chatImageReference(result[0].url.split('/').at(-1)!), { sessionId: session.id, path: image });
  await assert.doesNotReject(() => readChatImage(session, image));
  assert.throws(() => chatImageReference(result[0].url.split('/').at(-1)! + 'x'));
  assert.equal(withChatImages({ ...page, messages: [{ ...page.messages[0], role: 'tool', toolName: 'exec' }] }).messages[0].images, undefined);
  const generated = session.filePath!.replace('/sessions/session.jsonl', '/generated_images/a/result.png');
  const sources = withChatImages({ ...page, messages: [{ ...page.messages[0], role: 'tool', text: `Generated images are saved as ${generated}` }] }).messages[0].images!;
  assert.equal(sources[0].source, generated);
  assert.equal(withChatImages({ ...page, messages: [{ ...page.messages[0], text: '![x](%ED%95%9C%20%EA%B8%80.png)' }] }).messages[0].images?.length, 1);
  for (const source of ['/etc/private.png', 'https://example.com/a.png', '//example.com/a.png', '../private.png', 'javascript:x.png']) {
    assert.equal(withChatImages({ ...page, messages: [{ ...page.messages[0], text: `![x](${source})` }] }).messages[0].images, undefined);
  }
});
test('reader rejects traversal, symlink escape, non-images, directories, missing and oversized files', async t => {
  const { root, cwd, session } = await fixture(t);
  const outside = join(root, 'outside.png'); await writeFile(outside, png);
  const linked = join(cwd, 'link.png'); await symlink(outside, linked);
  const fake = join(cwd, 'fake.png'); await writeFile(fake, '<svg onload="alert(1)"/>');
  const huge = join(cwd, 'huge.png'); await writeFile(huge, Buffer.alloc(MAX_CHAT_IMAGE_BYTES + 1));
  for (const path of [outside, linked, fake, huge, cwd, join(cwd, 'missing.png')]) await assert.rejects(() => readChatImage(session, path), { statusCode: 404 });
});
test('image endpoint requires authentication and serves exact bytes with safe headers and HEAD', async t => {
  const { root, session, page } = await fixture(t);
  const { auth, origins, cookie, fetch } = await createRemoteAuthFixture(join(root, 'auth'));
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: root, auth, remote: { origins }, backend: {
    snapshot: () => ({ sessions: [session], runs: [], providers: [], scanning: false, hostname: 'fixture', version: 'test', updatedAt: '' }),
    detail: async () => page, enqueue: async () => { throw new Error('unused'); }, cancel: async () => {}, subscribe: () => () => {},
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const detail = await (await fetch(`${base}/api/sessions/${session.id}`, { headers: { cookie } })).json();
  const url = base + detail.messages[0].images[0].url;
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, { headers: { cookie } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  const head = await fetch(url, { method: 'HEAD', headers: { cookie } });
  assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await fetch(url + 'tampered', { headers: { cookie } })).status, 404);
});

test('joined-computer image access rechecks excluded files and session visibility', async t => {
  const { createServer } = await import('node:http');
  const { RemoteExclusionStore } = await import('../../../server/remote/exclusions.js');
  const { createRemoteRouter } = await import('../../../server/remote/router.js');
  const { root, cwd, session, page } = await fixture(t);
  const hidden = join(cwd, 'hidden'); await mkdir(hidden);
  const path = join(hidden, 'icon.png'); await writeFile(path, png);
  await mkdir(join(root, 'state'));
  const exclusions = new RemoteExclusionStore(join(root, 'state')); await exclusions.start();
  let coordinator = false;
  const router = createRemoteRouter({ exclusions, backend: {
    snapshot: () => ({ sessions: [session], runs: [], providers: [], scanning: false, hostname: 'fixture', version: 'test', updatedAt: '' }),
    session: id => id === session.id ? session : undefined, coordinators: () => new Set(coordinator ? [session.id] : []),
    detail: async () => ({ ...page, messages: [{ ...page.messages[0], text: `![icon](${path})` }] }),
    enqueue: async () => { throw new Error('unused'); }, cancel: async () => {}, subscribe: () => () => {},
  } });
  const server = createServer((req, res) => { void router.handle(req, res, { controllerId: 'fixture' }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { router.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const detail = await (await fetch(`${base}/api/sessions/${session.id}`)).json();
  const url = base + detail.messages[0].images[0].url;
  assert.equal((await fetch(url)).status, 200);
  coordinator = true;
  assert.equal((await fetch(url)).status, 404);
  coordinator = false;
  await exclusions.add(hidden);
  assert.equal((await fetch(url)).status, 404);
});
