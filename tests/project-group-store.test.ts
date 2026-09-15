import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeProjectGroupPatch, ProjectGroupStore } from '../server/project-groups.js';
import { createMonitorServer } from '../server/http.js';
import type { Session } from '../shared/types.js';

test('project labels and pins survive restart privately without changing cwd identity or native history', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-groups-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const nativePath = join(dir, 'native.jsonl');
  const raw = '{"cwd":"/native/path","title":"untouched"}\n';
  await writeFile(nativePath, raw);
  const store = new ProjectGroupStore(dir);
  await store.start();
  const cwd = `${dir}/native/../symlink-alias/`;
  assert.deepEqual(store.list(), []);
  assert.deepEqual(await store.set({ cwd, title: '  폴더 이름  ' }), { cwd, title: '폴더 이름', pinned: false });
  await store.set({ cwd, pinned: true });
  const emptyCwd = `${dir}/not-present-anymore`;
  await store.set({ cwd: emptyCwd, pinned: true });
  await store.flush();
  const metadataPath = join(dir, 'project-groups.json');
  assert.equal((await stat(metadataPath)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(dir)).sort(), ['native.jsonl', 'project-groups.json']);
  const restarted = new ProjectGroupStore(dir); await restarted.start();
  assert.deepEqual(restarted.list(), [{ cwd, title: '폴더 이름', pinned: true }, { cwd: emptyCwd, title: '', pinned: true }]);
  const copy = restarted.list(); copy[0].title = 'must not mutate saved state';
  assert.equal(restarted.list()[0].title, '폴더 이름');
  assert.deepEqual(await restarted.set({ cwd, title: ' \n ' }), { cwd, title: '', pinned: true });
  assert.deepEqual(await restarted.set({ cwd, pinned: false }), { cwd, title: '', pinned: false });
  await restarted.set({ cwd: emptyCwd, pinned: false });
  await restarted.flush();
  const cleared = new ProjectGroupStore(dir); await cleared.start();
  assert.deepEqual(cleared.list(), []);
  assert.deepEqual(JSON.parse(await readFile(metadataPath, 'utf8')), []);
  assert.equal(await readFile(nativePath, 'utf8'), raw);
});

test('concurrent partial patches merge title and pin fields against committed metadata', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-groups-concurrency-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ProjectGroupStore(dir); await store.start();
  const cwd = '/same-project';
  const writes = await Promise.all([
    store.set({ cwd, title: 'First' }), store.set({ cwd, pinned: true }),
    store.set({ cwd, title: 'Last' }), store.set({ cwd, pinned: false }),
  ]);
  assert.deepEqual(writes.map(group => [group.title, group.pinned]), [['First', false], ['First', true], ['Last', true], ['Last', false]]);
  await Promise.all(Array.from({ length: 12 }, (_, i) => store.set({ cwd: `/other-${i}`, pinned: true })));
  const restarted = new ProjectGroupStore(dir); await restarted.start();
  assert.equal(restarted.list().length, 13);
  assert.deepEqual(restarted.list().find(group => group.cwd === cwd), { cwd, title: 'Last', pinned: false });
  assert.deepEqual(await readdir(dir), ['project-groups.json']);
});

test('a failed group save preserves memory and disk and does not poison later patches or flush', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-groups-failure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateDir = join(dir, 'state'); const savedDir = join(dir, 'saved');
  const store = new ProjectGroupStore(stateDir); await store.start();
  await store.set({ cwd: '/project', title: 'Committed' });
  await rename(stateDir, savedDir); await writeFile(stateDir, 'Prevent writes');
  await assert.rejects(store.set({ cwd: '/project', pinned: true }), { statusCode: 503 });
  await store.flush();
  assert.deepEqual(store.list(), [{ cwd: '/project', title: 'Committed', pinned: false }]);
  assert.deepEqual(JSON.parse(await readFile(join(savedDir, 'project-groups.json'), 'utf8')), store.list());
  await rm(stateDir); await rename(savedDir, stateDir);
  assert.deepEqual(await store.set({ cwd: '/project', pinned: true }), { cwd: '/project', title: 'Committed', pinned: true });
  await store.flush();
  assert.deepEqual(await readdir(stateDir), ['project-groups.json']);
});

test('group patches validate exact booleans and title limits while preserving absolute cwd strings', () => {
  assert.deepEqual(normalizeProjectGroupPatch({ cwd: '/path/../alias/ ', title: ` ${'x'.repeat(120)} ` }), { cwd: '/path/../alias/ ', title: 'x'.repeat(120) });
  assert.equal(normalizeProjectGroupPatch({ cwd: '/path', title: '😀'.repeat(60) }).title, '😀'.repeat(60));
  assert.deepEqual(normalizeProjectGroupPatch({ cwd: '/missing', pinned: false }), { cwd: '/missing', pinned: false });
  for (const invalid of [null, [], {}, { cwd: '/valid' },
    ...['relative', '', '/bad\0path', '/'.repeat(4097), 42].map(cwd => ({ cwd, pinned: true })),
    ...[undefined, null, 0, 1, 'true', [], {}].map(pinned => ({ cwd: '/valid', pinned })),
    ...[undefined, null, 42, [], {}, 'x'.repeat(121), '😀'.repeat(61)].map(title => ({ cwd: '/valid', title })),
  ]) assert.throws(() => normalizeProjectGroupPatch(invalid), { statusCode: 400 });
});

