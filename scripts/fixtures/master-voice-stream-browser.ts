import { VoiceSession } from '../../client/src/master/voice-client';

const win = window as any;
const config: { pcm: boolean; rate: number; observeGate?: boolean } = win.__voiceFixture;
win.events = []; win.views = []; win.rmsMax = config.pcm ? 0 : null; win.received = [];
const OriginalAudio = window.Audio;
const context = new AudioContext();
const analyser = context.createAnalyser(); analyser.fftSize = 2048;
if (config.pcm) analyser.connect(context.destination);
win.audio = [];
window.Audio = function (...args: any[]) {
  const audio = new OriginalAudio(...args); win.audio.push(audio);
  if (config.pcm) context.createMediaElementSource(audio).connect(analyser);
  for (const event of ['playing', 'waiting', 'ended', 'error', 'timeupdate'])
    audio.addEventListener(event, () => win.events.push({ event, position: audio.currentTime, at: Date.now(), src: audio.src,
      ...(config.observeGate ? { armed: win.voice?.armed } : {}) }));
  return audio;
} as any;
if (config.pcm) setInterval(() => {
  const data = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(data);
  win.rmsMax = Math.max(win.rmsMax, Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length));
}, 25);
// Generated silent media track: no personal microphone permission or device access.
// Keep the producer for this page's lifetime; stop() releases each consumer clone, not the source.
let synthetic: AudioContext | undefined;
let syntheticDestination: MediaStreamAudioDestinationNode | undefined;
win.syntheticDiagnostics = [];
// Preserve the overridden DOM wrapper for the full test page lifetime, including a later listen click.
const mediaDevices = navigator.mediaDevices;
win.syntheticMediaDevices = mediaDevices;
const syntheticGetUserMedia = async () => {
  let stage = 'constructor';
  const diagnostic: any = { at: Date.now(), reusedProducer: Boolean(syntheticDestination) };
  win.syntheticDiagnostics.push(diagnostic);
  try {
    if (!synthetic) { synthetic = new AudioContext(); win.synthetic = synthetic; }
    stage = 'destination';
    syntheticDestination ??= synthetic.createMediaStreamDestination();
    stage = 'clone';
    const stream = syntheticDestination.stream.clone();
    Object.assign(diagnostic, { stage: 'complete', contextState: synthetic.state, trackStates: stream.getTracks().map(track => track.readyState) });
    return stream;
  } catch (error) {
    Object.assign(diagnostic, { stage, errorName: error instanceof Error ? error.name : 'unknown' });
    throw error;
  }
};
mediaDevices.getUserMedia = syntheticGetUserMedia;
win.syntheticGetUserMedia = syntheticGetUserMedia;
const voice = new VoiceSession({
  token: () => 'fixture-only', tabId: '00000000-0000-4000-8000-000000000001',
  settings: () => ({ voiceId: 'fixture', model: 'eleven_v3_conversational', endSilenceMs: 1000, listenMinutes: 5, readReports: true, dailyDollars: 0, playbackRate: config.rate }),
  viewContext: () => undefined, onView: view => win.views.push(view), onEnded: reason => { win.ended = reason; },
});
win.voice = voice;
const listenSnapshot = () => {
  const state = voice as unknown as { readonly over: boolean; readonly listening: boolean; readonly held: boolean;
    readonly stream?: MediaStream; readonly context?: AudioContext; readonly current?: { say: { kind: string } }; readonly open: { size: number } };
  return { at: Date.now(), over: state.over, listening: state.listening, held: state.held, streamDefined: Boolean(state.stream),
    streamTrackStates: state.stream?.getTracks().map(track => track.readyState),
    contextDefined: Boolean(state.context), contextState: state.context?.state, currentKind: state.current?.say.kind, openSize: state.open.size,
    mediaDevicesIdentityMatches: navigator.mediaDevices === mediaDevices,
    getUserMediaIdentityMatches: navigator.mediaDevices.getUserMedia === syntheticGetUserMedia };
};
// Read-only fixture observation; listening itself goes through the public listen() method.
if (config.observeGate) {
  win.gateStates = [];
  let pendingKey = '';
  setInterval(() => {
    const armed = (voice as unknown as { readonly armed: boolean }).armed;
    if (win.gateStates.at(-1)?.armed !== armed) win.gateStates.push({ armed, at: Date.now() });
    if (win.listenDiagnostics?.phase === 'pending') {
      const snapshot = listenSnapshot(); const { at, ...fields } = snapshot;
      const key = JSON.stringify(fields);
      if (key !== pendingKey && win.listenDiagnostics.pending.length < 32) {
        win.listenDiagnostics.pending.push(snapshot); pendingKey = key;
      }
    }
  }, 10);
}
const stream = new EventSource('/fixture/events');
stream.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.type === 'say') { win.received.push(message.say); voice.say(message.say); }
};
document.getElementById('start')!.onclick = async () => { await context.resume(); await voice.start(); voice.mute(); win.started = true; };
document.getElementById('listen')!.onclick = async () => {
  win.listenDiagnostics = { phase: 'pending', before: listenSnapshot(), pending: [] };
  try {
    if (!win.listenDiagnostics.before.mediaDevicesIdentityMatches || !win.listenDiagnostics.before.getUserMediaIdentityMatches)
      throw new Error('Fixture synthetic microphone override was lost before listen');
    await voice.listen();
    win.listenDiagnostics.after = listenSnapshot(); win.listenDiagnostics.phase = 'completed'; win.listenCompleted = true;
  } catch (error) {
    win.listenDiagnostics.after = listenSnapshot(); win.listenDiagnostics.phase = 'failed';
    win.listenDiagnostics.errorName = error instanceof Error ? error.name : 'unknown';
    throw error;
  }
};
