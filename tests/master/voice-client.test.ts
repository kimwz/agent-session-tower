import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { MasterSay } from '../../shared/master.js';

/**
 * The page's voice session in a fake browser: a fake clock, microphone, speaker, ElevenLabs connection and master.
 * Races the normal flow in a real browser never shows: connections slow to close, a page that stalls and then handles
 * the microphone in a burst, notices cancelled one after another, and a browser that will not play by itself.
 */

class FakeSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  onclose?: () => void;
  private readonly closeListeners: Array<() => void> = [];
  constructor(readonly url: string) { FakeSocket.all.push(this); }
  /** Answers each commit as ElevenLabs does (see `write`), instead of the test answering the last one itself. */
  autoCommit = false;
  private said = '';
  private committedLength = 0;
  send(message: string): void {
    assert.equal(this.readyState, 1, 'sent only while open');
    this.sent.push(message);
    if (this.autoCommit && JSON.parse(message).commit === true) queueMicrotask(() => this.commitSaid());
  }
  /** ElevenLabs writes down `said` (all said so far): its partial writing covers only what came after the last commit. */
  write(said: string): void { this.said = said; this.message({ message_type: 'partial_transcript', text: said.slice(this.committedLength).trim() }); }
  /** ElevenLabs commits what it wrote since the last commit, as it also does by itself after about 36 seconds. */
  commitSaid(): void { const text = this.said.slice(this.committedLength).trim(); this.committedLength = this.said.length; this.message({ message_type: 'committed_transcript', text }); }
  /** Only asks: the connection closes when the test says so, as a slow upload would. */
  close(): void { if (this.readyState < 2) this.readyState = 2; }
  addEventListener(type: string, listener: () => void): void { if (type === 'close') this.closeListeners.push(listener); }
  open(): void { this.readyState = 1; this.onopen?.(); }
  message(body: object): void { this.onmessage?.({ data: JSON.stringify(body) }); }
  closed(): void { this.readyState = 3; this.onclose?.(); for (const listener of this.closeListeners) listener(); }
  /** Seconds of audio actually sent. */
  seconds(): number {
    return this.sent.reduce((sum, message) => sum + Buffer.from(JSON.parse(message).audio_base_64, 'base64').length, 0) / 32_000;
  }
}

class FakeAudio {
  static all: FakeAudio[] = [];
  static refuse = false;
  /** Holds the unlocking silence's play() until the test lets it finish. */
  static slowSilence?: () => void;
  src = '';
  preload = '';
  played: string[] = [];
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { FakeAudio.all.push(this); }
  paused: string[] = [];
  play(): Promise<void> {
    if (FakeAudio.refuse && this.src !== '/master-silence.wav') return Promise.reject(new DOMException('Autoplay refused', 'NotAllowedError'));
    this.played.push(this.src);
    if (this.src === '/master-silence.wav' && FakeAudio.slow) return new Promise(resolve => { FakeAudio.slowSilence = resolve; });
    return Promise.resolve();
  }
  static slow = false;
  pause(): void { this.paused.push(this.src); }
  removeAttribute(): void { this.src = ''; }
}

interface Frame { samples: Float32Array; time: number }

class FakeNode {
  static last?: FakeNode;
  port = { onmessage: null as ((event: { data: Frame }) => void) | null, close() {} };
  constructor() { FakeNode.last = this; }
  disconnect(): void {}
}

/** The audio's own clock (`currentTime`) moves only as the microphone is captured, whatever the page's clock does. */
class FakeContext {
  static last?: FakeContext;
  static rate = 16_000;
  sampleRate = FakeContext.rate;
  currentTime = 0;
  constructor() { FakeContext.last = this; }
  audioWorklet = { addModule: async () => {} };
  resume = async () => {};
  close = async () => {};
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
}

const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
let requestAnswer: unknown = {};
let tokens = 0;
/** How many token requests fail next (the web restarting, say). */
let tokenFailures = 0;
/** How the web judges a pause (Jev in real life): by default, finished. */
let turnEnd: (body: { text: string; pauseMs: number }) => unknown = () => ({ finished: 0.9 });

Object.assign(globalThis, {
  window: { isSecureContext: true, navigator: globalThis.navigator, dispatchEvent() {} },
  WebSocket: FakeSocket,
  Audio: FakeAudio,
  AudioContext: FakeContext,
  AudioWorkletNode: FakeNode,
  fetch: async (path: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    posts.push({ path, body });
    if (path.endsWith('/token') && tokenFailures > 0) { tokenFailures--; return { ok: false, status: 503, json: async () => ({ error: 'restarting' }) }; }
    const reply = path.endsWith('/on') ? { session: 'session-1' }
      : path.endsWith('/token') ? { tokenId: `token-${++tokens}`, url: 'wss://stt.test', expiresAt: Date.now() + 900_000 }
      : path.endsWith('/request') ? requestAnswer
      : path.endsWith('/finished') ? await turnEnd(body as { text: string; pauseMs: number }) : true;
    return { ok: true, status: 200, json: async () => reply };
  },
});
Object.defineProperty(globalThis.navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ readyState: 'live', stop() {} }] }) } });

