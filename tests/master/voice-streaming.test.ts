import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ElevenLabs } from '../../server/master/elevenlabs.js';
import type { LiveState } from '../../server/tower-tools/live-state.js';
import { MasterRoom } from '../../server/master/room.js';
import { lastMessage, MasterSession } from '../../server/master/session.js';
import { MasterSettingsStore } from '../../server/master/settings.js';
import { TowerClient } from '../../server/tower-tools/tower-client.js';
import { frameAt, id3Size, MasterVoice } from '../../server/master/voice.js';
import { FIRST_CHUNK, TextFollower } from '../../server/master/voice-stream.js';
import { streamTone, VOICE_REST, VOICE_TONES, voicedChunk, voicedChunkPairs, voicedParts, voicedPartPairs } from '../../server/master/voice-text.js';

/** What the fake fast model says first. */
const FIRST = '요청을 확인해 볼게요.';
import { describe } from '../../server/master/voice-timings.js';
import { masterRoutes } from '../../server/master/routes.js';
import { MasterClient } from '../../server/master/client.js';
import { startMasterHost } from '../../server/master/host.js';
import { SayOrder } from '../../shared/master/voice-order.js';
import type { MasterEntry, MasterSay, MasterStreamEvent } from '../../shared/master.js';
import type { Run, RunReply, Snapshot } from '../../shared/types.js';
import { until } from '../helpers/until.js';

const TOKEN = 'a'.repeat(64);
const SECRET = 'b'.repeat(64);
const VOICE_KEY = 'el-test-0123456789abcdef';
const MASTER = 'claude:master';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const untag = (text: string) => text.replace(/^\[[a-z]+\] /, '');

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}
const stop = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });

// ─── pieces ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('words are taken whole as they are written: after a sentence or a line, never inside a code block, a table row or a number', () => {
  const follow = new TextFollower();
  const first = { done: false, first: true, paused: false };
  const later = { done: false, first: false, paused: false };
  assert.equal(follow.next('네.', first), undefined, 'a sentence is whole only once the space after it comes');
  assert.equal(follow.next('네. 확', first), undefined, `too short to start with (${FIRST_CHUNK} characters)`);
  assert.equal(follow.next('네. 지금 확인해 볼게요. 결', first), '네. 지금 확인해 볼게요. ');
  let text = '네. 지금 확인해 볼게요. 결과는 ';
  assert.equal(follow.next(text, later), undefined, 'nothing whole yet');
  text += '버전 1.70.0. 입니다';
  assert.equal(follow.next(text, { ...later, paused: true }), undefined, 'a mark after a digit ends no sentence');
  text += '.\n1. 첫째 항목\n```js\nconst a = 1;';
  assert.equal(follow.next(text, { ...later, paused: true }), '결과는 버전 1.70.0. 입니다.\n1. 첫째 항목\n', 'up to the line before an open code block');
  text += '\n```\n| a | b |';
  assert.equal(follow.next(text, { ...later, paused: true }), '```js\nconst a = 1;\n```\n', 'a closed code block goes whole; a table row being written waits');
  text += ' c |\n끝.';
  assert.equal(follow.next(text, { done: true, first: false, paused: false }), '| a | b | c |\n끝.', 'at the end everything left goes');
  assert.equal(follow.next(text, { done: true, first: false, paused: false }), undefined, 'nothing twice');
  // Later chunks wait for enough to say, or a pause.
  const longer = new TextFollower();
  longer.at = 0;
  assert.equal(longer.next('짧은 문장입니다. ', later), undefined);
  assert.equal(longer.next('짧은 문장입니다. ', { ...later, paused: true }), '짧은 문장입니다. ');
});

test('a streamed answer keeps one tone: set by its first words, calm once serious words come, and never brighter again', () => {
  const model = 'eleven_v3_conversational';
  assert.equal(streamTone('배포가 끝났어요.', model, 'answer'), VOICE_TONES.excited);
  assert.equal(streamTone('다음 작업도 볼게요.', model, 'answer', VOICE_TONES.excited), VOICE_TONES.excited);
  assert.equal(streamTone('그런데 테스트 하나가 실패했어요.', model, 'answer', VOICE_TONES.excited), '');
  assert.equal(streamTone('좋은 소식도 있어요.', model, 'answer', ''), '', 'calm stays');
  assert.equal(streamTone('안녕하세요.', 'eleven_flash_v2_5', 'answer'), '', 'no tags for models that would read them');
  assert.deepEqual(voicedChunk('첫 문장입니다. [주의] 둘째.', model, VOICE_TONES.bright), ['[cheerfully] 첫 문장입니다. (주의) 둘째.']);
  const parts = voicedChunk(`${'가'.repeat(300)}. ${'나'.repeat(300)}.`, model, '');
  assert.equal(parts.length, 2, 'parts stay within their size, split between sentences');
});

test('the first response and the answer keep their order: the answer drops a first response still waiting, and a late one is not said', () => {
  const order = new SayOrder();
  const say = (id: string, kind: MasterSay['kind'], request?: string): MasterSay => ({ id, session: 's', kind, text: id, audio: `/a/${id}`, expiresAt: 0, ...(request ? { request } : {}) });
  const ack = say('ack', 'ack', 'q1');
  assert.deepEqual(order.admit(ack, []), { admit: true, drop: [] });
  const other = say('other-ack', 'ack', 'q2');
  const answer = say('answer', 'answer', 'q1');
  assert.deepEqual(order.admit(answer, [ack, other]), { admit: true, drop: [ack] }, 'only the same request\'s waiting first response goes');
  assert.equal(order.admit(say('late', 'working', 'q1'), []).admit, false);
  assert.equal(order.admit(say('late-ack', 'ack', 'q1'), []).admit, false);
  assert.equal(order.admit(say('n', 'notice'), []).admit, true, 'anything without a request is as before');
});

test('the answer is the last message\'s words, whole; replies that lost words are not used', () => {
  const run = (replies: RunReply[], trimmed = false) => ({ replies, ...(trimmed ? { repliesTrimmed: true } : {}) }) as Run;
  assert.equal(lastMessage(run([{ id: 'm1:1', text: '먼저 볼게요.', done: true }, { id: 'm2:0', text: '두 개예요.', done: true }, { id: 'm2:2', text: '자세한 건 화면에.', done: true }])), '두 개예요.\n자세한 건 화면에.');
  assert.equal(lastMessage(run([{ id: 'm1:0', text: '답', done: true }], true)), undefined);
  assert.equal(lastMessage({} as Run), undefined, 'an older worker sends none');
});

test('audio starts again partway at a whole frame after its tag, and a line tells how long each step took', () => {
  const header = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
  const frame = Buffer.concat([header, Buffer.alloc(417 - 4, 1)]);
  const tag = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 20]), Buffer.alloc(20)]);
  const data = Buffer.concat([tag, frame, frame, frame, frame]);
  assert.equal(id3Size(data), 30);
  assert.equal(frameAt(data, 30), 30);
  assert.equal(frameAt(data, 31), 30 + 417, 'the next whole frame');
  assert.equal(frameAt(data, 10_000), data.length);
  assert.match(describe({ key: 'abcdef0123', mode: 'stream', request: 1000, text: 1500, audio: 2200, play: 2500 }), /abcdef01 \(stream\): text \+500ms, audio \+1200ms, play \+1500ms/);
});

test('the page\'s place in the audio reaches the host through the web', async () => {
  const piped: Array<{ id: string; at: number }> = [];
  const handle = masterRoutes({ pipeAudio: async (res: import('node:http').ServerResponse, id: string, at: number) => { piped.push({ id, at }); res.writeHead(200).end(); } } as unknown as MasterClient);
  const id = randomUUID();
  for (const query of ['?at=12.5', '?at=-1', '?at=nope', '']) {
    const url = new URL(`http://x/api/master/voice/audio/${id}${query}`);
    const res = { writeHead() { return this; }, end() {}, headersSent: false } as unknown as import('node:http').ServerResponse;
    await handle({ method: 'GET' } as IncomingMessage, res, url.pathname, url, { local: true });
  }
  assert.deepEqual(piped.map(item => item.at), [12.5, 0, 0, 0]);
});

// ─── reading while the master writes ────────────────────────────────────────────────────────────────────────────────

async function fakeElevenLabs() {
  // Each reading starts with an empty ID3 tag, as ElevenLabs' mp3 does; later parts of one audio lose theirs.
  const state = { speeches: [] as string[], chunks: [Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]), Buffer.from('sound')], gapMs: 10, completed: [] as Array<{ speech: number; at: number }> };
  const server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const url = new URL(req.url!, 'http://x');
    if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
    if (req.method === 'POST' && /^\/v1\/text-to-speech\/[^/]+\/stream$/.test(url.pathname)) {
      state.speeches.push(String((JSON.parse(Buffer.concat(chunks).toString('utf8')) as { text: string }).text));
      const speech = state.speeches.length;
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'history-item-id': `h${speech}` });
      res.write(state.chunks[0]);
      await sleep(state.gapMs);
      res.end(state.chunks[1]);
      state.completed.push({ speech, at: Date.now() });
      return;
    }
    res.writeHead(404).end();
  });
  const port = await listen(server);
  return Object.assign(state, { base: `http://127.0.0.1:${port}`, close: () => stop(server) });
}

