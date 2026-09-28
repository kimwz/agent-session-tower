import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ElevenLabs } from '../../server/master/elevenlabs.js';
import type { LiveState } from '../../server/master/live-state.js';
import { MasterRoom } from '../../server/master/room.js';
import { MasterSession } from '../../server/master/session.js';
import { MasterSettingsStore } from '../../server/master/settings.js';
import { TowerClient } from '../../server/master/tower-client.js';
import { MasterVoice, migrate, type VoiceTiming } from '../../server/master/voice.js';
import { isNoise, READ_CHARS, speakable, VOICE_ACKS, VOICE_NUDGE, VOICE_REST, voiced, voicedParts } from '../../server/master/voice-text.js';
import type { MasterEntry, MasterSpeak, MasterStreamEvent } from '../../shared/master.js';
import type { ChatMessage, Run, Snapshot } from '../../shared/types.js';
import { until } from '../helpers/until.js';

const TOKEN = 'a'.repeat(64);
const SECRET = 'b'.repeat(64);
const VOICE_KEY = 'el-test-0123456789abcdef';
const TAB = randomUUID();
const digestOf = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const FAST: Partial<VoiceTiming> = { firstChunkMs: 1_000, synthMs: 2_000, playMs: 2_000, resyncMs: 500, waitMs: 500, presenceMs: 60_000, tickMs: 60_000 };

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}
const stop = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });

/** ElevenLabs as far as the master uses it: tokens, reading aloud (as a stream), voices, and history removal. */
async function fakeElevenLabs() {
  const state = {
    tokens: 0, speeches: [] as Array<{ voice: string; body: Record<string, unknown>; key?: string }>, deletes: [] as string[], keys: [] as string[],
    mode: 'ok' as 'ok' | 'cut' | 'error', fail: (_text: string) => false, silent: (_text: string) => false, lagMs: 0, chunks: [Buffer.from('ID3-first-'), Buffer.from('second-part')], gapMs: 20,
  };
  const server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    state.keys.push(String(req.headers['xi-api-key']));
    const url = new URL(req.url!, 'http://x');
    if (req.method === 'POST' && url.pathname === '/v1/single-use-token/realtime_scribe') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ token: `sutkn_${++state.tokens}` })); return; }
    if (req.method === 'GET' && url.pathname === '/v2/voices') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ voices: [{ voice_id: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica', category: 'premade' }, { voice_id: 'bad id', name: 'x' }], has_more: false })); return; }
    if (req.method === 'DELETE' && url.pathname.startsWith('/v1/history/')) { state.deletes.push(url.pathname.slice('/v1/history/'.length)); res.writeHead(200).end(); return; }
    const speech = /^\/v1\/text-to-speech\/([^/]+)\/stream$/.exec(url.pathname);
    if (req.method === 'POST' && speech) {
      state.speeches.push({ voice: speech[1], body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>, key: req.headers['xi-api-key'] as string });
      if (state.mode === 'error' || state.fail(String(state.speeches.at(-1)!.body.text))) { res.writeHead(500).end('no'); return; }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'history-item-id': `h${state.speeches.length}` });
      if (state.silent(String(state.speeches.at(-1)!.body.text))) { res.end(); return; }
      if (state.lagMs) await sleep(state.lagMs);
      res.write(state.chunks[0]);
      await sleep(state.gapMs);
      if (state.mode === 'cut') { res.destroy(); return; }
      res.end(state.chunks[1]);
      return;
    }
    res.writeHead(404).end();
  });
  const port = await listen(server);
  return Object.assign(state, { base: `http://127.0.0.1:${port}`, close: () => stop(server) });
}

/** What the master session answers, in order: text, or a function of the request. Nothing leaves a turn running. */
type Step = string | ((prompt: string) => string | undefined) | undefined;
const MASTER = 'claude:master';

interface Options { steps?: Step[]; settings?: Record<string, unknown>; prepare?: (dir: string, room: MasterRoom) => void | Promise<void>; timing?: Partial<VoiceTiming>; voiceKey?: boolean }

/**
 * The master session and its voice in one folder: a fake Tower where a message to the master session becomes a run,
 * answered from the script, and a fake ElevenLabs.
 */