const { VoiceSession } = await import('../../client/src/master/voice-client.js');
const { digest } = await import('../../client/src/master/voice-sound.js');
type View = import('../../client/src/master/voice-client.js').VoiceView;

const flush = async () => { for (let round = 0; round < 5; round++) await new Promise(resolve => setImmediate(resolve)); };

/** A fake page; `frame` samples at `rate` a microphone frame (a real worklet: 128 at 44.1 or 48 kHz). */
async function harness({ rate = 16_000, frame = 160, failTokens = 0 } = {}) {
  FakeSocket.all = [];
  FakeAudio.all = [];
  FakeAudio.refuse = false;
  FakeAudio.slow = false;
  FakeContext.rate = rate;
  posts.length = 0;
  requestAnswer = {};
  turnEnd = () => ({ finished: 0.9 });
  tokenFailures = failTokens;
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  let view: View | undefined;
  const voice = new VoiceSession({
    token: () => 'page-token', tabId: 'tab-1', viewContext: () => undefined,
    settings: () => ({ voiceId: 'v', model: 'eleven_v3_conversational', endSilenceMs: 1_000, listenMinutes: 5, readReports: true, dailyDollars: 0 }),
    onView: next => { view = next; }, onEnded: () => {},
  });
  await voice.start();
  await flush();
  const session = await digest('session-1');
  const audio = FakeAudio.all[0];
  const context = FakeContext.last!;
  /** The microphone captured at a loudness for a while, frame by frame (the audio's clock goes with it). */
  let captured = 0;
  const frames = (rms: number, ms: number): Frame[] => {
    const list: Frame[] = [];
    for (const end = captured + Math.round(ms / 1000 * rate); captured < end; captured += frame) {
      list.push({ samples: new Float32Array(frame).fill(rms), time: context.currentTime });
      context.currentTime = (captured + frame) / rate;
    }
    return list;
  };
  /** Frames handed to the page: as they come (the page's clock going with them), or all at once after a stall. */
  let owed = 0;
  const deliver = (list: Frame[], burst = false) => {
    for (const item of list) {
      FakeNode.last!.port.onmessage?.({ data: item });
      if (burst) continue;
      owed += frame / rate * 1000;
      const whole = Math.floor(owed);
      if (whole) { mock.timers.tick(whole); owed -= whole; }
    }
  };
  const hear = async (rms: number, ms: number) => { deliver(frames(rms, ms)); await flush(); };
  /** The same, in 50 ms steps with the page answering in between (as a real page would, while judgments come back). */
  const hearSlowly = async (rms: number, ms: number) => { for (let left = ms; left > 0; left -= 50) { deliver(frames(rms, Math.min(50, left))); await flush(); } };
  const say = (id: string, kind: MasterSay['kind']): MasterSay => ({ id, session, kind, text: `${kind} ${id}`, audio: `/api/master/voice/audio/${id}`, expiresAt: Date.now() + 600_000 });
  const results = () => posts.filter(post => post.path.endsWith('/played')).map(post => `${post.body.id}:${post.body.result}`);
  /** The owner says something; ElevenLabs writes it down; the connection is asked to close. */
  const speak = async (text: string) => {
    await hear(0.002, 200);
    await hear(0.1, 400);
    const socket = FakeSocket.all.at(-1)!;
    socket.open();
    socket.message({ message_type: 'partial_transcript', text });
    await hearSlowly(0.002, 1_500);
    socket.message({ message_type: 'committed_transcript', text });
    await flush();
    return socket;
  };
  const usages = () => posts.filter(post => post.path.endsWith('/usage')).map(post => post.body.seconds);
  return { voice, audio, frames, deliver, hear, hearSlowly, say, results, usages, speak, view: () => view!, end: () => { voice.stop(); mock.timers.reset(); } };
}

test('nothing plays until an utterance\'s connection has really closed (or ten seconds passed), and only what was sent is paid', async () => {
  const page = await harness();
  try {
    page.voice.say(page.say('early', 'answer'));
    // What waited began playing at once, before anything was said.
    assert.deepEqual(page.audio.played.slice(1), ['/api/master/voice/audio/early']);
    page.audio.onended!();
    mock.timers.tick(400);
    requestAnswer = { ack: page.say('ack-1', 'ack') };
    const first = await page.speak('첫 번째 요청');
    assert.equal(first.readyState, 2, 'closing, with audio still to send');
    assert.ok(posts.some(post => post.path.endsWith('/request') && post.body.text === '첫 번째 요청'));
    assert.deepEqual(page.audio.played.slice(2), [], 'the short reply waits for the connection to close');
    const usage = posts.find(post => post.path.endsWith('/usage'))!;
    assert.equal(usage.body.seconds, first.seconds(), 'settled with what was actually sent');
    first.closed();
    await flush();
    assert.deepEqual(page.audio.played.slice(2), ['/api/master/voice/audio/ack-1']);
    page.audio.onended!();
    mock.timers.tick(400);
    await flush();

    requestAnswer = { ack: page.say('ack-2', 'ack') };
    const second = await page.speak('두 번째 요청');
    assert.equal(second.readyState, 2);
    mock.timers.tick(9_900);
    await flush();
    assert.equal(page.audio.played.length, 3, 'still waiting within ten seconds');
    mock.timers.tick(100);
    await flush();
    assert.equal(page.audio.played.at(-1), '/api/master/voice/audio/ack-2', 'a connection that never closes is let be after ten seconds');
    const sent = second.sent.length;
    page.audio.onended!();
    mock.timers.tick(400);
    // The owner speaks again, and turns listening off before ElevenLabs answers: nothing was sent, nothing is paid.
    const paid = page.usages().length;
    await page.hear(0.002, 200);
    await page.hear(0.1, 400);
    assert.equal(second.sent.length, sent, 'the connection let be gets nothing new');
    assert.equal(FakeSocket.all.at(-1)!.readyState, 0);
    page.voice.mute();
    await flush();
    assert.ok(page.usages().length > paid);
    assert.ok(page.usages().slice(paid).every(seconds => seconds === 0), 'audio never sent is not paid');
  } finally { page.end(); }
});

