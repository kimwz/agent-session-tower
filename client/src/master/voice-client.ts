import { VOICE_TURN_FINISHED } from '../../../shared/decisions';
import type { MasterSay, MasterViewContext, MasterVoiceSettings, MasterVoiceStatus } from '../../../shared/master';
import { SayOrder } from '../../../shared/master/voice-order';
import { post } from './api';
import { applyPlaybackRate, base64, digest, END_HOLD_MS, endHoldMs, fitUtterance, joinSegments, listenExpired, noticeOutcome, SpeechGate, toPcm16, UTTERANCE_BYTES } from './voice-sound';

const PRESENCE_MS = 5_000;
const REPORT_MS = 2_000;
/** Kept from before speech is recognised as speech (its onset, and the syllable that started it), so no first word is lost. */
const PREROLL_SECONDS = 1;
const TAIL_BYTES = 640;
const COMMIT_MS = 4_000;
const COOLDOWN_MS = 400;
const OBJECTION_MS = 2_000;
/** The same words are judged again once the pause has grown this long: a longer pause says more. */
const REASK_MS = 3_000;
/** A judgment not back by then is not waited for: the page's own rule decides the rest of the utterance. */
const JUDGE_WAIT_MS = 3_000;
/**
 * At most this many judgments for one utterance. Past them, what was said goes after a pause of `REASK_MS` when the
 * last judgment was near the bar (or, not judged, it does not trail off); otherwise the long pause keeps it unsent.
 */
const JUDGMENTS = 20;
/**
 * Writing that changes this far into a pause is new speech too quiet for the gate, not late writing of what came
 * before: the pause starts over, so it is not judged as a long one.
 */
const WRITING_LAG_MS = 2_000;
/** A loud moment shown as a voice being heard once it has been loud this long, so a click or a cough does not flash it. */
const HEARING_MS = 120;
/** Out of judgments, a last judgment at least this sure lets a request go at `REASK_MS`; a lower one waits for the owner. */
const EXHAUSTED_FINISHED = 0.3;
/**
 * ElevenLabs commits what it heard by itself after about 36 seconds of audio since the last commit, and a commit it
 * makes cannot be told apart from ours in time. So ours come first: at a pause once this much went since the last one…
 */
const SEGMENT_PAUSE_BYTES = 15 * 32_000;
/** …at the first quiet moment (`SEGMENT_QUIET_MS` after the voice was last loud) once this much went… */
const SEGMENT_SOON_BYTES = 30 * 32_000;
const SEGMENT_QUIET_MS = 100;
/** …and here whatever is being said. */
const SEGMENT_FORCE_BYTES = 33 * 32_000;
/** A pause this long ends the utterance without sending it: what was said waits, to go on with or send by click. */
const PARK_MS = 20_000;
/** How long a closed utterance's connection may take to finish sending before playing goes on anyway. */
const CLOSE_MS = 10_000;
/** A spare token older than this is traded for a fresh one (they last 15 minutes). */
const SPARE_MS = 10 * 60_000;
const QUEUE = 20;
/** An answer read while it is written has no known length: it is given up on only after the longest one read (5,000 characters). */
const STREAMING_PLAY_MS = 5_000 * 200 + 30_000;
/** Audio cut off partway (the web restarting) is fetched again from where it was, this many times within this long. */
const RESUMES = 3;
const RESUME_WITHIN_MS = 30_000;
const STT_ERRORS = new Set(['auth_error', 'quota_exceeded', 'rate_limited', 'queue_overflow', 'resource_exhausted', 'session_time_limit_exceeded', 'input_error', 'invalid_request', 'chunk_size_exceeded', 'insufficient_audio_activity', 'transcriber_error', 'unaccepted_terms', 'commit_throttled', 'error']);

export interface VoiceView {
  listening: boolean;
  /** The owner is speaking, and it is being written down. */
  capturing: boolean;
  /** A voice is heard, not yet long enough to be taken as speech: shown at once, before writing down begins. */
  hearing?: boolean;
  /** What was just heard, or is being heard. */
  heard?: string;
  /** The owner paused, but does not seem finished: listening goes on. */
  waiting?: boolean;
  /** What was said but not sent (a long pause before it seemed finished): speaking goes on with it, or a click sends it. */
  draft?: string;
  playing?: { kind: MasterSay['kind']; text: string };
  error?: string;
  /** The owner muted the microphone: it stays off, even after a report is read, until they unmute it. */
  muted?: boolean;
}

