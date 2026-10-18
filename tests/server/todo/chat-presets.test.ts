import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitorServer } from '../../../server/http/server.js';
import { TodoStore } from '../../../server/todo/store.js';
import { TowerError } from '../../../shared/errors.js';
import { MAX_CHAT_PRESETS, parseChatPresets } from '../../../shared/todo/chat-presets.js';
import type { Snapshot } from '../../../shared/types.js';

const kind = (error: unknown) => error instanceof TowerError ? error.kind : undefined;

test('the chat presets are refused whole unless every one is a distinct text of 1 to 500 characters', () => {
  assert.deepEqual(parseChatPresets(['  작업 시작 해줘 ', '설계 해줘']), ['작업 시작 해줘', '설계 해줘']);
  assert.deepEqual(parseChatPresets([]), []);
  assert.equal(parseChatPresets(null), null);
  for (const bad of [undefined, 'a', {}, [1], [''], ['  '], ['x'.repeat(501)], ['a', ' a'], Array.from({ length: MAX_CHAT_PRESETS + 1 }, (_, index) => `p${index}`)]) {
    assert.throws(() => parseChatPresets(bad), (error: unknown) => kind(error) === 'invalid', JSON.stringify(bad)?.slice(0, 40));
  }
});

test('saved presets come with the overview, survive reopening, and move the revision; null goes back to the defaults', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-todo-presets-'));
  const store = new TodoStore(dir);
  store.start();
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  assert.equal(store.chatPresets(), null);
  assert.equal('chatPresets' in store.overview(), false, 'nothing saved: the page shows the defaults');

  const before = store.revision();
  assert.deepEqual(store.setChatPresets(['조사 해줘', ' 작업 시작 해줘']), ['조사 해줘', '작업 시작 해줘']);
  assert.equal(store.revision(), before + 1, 'open pages read the overview again');
  assert.deepEqual(store.overview().chatPresets, ['조사 해줘', '작업 시작 해줘']);
  assert.throws(() => store.setChatPresets(['a', 'a']), (error: unknown) => kind(error) === 'invalid');
  assert.deepEqual(store.chatPresets(), ['조사 해줘', '작업 시작 해줘'], 'a refused list changes nothing');

  store.close();
  const again = new TodoStore(dir);
  again.start();
  t.after(() => again.close());
  assert.deepEqual(again.chatPresets(), ['조사 해줘', '작업 시작 해줘']);
  assert.deepEqual(again.setChatPresets([]), []);
  assert.deepEqual(again.overview().chatPresets, [], 'an empty list stays empty: the owner removed every button');
  assert.equal(again.setChatPresets(null), null);
  assert.equal(again.chatPresets(), null);
  assert.equal('chatPresets' in again.overview(), false);
});

test('anyone may read the presets; only the owner\'s page with its request token saves them', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-todo-presets-http-'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Tower</title>');
  let presets: string[] | null = null;
  const saves: unknown[] = [];
  const snapshot = (): Snapshot => ({ sessions: [], runs: [], providers: [], scanning: false, hostname: 'test', version: 'test', updatedAt: new Date().toISOString(), todoRevision: 0 });
  const unused = () => { throw new Error('unused'); };
  const masterSecret = 'm'.repeat(64);
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, master: { callerSecret: masterSecret, handle: async () => false }, backend: {
    snapshot, detail: async () => undefined, enqueue: async () => unused(), cancel: async () => {}, subscribe: () => () => {},
    todos: {
      overview: unused, detail: unused, completed: unused, search: unused, apply: unused,
      chatPresets: () => presets,
      setChatPresets: input => { saves.push(input); presets = parseChatPresets(input); return presets; },
    },
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const { token } = await (await fetch(`${base}/api/bootstrap`)).json() as { token: string };
  const headers = { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token, Origin: base };
  const save = (body: unknown, extra: Record<string, string> = {}, without?: string) => {
    const sent: Record<string, string> = { ...headers, ...extra };
    if (without) delete sent[without];
    return fetch(`${base}/api/todos/chat-presets`, { method: 'POST', headers: sent, body: JSON.stringify(body) });
  };

  assert.deepEqual(await (await fetch(`${base}/api/todos/chat-presets`)).json(), { presets: null });
  // Not the owner's page: the master, a local agent, no page token, or no page origin.
  for (const extra of <Record<string, string>[]>[{ 'X-Tower-Master': masterSecret }, { 'X-Tower-Agent': 'local' }]) assert.equal((await save({ presets: ['a'] }, extra)).status, 403, JSON.stringify(extra));
  assert.equal((await save({ presets: ['a'] }, {}, 'X-Agent-Monitor-Token')).status, 403, 'the request token is checked with the origin in place');
  assert.equal((await save({ presets: ['a'] }, {}, 'Origin')).status, 403);
  for (const body of [{}, { presets: ['a'], extra: 1 }, { presets: 'a' }, { presets: [''] }]) assert.equal((await save(body)).status, 400, JSON.stringify(body));
  assert.equal(presets, null);
  assert.equal(saves.length, 2, 'only bodies of the right shape reach the store, which refuses the bad list');

  const saved = await save({ presets: ['설계 해줘', '작업 시작 해줘'] });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { presets: ['설계 해줘', '작업 시작 해줘'] });
  assert.deepEqual(await (await fetch(`${base}/api/todos/chat-presets`)).json(), { presets: ['설계 해줘', '작업 시작 해줘'] });
  assert.deepEqual(await (await save({ presets: null })).json(), { presets: null });
});