test('what the microphone captured while something played is never heard, even when the page handles it late', async () => {
  const page = await harness();
  try {
    page.voice.say(page.say('a1', 'answer'));
    // The page is busy while the answer plays: what the microphone captured meanwhile waits.
    const during = [...page.frames(0.002, 200), ...page.frames(0.1, 600)];
    page.audio.onended!();
    mock.timers.tick(400);
    page.deliver(during);
    await flush();
    assert.equal(FakeSocket.all.length, 0, 'no utterance from before listening began again');
    assert.equal(page.view().capturing, false);
    await page.hear(0.002, 200);
    await page.hear(0.1, 400);
    assert.equal(FakeSocket.all.length, 1, 'what is said afterwards is heard');
  } finally { page.end(); }
});

for (const audio of [{ rate: 16_000, frame: 160 }, { rate: 48_000, frame: 128 }, { rate: 44_100, frame: 128 }]) test(`a notice's moment to object is timed on the audio's clock: speech during a stall objects, and what was captured before it is not heard (${audio.frame} samples at ${audio.rate} Hz)`, async () => {
  const page = await harness(audio);
  try {
    page.voice.say(page.say('n1', 'notice'));
    page.audio.onended!();
    // The page stalls right after the notice while the owner objects; the microphone reaches it in one burst, late.
    const stalled = [...page.frames(0.002, 700), ...page.frames(0.1, 600), ...page.frames(0.002, 1_500)];
    mock.timers.setTime(Date.now() + 2_800);
    mock.timers.tick(0);
    assert.deepEqual(page.results(), [], 'nothing heard yet: not decided');
    page.deliver(stalled, true);
    await flush();
    assert.deepEqual(page.results(), ['n1:interrupted']);

    mock.timers.tick(400);
    page.voice.say(page.say('n2', 'notice'));
    // Captured while it played, handled after it ended: not the moment after.
    const during = [...page.frames(0.002, 300), ...page.frames(0.1, 500)];
    page.audio.onended!();
    page.deliver(during, true);
    await page.hear(0.002, 400 + 1_900);
    assert.deepEqual(page.results(), ['n1:interrupted'], 'a short pause, then two seconds heard');
    await page.hear(0.002, 200);
    assert.deepEqual(page.results(), ['n1:interrupted', 'n2:played']);
  } finally { page.end(); }
});

test('notices cancelled one after another are each settled once, and never decide the next one', async () => {
  const page = await harness();
  try {
    page.voice.say(page.say('a', 'notice'));
    page.voice.say(page.say('b', 'notice'));
    page.voice.say(page.say('c', 'notice'));
    page.audio.onended!();
    mock.timers.tick(400);
    page.voice.skip();
    assert.deepEqual(page.results(), ['a:interrupted']);
    mock.timers.tick(400);
    assert.equal(page.audio.played.at(-1), '/api/master/voice/audio/b');
    page.voice.skip();
    // A's timers were let go with it: B's are not touched by them.
    mock.timers.tick(400);
    assert.equal(page.audio.played.at(-1), '/api/master/voice/audio/c');
    mock.timers.tick(3_000);
    assert.deepEqual(page.results(), ['a:interrupted', 'b:interrupted'], 'c is still playing: nothing decided it');
    page.voice.mute();
    assert.deepEqual(page.results(), ['a:interrupted', 'b:interrupted', 'c:interrupted'], 'listening off during a notice calls it off');
  } finally { page.end(); }
});

