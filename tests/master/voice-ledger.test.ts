import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MasterRoom } from '../../server/master/room.js';
import { MasterSettingsStore } from '../../server/master/settings.js';
import { MasterVoice } from '../../server/master/voice.js';
import { writePrivateJson } from '../../server/stores/private-json.js';
import type { MasterEntry, MasterEntryData, MasterSpeak, MasterStreamEvent } from '../../shared/master.js';

/**
 * The voice's own records (voice.json): tokens, the money they hold, how a failed save is handled, and the list of
 * news not yet read (`speaking`), through the facade and the real room, without any audio or provider.
 */

const VOICE_KEY = 'el-test-0123456789abcdef';
const TAB = '11111111-1111-4111-8111-111111111111';

interface Ledger {
  dir: string; room: MasterRoom; voice: MasterVoice; settings: MasterSettingsStore;
  stt: { calls: number; gate?: Promise<void>; fail?: boolean };
  events: MasterStreamEvent[];
  saved(): Promise<{ speaking?: Array<{ id: string; order: number }>; tokens?: unknown[]; days?: Record<string, { sttSeconds: number }> }>;
}

/** A voice over a real room and settings in a fresh folder; `prepare` runs before the voice starts. */
async function ledger(t: test.TestContext, prepare?: (room: MasterRoom, dir: string) => Promise<void>): Promise<Ledger> {
  const dir = await mkdtemp(join(tmpdir(), 'tower-voice-ledger-'));
  let voice: MasterVoice | undefined;
  let room: MasterRoom | undefined;
  // Whatever point the test stops at: the voice is closed (its saves awaited), the room's writes awaited, then the folder goes.
  t.after(async () => {
    try { await voice?.close(); } finally { await room?.flush(); await rm(dir, { recursive: true, force: true }); }
  });
  const settings = new MasterSettingsStore(dir);
  await settings.start();
  await settings.update({ voiceKey: VOICE_KEY });
  await settings.bind({ sessionId: 'claude:master', provider: 'claude', startedAt: new Date().toISOString() });
  room = new MasterRoom(dir);
  await room.start();
  await prepare?.(room, dir);
  const stt: Ledger['stt'] = { calls: 0 };
  const elevenLabs = {
    sttToken: async () => { const call = ++stt.calls; await stt.gate; if (stt.fail) throw new Error('no token'); return `sutkn_${call}`; },
    sttUrl: (token: string) => `wss://stt.invalid/?token=${token}`,
  };
  voice = new MasterVoice({ dataDir: dir, settings, room, elevenLabs: elevenLabs as never, hooks: { hide: text => text, connectedSince: () => 0, send: async () => undefined } });
  const events: MasterStreamEvent[] = [];
  room.subscribe(event => events.push(event));
  await voice.start();
  const made = voice;
  return { dir, room, voice: made, settings, stt, events,
    saved: async () => { await made.close(); return JSON.parse(await readFile(join(dir, 'voice.json'), 'utf8')); } };
}

const open = (state: MasterSpeak['state']): MasterEntryData => ({ kind: 'event', text: 'news', speak: { state } });
const speakOf = (room: MasterRoom, id: string) => (room.get(id)?.data as { speak?: MasterSpeak } | undefined)?.speak;
const voiceEvents = (events: MasterStreamEvent[]) => events.filter(event => event.type === 'voice').length;

// ─── tokens and the money they hold ────────────────────────────────────────────────────────────────────────────

test('tokens asked for at once each see the other reserved: a session holds two, and a third waits for none of them', async t => {
  const h = await ledger(t);
  const session = h.voice.voiceOn({ tabId: TAB, local: true }).session;
  let open!: () => void;
  h.stt.gate = new Promise<void>(resolve => { open = resolve; });
  const first = h.voice.voiceToken({ session });
  const second = h.voice.voiceToken({ session });
  // Both are held before either token came back.
  await assert.rejects(h.voice.voiceToken({ session }), { message: '받아쓰기 준비가 이미 되어 있습니다.' });
  assert.equal(h.stt.calls, 2, 'the third was refused before asking ElevenLabs');
  open();
  const tokens = await Promise.all([first, second]);
  assert.notEqual(tokens[0].tokenId, tokens[1].tokenId);
});

test('a token ElevenLabs refuses is given back, but still counts toward the minute; nothing is saved or told for it', async t => {
  const h = await ledger(t);
  const session = h.voice.voiceOn({ tabId: TAB, local: true }).session;
  h.stt.fail = true;
  const before = voiceEvents(h.events);
  for (let index = 0; index < 20; index++) await assert.rejects(h.voice.voiceToken({ session }), { message: 'no token' });
  assert.equal(voiceEvents(h.events), before, 'no broadcast for a refused token');
  h.stt.fail = false;
  // None is held (a session could take two), but the minute has had its twenty asks.
  await assert.rejects(h.voice.voiceToken({ session }), { message: '받아쓰기 요청이 너무 많습니다.' });
  assert.equal(h.stt.calls, 20);
  assert.deepEqual((await h.saved()).tokens, []);
});