async function harness(t: test.TestContext, options: Options = {}) {
  const cleanup: Array<() => unknown> = [];
  const dir = await mkdtemp(join(tmpdir(), 'tower-master-voice7-'));
  t.after(async () => { for (const step of cleanup.reverse()) await step(); await rm(dir, { recursive: true, force: true }); });
  const labs = await fakeElevenLabs();
  cleanup.push(() => labs.close());
  const seen: Array<{ method: string; path: string }> = [];
  const runs: Run[] = [];
  const histories = new Map<string, { updatedAt: string; messages: ChatMessage[] }>();
  const steps = [...(options.steps ?? [])];
  const prompts: string[] = [];
  let clock = Date.now();
  const tick = () => new Date(clock += 1000).toISOString();
  const history = (id: string) => { let known = histories.get(id); if (!known) histories.set(id, known = { updatedAt: tick(), messages: [] }); return known; };
  const answer = (run: Run, text: string | undefined) => {
    if (text === undefined) return;
    const kept = history(run.sessionId);
    kept.messages.push({ id: randomUUID(), role: 'user', text: run.prompt, timestamp: tick() }, { id: randomUUID(), role: 'assistant', text, timestamp: tick() });
    run.status = 'completed'; run.finishedAt = tick(); kept.updatedAt = tick();
  };
  const tower = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    seen.push({ method: req.method!, path: req.url! });
    const url = new URL(req.url!, 'http://x');
    const message = /^\/api\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
    if (req.method === 'POST' && message) {
      const prompt = String((JSON.parse(Buffer.concat(chunks).toString('utf8')) as { prompt?: string }).prompt);
      prompts.push(prompt);
      const run: Run = { id: `r${runs.length + 1}`, sessionId: decodeURIComponent(message[1]), prompt, status: 'running', createdAt: tick(), output: '' };
      runs.push(run);
      res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ run }));
      const step = steps.shift();
      setTimeout(() => answer(run, typeof step === 'function' ? step(prompt) : step), 20);
      return;
    }
    const detail = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && detail) {
      const id = decodeURIComponent(detail[1]);
      const kept = history(id);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ session: { id, updatedAt: kept.updatedAt }, messages: kept.messages, hasMore: false }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  });
  const towerPort = await listen(tower);
  cleanup.push(() => stop(tower));
  const settings = new MasterSettingsStore(dir);
  await settings.start();
  if (options.voiceKey !== false || options.settings) await settings.update({ ...(options.voiceKey === false ? {} : { voiceKey: VOICE_KEY }), ...options.settings });
  await settings.bind({ sessionId: MASTER, provider: 'claude', startedAt: new Date().toISOString() });
  const room = new MasterRoom(dir);
  await room.start();
  await options.prepare?.(dir, room);
  const client = new TowerClient(2_000);
  client.setCredentials({ port: towerPort, token: TOKEN, callerSecret: SECRET });
  const snapshot = (): Snapshot => ({ sessions: [], runs, autoPrompts: [], providers: [], scanning: false, hostname: 'here', version: 't', updatedAt: '' });
  const live = { fresh: async () => snapshot(), snapshot, node: () => undefined } as unknown as LiveState;
  const session = new MasterSession({ stateDir: dir, dataDir: dir, settings, tower: client, live, room, followMs: 30 });
  const elevenLabs = new ElevenLabs({ key: () => settings.voiceKey(), apiBase: labs.base, sttBase: labs.base.replace('http', 'ws'), historyDelaysMs: [10] });
  const voice = new MasterVoice({ dataDir: dir, settings, room, elevenLabs, timing: { ...FAST, ...options.timing },
    hooks: { hide: text => text, connectedSince: () => client.connectedSince(), send: input => session.spoken({ text: input.text, key: input.voice.key, voiceSession: input.voice.session ?? '' }) } });
  session.setVoice(voice);
  await voice.start();
  await session.start();
  cleanup.push(async () => { await voice.close(); await session.close(); await room.flush(); });
  const events: MasterStreamEvent[] = [];
  room.subscribe(event => events.push(event));
  const says = () => events.flatMap(event => event.type === 'say' ? [event.say] : []);
  const speakOf = (id: string): MasterSpeak | undefined => { const data = room.get(id)?.data; return data && (data.kind === 'master' || data.kind === 'event' || data.kind === 'error') ? data.speak : undefined; };
  /** Work the master handed out ends: Tower reports it to the master session, whose answer is the next step. */
  const queueEvent = async (title: string) => {
    const id = `d${runs.length + 1}`;
    const run: Run = { id, sessionId: `claude:work-${id}`, prompt: title, status: 'running', createdAt: tick(), output: '' };
    runs.push(run);
    await session.started({ method: 'POST', path: '/api/sessions', route: '/api/sessions', local: '/api/sessions', write: true }, { prompt: title }, { session: { id: run.sessionId }, run: { id } });
    answer(run, `${title}: done`);
  };
  return { dir, labs, room, session, voice, client, towerPort, seen, events, says, speakOf, queueEvent, settings, prompts, runs };
}
type Harness = Awaited<ReturnType<typeof harness>>;
const masterEntry = (h: Harness, pattern: RegExp) => until(() => h.room.recent(200).find((entry): entry is MasterEntry => (entry.data.kind === 'master' || entry.data.kind === 'event') && pattern.test(entry.data.text)));
const on = (h: Harness, tab = TAB) => h.voice.voiceOn({ tabId: tab, local: true }).session;
const request = (h: Harness, session: string, text: string) => h.voice.voiceRequest({ session, clientMessageId: randomUUID(), text, local: true });
/** A page that plays every answer and report it is given through to the end. */
const autoPlay = (h: Harness, session: string) => h.room.subscribe(event => {
  if (event.type === 'say' && (event.say.kind === 'answer' || event.say.kind === 'report')) setTimeout(() => h.voice.voicePlayed({ session, id: event.say.id, result: 'played' }), 10);
});

/** Reads a GET as the page would, through an HTTP server that hands the request to the voice. */
async function audioServer(t: test.TestContext, voice: MasterVoice) {
  const server = createServer((req, res) => { void voice.serveAudio(req.url!.slice(1), res); });
  const port = await listen(server);
  t.after(() => stop(server));
  const fetchAudio = (id: string) => new Promise<{ status: number; body: Buffer; complete: boolean }>(resolve => {
    const chunks: Buffer[] = [];
    httpRequest({ host: '127.0.0.1', port, path: `/${id}` }, res => {
      res.on('data', chunk => chunks.push(chunk as Buffer));
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks), complete: res.complete }));
      res.on('error', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks), complete: false }));
      res.on('aborted', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks), complete: false }));
    }).on('error', () => resolve({ status: 0, body: Buffer.concat(chunks), complete: false })).end();
  });
  return { port, fetchAudio };
}

