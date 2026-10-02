import { VoiceSession } from '../../client/src/master/voice-client';

const win = window as any;
const config: { pcm: boolean; rate: number } = win.__voiceFixture;
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
    audio.addEventListener(event, () => win.events.push({ event, position: audio.currentTime, at: Date.now(), src: audio.src }));
  return audio;
} as any;
if (config.pcm) setInterval(() => {
  const data = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(data);
  win.rmsMax = Math.max(win.rmsMax, Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length));
}, 25);
// Generated silent media track: no personal microphone permission or device access.
navigator.mediaDevices.getUserMedia = async () => {
  const synthetic = new AudioContext(); win.synthetic = synthetic;
  return synthetic.createMediaStreamDestination().stream;
};
const voice = new VoiceSession({
  token: () => 'fixture-only', tabId: '00000000-0000-4000-8000-000000000001',
  settings: () => ({ voiceId: 'fixture', model: 'eleven_v3_conversational', endSilenceMs: 1000, listenMinutes: 5, readReports: true, dailyDollars: 0, playbackRate: config.rate }),
  viewContext: () => undefined, onView: view => win.views.push(view), onEnded: reason => { win.ended = reason; },
});
win.voice = voice;
const stream = new EventSource('/fixture/events');
stream.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.type === 'say') { win.received.push(message.say); voice.say(message.say); }
};
document.getElementById('start')!.onclick = async () => { await context.resume(); await voice.start(); voice.mute(); win.started = true; };
