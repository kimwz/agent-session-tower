import type { MasterSay, MasterViewContext, MasterVoiceSettings, MasterVoiceStatus } from '../../../shared/master';
import { post } from './api';
import { base64, digest, fitUtterance, listenExpired, noticeOutcome, SpeechGate, toPcm16, UTTERANCE_BYTES } from './voice-sound';

const PRESENCE_MS = 5_000;
const REPORT_MS = 2_000;
const PREROLL_SECONDS = 0.6;
const TAIL_BYTES = 640;
const COMMIT_MS = 4_000;
const COOLDOWN_MS = 400;
const OBJECTION_MS = 2_000;
/** How long a closed utterance's connection may take to finish sending before playing goes on anyway. */
const CLOSE_MS = 10_000;
/** A spare token older than this is traded for a fresh one (they last 15 minutes). */
const SPARE_MS = 10 * 60_000;
const QUEUE = 20;
const STT_ERRORS = new Set(['auth_error', 'quota_exceeded', 'rate_limited', 'queue_overflow', 'resource_exhausted', 'session_time_limit_exceeded', 'input_error', 'invalid_request', 'chunk_size_exceeded', 'insufficient_audio_activity', 'transcriber_error', 'unaccepted_terms', 'commit_throttled', 'error']);

export interface VoiceView {
  listening: boolean;
  /** The owner is speaking, and it is being written down. */
  capturing: boolean;
  /** What was just heard, or is being heard. */
  heard?: string;
  playing?: { kind: MasterSay['kind']; text: string };
  /** What the browser would not play by itself, to be played with a click. */
  blocked?: { text: string };
  error?: string;
}

export interface VoiceSessionOptions {
  token: () => string;
  tabId: string;
  settings: () => MasterVoiceSettings;
  panelOpen: () => boolean;
  viewContext: () => MasterViewContext | undefined;
  onView(view: VoiceView): void;
  /** Voice is off here: by the owner, because another tab took it, or because the host no longer has it. */
  onEnded(reason: string, error?: string): void;
}

interface Token { tokenId: string; url: string; expiresAt: number }
interface Spare { token: Promise<Token | undefined>; at: number }
/** `bytes` is the audio taken for the utterance (it may not pass 60 seconds); `sent` what actually went out. */
interface Utterance { token?: Token; socket?: WebSocket; bytes: number; sent: number; queue: Array<{ message: string; bytes: number }>; open: boolean; closed: boolean; done: Promise<string>; settle(text: string | Error): void }
/**
 * A say being played. A notice's moment to object starts at `armedAt`; with listening on, `heard` counts the
 * microphone samples heard since it began (on the audio's clock), which it must reach as well.
 */
interface Playing { say: MasterSay; startedAt: number; replay?: boolean; failed?: boolean; cancelled?: boolean; spokeAt?: number; armedAt?: number; heard?: number; timers: Array<ReturnType<typeof setTimeout>> }

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Voice in this tab: it listens for the owner, writes down what they say with ElevenLabs directly (a single-use
 * token from the master each time), sends it as a request, and plays what the master reads aloud. Listening and
 * playing never overlap: nothing plays while any utterance is still being written down, and while something plays
 * the microphone is not heard at all.
 */
export class VoiceSession {
  private session = '';
  private sessionDigest = '';
  private context?: AudioContext;
  private readonly audio = new Audio();
  private stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private node?: AudioWorkletNode;
  private readonly gate: SpeechGate;
  private preroll: Float32Array[] = [];
  private prerollLength = 0;
  /** The utterance being heard now, and every utterance whose connection is not closed yet. */
  private utterance?: Utterance;
  private readonly open = new Set<Utterance>();
  private spare?: Spare;
  private listening = false;
  private armed = false;
  /** The audio time (seconds) from which the microphone is heard: frames captured before it are not. */
  private heardFrom = 0;
  private lastActivityAt = Date.now();
  private lastSpeechAt = 0;
  private lastReportAt = 0;
  private lastPresenceAt = 0;
  private speechToTell = false;
  private reporting = false;
  private readonly queue: Array<{ say: MasterSay; replay?: boolean }> = [];
  private readonly seen = new Set<string>();
  private current?: Playing;
  private blocked?: MasterSay;
  private view: VoiceView = { listening: false, capturing: false };
  private timer?: ReturnType<typeof setInterval>;
  private over = false;

