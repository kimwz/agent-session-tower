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

test('heartbeat defaults migrate old settings and validated partial edits preserve voice and binding', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-heartbeat-settings-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ voice: { playbackRate: 1.4 } }));
  const store = new MasterSettingsStore(dir); await store.start(); assert.equal(store.current().heartbeat.intervalMinutes, 30); assert.equal(store.current().heartbeat.enabled, true);
  await store.update({ heartbeat: { enabled: false, intervalMinutes: 45, prompt: 'Inspect actual recent task evidence' } });
  assert.equal(store.current().voice.playbackRate, 1.4); assert.equal(store.current().heartbeat.enabled, false);
  for (const invalid of [{ intervalMinutes: 0 }, { intervalMinutes: 1.2 }, { prompt: '' }, { unknown: true }, { enabled: 'yes' }]) await assert.rejects(store.update({ heartbeat: invalid }), /Heartbeat/);
  const again = new MasterSettingsStore(dir); await again.start(); assert.deepEqual(again.current().heartbeat, store.current().heartbeat);
});
