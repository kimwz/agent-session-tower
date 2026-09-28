import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MasterRoom } from '../../server/master/room.js';
import { writePrivateJson } from '../../server/stores/private-json.js';
import type { MasterStreamEvent } from '../../shared/master.js';

test('the conversation is kept in order across restarts, and a changed entry replaces itself', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-master-room-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const room = new MasterRoom(dir);
  await room.start();
  for (let index = 0; index < 520; index++) room.add({ kind: 'owner', text: `m${index}` });
  const answer = room.add({ kind: 'master', text: 'answer', turnId: 't', final: true, speak: { state: 'pending' } });
  room.update(answer.id, { kind: 'master', text: 'answer', turnId: 't', final: true, speak: { state: 'played' } });
  await room.flush();
  assert.equal(((await stat(join(dir, 'room', '000000.json'))).mode & 0o777), 0o600);
  const again = new MasterRoom(dir);
  await again.start();
  assert.equal(again.lastOrder(), 520);
  const latest = await again.page(undefined, 3);
  assert.deepEqual(latest.entries.map(entry => entry.order), [518, 519, 520]);
  assert.equal(latest.hasMore, true);
  assert.equal(latest.entries[2].revision, 2);
  assert.equal(latest.entries[2].data.kind === 'master' && latest.entries[2].data.speak?.state, 'played');
  const across = await again.page(502, 5);
  assert.deepEqual(across.entries.map(entry => entry.order), [497, 498, 499, 500, 501]);
  const first = await again.page(2, 10);
  assert.deepEqual(first.entries.map(entry => entry.order), [0, 1]);
  assert.equal(first.hasMore, false);
});

test('a page resumes live changes from its position in this run, and starts over from a checkpoint otherwise', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-master-room-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const room = new MasterRoom(dir);
  await room.start();
  const heard: MasterStreamEvent[] = [];
  const stop = room.subscribe(event => heard.push(event));
  room.add({ kind: 'owner', text: 'a' });
  const { epoch, seq } = room.position();
  room.setDraft({ turnId: 't', text: 'thinking' });
  room.add({ kind: 'master', text: 'b', turnId: 't', final: true });
  stop();
  assert.deepEqual(room.since(epoch, seq)!.map(event => event.type), ['draft', 'entry']);
  assert.deepEqual(room.since(epoch, room.position().seq), []);
  assert.equal(room.since('another-run', 0), undefined);
  assert.equal(room.since(epoch, room.position().seq + 5), undefined);
  assert.deepEqual(heard.map(event => event.seq), [1, 2, 3]);
  await room.flush();
});

test('a conversation file larger than other saved state still opens: 500 long messages are allowed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-master-room-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'room'), { recursive: true, mode: 0o700 });
  const text = '가'.repeat(30_000);
  const entries = Array.from({ length: 150 }, (_, order) => ({ id: `e${order}`, order, at: new Date().toISOString(), revision: 1, data: { kind: 'owner', text } }));
  await writePrivateJson(join(dir, 'room', '000000.json'), JSON.stringify({ entries }));
  assert.ok((await stat(join(dir, 'room', '000000.json'))).size > 12_000_000);
  const room = new MasterRoom(dir);
  await room.start();
  assert.equal(room.lastOrder(), 149);
});

test('an entry from an older file is read back and updated, so something waiting to be read aloud from long ago is settled', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-master-room-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = new MasterRoom(dir);
  await first.start();
  const card = first.add({ kind: 'event', text: 'old news', speak: { state: 'pending' } });
  for (let index = 0; index < 1100; index++) first.add({ kind: 'owner', text: `m${index}` });
  await first.flush();
  const again = new MasterRoom(dir);
  await again.start();
  assert.equal(again.get(card.id), undefined, 'only the latest files are read at start');
  await again.load(card.order);
  assert.ok(again.update(card.id, { kind: 'event', text: 'old news', speak: { state: 'unspoken' } }));
  await again.flush();
  const third = new MasterRoom(dir);
  await third.start();
  const page = await third.page(1, 1);
  assert.equal(page.entries[0].data.kind === 'event' && page.entries[0].data.speak?.state, 'unspoken');
});