test('what the browser will not play by itself can be played with a click, told to the master once', async () => {
  const page = await harness();
  try {
    FakeAudio.refuse = true;
    page.voice.say(page.say('r1', 'report'));
    await flush();
    assert.deepEqual(page.results(), ['r1:failed']);
    assert.deepEqual(page.view().blocked, { text: 'report r1' });
    FakeAudio.refuse = false;
    mock.timers.tick(400);
    page.voice.replay();
    assert.equal(page.audio.played.at(-1), '/api/master/voice/audio/r1');
    assert.equal(page.view().blocked, undefined);
    page.audio.onended!();
    assert.deepEqual(page.results(), ['r1:failed'], 'the replay is not reported again');

    // Clicked while the owner speaks: the click lets sound play, and the reading waits its turn.
    FakeAudio.refuse = true;
    mock.timers.tick(400);
    page.voice.say(page.say('r2', 'report'));
    await flush();
    FakeAudio.refuse = false;
    mock.timers.tick(400);
    await page.hear(0.002, 200);
    await page.hear(0.1, 400);
    const socket = FakeSocket.all.at(-1)!;
    socket.open();
    const before = page.audio.played.length;
    page.voice.replay();
    assert.deepEqual(page.audio.played.slice(before), ['/master-silence.wav']);
    // Nothing written down: the page's own rule ends it a little after the pause.
    await page.hear(0.002, 2_500);
    socket.message({ message_type: 'committed_transcript', text: '' });
    await flush();
    socket.closed();
    await flush();
    assert.equal(page.audio.played.at(-1), '/api/master/voice/audio/r2');
    assert.deepEqual(page.results(), ['r1:failed', 'r2:failed']);
    page.audio.onended!();
    mock.timers.tick(400);

    // The unlocking silence finishes only after the reading has started: it does not stop the reading.
    FakeAudio.refuse = true;
    page.voice.say(page.say('r3', 'report'));
    await flush();
    FakeAudio.refuse = false;
    FakeAudio.slow = true;
    mock.timers.tick(400);
    await page.hear(0.002, 200);
    await page.hear(0.1, 400);
    const third = FakeSocket.all.at(-1)!;
    third.open();
    page.voice.replay();
    await page.hear(0.002, 2_500);
    third.message({ message_type: 'committed_transcript', text: '' });
    await flush();
    third.closed();
    await flush();
    assert.equal(page.audio.played.at(-1), '/api/master/voice/audio/r3');
    const paused = page.audio.paused.length;
    FakeAudio.slowSilence!();
    await flush();
    assert.equal(page.audio.paused.length, paused, 'the reading plays on');
  } finally { page.end(); }
});

// ─── when the owner is done ────────────────────────────────────────────────────────────────────────────────────

const commits = (socket: FakeSocket) => socket.sent.filter(message => JSON.parse(message).commit === true).length;
const requests = () => posts.filter(post => post.path.endsWith('/request')).map(post => post.body.text);
const judged = () => posts.filter(post => post.path.endsWith('/finished')).map(post => post.body as { text: string; pauseMs: number });

/** The owner starts speaking and ElevenLabs has written down `text` so far. */
async function startSpeaking(page: Awaited<ReturnType<typeof harness>>, text: string): Promise<FakeSocket> {
  await page.hear(0.002, 200);
  await page.hear(0.1, 400);
  const socket = FakeSocket.all.at(-1)!;
  socket.open();
  socket.message({ message_type: 'partial_transcript', text });
  return socket;
}

test('a pause mid-thought is not the end: each pause is judged, speaking on continues the same utterance, and it goes once finished', async () => {
  const page = await harness();
  try {
    turnEnd = ({ text }) => ({ finished: text.endsWith('줘') ? 0.95 : 0.1 });
    const socket = await startSpeaking(page, '이 세션 로그 확인하고');
    await page.hearSlowly(0.002, 2_500);
    assert.equal(commits(socket), 0, 'a pause judged unfinished commits nothing');
    assert.deepEqual(requests(), []);
    assert.ok(judged().length >= 1 && judged().every(body => body.text === '이 세션 로그 확인하고' && body.pauseMs > 0));
    assert.deepEqual([page.view().capturing, page.view().waiting], [true, true]);
    assert.deepEqual(page.audio.played.slice(1), [], 'no reply starts');

    await page.hearSlowly(0.1, 600);
    assert.equal(page.view().waiting, false, 'speaking again');
    socket.message({ message_type: 'partial_transcript', text: '이 세션 로그 확인하고 원인 알려 줘' });
    await page.hearSlowly(0.002, 1_500);
    assert.equal(commits(socket), 1, 'finished: committed at the pause, the judgment made on the way to it');
    assert.equal(FakeSocket.all.length, 1, 'one utterance throughout');
    socket.message({ message_type: 'committed_transcript', text: '이 세션 로그 확인하고 원인 알려 줘' });
    await flush();
    assert.deepEqual(requests(), ['이 세션 로그 확인하고 원인 알려 줘']);
    assert.ok(judged().length <= 4, 'the same words are not judged again and again');
  } finally { page.end(); }
});

test('a long unfinished pause plays nothing and ends nothing: nothing of the speaker comes back into the microphone, and speaking on continues', async () => {
  const page = await harness();
  try {
    // 2026-09-29: a recorded "계속 말씀하세요" played in such a pause came back through the microphone and was written into the request.
    turnEnd = ({ text }) => ({ finished: text.endsWith('줘') ? 0.9 : 0.1 });
    const socket = await startSpeaking(page, '그러니까 음');
    await page.hearSlowly(0.002, 8_000);
    assert.deepEqual(page.audio.played.slice(1), [], 'nothing is played');
    assert.ok(!posts.some(post => post.path.includes('nudge')));
    assert.deepEqual([commits(socket), requests().length, page.view().capturing, page.view().waiting], [0, 0, true, true]);
    const sent = socket.sent.length;
    await page.hearSlowly(0.1, 400);
    assert.ok(socket.sent.length > sent, 'what they say next is sent');
    socket.message({ message_type: 'partial_transcript', text: '그러니까 음 내일 배포 일정 잡아 줘' });
    await page.hearSlowly(0.002, 1_500);
    assert.equal(commits(socket), 1);
    socket.message({ message_type: 'committed_transcript', text: '그러니까 음 내일 배포 일정 잡아 줘' });
    await flush();
    assert.deepEqual(requests(), ['그러니까 음 내일 배포 일정 잡아 줘']);
  } finally { page.end(); }
});

