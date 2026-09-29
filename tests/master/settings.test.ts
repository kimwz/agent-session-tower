import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MasterSettingsStore } from '../../server/master/settings.js';

test('settings saved before reading speed existed read at the speed as made, and are written back with it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-master-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ voice: { voiceId: 'cgSgspJ2msm6clMCkdW9', model: 'eleven_v3', endSilenceMs: 1200, listenMinutes: 5, readReports: true, dailyDollars: 2 } }));
  const store = new MasterSettingsStore(dir);
  await store.start();
  assert.equal(store.current().voice.playbackRate, 1);
  assert.equal(store.current().voice.model, 'eleven_v3');
  assert.equal(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')).voice.playbackRate, 1);
  assert.equal((await store.update({ voice: { playbackRate: 1.6 } })).voice.playbackRate, 1.6);
  const again = new MasterSettingsStore(dir);
  await again.start();
  assert.equal(again.current().voice.playbackRate, 1.6);
});