interface Page { answer?: (say: MasterSay) => string | undefined; delayMs?: number }

/**
 * The master session and its voice, with a fake Tower whose master turns the test writes word by word (as the worker
 * passes them), a live state that tells of every change, a fake ElevenLabs, and a page that plays what it is given.
 */
async function harness(t: test.TestContext, options: { settings?: Record<string, unknown>; page?: Page; followMs?: number; prepare?: (dir: string) => Promise<void>; playMs?: number } = {}) {
  const cleanup: Array<() => unknown> = [];
  const dir = await mkdtemp(join(tmpdir(), 'tower-voice-stream-'));
  t.after(async () => { for (const step of cleanup.reverse()) await step(); await rm(dir, { recursive: true, force: true }); });
  const labs = await fakeElevenLabs();
  cleanup.push(() => labs.close());
  const runs: Run[] = [];
  let clock = Date.now();
  const tick = () => new Date(clock += 1000).toISOString();
  const tower = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const url = new URL(req.url!, 'http://x');
    const message = /^\/api\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
    if (req.method === 'POST' && message) {
      const prompt = String((JSON.parse(Buffer.concat(chunks).toString('utf8')) as { prompt?: string }).prompt);
      const run: Run = { id: `r${runs.length + 1}`, sessionId: decodeURIComponent(message[1]), prompt, status: 'running', createdAt: tick(), output: '', replies: [] };
      runs.push(run);
      res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ run }));
      return;
    }
    const detail = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && detail) { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ session: { id: decodeURIComponent(detail[1]), updatedAt: tick() }, messages: [], hasMore: false })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  });
  const towerPort = await listen(tower);
  cleanup.push(() => stop(tower));
  const settings = new MasterSettingsStore(dir);
  await settings.start();
  await settings.update({ voiceKey: VOICE_KEY, ...options.settings });
  await settings.bind({ sessionId: MASTER, provider: 'claude', startedAt: new Date().toISOString() });
  const room = new MasterRoom(dir);
  await room.start();
  await options.prepare?.(dir);
  const client = new TowerClient(2_000);
  client.setCredentials({ port: towerPort, token: TOKEN, callerSecret: SECRET });
  const listeners = new Set<() => void>();
  const snapshot = (): Snapshot => ({ sessions: [], runs, autoPrompts: [], providers: [], scanning: false, hostname: 'here', version: 't', updatedAt: '' });
  const live = { fresh: async () => snapshot(), snapshot, node: () => undefined, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); } } as unknown as LiveState;
  const emit = () => { for (const listener of listeners) listener(); };
  const session = new MasterSession({ stateDir: dir, dataDir: dir, settings, tower: client, live, room, followMs: options.followMs ?? 60_000 });
  const elevenLabs = new ElevenLabs({ key: () => settings.voiceKey(), apiBase: labs.base, historyDelaysMs: [10] });
  /** The fast model writing first replies, faked; `delayMs` holds its answer back. */
  const firsts = { delayMs: 0 };
  const firstReply = {
    prepare: () => {}, close: () => {},
    make: async (_text: string, signal: AbortSignal) => {
      if (firsts.delayMs) await new Promise<void>(resolve => { const timer = setTimeout(resolve, firsts.delayMs); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
      return signal.aborted ? { skipped: 'failed' as const, warm: true } : { text: FIRST, warm: true };
    },
  };
  const voice = new MasterVoice({ dataDir: dir, settings, room, elevenLabs, firstReply, timing: { firstChunkMs: 1_000, synthMs: 2_000, playMs: options.playMs ?? 2_000, resyncMs: 500, waitMs: 500, presenceMs: 60_000, tickMs: 60_000 },
    hooks: { hide: text => text, connectedSince: () => client.connectedSince(), send: input => session.spoken({ text: input.text, key: input.voice.key, voiceSession: input.voice.session ?? '' }),
      streamState: (turn, state) => session.voicedState(turn, state) } });
  session.setVoice(voice);
  await voice.start();
  await session.start();
  cleanup.push(async () => { await voice.close(); await session.close(); await room.flush(); });
  const events: MasterStreamEvent[] = [];
  const heardSays = new Set<string>();
  const page = options.page ?? {};
  room.subscribe(event => {
    events.push(event);
    if (event.type !== 'say' || event.say.cancelled || heardSays.has(event.say.id) || (event.say.kind !== 'answer' && event.say.kind !== 'report')) return;
    heardSays.add(event.say.id);
    const result = page.answer ? page.answer(event.say) : 'played';
    // Sound that never started (refused, or waited too long) has no start to tell of.
    if (result) setTimeout(() => voice.voicePlayed({ session: current, id: event.say.id, result, ...(result === 'blocked' || result === 'expired' ? {} : { startedMs: 5 }) }), page.delayMs ?? 30);
  });
  let current = '';
  const on = () => (current = voice.voiceOn({ tabId: randomUUID(), local: true }).session);
  const says = () => [...new Map(events.flatMap(event => event.type === 'say' && !event.say.cancelled ? [[event.say.id, event.say] as const] : [])).values()];
  /** The master writes more of a reply (and maybe ends it); Tower's state changes. */
  const write = (run: Run, id: string, text: string, done = false) => {
    let reply = run.replies!.find(item => item.id === id);
    if (!reply) run.replies!.push(reply = { id, text: '' });
    reply.text += text;
    if (done) reply.done = true;
    fresh(run);
    emit();
  };
  /** Tower's live state brings new objects each time, never the ones it gave before. */
  const fresh = (run: Run) => { run.replies = run.replies?.map(item => ({ ...item })); };
  const finish = (run: Run, status: Run['status'] = 'completed') => { for (const reply of run.replies ?? []) reply.done = true; fresh(run); run.status = status; run.finishedAt = tick(); emit(); };
  const spoken = () => labs.speeches.filter(text => untag(text) !== FIRST).map(untag);
  const entry = (pattern: RegExp) => until(() => room.recent(200).find((item): item is MasterEntry => (item.data.kind === 'master' || item.data.kind === 'event' || item.data.kind === 'error') && pattern.test(item.data.text)));
  const speakOf = (item: MasterEntry) => { const data = room.get(item.id)?.data; return data && (data.kind === 'master' || data.kind === 'event' || data.kind === 'error') ? data.speak : undefined; };
  const follow = async () => JSON.parse(await readFile(join(dir, 'follow.json'), 'utf8')) as { voiced?: Array<{ turn: string; state: string }> };
  const ask = async (text: string) => { const answer = await voice.voiceRequest({ session: current, clientMessageId: randomUUID(), text, local: true }); return { answer, run: await until(() => runs.at(-1)) }; };
  return { dir, labs, room, session, voice, runs, emit, on, says, write, finish, spoken, entry, speakOf, follow, ask, settings, fresh, firsts, events, current: () => current };
}

test('an answer is read sentence by sentence while the master writes it; when the turn ends only the rest is read, nothing twice', async t => {
  const h = await harness(t);
  h.on();
  const { answer, run } = await h.ask('SORI 광고 알려줘');
  assert.ok(answer.ack?.request, 'the first response names its request');
  h.write(run, 'm1:1', '지금 SORI 광고 성과를 확인했어요. 결제가 ');
  const first = await until(() => h.says().find(say => say.kind === 'answer'));
  assert.equal(first.streaming, true);
  assert.equal(first.request, answer.ack!.request, 'the answer names the same request, so the page keeps their order');
  assert.deepEqual(h.spoken(), ['지금 SORI 광고 성과를 확인했어요.'], 'read before the turn ended, only what was whole');
  assert.equal(h.voice.busy(), true, 'a host of another build waits while this is read');
  h.write(run, 'm1:1', '아직 없어요. 다음 단계를 말씀드릴게요.', true);
  h.finish(run);
  const done = await h.entry(/결제가 아직 없어요/);
  await until(() => h.speakOf(done)?.state === 'played');
  const whole = '지금 SORI 광고 성과를 확인했어요. 결제가 아직 없어요. 다음 단계를 말씀드릴게요.';
  await until(() => h.spoken().join(' ').length >= whole.length || undefined);
  await sleep(50);
  assert.deepEqual(h.spoken().join(' '), whole, 'nothing twice');
  assert.equal(h.room.recent(200).filter(item => item.data.kind === 'master').length, 1, 'one entry, never waiting to be read again');
  // Its record is kept as it ends (written before the session's last save completes).
  await h.session.close();
  assert.deepEqual((await h.follow()).voiced?.map(item => [item.turn, item.state]), [['r1', 'done']]);
  await until(() => !h.voice.busy() || undefined);
});

test('what the master writes before a tool is read at once; its final answer after the tool is read next, each once', async t => {
  const h = await harness(t);
  h.on();
  const { run } = await h.ask('지금 뭐 돌아가?');
  h.write(run, 'm1:1', '세션 목록을 볼게요.', true);
  await until(() => h.says().filter(say => say.kind === 'answer').length === 1 || undefined);
  await sleep(100);
  h.write(run, 'm2:0', '지금 두 개가 돌고 있어요. 하나는 배포, 하나는 리뷰예요.', true);
  h.finish(run);
  const done = await h.entry(/두 개가 돌고/);
  await until(() => h.speakOf(done)?.state === 'played');
  const answers = h.says().filter(say => say.kind === 'answer');
  assert.equal(answers.length, 2, 'each message its own audio, so a tool call never holds audio open');
  assert.notEqual(answers[0].audio, answers[1].audio);
  await until(() => h.spoken().length >= 2 || undefined);
  await sleep(50);
  assert.deepEqual(h.spoken(), ['세션 목록을 볼게요.', '지금 두 개가 돌고 있어요. 하나는 배포, 하나는 리뷰예요.']);
  const data = done.data as { text: string };
  assert.equal(data.text, '지금 두 개가 돌고 있어요. 하나는 배포, 하나는 리뷰예요.', 'the answer is the last message, as history would give it');
});

test('an answer skipped on the page stops being read: nothing more of the turn, now or when it ends', async t => {
  const h = await harness(t, { page: { answer: () => 'interrupted' } });
  h.on();
  const { run } = await h.ask('길게 설명해 줘');
  h.write(run, 'm1:0', '첫 문장을 먼저 말씀드릴게요. ');
  await until(() => h.says().find(say => say.kind === 'answer'));
  await until(() => !h.voice.streaming(run.id) || undefined);
  h.write(run, 'm1:0', '둘째 문장은 읽히지 않아야 해요. 셋째도요.', true);
  h.finish(run);
  const done = await h.entry(/둘째 문장/);
  await until(() => h.speakOf(done)?.state === 'unspoken');
  assert.deepEqual(h.spoken(), ['첫 문장을 먼저 말씀드릴게요.']);
  assert.equal(h.says().filter(say => say.kind === 'answer').length, 1);
});

test('a turn being read when the host stopped is never read again after it starts over', async t => {
  const h = await harness(t, { prepare: async dir => {
    await writeFile(join(dir, 'follow.json'), JSON.stringify({ version: 1, baselineAt: new Date(0).toISOString(), masterRuns: ['r1'],
      followed: [{ id: 'f1', kind: 'spoken', title: 't', sessionId: MASTER, runId: 'r1', createdAt: new Date().toISOString(), state: 'running', key: 'k1' }],
      voiced: [{ turn: 'r1', state: 'started', at: new Date().toISOString() }] }));
  } });
  h.on();
  const run: Run = { id: 'r1', sessionId: MASTER, prompt: '[voice] x', status: 'running', createdAt: new Date().toISOString(), output: '', replies: [] };
  h.runs.push(run);
  h.write(run, 'm1:0', '이미 읽던 답입니다. 다시 읽으면 안 돼요.', true);
  h.finish(run);
  await sleep(300);
  assert.deepEqual(h.spoken(), []);
  assert.equal(h.says().length, 0);
  assert.deepEqual((await h.follow()).voiced?.map(item => item.state), ['stopped']);
});

test('a turn that ends is answered at once, not at the next regular look', async t => {
  const h = await harness(t, { followMs: 60_000 });
  h.on();
  const { run } = await h.ask('짧게 답해 줘');
  const started = Date.now();
  h.write(run, 'm1:0', '네, 끝났어요.', true);
  h.finish(run);
  await h.entry(/끝났어요/);
  assert.ok(Date.now() - started < 2_000, 'well before the next regular look');
});

test('many replies at once are all read in order, none of their audio pushed out while it waits', async t => {
  const h = await harness(t, { page: { delayMs: 5 } });
  h.on();
  const { run } = await h.ask('많이 말해 줘');
  for (let index = 0; index < 45; index++) run.replies!.push({ id: `m${index}:0`, text: `${index}번째 짧은 말이에요.`, done: true });
  h.fresh(run);
  h.emit();
  await until(() => h.says().find(say => say.kind === 'answer'));
  h.finish(run);
  const done = await h.entry(/44번째/);
  await until(() => h.speakOf(done)?.state === 'played', 20_000);
  await until(() => h.spoken().length >= 45 || undefined, 20_000);
  assert.deepEqual(h.spoken(), Array.from({ length: 45 }, (_, index) => `${index}번째 짧은 말이에요.`));
});

test('the daily limit holds while an answer is read: past it nothing more is asked for, and it is never passed', async t => {
  const h = await harness(t, { settings: { voice: { dailyDollars: 0.0075 } } });
  h.on();
  const { run } = await h.ask('길게');
  const before = h.voice.status().today.dollars;
  h.write(run, 'm1:0', `${'가'.repeat(20)}. `);
  await until(() => h.says().find(say => say.kind === 'answer'));
  h.write(run, 'm1:0', `${'나'.repeat(400)}. ${'다'.repeat(400)}.`, true);
  h.finish(run);
  await sleep(500);
  assert.ok(h.voice.status().today.dollars <= 0.0075 + 1e-9, `spent ${h.voice.status().today.dollars} from ${before}`);
  assert.ok(!h.spoken().some(text => text.includes('다'.repeat(50))));
  // Cut short by the limit: not called heard to its end, and the owner is told why.
  const done = await h.entry(/나{400}/);
  await until(() => h.speakOf(done)?.state === 'unspoken' || undefined);
  assert.deepEqual({ reason: h.speakOf(done)?.reason, heard: h.speakOf(done)?.heard }, { reason: 'limit', heard: true });
});

test('voice turned off while an answer is read stops it; nothing of that turn is read afterwards', async t => {
  const h = await harness(t, { page: { answer: () => undefined } });
  const session = h.on();
  const { run } = await h.ask('설명해 줘');
  h.write(run, 'm1:0', '설명을 시작할게요. ');
  await until(() => h.says().find(say => say.kind === 'answer'));
  h.voice.voiceOff({ session });
  h.write(run, 'm1:0', '이 뒤는 읽히지 않아요.', true);
  h.finish(run);
  const done = await h.entry(/이 뒤는/);
  await sleep(100);
  assert.deepEqual(h.spoken(), ['설명을 시작할게요.']);
  assert.equal(h.speakOf(done)?.reason, 'stopped', 'the owner turned it off');
  assert.equal(h.voice.status().missed, undefined, 'nothing to tell the owner');
  assert.equal(h.voice.busy(), false);
});

test('a first response ready only after the answer has begun is not said', async t => {
  const h = await harness(t);
  h.on();
  h.firsts.delayMs = 400;
  const asked = h.voice.voiceRequest({ session: h.current(), clientMessageId: randomUUID(), text: '상태 알려줘', local: true });
  const run = await until(() => h.runs.at(-1));
  h.write(run, 'm1:0', '지금 상태를 확인했어요. ');
  await until(() => h.says().find(say => say.kind === 'answer'));
  assert.deepEqual(await asked, {});
  h.finish(run);
});

test('the timing of the first response and the first sound is kept', async t => {
  const h = await harness(t);
  h.on();
  const { answer, run } = await h.ask('상태 알려줘');
  const key = answer.ack!.request!;
  assert.equal(answer.ack!.text, FIRST);
  h.write(run, 'm1:0', '지금 상태를 확인했어요. ');
  await until(() => h.says().find(say => say.kind === 'answer'));
  h.write(run, 'm1:0', '모두 정상이에요.', true);
  h.finish(run);
  const done = await h.entry(/정상이에요/);
  await until(() => h.speakOf(done)?.state === 'played');
  const record = await until(() => h.voice.timings.list().find(item => item.key === key && item.play !== undefined && item.end !== undefined));
  assert.equal(record.mode, 'stream');
  for (const field of ['request', 'ack', 'text', 'tts', 'audio', 'say', 'play', 'end'] as const) assert.equal(typeof record[field], 'number', field);
  assert.ok(record.request! <= record.text! && record.text! <= record.tts! && record.tts! <= record.audio! && record.audio! <= record.say!);
  await h.voice.timings.flush();
  const saved = JSON.parse(await readFile(join(h.dir, 'voice-timings.json'), 'utf8')) as { records: Array<{ key: string }> };
  assert.ok(saved.records.some(item => item.key === key));
});

test('a long streamed answer ends at the limit with a pointer to the screen', async t => {
  const h = await harness(t, { page: { delayMs: 5 } });
  h.on();
  const { run } = await h.ask('아주 길게');
  const sentence = `${'가'.repeat(95)}다. `;
  h.write(run, 'm1:0', sentence.repeat(60), true);
  await until(() => h.says().find(say => say.kind === 'answer'));
  h.finish(run);
  const done = await h.entry(/가{95}다/);
  await until(() => h.speakOf(done)?.state === 'played', 20_000);
  const heard = await until(() => { const all = h.spoken().join(' '); return all.endsWith(VOICE_REST) && all; });
  assert.ok(heard.length <= 5_000 + VOICE_REST.length + 60);
});

test('audio asked for again partway starts at a whole frame near that place', async t => {
  const h = await harness(t, { page: { answer: () => undefined } });
  const header = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
  const frame = Buffer.concat([header, Buffer.alloc(413, 7)]);
  h.labs.chunks = [Buffer.concat([frame, frame, frame]), Buffer.concat([frame, frame, frame, frame, frame, frame, frame, frame])];
  h.on();
  const { run } = await h.ask('들려줘');
  h.write(run, 'm1:0', '이어 듣기를 확인하는 답입니다.', true);
  const say = await until(() => h.says().find(item => item.kind === 'answer'));
  const id = say.audio.split('/').at(-1)!;
  const server = createServer((req, res) => { const url = new URL(req.url!, 'http://x'); void h.voice.serveAudio(url.pathname.slice(1), res, Number(url.searchParams.get('at') ?? 0)); });
  const port = await listen(server);
  t.after(() => stop(server));
  const get = (path: string) => new Promise<Buffer>(resolve => {
    const chunks: Buffer[] = [];
    httpRequest({ host: '127.0.0.1', port, path }, res => { res.on('data', chunk => chunks.push(chunk as Buffer)); res.on('end', () => resolve(Buffer.concat(chunks))); res.on('aborted', () => resolve(Buffer.concat(chunks))); }).end();
  });
  await sleep(200);
  h.finish(run);
  const whole = await get(`/${id}`);
  assert.equal(whole.length, 417 * 11);
  // 0.06 s is 960 bytes in: the third frame starts at 834, so the next whole one at 1251.
  const later = await get(`/${id}?at=0.06`);
  assert.equal(later.length, whole.length - 1251);
  assert.deepEqual(later.subarray(0, 4), header);
});

test('words that keep coming after the first ones went to speech are read too, from new state each time', async t => {
  const h = await harness(t);
  h.on();
  const { run } = await h.ask('천천히 말해 줘');
  h.write(run, 'm1:0', '첫 문장을 먼저 말씀드릴게요. ');
  await until(() => h.says().find(say => say.kind === 'answer'));
  await sleep(50);
  // Well after the turn's record was kept, more words come, in new objects each time.
  for (let index = 0; index < 3; index++) { await sleep(20); h.write(run, 'm1:0', `${index + 2}번째 문장을 이어서 말씀드려요, 조금 더 길게 써 볼게요. `); }
  await until(() => h.spoken().length >= 2 || undefined);
  h.write(run, 'm1:0', '끝.', true);
  await until(() => h.spoken().join(' ').endsWith('끝.') || undefined);
  assert.equal(h.spoken().join(' '), '첫 문장을 먼저 말씀드릴게요. 2번째 문장을 이어서 말씀드려요, 조금 더 길게 써 볼게요. 3번째 문장을 이어서 말씀드려요, 조금 더 길게 써 볼게요. 4번째 문장을 이어서 말씀드려요, 조금 더 길게 써 볼게요. 끝.');
});

test('a message steered into a turn being read that fails to arrive does not stop the turn\'s reading', async t => {
  const h = await harness(t, { page: { delayMs: 5 } });
  h.on();
  const { run } = await h.ask('첫 요청');
  h.write(run, 'm1:0', '첫 요청에 답하고 있어요. ');
  await until(() => h.says().find(say => say.kind === 'answer'));
  // A second request steered into the same turn; its delivery failed while the turn goes on.
  const second = await h.ask('덧붙인 요청');
  second.run.steering = { targetRunId: run.id, state: 'uncertain', requestedAt: new Date().toISOString() };
  second.run.status = 'error';
  second.run.finishedAt = new Date().toISOString();
  h.emit();
  await h.entry(/답하지 못했습니다/);
  assert.equal(h.voice.streaming(run.id), true, 'the turn is still being read');
  h.write(run, 'm1:0', '이어서 끝까지 말씀드려요.', true);
  h.finish(run);
  const done = await h.entry(/끝까지 말씀드려요/);
  await until(() => h.speakOf(done)?.state === 'played');
  await until(() => h.spoken().includes('이어서 끝까지 말씀드려요.') || undefined);
});

test('a turn being read goes on to its end even when the only request that followed it failed to arrive', async t => {
  const h = await harness(t, { page: { delayMs: 5 } });
  h.on();
  // The owner typed to the master (a turn nobody follows); then spoke, and that request was steered into it.
  const typed: Run = { id: 'typed', sessionId: MASTER, prompt: '글로 쓴 요청', status: 'running', createdAt: new Date().toISOString(), output: '', replies: [] };
  h.runs.push(typed);
  const spoken = await h.ask('말로 덧붙인 요청');
  spoken.run.steering = { targetRunId: typed.id, state: 'delivered', requestedAt: new Date().toISOString() };
  h.write(typed, 'm1:0', '두 요청에 함께 답하고 있어요. ');
  await until(() => h.says().find(say => say.kind === 'answer'));
  assert.equal(h.voice.streaming(typed.id), true);
  // The steered request's delivery turns out to have failed; the typed turn goes on.
  spoken.run.steering = { ...spoken.run.steering, state: 'uncertain' };
  spoken.run.status = 'error';
  spoken.run.finishedAt = new Date().toISOString();
  h.emit();
  await h.entry(/답하지 못했습니다/);
  h.write(typed, 'm1:0', '마지막 문장까지 읽혀요.', true);
  h.finish(typed);
  await until(() => h.spoken().includes('마지막 문장까지 읽혀요.') || undefined);
  await until(() => !h.voice.streaming(typed.id) || undefined);
  await until(() => !h.voice.busy() || undefined);
});

test('a turn that ended while its words still play keeps its entry, however often Tower\'s state changes meanwhile', async t => {
  const h = await harness(t, { page: { delayMs: 400 } });
  h.on();
  const { run } = await h.ask('끝난 뒤에도');
  h.write(run, 'm1:0', '이 답은 끝난 뒤에도 기록돼요.', true);
  await until(() => h.says().find(say => say.kind === 'answer'));
  h.finish(run);
  await until(() => h.session.activeTasks() >= 0 && !h.runs.some(item => item.status === 'running') || undefined);
  for (let index = 0; index < 5; index++) { await sleep(30); h.emit(); }
  const done = await h.entry(/끝난 뒤에도 기록돼요/);
  await until(() => h.speakOf(done)?.state === 'played');
  assert.equal((done.data as { kind: string }).kind, 'master');
});

// ─── answers not read aloud are told of, and can be heard again (#43) ───────────────────────────────────────────────

/** A turn as the master writes it: a short reply before a tool, then a final answer with a list and a table, in two pieces. */
const FINAL = '확인이 필요한 작업이 여럿 있어요.\n\n**Tower 설계**\n- 개발 원칙을 점검하는 세션이에요. 승인이 필요해요.\n- **playbook 배너:** 배포해도 되냐는 문의예요.\n\n| 작업 | 상태 |\n|---|---|\n| 리뷰 | 대기 |\n| 배포 | 끝남 |\n\n이 세션이 끝나면 알려 드릴게요.';
async function toolTurn(h: Awaited<ReturnType<typeof harness>>) {
  const { run, answer } = await h.ask('지금 내가 확인해야 할 작업 뭐 있어?');
  h.write(run, 'm1:0', '확인할 작업을 찾아볼게요.', true);
  await until(() => h.says().find(say => say.kind === 'answer'));
  h.write(run, 'm2:0', FINAL.slice(0, 60));
  await sleep(30);
  h.write(run, 'm2:0', FINAL.slice(60), true);
  h.finish(run);
  return { run, key: answer.ack!.request! };
}
const recordOf = (h: Awaited<ReturnType<typeof harness>>, key: string) => h.voice.timings.list().find(item => item.key === key);

test('a turn of several replies with a list and a table is read to its end while written, and each thing said is recorded', async t => {
  const h = await harness(t, { page: { delayMs: 5 } });
  h.on();
  const { key } = await toolTurn(h);
  const done = await h.entry(/확인이 필요한 작업이 여럿/);
  await until(() => h.speakOf(done)?.state === 'played' || h.speakOf(done)?.state === 'unspoken' || undefined);
  assert.equal(h.speakOf(done)?.state, 'played');
  assert.ok(h.spoken().join(' ').endsWith('이 세션이 끝나면 알려 드릴게요.'), 'read to its last sentence');
  assert.equal(h.voice.status().missed, undefined);
  const record = await until(() => recordOf(h, key)?.outcome);
  assert.deepEqual(record, { at: record.at, state: 'played' });
  assert.deepEqual(recordOf(h, key)!.says!.map(say => say.result), ['played', 'played'], 'each reply\'s audio, with the page\'s word on it');
});

test('a reply the page could not play ends the answer told of beside the voice, and it can be heard again whole', async t => {
  let count = 0;
  const h = await harness(t, { page: { delayMs: 5, answer: () => ++count === 2 ? 'failed' : 'played' } });
  h.on();
  const { key } = await toolTurn(h);
  const done = await h.entry(/확인이 필요한 작업이 여럿/);
  await until(() => h.speakOf(done)?.state === 'unspoken' || undefined);
  assert.deepEqual({ reason: h.speakOf(done)?.reason, heard: h.speakOf(done)?.heard }, { reason: 'failed', heard: true }, 'its first reply was heard');
  const missed = await until(() => h.voice.status().missed);
  assert.deepEqual({ entry: missed.entry, reason: missed.reason, heard: missed.heard }, { entry: done.id, reason: 'failed', heard: true });
  assert.match(missed.text, /^확인이 필요한 작업이 여럿/);
  assert.ok(h.events.some(event => event.type === 'voice' && event.voice.missed?.entry === done.id), 'pages are told');
  assert.deepEqual(recordOf(h, key)!.says!.map(say => say.result), ['played', 'failed']);
  assert.deepEqual({ ...recordOf(h, key)!.outcome, at: 0 }, { at: 0, state: 'unspoken', reason: 'failed', heard: true });
  // Heard again: read whole, once the owner asks.
  const before = h.says().length;
  assert.equal(h.voice.voiceMissed({ session: h.current(), entry: done.id, action: 'replay' }), true);
  assert.equal(h.voice.status().missed, undefined, 'no longer told of once asked for');
  await until(() => h.speakOf(done)?.state === 'played' || undefined);
  const again = h.says().slice(before);
  assert.equal(again.map(say => say.text).join(' '), h.spoken().slice(-again.length).join(' '), 'one finite playback per replay part');
  assert.ok(again.every(say => say.streaming === true));
  assert.equal(h.speakOf(done)?.reason, undefined, 'played: no reason left');
  assert.deepEqual(recordOf(h, key)!.says!.map(say => say.result), ['played', 'failed', ...again.map(() => 'played')]);
  assert.equal(recordOf(h, key)!.outcome!.state, 'played');
});

test('the browser refusing to play, a page gone or voice moved are told of; the owner\'s own stop is not', async t => {
  const blocked = await harness(t, { page: { answer: () => 'blocked' } });
  blocked.on();
  const { run } = await blocked.ask('목록 알려줘');
  blocked.write(run, 'm1:0', '목록을 알려 드릴게요. 둘이에요.', true);
  blocked.finish(run);
  const first = await blocked.entry(/목록을 알려/);
  await until(() => blocked.speakOf(first)?.state === 'unspoken' || undefined);
  assert.deepEqual({ reason: blocked.speakOf(first)?.reason, heard: blocked.speakOf(first)?.heard }, { reason: 'blocked', heard: undefined });
  assert.equal((await until(() => blocked.voice.status().missed)).reason, 'blocked');
  assert.equal(blocked.voice.voiceMissed({ session: blocked.current(), entry: first.id, action: 'dismiss' }), true);
  assert.equal(blocked.voice.status().missed, undefined, 'dismissed');

  const moved = await harness(t, { page: { answer: () => undefined } });
  moved.on();
  const second = await moved.ask('길게');
  moved.write(second.run, 'm1:0', '이 답을 읽는 중에 음성이 다른 탭으로 옮겨 가요.', true);
  await until(() => moved.says().find(say => say.kind === 'answer'));
  moved.finish(second.run);
  await sleep(50);
  moved.on();
  const away = await moved.entry(/다른 탭으로/);
  await until(() => moved.speakOf(away)?.state === 'unspoken' || undefined);
  assert.equal(moved.speakOf(away)?.reason, 'away');
  assert.deepEqual(recordOf(moved, second.answer.ack!.request!)!.says!.map(say => say.result), ['away'], 'what was playing ended with voice moving');
  assert.equal((await until(() => moved.voice.status().missed)).entry, away.id);

  const skipped = await harness(t, { page: { answer: () => 'stopped' } });
  skipped.on();
  const third = await skipped.ask('멈출 답');
  skipped.write(third.run, 'm1:0', '이 답은 주인이 멈춰요.', true);
  skipped.finish(third.run);
  const stopped = await skipped.entry(/주인이 멈춰요/);
  await until(() => skipped.speakOf(stopped)?.state === 'unspoken' || undefined);
  assert.equal(skipped.speakOf(stopped)?.reason, 'stopped');
  await until(() => recordOf(skipped, third.answer.ack!.request!)?.outcome);
  assert.equal(skipped.voice.status().missed, undefined, 'the owner stopped it: nothing to tell');
});

test('an answer with nothing to read is told of, and is not offered to hear again', async t => {
  const h = await harness(t, { page: { delayMs: 5 } });
  h.on();
  const { run } = await h.ask('선 하나만');
  h.write(run, 'm1:0', '---', true);
  h.finish(run);
  const done = await until(() => h.room.recent(200).find((item): item is MasterEntry => item.data.kind === 'master'));
  await until(() => h.speakOf(done)?.state === 'unspoken' || undefined);
  assert.equal(h.speakOf(done)?.reason, 'empty');
  assert.equal((await until(() => h.voice.status().missed)).reason, 'empty');
  assert.equal(h.voice.voiceMissed({ session: h.current(), entry: done.id, action: 'replay' }), false);
});

test('an answer kept shorter than it was ends, read aloud, saying the rest is on the screen', async t => {
  const h = await harness(t, { page: { delayMs: 5 } });
  h.on();
  const session = h.voice.status().session!;
  const entry = h.room.add({ kind: 'master', text: '앞부분만 남은 긴 답이에요.', turnId: 't', final: true, speak: { state: 'pending', session, cut: true } });
  await until(() => h.speakOf(entry)?.state === 'played' || undefined);
  await until(() => h.spoken().length >= 2 || undefined);
  assert.deepEqual(h.spoken(), ['앞부분만 남은 긴 답이에요.', VOICE_REST]);
});

test('a page that never tells how it went, or kept it waiting too long, ends the answer told of; voice the owner turned off does not', async t => {
  // MS_PER_CHAR (200 ms) a character is waited for on top of playMs: a short answer is given up on soon.
  const silent = await harness(t, { playMs: 50, page: { answer: () => undefined } });
  silent.on();
  const session = silent.voice.status().session!;
  const entry = silent.room.add({ kind: 'master', text: '네.', turnId: 't', final: true, speak: { state: 'pending', session } });
  await until(() => silent.speakOf(entry)?.state === 'unspoken' || undefined, 5_000);
  assert.equal(silent.speakOf(entry)?.reason, 'timeout');
  assert.equal((await until(() => silent.voice.status().missed)).reason, 'timeout');

  const late = await harness(t, { page: { answer: () => 'expired' } });
  late.on();
  const waited = late.room.add({ kind: 'master', text: '오래 기다린 답이에요.', turnId: 't', final: true, speak: { state: 'pending', session: late.voice.status().session! } });
  await until(() => late.speakOf(waited)?.state === 'unspoken' || undefined);
  assert.deepEqual({ reason: late.speakOf(waited)?.reason, heard: late.speakOf(waited)?.heard }, { reason: 'expired', heard: undefined });

  // Voice turned off by the owner before the answer came: not read, and nothing to tell when voice is on again.
  const off = await harness(t, { page: { delayMs: 5 } });
  const current = off.on();
  const { run } = await off.ask('끄기 전에 물은 것');
  off.voice.voiceOff({ session: current });
  off.write(run, 'm1:0', '음성이 꺼진 뒤에 온 답이에요.', true);
  off.finish(run);
  const quiet = await off.entry(/꺼진 뒤에 온 답/);
  assert.deepEqual({ state: off.speakOf(quiet)?.state, reason: off.speakOf(quiet)?.reason }, { state: 'unspoken', reason: 'stopped' });
  off.on();
  await sleep(30);
  assert.equal(off.voice.status().missed, undefined);
});

test('new text waits in distinct finite parts, and a cancelled turn promptly cancels its active part', async t => {
  const h = await harness(t, { page: { answer: () => undefined } });
  h.on();
  const { run } = await h.ask('스트리밍 경합 확인');
  h.write(run, 'm1:0', '첫 문장을 먼저 말씀드릴게요. ');
  const first = await until(() => h.says().find(say => say.kind === 'answer'));
  const rest = '두 번째 문장의 추가 설명입니다. '.repeat(10);
  h.write(run, 'm1:0', rest);
  await sleep(50);
  assert.equal(h.says().filter(say => say.kind === 'answer').length, 1, 'new text cannot replace or replay the active finite part');
  assert.equal(h.says().find(say => say.id === first.id)!.text, first.text);
  assert.equal(h.voice.voicePlayed({ session: h.current(), id: first.id, result: 'played' }), true);
  const next = await until(() => h.says().find(say => say.kind === 'answer' && say.id !== first.id));
  assert.ok(next.text.includes('두 번째'));
  assert.notEqual(next.audio, first.audio);
  h.finish(run, 'cancelled');
  await until(() => h.events.find(event => event.type === 'say' && event.say.id === next.id && event.say.cancelled));
  await until(() => !h.voice.streaming(run.id) || undefined);
  assert.equal(h.voice.voicePlayed({ session: h.current(), id: next.id, result: 'played' }), false);
  assert.equal(h.voice.streaming(run.id), false);
});

test('page media diagnostics keep only bounded playback state, never arbitrary payload', async () => {
  const { playbackRecord } = await import('../../server/master/voice-timings.js');
  assert.deepEqual(playbackRecord({ position: 12.5, muted: false, volume: 0.5, ready: 3, network: 2, context: 'running', text: 'private payload' }), { position: 12.5, muted: false, volume: 0.5, ready: 3, network: 2, context: 'running' });
  assert.equal(playbackRecord({ position: Infinity, muted: 'yes', volume: -1, ready: 100, network: 100, context: 'arbitrary payload' }), undefined);
});


test('live progress records receipt and real start before turn end without settling the say', async t => {
  const h = await harness(t, { page: { answer: () => undefined } });
  h.on();
  const { answer, run } = await h.ask('진행 진단');
  const key = answer.ack!.request!;
  h.write(run, 'm1:0', '첫 문장은 실행 중에 읽어요. ');
  const say = await until(() => h.says().find(item => item.kind === 'answer'));
  const send = (event: string, elapsedMs: number, playback?: unknown, session = h.current()) => h.voice.voiceProgress({ session, id: say.id, event, elapsedMs, playback });
  assert.equal(send('started', 1, { position: 0 }), false);
  assert.equal(send('received', NaN), false);
  assert.equal(send('received', 0, undefined, 'stale'), false);
  assert.equal(send('received', 0), true);
  assert.equal(send('source', 10), true);
  assert.equal(send('started', 25, { position: 0.03, text: 'private' }), true);
  assert.equal(send('waiting', 30, { position: 0.03 }), true);
  assert.equal(send('resumed', 40, { position: 0.04 }), true);
  assert.equal(send('progress', 5_000, { position: 1 }), true);
  const record = recordOf(h, key)!;
  const said = record.says!.find(item => item.id === say.id)!;
  assert.equal(record.end, undefined);
  assert.equal(record.outcome, undefined);
  assert.equal(said.result, undefined);
  assert.equal(said.started!.elapsedMs, 25);
  assert.equal(said.started!.at, record.started);
  assert.deepEqual(said.started!.playback, { position: 0.03 });
  assert.equal(said.waits, 1);
  assert.equal(said.latest!.event, 'progress');
  assert.equal(typeof record.sentence, 'number');
  assert.equal(record.runId, run.id);
  assert.equal(typeof record.pieces?.[0].firstByte, 'number');
  assert.equal(h.voice.streaming(run.id), true);
  h.write(run, 'm1:0', '남은 문장도 읽습니다.', true);
  h.finish(run);
  assert.equal(h.voice.voicePlayed({ session: h.current(), id: say.id, result: 'played' }), true);
  const residual = await until(() => h.says().find(item => item.kind === 'answer' && item.id !== say.id));
  assert.equal(h.voice.voicePlayed({ session: h.current(), id: residual.id, result: 'played' }), true);
  await until(() => recordOf(h, key)?.outcome);
  assert.equal(send('progress', 6_000, { position: 2 }), false);
});

test('timing traces bound TTS attempts and preserve first attempt, and snapshots are detached', async t => {
  const { VoiceTimings } = await import('../../server/master/voice-timings.js');
  const dir = await mkdtemp(join(tmpdir(), 'voice-trace-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const timings = new VoiceTimings(join(dir, 'trace.json'));
  timings.mark('key', 'request', 1);
  for (let part = 0; part < 100; part++) timings.piece('key', { live: 'live', part, attempt: 0, start: part, bytes: 1, result: 'done' });
  const record = timings.list()[0];
  assert.equal(record.pieces!.length, 40);
  assert.equal(record.pieces![0].part, 0);
  assert.equal(record.pieces!.at(-1)!.part, 99);
  record.pieces![0].bytes = 999;
  assert.equal(timings.list()[0].pieces![0].bytes, 1);
  await timings.flush();
});


test('actual host socket and web relay correlate writes, EOF and late transport after terminal ACK', async t => {
  const h = await harness(t, { page: { answer: () => undefined } });
  h.on();
  const { answer, run } = await h.ask('전달 단계 확인');
  const key = answer.ack!.request!;
  h.write(run, 'm1:0', '아직 실행 중인 첫 문장을 읽습니다. ');
  const say = await until(() => h.says().find(item => item.kind === 'answer'));
  const live = say.audio.split('/').at(-1)!;
  const serve = MasterVoice.prototype.serveAudio;
  const transport = MasterVoice.prototype.voiceTransport;
  t.mock.method(MasterVoice.prototype, 'serveAudio', (...args: Parameters<typeof serve>) => serve.call(h.voice, ...args));
  t.mock.method(MasterVoice.prototype, 'voiceTransport', (...args: Parameters<typeof transport>) => transport.call(h.voice, ...args));
  const dir = await mkdtemp(join(tmpdir(), 'voice-stage-host-'));
  const host = await startMasterHost({ stateDir: dir, idleMs: 60_000 });
  const client = new MasterClient({ stateDir: dir, credentials: () => undefined });
  const relay = createServer((_req, res) => { void client.pipeAudio(res, live); });
  const port = await listen(relay);
  t.after(async () => { await stop(relay); client.dispose(); await host.close(); await rm(dir, { recursive: true, force: true }); });
  const response = await fetch(`http://127.0.0.1:${port}/`);
  const reader = response.body!.getReader();
  const initial = await reader.read();
  assert.ok(initial.value!.length > 0);
  const request = await until(() => recordOf(h, key)?.audioRequests?.find(item => item.web?.firstWrite));
  assert.equal(request.live, live);
  assert.equal(recordOf(h, key)!.says!.find(item => item.id === say.id)!.live, live);
  assert.equal(request.host!.normal, true, 'finite file EOF is independent of native run completion');
  assert.equal(recordOf(h, key)!.outcome, undefined);
  h.write(run, 'm1:0', '이제 마지막 내용을 읽습니다.', true);
  h.finish(run);
  let bytes = initial.value!.length;
  for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; }
  assert.equal(h.voice.voicePlayed({ session: h.current(), id: say.id, result: 'played', elapsedMs: 1000, attempt: 0 }), true);
  const ended = await until(() => recordOf(h, key)?.audioRequests?.find(item => item.requestId === request.requestId && item.web?.close && item.host?.close));
  assert.equal(ended.host!.normal, true);
  assert.equal(ended.web!.normal, true);
  assert.equal(ended.host!.bytes, bytes);
  assert.equal(ended.web!.bytes, bytes);
  assert.ok(ended.host!.firstWrite! <= ended.host!.end!);
  assert.ok(ended.web!.firstWrite! <= ended.web!.end!);
  assert.equal(h.voice.voiceTransport({ live, requestId: randomUUID(), web: { request: 1, bytes: 1 } }), false);
  assert.equal(h.voice.voiceTransport({ live, requestId: ended.requestId, web: { request: ended.web!.request, bytes, close: Date.now(), normal: true } }), true);
});

test('two socket readers stay distinct and a truncated relay never settles playback', async t => {
  const h = await harness(t, { page: { answer: () => undefined } });
  h.on();
  const { answer, run } = await h.ask('전달 중 연결 종료 확인');
  const key = answer.ack!.request!;
  h.labs.chunks = [Buffer.alloc(1_000_000, 1), Buffer.alloc(1_000_000, 2)];
  h.write(run, 'm1:0', '열린 실행의 첫 문장을 읽습니다. ');
  const say = await until(() => h.says().find(item => item.kind === 'answer'));
  const live = say.audio.split('/').at(-1)!;
  const serve = MasterVoice.prototype.serveAudio;
  const transport = MasterVoice.prototype.voiceTransport;
  // Keep real writes and sockets, but hold drain acknowledgement until the fixture releases it.
  // This makes close-before-end deterministic without exceeding the production audio size cap.
  let releaseDrain = false;
  const gated: Parameters<typeof serve>[1][] = [];
  t.mock.method(MasterVoice.prototype, 'serveAudio', (...args: Parameters<typeof serve>) => {
    const response = args[1];
    gated.push(response);
    const emit = response.emit;
    t.mock.method(response, 'emit', (...event: Parameters<typeof emit>) => event[0] === 'drain' && !releaseDrain ? false : emit.apply(response, event));
    return serve.call(h.voice, ...args);
  });
  t.mock.method(MasterVoice.prototype, 'voiceTransport', (...args: Parameters<typeof transport>) => transport.call(h.voice, ...args));
  const dir = await mkdtemp(join(tmpdir(), 'voice-stage-cut-'));
  const host = await startMasterHost({ stateDir: dir, idleMs: 60_000 });
  const client = new MasterClient({ stateDir: dir, credentials: () => undefined });
  const relay = createServer((_req, res) => { void client.pipeAudio(res, live); });
  const port = await listen(relay);
  t.after(async () => { await stop(relay); client.dispose(); await host.close(); await rm(dir, { recursive: true, force: true }); });
  const first = await fetch(`http://127.0.0.1:${port}/`);
  const firstReader = first.body!.getReader();
  assert.ok((await firstReader.read()).value!.length > 0);
  const firstRequest = await until(() => recordOf(h, key)?.audioRequests?.find(item => item.web?.firstWrite));
  const second = await fetch(`http://127.0.0.1:${port}/`);
  const secondReader = second.body!.getReader();
  const secondChunk = await secondReader.read();
  assert.ok(secondChunk.value!.length > 0);
  const secondRequest = await until(() => recordOf(h, key)?.audioRequests?.find(item => item.requestId !== firstRequest.requestId && item.web?.firstWrite));
  assert.notEqual(firstRequest.requestId, secondRequest.requestId);
  assert.equal(firstRequest.live, secondRequest.live);
  await firstReader.cancel();
  const cut = await until(() => recordOf(h, key)?.audioRequests?.find(item => item.requestId === firstRequest.requestId && item.host?.close && item.web?.close));
  assert.equal(cut.host!.normal, false);
  assert.equal(cut.web!.normal, false);
  assert.equal(cut.host!.end, undefined);
  assert.equal(cut.web!.end, undefined);
  assert.ok(cut.host!.bytes > 0 && cut.web!.bytes > 0);
  assert.equal(recordOf(h, key)!.outcome, undefined);
  assert.equal(recordOf(h, key)!.says!.find(item => item.id === say.id)!.result, undefined);
  assert.equal(h.voice.voiceTransport({ live, requestId: cut.requestId, web: { ...cut.web!, close: Date.now() } }), true);
  assert.equal(recordOf(h, key)!.outcome, undefined, 'late transport remains diagnostic');
  assert.equal(recordOf(h, key)!.audioRequests!.find(item => item.requestId === secondRequest.requestId)!.host!.close, undefined);
  releaseDrain = true;
  for (const response of gated) if (!response.destroyed) response.emit('drain');
  h.write(run, 'm1:0', '', true);
  h.finish(run);
  while (!(await secondReader.read()).done) { /* Drain the remaining finite fixture audio. */ }
  const complete = await until(() => recordOf(h, key)?.audioRequests?.find(item => item.requestId === secondRequest.requestId && item.host?.end && item.web?.end));
  assert.equal(complete.host!.normal, true);
  assert.equal(complete.web!.normal, true);
  assert.equal(recordOf(h, key)!.outcome, undefined, 'even EOF does not settle a say');
  assert.equal(h.voice.voicePlayed({ session: h.current(), id: say.id, result: 'played', elapsedMs: 2000, attempt: 1 }), true);
  await until(() => recordOf(h, key)?.outcome);
  assert.equal(h.voice.voiceProgress({ session: h.current(), id: say.id, event: 'progress', elapsedMs: 3000 }), false);
  assert.equal(h.voice.voiceTransport({ live, requestId: cut.requestId, web: { ...cut.web!, close: Date.now() } }), true);
  assert.equal(recordOf(h, key)!.outcome!.state, 'played');
});


const finiteGet = (port: number, id: string, at = 0) => new Promise<{ data: Buffer; length: string | undefined }>((resolve, reject) => {
  const chunks: Buffer[] = [];
  const request = httpRequest({ host: '127.0.0.1', port, path: `/${id}${at ? `?at=${at}` : ''}`, headers: { range: 'bytes=0-1' } }, res => {
    res.on('data', chunk => chunks.push(chunk as Buffer));
    res.on('end', () => resolve({ data: Buffer.concat(chunks), length: res.headers['content-length'] }));
    res.on('aborted', () => reject(new Error('fixture audio aborted')));
  });
  request.on('error', reject);
  request.end();
});

test('finite audio is complete before say, has exact length and plays a part before run end', async t => {
  const h = await harness(t, { page: { answer: () => undefined } });
  h.on();
  const { answer, run } = await h.ask('유한 파일 첫 재생');
  await until(() => h.labs.completed.length >= 1 || undefined);
  h.labs.gapMs = 200;
  const frame = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(413, 7)]);
  h.labs.chunks = [Buffer.concat([frame, frame, frame]), Buffer.concat(Array<Buffer>(8).fill(frame))];
  h.write(run, 'm1:0', '첫 문장을 실행 중에 읽습니다. ');
  const say = await until(() => h.says().find(item => item.kind === 'answer'));
  assert.ok(h.labs.completed.some(item => item.speech === 2), 'one TTS part must finish before its say is emitted');
  assert.equal(run.status, 'running');
  const id = say.audio.split('/').at(-1)!;
  const relay = createServer((req, res) => { const url = new URL(req.url!, 'http://fixture'); void h.voice.serveAudio(url.pathname.slice(1), res, Number(url.searchParams.get('at') ?? 0)); });
  const port = await listen(relay);
  t.after(() => stop(relay));
  const whole = await finiteGet(port, id);
  assert.equal(whole.data.length, 417 * 11);
  assert.equal(Number(whole.length), whole.data.length);
  const sliced = await finiteGet(port, id, 0.06);
  assert.equal(sliced.data.length, whole.data.length - 1251);
  assert.equal(Number(sliced.length), sliced.data.length);
  assert.deepEqual(sliced.data.subarray(0, 4), frame.subarray(0, 4));
  assert.equal(h.voice.voicePlayed({ session: h.current(), id: say.id, result: 'played' }), true);
  const key = answer.ack!.request!;
  await until(() => recordOf(h, key)?.says?.some(item => item.id === say.id && item.result === 'played') || undefined);
  assert.equal(run.status, 'running', 'finite part ACK does not wait for native run end');
  assert.equal(recordOf(h, key)!.outcome, undefined, 'part ACK does not finish an open turn');
  h.finish(run);
});