test('a very long unfinished pause keeps what was said unsent to go on from', async () => {
  const page = await harness();
  try {
    turnEnd = ({ text }) => ({ finished: text === '내일 회의는 오후 세 시로 잡아 줘' ? 0.9 : 0.1 });
    const socket = await startSpeaking(page, '내일 회의는');
    await page.hearSlowly(0.002, 6_000);
    assert.equal(commits(socket), 0);
    await page.hearSlowly(0.002, 15_000);
    assert.equal(commits(socket), 1, 'written down after twenty seconds, not sent');
    socket.message({ message_type: 'committed_transcript', text: '내일 회의는' });
    await flush();
    socket.closed();
    await flush();
    assert.deepEqual(requests(), []);
    assert.deepEqual([page.view().capturing, page.view().draft], [false, '내일 회의는']);

    await page.speak('오후 세 시로 잡아 줘');
    assert.ok(judged().some(body => body.text === '내일 회의는 오후 세 시로 잡아 줘'), 'judged together with what waited');
    assert.deepEqual(requests(), ['내일 회의는 오후 세 시로 잡아 줘']);
    assert.equal(page.view().draft, undefined);
    FakeSocket.all.at(-1)!.closed();
    await flush();

    // What waits can also be sent with a click, or dropped.
    const third = await startSpeaking(page, '로그 좀');
    await page.hearSlowly(0.002, 21_500);
    third.message({ message_type: 'committed_transcript', text: '로그 좀' });
    await flush();
    third.closed();
    await flush();
    assert.equal(page.view().draft, '로그 좀');
    page.voice.finish();
    await flush();
    assert.deepEqual(requests().at(-1), '로그 좀');
    assert.equal(page.view().draft, undefined);
  } finally { page.end(); }
});

test('without a judgment (none set up, failed or too slow) the pause and how the sentence ends decide', async () => {
  const page = await harness();
  try {
    turnEnd = () => ({ unavailable: true });
    const first = await startSpeaking(page, '세션 목록 보여 줘');
    await page.hearSlowly(0.002, 1_700);
    assert.equal(commits(first), 1, 'a finished sentence goes a moment after the pause');
    first.message({ message_type: 'committed_transcript', text: '세션 목록 보여 줘' });
    await flush();
    first.closed();
    await flush();

    const second = await startSpeaking(page, '그리고');
    await page.hearSlowly(0.002, 1_700);
    assert.equal(commits(second), 0, 'a sentence trailing off waits longer');
    await page.hearSlowly(0.002, 1_300);
    assert.equal(commits(second), 1);
    second.message({ message_type: 'committed_transcript', text: '그리고' });
    await flush();
    second.closed();
    await flush();

    turnEnd = () => new Promise(() => {});
    const third = await startSpeaking(page, '배포해 줘');
    await page.hearSlowly(0.002, 2_500);
    assert.equal(commits(third), 0, 'a judgment on its way is waited for');
    await page.hearSlowly(0.002, 1_500);
    assert.equal(commits(third), 1, 'but not for more than three seconds');
    third.message({ message_type: 'committed_transcript', text: '배포해 줘' });
    await flush();
    assert.deepEqual(requests(), ['세션 목록 보여 줘', '그리고', '배포해 줘']);
  } finally { page.end(); }
});

test('once the reply starts, talking over it is never written down; afterwards it is a new request, and talking before it plays holds it back', async () => {
  const page = await harness();
  try {
    requestAnswer = { ack: page.say('ack-1', 'ack') };
    const first = await page.speak('첫 요청');
    first.closed();
    await flush();
    assert.equal(page.audio.played.at(-1), '/api/master/voice/audio/ack-1');
    await page.hearSlowly(0.1, 600);
    assert.deepEqual([FakeSocket.all.length, page.view().capturing], [1, false], 'the microphone is not heard while the reply plays');
    page.audio.onended!();
    mock.timers.tick(400);
    await flush();

    requestAnswer = { ack: page.say('ack-2', 'ack') };
    const second = await page.speak('두 번째 요청');
    assert.deepEqual(requests(), ['첫 요청', '두 번째 요청']);
    // The owner goes on before the reply could play (its connection still closing): the reply waits for them.
    requestAnswer = {};
    const third = await startSpeaking(page, '아 그리고 테스트도 돌려 줘');
    second.closed();
    await flush();
    assert.notEqual(page.audio.played.at(-1), '/api/master/voice/audio/ack-2', 'nothing plays over the owner');
    await page.hearSlowly(0.002, 1_500);
    third.message({ message_type: 'committed_transcript', text: '아 그리고 테스트도 돌려 줘' });
    await flush();
    third.closed();
    await flush();
    assert.equal(page.audio.played.at(-1), '/api/master/voice/audio/ack-2');
    assert.deepEqual(requests(), ['첫 요청', '두 번째 요청', '아 그리고 테스트도 돌려 줘']);
  } finally { page.end(); }
});

