import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MasterRoom } from '../../server/master/room.js';
import { MasterSettingsStore } from '../../server/master/settings.js';
import { MasterVoice } from '../../server/master/voice.js';
import type { MasterStreamEvent } from '../../shared/master.js';
import { until } from '../helpers/until.js';

/**
 * Audio being made, through the facade with a stand-in for ElevenLabs: what is charged and told when, and that audio
 * taken out of the store while it is being recorded is still written whole.
 */

const VOICE_KEY = 'el-test-0123456789abcdef';
type Speech = 'sound' | 'fail-before-sound' | 'sound-then-fail' | { gate: Promise<void>; bytes: string };

async function audio(t: test.TestContext, speeches: Speech[]) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-voice-audio-'));
  let voice: MasterVoice | undefined;
  let room: MasterRoom | undefined;
  const pending = new Set<Promise<unknown>>();
  // Whatever point the test stops at: work it started settles, the voice closes, the room's writes end, the folder goes.
  t.after(async () => {
    try { await Promise.allSettled([...pending]); await voice?.close(); } finally { await room?.flush(); await rm(dir, { recursive: true, force: true }); }
  });
  const settings = new MasterSettingsStore(dir);
  await settings.start();
  await settings.update({ voiceKey: VOICE_KEY });
  room = new MasterRoom(dir);
  await room.start();
  const asked: string[] = [];
  const elevenLabs = {
    speak: async function* (text: string) {
      asked.push(text);
      const speech = speeches.shift() ?? 'sound';
      if (speech === 'fail-before-sound') throw new Error('no sound');
      if (typeof speech === 'object') { await speech.gate; yield Buffer.from(speech.bytes); return; }
      yield Buffer.from(`sound:${text}`);
      if (speech === 'sound-then-fail') throw new Error('cut');
    },
  };
  voice = new MasterVoice({ dataDir: dir, settings, room, elevenLabs: elevenLabs as never, hooks: { hide: text => text, connectedSince: () => 0, send: async () => undefined } });
  const events: MasterStreamEvent[] = [];
  room.subscribe(event => events.push(event));
  await voice.start();
  const made = voice;
  return { dir, voice: made, asked, events, pend: <T>(work: Promise<T>) => { pending.add(work); work.catch(() => {}); return work; },
    told: () => events.filter(event => event.type === 'voice').length };
}

/** Test-only access to the private start of audio making (C8: the private audio owner's synthesize; before, the facade's own). */
const synthesize = (voice: MasterVoice, text: string | string[]) => (voice as unknown as { audio: { synthesize(text: string | string[]): { id: string } } }).audio.synthesize(text);

test('audio being made is charged and told once at its start; a part asked for again is charged but not told; parts never asked for are given back and told', async t => {
  // A part that fails before any sound is asked for once more: charged again, told nothing more.
  const retried = await audio(t, ['fail-before-sound', 'sound']);
  synthesize(retried.voice, 'abc');
  assert.equal(retried.told(), 1, 'told once at its start');
  assert.equal(retried.voice.status().today.ttsChars, 3);
  await until(() => !retried.voice.busy());
  assert.deepEqual(retried.asked, ['abc', 'abc']);
  assert.equal(retried.voice.status().today.ttsChars, 6, 'the second ask is paid for');
  assert.equal(retried.told(), 1, 'and not told');
  // A part cut off after its first sound fails the audio: the parts never asked for are given back, and told.
  const cut = await audio(t, ['sound-then-fail']);
  synthesize(cut.voice, ['abc', 'defg']);
  assert.equal(cut.told(), 1);
  assert.equal(cut.voice.status().today.ttsChars, 7, 'every part is charged at the start');
  await until(() => !cut.voice.busy());
  assert.deepEqual(cut.asked, ['abc'], 'the second part was never asked for');
  assert.equal(cut.voice.status().today.ttsChars, 3, 'and is given back');
  await until(() => cut.told() === 2);
});

test('a recording finished but taken out of the store before it is written is still written whole', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reached!: () => void;
  const atFolder = new Promise<void>(resolve => { reached = resolve; });
  const original = fsPromises.mkdir;
  t.mock.method(fsPromises, 'mkdir', async (...args: Parameters<typeof original>) => {
    if (String(args[0]).endsWith('voice-previews')) { reached(); await gate; }
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { release(); t.mock.restoreAll(); syncBuiltinESMExports(); });
  const h = await audio(t, [{ gate: Promise.resolve(), bytes: 'ID3-whole-recording' }]);
  const preview = h.pend(h.voice.voicePreview({ voiceId: 'bv62BmVlrpG0pQegOpuN' }));
  // Made and finished; waiting for its folder.
  await atFolder;
  // Every audio is taken out of the store (as the host closing does) before the recording is written.
  await h.voice.close();
  assert.equal(h.voice.busy(), false);
  release();
  const { audio: path } = await preview;
  const key = path.split('preview-')[1];
  assert.deepEqual(await readdir(join(h.dir, 'voice-previews')), [`${key}.mp3`]);
  assert.equal(await readFile(join(h.dir, 'voice-previews', `${key}.mp3`), 'utf8'), 'ID3-whole-recording');
});
