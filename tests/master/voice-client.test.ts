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
  send(message: string): void { assert.equal(this.readyState, 1, 'sent only while open'); this.sent.push(message); }
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
  src = '';
  preload = '';
  played: string[] = [];
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { FakeAudio.all.push(this); }
  play(): Promise<void> {
    if (FakeAudio.refuse && this.src !== '/master-silence.wav') return Promise.reject(new DOMException('Autoplay refused', 'NotAllowedError'));
    this.played.push(this.src);
    return Promise.resolve();
  }
  pause(): void {}
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
  sampleRate = 16_000;
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

Object.assign(globalThis, {
  window: { isSecureContext: true, navigator: globalThis.navigator, dispatchEvent() {} },
  WebSocket: FakeSocket,
  Audio: FakeAudio,
  AudioContext: FakeContext,
  AudioWorkletNode: FakeNode,
  fetch: async (path: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    posts.push({ path, body });
    const reply = path.endsWith('/on') ? { session: 'session-1' }
      : path.endsWith('/token') ? { tokenId: `token-${++tokens}`, url: 'wss://stt.test', expiresAt: Date.now() + 900_000 }
      : path.endsWith('/request') ? requestAnswer : true;
    return { ok: true, status: 200, json: async () => reply };
  },
});
Object.defineProperty(globalThis.navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ readyState: 'live', stop() {} }] }) } });

const { VoiceSession } = await import('../../client/src/master/voice-client.js');
const { digest } = await import('../../client/src/master/voice-sound.js');
type View = import('../../client/src/master/voice-client.js').VoiceView;

const flush = async () => { for (let round = 0; round < 5; round++) await new Promise(resolve => setImmediate(resolve)); };

async function harness() {
  FakeSocket.all = [];
  FakeAudio.all = [];
  FakeAudio.refuse = false;
  posts.length = 0;
  requestAnswer = {};
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  let view: View | undefined;
  const voice = new VoiceSession({
    token: () => 'page-token', tabId: 'tab-1', panelOpen: () => true, viewContext: () => undefined,
    settings: () => ({ voiceId: 'v', model: 'eleven_v3_conversational', endSilenceMs: 1_000, listenMinutes: 5, readReports: true, dailyDollars: 0 }),
    onView: next => { view = next; }, onEnded: () => {},
  });
  await voice.start();
  await flush();
  const session = await digest('session-1');
  const audio = FakeAudio.all[0];
  const context = FakeContext.last!;
  /** The microphone captured at a loudness for a while, 10 ms a frame (the audio's clock goes with it). */
  const frames = (rms: number, ms: number): Frame[] => {
    const captured: Frame[] = [];
    for (let at = 0; at < ms; at += 10) { captured.push({ samples: new Float32Array(160).fill(rms), time: context.currentTime }); context.currentTime += 0.01; }
    return captured;
  };
  /** Frames handed to the page: as they come (the page's clock going with them), or all at once after a stall. */
  const deliver = (captured: Frame[], burst = false) => {
    for (const frame of captured) { FakeNode.last!.port.onmessage?.({ data: frame }); if (!burst) mock.timers.tick(10); }
  };
  const hear = async (rms: number, ms: number) => { deliver(frames(rms, ms)); await flush(); };
  const say = (id: string, kind: MasterSay['kind']): MasterSay => ({ id, session, kind, text: `${kind} ${id}`, audio: `/api/master/voice/audio/${id}`, expiresAt: Date.now() + 600_000 });
  const results = () => posts.filter(post => post.path.endsWith('/played')).map(post => `${post.body.id}:${post.body.result}`);
  /** The owner says something; ElevenLabs writes it down; the connection is asked to close. */
  const speak = async (text: string) => {
    await hear(0.002, 200);
    await hear(0.1, 400);
    const socket = FakeSocket.all.at(-1)!;
    socket.open();
    await hear(0.002, 1_500);
    socket.message({ message_type: 'committed_transcript', text });
    await flush();
    return socket;
  };
  const usages = () => posts.filter(post => post.path.endsWith('/usage')).map(post => post.body.seconds);
  return { voice, audio, frames, deliver, hear, say, results, usages, speak, view: () => view!, end: () => { voice.stop(); mock.timers.reset(); } };
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

test('a notice\'s moment to object is timed on the audio\'s clock: speech during a stall objects, and what was captured before it is not heard', async () => {
  const page = await harness();
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
    await page.hear(0.002, 1_500);
    socket.message({ message_type: 'committed_transcript', text: '' });
    await flush();
    socket.closed();
    await flush();
    assert.equal(page.audio.played.at(-1), '/api/master/voice/audio/r2');
    assert.deepEqual(page.results(), ['r1:failed', 'r2:failed']);
  } finally { page.end(); }
});