test('a finished request after many pauses still goes: once judgments run out, the pause and how it ends decide, a judgment made or not', async () => {
  const page = await harness();
  try {
    // 2026-09-28: the last judgment one utterance may have landed on the finished request, just under the bar (0.48),
    // and with none left to ask at the longer pause, it waited twenty seconds and was kept unsent.
    turnEnd = () => ({ finished: 0.48 });
    const socket = await startSpeaking(page, '그,');
    socket.autoCommit = true;
    let said = '그,';
    for (let pause = 0; pause < 19; pause++) {
      await page.hearSlowly(0.002, 1_200);
      said += ` 말 ${pause}`;
      await page.hearSlowly(0.1, 400);
      socket.write(said);
    }
    said += ' 신난 목소리로 대화할 수 있도록.';
    socket.write(said);
    assert.ok(commits(socket) >= 1, 'long enough to be committed in parts at its pauses');
    const parts = commits(socket);
    await page.hearSlowly(0.002, 1_200);
    assert.equal(judged().length, 20, 'the finished request had the last judgment');
    assert.equal(judged().at(-1)!.text, said, 'judged as a whole, its parts included');
    assert.equal(page.view().capturing, true);
    await page.hearSlowly(0.002, 2_300);
    assert.equal(commits(socket), parts + 1, 'sent within seconds, not kept unsent after twenty');
    await flush();
    assert.deepEqual(requests(), [said]);
    assert.ok(judged().length <= 20);
    socket.closed();
    await flush();

    // Its last judgment sure that it is not finished, it waits for the owner however many judgments were used.
    turnEnd = ({ text }) => ({ finished: text.endsWith('그리고') ? 0.05 : 0.48 });
    const next = await startSpeaking(page, '그,');
    next.autoCommit = true;
    let more = '그,';
    for (let pause = 0; pause < 19; pause++) {
      await page.hearSlowly(0.002, 1_200);
      more += ` 말 ${pause}`;
      await page.hearSlowly(0.1, 400);
      next.write(more);
    }
    more += ' 이것도 고쳐 주고 그리고';
    next.write(more);
    await page.hearSlowly(0.002, 4_500);
    assert.equal(judged().length, 40);
    assert.deepEqual([page.view().capturing, requests().length], [true, 1], 'not sent at the longer pause');
  } finally { page.end(); }
});

test('words still being written down in what seemed a pause are speech too quiet to hear: the pause starts over, unjudged as long', async () => {
  const page = await harness();
  try {
    turnEnd = ({ text }) => ({ finished: text.endsWith('줄래?') ? 0.9 : 0.05 });
    const socket = await startSpeaking(page, '그, 마스터 채팅 음성으로 할 때,');
    // The owner goes on softly: the microphone stays below speech, but ElevenLabs keeps writing.
    let said = '그, 마스터 채팅 음성으로 할 때,';
    for (const more of [' 어, 그,', ' 음성에 태그를', ' 줄 수가 있거든?', ' 그, 음성 태그 줄 때', ' 신남, 약간 들뜸']) {
      await page.hearSlowly(0.002, 1_000);
      said += more;
      socket.message({ message_type: 'partial_transcript', text: said });
    }
    await page.hearSlowly(0.002, 1_000);
    assert.ok(judged().length <= 3, `words a second apart are not each judged (${judged().length})`);
    assert.ok(judged().every(body => body.pauseMs < 3_000), `judged as short pauses: ${judged().map(body => body.pauseMs).join(', ')}`);
    assert.equal(commits(socket), 0);
    said += ' 이런 태그를 줄래?';
    socket.message({ message_type: 'partial_transcript', text: said });
    await page.hearSlowly(0.002, 2_500);
    assert.equal(commits(socket), 1);
  } finally { page.end(); }
});

test('speaking starts shows at once, and what is written down begins with the first syllable, the onset before it included', async () => {
  // A real worklet's frames: the gate's smoothing and timing as in a browser.
  const page = await harness({ rate: 48_000, frame: 128 });
  try {
    await page.hear(0.002, 500);
    const shown: boolean[] = [];
    await page.hear(0.1, 30);
    for (let step = 0; step < 30; step++) { await page.hear(0.002, 10); shown.push(Boolean(page.view().hearing)); }
    assert.ok(!shown.includes(true), 'a click does not flash it, nor the quiet after it');
    await page.hear(0.1, 150);
    assert.deepEqual([page.view().hearing, page.view().capturing], [true, false], 'a voice is shown before it counts as speech');
    await page.hear(0.002, 300);
    assert.equal(page.view().hearing, false, 'a blip is let go');
    // Syllables with short gaps: the first one is sent, not cut off.
    for (let syllable = 0; syllable < 4; syllable++) { await page.hear(0.1, 150); await page.hear(0.002, 60); }
    assert.equal(page.view().capturing, true);
    const socket = FakeSocket.all.at(-1)!;
    socket.open();
    const loud = socket.sent.reduce((sum, message) => { const pcm = new Int16Array(new Uint8Array(Buffer.from(JSON.parse(message).audio_base_64, 'base64')).buffer); return sum + pcm.filter(sample => sample > 1_000).length; }, 0);
    assert.ok(loud >= 4 * 150 * 16, `all four syllables sent (${loud / 16} ms loud)`);
  } finally { page.end(); }
});

