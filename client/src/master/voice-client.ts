import type { MasterVoiceStatus } from '../../../shared/master';
import { post } from './api';
import { activityReport, createHearing, digest, hear, leaseVerdict, noticeResult, silenceDue } from './voice-sound';

const FRAME_MS = 20;
const REPORT_MS = 2_000;
const ICE_MS = 5_000;
const START_MS = 60_000;
const STARTED_MS = 15_000;
const NOTICE_MS = 12_000;
const PLAYBACK_RMS = 0.005;

export type CallPhase = 'starting' | 'live' | 'ending';
export interface CallView { phase: CallPhase; speaking: boolean; playing: boolean; notice?: string }

export interface CallOptions {
  token: () => string;
  tabId: string;
  wake: boolean;
  silenceSeconds: () => number;
  onView(view: CallView): void;
  /** The call is over here; `reason` as the host would say it, `error` when it could not start. */
  onEnded(reason: string, error?: string): void;
}

const timeout = <T,>(promise: Promise<T>, ms: number, message: string) => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(message)), ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

/**
 * One voice call from this tab. The browser makes the WebRTC connection to GPT-Live with the answer the host got; it
 * never holds a key. It listens to the microphone and the call to know when the owner speaks and when the call plays,
 * ends the call after a quiet while, reports what it hears, and says Tower's notices itself.
 */
export class VoiceCall {
  readonly attemptId = crypto.randomUUID();
  private attemptHash = '';
  private pc?: RTCPeerConnection;
  private mic?: MediaStream;
  private audio?: HTMLAudioElement;
  private context?: AudioContext;
  private micAnalyser?: AnalyserNode;
  private remoteAnalyser?: AnalyserNode;
  private hearing = createHearing();
  private loop?: ReturnType<typeof setInterval>;
  private phase: CallPhase = 'starting';
  private speaking = false;
  private playing = false;
  private lastSpeechAt = 0;
  private lastPlaybackAt = 0;
  private readyAt = 0;
  private lastReportAt = 0;
  private reporting = false;
  private notice?: { id: string; text: string; startedAt: number; endedAt?: number; failed?: boolean; volume: number };
  private status?: MasterVoiceStatus;
  private lastLeaseAt = Date.now();
  private connected = true;
  private disconnectedAt?: number;
  private over = false;

  constructor(private readonly options: CallOptions) {}