test('finite parts keep reply order and final residual once, with no synthesis past the current ACK', async t => {
  const h = await harness(t, { page: { answer: () => undefined } });
  h.on();
  const { run } = await h.ask('유한 부분 순서');
  await until(() => h.labs.completed.length >= 1 || undefined);
  h.labs.gapMs = 30;
  const firstReply = `${'첫 부분의 내용을 정확히 읽습니다. '.repeat(30)}`;
  h.write(run, 'm1:0', firstReply, true);
  const first = await until(() => h.says().find(item => item.kind === 'answer'));
  h.write(run, 'm2:0', '도구 뒤 답을 이어서 읽습니다. ');
  await sleep(80);
  assert.equal(h.spoken().length, 1, 'only the current part is synthesized before its terminal ACK');
  const heard: string[] = [];
  const acknowledge = async (say: MasterSay) => {
    heard.push(say.id);
    assert.equal(h.voice.voicePlayed({ session: h.current(), id: say.id, result: 'played' }), true);
    assert.equal(h.voice.voicePlayed({ session: h.current(), id: say.id, result: 'played' }), false, 'duplicate part ACK is rejected');
  };
  await acknowledge(first);
  const second = await until(() => h.says().find(item => item.kind === 'answer' && !heard.includes(item.id)));
  await acknowledge(second);
  h.write(run, 'm2:0', '마지막 미완성 잔여', false);
  h.finish(run);
  const deadline = Date.now() + 5_000;
  for (;;) {
    assert.ok(Date.now() < deadline, 'all finite parts finish within the fixture deadline');
    const next = h.says().find(item => item.kind === 'answer' && !heard.includes(item.id));
    if (next) { await acknowledge(next); continue; }
    if (!h.voice.streaming(run.id)) break;
    await sleep(20);
  }
  const done = await h.entry(/마지막 미완성 잔여/);
  assert.equal(h.speakOf(done)?.state, 'played');
  assert.equal(h.spoken().join(' ').replace(/\s+/g, ' ').trim(), `${firstReply} 도구 뒤 답을 이어서 읽습니다. 마지막 미완성 잔여.`.replace(/\s+/g, ' ').trim());
  assert.equal(new Set(h.says().filter(item => item.kind === 'answer').map(item => item.audio)).size, heard.length, 'each completed part owns a distinct finite audio id');
});