test('group startup rejects symlink metadata and invalid saved documents', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-groups-invalid-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'project-groups.json');
  for (const saved of [{}, [{ cwd: '/valid', pinned: true }], [{ cwd: '../bad', title: '', pinned: true }], [{ cwd: '/valid', title: '', pinned: 'true' }]]) {
    await writeFile(path, JSON.stringify(saved));
    await assert.rejects(new ProjectGroupStore(dir).start());
  }
  await rm(path);
  const outside = join(dir, 'outside.json'); await writeFile(outside, '[]');
  await symlink(outside, path);
  await assert.rejects(new ProjectGroupStore(dir).start());
});

test('group HTTP validates authentication, commits before SSE and allows groups with no sessions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-groups-http-'));
  const stateDir = join(dir, 'state');
  const store = new ProjectGroupStore(stateDir); await store.start();
  await mkdir(join(dir, 'client'));
  const native: Session = {
    id: 'codex:fixture', nativeId: 'fixture', provider: 'codex', title: 'Original', cwd: '/native/folder', project: 'folder', status: 'completed', statusReason: 'Finished',
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', lastMessage: 'done', messageCount: 1, isSubagent: false, resumable: true, filePath: '/private/native-log',
  };
  const original = structuredClone(native);
  let saves = 0; let notify = () => {};
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: join(dir, 'client'), remote: { password: 'test-password', origins: new Set() }, backend: {
    snapshot: () => ({ sessions: [native], groups: store.list(), runs: [], providers: [], scanning: false, hostname: 'test', version: 'test', updatedAt: native.updatedAt }),
    detail: async () => undefined,
    setGroup: async patch => { const group = await store.set(patch); saves++; notify(); return group; },
    enqueue: async () => { throw new Error('must not enqueue'); }, cancel: async () => { throw new Error('must not cancel'); },
    subscribe: listener => { notify = listener; return () => {}; },
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await store.flush(); await rm(dir, { recursive: true, force: true }); });
  const authorization = `Basic ${Buffer.from('monitor:test-password').toString('base64')}`;
  const { token } = await (await fetch(`${base}/api/bootstrap`, { headers: { authorization } })).json();
  const headers = { authorization, 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token };
  const send = (body: unknown, extra: Record<string, string> = {}) => fetch(`${base}/api/groups`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  const patch = { cwd: '/no-session-and-no-directory', title: '  Pinned project  ', pinned: true };
  assert.equal((await send(patch, { authorization: '' })).status, 401);
  assert.equal((await send(patch, { 'X-Agent-Monitor-Token': '' })).status, 403);
  assert.equal((await send(patch, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await send(patch, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await send(patch, { 'Content-Type': 'text/plain' })).status, 415);
  for (const invalid of [{}, { cwd: '/valid' }, { cwd: 'relative', pinned: true }, { cwd: '/valid', pinned: 'true' }, { cwd: '/valid', title: 'x'.repeat(121) }, null, []]) assert.equal((await send(invalid)).status, 400);
  assert.equal((await fetch(`${base}/api/groups`, { method: 'POST', headers, body: '{bad' })).status, 400);
  assert.equal(saves, 0);
  const controller = new AbortController();
  const events = await fetch(`${base}/api/events`, { headers: { authorization }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
  const reader = events.body!.getReader();
  try {
    await reader.read();
    const accepted = await send(patch);
    assert.equal(accepted.status, 200);
    const group = (await accepted.json()).group;
    assert.deepEqual(group, { cwd: patch.cwd, title: 'Pinned project', pinned: true });
    assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'project-groups.json'), 'utf8')), [group]);
    let stream = '';
    while (!stream.includes('Pinned project')) { const next = await reader.read(); if (next.done) break; stream += new TextDecoder().decode(next.value); }
    assert.match(stream, /Pinned project/); assert.doesNotMatch(stream, /private\/native-log/);
    assert.deepEqual((await (await fetch(`${base}/api/snapshot`, { headers: { authorization } })).json()).groups, [group]);
    const savedDir = join(dir, 'saved'); await rename(stateDir, savedDir); await writeFile(stateDir, 'Blocked');
    assert.equal((await send({ cwd: patch.cwd, title: 'Must not publish' })).status, 503);
    assert.equal(saves, 1);
    assert.deepEqual(store.list(), [group]);
    await rm(stateDir); await rename(savedDir, stateDir);
    assert.equal((await send({ cwd: patch.cwd, title: '' })).status, 200);
    assert.deepEqual(store.list(), [{ ...group, title: '' }]);
    assert.equal((await send({ cwd: patch.cwd, pinned: false })).status, 200);
    assert.deepEqual(store.list(), []);
    assert.deepEqual(native, original);
  } finally { controller.abort(); }
});