test('a token runs out only after strictly sixteen minutes, then counts as a whole utterance; an utterance is clamped to 0–180 seconds', async t => {
  const h = await ledger(t);
  const start = Date.parse('2026-10-03T03:00:00.000Z');
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const session = h.voice.voiceOn({ tabId: TAB, local: true }).session;
  await h.voice.voiceToken({ session });
  await h.voice.voiceToken({ session });
  // At exactly sixteen minutes both are still held: a third is refused.
  t.mock.timers.setTime(start + 16 * 60_000);
  await assert.rejects(h.voice.voiceToken({ session }), { message: '받아쓰기 준비가 이미 되어 있습니다.' });
  assert.equal(h.voice.status().today.sttSeconds, 0);
  // A moment later both ran out: counted whole, and the session may take tokens again.
  t.mock.timers.setTime(start + 16 * 60_000 + 1);
  const used: Array<{ tokenId: string }> = [];
  used.push(await h.voice.voiceToken({ session }));
  assert.equal(h.voice.status().today.sttSeconds, 360);
  used.push(await h.voice.voiceToken({ session }));
  assert.equal(await h.voice.voiceUsage({ tokenId: used[0].tokenId, seconds: -5 }), true);
  assert.equal(h.voice.status().today.sttSeconds, 360, 'below zero counts as zero');
  assert.equal(await h.voice.voiceUsage({ tokenId: used[1].tokenId, seconds: Number.NaN }), true);
  assert.equal(h.voice.status().today.sttSeconds, 540, 'not a number counts as a whole utterance');
  used.push(await h.voice.voiceToken({ session }));
  assert.equal(await h.voice.voiceUsage({ tokenId: used[2].tokenId, seconds: 999 }), true);
  assert.equal(h.voice.status().today.sttSeconds, 720, 'at most 180 seconds');
  used.push(await h.voice.voiceToken({ session }));
  assert.equal(await h.voice.voiceUsage({ tokenId: used[3].tokenId, seconds: '30' }), true);
  assert.equal(h.voice.status().today.sttSeconds, 900, 'a string counts as a whole utterance');
});

test('a save that fails is reported and leaves the next save to write everything as it is then', async t => {
  const logged: string[] = [];
  t.mock.method(console, 'error', (line: string) => { logged.push(line); });
  const h = await ledger(t);
  const session = h.voice.voiceOn({ tabId: TAB, local: true }).session;
  const token = await h.voice.voiceToken({ session });
  // The records cannot be written where they go.
  await rm(join(h.dir, 'voice.json'), { force: true });
  await mkdir(join(h.dir, 'voice.json'));
  const before = voiceEvents(h.events);
  await assert.rejects(h.voice.voiceUsage({ tokenId: token.tokenId, seconds: 7 }));
  assert.equal(voiceEvents(h.events), before, 'not told when the change was not saved');
  assert.equal(h.voice.status().today.sttSeconds, 7, 'the change stands in memory');
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^Master voice records were not saved: E[A-Z]+$/);
  // Once it can be written again, the next save writes the records as they are by then.
  await rm(join(h.dir, 'voice.json'), { recursive: true, force: true });
  await h.voice.voiceToken({ session });
  const saved = await h.saved();
  assert.equal(saved.tokens?.length, 1);
  assert.equal(Object.values(saved.days ?? {})[0]?.sttSeconds, 7);
});

// ─── news not yet read (`speaking`) ────────────────────────────────────────────────────────────────────────────

test('a 501st open entry gives up the oldest open one: it is marked queue once, and 500 stay listed', async t => {
  const h = await ledger(t);
  const entries: MasterEntry[] = [];
  for (let index = 0; index < 501; index++) entries.push(h.room.add(open('playing')));
  assert.deepEqual(speakOf(h.room, entries[0].id), { state: 'unspoken', reason: 'queue' });
  assert.equal(h.room.get(entries[0].id)!.revision, 2, 'given up on once');
  for (const entry of entries.slice(1)) assert.deepEqual(speakOf(h.room, entry.id), { state: 'playing' });
  const saved = await h.saved();
  assert.equal(saved.speaking?.length, 500);
  assert.deepEqual(saved.speaking?.map(item => item.id), entries.slice(1).map(entry => entry.id));
});