test('finite synthesis cancelled before completion never publishes that partial audio', async t => {
  const h = await harness(t, { page: { answer: () => undefined } });
  h.on();
  const { run } = await h.ask('부분 합성 취소');
  await until(() => h.labs.completed.length >= 1 || undefined);
  h.labs.gapMs = 300;
  h.write(run, 'm1:0', '합성 중인 첫 문장은 끝나기 전에 취소합니다. ');
  await until(() => h.spoken().length === 1 || undefined);
  await sleep(30);
  assert.equal(h.says().filter(item => item.kind === 'answer').length, 0, 'partial TTS bytes cannot be advertised as a finite file');
  h.finish(run, 'cancelled');
  await sleep(350);
  assert.equal(h.says().filter(item => item.kind === 'answer' && item.text.includes('합성 중인 첫 문장')).length, 0);
  assert.equal(h.spoken().filter(text => text.includes('합성 중인 첫 문장')).length, 1);
});

test('finite replay uses complete parts and settles the entry only after their ACKs', async t => {
  const h = await harness(t, { page: { answer: () => undefined } });
  h.on();
  const text = '다시 들을 문장의 내용을 순서대로 읽습니다. '.repeat(25).trim();
  const entry = h.room.add({ kind: 'master', text, turnId: 'replay-fixture', final: true, speak: { state: 'played', session: h.voice.status().session! } });
  assert.equal(h.voice.voiceMissed({ session: h.current(), entry: entry.id, action: 'replay' }), true);
  const first = await until(() => h.says().find(item => item.kind === 'answer'));
  const relay = createServer((req, res) => { void h.voice.serveAudio(req.url!.slice(1), res); });
  const port = await listen(relay);
  t.after(() => stop(relay));
  const acked = new Set<string>();
  let current = first;
  const deadline = Date.now() + 5_000;
  for (;;) {
    const response = await finiteGet(port, current.audio.split('/').at(-1)!);
    assert.equal(Number(response.length), response.data.length, 'every replay part has an exact finite response length');
    assert.ok(['pending', 'playing'].includes(h.speakOf(entry)?.state ?? ''), 'entry is not settled before this part ACK');
    acked.add(current.id);
    assert.equal(h.voice.voicePlayed({ session: h.current(), id: current.id, result: 'played' }), true);
    await sleep(30);
    if (h.speakOf(entry)?.state === 'played') break;
    assert.ok(Date.now() < deadline, 'replay completes within the fixture deadline');
    current = await until(() => h.says().find(item => item.kind === 'answer' && !acked.has(item.id)));
  }
  assert.ok(acked.size >= 2, 'a long replay is several independently acknowledged files');
  assert.equal(h.spoken().join(' ').replace(/\s+/g, ' ').trim(), text);
  assert.equal(h.room.recent(200).filter(item => item.id === entry.id).length, 1, 'replay updates one entry');
});


