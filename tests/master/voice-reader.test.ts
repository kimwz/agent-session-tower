import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MasterRoom } from '../../server/master/room.js';
import { MasterSettingsStore } from '../../server/master/settings.js';
import { MasterVoice } from '../../server/master/voice.js';
import type { MasterStreamEvent } from '../../shared/master.js';

/**
 * Reading a turn while it is written, around its record (`streamState`): a turn whose `started` record is still being
 * kept when its voice session ends, or the host closes, is never read; the record's late answer cannot bring it back.
 */

const VOICE_KEY = 'el-test-0123456789abcdef';
const WORDS = '지금 확인한 결과를 하나씩 알려 드릴게요. 다음 ';

/**
 * A voice over a real room and settings, with the `started` record held by the test.
 *
 * Every piece of work the fixture sets going is tracked from the moment it exists: each `started` record's
 * continuation (the record is a thenable, so whatever the voice chains on it is a promise kept here), each task on the
 * voice's one playback line (its private `onLine`, wrapped on this instance only: test-only), and each fake speech
 * request until its generator ends. The after hook, added first, then: lets every held record go, closes the voice,
 * waits until all tracked work has settled and nothing new was added (or fails and keeps the folder), flushes the
 * voice's records, its timings and the room, and only then removes this fixture's own folder.
 */
async function reader(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-voice-reader-'));
  let voice: MasterVoice | undefined;
  let room: MasterRoom | undefined;
  const gates: Array<() => void> = [];
  const work = new Set<Promise<unknown>>();
  const track = <T>(promise: Promise<T>): Promise<T> => { work.add(promise); promise.catch(() => {}); return promise; };
  t.after(async () => {
    for (const open of gates) open();
    try { await voice?.close(); } finally {
      // Everything set going has settled, including what settling set going.
      const deadline = Date.now() + 10_000;
      for (let seen = -1; seen !== work.size;) {
        seen = work.size;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settled = await Promise.race([Promise.allSettled([...work]).then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now())); })]);
        clearTimeout(timer);
        if (!settled) throw new Error(`Voice work did not settle; ${dir} is kept.`);
      }
      // The voice's own records as last written (test-only: its private records owner, or before C8 its write tail).
      const records = voice as unknown as { usage?: { flush(): Promise<void> }; writes?: Promise<void> } | undefined;
      await (records?.usage ? records.usage.flush() : records?.writes);
      await voice?.timings.flush();
      await room?.flush();
      await rm(dir, { recursive: true, force: true });
    }
  });
  const settings = new MasterSettingsStore(dir);
  await settings.start();
  await settings.update({ voiceKey: VOICE_KEY });
  await settings.bind({ sessionId: 'claude:master', provider: 'claude', startedAt: new Date().toISOString() });
  room = new MasterRoom(dir);
  await room.start();
  const speeches: string[] = [];
  const elevenLabs = {
    speak: (text: string) => {
      let ended!: () => void;
      track(new Promise<void>(resolve => { ended = resolve; }));
      return (async function* () { try { speeches.push(text); yield Buffer.from(`sound:${text}`); } finally { ended(); } })();
    },
  };
  const states: string[] = [];
  /** The next `started` record is kept only when the test says how it went. */
  let held: { settle: (ok: boolean) => void } | undefined;
  const streamState = (turn: string, state: 'started' | 'stopped' | 'done') => {
    states.push(`${turn}:${state}`);
    if (state !== 'started') return Promise.resolve();
    const record = new Promise<void>((resolve, reject) => {
      const settle = (ok: boolean) => { if (ok) resolve(); else reject(new Error('not kept')); };
      held = { settle };
      gates.push(() => settle(true));
    });
    record.catch(() => {});
    // What the voice chains on the record is tracked as it is chained.
    return { then: (resolved?: () => unknown, rejected?: (error: unknown) => unknown) => track(record.then(resolved, rejected)) } as unknown as Promise<void>;
  };
  voice = new MasterVoice({ dataDir: dir, settings, room, elevenLabs: elevenLabs as never, timing: { firstChunkMs: 1_000, synthMs: 2_000, playMs: 200, waitMs: 200, presenceMs: 60_000 },
    hooks: { hide: text => text, connectedSince: () => 0, send: async () => undefined, streamState } });
  // Test-only: the voice's one playback line, tracked task by task (this instance only).
  const line = voice as unknown as { onLine<T>(work: () => Promise<T>): Promise<T> };
  const onLine = line.onLine.bind(voice);
  line.onLine = task => track(onLine(task));
  const events: MasterStreamEvent[] = [];
  room.subscribe(event => events.push(event));
  await voice.start();
  const made = voice;
  const turn = (id: string) => ({ turn: id, kind: 'answer' as const, key: `key-${id}`, replies: [{ id: `${id}:0`, text: WORDS }] });
  return { voice: made, states, speeches, events, turn, on: () => made.voiceOn({ tabId: randomUUID(), local: true }).session,
    settle: (ok: boolean) => { const current = held; held = undefined; current?.settle(ok); },
    says: () => events.filter(event => event.type === 'say').length };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 50));

test('a turn whose started record is kept while its voice session is still on is read (the control)', async t => {
  const h = await reader(t);
  h.on();
  h.voice.stream(h.turn('t1'));
  assert.deepEqual(h.states, ['t1:started']);
  assert.equal(h.voice.streaming('t1'), true);
  h.settle(true);
  for (let tries = 0; !h.speeches.length; tries++) { if (tries > 400) throw new Error('not read'); await tick(); }
  assert.deepEqual(h.speeches, ['지금 확인한 결과를 하나씩 알려 드릴게요.'], 'the first whole sentence, without a tone tag on the default model (Eleven v4 Turbo)');
});

test('a started record kept only after its voice session ended never starts the reading', async t => {
  const h = await reader(t);
  h.on();
  h.voice.stream(h.turn('t1'));
  // Voice moves to another tab while the record is being kept.
  h.on();
  assert.deepEqual(h.states, ['t1:started', 't1:stopped']);
  assert.equal(h.voice.streaming('t1'), false);
  h.settle(true);
  await tick();
  assert.deepEqual(h.speeches, [], 'nothing is made');
  assert.equal(h.says(), 0, 'nothing is said');
  assert.deepEqual(h.states, ['t1:started', 't1:stopped'], 'no record after');
});

test('a started record refused after its voice session ended changes nothing more', async t => {
  const h = await reader(t);
  h.on();
  h.voice.stream(h.turn('t1'));
  h.on();
  h.settle(false);
  await tick();
  assert.deepEqual(h.speeches, []);
  assert.equal(h.says(), 0);
  assert.deepEqual(h.states, ['t1:started', 't1:stopped'], 'stopped once, not again for the refusal');
});

test('a started record kept only after the host closed never starts the reading', async t => {
  const h = await reader(t);
  h.on();
  h.voice.stream(h.turn('t1'));
  await h.voice.close();
  assert.deepEqual(h.states, ['t1:started', 't1:stopped']);
  h.settle(true);
  await tick();
  assert.deepEqual(h.speeches, []);
  assert.equal(h.says(), 0);
});

test('after the host closed, voice can be turned on but a turn is neither recorded nor read', async t => {
  const h = await reader(t);
  await h.voice.close();
  h.on();
  h.voice.stream(h.turn('t1'));
  await tick();
  assert.deepEqual(h.states, [], 'no started record');
  assert.equal(h.voice.streaming('t1'), false);
  assert.deepEqual(h.speeches, []);
});