test('voice is one session at a time: a new one ends the one before, whose page is refused from then on and cannot take it back', async t => {
  const h = await harness(t);
  assert.throws(() => h.voice.voiceOn({ tabId: 'not-a-uuid', local: true }), { statusCode: 400 });
  const first = on(h);
  assert.equal(h.voice.status().session, digestOf(first));
  assert.equal(h.voice.voicePresence({ session: first, listening: true, panelOpen: true }), true);
  const second = on(h, randomUUID());
  assert.equal(h.voice.status().session, digestOf(second));
  assert.equal(h.voice.voicePresence({ session: first, listening: true, panelOpen: true }), false, 'presence never takes voice back');
  assert.deepEqual(await request(h, first, '지금 뭐 돌아가?'), { stale: true });
  await assert.rejects(h.voice.voiceToken({ session: first }), { statusCode: 409 });
  assert.equal(h.voice.voiceActivity({ session: first, speaking: true }), false);
  assert.equal(h.voice.voiceOff({ session: first }), false);
  assert.equal(h.voice.voiceOff({ session: second }), true);
  assert.equal(h.voice.status().session, undefined);
  const saved = await readFile(join(h.dir, 'voice.json'), 'utf8');
  assert.ok(!saved.includes(first) && !saved.includes(second) && !saved.includes(TAB), 'session and tab ids stay in memory');
});

test('voice needs an ElevenLabs key; tokens come from it, each reserving an utterance until settled once, from any session', async t => {
  const h = await harness(t, { voiceKey: false });
  assert.throws(() => on(h), { statusCode: 409 });
  await h.settings.update({ voiceKey: VOICE_KEY });
  const session = on(h);
  const first = await h.voice.voiceToken({ session });
  assert.match(first.url, /\/v1\/speech-to-text\/realtime\?model_id=scribe_v2_realtime&language_code=kor&audio_format=pcm_16000&token=sutkn_1$/);
  assert.equal(h.labs.keys.at(-1), VOICE_KEY, 'the key stays on the host; the page gets a single-use token');
  assert.ok(!first.url.includes(VOICE_KEY));
  const reserved = h.voice.status().today.dollars;
  assert.ok(reserved > 0, 'a token holds a whole utterance');
  await h.voice.voiceToken({ session });
  await assert.rejects(h.voice.voiceToken({ session }), { statusCode: 409 }, 'at most two unsettled a session');
  // Voice moves to another tab: the first page's utterance is still settled.
  const other = on(h, randomUUID());
  assert.equal(await h.voice.voiceUsage({ tokenId: first.tokenId, seconds: 6 }), true);
  assert.equal(await h.voice.voiceUsage({ tokenId: first.tokenId, seconds: 6 }), false, 'once');
  assert.equal(h.voice.status().today.sttSeconds, 6);
  await h.voice.voiceToken({ session: other });
  // A token never settled counts as a whole utterance once it can no longer be used, on the day it runs out.
  const file = (h.voice as unknown as { file: { tokens: Array<{ issuedAt: number }> } }).file;
  for (const token of file.tokens) token.issuedAt -= 17 * 60_000;
  (h.voice as unknown as { settleExpired(now: number): void }).settleExpired(Date.now());
  assert.equal(h.voice.status().today.sttSeconds, 6 + 60 * 2);
  assert.equal(file.tokens.length, 0);
});

test('a daily limit holds every unsettled token and every reading before it starts, so it is never passed', async t => {
  const long = '오늘 끝난 일은 세 가지입니다. 첫째는 배포 준비, 둘째는 테스트 정리, 셋째는 문서 수정입니다. 남은 일은 없습니다. 더 알고 싶으시면 말씀해 주세요.';
  const h = await harness(t, { settings: { voice: { dailyDollars: 0.01 } }, steps: [long] });
  const session = on(h);
  const token = await h.voice.voiceToken({ session });
  // 60 seconds held (about $0.0065): a second would pass one cent.
  await assert.rejects(h.voice.voiceToken({ session }), { statusCode: 409 });
  await h.voice.voiceUsage({ tokenId: token.tokenId, seconds: 2 });
  await h.voice.voiceToken({ session });
  assert.equal(h.voice.status().limited, false);
  // The short reply fits; an answer whose reading would pass the limit is not made, and says so.
  const answer = await request(h, session, '오늘 한 일 알려줘');
  assert.ok(answer.ack);
  const entry = await masterEntry(h, /세 가지입니다/);
  await until(() => h.speakOf(entry.id)?.state === 'unspoken');
  assert.equal(h.labs.speeches.filter(item => String(item.body.text).includes('세 가지입니다')).length, 0);
  assert.ok(h.voice.status().today.dollars <= 0.01);
});