test('finite parts hold their segment line so another entry cannot interrupt them', async t => {
  const h = await harness(t, { page: { answer: () => undefined } });
  h.on();
  const { run } = await h.ask('낭독 사이 끼어들기 방지');
  await until(() => h.labs.completed.length >= 1 || undefined);
  h.write(run, 'm1:0', '같은 답변의 문장들을 끊김 없이 순서대로 읽습니다. '.repeat(24), true);
  const first = await until(() => h.says().find(item => item.kind === 'answer'));
  h.room.add({ kind: 'event', text: '다른 보고는 답변의 부분 사이에 들어가지 않습니다.', speak: { state: 'pending' } });
  assert.equal(h.voice.voicePlayed({ session: h.current(), id: first.id, result: 'played' }), true);
  const next = await until(() => h.says().find(item => item.id !== first.id && (item.kind === 'answer' || item.kind === 'report')));
  assert.equal(next.kind, 'answer', 'global line stays with the current reply segment until all its parts are played');
  assert.ok(next.text.includes('같은 답변'), 'next audio is the rest of the same reply, not the queued report');
  h.finish(run, 'cancelled');
});

for (const example of [
  { model: 'eleven_flash_v2_5', text: '[cheerfully] 본문에 적힌 문자열을 그대로 보여 줍니다.', speech: '[cheerfully] 본문에 적힌 문자열을 그대로 보여 줍니다.' },
  { model: 'eleven_v3_conversational', text: '[WIP] 본문의 괄호를 그대로 보여 줍니다.', speech: '[cheerfully] (WIP) 본문의 괄호를 그대로 보여 줍니다.' },
]) {
  for (const mode of ['stream', 'replay'] as const) test(`finite ${mode} preserves original display text for ${example.model}`, async t => {
    const h = await harness(t, { settings: { voice: { model: example.model } }, page: { answer: () => undefined } });
    h.on();
    if (mode === 'stream') {
      const { run } = await h.ask('표시 원문 확인');
      h.write(run, 'm1:0', `${example.text} `, true);
      h.finish(run);
    } else {
      const entry = h.room.add({ kind: 'master', text: example.text, turnId: 'literal-replay', final: true, speak: { state: 'played', session: h.voice.status().session! } });
      assert.equal(h.voice.voiceMissed({ session: h.current(), entry: entry.id, action: 'replay' }), true);
    }
    const say = await until(() => h.says().find(item => item.kind === 'answer'));
    assert.equal(h.labs.speeches.at(-1), example.speech, 'speech retains existing tag and bracket behavior');
    assert.equal(say.text, example.text, 'page retains original readable text, independently of speech tags');
    assert.equal(h.voice.voicePlayed({ session: h.current(), id: say.id, result: 'played' }), true);
  });
}

