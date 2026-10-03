import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MasterRoom } from '../../server/master/room.js';
import { MasterSettingsStore } from '../../server/master/settings.js';
import { MasterVoice } from '../../server/master/voice.js';
import { audioSink } from '../../server/http/sinks.js';
import { until } from '../helpers/until.js';

/**
 * Audio whose making fails after a page already got some of it: the page sees its response cut short, never a clean
 * end; the request is recorded as not ended normally; and nothing is left waiting on that audio.
 */
test('audio that fails after its first bytes went out is cut off: a truncated response, no clean finish, nothing left waiting', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-voice-cutoff-'));
  const servers: Server[] = [];
  let voice: MasterVoice | undefined;
  let fail!: () => void;
  const failing = new Promise<void>(resolve => { fail = resolve; });
  t.after(async () => {
    // The synthesis is let go whatever point the test stopped at, then everything that serves it ends.
    fail();
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    await voice?.close();
    await rm(dir, { recursive: true, force: true });
  });
  const settings = new MasterSettingsStore(dir);
  await settings.start();
  const room = new MasterRoom(dir);
  await room.start();
  // Speech that sends its first sound, then fails before the rest.
  const elevenLabs = { speak: async function* () { yield Buffer.from('ID3-first-sound'); await failing; throw new Error('synthesis failed'); } };
  voice = new MasterVoice({ dataDir: dir, settings, room, elevenLabs: elevenLabs as never, timing: { waitMs: 200 },
    hooks: { hide: text => text, connectedSince: () => 0, send: async () => undefined } });
  await voice.start();
  const stages: Array<Record<string, unknown>> = [];
  t.mock.method((voice as unknown as { timings: { audioRequest: (...args: unknown[]) => void } }).timings, 'audioRequest', (...args: unknown[]) => { stages.push({ ...(args[4] as Record<string, unknown>) }); });
  const live = (voice as unknown as { synthesize(text: string): { id: string } }).synthesize('끝까지 만들어지지 않을 문장입니다.');
  const served = voice;
  const server = createServer((_req, res) => { void served.serveAudio(live.id, audioSink(res)); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  const heard = await new Promise<{ status: number; body: string; complete: boolean; aborted: boolean }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/' }, res => {
      const chunks: Buffer[] = [];
      let aborted = false;
      res.on('data', chunk => { chunks.push(chunk as Buffer); fail(); });
      res.on('aborted', () => { aborted = true; });
      res.on('error', () => { aborted = true; });
      res.on('close', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString(), complete: res.complete, aborted }));
    });
    req.on('error', reject);
    req.end();
  });
  assert.deepEqual(heard, { status: 200, body: 'ID3-first-sound', complete: false, aborted: true }, 'the page got the first sound, then a response cut short');
  await until(() => stages.some(stage => stage.close !== undefined));
  const last = stages.at(-1)!;
  assert.equal(last.normal, false, 'recorded as not ended normally');
  assert.equal(last.end, undefined, 'never a clean finish');
  assert.equal(last.bytes, 'ID3-first-sound'.length);
  await until(() => voice!.listeners(live.id) === 0);
});