export interface VoiceSessionOptions {
  token: () => string;
  tabId: string;
  settings: () => MasterVoiceSettings;
  viewContext: () => MasterViewContext | undefined;
  onView(view: VoiceView): void;
  /** Voice is off here: by the owner, because another tab took it, or because the host no longer has it. */
  onEnded(reason: string, error?: string): void;
}

interface Token { tokenId: string; url: string; expiresAt: number }
interface Spare { token: Promise<Token | undefined>; at: number }
/**
 * `bytes` is the audio taken for the utterance (it may not pass `UTTERANCE_BYTES`); `sent` what actually went out.
 * It is committed in parts: `commits` asked for (the last one `final`), `segments` what ElevenLabs wrote for each part
 * back so far, `partial` its latest writing of the part still open, `uncommitted` the audio since the last commit.
 * `heard` is all of it as one text. `quietSince` (audio clock, ms) is set while the owner pauses; each pause is judged
 * (`asking`, then `verdict`) until they seem finished, and `ownRule` means judgments failed and the page decides.
 */
interface Utterance {
  token?: Token; socket?: WebSocket; bytes: number; sent: number; queue: Array<{ message: string; bytes: number }>; open: boolean; closed: boolean; done: Promise<string>; settle(text: string | Error): void;
  commits: number; final?: boolean; segments: string[]; partial: string; uncommitted: number;
  heard: string; quietSince?: number; resumedQuietly?: boolean; judgments: number; asking?: { text: string; at: number }; verdict?: { text: string; finished: number; pauseMs: number }; ownRule?: boolean;
}
/**
 * A say being played. A notice's moment to object starts at `armedAt`; with listening on, `heard` counts the
 * microphone samples heard since it began (on the audio's clock), which it must reach as well.
 */