for (const stop of ['native-cancel', 'voice-off'] as const) test(`a future-text waiter wakes on ${stop} after the active part ACK`, async t => {
  const h = await harness(t, { page: { answer: () => undefined } });
  h.on();
  const { run } = await h.ask('대기 중 취소 확인');
  h.write(run, 'm1:0', '첫 부분을 끝까지 읽고 새 문장을 기다립니다. ');
  const first = await until(() => h.says().find(item => item.kind === 'answer'));
  assert.equal(h.voice.voicePlayed({ session: h.current(), id: first.id, result: 'played' }), true);
  await sleep(30);
  assert.equal(h.voice.streaming(run.id), true, 'ACK leaves the native turn open, waiting for future text');
  h.room.add({ kind: 'event', text: '취소 뒤 대기열의 보고가 재개됩니다.', speak: { state: 'pending' } });
  await sleep(30);
  assert.equal(h.says().filter(item => item.kind === 'report').length, 0, 'the reply still owns the line');
  const before = h.labs.speeches.filter(text => text.includes('첫 부분')).length;
  if (stop === 'native-cancel') h.finish(run, 'cancelled');
  else assert.equal(h.voice.voiceOff({ session: h.current() }), true);
  await until(() => !h.voice.streaming(run.id) || undefined, 500);
  if (stop === 'voice-off') {
    assert.equal(h.voice.status().session, undefined);
    await until(() => !h.voice.busy() || undefined, 500);
    assert.equal(h.says().filter(item => item.kind === 'report').length, 0, 'voice off ends all playback');
    assert.ok(!h.labs.speeches.some(text => text.includes('취소 뒤 대기열')), 'old queued report is not synthesized');
    h.on();
    h.room.add({ kind: 'event', text: '새 음성 세션의 보고를 즉시 읽습니다.', speak: { state: 'pending' } });
  }
  const report = await until(() => h.says().find(item => item.kind === 'report'), 1_000);
  if (stop === 'voice-off') assert.equal(report.text, '새 음성 세션의 보고를 즉시 읽습니다.', 'new session proves the old line waiter released');
  assert.equal(h.voice.voicePlayed({ session: h.current(), id: first.id, result: 'played' }), false, 'old ACK stays settled');
  h.write(run, 'm1:0', '취소 이후의 문장은 합성되지 않습니다.', true);
  h.finish(run, 'cancelled');
  await sleep(50);
  assert.equal(h.labs.speeches.filter(text => text.includes('첫 부분')).length, before);
  assert.ok(!h.labs.speeches.some(text => text.includes('취소 이후')));
  if (report) assert.equal(h.voice.voicePlayed({ session: h.current(), id: report.id, result: 'played' }), true);
});