test('what the owner said is a request like a typed one, answered first with a recorded reply that is made once', async t => {
  const h = await harness(t, { steps: ['작업 두 개입니다.\n\n- a\n- b', '두 번째 답'] });
  const session = on(h);
  assert.deepEqual(await request(h, session, '감사합니다.'), { ignored: true }, 'known phantom transcripts are noise');
  assert.deepEqual(await request(h, session, '(음악)'), { ignored: true });
  const first = await request(h, session, '지금 작업 중인 세션 알려줘');
  assert.ok(first.ack && (VOICE_ACKS as readonly string[]).includes(first.ack.text));
  assert.match(first.ack.audio, /^\/api\/master\/voice\/audio\/clip-[a-f0-9]{64}$/);
  assert.equal(first.ack.session, digestOf(session));
  const owner = h.room.recent(20).find(entry => entry.data.kind === 'owner');
  assert.deepEqual(owner?.data, { kind: 'owner', text: '지금 작업 중인 세션 알려줘', voice: true });
  // It goes to the master session marked as said aloud, so the master answers it to be heard.
  assert.equal(h.prompts[0], '[voice] 지금 작업 중인 세션 알려줘');
  await masterEntry(h, /두 개입니다/);
  const made = h.labs.speeches.length;
  // The same short reply again is played from its recording.
  for (let index = 0; index < 6; index++) await request(h, session, `요청 ${index}`);
  const clips = await readdir(join(h.dir, 'voice-clips'));
  assert.ok(clips.length <= VOICE_ACKS.length);
  assert.ok(h.labs.speeches.length - made <= VOICE_ACKS.length, 'each reply is made once');
  assert.equal(h.labs.speeches[0].body.model_id, 'eleven_v3_conversational');
  assert.equal(h.labs.speeches[0].body.language_code, 'ko');
  assert.equal(h.labs.speeches[0].body.text, `[cheerfully] ${first.ack.text}`, 'a short reply is recorded brightly');
  assert.equal(isNoise('네 알겠어요'), false);
});

test('a long pause gets a recorded sign that the owner is still heard: made once, never a request, and only for the voice session now', async t => {
  const h = await harness(t, { steps: [] });
  const session = on(h);
  assert.equal(h.voice.voiceKnown({ session }), true);
  assert.equal(h.voice.voiceKnown({ session: 'not-this-one' }), false);
  const first = await h.voice.voiceNudge({ session });
  assert.equal(first.say?.text, VOICE_NUDGE);
  assert.equal(first.say?.kind, 'ack', 'reported to nobody, as a short reply');
  assert.match(first.say!.audio, /^\/api\/master\/voice\/audio\/clip-[a-f0-9]{64}$/);
  const made = h.labs.speeches.length;
  const again = await h.voice.voiceNudge({ session });
  assert.equal(again.say?.audio, first.say?.audio);
  assert.equal(h.labs.speeches.length, made, 'played from its recording');
  assert.equal(h.prompts.length, 0, 'nothing is asked of the master');
  assert.deepEqual(await h.voice.voiceNudge({ session: 'not-this-one' }), { stale: true });
});

test('an answer to a spoken request is read aloud where voice is on and marked played; with nobody to hear it, it is marked so', async t => {
  let later = '';
  const h: Harness = await harness(t, { steps: ['작업 두 개입니다.\n\n자세한 목록은 화면에.', '보고 A 끝.', '보고 C 끝.', '보고 B 끝.',
    () => { h.voice.voiceOff({ session: later }); return '답 D.'; }] });
  const session = on(h);
  await request(h, session, '최근 작업 알려줘');
  const answer = await masterEntry(h, /두 개입니다/);
  const reading = await until(() => h.says().find(item => item.kind === 'answer'));
  assert.equal(reading.text, '작업 두 개입니다. 자세한 목록은 화면에.', 'the whole answer, not only its first paragraph');
  assert.ok(h.labs.speeches.some(item => item.body.text === '[cheerfully] 작업 두 개입니다. 자세한 목록은 화면에.'), 'the tone tag goes only to speech');
  assert.equal(h.speakOf(answer.id)?.state, 'playing');
  assert.equal(h.voice.voicePlayed({ session, id: reading.id, result: 'played' }), true);
  await until(() => h.speakOf(answer.id)?.state === 'played');
  // A report of finished work is read when reports are read.
  await h.queueEvent('A ended');
  const report = await masterEntry(h, /보고 A/);
  const reportSay = await until(() => h.says().find(item => item.kind === 'report'));
  h.voice.voicePlayed({ session, id: reportSay.id, result: 'played' });
  await until(() => h.speakOf(report.id)?.state === 'played');
  // Voice on, but the master closed: the report is marked as not said aloud.
  h.voice.voicePresence({ session, listening: true, panelOpen: false });
  await h.queueEvent('C ended');
  const unheard = await masterEntry(h, /보고 C/);
  assert.equal(h.speakOf(unheard.id)?.state, 'unspoken');
  // Voice turned off: the report is only in the master's conversation.
  h.voice.voiceOff({ session });
  await h.queueEvent('B ended');
  await until(() => h.runs.find(run => run.prompt.includes('B ended') && run.prompt.startsWith('[Tower report]'))?.status === 'completed' || undefined);
  await sleep(150);
  assert.equal(h.room.recent(200).some(entry => entry.data.kind === 'event' && /보고 B/.test(entry.data.text)), false);
  // Reports reach the master session as Tower's messages, with the work's own answer.
  assert.match(h.prompts.find(prompt => prompt.includes('A ended'))!, /^\[Tower report\] Work you handed out ended:\n- "A ended" — completed \(session claude:work-d\d+\)\n  Its answer:\n    A ended: done/);
  // A spoken request answered after voice went off is marked as not said aloud.
  later = on(h, randomUUID());
  await request(h, later, '마지막 질문');
  const late = await masterEntry(h, /답 D/);
  assert.equal(h.speakOf(late.id)?.state, 'unspoken');
  await until(() => h.labs.deletes.length >= 2);
  assert.ok(h.labs.deletes.every(id => /^h\d+$/.test(id)), 'what ElevenLabs kept of a reading is removed');
});