interface Playing {
  say: MasterSay; startedAt: number; failed?: boolean; cancelled?: boolean; spokeAt?: number; armedAt?: number; heard?: number; timers: Array<ReturnType<typeof setTimeout>>;
  /** When the page was told to play it, and when its sound started (for the host's timing records). */
  receivedAt?: number; playingAt?: number;
  /** Where in the audio the current source starts (seconds), and how often it was fetched again. */
  base: number; resumes: number; firstErrorAt?: number;
  /**
   * Which fetch of its audio is current (0 the first), and whether another is waiting to start: an error and a refused
   * play() may both tell of one failed fetch, and it is handled once.
   */
  fetch: number; retrying?: boolean;
  /** Whether the current source has played at all (its place counts only then). */
  sourcePlayed?: boolean;
}

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
  private listening = false;
  /** The owner muted the microphone (see `VoiceView.muted`). */
  private held = false;
  /** A voice is heard, not speech yet (see `VoiceView.hearing`). */
  private hearing = false;
  private armed = false;
  /** The audio time (seconds) from which the microphone is heard: frames captured before it are not. */
  private heardFrom = 0;
  private lastActivityAt = Date.now();
  private lastSpeechAt = 0;
  private lastReportAt = 0;
  private lastPresenceAt = 0;
  private speechToTell = false;
  private reporting = false;
  private readonly queue: Array<{ say: MasterSay; receivedAt?: number }> = [];
  /** The order of a spoken request's first response and its answer (shared/master/voice-order.ts). */
  private readonly order = new SayOrder();
  private readonly seen = new Set<string>();
  private current?: Playing;
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
      // Ended before the master answered: its new voice session is turned off too, and nothing more starts here.
      if (this.over) { void post('/api/master/voice/off', this.options.token(), { session }).catch(() => {}); return; }
      this.session = session;
      this.sessionDigest = await digest(session);
      await this.context.audioWorklet.addModule('/master-pcm-tap.js');
      await this.listen();
      if (this.over) return;
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

  /** Listening back on by the owner (unmuting too). */
  async listen(): Promise<void> {
    this.held = false;
    await this.listenAgain();
  }

  /** Listening back on, unless the owner muted the microphone. */
  private async listenAgain(): Promise<void> {
    if (this.over || this.held) return;
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

  /** The owner mutes the microphone: what the master reads aloud still plays here, and it stays muted until unmuted. */
  mute(): void {
    if (this.over) return;
    this.held = true;
    if (!this.listening) { this.show({}); return; }
    this.stopListening();
  }

  /** Listening off: the microphone is let go, but what the master reads aloud still plays here. */
  private stopListening(): void {
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

  /**
   * Hears again, from the owner's click, an answer the master could not read aloud (`MasterVoiceStatus.missed`): the
   * master reads it again whole, and the click lets its sound play when its turn comes.
   */
  replayMissed(entry: string): void {
    if (this.over || !this.session) return;
    this.show({ error: undefined });
    // It waits behind what is being said: the click lets sound play now, for when its turn comes.
    if (!this.current) this.unlock();
    void post('/api/master/voice/missed', this.options.token(), { session: this.session, entry, action: 'replay' })
      .then(done => { if (done === false) this.show({ error: '다시 들을 수 없습니다. 답은 화면에 있습니다.' }); }, (error: unknown) => this.show({ error: errorText(error) }));
  }

  /** The owner no longer wants to be told of an answer not read aloud. */
  dismissMissed(entry: string): void {
    if (this.over || !this.session) return;
    void post('/api/master/voice/missed', this.options.token(), { session: this.session, entry, action: 'dismiss' }).catch(() => {});
  }

  /** Lets sound play later without another click; called straight from one. */
  private unlock(): void {
    void this.context?.resume().catch(() => {});
    this.audio.src = '/master-silence.wav';
    void this.audio.play().then(() => { if (!this.current) this.audio.pause(); }, () => {});
  }

  /** The host's word on voice: if it is no longer this tab's session, voice ends here. */
  status(voice: MasterVoiceStatus): void {
    if (this.over || !this.sessionDigest) return;
    if (voice.session !== this.sessionDigest) this.end(voice.session ? 'replaced' : 'host');
    else if (voice.limited && this.listening) { this.stopListening(); this.show({ error: '오늘 음성 한도에 닿아 듣기를 껐습니다.' }); }
  }

  /** Something to play: only this session's, once each, not once it is stale, and never more than a few waiting. */
  say(say: MasterSay): void {
    if (this.over || say.session !== this.sessionDigest || this.seen.has(say.id) || say.expiresAt < Date.now()) return;
    this.seen.add(say.id);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value!);
    const order = this.order.admit(say, this.queue.map(item => item.say));
    for (const dropped of order.drop) { const index = this.queue.findIndex(item => item.say === dropped); if (index >= 0) this.queue.splice(index, 1); }
    if (!order.admit) return;
    this.queue.push({ say, receivedAt: Date.now() });
    while (this.queue.length > QUEUE) { const dropped = this.queue.shift()!; this.report(dropped.say, 'expired', undefined, 'queue-full'); }
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
    const utterance = this.utterance;
    if (utterance) {
      this.send(data);
      if (utterance.bytes >= UTTERANCE_BYTES - TAIL_BYTES) { void this.commit(); return; }
      const at = time * 1000;
      if (event === 'silence-commit' ? utterance.uncommitted >= SEGMENT_PAUSE_BYTES
        : utterance.uncommitted >= SEGMENT_FORCE_BYTES || (utterance.uncommitted >= SEGMENT_SOON_BYTES && at - this.gate.lastVoiceAt >= SEGMENT_QUIET_MS)) this.segment(utterance);
      if (event === 'silence-commit') { utterance.quietSince = at - this.gate.silenceMs; utterance.resumedQuietly = false; this.show({}); }
      else if (event === 'speech-start' && utterance.quietSince !== undefined) { utterance.quietSince = undefined; utterance.resumedQuietly = false; this.show({}); }
      if (utterance.quietSince !== undefined) this.paused(utterance, at - utterance.quietSince);
      else if (this.gate.isSpeaking && at - this.gate.lastVoiceAt >= this.gate.silenceMs / 2) this.prejudge(utterance);
    } else if (event === 'speech-start') this.begin();
    else {
      const hearing = this.gate.voicedMs >= HEARING_MS;
      if (hearing !== this.hearing) { this.hearing = hearing; this.show({}); }
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
    // No token ready (the last one failed): one is asked for now and the utterance waits for it, so nothing said is lost.
    if (!this.spare) this.prefetch();
    const spare = this.spare;
    this.spare = undefined;
    if (!spare) return;
    const preroll = this.preroll;
    this.preroll = [];
    this.prerollLength = 0;
    let settle!: (text: string | Error) => void;
    const done = new Promise<string>((resolve, reject) => { settle = value => value instanceof Error ? reject(value) : resolve(value); });
    done.catch(() => {});
    const utterance: Utterance = { bytes: 0, sent: 0, queue: [], open: false, closed: false, done, settle, commits: 0, segments: [], partial: '', uncommitted: 0, heard: '', judgments: 0 };
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
        // Writing that comes while the last part is awaited is kept too, in case that part never comes.
        if (message.message_type === 'partial_transcript') { if (this.utterance === utterance) this.written(utterance, String(message.text ?? '')); else utterance.partial = String(message.text ?? ''); }
        else if (message.message_type === 'committed_transcript' || message.message_type === 'committed_transcript_with_timestamps') this.committed(utterance, String(message.text ?? ''));
        else if (message.message_type && STT_ERRORS.has(message.message_type)) utterance.settle(new Error(message.error ?? message.message_type));
      };
      socket.onerror = () => utterance.settle(new Error('받아쓰기 연결이 끊겼습니다.'));
      socket.onclose = () => utterance.settle(new Error('받아쓰기 연결이 끊겼습니다.'));
    });
    this.prefetch();
  }

  /** ElevenLabs wrote down more of the part of the utterance not committed yet. */
  private written(utterance: Utterance, text: string): void {
    utterance.partial = text;
    const heard = joinSegments([...utterance.segments, text]);
    const changed = heard !== utterance.heard;
    utterance.heard = heard;
    const at = (this.context?.currentTime ?? 0) * 1000;
    // The owner is speaking again, too quietly for the gate: the pause starts over.
    if (changed && utterance.quietSince !== undefined && at - utterance.quietSince >= WRITING_LAG_MS) { utterance.quietSince = at; utterance.resumedQuietly = true; }
    this.show({ heard: this.said(heard) });
  }

  /**
   * ElevenLabs wrote down a committed part, one for each commit in order (an empty one for a silent part). Its final
   * wording is taken as is, not as new speech. Once every commit asked for is back, after the last, the utterance is
   * written down. A part beyond those asked for is one ElevenLabs committed by itself: it is counted as one of ours.
   */
  private committed(utterance: Utterance, text: string): void {
    if (utterance.closed) return;
    utterance.segments.push(text);
    utterance.partial = '';
    utterance.commits = Math.max(utterance.commits, utterance.segments.length);
    utterance.heard = joinSegments(utterance.segments);
    if (utterance.final) { if (utterance.segments.length >= utterance.commits) utterance.settle(utterance.heard); return; }
    if (this.utterance === utterance) this.show({ heard: this.said(utterance.heard) });
  }

  /** Commits what was said so far while the owner goes on: what ElevenLabs writes for it is kept, and the utterance stays open. */
  private segment(utterance: Utterance): void {
    if (utterance.bytes + 2 * TAIL_BYTES > UTTERANCE_BYTES) return;
    this.commitChunk(utterance);
  }

  /** A short silent tail carrying a commit (an empty chunk is refused). */
  private commitChunk(utterance: Utterance): void {
    utterance.bytes += TAIL_BYTES;
    utterance.commits++;
    utterance.uncommitted = 0;
    this.transmit(utterance, JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: base64(new Uint8Array(TAIL_BYTES)), sample_rate: 16_000, commit: true }), TAIL_BYTES);
  }

  /** Audio for the utterance, never past `UTTERANCE_BYTES` (the silent tail that commits it included). */
  private send(data: Float32Array): void {
    const utterance = this.utterance;
    if (!utterance || !this.context) return;
    const pcm = toPcm16(data, this.context.sampleRate);
    const allowed = fitUtterance(utterance.bytes, pcm.byteLength, TAIL_BYTES);
    if (!allowed) return;
    utterance.bytes += allowed;
    utterance.uncommitted += allowed;
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
    utterance.final = true;
    this.commitChunk(utterance);
    let text = '';
    try {
      text = (await Promise.race([utterance.done, new Promise<string>((_, reject) => setTimeout(() => reject(new Error('받아쓰기가 늦어 버렸습니다.')), COMMIT_MS))])).trim();
    } catch (error) {
      // Called off (voice ended, listening muted): nothing goes.
      if (utterance.closed) return;
      // Late or cut off: what was written down so far goes, rather than nothing.
      text = joinSegments([...utterance.segments, utterance.partial]);
      if (!text) this.show({ error: `받아쓰지 못했습니다: ${errorText(error)}` });
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
   * judged, and judged again when it changes or the pause grows; it is sent only once they seem finished. A very long
   * pause before that keeps it unsent. Without a judgment (none set up, failed or late) the page decides from the pause
   * and how the sentence ends.
   */
  private paused(utterance: Utterance, silent: number): void {
    // Loud again, perhaps speaking again: nothing is decided until it is clear.
    // New words mid-pause started it over: it is a pause again once it is as long as one.
    // Quiet speech writes more every second or so: its pauses are judged once they are longer than that, not at each word.
    if (this.gate.isVoicing || silent < (utterance.resumedQuietly ? WRITING_LAG_MS : this.gate.silenceMs)) return;
    const text = this.said(utterance.heard);
    if (utterance.asking && Date.now() - utterance.asking.at >= JUDGE_WAIT_MS) { utterance.asking = undefined; utterance.ownRule = true; }
    if (utterance.ownRule || !text) {
      if (silent >= this.gate.silenceMs + endHoldMs(text)) void this.commit();
      return;
    }
    const verdict = utterance.verdict?.text === text ? utterance.verdict : undefined;
    if (verdict && verdict.finished >= VOICE_TURN_FINISHED) { void this.commit(); return; }
    const exhausted = !utterance.asking && utterance.judgments >= JUDGMENTS;
    if (exhausted) {
      // Out of judgments: waiting on an answer that will not be asked again would keep a finished request until the
      // long pause keeps it unsent. A last judgment near the bar lets it go at the longer pause; one sure it is not
      // finished, or words not judged that trail off, wait for the owner.
      if (verdict ? verdict.finished >= EXHAUSTED_FINISHED && silent >= REASK_MS
        : endHoldMs(text) !== END_HOLD_MS.unfinished && silent >= REASK_MS + endHoldMs(text)) { void this.commit(); return; }
    } else if (!utterance.asking && (!verdict || (verdict.pauseMs < REASK_MS && silent >= REASK_MS))) this.judge(utterance, text, silent);
    if (!verdict && !exhausted) return;
    if (silent >= PARK_MS) void this.commit(true);
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
      .catch(() => { if (left > 0) setTimeout(() => attempt(left - 1), 10_000); else if (!this.over) { this.stopListening(); this.show({ error: '마스터에 닿지 않아 듣기를 껐습니다.' }); } });
    attempt(2);
  }

  // ─── playing ─────────────────────────────────────────────────────────────────────────────────────────────────

  /** Plays the next thing when nothing plays and no utterance is still being written down. */
  private next(): void {
    if (this.over || this.current || this.utterance || this.open.size) return;
    const item = this.queue.shift();
    if (!item) { this.arm(); return; }
    const say = item.say;
    // Waited too long to play (the owner kept speaking, or the page was busy): the master tells the owner it was not read.
    if (say.expiresAt < Date.now()) { this.report(say, 'expired', undefined, `waited-${Math.round((Date.now() - (item.receivedAt ?? Date.now())) / 1000)}s`); this.next(); return; }
    this.disarm();
    const current: Playing = { say, startedAt: Date.now(), ...(item.receivedAt ? { receivedAt: item.receivedAt } : {}), timers: [], base: 0, resumes: 0, fetch: 0 };
    this.current = current;
    this.show({});
    // A player that never ends or fails is given up on after a while, so the queue goes on.
    current.timers.push(setTimeout(() => { if (say.kind === 'notice') { current.failed = true; this.decideNotice(current); } else this.finishPlay(current, 'failed', current.playingAt === undefined ? 'never-started' : 'player-timeout'); },
      say.streaming ? STREAMING_PLAY_MS : Math.max(30_000, say.text.length * 200)));
    this.audio.onplaying = () => { if (this.current !== current) return; this.pace(); current.playingAt ??= Date.now(); current.sourcePlayed = true; };
    this.audio.onended = () => { if (this.current === current) say.kind === 'notice' ? this.noticeEnded(current) : this.finishPlay(current, 'played'); };
    this.audio.onerror = () => {
      if (this.current !== current) return;
      if (say.kind === 'notice') { current.failed = true; this.decideNotice(current); return; }
      this.lost(current, current.fetch);
    };
    this.audio.src = say.audio;
    this.pace();
    this.audio.play().catch((error: unknown) => {
      if (this.current !== current) return;
      if (say.kind === 'notice') { current.failed = true; this.decideNotice(current); return; }
      // Autoplay refused: the master tells the owner, who can hear it again with a click (a click lets it play).
      const blocked = error instanceof DOMException && error.name === 'NotAllowedError';
      this.finishPlay(current, blocked ? 'blocked' : 'failed', blocked ? undefined : `play-${error instanceof Error ? error.name : 'error'}`);
      if (blocked) this.show({ error: '브라우저가 소리 재생을 막았습니다.' });
    });
  }

  /**
   * An answer whose audio was cut off partway (the web restarting in the middle) is fetched again from where it was,
   * a few times within a while: `base` keeps the place in the whole audio across several cuts.
   */
  /** The current fetch of an answer failed: fetched again if it can be, otherwise the answer failed. Once per fetch. */
  private lost(current: Playing, fetch: number): void {
    if (this.current !== current || fetch !== current.fetch || current.retrying) return;
    if (!this.resume(current)) this.finishPlay(current, 'failed', current.resumes >= RESUMES ? 'resumes-used' : `media-error-${this.audio.error?.code ?? 0}`);
  }

  private resume(current: Playing): boolean {
    const kind = current.say.kind;
    if ((kind !== 'answer' && kind !== 'report') || current.playingAt === undefined || current.resumes >= RESUMES) return false;
    const now = Date.now();
    current.firstErrorAt ??= now;
    if (now - current.firstErrorAt > RESUME_WITHIN_MS) return false;
    current.resumes++;
    const at = current.base + (current.sourcePlayed && Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : 0);
    current.base = at;
    current.sourcePlayed = false;
    current.retrying = true;
    current.timers.push(setTimeout(() => {
      if (this.current !== current) return;
      current.retrying = false;
      const fetch = ++current.fetch;
      this.audio.src = `${current.say.audio}?at=${at.toFixed(2)}`;
      this.pace();
      // Refused again (the web still away): another try, while tries and time are left.
      this.audio.play().catch(() => this.lost(current, fetch));
    }, 1_000 * current.resumes));
    return true;
  }

  /**
   * Plays at the speed set now, pitch kept: for each source (a new one starts at the default rate), when its sound
   * starts, and while it plays, so a speed chosen meanwhile is heard at once. `currentTime` stays the place in the
   * audio itself, so fetching again from there is unchanged.
   */
  private pace(): void {
    applyPlaybackRate(this.audio, this.options.settings().playbackRate);
  }

  /** `detail`: what failed, for the master's timing records (a media error, the player given up on, …). */
  private finishPlay(current: Playing, result: 'played' | 'stopped' | 'failed' | 'blocked', detail?: string): void {
    if (this.current !== current || current.say.kind === 'notice') return;
    for (const timer of current.timers) clearTimeout(timer);
    this.current = undefined;
    this.audio.pause();
    this.report(current.say, result, current.playingAt !== undefined && current.receivedAt !== undefined ? current.playingAt - current.receivedAt : undefined, detail);
    // A report read aloud turns listening back on, so the owner can answer it.
    if (current.say.kind === 'report' && result === 'played') { this.lastActivityAt = Date.now(); void this.listenAgain(); }
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

  /**
   * Tells the host how something it gave to play went (and how long the sound took to start), tried again a few
   * times so a web restarting just then does not lose it.
   */
  private report(say: MasterSay, result: string, startedMs?: number, detail?: string): void {
    if (say.kind === 'ack' || say.kind === 'working') return;
    const send = (left: number) => void post('/api/master/voice/played', this.options.token(), { session: this.session, id: say.id, result, ...(startedMs !== undefined ? { startedMs } : {}), ...(detail ? { detail } : {}) })
      .catch(() => { if (left > 0 && !this.over) setTimeout(() => send(left - 1), 3_000); });
    send(3);
  }

  // ─── keeping the master told ─────────────────────────────────────────────────────────────────────────────────

  private tick(): void {
    if (this.over) return;
    const now = Date.now();
    if (this.current) this.pace();
    if (this.listening && !this.utterance && !this.current && listenExpired(this.lastActivityAt, this.options.settings().listenMinutes, now)) this.stopListening();
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
      const known = await post<boolean>('/api/master/voice/presence', this.options.token(), { session: this.session, listening: this.listening });
      if (known === false) this.end('replaced');
    } catch { /* Tried again in a few seconds. */ }
  }

  private show(change: Partial<VoiceView>): void {
    const utterance = this.utterance;
    const waiting = Boolean(utterance && utterance.quietSince !== undefined && !utterance.ownRule && utterance.verdict && utterance.verdict.finished < VOICE_TURN_FINISHED);
    if (utterance || this.current || !this.armed) this.hearing = false;
    const hearing = this.hearing;
    this.view = { ...this.view, ...change, listening: this.listening, muted: this.held || undefined, capturing: Boolean(utterance), hearing, waiting, draft: this.draft || undefined, playing: this.current ? { kind: this.current.say.kind, text: this.current.say.text } : undefined };
    this.options.onView(this.view);
  }
}