test('future text owns the line for at most five minutes while presence remains alive', async t => {
  const h = await harness(t, { page: { answer: () => undefined } });
  h.on();
  const { run } = await h.ask('대기 상한 확인');
  h.write(run, 'm1:0', '첫 부분 뒤 미래 문장을 기다립니다. ');
  const first = await until(() => h.says().find(item => item.kind === 'answer'));
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  t.after(() => t.mock.timers.reset());
  assert.equal(h.voice.voicePlayed({ session: h.current(), id: first.id, result: 'played' }), true);
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
  h.room.add({ kind: 'event', text: '상한 뒤에만 이 보고를 읽습니다.', speak: { state: 'pending' } });
  for (let step = 0; step < 10; step++) {
    const advance = step === 9 ? 29_999 : 30_000;
    t.mock.timers.tick(advance);
    assert.equal(h.voice.voicePresence({ session: h.current(), listening: true }), true);
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
  }
  assert.ok(!h.labs.speeches.some(text => text.includes('상한 뒤')));
  assert.equal(h.says().filter(item => item.kind === 'report').length, 0, '299999ms still holds the report');
  t.mock.timers.tick(1);
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
  t.mock.timers.reset();
  const report = await until(() => h.says().find(item => item.kind === 'report'), 1_000);
  assert.equal(run.status, 'running', 'the bound does not end the native run');
  assert.equal(h.voice.voicePlayed({ session: h.current(), id: report.id, result: 'played' }), true);
  h.finish(run);
});


