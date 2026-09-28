import { Mic, MicOff, Play, Send, Square, Volume2, VolumeX, X } from 'lucide-react';
import type { MasterVoiceStatus } from '../../../shared/master';
import type { VoiceView } from './voice-client';
import { useWords } from './strings';

/** Voice as the panel shows it, and what the owner can do about it. */
export interface VoiceControls {
  /** Why voice cannot be turned on here, if it cannot. */
  unavailable?: string;
  view: VoiceView | null;
  /** How voice last ended in this tab, until it is turned on again or dismissed. */
  ended: { reason: string; error?: string } | null;
  status?: MasterVoiceStatus;
  start(): void;
  stop(): void;
  listen(): void;
  mute(): void;
  skip(): void;
  /** Plays what the browser would not play by itself. */
  replay(): void;
  /** Sends what is being said, or what waits unsent, now. */
  finish(): void;
  /** Drops what waits unsent. */
  discard(): void;
  dismiss(): void;
}

/** Today's voice use on this computer (estimated), always in view with voice. */
export function voiceUsage(status: MasterVoiceStatus | undefined, words: (ko: string, en: string) => string): string {
  if (!status) return '';
  const limit = status.limitDollars ? ` / $${status.limitDollars.toFixed(2)}` : '';
  return `${words('오늘', 'Today')} $${status.today.dollars.toFixed(2)}${limit} · ${words(`받아쓰기 ${Math.round(status.today.sttSeconds)}초, 읽기 ${status.today.ttsChars}자`, `${Math.round(status.today.sttSeconds)}s heard, ${status.today.ttsChars} chars read`)}`;
}

function endText(ended: { reason: string; error?: string }, words: (ko: string, en: string) => string): string {
  switch (ended.reason) {
    case 'owner': return words('음성을 껐습니다.', 'Voice is off.');
    case 'replaced': return words('다른 탭에서 음성을 켰습니다.', 'Voice was turned on in another tab.');
    case 'host': return words('마스터가 다시 시작해 음성이 꺼졌습니다. 다시 켜 주세요.', 'The master restarted and voice turned off. Turn it on again.');
    default: return `${words('음성을 켜지 못했습니다', 'Voice could not start')}${ended.error ? `: ${ended.error}` : '.'}`;
  }
}

/** Voice in this tab: listening or not, what is being heard or read aloud, and today's use. */
export function VoiceBar({ voice }: { voice: VoiceControls }) {
  const words = useWords();
  const usage = voiceUsage(voice.status, words);
  const view = voice.view;
  if (view) {
    const playing = view.playing;
    const label = playing ? (playing.kind === 'notice' ? `${words('되돌릴 수 없는 작업', 'Irreversible change')}: ${playing.text}` : playing.text)
      : view.capturing ? `${view.waiting ? words('듣고 있어요 · 이어서 말씀하세요', 'Listening · go on') : words('듣고 있어요', 'Listening')}: ${view.heard || '…'}`
      : view.hearing ? `${words('듣고 있어요', 'Listening')}: ${view.draft ? `${view.draft} …` : '…'}`
      : view.draft ? `${words('아직 보내지 않은 말', 'Not sent yet')}: ${view.draft}`
      : view.listening ? (view.heard ? `${words('들은 말', 'Heard')}: ${view.heard}` : words('듣는 중 — 말씀하세요', 'Listening — go ahead'))
      : words('음성 켜짐 · 맡긴 일 소식은 읽어 드려요', 'Voice on · news of finished work is read aloud');
    // What is heard or read aloud has a line of its own; today's use sits beside the buttons below it, so neither covers the other.
    return <div className={`master-voice live ${view.capturing || view.hearing ? 'speaking' : playing ? 'playing' : ''}`}>
      <div className="master-voice-now" role="status">
        <span className="master-voice-dot" aria-hidden />
        {playing ? <Volume2 size={13} /> : view.listening ? <Mic size={13} /> : <MicOff size={13} />}
        <span className="master-voice-label"><span>{label}</span></span>
      </div>
      {view.error && <small className="master-voice-error">{view.error}</small>}
      <div className="master-voice-controls">
      {usage && <small className="master-voice-usage">{usage}</small>}
      <div className="master-voice-actions">
        {!playing && view.blocked && <button className="master-voice-restart" onClick={voice.replay} title={view.blocked.text}><Play size={12} />{words('듣기', 'Play')}</button>}
        {!playing && (view.capturing || view.draft) && <button className="master-voice-restart" onClick={voice.finish} title={words('말이 끝났다고 보고 지금 보내기', 'Done speaking: send it now')}><Send size={12} />{words('보내기', 'Send')}</button>}
        {!playing && !view.capturing && view.draft && <button className="secondary-button" onClick={voice.discard}><X size={12} />{words('지우기', 'Discard')}</button>}
        {playing && <button className="master-voice-restart" onClick={voice.skip}><Square size={12} />{playing.kind === 'notice' ? words('취소', 'Cancel') : words('멈춤', 'Stop')}</button>}
        {!playing && (view.listening
          ? <button className="secondary-button" onClick={voice.mute}><MicOff size={12} />{words('듣기 끄기', 'Stop listening')}</button>
          : <button className="master-voice-restart" onClick={voice.listen}><Mic size={12} />{words('다시 듣기', 'Listen')}</button>)}
        <button className="master-voice-end" onClick={voice.stop} title={words('음성 끄기 (맡긴 일은 계속됩니다)', 'Voice off (work already sent continues)')}><VolumeX size={12} />{words('음성 끄기', 'Voice off')}</button>
      </div>
      </div>
    </div>;
  }
  if (voice.ended && voice.ended.reason !== 'owner') {
    return <div className="master-voice ended" role="status">
      <span className="master-voice-label">{endText(voice.ended, words)}</span>
      <button className="master-voice-restart" onClick={voice.start} disabled={Boolean(voice.unavailable)}><Mic size={13} />{words('다시 켜기', 'Turn on')}</button>
      <button className="icon-button" onClick={voice.dismiss} aria-label={words('닫기', 'Dismiss')}><X size={13} /></button>
    </div>;
  }
  return usage && !voice.unavailable ? <div className="master-voice idle"><small>{words('음성', 'Voice')} · {usage}</small></div> : null;
}