test('with no token ready when speaking starts, one is fetched then and nothing said is lost', async () => {
  const page = await harness({ failTokens: 1 });
  try {
    assert.equal(tokenFailures, 0, 'the token ready for speaking failed');
    const socket = await page.speak('세션 목록 보여 줘');
    assert.equal(FakeSocket.all.length, 1);
    assert.equal(commits(socket), 1);
    assert.deepEqual(requests(), ['세션 목록 보여 줘']);
  } finally { page.end(); }
});

test('out of judgments, a finished request goes even after a long pause judged unfinished, while one that trails off still waits for the owner', async () => {
  const page = await harness();
  try {
    turnEnd = () => ({ finished: 0.3 });
    // Each pause gets its first judgment and the one at three seconds: ten pauses use all twenty.
    const socket = await startSpeaking(page, '그,');
    socket.autoCommit = true;
    let said = '그,';
    for (let pause = 0; pause < 10; pause++) {
      await page.hearSlowly(0.002, 3_300);
      said += ` 말 ${pause}`;
      await page.hearSlowly(0.1, 400);
      socket.write(said);
    }
    assert.equal(judged().length, 20);
    assert.ok(judged().at(-1)!.pauseMs >= 3_000, 'the last one was at the longer pause');
    // It trails off: no more judgments, and it is not sent however long the owner thinks (it waits unsent).
    said += ' 그러니까 음';
    socket.write(said);
    const parts = commits(socket);
    await page.hearSlowly(0.002, 5_500);
    assert.deepEqual([commits(socket), judged().length, page.view().capturing], [parts, 20, true]);
    await page.hearSlowly(0.002, 15_000);
    assert.equal(page.view().capturing, false, 'kept unsent after twenty seconds');
    await flush();
    socket.closed();
    await flush();
    assert.deepEqual([requests(), page.view().draft], [[], said]);

    // The same, with a finished request: it goes at three seconds and the wait for its ending, not after twenty.
    page.voice.discard();
    const next = await startSpeaking(page, '그,');
    next.autoCommit = true;
    let more = '그,';
    for (let pause = 0; pause < 10; pause++) {
      await page.hearSlowly(0.002, 3_300);
      more += ` 말 ${pause}`;
      await page.hearSlowly(0.1, 400);
      next.write(more);
    }
    assert.equal(judged().length, 40);
    more += ' 로그 보여 줘';
    next.write(more);
    await page.hearSlowly(0.002, 3_000);
    assert.equal(page.view().capturing, true, 'not before three seconds');
    await page.hearSlowly(0.002, 500);
    await flush();
    assert.deepEqual(requests(), [more]);
  } finally { page.end(); }
});

// ─── long utterances ───────────────────────────────────────────────────────────────────────────────────────────

test('a part ElevenLabs commits by itself mid-speech is kept: the request is the whole utterance, not its first part', async () => {
  const page = await harness();
  try {
    // 2026-09-29: ElevenLabs committed the first ~36 seconds by itself; the page sent only those and lost the rest.
    turnEnd = ({ text }) => ({ finished: text.endsWith('따로 맡겨 줘.') ? 0.9 : 0.1 });
    const socket = await startSpeaking(page, '첫 응답을 뭐라고 할지');
    socket.message({ message_type: 'committed_transcript', text: '첫 응답을 뭐라고 할지' });
    await page.hearSlowly(0.1, 400);
    socket.message({ message_type: 'partial_transcript', text: '정하는 작업도 따로 맡겨 줘.' });
    assert.equal(page.view().heard, '첫 응답을 뭐라고 할지 정하는 작업도 따로 맡겨 줘.', 'shown whole');
    await page.hearSlowly(0.002, 1_500);
    assert.equal(judged().at(-1)!.text, '첫 응답을 뭐라고 할지 정하는 작업도 따로 맡겨 줘.', 'judged whole');
    assert.equal(commits(socket), 1);
    assert.deepEqual(requests(), [], 'waits for the part it committed');
    socket.message({ message_type: 'committed_transcript', text: '정하는 작업도 따로 맡겨 줘.' });
    await flush();
    assert.deepEqual(requests(), ['첫 응답을 뭐라고 할지 정하는 작업도 따로 맡겨 줘.']);
  } finally { page.end(); }
});