test('audio streams to the page as it is made; cut-off audio cuts the page off, and a page gone leaves nothing waiting', async t => {
  const h = await harness(t, { steps: ['답 하나.', '답 둘.', '답 셋.'], timing: { waitMs: 10_000 } });
  const { fetchAudio, port: audioPort } = await audioServer(t, h.voice);
  const session = on(h);
  h.labs.gapMs = 200;
  await request(h, session, '하나');
  const first = await until(() => h.says().find(item => item.kind === 'answer'));
  const id = first.audio.split('/').at(-1)!;
  const whole = await fetchAudio(id);
  assert.equal(whole.status, 200);
  assert.equal(whole.body.toString(), 'ID3-first-second-part');
  assert.ok(whole.complete);
  h.voice.voicePlayed({ session, id: first.id, result: 'played' });
  // Failed after its first part: the page's connection is cut, never cleanly ended.
  h.labs.mode = 'cut';
  await request(h, session, '두 번째');
  const second = await until(() => h.says().filter(item => item.kind === 'answer')[1]);
  const cut = await fetchAudio(second.audio.split('/').at(-1)!);
  assert.equal(cut.complete, false);
  assert.equal(cut.body.toString(), 'ID3-first-');
  assert.equal(h.voice.listeners(second.audio.split('/').at(-1)!), 0);
  // A page that comes only after the audio failed still gets what was made before its connection is cut.
  const lateAt = Date.now();
  const late = await fetchAudio(second.audio.split('/').at(-1)!);
  assert.ok(Date.now() - lateAt < 3_000, 'cut off once sent, not after a wait');
  assert.equal(late.complete, false);
  assert.equal(late.body.toString(), 'ID3-first-');
  // A slow page that stops reading and then goes away leaves nothing waiting.
  h.labs.mode = 'ok';
  h.labs.chunks = [Buffer.alloc(900_000, 1), Buffer.alloc(900_000, 2)];
  h.voice.voicePlayed({ session, id: second.id, result: 'played' });
  await request(h, session, '세 번째');
  const third = await until(() => h.says().filter(item => item.kind === 'answer')[2]);
  const thirdId = third.audio.split('/').at(-1)!;
  await new Promise<void>(resolve => {
    const req = httpRequest({ host: '127.0.0.1', port: (audioPort), path: `/${thirdId}` }, res => { res.pause(); setTimeout(() => { req.destroy(); resolve(); }, 300); });
    req.end();
  });
  await until(() => h.voice.listeners(thirdId) === 0, 3_000);
  assert.equal((await fetchAudio(randomUUID())).status, 404);
  assert.equal((await fetchAudio(`clip-${'0'.repeat(64)}`)).status, 404);
});

/** An mp3 as ElevenLabs sends it: an ID3 tag of `size` bytes after its header, then frames. */
/** What was sent to speech for answers, the short replies left out. */
const readings = (h: Harness) => h.labs.speeches.map(item => String(item.body.text)).filter(text => !VOICE_ACKS.some(ack => text.endsWith(ack)));
const mp3 = (frames: string, size = 35) => Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, size]), Buffer.alloc(size, 0x54), Buffer.from(frames)]);

test('a long answer to a spoken request is read whole: parts of whole sentences, in order, made into one stream with one tag at its start', async t => {
  const long = Array.from({ length: 24 }, (_, index) => `${index + 1}번째 문장은 끝까지 읽혀야 하는 설명이고, 빠지거나 겹치지 않고 이어집니다.`);
  const answer = `좋아요, 하나씩 말씀드릴게요!\n\n${long.slice(0, 12).map(line => `- ${line}`).join('\n')}\n\n${long.slice(12).join(' ')}`;
  const h = await harness(t, { steps: [answer] });
  const { fetchAudio } = await audioServer(t, h.voice);
  const session = on(h);
  // Each part's stream starts with its own tag, split across chunks the way a network may split it.
  const whole = mp3('frames');
  h.labs.chunks = [whole.subarray(0, 6), whole.subarray(6)];
  h.labs.gapMs = 5;
  await request(h, session, '길게 알려줘');
  const entry = await masterEntry(h, /하나씩 말씀드릴게요/);
  const reading = await until(() => h.says().find(item => item.kind === 'answer'));
  assert.equal(h.says().filter(item => item.kind === 'answer').length, 1, 'one thing to play for the answer');
  assert.equal(reading.text, speakable(answer), 'the page is sent what is read, without tags');
  assert.ok(!reading.text.includes('[cheerfully]'));
  for (const line of long) assert.ok(reading.text.includes(line), line);
  const audio = await fetchAudio(reading.audio.split('/').at(-1)!);
  assert.ok(audio.complete);
  const texts = readings(h);
  assert.ok(texts.length > 2, 'made in parts');
  assert.ok(texts[0].length < 140, 'the first part is short, so it starts soon');
  assert.ok(texts.every(text => text.startsWith('[cheerfully] ')), 'each part keeps the tone');
  assert.equal(texts.map(text => text.slice('[cheerfully] '.length)).join(' '), speakable(answer), 'nothing dropped, nothing said twice');
  assert.deepEqual(audio.body, Buffer.concat([whole, ...texts.slice(1).map(() => Buffer.from('frames'))]), 'only the first tag stays');
  h.voice.voicePlayed({ session, id: reading.id, result: 'played' });
  await until(() => h.speakOf(entry.id)?.state === 'played');
});