  /** Connects, and resolves once the call is live; on any failure the host is told and everything is let go. */
  async start(): Promise<void> {
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') throw new Error('음성은 https 주소나 이 컴퓨터(localhost)에서 마이크를 쓸 수 있을 때만 됩니다.');
      // Made while the owner's press still counts, so the browser lets the call be heard.
      const context = this.context = new AudioContext();
      const resumed = context.resume().catch(() => {});
      const audio = this.audio = new Audio();
      audio.autoplay = true;
      this.attemptHash = await digest(this.attemptId);
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      this.throwIfOver();
      const pc = this.pc = new RTCPeerConnection();
      const remote = new Promise<MediaStream>(resolve => { pc.ontrack = event => resolve(event.streams[0] ?? new MediaStream([event.track])); });
      for (const track of this.mic.getAudioTracks()) pc.addTrack(track, this.mic);
      const channel = pc.createDataChannel('oai-events');
      const started = new Promise<void>((resolve, reject) => {
        channel.onmessage = message => {
          let event: { type?: string; error?: { message?: string } };
          try { event = JSON.parse(String(message.data)); } catch { return; }
          if (event.type === 'session.started') resolve();
          else if (event.type === 'session.closed') { reject(new Error('음성 세션이 끝났습니다.')); this.end('closed'); }
          else if (event.type === 'error' && this.phase === 'starting') reject(new Error(event.error?.message ?? '음성 오류'));
        };
      });
      started.catch(() => {});
      pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.end('connection'); };
      await pc.setLocalDescription(await pc.createOffer());
      await this.gathered(pc);
      this.throwIfOver();
      const answer = await timeout(post<{ sdp: string }>('/api/master/voice/start', this.options.token(), { attemptId: this.attemptId, sdp: pc.localDescription?.sdp, tabId: this.options.tabId, wake: this.options.wake }), START_MS, '음성 시작이 너무 오래 걸립니다.');
      this.throwIfOver();
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      const stream = await timeout(remote, STARTED_MS, '음성이 연결되지 않았습니다.');
      audio.srcObject = stream;
      await audio.play();
      await resumed;
      if (context.state !== 'running') await context.resume();
      this.micAnalyser = analyser(context, this.mic, 1024);
      this.remoteAnalyser = analyser(context, stream, 256);
      await timeout(started, STARTED_MS, '음성 세션이 시작되지 않았습니다.');
      if (context.state !== 'running' || audio.paused) throw new Error('소리를 재생할 수 없습니다. 페이지를 한 번 누른 뒤 다시 시작해 주세요.');
      this.throwIfOver();
      if (!await post<boolean>('/api/master/voice/ready', this.options.token(), { attemptId: this.attemptId })) throw new Error('음성이 준비되기 전에 끝났습니다.');
      this.readyAt = Date.now();
      this.phase = 'live';
      this.show();
      this.loop = setInterval(() => this.tick(), FRAME_MS);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!this.over) {
        void post('/api/master/voice/stop', this.options.token(), { attemptId: this.attemptId, reason: 'failed' }).catch(() => {});
        this.end('failed', message);
      }
      // What arrived after the call was already ended here (a microphone allowed late) is let go too.
      this.release();
      throw error;
    }
  }

  /** Ends the call from here: by hand or on silence. The sound stops at once; the host closes the session. */
  async stop(reason: 'owner' | 'silence'): Promise<void> {
    if (this.over || this.phase === 'ending') return;
    this.phase = 'ending';
    if (this.audio) this.audio.muted = true;
    window.speechSynthesis?.cancel();
    this.show();
    // Tried twice: the host must hear why the call ended (a quiet end may be woken by news later).
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await post('/api/master/voice/stop', this.options.token(), { attemptId: this.attemptId, reason }); break; }
      catch { if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 1_000)); }
    }
    this.end(reason);
  }

  /** The host's word on the call, every few seconds while it lasts. */
  lease(status: MasterVoiceStatus): void {
    this.status = status;
    this.lastLeaseAt = Date.now();
    this.check();
  }

  /** Whether the page's live stream from the host is up. */
  stream(connected: boolean): void {
    if (connected && !this.connected) this.lastLeaseAt = Date.now();
    if (!connected && this.connected) this.disconnectedAt = Date.now();
    this.connected = connected;
  }

  /** A sentence Tower says before an irreversible change; the call's own voice is silent meanwhile. */
  say(notice: { id: string; attempt: string; text: string }): void {
    if (this.over || this.phase !== 'live' || notice.attempt !== this.attemptHash) return;
    if (this.notice) this.decide('failed');
    const volume = this.audio?.volume ?? 1;
    this.notice = { id: notice.id, text: notice.text, startedAt: Date.now(), volume };
    if (!window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') { this.notice.failed = true; return; }
    if (this.audio) this.audio.volume = 0;
    const current = this.notice;
    const utterance = new SpeechSynthesisUtterance(notice.text);
    utterance.lang = 'ko-KR';
    utterance.onend = () => { if (this.notice === current) current.endedAt = Date.now(); };
    utterance.onerror = () => { if (this.notice === current) current.failed = true; };
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    this.show();
  }

  /** Lets go of everything here without asking the host (it ended the call, or never had it). */
  end(reason: string, error?: string): void {
    if (this.over) return;
    this.over = true;
    if (this.loop) clearInterval(this.loop);
    if (this.notice) { window.speechSynthesis?.cancel(); void post('/api/master/voice/notice', this.options.token(), { noticeId: this.notice.id, result: 'failed' }).catch(() => {}); }
    this.notice = undefined;
    this.release();
    this.options.onEnded(reason, error);
  }

  /** Lets go of the microphone, the connection and the sound; safe to do again for what arrived late. */
  private release(): void {
    for (const track of this.mic?.getTracks() ?? []) track.stop();
    if (this.pc && this.pc.signalingState !== 'closed') this.pc.close();
    if (this.audio) { this.audio.pause(); this.audio.srcObject = null; }
    if (this.context && this.context.state !== 'closed') void this.context.close().catch(() => {});
  }

  private throwIfOver(): void { if (this.over) throw new Error('음성을 멈췄습니다.'); }

  private gathered(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ICE_MS);
      pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } });
    });
  }

  private tick(): void {
    if (this.over) return;
    const now = Date.now();
    const wasSpeaking = this.speaking, wasPlaying = this.playing;
    if (this.micAnalyser && this.context) {
      const bins = new Float32Array(this.micAnalyser.frequencyBinCount);
      this.micAnalyser.getFloatFrequencyData(bins);
      const power = bins.map(db => Number.isFinite(db) ? 10 ** (db / 10) : 0);
      this.speaking = hear(this.hearing, power, this.context.sampleRate / this.micAnalyser.fftSize, now);
      if (this.speaking) this.lastSpeechAt = now;
    }
    const audio = this.audio;
    const noticePlaying = Boolean(this.notice && !this.notice.endedAt && !this.notice.failed);
    this.playing = noticePlaying || Boolean(audio && !audio.paused && !audio.muted && audio.volume > 0 && this.remoteAnalyser && rms(this.remoteAnalyser) > PLAYBACK_RMS);
    if (this.playing) this.lastPlaybackAt = now;
    if (this.notice) {
      const result = now - this.notice.startedAt > NOTICE_MS && !this.notice.endedAt ? 'failed' : noticeResult({ ...this.notice, lastSpeechAt: this.lastSpeechAt, now });
      if (result) this.decide(result);
    }
    // The owner starting to speak is told at once (it may hold back a change); the rest every two seconds.
    if ((this.speaking && !wasSpeaking && now - this.lastReportAt >= 250) || now - this.lastReportAt >= REPORT_MS) this.report(now);
    if (this.speaking !== wasSpeaking || this.playing !== wasPlaying) this.show();
    if (this.phase === 'live' && silenceDue({ now, readyAt: this.readyAt, lastSpeechAt: this.lastSpeechAt, lastPlaybackAt: this.lastPlaybackAt, seconds: this.options.silenceSeconds() })) void this.stop('silence');
    this.check();
  }

  private decide(result: 'played' | 'interrupted' | 'failed'): void {
    const notice = this.notice;
    if (!notice) return;
    this.notice = undefined;
    if (!notice.endedAt) window.speechSynthesis?.cancel();
    if (this.audio) this.audio.volume = notice.volume;
    void post('/api/master/voice/notice', this.options.token(), { noticeId: notice.id, result }).catch(() => {});
    // A fresh word on what was heard, which a change waiting on the notice needs before it goes.
    this.lastReportAt = 0;
    this.show();
  }

  /** What this page hears goes to the host; a report the host no longer takes means the call is over there. */
  private report(now: number): void {
    if (this.reporting || this.phase !== 'live') return;
    this.reporting = true;
    this.lastReportAt = now;
    void post<boolean>('/api/master/voice/activity', this.options.token(), { attemptId: this.attemptId, ...activityReport({ speaking: this.speaking, playing: this.playing, lastSpeechAt: this.lastSpeechAt, lastPlaybackAt: this.lastPlaybackAt }, Date.now()) })
      .then(known => { if (known === false) this.end('closed'); })
      .catch(() => { /* The web may be restarting: the next report carries what was missed. */ })
      .finally(() => { this.reporting = false; });
  }

  private check(): void {
    if (this.over || this.phase === 'starting' || !this.attemptHash) return;
    const verdict = leaseVerdict({ status: this.status, attemptHash: this.attemptHash, connected: this.connected, lastLeaseAt: this.lastLeaseAt, disconnectedAt: this.disconnectedAt, now: Date.now() });
    if (verdict === 'ended') this.end(this.status?.attempt === this.attemptHash ? this.status.reason ?? 'closed' : 'taken-over');
    else if (verdict === 'lost') this.end('connection');
  }

  private show(): void {
    this.options.onView({ phase: this.phase, speaking: this.speaking, playing: this.playing, ...(this.notice ? { notice: this.notice.text } : {}) });
  }
}

function analyser(context: AudioContext, stream: MediaStream, size: number): AnalyserNode {
  const node = context.createAnalyser();
  node.fftSize = size;
  node.smoothingTimeConstant = 0.2;
  context.createMediaStreamSource(stream).connect(node);
  return node;
}

function rms(node: AnalyserNode): number {
  const samples = new Float32Array(node.fftSize);
  node.getFloatTimeDomainData(samples);
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}