test('paired voice parts keep original brackets, existing speech partitions and bounded final remainder', () => {
  const original = '[cheerfully] 첫 문자열입니다. [WIP.] 다음 괄호도 본문입니다. '.repeat(125).trim();
  for (const model of ['eleven_flash_v2_5', 'eleven_v3_conversational']) {
    const pairs = voicedPartPairs(original, model, 'answer');
    assert.deepEqual(pairs.map(part => part.speech), voicedParts(original, model, 'answer'));
    assert.ok(pairs.every(part => part.text.includes('[') || part.text === VOICE_REST));
    assert.ok(pairs.at(-1)!.text.endsWith(VOICE_REST));
    const chunk = original.slice(0, 950);
    const tag = streamTone(chunk, model, 'answer');
    const chunks = voicedChunkPairs(chunk, model, tag);
    assert.deepEqual(chunks.map(part => part.speech), voicedChunk(chunk, model, tag));
    assert.equal(chunks.map(part => part.text).join(' '), chunk.trim());
    assert.ok(chunks.every(part => part.text.length <= 500));
    for (const part of chunks) {
      const expected = model === 'eleven_flash_v2_5' ? part.text : part.text.replaceAll('[', '(').replaceAll(']', ')');
      assert.equal(part.speech, tag ? `${tag} ${expected}` : expected);
    }
  }
});
