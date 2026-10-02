import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VoiceTimings, progressRecord, playbackRecord, transportStage, type VoiceProgressEvent } from '../../server/master/voice-timings.js';

test('voice traces retain first source, retry and waiting stages across later progress', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-stages-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const timings = new VoiceTimings(join(dir, 'timings.json'));
  timings.mark('key', 'request', 100);
  timings.said('key', 'say', 200, 1);
  const events: VoiceProgressEvent[] = ['source', 'waiting', 'retry', 'source', 'resumed', ...Array<VoiceProgressEvent>(75).fill('progress')];
  for (const [i, event] of events.entries()) {
    timings.progress('key', 'say', { event, at: 300 + i, elapsedMs: i, attempt: i > 1 ? 1 : 0 });
  }
  const say = timings.list()[0].says![0];
  assert.equal(say.source!.at, 300);
  assert.deepEqual(say.events!.slice(0, 5).map(item => item.event), ['source', 'waiting', 'retry', 'source', 'resumed']);
  assert.equal(say.events!.length, 64);
  assert.equal(say.events![15].elapsedMs, 15);
  assert.equal(say.events![16].elapsedMs, 32);
  assert.equal(say.events!.at(-1)!.elapsedMs, 79);
  assert.equal(say.droppedEvents, 16);
  await timings.flush();
});


test('terminal ACK preserves receipt and page elapsed separately from inferred start', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-terminal-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const timings = new VoiceTimings(join(dir, 'timings.json'));
  timings.mark('key', 'request', 100);
  timings.said('key', 'say', 200, 1);
  timings.terminal('key', 'say', { event: 'terminal', at: 40_000, elapsedMs: 39_800, attempt: 1, result: 'played' });
  timings.heard('key', 'say', { play: 250, result: 'played' });
  const say = timings.list()[0].says![0];
  assert.equal(say.play, 250);
  assert.equal(say.terminal!.at, 40_000);
  assert.equal(say.terminal!.elapsedMs, 39_800);
  assert.equal(say.events!.at(-1)!.event, 'terminal');
  await timings.flush();
});

test('diagnostic payload allows bounded media and enums without arbitrary error content', () => {
  assert.deepEqual(playbackRecord({ paused: true, ended: false, seeking: false, rate: 1.5, bufferedEnd: 9, raw: 'secret' }), { paused: true, ended: false, seeking: false, rate: 1.5, bufferedEnd: 9 });
  assert.equal(playbackRecord({ rate: 0, bufferedEnd: Infinity, paused: 'yes' }), undefined);
  assert.equal(progressRecord({ event: 'retry', elapsedMs: 3, attempt: 4 }), undefined);
  assert.equal(progressRecord({ event: 'retry', elapsedMs: 3, reason: 'secret' }), undefined);
  assert.equal(progressRecord({ event: 'play-rejected', elapsedMs: 3, error: 'secret credentials' }), undefined);
  assert.equal(progressRecord({ event: 'terminal', elapsedMs: 3 }), undefined);
  assert.equal(progressRecord({ event: 'play-rejected', elapsedMs: 3, error: 'AbortError', attempt: 1 })!.error, 'AbortError');
  assert.equal(transportStage({ request: 1, bytes: Infinity }), undefined);
});

test('transport records correlate only observed host requests, bound retention and merge late snapshots', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-transport-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const timings = new VoiceTimings(join(dir, 'timings.json'));
  timings.mark('key', 'request', 100);
  assert.equal(timings.webTransport('live', 'unknown', { request: 1, bytes: 1 }), false);
  for (let i = 0; i < 40; i++) timings.audioRequest('key', 'live', String(i), 0, { request: 200, bytes: 1 });
  const record = timings.list()[0];
  assert.equal(record.audioRequests!.length, 30);
  assert.equal(record.audioRequests![7].requestId, '7');
  assert.equal(record.audioRequests![8].requestId, '18');
  assert.equal(record.droppedAudioRequests, 10);
  assert.equal(timings.webTransport('live', '39', { request: 200, firstWrite: 201, end: 202, close: 203, normal: true, bytes: 100 }), true);
  timings.webTransport('live', '39', { request: 200, firstWrite: 201, bytes: 1 });
  const web = timings.list()[0].audioRequests!.at(-1)!.web!;
  assert.equal(web.end, 202);
  assert.equal(web.close, 203);
  assert.equal(web.normal, true);
  assert.equal(web.bytes, 100);
  await timings.flush();
});


test('saved histories and request lists are bounded again at startup', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-startup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'timings.json');
  await writeFile(path, JSON.stringify({ records: [{ key: 'key', says: [{ id: 'say', at: 1, droppedEvents: -1, events: Array.from({ length: 80 }, (_, i) => ({ event: 'progress', at: i, elapsedMs: i })) }], audioRequests: Array.from({ length: 40 }, (_, i) => ({ requestId: String(i), live: 'live', offset: 0 })) }] }), { mode: 0o600 });
  const timings = new VoiceTimings(path);
  await timings.start();
  const record = timings.list()[0];
  assert.equal(record.says![0].events!.length, 64);
  assert.equal(record.says![0].events![16].elapsedMs, 32);
  assert.equal(record.says![0].droppedEvents, 16);
  assert.equal(record.audioRequests!.length, 30);
  assert.equal(record.audioRequests![8].requestId, '18');
  assert.equal(record.droppedAudioRequests, 10);
});