  static supported(): boolean {
    return typeof window !== 'undefined' && window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia) && typeof AudioWorkletNode !== 'undefined' && typeof WebSocket !== 'undefined';
  }

  constructor(private readonly options: VoiceSessionOptions) {
    this.gate = new SpeechGate(options.settings().endSilenceMs);
    this.audio.preload = 'auto';
  }

  /**
   * Turns voice on. Call it straight from the owner's click: the sound is unlocked before anything is awaited, so
   * the browser lets what is read aloud play later without another click.
   */
  async start(): Promise<void> {
    this.context = new AudioContext();
    this.unlock();
    try {
      const { session } = await post<{ session: string }>('/api/master/voice/on', this.options.token(), { tabId: this.options.tabId });
      this.session = session;
      this.sessionDigest = await digest(session);
      await this.context.audioWorklet.addModule('/master-pcm-tap.js');
      await this.listen();
      this.timer = setInterval(() => this.tick(), 1_000);
      void this.presence();
    } catch (error) {
      this.end('failed', errorText(error));
      throw error;
    }
  }

  /** Turns voice off here, and on the master. */
  stop(): void {
    if (this.over) return;
    if (this.session) void post('/api/master/voice/off', this.options.token(), { session: this.session }).catch(() => {});
    this.end('owner');
  }

  /** Listening back on (by the owner, or after a report was read). */
  async listen(): Promise<void> {
    if (this.over) return;
    this.lastActivityAt = Date.now();
    if (!this.listening) {
      this.listening = true;
      await this.openMic();
      this.arm();
      void this.presence();
      this.prefetch();
    }
    this.show({});
  }

  /** Listening off: the microphone is let go, but what the master reads aloud still plays here. */
  mute(): void {
    if (!this.listening) return;
    this.listening = false;
    // A notice can no longer be objected to by voice: its change is not sent.
    if (this.current?.say.kind === 'notice') { this.current.cancelled = true; this.decideNotice(this.current); }
    this.disarm();
    this.abandon('muted');
    this.releaseSpare();
    this.closeMic();
    void this.presence();
    this.show({});
  }

  /** Stops what is playing now (a notice this way is cancelled: its change is not sent). */
  skip(): void {
    const current = this.current;
    if (!current) return;
    if (current.say.kind === 'notice') { current.cancelled = true; this.decideNotice(current); return; }
    this.audio.pause();
    this.finishPlay(current, 'stopped');
  }

  /** Plays, from the owner's click, what the browser would not play by itself (not a notice: its moment is gone). */
  replay(): void {
    const say = this.blocked;
    if (!say || this.over) return;
    this.blocked = undefined;
    this.queue.unshift({ say, replay: true });
    this.show({ error: undefined });
    this.next();
    // It waits behind what is being said: the click lets sound play now, for when its turn comes.
    if (!this.current) this.unlock();
  }

  /** Lets sound play later without another click; called straight from one. */
  private unlock(): void {
    void this.context?.resume().catch(() => {});
    this.audio.src = '/master-silence.wav';
    void this.audio.play().then(() => { if (!this.current) this.audio.pause(); }, () => {});
  }

  /** Tells the master at once where this page stands (the master panel opened or closed). */
  touch(): void { void this.presence(); }

  /** The host's word on voice: if it is no longer this tab's session, voice ends here. */
  status(voice: MasterVoiceStatus): void {
    if (this.over || !this.sessionDigest) return;
    if (voice.session !== this.sessionDigest) this.end(voice.session ? 'replaced' : 'host');
    else if (voice.limited && this.listening) { this.mute(); this.show({ error: '오늘 음성 한도에 닿아 듣기를 껐습니다.' }); }
  }

  /** Something to play: only this session's, once each, not once it is stale, and never more than a few waiting. */
  say(say: MasterSay): void {
    if (this.over || say.session !== this.sessionDigest || this.seen.has(say.id) || say.expiresAt < Date.now()) return;
    this.seen.add(say.id);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value!);
    this.queue.push({ say });
    while (this.queue.length > QUEUE) { const dropped = this.queue.shift()!; if (!dropped.replay) this.report(dropped.say, 'failed'); }
    this.next();
  }

  private end(reason: string, error?: string): void {
    if (this.over) return;
    this.over = true;
    if (this.timer) clearInterval(this.timer);
    if (this.current) for (const timer of this.current.timers) clearTimeout(timer);
    this.current = undefined;
    this.abandon('ended');
    this.releaseSpare();
    this.closeMic();
    this.audio.pause();
    this.audio.removeAttribute('src');
    void this.context?.close().catch(() => {});
    this.options.onEnded(reason, error);
  }

  // ─── the microphone ──────────────────────────────────────────────────────────────────────────────────────────

  private async openMic(): Promise<void> {
    if (this.stream && this.stream.getTracks().some(track => track.readyState === 'live')) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    // Allowed after voice was turned off or listening muted meanwhile: let it go at once.
    if (this.over || !this.listening) { for (const track of stream.getTracks()) track.stop(); return; }
    this.stream = stream;
  }

  private closeMic(): void {
    this.node?.port.close();
    this.node?.disconnect();
    this.source?.disconnect();
    this.node = undefined;
    this.source = undefined;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = undefined;
  }

  /** Starts hearing the microphone for what is said (never while something plays or is being written down). */
  private arm(): void {
    if (this.over || !this.listening || !this.stream || !this.context || this.current || this.open.size) return;
    this.gate.silenceMs = this.options.settings().endSilenceMs;
    this.gate.reset();
    this.preroll = [];
    this.prerollLength = 0;
    this.heardFrom = this.context.currentTime;
    this.ensureNode();
    this.armed = true;
  }

  private ensureNode(): void {
    if (this.node || !this.stream || !this.context) return;
    this.source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, 'master-pcm-tap', { numberOfOutputs: 0 });
    this.node.port.onmessage = (event: MessageEvent<{ samples: Float32Array; time: number }>) => this.frame(event.data.samples, event.data.time);
    this.source.connect(this.node);
  }

  /** Stops hearing the microphone: not a single frame is looked at or sent until it is armed again. */
  private disarm(): void {
    this.armed = false;
    this.preroll = [];
    this.prerollLength = 0;
  }

  /**
   * One frame from the microphone, captured at `time` on the audio's clock. Frames captured before hearing began
   * (while something played) are not heard even when handled late, and speech is timed on that clock, so frames
   * handled in a burst after the page was busy keep their real spacing.
   */
  private frame(data: Float32Array, time: number): void {
    if (!this.armed || !this.context || time < this.heardFrom) return;
    let sum = 0;
    for (const sample of data) sum += sample * sample;
    const event = this.gate.update(Math.sqrt(sum / data.length), time * 1000);
    const now = Date.now();
    if (this.gate.isSpeaking || event === 'speech-start') this.lastSpeechAt = now;
    if (event === 'speech-start') this.speechToTell = true;
    // In a notice's moment after, speech only objects: nothing is written down.
    const current = this.current;
    if (current) {
      if (current.say.kind === 'notice' && current.heard !== undefined) {
        current.heard += data.length;
        if (this.gate.isSpeaking || event === 'speech-start') current.spokeAt ??= now;
        this.decideNotice(current);
      }
      return;
    }
    if (this.utterance) {
      this.send(data);
      if (event === 'silence-commit' || this.utterance.bytes >= UTTERANCE_BYTES - TAIL_BYTES) void this.commit();
    } else if (event === 'speech-start') this.begin();
    else {
      this.preroll.push(data);
      this.prerollLength += data.length;
      while (this.prerollLength > this.context.sampleRate * PREROLL_SECONDS && this.preroll.length > 1) this.prerollLength -= this.preroll.shift()!.length;
    }
  }

  // ─── writing down what is said ───────────────────────────────────────────────────────────────────────────────

  /** A token ready for the next utterance; one too old to be safe is settled unused and replaced. */
  private prefetch(): void {
    if (this.over || !this.listening) return;
    if (this.spare && Date.now() - this.spare.at < SPARE_MS) return;
    this.releaseSpare();
    const token: Promise<Token | undefined> = post<Token>('/api/master/voice/token', this.options.token(), { session: this.session })
      .catch(error => { if (this.spare?.token === token) this.spare = undefined; this.show({ error: errorText(error) }); return undefined; });
    this.spare = { token, at: Date.now() };
  }

  /** A spare token that will not be used is settled as unused, so its reservation is let go. */
  private releaseSpare(): void {
    const spare = this.spare;
    this.spare = undefined;
    void spare?.token.then(token => { if (token) this.settleUsage(token.tokenId, 0); });
  }

  /** The owner started speaking: a connection with the token ready, the last moment before included. */
  private begin(): void {
    const spare = this.spare;
    this.spare = undefined;
    if (!spare) { this.prefetch(); return; }
    const preroll = this.preroll;
    this.preroll = [];
    this.prerollLength = 0;
    let settle!: (text: string | Error) => void;
    const done = new Promise<string>((resolve, reject) => { settle = value => value instanceof Error ? reject(value) : resolve(value); });
    done.catch(() => {});
    const utterance: Utterance = { bytes: 0, sent: 0, queue: [], open: false, closed: false, done, settle };
    this.utterance = utterance;
    this.open.add(utterance);
    this.lastActivityAt = Date.now();
    this.show({ heard: '' });
    for (const data of preroll) this.send(data);
    void spare.token.then(token => {
      if (utterance.closed) { if (token) this.settleUsage(token.tokenId, 0); return; }
      if (!token || token.expiresAt < Date.now()) {
        this.close(utterance, new Error('받아쓰기를 준비하지 못했습니다. 다시 말씀해 주세요.'));
        if (token) this.settleUsage(token.tokenId, 0);
        return;
      }
      utterance.token = token;
      const socket = utterance.socket = new WebSocket(token.url);
      socket.onopen = () => {
        utterance.open = true;
        for (const chunk of utterance.queue.splice(0)) { socket.send(chunk.message); utterance.sent += chunk.bytes; }
      };
      socket.onmessage = event => {
        let message: { message_type?: string; text?: string; error?: string };
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message.message_type === 'partial_transcript' && this.utterance === utterance) this.show({ heard: String(message.text ?? '') });
        else if (message.message_type === 'committed_transcript' || message.message_type === 'committed_transcript_with_timestamps') utterance.settle(String(message.text ?? ''));
        else if (message.message_type && STT_ERRORS.has(message.message_type)) utterance.settle(new Error(message.error ?? message.message_type));
      };
      socket.onerror = () => utterance.settle(new Error('받아쓰기 연결이 끊겼습니다.'));
      socket.onclose = () => utterance.settle(new Error('받아쓰기 연결이 끊겼습니다.'));
    });
    this.prefetch();
  }

  /** Audio for the utterance, never past its 60 seconds (the silent tail that commits it included). */
  private send(data: Float32Array): void {
    const utterance = this.utterance;
    if (!utterance || !this.context) return;
    const pcm = toPcm16(data, this.context.sampleRate);
    const allowed = fitUtterance(utterance.bytes, pcm.byteLength, TAIL_BYTES);
    if (!allowed) return;
    utterance.bytes += allowed;
    this.transmit(utterance, JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: base64(new Uint8Array(pcm.buffer, 0, allowed)), sample_rate: 16_000, commit: false }), allowed);
  }

  /** Sends audio on the utterance's connection, or keeps it until the connection opens; only what goes out is paid. */
  private transmit(utterance: Utterance, message: string, bytes: number): void {
    if (utterance.closed) return;
    if (!utterance.open) utterance.queue.push({ message, bytes });
    // A connection ElevenLabs has closed already takes nothing: what would go there is neither sent nor paid.
    else if (utterance.socket?.readyState === WebSocket.OPEN) { utterance.socket.send(message); utterance.sent += bytes; }
  }

  /** The owner stopped (or ran out of time): what was said is committed, written down and sent as a request. */
  private async commit(): Promise<void> {
    const utterance = this.utterance;
    if (!utterance) return;
    this.utterance = undefined;
    // The commit rides on a short silent tail; an empty chunk is refused.
    utterance.bytes += TAIL_BYTES;
    this.transmit(utterance, JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: base64(new Uint8Array(TAIL_BYTES)), sample_rate: 16_000, commit: true }), TAIL_BYTES);
    let text = '';
    try {
      text = (await Promise.race([utterance.done, new Promise<string>((_, reject) => setTimeout(() => reject(new Error('받아쓰기가 늦어 버렸습니다.')), COMMIT_MS))])).trim();
    } catch (error) {
      this.show({ error: `받아쓰지 못했습니다: ${errorText(error)}` });
    }
    this.close(utterance);
    if (!text || this.over) return;
    this.show({ heard: text });
    this.lastActivityAt = Date.now();
    try {
      const view = this.options.viewContext();
      const answer = await post<{ ignored?: true; stale?: true; ack?: MasterSay }>('/api/master/voice/request', this.options.token(), { session: this.session, clientMessageId: crypto.randomUUID(), text, ...(view ? { viewContext: view } : {}) });
      if (answer.stale) { this.end('replaced'); return; }
      if (answer.ignored) { this.show({ heard: `(무시함) ${text}` }); return; }
      if (answer.ack) this.say(answer.ack);
    } catch (error) { this.show({ error: errorText(error) }); }
  }

  /**
   * Closes an utterance: nothing more is sent on it, what went out is settled, and once its connection has really
   * closed (what it still had to send gone), what waits to play goes on. A connection that does not close within
   * ten seconds is let be: it gets nothing new, so nothing played afterwards can reach it.
   */
  private close(utterance: Utterance, error?: Error): void {
    if (utterance.closed) return;
    utterance.closed = true;
    if (this.utterance === utterance) this.utterance = undefined;
    utterance.settle(error ?? new Error('closed'));
    utterance.queue.length = 0;
    if (utterance.token) this.settleUsage(utterance.token.tokenId, utterance.sent / 32_000);
    if (error) this.show({ error: error.message });
    const socket = utterance.socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) { this.release(utterance); return; }
    const timer = setTimeout(() => this.release(utterance), CLOSE_MS);
    socket.addEventListener('close', () => { clearTimeout(timer); this.release(utterance); });
    try { socket.close(); } catch { clearTimeout(timer); this.release(utterance); }
  }

  /** An utterance's connection is closed: playing (or listening) may go on. */
  private release(utterance: Utterance): void {
    if (this.open.delete(utterance)) this.next();
  }

  /** Every utterance not yet sent is called off (voice ended, listening muted): nothing more goes out. */
  private abandon(reason: string): void {
    void reason;
    for (const utterance of [...this.open]) this.close(utterance);
  }

  /** Reports how long an utterance ran, once, tried three times in 30 seconds. */
  private settleUsage(tokenId: string, seconds: number): void {
    const attempt = (left: number) => void post('/api/master/voice/usage', this.options.token(), { tokenId, seconds: Math.min(seconds, UTTERANCE_BYTES / 32_000) })
      .catch(() => { if (left > 0) setTimeout(() => attempt(left - 1), 10_000); else if (!this.over) { this.mute(); this.show({ error: '마스터에 닿지 않아 듣기를 껐습니다.' }); } });
    attempt(2);
  }

  // ─── playing ─────────────────────────────────────────────────────────────────────────────────────────────────

  /** Plays the next thing when nothing plays and no utterance is still being written down. */
  private next(): void {
    if (this.over || this.current || this.utterance || this.open.size) return;
    const item = this.queue.shift();
    if (!item) { this.arm(); return; }
    const say = item.say;
    if (!item.replay && say.expiresAt < Date.now()) { this.report(say, 'failed'); this.next(); return; }
    this.disarm();
    const current: Playing = { say, startedAt: Date.now(), ...(item.replay ? { replay: true } : {}), timers: [] };
    this.current = current;
    this.show({});
    // A player that never ends or fails is given up on after a while, so the queue goes on.
    current.timers.push(setTimeout(() => { if (say.kind === 'notice') { current.failed = true; this.decideNotice(current); } else this.finishPlay(current, 'failed'); }, Math.max(30_000, say.text.length * 200)));
    this.audio.onended = () => { if (this.current === current) say.kind === 'notice' ? this.noticeEnded(current) : this.finishPlay(current, 'played'); };
    this.audio.onerror = () => { if (this.current === current) say.kind === 'notice' ? (current.failed = true, this.decideNotice(current)) : this.finishPlay(current, 'failed'); };
    this.audio.src = say.audio;
    this.audio.play().catch((error: unknown) => {
      if (this.current !== current) return;
      if (say.kind === 'notice') { current.failed = true; this.decideNotice(current); return; }
      this.finishPlay(current, 'failed');
      // Autoplay refused: the owner can play it with a click (a click lets it play).
      if (error instanceof DOMException && error.name === 'NotAllowedError') { this.blocked = say; this.show({ error: '브라우저가 소리 재생을 막았습니다.' }); }
    });
  }

  private finishPlay(current: Playing, result: 'played' | 'stopped' | 'failed'): void {
    if (this.current !== current || current.say.kind === 'notice') return;
    for (const timer of current.timers) clearTimeout(timer);
    this.current = undefined;
    this.audio.pause();
    if (!current.replay) this.report(current.say, result);
    else if (result === 'failed') this.show({ error: '다시 들을 수 없습니다. 답은 화면에 있습니다.' });
    // A report read aloud turns listening back on, so the owner can answer it.
    if (current.say.kind === 'report' && result === 'played') { this.lastActivityAt = Date.now(); void this.listen(); }
    this.show({});
    setTimeout(() => this.next(), COOLDOWN_MS);
  }

  /**
   * A notice played through: a moment to object follows (speaking or cancelling), a short pause after it. With
   * listening on it is measured on the audio's clock and lasts until two seconds of the microphone captured after the
   * pause were heard, so a page that stalls neither skips it nor misses what was said meanwhile.
   */
  private noticeEnded(current: Playing): void {
    current.armedAt = Date.now() + COOLDOWN_MS;
    if (this.listening && this.stream && this.context) {
      this.gate.reset();
      this.heardFrom = this.context.currentTime + COOLDOWN_MS / 1000;
      this.ensureNode();
      current.heard = 0;
      this.armed = true;
    }
    current.timers.push(setTimeout(() => this.decideNotice(current), COOLDOWN_MS + OBJECTION_MS));
  }

  /** Settles this notice (and only this one) once its outcome is known; until then it keeps waiting. */
  private decideNotice(current: Playing): void {
    if (this.current !== current) return;
    const heardMs = current.heard !== undefined && this.context ? current.heard / this.context.sampleRate * 1000 : undefined;
    const outcome = noticeOutcome({ ...current, heardMs, now: Date.now(), windowMs: OBJECTION_MS });
    if (!outcome) return;
    for (const timer of current.timers) clearTimeout(timer);
    this.current = undefined;
    this.disarm();
    this.audio.pause();
    this.report(current.say, outcome);
    this.lastReportAt = 0;
    this.show({});
    setTimeout(() => this.next(), COOLDOWN_MS);
  }

  private report(say: MasterSay, result: string): void {
    if (say.kind === 'ack' || say.kind === 'working') return;
    void post('/api/master/voice/played', this.options.token(), { session: this.session, id: say.id, result }).catch(() => {});
  }

  // ─── keeping the master told ─────────────────────────────────────────────────────────────────────────────────

  private tick(): void {
    if (this.over) return;
    const now = Date.now();
    if (this.listening && !this.utterance && !this.current && listenExpired(this.lastActivityAt, this.options.settings().listenMinutes, now)) this.mute();
    if (this.listening && !this.utterance) this.prefetch();
    if (this.listening && (this.speechToTell || now - this.lastReportAt >= REPORT_MS)) this.activity(now);
    if (now - this.lastPresenceAt >= PRESENCE_MS) void this.presence();
  }

  /** What is heard, for a change waiting on its notice: speech starting is told at once, the rest every two seconds. */
  private activity(now: number): void {
    if (this.reporting) return;
    this.reporting = true;
    this.speechToTell = false;
    this.lastReportAt = now;
    const speaking = this.gate.isSpeaking;
    void post<boolean>('/api/master/voice/activity', this.options.token(), { session: this.session, speaking, ...(this.lastSpeechAt ? { sinceSpeechMs: Math.max(0, Date.now() - this.lastSpeechAt) } : {}) })
      .then(known => { if (known === false) this.end('replaced'); })
      .catch(() => { /* The web may be restarting: the next report carries what was missed. */ })
      .finally(() => { this.reporting = false; if (this.speechToTell) this.activity(Date.now()); });
  }

  private async presence(): Promise<void> {
    if (this.over || !this.session) return;
    this.lastPresenceAt = Date.now();
    try {
      const known = await post<boolean>('/api/master/voice/presence', this.options.token(), { session: this.session, listening: this.listening, panelOpen: this.options.panelOpen() });
      if (known === false) this.end('replaced');
    } catch { /* Tried again in a few seconds. */ }
  }

  private show(change: Partial<VoiceView>): void {
    this.view = { ...this.view, ...change, listening: this.listening, capturing: Boolean(this.utterance), playing: this.current ? { kind: this.current.say.kind, text: this.current.say.text } : undefined, blocked: this.blocked ? { text: this.blocked.text } : undefined };
    this.options.onView(this.view);
  }
}