test('a later part that fails before any sound is asked for once more; one that fails again cuts the answer off and marks it not said', async t => {
  const answer = Array.from({ length: 40 }, (_, index) => `${index + 1}번째 문장은 조금 길게 이어지는 설명입니다.`).join(' ');
  const h = await harness(t, { steps: [answer, answer.replace(/설명/g, '이야기')] });
  const { fetchAudio } = await audioServer(t, h.voice);
  const session = on(h);
  h.labs.gapMs = 5;
  h.labs.chunks = [mp3('a'), Buffer.from('b')];
  // The answer's second part (from its fifth sentence) fails once.
  let failures = 0;
  h.labs.fail = text => text.includes('5번째') && failures++ === 0;
  await request(h, session, '하나');
  const first = await until(() => h.says().find(item => item.kind === 'answer'));
  const whole = await fetchAudio(first.audio.split('/').at(-1)!);
  assert.ok(whole.complete, 'the part asked for again came, and the answer is whole');
  const texts = readings(h).map(text => text.replace(/^\[cheerfully\] /, ''));
  assert.equal(texts[1], texts[2], 'the failed part is asked for again');
  assert.equal([texts[0], ...texts.slice(2)].join(' '), answer, 'and nothing else is said twice');
  const entry = await masterEntry(h, /설명입니다/);
  h.voice.voicePlayed({ session, id: first.id, result: 'played' });
  await until(() => h.speakOf(entry.id)?.state === 'played');
  // Failing twice: the page's connection is cut after what came, and the answer is marked as not said aloud.
  h.labs.fail = text => text.includes('5번째');
  await request(h, session, '두 번째');
  const second = await until(() => h.says().filter(item => item.kind === 'answer')[1]);
  const cut = await fetchAudio(second.audio.split('/').at(-1)!);
  assert.equal(cut.complete, false);
  const failed = await masterEntry(h, /이야기입니다/);
  h.voice.voicePlayed({ session, id: second.id, result: 'failed' });
  await until(() => h.speakOf(failed.id)?.state === 'unspoken');
  // What is counted is what was asked for: the parts after the one that failed were never sent, nor paid for.
  assert.ok(!readings(h).some(text => text.includes('30번째 문장은 조금 길게 이어지는 이야기')));
  const asked = () => h.labs.speeches.reduce((sum, item) => sum + String(item.body.text).length, 0);
  await until(() => h.voice.status().today.ttsChars === asked());
});

test('a long answer skipped partway stops being made: the parts not yet asked for are not asked for, nor paid for', async t => {
  const answer = Array.from({ length: 60 }, (_, index) => `${index + 1}번째 문장은 조금 길게 이어지는 설명입니다.`).join(' ');
  const h = await harness(t, { steps: [answer], timing: { playMs: 60_000 } });
  const session = on(h);
  h.labs.chunks = [mp3('a'), Buffer.from('b')];
  h.labs.gapMs = 150;
  await request(h, session, '길게 알려줘');
  const entry = await masterEntry(h, /60번째/);
  const reading = await until(() => h.says().find(item => item.kind === 'answer'));
  h.voice.voicePlayed({ session, id: reading.id, result: 'stopped' });
  await until(() => h.speakOf(entry.id)?.state === 'unspoken');
  const made = readings(h).length;
  await sleep(600);
  assert.equal(readings(h).length, made, 'nothing more is asked for');
  const all = voicedParts(speakable(answer), 'eleven_v3_conversational', 'answer');
  assert.ok(made < all.length);
  // Paid for: what was asked for, and at most the one part whose request the skip cut short on its way.
  const asked = h.labs.speeches.reduce((sum, item) => sum + String(item.body.text).length, 0);
  const paid = h.voice.status().today.ttsChars;
  assert.ok(paid >= asked && paid <= asked + 520, `${paid} for ${asked} asked`);
  assert.ok(paid < all.reduce((sum, part) => sum + part.length, 0) / 2);
});

test('an answer whose sound does not start in time is not made further', async t => {
  const answer = Array.from({ length: 30 }, (_, index) => `${index + 1}번째 문장은 조금 길게 이어지는 설명입니다.`).join(' ');
  const h = await harness(t, { steps: [answer], timing: { firstChunkMs: 100 } });
  const session = on(h);
  h.labs.chunks = [mp3('a'), Buffer.from('b')];
  h.labs.gapMs = 5;
  h.labs.lagMs = 300;
  await request(h, session, '길게 알려줘');
  const entry = await masterEntry(h, /30번째/);
  await until(() => h.speakOf(entry.id)?.state === 'unspoken');
  await sleep(800);
  assert.equal(readings(h).length, 1, 'only the first part was asked for');
  assert.equal(h.says().filter(item => item.kind === 'answer').length, 0);
});

test('a later part that comes back without sound is asked for again, never skipped', async t => {
  const answer = Array.from({ length: 12 }, (_, index) => `${index + 1}번째 문장은 조금 길게 이어지는 설명입니다.`).join(' ');
  const h = await harness(t, { steps: [answer] });
  const { fetchAudio } = await audioServer(t, h.voice);
  const session = on(h);
  h.labs.gapMs = 5;
  h.labs.chunks = [mp3('a'), Buffer.from('b')];
  let silences = 0;
  h.labs.silent = text => text.includes('5번째') && silences++ === 0;
  await request(h, session, '하나');
  const reading = await until(() => h.says().find(item => item.kind === 'answer'));
  assert.ok((await fetchAudio(reading.audio.split('/').at(-1)!)).complete);
  const texts = readings(h).map(text => text.replace(/^\[cheerfully\] /, ''));
  assert.equal(texts[1], texts[2], 'the silent part is asked for again');
  assert.equal([texts[0], ...texts.slice(2)].join(' '), answer);
});

