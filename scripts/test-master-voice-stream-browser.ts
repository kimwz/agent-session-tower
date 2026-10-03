/**
 * Isolated finite-part browser regression (WebKit is the default). Tower/native run updates and ElevenLabs are fixtures;
 * HTMLAudio decoding, media clock, Web Audio PCM and VoiceSession are real. No provider is spawned.
 * Run: node --import tsx scripts/test-master-voice-stream-browser.ts
 * Required: VOICE_BROWSER_MP3=/absolute/path/to/existing/valid.mp3 (no TTS network calls)
 * Optional: VOICE_BROWSER_ENGINE=webkit|chromium|chrome; VOICE_BROWSER_PCM=0|1 (default 1)
 * Optional: VOICE_BROWSER_TTS_DELAY_MS=0..5000 delays completion of only the second part to verify the listening boundary.
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
import { audioSink } from '../server/http/sinks.js';

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
const engine = process.env.VOICE_BROWSER_ENGINE ?? 'webkit'; assert.ok(['webkit', 'chromium', 'chrome'].includes(engine));
const pcm = process.env.VOICE_BROWSER_PCM !== '0';
const ttsDelayMs = Number(process.env.VOICE_BROWSER_TTS_DELAY_MS ?? 0);
assert.ok(Number.isInteger(ttsDelayMs) && ttsDelayMs >= 0 && ttsDelayMs <= 5000, 'VOICE_BROWSER_TTS_DELAY_MS must be an integer from 0 to 5000');
const artifactDir = join(root, 'tmp/voice-recovery');
const artifact = join(artifactDir, `finite-browser-${engine}-${pcm ? 'pcm' : 'raw'}${ttsDelayMs ? `-delay${ttsDelayMs}` : ''}.json`);
if (!process.env.VOICE_BROWSER_MP3) throw new Error('Set VOICE_BROWSER_MP3 to an existing valid cached MP3; this test never generates TTS.');
const mp3 = await readFile(process.env.VOICE_BROWSER_MP3);
const playwrightModule = process.env.VOICE_BROWSER_PLAYWRIGHT ? pathToFileURL(process.env.VOICE_BROWSER_PLAYWRIGHT).href : 'playwright';
const { chromium, webkit } = await import(playwrightModule);
const bundle = await build({ entryPoints: [join(root, 'scripts/fixtures/master-voice-stream-browser.ts')], bundle: true, write: false, platform: 'browser', format: 'iife' });
const dir = await mkdtemp(join(tmpdir(), 'tower-voice-browser-fixture-'));
const cleanups: Array<() => Promise<unknown>> = [() => rm(dir, { recursive: true, force: true })];
const runs: Run[] = [];
const calls: Array<{ text: string; at: number; firstByteAt?: number; responseEndedAt?: number }> = [];
const progress: any[] = [], played: any[] = [], audioRequests: any[] = [], says: any[] = [], transportReports: any[] = [], webResponses: any[] = [];
let voice: MasterVoice, session: MasterSession, browser: any, page: any, current = '';
let boundaryEvidence: any;
let timingSnapshot: () => unknown = () => undefined;
let receiptOrder = 0;
try {
  const labs = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (req.method === 'POST' && req.url?.includes('/text-to-speech/')) {
      const call = { text: JSON.parse(raw).text.replace(/^\[[a-z]+\] /, ''), at: Date.now() } as typeof calls[number];
      calls.push(call); const index = calls.length;
      res.once('finish', () => { call.responseEndedAt = Date.now(); });
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'history-item-id': `fixture-${index}` });
      call.firstByteAt = Date.now();
      if (index === 2 && ttsDelayMs) {
        // Immediate first bytes preserve the existing first-chunk timeout; completion alone is delayed.
        res.write(mp3.subarray(0, Math.min(4096, mp3.length - 1)));
        const completeAt = call.firstByteAt + ttsDelayMs;
        while (Date.now() < completeAt) await sleep(completeAt - Date.now());
        res.end(mp3.subarray(Math.min(4096, mp3.length - 1)));
      } else res.end(mp3);
      return;
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
    timing: { firstChunkMs: 1000, synthMs: Math.max(5000, ttsDelayMs + 1000), playMs: 60_000, resyncMs: 500, waitMs: 500, presenceMs: 60_000, tickMs: 60_000 },
    hooks: { hide: text => text, connectedSince: () => client.connectedSince(), send: input => session.spoken({ text: input.text, key: input.voice.key, voiceSession: input.voice.session ?? '' }), streamState: (turn, state) => session.voicedState(turn, state) } });
  timingSnapshot = () => voice.timings.list();
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
      await voice.serveAudio(audio[1], audioSink(res), Number(url.searchParams.get('at') ?? 0), requestId as string);
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
        else if (url.pathname.endsWith('/progress')) { answer = voice.voiceProgress(body); progress.push({ ...body, accepted: answer, at: Date.now(), receiptOrder: ++receiptOrder }); }
        else if (url.pathname.endsWith('/played')) { answer = voice.voicePlayed(body); played.push({ ...body, accepted: answer, at: Date.now(), receiptOrder: ++receiptOrder }); }
        else if (url.pathname.endsWith('/missed')) answer = voice.voiceMissed(body);
        else if (url.pathname.endsWith('/token')) answer = { tokenId: 'fixture-only', url: 'ws://127.0.0.1:1', expiresAt: Date.now() + 10_000 };
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(answer)); return;
      }
      const audio = /^\/api\/master\/voice\/audio\/(.*)$/.exec(url.pathname);
      if (audio) { const request: any = { id: audio[1], range: req.headers.range, at: Date.now() }; audioRequests.push(request); res.once('finish', () => { request.finishedAt = Date.now(); }); await proxy.pipeAudio(res, audio[1], Number(url.searchParams.get('at') ?? 0)); return; }
      if (url.pathname === '/bundle.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].contents); return; }
      if (url.pathname === '/master-pcm-tap.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(worklet); return; }
      if (url.pathname === '/master-silence.wav') { res.writeHead(200, { 'Content-Type': 'audio/wav' }).end(silence); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<button id="start">fixture start</button><button id="listen">fixture listen</button><script>window.__voiceFixture=${JSON.stringify({ pcm, rate: 1.2, observeGate: ttsDelayMs > 0 })}</script><script src="/bundle.js"></script>`);
    } catch (error) { if (!res.headersSent) res.writeHead(500).end(String(error)); else res.destroy(); }
  });
  const webPort = await listen(web); cleanups.push(async () => { for (const res of subscribers) res.destroy(); await stop(web); });
  browser = engine === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch({ headless: true, ...(engine === 'chrome' ? { channel: 'chrome' } : {}), args: ['--autoplay-policy=user-gesture-required'] });
  cleanups.push(() => browser.close());
  page = await browser.newPage(); const errors: string[] = []; page.on('pageerror', (error: Error) => errors.push(error.message));
  page.on('response', async (response: any) => {
    const url = new URL(response.url());
    const audio = /^\/api\/master\/voice\/audio\/(.*)$/.exec(url.pathname);
    if (!audio) return;
    // Observe headers delivered at the actual browser boundary; writeHead need not retain getHeader values.
    const headers = await response.allHeaders();
    webResponses.push({ id: audio[1], at: Date.now(), contentLength: Number(headers['content-length']), contentType: headers['content-type'], status: response.status() });
  });
  await page.goto(`http://127.0.0.1:${webPort}`); await page.click('#start'); await page.waitForFunction(() => (window as any).started);
  // Synthetic microphone is muted. All utterances below enter through the actual host API.
  await page.evaluate((enabled: boolean) => { (window as any).rmsMax = enabled ? 0 : null; }, pcm);
  const ask = async () => { await voice.voiceRequest({ session: current, text: '격리 fixture 요청', clientMessageId: randomUUID(), local: true }); return until(() => runs.at(-1)); };
  const first = '첫 문장을 지금 읽습니다.';
  const residual = ' 마지막 남은 내용을 읽습니다.';
  const timingsFor = (id: string) => voice.timings.list().find(record => record.says?.some(say => say.id === id));
  const terminal = (id: string) => played.find(item => item.id === id && item.accepted);
  const meaningful = (id: string) => progress.find(item => item.id === id && item.event === 'started' && item.accepted && item.playback?.position >= 0.02);
  const verifyPart = async (say: any, runId?: string) => {
    const request = await until(() => timingsFor(say.id)?.audioRequests?.find(item => item.live === say.audio.split('/').at(-1) && item.host?.normal && item.host.close && item.web?.normal && item.web.close));
    await until(() => webResponses.find(item => item.id === request.live));
    const diagnosticEvents = ['received', 'source', 'play-attempt', 'play-resolved', 'started', 'ended'];
    // Diagnostic POSTs and terminal ACKs are independent requests; wait for every receipt before reading history.
    await until(() => diagnosticEvents.every(event => progress.some(item => item.id === say.id && item.event === event)) && terminal(say.id));
    const timing = timingsFor(say.id)!;
    const stored = timing.says!.find(item => item.id === say.id)!;
    if (runId) { assert.equal(timing.runId, runId); assert.equal(timing.turnId, runId); }
    assert.equal(stored.live, request.live);
    assert.equal(request.host!.bytes, mp3.length); assert.equal(request.web!.bytes, mp3.length);
    assert.ok(transportReports.some(report => report.requestId === request.requestId && report.accepted));
    assert.ok(webResponses.some(item => item.id === request.live && item.contentLength === mp3.length && item.contentType === 'audio/mpeg' && item.status === 200), 'web exposes finite content length for each independent MP3');
    for (const event of ['received', 'source', 'play-attempt', 'play-resolved', 'started', 'terminal'])
      assert.ok(stored.events?.some(item => item.event === event), `part history retains ${event}`);
    const audioPath = new URL(say.audio, 'http://fixture').pathname;
    const domEnded = await page.evaluate((path: string) => (window as any).events.find((event: any) => event.event === 'ended' && new URL(event.src).pathname === path), audioPath);
    assert.ok(domEnded, 'the actual DOM audio for this part emits ended');
    const endedReceipt = progress.find(item => item.id === say.id && item.event === 'ended');
    const terminalReceipt = terminal(say.id);
    assert.equal(typeof endedReceipt.accepted, 'boolean', 'ended diagnostic HTTP receipt records its acceptance');
    if (endedReceipt.accepted) assert.ok(stored.events?.some(item => item.event === 'ended'), 'accepted ended remains in part history');
    else {
      // Terminal ACK and ended diagnostics race over independent HTTP requests; terminal state stays authoritative.
      assert.ok(Number.isFinite(endedReceipt.elapsedMs) && endedReceipt.elapsedMs >= 0 && endedReceipt.elapsedMs < 3_600_000, 'rejected ended has a valid diagnostic elapsed time');
      assert.equal(endedReceipt.attempt, 0);
      assert.equal(endedReceipt.playback?.ended, true);
      assert.ok(terminalReceipt.receiptOrder < endedReceipt.receiptOrder && terminalReceipt.at <= endedReceipt.at, 'only an ended receipt arriving after accepted terminal ACK may be rejected');
      assert.ok(endedReceipt.elapsedMs <= terminalReceipt.elapsedMs, 'the client emits ended before its terminal ACK');
    }
    assert.equal(stored.terminal?.result, 'played'); assert.equal(stored.terminal?.attempt, 0);
    assert.equal(stored.terminal?.playback?.ended, true);
    assert.equal(stored.started?.playback?.rate, 1.2);
    assert.ok(stored.started!.playback!.position! >= 0.02, 'a <=5us initialization timestamp is not meaningful progress');
    assert.equal(progress.some(item => item.id === say.id && item.event === 'retry'), false, 'healthy finite WebKit/Chromium audio never needs a watchdog retry');
    // HTTP receipts may arrive out of order. Each browser stage carries its own monotonic clock.
    const localEvents = progress.filter(item => item.id === say.id);
    assert.ok(localEvents.every(item => item.elapsedMs >= 0));
    assert.ok(stored.terminal!.elapsedMs! >= stored.started!.elapsedMs!);
    return { request, timing, stored, completionEvidence: { domEnded, endedReceipt, terminalReceipt } };
  };
  const run = await ask(); write(run, first + ' ');
  await until(() => calls.some(call => call.text === first));
  const answer = await until(() => says.find(say => say.kind === 'answer' && !say.cancelled));
  await until(() => meaningful(answer.id));
  const holdUntil = Date.now() + 10_000;
  if (pcm) await page.waitForFunction(() => (window as any).rmsMax > 0.001);
  await until(() => terminal(answer.id)?.result === 'played');
  const firstStages = await verifyPart(answer, run.id);
  await sleep(Math.max(0, holdUntil - Date.now()));
  assert.equal(run.status, 'running'); assert.equal(run.finishedAt, undefined);
  assert.equal(calls.length, 1, 'completed sentence is its own part before residual exists');
  const heldEvidence = { at: Date.now(), runStatus: run.status, firstTts: calls[0], started: meaningful(answer.id), terminal: terminal(answer.id), transport: firstStages.request, media: await page.evaluate(() => ({ position: (window as any).audio[0].currentTime, rmsMax: (window as any).rmsMax })) };
  write(run, residual, true); const endAt = Date.now(); finish(run);
  if (ttsDelayMs) {
    await until(() => calls[1]);
    assert.equal(calls[1].responseEndedAt, undefined, 'second TTS is still pending when listening is requested');
    assert.equal(await page.evaluate(() => navigator.mediaDevices === (window as any).syntheticMediaDevices && navigator.mediaDevices.getUserMedia === (window as any).syntheticGetUserMedia), true, 'only the retained synthetic microphone override may be called');
    // Match the real UI's user activation for AudioContext resume; getUserMedia remains synthetic.
    await page.click('#listen');
    await page.waitForFunction(() => (window as any).listenCompleted);
    const microphone = await page.evaluate(() => ({ diagnostics: (window as any).syntheticDiagnostics, listen: (window as any).listenDiagnostics }));
    assert.equal(microphone.listen.phase, 'completed');
    assert.ok(microphone.listen.before.mediaDevicesIdentityMatches && microphone.listen.before.getUserMediaIdentityMatches);
    assert.ok(microphone.listen.after.mediaDevicesIdentityMatches && microphone.listen.after.getUserMediaIdentityMatches);
    assert.equal(microphone.diagnostics.length, 2, 'start and listen each call the synthetic microphone once');
    assert.ok(microphone.diagnostics.every((item: any) => item.stage === 'complete' && item.trackStates.length > 0 && item.trackStates.every((state: string) => state === 'live')));
    assert.equal(microphone.diagnostics[0].reusedProducer, false);
    assert.equal(microphone.diagnostics[1].reusedProducer, true);
    assert.ok(microphone.listen.after.streamDefined && microphone.listen.after.streamTrackStates.length > 0 && microphone.listen.after.streamTrackStates.every((state: string) => state === 'live'));
    await page.waitForFunction(() => (window as any).gateStates.some((state: any) => state.armed));
    assert.equal(calls[1].responseEndedAt, undefined, 'synthetic microphone arms inside the synthesis gap');
  }
  const second = await until(() => says.find(say => say.kind === 'answer' && say.request === answer.request && say.id !== answer.id && !say.cancelled));
  assert.notEqual(second.audio, answer.audio, 'residual has independent finite audio and terminal ACK');
  await until(() => terminal(second.id)?.result === 'played');
  await verifyPart(second, run.id);
  if (ttsDelayMs) {
    const gateStates = await page.evaluate(() => (window as any).gateStates);
    const armed = gateStates.find((state: any) => state.armed && state.at >= calls[1].at);
    const disarmed = gateStates.find((state: any) => !state.armed && state.at > armed?.at);
    const source = progress.find(item => item.id === second.id && item.event === 'source');
    const started = meaningful(second.id);
    const secondPlaying = await page.evaluate((audio: string) => (window as any).events.filter((event: any) => event.event === 'playing' && event.src.includes(audio)), second.audio);
    assert.ok(armed && disarmed && disarmed.at <= started.at, 'listening arms during the gap and disarms before second meaningful playback');
    assert.ok(secondPlaying.length && secondPlaying.every((event: any) => event.armed === false), 'second Audio playback keeps the microphone gate closed');
    assert.ok(calls[1].responseEndedAt! - calls[1].firstByteAt! >= ttsDelayMs);
    assert.ok(terminal(answer.id).at <= calls[1].at && calls[1].responseEndedAt! <= source.at);
    assert.equal(played.some(item => item.id === second.id && ['timeout', 'expired'].includes(item.result)), false);
    boundaryEvidence = { ttsDelayMs, firstAckAt: terminal(answer.id).at, requestedTtsAt: calls[1].at, firstByteAt: calls[1].firstByteAt, responseEndAt: calls[1].responseEndedAt,
      secondSourceAt: source.at, secondStartedAt: started.at, secondAckAt: terminal(second.id).at,
      ackToRequestedTtsMs: calls[1].at - terminal(answer.id).at,
      synthesisCompletionMs: calls[1].responseEndedAt! - calls[1].at, responseEndToSourceMs: source.at - calls[1].responseEndedAt!,
      ackToSourceMs: source.at - terminal(answer.id).at, ackToStartedMs: started.at - terminal(answer.id).at, gateStates, secondPlaying,
      listenDiagnostics: await page.evaluate(() => (window as any).listenDiagnostics), syntheticDiagnostics: await page.evaluate(() => (window as any).syntheticDiagnostics) };
    // Restore the default muted conditions for the remaining cancellation/replay checks.
    await page.evaluate(() => (window as any).voice.mute());
  }
  assert.deepEqual(calls.map(call => call.text), [first, residual.trim()], 'ordered sentence and residual each synthesized once');
  assert.ok(heldEvidence.started.at < endAt && heldEvidence.terminal.at < endAt, 'meaningful progress and first part ACK both precede run end');
  assert.ok(heldEvidence.transport.host!.end! < endAt && heldEvidence.transport.web!.end! < endAt);
  assert.ok(terminal(answer.id).at < meaningful(second.id).at, 'parts play in order across residual flush');
  const settledBefore = played.length;
  assert.equal(voice.voiceProgress({ session: current, id: answer.id, event: 'progress', elapsedMs: 100, playback: { position: 1 } }), false, 'late progress cannot revive completed part');
  assert.equal(played.length, settledBefore);

  const cancelRun = await ask(); write(cancelRun, '취소할 첫 문장을 읽습니다. ');
  const cancelSay = await until(() => says.find(say => say.kind === 'answer' && say.request !== answer.request && !say.cancelled));
  await until(() => meaningful(cancelSay.id));
  const queued = { ...cancelSay, id: randomUUID(), audio: `/api/master/voice/audio/${randomUUID()}` };
  await page.evaluate(([active, queued]: any[]) => { const win = window as any; win.voice.say(queued); win.voice.say({ ...active, text: '동일 ID 갱신' }); win.voice.say({ ...queued, cancelled: true }); win.voice.skip(); }, [cancelSay, queued]);
  await until(() => terminal(cancelSay.id)?.result === 'stopped');
  const beforeCancel = calls.length;
  write(cancelRun, ' 취소 뒤 문장은 자동으로 읽으면 안 됩니다.', true); finish(cancelRun);
  await sleep(900);
  assert.equal(calls.length, beforeCancel, 'cancelled turn never synthesizes residual automatically');
  assert.equal(audioRequests.some(item => queued.audio.endsWith(item.id)), false);
  assert.equal(progress.filter(item => item.id === cancelSay.id && item.event === 'source').length, 1);
  assert.equal(await page.evaluate(() => (window as any).audio[0].paused), true);
  await until(() => timingsFor(cancelSay.id)?.says?.find(say => say.id === cancelSay.id)?.terminal?.result === 'stopped');
  const cancelledEntry = await until(() => room.recent(200).find(entry => entry.data.kind === 'master' && entry.data.text.includes('취소 뒤 문장') && entry.data.speak?.state === 'unspoken'));
  const beforeReplay = says.length;
  await page.evaluate((entry: string) => (window as any).voice.replayMissed(entry), cancelledEntry.id);
  const replay = await until(() => says.slice(beforeReplay).find(say => say.kind === 'answer' && !say.cancelled));
  await until(() => terminal(replay.id)?.result === 'played');
  await verifyPart(replay);
  assert.equal(calls.length, beforeCancel + 1, 'explicit replay reads the completed answer once');
  assert.deepEqual(errors, []);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(artifact, JSON.stringify({ result: 'PASS', browser: `isolated Playwright ${engine}`, pcmMeasured: pcm, ttsDelayMs, boundaryEvidence, scope: { actual: ['MasterSession', 'MasterVoice', 'VoiceSession', 'MasterClient socket audio proxy', 'HTMLAudio', ...(pcm ? ['WebAudio PCM'] : [])], fixtures: ['Tower/native run snapshots', 'ElevenLabs HTTP existing cached MP3'], nativeProviders: false, personalMicrophone: false, userBrowser: false, newTts: false }, heldEvidence, endAt, replayId: replay.id, calls, progress, played, audioRequests, webResponses, transportReports, timings: voice.timings.list(), events: await page.evaluate(() => (window as any).events), pageErrors: errors }, null, 2));
  console.log(`PASS finite independent parts with web Content-Length; meaningful progress/first ACK before held turn end; ordered residual; cancel and explicit replay. Artifact: ${artifact}`);
} catch (error) {
  await mkdir(artifactDir, { recursive: true });
  await writeFile(artifact, JSON.stringify({ result: 'FAIL', error: String(error), timings: timingSnapshot(), ttsDelayMs, boundaryEvidence, syntheticDiagnostics: page ? await page.evaluate(() => (window as any).syntheticDiagnostics).catch(() => []) : [], listenDiagnostics: page ? await page.evaluate(() => (window as any).listenDiagnostics).catch(() => undefined) : undefined, gateStates: page ? await page.evaluate(() => (window as any).gateStates).catch(() => []) : [], calls, progress, played, audioRequests, webResponses, events: page ? await page.evaluate(() => (window as any).events).catch(() => []) : [] }, null, 2));
  throw error;
} finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
