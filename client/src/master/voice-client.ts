import { VOICE_TURN_FINISHED } from '../../../shared/decisions';
import type { MasterSay, MasterViewContext, MasterVoiceSettings, MasterVoiceStatus } from '../../../shared/master';
import { post } from './api';
import { base64, digest, endHoldMs, fitUtterance, listenExpired, noticeOutcome, SpeechGate, toPcm16, UTTERANCE_BYTES } from './voice-sound';

const PRESENCE_MS = 5_000;
const REPORT_MS = 2_000;
const PREROLL_SECONDS = 0.6;
const TAIL_BYTES = 640;
const COMMIT_MS = 4_000;
const COOLDOWN_MS = 400;
const OBJECTION_MS = 2_000;
/** The same words are judged again once the pause has grown this long: a longer pause says more. */
const REASK_MS = 3_000;
/** A judgment not back by then is not waited for: the page's own rule decides the rest of the utterance. */
const JUDGE_WAIT_MS = 3_000;
/** At most this many judgments for one utterance; past them the page's own rule decides. */
const JUDGMENTS = 12;
/** A pause this long in the middle of what is said gets a short sign that the owner is still heard, once. */
const NUDGE_MS = 5_000;
/** How long the sign may play before it is given up on. */
const NUDGE_PLAY_MS = 8_000;
/** A pause this long ends the utterance without sending it: what was said waits, to go on with or send by click. */
const PARK_MS = 20_000;
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
  /** The owner paused, but does not seem finished: listening goes on. */
  waiting?: boolean;
  /** What was said but not sent (a long pause before it seemed finished): speaking goes on with it, or a click sends it. */
  draft?: string;
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
/**
 * `bytes` is the audio taken for the utterance (it may not pass 60 seconds); `sent` what actually went out. `heard` is
 * the latest partial writing. `quietSince` (audio clock, ms) is set while the owner pauses; each pause is judged
 * (`asking`, then `verdict`) until they seem finished, and `ownRule` means judgments failed and the page decides.
 */