test('a long utterance is committed in parts at its pauses, a part coming back does not restart the pause, and every part is waited for', async () => {
  const page = await harness();
  try {
    turnEnd = ({ text }) => ({ finished: text.endsWith('보여 줘') ? 0.9 : 0.1 });
    const socket = await startSpeaking(page, '');
    let said = '';
    for (let part = 0; part < 4; part++) {
      said += ` 설명 ${part}`;
      await page.hearSlowly(0.1, 3_900);
      socket.message({ message_type: 'partial_transcript', text: said.trim() });
      await page.hearSlowly(0.002, 1_800);
    }
    assert.equal(commits(socket), 1, 'past fifteen seconds, the pause commits what was said so far');
    socket.message({ message_type: 'committed_transcript', text: '설명 0, 설명 1 설명 2 설명 3' });
    await page.hearSlowly(0.1, 2_000);
    socket.message({ message_type: 'partial_transcript', text: '로그 보여 줘' });
    await page.hearSlowly(0.002, 1_500);
    assert.equal(commits(socket), 2, 'finished: the final commit');
    assert.equal(judged().at(-1)!.text, '설명 0, 설명 1 설명 2 설명 3 로그 보여 줘');
    socket.message({ message_type: 'committed_transcript', text: '로그 보여 줘' });
    await flush();
    assert.deepEqual(requests(), ['설명 0, 설명 1 설명 2 설명 3 로그 보여 줘']);

    // A part committed in a pause, back while the pause goes on, is its final wording and not new quiet speech.
    socket.closed();
    await flush();
    const next = await startSpeaking(page, '');
    for (let part = 0; part < 4; part++) { await page.hearSlowly(0.1, 3_900); await page.hearSlowly(0.002, 1_800); }
    next.message({ message_type: 'partial_transcript', text: '배포 상태 알려 주고' });
    await page.hearSlowly(0.1, 400);
    await page.hearSlowly(0.002, 1_100);
    assert.equal(commits(next), 1);
    const at = judged().length;
    await page.hearSlowly(0.002, 1_000);
    next.message({ message_type: 'committed_transcript', text: '배포 상태 알려 주고,' });
    await page.hearSlowly(0.002, 1_600);
    assert.ok(judged().slice(at).some(body => body.pauseMs >= 3_000), 'judged as the longer pause it is');
  } finally { page.end(); }
});

test('speech with no pause is committed before ElevenLabs would do it by itself, and an utterance may run past a minute', async () => {
  const page = await harness();
  try {
    turnEnd = () => ({ finished: 0.1 });
    const socket = await startSpeaking(page, '');
    socket.autoCommit = true;
    // Loud throughout, with syllable gaps too short for the gate's pause.
    const at: number[] = [];
    let said = '';
    for (let second = 0; second < 95; second++) {
      said = `${said} 말 ${second}`.trim();
      socket.write(said);
      await page.hear(0.1, 900);
      await page.hear(0.002, 100);
      if (commits(socket) > at.length) at.push(socket.seconds());
    }
    assert.equal(at.length, 2, `committed in parts (${at.join(', ')})`);
    assert.ok(at[0] >= 30 && at[0] < 34, `the first before 36 seconds (${at[0]})`);
    assert.ok(at[1] - at[0] < 34, 'the next one too');
    assert.deepEqual([page.view().capturing, requests().length], [true, 0], 'not cut at a minute');

    // A moment quiet enough (though no pause) past thirty seconds is where the next part is cut.
    for (let second = 0; second < 32 && commits(socket) === 2; second++) { await page.hear(0.1, 400); await page.hear(0.002, 600); }
    const third = socket.seconds() - at[1];
    assert.ok(commits(socket) === 3 && third >= 30 && third < 32, `cut at a quiet moment (${third})`);
    socket.write(`${said} 마지막 부분`);
    await page.hearSlowly(0.002, 1_500);
    turnEnd = () => ({ finished: 0.9 });
    await page.hearSlowly(0.002, 2_000);
    await flush();
    assert.equal(requests().length, 1);
    assert.equal(requests()[0], `${said} 마지막 부분`, 'the whole of it, its parts in order');
  } finally { page.end(); }
});

test('a short request is committed once, and a final writing that is late or cut off still sends what was written down', async () => {
  const page = await harness();
  try {
    const socket = await startSpeaking(page, '빌드 상태 알려 줘');
    await page.hearSlowly(0.002, 1_500);
    assert.equal(commits(socket), 1, 'one commit, at the pause');
    socket.message({ message_type: 'committed_transcript', text: '빌드 상태 알려 줘' });
    await flush();
    assert.deepEqual(requests(), ['빌드 상태 알려 줘']);
    socket.closed();
    await flush();

    const late = await startSpeaking(page, '테스트 결과 보여 줘');
    await page.hearSlowly(0.002, 1_500);
    assert.equal(commits(late), 1);
    mock.timers.tick(4_000);
    await flush();
    assert.deepEqual(requests().at(-1), '테스트 결과 보여 줘', 'sent with what was written down so far');
  } finally { page.end(); }
});

test('writing that comes while the last part is awaited is what goes if that part never comes, and muting meanwhile sends nothing', async () => {
  const page = await harness();
  try {
    const socket = await startSpeaking(page, '배포해 줘');
    await page.hearSlowly(0.002, 1_500);
    assert.equal(commits(socket), 1);
    socket.message({ message_type: 'partial_transcript', text: '배포해 줘 대신 운영은 건드리지 마' });
    mock.timers.tick(4_000);
    await flush();
    assert.deepEqual(requests(), ['배포해 줘 대신 운영은 건드리지 마']);
    socket.closed();
    await flush();

    const muted = await startSpeaking(page, '서버 재시작해 줘');
    await page.hearSlowly(0.002, 1_500);
    assert.equal(commits(muted), 1);
    page.voice.mute();
    mock.timers.tick(4_000);
    await flush();
    assert.deepEqual(requests(), ['배포해 줘 대신 운영은 건드리지 마'], 'called off, not sent');
  } finally { page.end(); }
});