test('listed news no longer open is dropped from the front without being marked, and a duplicate listing is removed one at a time', async t => {
  const room: { entries: MasterEntry[] } = { entries: [] };
  const h = await ledger(t, async (made, dir) => {
    // Kept by an earlier version: one entry listed twice (same id and order), and news already read.
    for (let index = 0; index < 499; index++) room.entries.push(made.add(open('played')));
    const twice = room.entries[0];
    await writePrivateJson(join(dir, 'voice.json'), JSON.stringify({ version: 6, days: {}, tokens: [],
      speaking: [{ id: twice.id, order: twice.order }, { id: twice.id, order: twice.order }, ...room.entries.slice(1).map(entry => ({ id: entry.id, order: entry.order }))] }));
  });
  const twice = room.entries[0];
  // Open again: still listed (twice), so nothing changes in the list.
  h.room.update(twice.id, open('playing'));
  // The 501st: the oldest listed is open, so it is given up on; the room's change removes its first listing, and the
  // second listing (equal in value) stays.
  const added = h.room.add(open('playing'));
  assert.deepEqual(speakOf(h.room, twice.id), { state: 'unspoken', reason: 'queue' });
  // As saved right after: the second listing is still there (a listing equal in value is not the one given up on).
  let listed: Array<{ id: string }> = [];
  for (let tries = 0; !listed.some(item => item.id === added.id); tries++) {
    if (tries > 1000) throw new Error('the list was not saved');
    await new Promise(resolve => setTimeout(resolve, 5));
    listed = (JSON.parse(await readFile(join(h.dir, 'voice.json'), 'utf8').catch(() => '{"speaking":[]}')) as { speaking: Array<{ id: string }> }).speaking;
  }
  assert.equal(listed.length, 500);
  assert.equal(listed.filter(item => item.id === twice.id).length, 1);
  assert.equal(listed[0].id, twice.id);
  // The next: the oldest listed is now the second listing, no longer open: dropped from the front, unmarked.
  const revision = h.room.get(twice.id)!.revision;
  const next = h.room.add(open('playing'));
  assert.equal(h.room.get(twice.id)!.revision, revision, 'not marked again');
  const saved = await h.saved();
  assert.equal(saved.speaking?.length, 500);
  assert.equal(saved.speaking?.filter(item => item.id === twice.id).length, 0);
  assert.deepEqual(saved.speaking?.slice(-2).map(item => item.id), [added.id, next.id]);
});

test('at start, the list is rebuilt from the room only when the saved one is missing or not a list; a rebuild past 500 gives up the oldest', async t => {
  const prepare = (speaking: unknown, count: number) => async (room: MasterRoom, dir: string) => {
    for (let index = 0; index < count; index++) room.add(open('playing'));
    if (speaking !== 'no file') await writePrivateJson(join(dir, 'voice.json'), JSON.stringify(speaking));
  };
  const states = (room: MasterRoom) => room.recent(1000).map(entry => (entry.data as { speak?: MasterSpeak }).speak);
  // Rebuilt (no speaking key) with 501 open. The room is read newest page first (200 at a time), so the list starts at
  // order 301; the 501st listed overflows it and the first listed (order 301) is given up on, before the voice listens
  // to the room. The rest end with the restart.
  const rebuilt = await ledger(t, prepare({ version: 6, days: {}, tokens: [] }, 501));
  const after = states(rebuilt.room);
  assert.deepEqual(after.flatMap((speak, order) => speak?.reason === 'queue' ? [order] : []), [301]);
  assert.ok(after.every((speak, order) => order === 301 || (speak?.state === 'unspoken' && speak.reason === 'restart')));
  assert.deepEqual((await rebuilt.saved()).speaking, []);
  // Rebuilt for a speaking that is not a list, and for saved data that is not an object at all.
  for (const saved of [{ version: 6, days: {}, tokens: [], speaking: 'x' }, 5]) {
    const h = await ledger(t, prepare(saved, 2));
    assert.ok(states(h.room).every(speak => speak?.state === 'unspoken' && speak.reason === 'restart'), JSON.stringify(saved));
  }
  // Not rebuilt for a saved empty list, nor without a saved file: open entries the list does not name stay as they are.
  for (const saved of [{ version: 6, days: {}, tokens: [], speaking: [] }, 'no file']) {
    const h = await ledger(t, prepare(saved, 2));
    assert.ok(states(h.room).every(speak => speak?.state === 'playing'), JSON.stringify(saved));
  }
});

test('at start, listed news still pending or playing is marked restart; the rest of the list is kept and saved', async t => {
  const ids: Record<string, MasterEntry> = {};
  const h = await ledger(t, async (room, dir) => {
    for (const state of ['pending', 'playing', 'played'] as const) ids[state] = room.add(open(state));
    await writePrivateJson(join(dir, 'voice.json'), JSON.stringify({ version: 6, days: {}, tokens: [],
      speaking: Object.values(ids).map(entry => ({ id: entry.id, order: entry.order })) }));
  });
  assert.deepEqual(speakOf(h.room, ids.pending.id), { state: 'unspoken', reason: 'restart' });
  assert.deepEqual(speakOf(h.room, ids.playing.id), { state: 'unspoken', reason: 'restart' });
  assert.deepEqual(speakOf(h.room, ids.played.id), { state: 'played' });
  assert.deepEqual((await h.saved()).speaking, [{ id: ids.played.id, order: ids.played.order }]);
});
