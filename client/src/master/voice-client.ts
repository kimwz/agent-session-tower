import type { MasterSay, MasterViewContext, MasterVoiceSettings, MasterVoiceStatus } from '../../../shared/master';
import { post } from './api';
import { base64, digest, listenExpired, noticeOutcome, SpeechGate, toPcm16 } from './voice-sound';

const PRESENCE_MS = 5_000;
const REPORT_MS = 2_000;
const PREROLL_SECONDS = 0.6;
const UTTERANCE_SECONDS = 60;
const COMMIT_MS = 4_000;
const COOLDOWN_MS = 400;
const OBJECTION_MS = 2_000;
const STT_ERRORS = new Set(['auth_error', 'quota_exceeded', 'rate_limited', 'queue_overflow', 'resource_exhausted', 'session_time_limit_exceeded', 'input_error', 'invalid_request', 'chunk_size_exceeded', 'insufficient_audio_activity', 'transcriber_error', 'unaccepted_terms', 'commit_throttled', 'error']);

export interface VoiceView {
  listening: boolean;
  /** The owner is speaking, and it is being written down. */
  capturing: boolean;
  /** What was just heard, or is being heard. */
  heard?: string;
  playing?: { kind: MasterSay['kind']; text: string };
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
interface Utterance { token: Token; socket: WebSocket; bytes: number; queue: string[]; open: boolean; partial: string; done: Promise<string>; settle(text: string | Error): void }

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Voice in this tab: it listens for the owner, writes down what they say with ElevenLabs directly (a single-use
 * token from the master each time), sends it as a request, and plays what the master reads aloud. Listening and
 * playing never overlap: while something plays, the microphone is not heard at all.
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
  private utterance?: Utterance;
  private spare?: Promise<Token | undefined>;
  private listening = false;
  private armed = false;
  private lastActivityAt = Date.now();
  private lastSpeechAt = 0;
  private lastReportAt = 0;
  private lastPresenceAt = 0;
  private speechToTell = false;
  private reporting = false;
  private readonly queue: MasterSay[] = [];
  private readonly seen = new Set<string>();
  private current?: { say: MasterSay; startedAt: number; endedAt?: number; failed?: boolean; cancelled?: boolean; spokeAt?: number };
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
    void this.context.resume().catch(() => {});
    this.audio.src = '/master-silence.wav';
    void this.audio.play().then(() => this.audio.pause(), () => {});
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
    this.disarm();
    this.abandon('muted');
    this.closeMic();
    void this.presence();
    this.show({});
  }

  /** Tells the master at once where this page stands (the master panel opened or closed). */
  touch(): void { void this.presence(); }

  /** Stops what is playing now. */
  skip(): void {
    const current = this.current;
    if (!current) return;
    if (current.say.kind === 'notice') { current.cancelled = true; this.finishNotice(); return; }
    this.audio.pause();
    this.finishPlay('stopped');
  }

  /** The host's word on voice: if it is no longer this tab's session, voice ends here. */
  status(voice: MasterVoiceStatus): void {
    if (this.over || !this.sessionDigest) return;
    if (voice.session !== this.sessionDigest) this.end(voice.session ? 'replaced' : 'host');
    else if (voice.limited && this.listening) { this.mute(); this.show({ error: '오늘 음성 한도에 닿아 듣기를 껐습니다.' }); }
  }

  /** Something to play: only this session's, once each, and not once it is stale. */
  say(say: MasterSay): void {
    if (this.over || say.session !== this.sessionDigest || this.seen.has(say.id) || say.expiresAt < Date.now()) return;
    this.seen.add(say.id);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value!);
    this.queue.push(say);
    this.next();
  }

  private end(reason: string, error?: string): void {
    if (this.over) return;
    this.over = true;
    if (this.timer) clearInterval(this.timer);
    this.abandon('ended');
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

  /** Starts hearing the microphone (after playback, a short pause first so its tail is not heard). */
  private arm(): void {
    if (this.over || !this.listening || !this.stream || !this.context || this.current) return;
    this.gate.silenceMs = this.options.settings().endSilenceMs;
    this.gate.reset();
    this.preroll = [];
    this.prerollLength = 0;
    if (!this.node) {
      this.source = this.context.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.context, 'master-pcm-tap', { numberOfOutputs: 0 });
      this.node.port.onmessage = (event: MessageEvent<Float32Array>) => this.frame(event.data);
      this.source.connect(this.node);
    }
    this.armed = true;
  }

  /** Stops hearing the microphone: not a single frame is looked at or sent until it is armed again. */
  private disarm(): void {
    this.armed = false;
    this.preroll = [];
    this.prerollLength = 0;
  }

  private frame(data: Float32Array): void {
    if (!this.armed || !this.context) return;
    let sum = 0;
    for (const sample of data) sum += sample * sample;
    const event = this.gate.update(Math.sqrt(sum / data.length));
    const now = Date.now();
    if (this.gate.isSpeaking || event === 'speech-start') {
      this.lastSpeechAt = now;
      if (this.current?.say.kind === 'notice') this.current.spokeAt ??= now;
    }
    if (event === 'speech-start') this.speechToTell = true;
    // In a notice's moment after, speech only objects; nothing is written down.
    if (this.current) return;
    if (this.utterance) {
      this.send(data);
      if (event === 'silence-commit' || this.utterance.bytes >= UTTERANCE_SECONDS * 32_000) void this.commit();
    } else if (event === 'speech-start') this.begin();
    else {
      this.preroll.push(data);
      this.prerollLength += data.length;
      while (this.prerollLength > this.context.sampleRate * PREROLL_SECONDS && this.preroll.length > 1) this.prerollLength -= this.preroll.shift()!.length;
    }
  }

  // ─── writing down what is said ───────────────────────────────────────────────────────────────────────────────

  private prefetch(): void {
    if (this.spare || !this.listening || this.over) return;
    const spare: Promise<Token | undefined> = post<Token>('/api/master/voice/token', this.options.token(), { session: this.session })
      .catch(error => { if (this.spare === spare) this.spare = undefined; this.show({ error: errorText(error) }); return undefined; });
    this.spare = spare;
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
    const utterance: Utterance = { token: undefined as unknown as Token, socket: undefined as unknown as WebSocket, bytes: 0, queue: [], open: false, partial: '', done, settle };
    this.utterance = utterance;
    this.lastActivityAt = Date.now();
    this.show({ heard: '' });
    for (const data of preroll) this.send(data);
    void spare.then(token => {
      if (this.utterance !== utterance) { if (token) this.settleUsage(token.tokenId, 0); return; }
      if (!token || token.expiresAt < Date.now()) { this.utterance = undefined; this.show({ error: '받아쓰기를 준비하지 못했습니다. 다시 말씀해 주세요.' }); if (token) this.settleUsage(token.tokenId, 0); this.prefetch(); return; }
      utterance.token = token;
      const socket = utterance.socket = new WebSocket(token.url);
      socket.onopen = () => { utterance.open = true; for (const message of utterance.queue.splice(0)) socket.send(message); };
      socket.onmessage = event => {
        let message: { message_type?: string; text?: string; error?: string };
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message.message_type === 'partial_transcript' && this.utterance === utterance) { utterance.partial = String(message.text ?? ''); this.show({ heard: utterance.partial }); }
        else if (message.message_type === 'committed_transcript' || message.message_type === 'committed_transcript_with_timestamps') utterance.settle(String(message.text ?? ''));
        else if (message.message_type && STT_ERRORS.has(message.message_type)) utterance.settle(new Error(message.error ?? message.message_type));
      };
      socket.onerror = () => utterance.settle(new Error('받아쓰기 연결이 끊겼습니다.'));
      socket.onclose = () => utterance.settle(new Error('받아쓰기 연결이 끊겼습니다.'));
    });
    this.prefetch();
  }

  private send(data: Float32Array): void {
    const utterance = this.utterance;
    if (!utterance || !this.context || utterance.bytes >= UTTERANCE_SECONDS * 32_000) return;
    const pcm = toPcm16(data, this.context.sampleRate);
    utterance.bytes += pcm.byteLength;
    const message = JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: base64(new Uint8Array(pcm.buffer)), sample_rate: 16_000, commit: false });
    if (utterance.open) utterance.socket.send(message);
    else utterance.queue.push(message);
  }

  /** The owner stopped (or ran out of time): what was said is committed, written down and sent as a request. */
  private async commit(): Promise<void> {
    const utterance = this.utterance;
    if (!utterance) return;
    this.utterance = undefined;
    // The commit rides on a short silent tail; an empty chunk is refused.
    const tail = JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: base64(new Uint8Array(640)), sample_rate: 16_000, commit: true });
    utterance.bytes += 640;
    if (utterance.open) utterance.socket.send(tail);
    else utterance.queue.push(tail);
    let text = '';
    try {
      text = (await Promise.race([utterance.done, new Promise<string>((_, reject) => setTimeout(() => reject(new Error('받아쓰기가 늦어 버렸습니다.')), COMMIT_MS))])).trim();
    } catch (error) {
      this.show({ error: `받아쓰지 못했습니다: ${errorText(error)}` });
    } finally {
      try { utterance.socket?.close(); } catch { /* Closed already. */ }
      if (utterance.token) this.settleUsage(utterance.token.tokenId, utterance.bytes / 32_000);
    }
    this.next();
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

  /** Called off before it was sent (voice ended, listening muted): nothing is sent, and its cost is still settled. */
  private abandon(reason: string): void {
    const utterance = this.utterance;
    if (!utterance) return;
    this.utterance = undefined;
    utterance.settle(new Error(reason));
    try { utterance.socket?.close(); } catch { /* Closed already. */ }
    if (utterance.token) this.settleUsage(utterance.token.tokenId, utterance.bytes / 32_000);
  }

  /** Reports how long an utterance ran, once, tried three times in 30 seconds. */
  private settleUsage(tokenId: string, seconds: number): void {
    const attempt = (left: number) => void post('/api/master/voice/usage', this.options.token(), { tokenId, seconds: Math.min(seconds, UTTERANCE_SECONDS) })
      .catch(() => { if (left > 0) setTimeout(() => attempt(left - 1), 10_000); else if (!this.over) { this.mute(); this.show({ error: '마스터에 닿지 않아 듣기를 껐습니다.' }); } });
    attempt(2);
  }

  // ─── playing ─────────────────────────────────────────────────────────────────────────────────────────────────

  /** Plays the next thing when nothing plays and the owner is not in the middle of speaking. */
  private next(): void {
    if (this.over || this.current || this.utterance) return;
    const say = this.queue.shift();
    if (!say) { this.arm(); return; }
    if (say.expiresAt < Date.now()) { this.report(say.id, 'failed'); this.next(); return; }
    this.disarm();
    this.current = { say, startedAt: Date.now() };
    this.show({});
    this.audio.onended = () => { if (this.current?.say === say) say.kind === 'notice' ? this.noticeEnded() : this.finishPlay('played'); };
    this.audio.onerror = () => { if (this.current?.say === say) say.kind === 'notice' ? (this.current.failed = true, this.finishNotice()) : this.finishPlay('failed'); };
    this.audio.src = say.audio;
    this.audio.play().catch(() => {
      if (this.current?.say !== say) return;
      if (say.kind === 'notice') { this.current.failed = true; this.finishNotice(); }
      else { this.finishPlay('failed'); this.show({ error: '브라우저가 소리 재생을 막았습니다. 화면을 한 번 누른 뒤 다시 켜 주세요.' }); }
    });
  }

  private finishPlay(result: 'played' | 'stopped' | 'failed'): void {
    const current = this.current;
    if (!current || current.say.kind === 'notice') return;
    this.current = undefined;
    if (current.say.kind !== 'ack' && current.say.kind !== 'working') this.report(current.say.id, result);
    // A report read aloud turns listening back on, so the owner can answer it.
    if (current.say.kind === 'report' && result === 'played') { this.lastActivityAt = Date.now(); void this.listen(); }
    this.show({});
    setTimeout(() => this.next(), COOLDOWN_MS);
  }

  /** A notice played through: a moment to object follows (speaking or cancelling), with the microphone heard again. */
  private noticeEnded(): void {
    const current = this.current;
    if (!current) return;
    current.endedAt = Date.now();
    setTimeout(() => {
      if (this.current !== current) return;
      this.gate.reset();
      this.armed = this.listening;
      setTimeout(() => this.finishNotice(), OBJECTION_MS);
    }, COOLDOWN_MS);
  }

  private finishNotice(): void {
    const current = this.current;
    if (!current || current.say.kind !== 'notice') return;
    const outcome = noticeOutcome({ ...current, now: Date.now(), windowMs: OBJECTION_MS }) ?? (current.endedAt ? 'played' : 'failed');
    this.current = undefined;
    this.audio.pause();
    this.report(current.say.id, outcome);
    this.lastReportAt = 0;
    this.show({});
    setTimeout(() => this.next(), COOLDOWN_MS);
  }

  private report(id: string, result: string): void {
    void post('/api/master/voice/played', this.options.token(), { session: this.session, id, result }).catch(() => {});
  }

  // ─── keeping the master told ─────────────────────────────────────────────────────────────────────────────────

  private tick(): void {
    if (this.over) return;
    const now = Date.now();
    if (this.listening && !this.utterance && !this.current && listenExpired(this.lastActivityAt, this.options.settings().listenMinutes, now)) this.mute();
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
    this.view = { ...this.view, ...change, listening: this.listening, capturing: Boolean(this.utterance), ...(this.current ? { playing: { kind: this.current.say.kind, text: this.current.say.text } } : { playing: undefined }) };
    this.options.onView(this.view);
  }
}
