/**
 * Isolated real Chromium regression. Tower/native run updates and ElevenLabs are fixtures;
 * HTMLAudio decoding, media clock, Web Audio PCM and VoiceSession are real. No provider is spawned.
 * Run: node --import tsx scripts/test-master-voice-stream-browser.ts
 * Required: VOICE_BROWSER_MP3=/absolute/path/to/existing/valid.mp3 (no TTS network calls)
 * Optional: VOICE_BROWSER_PLAYWRIGHT=/absolute/path/to/playwright/index.mjs
 */
import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { randomUUID } from 'node:crypto';
import { ElevenLabs } from '../server/master/elevenlabs.js';
import { MasterRoom } from '../server/master/room.js';
import { MasterSession } from '../server/master/session.js';
import { MasterSettingsStore } from '../server/master/settings.js';
import { MasterClient } from '../server/master/client.js';
import { masterPaths } from '../server/master/paths.js';
import { MASTER_PROTOCOL } from '../server/master/host.js';
import { APP_VERSION } from '../shared/app-identity.js';
import { MasterVoice } from '../server/master/voice.js';
import { TowerClient } from '../server/tower-tools/tower-client.js';
import type { LiveState } from '../server/tower-tools/live-state.js';
import type { Run, Snapshot } from '../shared/types.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(get: () => T, timeout = 15_000): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const found = get(); if (found) return found as NonNullable<T>; await sleep(25); }
  throw new Error('fixture condition timed out');
}
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return (server.address() as { port: number }).port;
}
async function stop(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
const root = resolve(new URL('..', import.meta.url).pathname);
const artifact = join(root, 'tmp/voice-latency/browser-stream-result.json');
if (!process.env.VOICE_BROWSER_MP3) throw new Error('Set VOICE_BROWSER_MP3 to an existing valid cached MP3; this test never generates TTS.');
const mp3 = await readFile(process.env.VOICE_BROWSER_MP3);
const playwrightModule = process.env.VOICE_BROWSER_PLAYWRIGHT ? pathToFileURL(process.env.VOICE_BROWSER_PLAYWRIGHT).href : 'playwright';
const { chromium } = await import(playwrightModule);
const bundle = await build({ entryPoints: [join(root, 'scripts/fixtures/master-voice-stream-browser.ts')], bundle: true, write: false, platform: 'browser', format: 'iife' });
const dir = await mkdtemp(join(tmpdir(), 'tower-voice-browser-fixture-'));
const cleanups: Array<() => Promise<unknown>> = [() => rm(dir, { recursive: true, force: true })];
const runs: Run[] = [];
const calls: Array<{ text: string; at: number }> = [];
const progress: any[] = [], played: any[] = [], audioRequests: any[] = [], says: any[] = [], transportReports: any[] = [];
let voice: MasterVoice, session: MasterSession, browser: any, page: any, current = '';
try {
  const labs = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (req.method === 'POST' && req.url?.includes('/text-to-speech/')) {
      calls.push({ text: JSON.parse(raw).text.replace(/^\[[a-z]+\] /, ''), at: Date.now() });
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'history-item-id': `fixture-${calls.length}` }).end(mp3); return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  });
  const labsPort = await listen(labs); cleanups.push(() => stop(labs));
  const tower = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const match = /^\/api\/sessions\/([^/]+)\/messages$/.exec(req.url ?? '');
    if (req.method === 'POST' && match) {
      const run: Run = { id: `r${runs.length + 1}`, sessionId: decodeURIComponent(match[1]), prompt: JSON.parse(raw).prompt, status: 'running', createdAt: new Date().toISOString(), output: '', replies: [] };
      runs.push(run); res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ run })); return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ session: { id: 'codex:fixture', updatedAt: new Date().toISOString() }, messages: [], hasMore: false }));
  });
  const towerPort = await listen(tower); cleanups.push(() => stop(tower));
  const settings = new MasterSettingsStore(dir); await settings.start();
  await settings.update({ voiceKey: 'el-fixture-0123456789abcdef' });
  await settings.bind({ sessionId: 'codex:fixture', provider: 'codex', startedAt: new Date().toISOString() });
  const room = new MasterRoom(dir); await room.start();
  const client = new TowerClient(2000); client.setCredentials({ port: towerPort, token: 'a'.repeat(64), callerSecret: 'b'.repeat(64) });
  const listeners = new Set<() => void>();
  const snapshot = (): Snapshot => ({ sessions: [], runs, autoPrompts: [], providers: [], scanning: false, hostname: 'fixture', version: 'fixture', updatedAt: '' });
  const live = { fresh: async () => snapshot(), snapshot, node: () => undefined, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); } } as unknown as LiveState;
  const emit = () => { for (const listener of listeners) listener(); };
  const write = (run: Run, text: string, done = false) => { const old = run.replies?.[0]?.text ?? ''; run.replies = [{ id: `${run.id}:0`, text: old + text, ...(done ? { done: true } : {}) }]; emit(); };
  const finish = (run: Run) => { run.replies = run.replies?.map(reply => ({ ...reply, done: true })); run.status = 'completed'; run.finishedAt = new Date().toISOString(); emit(); };
  session = new MasterSession({ stateDir: dir, dataDir: dir, settings, tower: client, live, room, followMs: 60_000 });
  voice = new MasterVoice({ dataDir: dir, settings, room, elevenLabs: new ElevenLabs({ key: () => settings.voiceKey(), apiBase: `http://127.0.0.1:${labsPort}`, historyDelaysMs: [10] }),
    firstReply: { prepare() {}, close() {}, make: async () => ({ skipped: 'failed', warm: true }) },
    timing: { firstChunkMs: 1000, synthMs: 5000, playMs: 60_000, resyncMs: 500, waitMs: 500, presenceMs: 60_000, tickMs: 60_000 },
    hooks: { hide: text => text, connectedSince: () => client.connectedSince(), send: input => session.spoken({ text: input.text, key: input.voice.key, voiceSession: input.voice.session ?? '' }), streamState: (turn, state) => session.voicedState(turn, state) } });
  session.setVoice(voice); await voice.start(); await session.start();
  cleanups.push(async () => { await voice.close(); await session.close(); await room.flush(); });
  const subscribers = new Set<ServerResponse>();
  room.subscribe(event => { if (event.type !== 'say') return; says.push({ ...event.say, observedAt: Date.now() }); for (const res of subscribers) res.write(`data: ${JSON.stringify(event)}\n\n`); });
  const paths = await masterPaths(dir);
  cleanups.push(() => rm(resolve(paths.token, '..'), { recursive: true, force: true }));
  await writeFile(paths.token, 'c'.repeat(64), { mode: 0o600 });
  const socketHost = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, `Bearer ${'c'.repeat(64)}`);
      const url = new URL(req.url!, 'http://fixture-host');
      if (url.pathname === '/rpc') {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw); let result: unknown;
        if (body.method === 'ping') result = { busy: false };
        else if (body.method === 'voiceTransport') {
          result = voice.voiceTransport(body.args); transportReports.push({ ...body.args, accepted: result });
        } else throw new Error(`Fixture forbids host operation ${body.method}`);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ protocol: MASTER_PROTOCOL, stateDir: paths.stateDir, version: APP_VERSION, result })); return;
      }
      const audio = /^\/audio\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (!audio) { res.writeHead(404).end(); return; }
      const requestId = req.headers['x-tower-audio-request-id'];
      assert.equal(typeof requestId, 'string');
      await voice.serveAudio(audio[1], res, Number(url.searchParams.get('at') ?? 0), requestId as string);
    } catch (error) { if (!res.headersSent) res.writeHead(500).end(String(error)); else res.destroy(); }
  });
  cleanups.push(() => stop(socketHost));
  await new Promise<void>((resolve, reject) => { socketHost.once('error', reject); socketHost.listen(paths.socket, resolve); });
  const proxy = new MasterClient({ stateDir: dir, credentials: () => undefined, attachOnly: true });
  // Guard the provider/host spawn path before invoking the actual pipeAudio implementation.
  // A missing or incompatible fixture host fails instead of starting any process.
  (proxy as unknown as { startHost: () => Promise<void> }).startHost = async () => { assert.equal(await proxy.hostVersion(), APP_VERSION); };
  cleanups.push(async () => proxy.dispose());
  const worklet = await readFile(join(root, 'client/public/master-pcm-tap.js'));
  const silence = await readFile(join(root, 'client/public/master-silence.wav'));
  const web = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, 'http://fixture');
      if (url.pathname === '/fixture/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n'); subscribers.add(res); req.on('close', () => subscribers.delete(res)); return; }
      if (req.method === 'POST') {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw || '{}'); let answer: unknown = true;
        if (url.pathname.endsWith('/on')) { const started = voice.voiceOn({ tabId: body.tabId, local: true }); current = started.session; answer = started; }
        else if (url.pathname.endsWith('/off')) answer = voice.voiceOff(body);
        else if (url.pathname.endsWith('/presence')) answer = voice.voicePresence(body);
        else if (url.pathname.endsWith('/progress')) { answer = voice.voiceProgress(body); progress.push({ ...body, accepted: answer, at: Date.now() }); }
        else if (url.pathname.endsWith('/played')) { answer = voice.voicePlayed(body); played.push({ ...body, accepted: answer, at: Date.now() }); }
        else if (url.pathname.endsWith('/token')) answer = { tokenId: 'fixture-only', url: 'ws://127.0.0.1:1', expiresAt: Date.now() + 10_000 };
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(answer)); return;
      }
      const audio = /^\/api\/master\/voice\/audio\/(.*)$/.exec(url.pathname);
      if (audio) { audioRequests.push({ id: audio[1], range: req.headers.range, at: Date.now() }); await proxy.pipeAudio(res, audio[1], Number(url.searchParams.get('at') ?? 0)); return; }
      if (url.pathname === '/bundle.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].contents); return; }
      if (url.pathname === '/master-pcm-tap.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(worklet); return; }
      if (url.pathname === '/master-silence.wav') { res.writeHead(200, { 'Content-Type': 'audio/wav' }).end(silence); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<button id="start">fixture start</button><script src="/bundle.js"></script>');
    } catch (error) { if (!res.headersSent) res.writeHead(500).end(String(error)); else res.destroy(); }
  });
  const webPort = await listen(web); cleanups.push(async () => { for (const res of subscribers) res.destroy(); await stop(web); });
  browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=user-gesture-required'] });
  cleanups.push(() => browser.close());
  page = await browser.newPage(); const errors: string[] = []; page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${webPort}`); await page.click('#start'); await page.waitForFunction(() => (window as any).started);
  // Synthetic microphone is muted. All utterances below enter through the actual host API.
  await page.evaluate(() => { (window as any).rmsMax = 0; });
  const ask = async () => { await voice.voiceRequest({ session: current, text: '격리 fixture 요청', clientMessageId: randomUUID(), local: true }); return until(() => runs.at(-1)); };
  const first = '첫 문장을 지금 읽습니다.';
  const residual = ' 마지막 남은 내용을 읽습니다.';
  const run = await ask(); write(run, first + ' ');
  await until(() => calls.some(call => call.text === first));
  const answer = await until(() => says.find(say => say.kind === 'answer' && !say.cancelled));
  await until(() => progress.find(item => item.id === answer.id && item.event === 'started' && item.accepted));
  await page.waitForFunction(() => (window as any).rmsMax > 0.001 && (window as any).audio[0].currentTime > 0.1);
  await sleep(10_000); // Keep the run open past this cached first MP3, within the 30-second stall watchdog.
  assert.equal(run.status, 'running'); assert.equal(run.finishedAt, undefined);
  assert.equal(played.some(item => item.id === answer.id), false, 'live progress does not settle held audio');
  assert.ok(progress.some(item => item.id === answer.id && item.event === 'waiting' && item.playback?.position > 0), 'first audio exhausts while the run stays open');
  const heldEvidence = { at: Date.now(), runStatus: run.status, waits: progress.filter(item => item.id === answer.id && item.event === 'waiting'), firstTts: calls[0], started: progress.find(item => item.id === answer.id && item.event === 'started'), media: await page.evaluate(() => ({ position: (window as any).audio[0].currentTime, rmsMax: (window as any).rmsMax })) };
  write(run, residual, true); const endAt = Date.now(); finish(run);
  await until(() => played.find(item => item.id === answer.id && item.result === 'played'), 30_000);
  assert.deepEqual(calls.map(call => call.text), [first, residual.trim()], 'final residual is synthesized once without repeating first sentence');
  assert.ok(heldEvidence.started.at < endAt && heldEvidence.firstTts.at < endAt);
  // New diagnostic contract: page promise/media stages and both socket relay stages share this run/say/live.
  const timingsFor = (id: string) => voice.timings.list().find(record => record.says?.some(say => say.id === id));
  const transportComplete = () => timingsFor(answer.id)?.audioRequests?.find(request => request.host?.normal && request.host.close && request.web?.normal && request.web.close);
  const firstTransport = await until(transportComplete);
  const timing = timingsFor(answer.id)!;
  const sayTiming = timing.says!.find(say => say.id === answer.id)!;
  assert.equal(timing.runId, run.id); assert.equal(timing.turnId, run.id);
  assert.equal(sayTiming.live, answer.audio.split('/').at(-1));
  assert.equal(firstTransport.live, sayTiming.live);
  assert.ok(firstTransport.host!.firstWrite! < endAt && firstTransport.web!.firstWrite! < endAt, 'host and web write while run remains open');
  assert.ok(firstTransport.host!.end! >= endAt && firstTransport.web!.end! >= endAt, 'EOF follows residual and turn end');
  assert.equal(firstTransport.host!.bytes, firstTransport.web!.bytes);
  assert.ok(firstTransport.host!.bytes > mp3.length, 'transport carries both first and residual MP3 pieces');
  for (const event of ['received', 'source', 'play-attempt', 'play-resolved', 'started', 'waiting', 'resumed', 'ended', 'terminal'])
    assert.ok(sayTiming.events?.some(item => item.event === event), `bounded history retains ${event}`);
  const elapsedEvents = sayTiming.events!.filter(event => event.elapsedMs !== undefined);
  assert.ok(elapsedEvents.every((event, index) => !index || event.elapsedMs! >= elapsedEvents[index - 1].elapsedMs!), 'browser stage clock is monotonic');
  assert.equal(sayTiming.terminal?.result, 'played'); assert.equal(sayTiming.terminal?.attempt, 0);
  const mediaStart = sayTiming.started!.playback!;
  assert.equal(mediaStart.rate, 1.2); assert.equal(mediaStart.paused, false);
  assert.equal(typeof mediaStart.bufferedEnd, 'number');
  assert.equal(sayTiming.terminal?.playback?.ended, true);
  assert.ok(transportReports.some(report => report.requestId === firstTransport.requestId && report.accepted));
  const settledBefore = played.length;
  assert.equal(voice.voiceProgress({ session: current, id: answer.id, event: 'progress', elapsedMs: 100, playback: { position: 1 } }), false, 'late progress cannot settle/revive finished say');
  assert.equal(played.length, settledBefore);

  const cancelRun = await ask(); write(cancelRun, '취소할 첫 문장을 읽습니다. ');
  const cancelSay = await until(() => says.find(say => say.kind === 'answer' && say.request !== answer.request && !say.cancelled));
  await until(() => progress.find(item => item.id === cancelSay.id && item.event === 'started' && item.accepted));
  // Same-id updates and a cancelled queue item exercise the real browser queue without TTS.
  const queued = { ...cancelSay, id: randomUUID(), audio: `/api/master/voice/audio/${randomUUID()}` };
  await page.evaluate(([active, queued]: any[]) => { const win = window as any; win.voice.say(queued); win.voice.say({ ...active, text: '동일 ID 갱신' }); win.voice.say({ ...queued, cancelled: true }); win.voice.skip(); }, [cancelSay, queued]);
  await until(() => played.find(item => item.id === cancelSay.id && item.result === 'stopped'));
  const beforeCancel = calls.length;
  write(cancelRun, ' 취소 뒤 문장은 만들거나 재생하면 안 됩니다.', true); finish(cancelRun);
  await sleep(900);
  assert.equal(calls.length, beforeCancel, 'cancelled turn never synthesizes its residual');
  assert.equal(audioRequests.some(item => queued.audio.endsWith(item.id)), false, 'cancelled queued audio never fetched');
  assert.equal(progress.filter(item => item.id === cancelSay.id && item.event === 'source').length, 1, 'same-id update never starts a new source; Chromium may issue multiple HTTP range requests');
  assert.equal(await page.evaluate(() => (window as any).views.at(-1).playing), undefined);
  assert.equal(await page.evaluate(() => (window as any).audio[0].paused), true, 'skip stops HTMLAudio');
  await until(() => timingsFor(cancelSay.id)?.says?.find(say => say.id === cancelSay.id)?.terminal);
  const cancelledTiming = timingsFor(cancelSay.id)!.says!.find(say => say.id === cancelSay.id)!;
  assert.equal(cancelledTiming.terminal?.result, 'stopped'); assert.equal(cancelledTiming.terminal?.attempt, 0);
  assert.ok(cancelledTiming.events?.some(event => event.event === 'play-attempt'));
  assert.ok(cancelledTiming.events?.some(event => event.event === 'play-resolved'));
  assert.deepEqual(errors, []);
  await mkdir(join(root, 'tmp/voice-latency'), { recursive: true });
  await writeFile(artifact, JSON.stringify({ result: 'PASS', browser: 'isolated Playwright Chromium', scope: { actual: ['MasterSession', 'MasterVoice', 'VoiceSession', 'MasterClient socket audio proxy', 'HTMLAudio', 'WebAudio PCM'], fixtures: ['Tower HTTP API and native run snapshot updates', 'ElevenLabs HTTP responses using previously cached MP3'], nativeProviders: false, personalMicrophone: false, userBrowser: false, newTts: false }, heldEvidence, endAt, calls, progress, played, audioRequests, transportReports, timings: voice.timings.list(), events: await page.evaluate(() => (window as any).events), pageErrors: errors }, null, 2));
  console.log(`PASS socket host/web firstWrite/EOF/close correlation + real media/promise/terminal history before held turn end; residual once; cancellation. Artifact: ${artifact}`);
} catch (error) {
  await mkdir(join(root, 'tmp/voice-latency'), { recursive: true });
  await writeFile(artifact, JSON.stringify({ result: 'FAIL', error: String(error), calls, progress, played, audioRequests, events: page ? await page.evaluate(() => (window as any).events).catch(() => []) : [] }, null, 2));
  throw error;
} finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