test('voice records from GPT-Live calls become dollars once, counted and not yet counted, and settings keep everything but their old voice keys', async t => {
  const now = Date.now();
  const today = new Date(now);
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const old = { attempts: [
    { folded: true, createdAt: now - 60_000, usage: { seconds: 40, final: true } },
    { createdAt: now - 60_000, answered: true, readyAt: now - 50_000, usage: { seconds: 20, final: true } },
    { createdAt: now - 60_000, unbilled: true, usage: { seconds: 0 } },
    { createdAt: now - 60_000, answered: false, usage: { seconds: 0 } },
    { createdAt: now - 60_000, answered: true, readyAt: now - 60_000, closedAt: now - 30_000, usage: { seconds: 10, observedAt: now - 40_000 } },
  ], days: { [day]: 40 }, silence: null };
  const once = migrate(old, now);
  // 40 folded + 20 final + 0 unbilled + 15 never reached the page + (10 + 10 since its last report).
  assert.equal(Math.round(once.days[day].dollars / (0.05 / 60)), 40 + 20 + 15 + 20);
  assert.deepEqual(migrate(JSON.parse(JSON.stringify(once)), now + 3_600_000), once, 'read again, nothing is added');
  // A call that ran across midnight keeps what it reported on each day, and its unreported end falls on its days.
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const yesterday = new Date(midnight.getTime() - 1);
  const dayOf = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const across = migrate({ attempts: [{ createdAt: midnight.getTime() - 120_000, answered: true, readyAt: midnight.getTime() - 120_000, closedAt: midnight.getTime() + 30_000, usage: { seconds: 50, observedAt: midnight.getTime() - 10_000, byDay: { [dayOf(yesterday)]: 50 } } }] }, midnight.getTime() + 60_000);
  assert.equal(Math.round(across.days[dayOf(yesterday)].dollars / (0.05 / 60)), 50 + 10);
  assert.equal(Math.round(across.days[dayOf(midnight)].dollars / (0.05 / 60)), 30);

  const h = await harness(t, { prepare: async dir => {
    await writeFile(join(dir, 'voice.json'), JSON.stringify(old));
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ enabled: true, model: 'gpt-6-sol', effort: 'high', showResults: false, guards: { hideSecrets: true, localOnlyPages: true, eventTurnsReadOnly: true, readOnlyNodes: [], maxIrreversiblePerTurn: 3 }, voice: { voice: 'marin', silenceSeconds: 15, dailyMinutes: 30, autoWake: true } }));
  } });
  const restarted = new MasterSettingsStore(h.dir);
  await restarted.start();
  const settings = restarted.current();
  assert.deepEqual(Object.keys(settings), ['voice'], 'what the API master kept is dropped');
  assert.equal(settings.voice.model, 'eleven_v3_conversational');
  assert.equal(h.voice.status().today.dollars, Math.round(95 * (0.05 / 60) * 100) / 100);
  const saved = JSON.parse(await readFile(join(h.dir, 'voice.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(saved.version, 6);
  assert.equal(saved.attempts, undefined);
});

test('a tone tag goes only to models that follow tags, and never to failures, notices or serious news', () => {
  assert.equal(voiced('작업 두 개입니다.', 'eleven_v3_conversational', 'answer'), '[cheerfully] 작업 두 개입니다.');
  assert.equal(voiced('배포까지 끝났어요!', 'eleven_v3', 'report'), '[excited] 배포까지 끝났어요!');
  assert.equal(voiced('네, 확인해 볼게요.', 'eleven_v3_conversational', 'ack'), '[cheerfully] 네, 확인해 볼게요.');
  assert.equal(voiced('배포까지 끝났어요!', 'eleven_flash_v2_5', 'answer'), '배포까지 끝났어요!', 'a tag would be read out');
  assert.equal(voiced('세션을 닫습니다.', 'eleven_v3_conversational', 'notice'), '세션을 닫습니다.');
  assert.equal(voiced('요청을 처리하지 못했습니다: 시간 초과', 'eleven_v3_conversational', 'error'), '요청을 처리하지 못했습니다: 시간 초과');
  assert.equal(voiced('테스트가 실패했어요.', 'eleven_v3_conversational', 'report'), '테스트가 실패했어요.');
  assert.equal(voiced('죄송해요, 찾지 못했어요.', 'eleven_v3_conversational', 'answer'), '죄송해요, 찾지 못했어요.');
  assert.equal(voiced('[WIP] 브랜치 두 개예요.', 'eleven_v3_conversational', 'answer'), '[cheerfully] (WIP) 브랜치 두 개예요.', 'brackets in the text are read, not followed');
});

test('an answer is heard whole: every paragraph, list item and table cell, without markdown, code or addresses', () => {
  const joke = '좋아요, 신나게 하나 해볼게요! 😄\n\n냉장고가 친구한테 자랑했대요. “다들 하루에도 몇 번씩 나 보러 와!” 친구가 물었죠. “그래서 뭐라고 해?”';
  assert.equal(speakable(joke), '좋아요, 신나게 하나 해볼게요! 냉장고가 친구한테 자랑했대요. “다들 하루에도 몇 번씩 나 보러 와!” 친구가 물었죠. “그래서 뭐라고 해?”');
  const md = '## 결과\n\n**두 개**예요:\n1. 첫째 작업, 1.5초\n2. 둘째 `foo_bar` [문서](https://x.y/z)\n- [x] 끝남\n> 인용\n\n| 이름 | 상태 |\n|---|:--:|\n| A | 완료 |\n\n```js\nconst secret = 1;\n```\n참고 https://example.com/a?b=1';
  assert.equal(speakable(md), '결과. 두 개예요: 1. 첫째 작업, 1.5초. 2. 둘째 foo bar 문서. 끝남. 인용. 이름, 상태. A, 완료. 코드는 화면에 있어요. 참고 링크.');
  // Backticks within a line are not a fence: the rest of the answer is still read.
  assert.equal(speakable('Use `` ``` `` to start a code fence. Keep the remaining explanation.'), 'Use to start a code fence. Keep the remaining explanation.');
  assert.equal(speakable('앞\n~~~\nx\n~~~\n뒤'), '앞. 코드는 화면에 있어요. 뒤.');
  // Arithmetic keeps its sign, markup tags are not read, and a bar in a sentence is not a table.
  assert.equal(speakable('*참고*: 2*3=6'), '참고: 2*3=6.');
  assert.equal(speakable('2 * 3 = 6'), '2 * 3 = 6.');
  // A fence is a line of its own mark; a longer fence holds shorter ones, and backticks on a line are text.
  assert.equal(speakable('```foo``` is the value. And more.'), 'foo is the value. And more.');
  assert.equal(speakable('````\n```js\nx\n```\n````\n뒤'), '코드는 화면에 있어요. 뒤.');
  assert.equal(speakable('<details><summary>로그</summary>내용</details>'), '로그 내용.');
  assert.equal(speakable('A | B 중 하나예요.'), 'A | B 중 하나예요.');
});

test('the parts of an answer are whole sentences that join back into it; a number stays with its item, and past the limit reading ends at a sentence', () => {
  const text = speakable(Array.from({ length: 60 }, (_, index) => `${index + 1}. 항목 ${index + 1}은 소수 ${index}.5를 포함한 긴 설명으로 이어지는 문장입니다`).join('\n'));
  const parts = voicedParts(text, 'eleven_v3_conversational', 'answer');
  assert.ok(parts.length > 3);
  const bare = parts.map(part => part.replace(/^\[cheerfully\] /, ''));
  assert.equal(bare.join(' '), text);
  for (const part of bare) {
    assert.match(part, /[.!?…]$/, 'a part ends at a sentence');
    assert.doesNotMatch(part, /^\d+\.5/, 'a decimal is not split');
    assert.ok(!/\s\d{1,3}\.$/.test(part), 'an item number is not left behind');
  }
  // A sentence longer than a part is broken at a space, not in a word.
  const run = `${'가나다라 '.repeat(300).trim()}.`;
  const broken = voicedParts(run, 'eleven_flash_v2_5', 'answer');
  assert.equal(broken.join(' '), run);
  assert.ok(broken.every(part => part.length <= 500 && !part.startsWith(' ')));
  // A long sentence breaks after a comma when it has one.
  const commas = `${Array.from({ length: 40 }, (_, index) => `항목 ${index}번과 그 설명`).join(', ')}.`;
  const atCommas = voicedParts(commas, 'eleven_flash_v2_5', 'answer');
  assert.equal(atCommas.join(' '), commas);
  assert.ok(atCommas.slice(0, -1).every(part => part.endsWith(',')), 'each part but the last ends at a comma');
  // Too long to read whole: reading ends at a sentence, then says the rest is on the screen.
  const huge = Array.from({ length: 800 }, (_, index) => `문장 ${index}번입니다.`).join(' ');
  const capped = voicedParts(huge, 'eleven_flash_v2_5', 'answer');
  const heard = capped.join(' ');
  assert.ok(heard.endsWith(`입니다. ${VOICE_REST}`));
  assert.ok(heard.length <= READ_CHARS + VOICE_REST.length + capped.length);
  assert.ok(huge.startsWith(heard.slice(0, -VOICE_REST.length - 1)), 'what is read is the answer from its start');
  // A sentence that would pass the limit is left out whole, never read in part.
  const tail = `${'끝나지 않는 긴 문장 '.repeat(600).trim()}.`;
  const before = `${'짧은 문장입니다. '.repeat(20).trim()} `;
  const ended = voicedParts(before + tail, 'eleven_flash_v2_5', 'answer').join(' ');
  assert.equal(ended, `${before.trim()} ${VOICE_REST}`);
  // A first sentence longer than the limit is read up to it and ends at a space, not in a word.
  const single = voicedParts(tail, 'eleven_flash_v2_5', 'answer').join(' ');
  assert.ok(single.endsWith(` ${VOICE_REST}`) && single.length <= READ_CHARS + 20);
  assert.ok(tail.startsWith(single.slice(0, -VOICE_REST.length - 1).replace(/ (?=[^ ]*$)/, ' ')));
  assert.match(single.slice(0, -VOICE_REST.length - 1), /문장$/, 'ends at a whole word');
  // Serious news keeps the plain voice in every part; a model without tags gets no tag.
  assert.ok(voicedParts(`${'설명입니다. '.repeat(80)}마지막에 오류가 있었어요.`, 'eleven_v3', 'answer').every(part => !part.startsWith('[')));
  assert.deepEqual(voicedParts('', 'eleven_v3', 'answer'), []);
});