interface Utterance {
  token?: Token; socket?: WebSocket; bytes: number; sent: number; queue: Array<{ message: string; bytes: number }>; open: boolean; closed: boolean; done: Promise<string>; settle(text: string | Error): void;
  heard: string; quietSince?: number; judgments: number; asking?: { text: string; at: number }; verdict?: { text: string; finished: number; pauseMs: number }; ownRule?: boolean; nudged?: boolean;
}
/** The sign that the owner is still heard, playing: the microphone is kept, not sent, unless they speak over it. */
interface Nudge { frames: Float32Array[]; length: number; timer?: ReturnType<typeof setTimeout> }
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
  /** What was said before a long pause and not sent yet; what is said next goes on from it. */
  private draft = '';
  private nudging?: Nudge;
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
    this.stopNudge();
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

  /** The owner says they are done (a click): what is being said, or what waits unsent, is sent now. */
  finish(): void {
    if (this.over) return;
    if (this.utterance) { void this.commit(); return; }
    const draft = this.draft;
    if (!draft) return;
    this.draft = '';
    this.show({});
    void this.request(draft);
  }

  /** What waits unsent is dropped. */
  discard(): void {
    if (!this.draft) return;
    this.draft = '';
    this.show({ heard: undefined });
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
    this.stopNudge();
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
    const utterance = this.utterance;
    if (utterance) {
      if (this.nudging) { this.duringNudge(this.nudging, data, event); return; }
      this.send(data);
      if (utterance.bytes >= UTTERANCE_BYTES - TAIL_BYTES) { void this.commit(); return; }
      const at = time * 1000;
      if (event === 'silence-commit') { utterance.quietSince = at - this.gate.silenceMs; this.show({}); }
      else if (event === 'speech-start' && utterance.quietSince !== undefined) { utterance.quietSince = undefined; this.show({}); }
      if (utterance.quietSince !== undefined) this.paused(utterance, at - utterance.quietSince);
      else if (this.gate.isSpeaking && at - this.gate.lastVoiceAt >= this.gate.silenceMs / 2) this.prejudge(utterance);
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
    const utterance: Utterance = { bytes: 0, sent: 0, queue: [], open: false, closed: false, done, settle, heard: '', judgments: 0 };
    this.utterance = utterance;
    this.open.add(utterance);
    this.lastActivityAt = Date.now();
    this.show({ heard: this.draft });
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
        if (message.message_type === 'partial_transcript' && this.utterance === utterance) { utterance.heard = String(message.text ?? ''); this.show({ heard: this.said(utterance.heard) }); }
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

  /**
   * The owner finished (or ran out of time): what was said is committed, written down and sent as a request, together
   * with what waited unsent. `park` (a long pause before they seemed finished) writes it down but keeps it unsent.
   */
  private async commit(park = false): Promise<void> {
    const utterance = this.utterance;
    if (!utterance) return;
    this.utterance = undefined;
    this.stopNudge();
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
    if (this.over) return;
    const said = this.said(text);
    if (park) { this.draft = said; this.show({ heard: said }); return; }
    this.draft = '';
    if (!said) { this.show({}); return; }
    await this.request(said);
  }

  /** What the owner said, sent as a request; the short reply it gets is played. */
  private async request(text: string): Promise<void> {
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

  /** What was said: what waited unsent, and then `text`. */
  private said(text: string): string {
    return [this.draft, text.trim()].filter(Boolean).join(' ');
  }

  // ─── when the owner is done ──────────────────────────────────────────────────────────────────────────────────

  /**
   * The owner has paused for `silent` ms (the audio's clock) in the middle of an utterance. What they said so far is
   * judged, and judged again when it changes or the pause grows; it is sent only once they seem finished. A long
   * pause before that gets a short sign that they are still heard, and a very long one keeps it unsent. Without a
   * judgment (none set up, failed or late) the page decides from the pause and how the sentence ends.
   */
  private paused(utterance: Utterance, silent: number): void {
    // Loud again, perhaps speaking again: nothing is decided until it is clear.
    if (this.gate.isVoicing) return;
    const text = this.said(utterance.heard);
    if (utterance.asking && Date.now() - utterance.asking.at >= JUDGE_WAIT_MS) { utterance.asking = undefined; utterance.ownRule = true; }
    if (utterance.ownRule || !text) {
      if (silent >= this.gate.silenceMs + endHoldMs(text)) void this.commit();
      return;
    }
    const verdict = utterance.verdict?.text === text ? utterance.verdict : undefined;
    if (verdict && verdict.finished >= VOICE_TURN_FINISHED) { void this.commit(); return; }
    if (!utterance.asking && (!verdict || (verdict.pauseMs < REASK_MS && silent >= REASK_MS))) {
      if (utterance.judgments < JUDGMENTS) this.judge(utterance, text, silent);
      else if (!verdict) { utterance.ownRule = true; return; }
    }
    if (!verdict) return;
    if (silent >= PARK_MS) { void this.commit(true); return; }
    if (silent >= NUDGE_MS && !utterance.nudged) this.nudge(utterance);
  }

  /**
   * Halfway to a pause, what was said is judged already (as at the pause), so a finished request goes out as soon as
   * the pause is reached rather than a judgment later.
   */
  private prejudge(utterance: Utterance): void {
    const text = this.said(utterance.heard);
    if (!text || utterance.ownRule || utterance.asking || utterance.verdict?.text === text || utterance.judgments >= JUDGMENTS) return;
    this.judge(utterance, text, this.gate.silenceMs);
  }

  /** Asks whether the owner is finished with `text` after a pause of `pauseMs`; one question at a time. */
  private judge(utterance: Utterance, text: string, pauseMs: number): void {
    const asking = { text, at: Date.now() };
    utterance.asking = asking;
    utterance.judgments++;
    void post<{ finished?: number; unavailable?: true }>('/api/master/voice/finished', this.options.token(), { session: this.session, text, pauseMs: Math.round(pauseMs) })
      .then(answer => {
        if (utterance.asking !== asking) return;
        if (typeof answer?.finished === 'number' && Number.isFinite(answer.finished)) utterance.verdict = { text, finished: answer.finished, pauseMs };
        else utterance.ownRule = true;
      }, () => { if (utterance.asking === asking) utterance.ownRule = true; })
      .finally(() => { if (utterance.asking === asking) utterance.asking = undefined; this.show({}); });
  }

  /**
   * "Go on, I am listening", said once in a long pause of an utterance. It ends nothing and sends nothing: what the
   * microphone hears meanwhile is kept, not sent (it would carry the sign itself), and speaking over it stops it and
   * sends the moment before, so the owner is never talked over.
   */
  private nudge(utterance: Utterance): void {
    utterance.nudged = true;
    void post<{ stale?: true; say?: MasterSay }>('/api/master/voice/nudge', this.options.token(), { session: this.session })
      .then(answer => {
        if (answer?.stale) { this.end('replaced'); return; }
        const say = answer?.say;
        if (!say || this.over || this.utterance !== utterance || utterance.quietSince === undefined || this.current || this.nudging) return;
        const nudge: Nudge = { frames: [], length: 0 };
        this.nudging = nudge;
        const done = () => { if (this.nudging !== nudge) return; this.stopNudge(); this.gate.reset(); };
        nudge.timer = setTimeout(done, NUDGE_PLAY_MS);
        this.audio.onended = done;
        this.audio.onerror = done;
        this.audio.src = say.audio;
        this.audio.play().catch(done);
        this.show({});
      })
      .catch(() => {});
  }

  /** A frame while the sign plays: kept for a moment, and sent with what follows only if the owner speaks. */
  private duringNudge(nudge: Nudge, data: Float32Array, event: ReturnType<SpeechGate['update']>): void {
    nudge.frames.push(data);
    nudge.length += data.length;
    while (this.context && nudge.length > this.context.sampleRate * PREROLL_SECONDS && nudge.frames.length > 1) nudge.length -= nudge.frames.shift()!.length;
    if (event !== 'speech-start') return;
    const utterance = this.utterance!;
    this.stopNudge();
    utterance.quietSince = undefined;
    for (const frame of nudge.frames) this.send(frame);
    this.show({});
  }

  private stopNudge(): void {
    const nudge = this.nudging;
    if (!nudge) return;
    this.nudging = undefined;
    if (nudge.timer) clearTimeout(nudge.timer);
    this.audio.onended = null;
    this.audio.onerror = null;
    this.audio.pause();
    this.show({});
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
    const utterance = this.utterance;
    const waiting = Boolean(utterance && utterance.quietSince !== undefined && !utterance.ownRule && utterance.verdict && utterance.verdict.finished < VOICE_TURN_FINISHED);
    this.view = { ...this.view, ...change, listening: this.listening, capturing: Boolean(utterance), waiting, draft: this.draft || undefined, playing: this.current ? { kind: this.current.say.kind, text: this.current.say.text } : undefined, blocked: this.blocked ? { text: this.blocked.text } : undefined };
    this.options.onView(this.view);
  }
}
