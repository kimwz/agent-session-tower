import { LoaderCircle, Mic, PhoneOff, X } from 'lucide-react';
import type { MasterVoiceStatus } from '../../../shared/master';
import type { CallView } from './voice-client';
import { endReason } from './voice-sound';
import { useWords } from './strings';

/** The call as the panel shows it, and what the owner can do about it. */
export interface VoiceControls {
  supported: boolean;
  view: CallView | null;
  /** How the last call in this tab ended, until the next one starts. */
  end: { reason: string; error?: string } | null;
  status?: MasterVoiceStatus;
  start(): void;
  stop(): void;
  dismiss(): void;
}

/** Today's voice use on this computer, always in view with the call. */
export function voiceUsage(status: MasterVoiceStatus | undefined, words: (ko: string, en: string) => string): string {
  if (!status) return '';
  const minutes = Math.floor(status.today.seconds / 60), seconds = status.today.seconds % 60;
  const time = minutes ? words(`${minutes}분 ${seconds}초`, `${minutes}m ${seconds}s`) : words(`${seconds}초`, `${seconds}s`);
  return `${words('오늘', 'Today')} ${time} · $${status.today.dollars.toFixed(2)}${status.limitMinutes ? ` / ${words(`${status.limitMinutes}분`, `${status.limitMinutes}m`)}` : ''}`;
}

/** The running call (who is talking, today's use, end), or how the last one ended with a restart right there. */
export function VoiceBar({ voice }: { voice: VoiceControls }) {
  const words = useWords();
  const usage = voiceUsage(voice.status, words);
  const view = voice.view;
  if (view) {
    const label = view.phase === 'starting' ? words('음성 연결 중…', 'Connecting voice…') : view.phase === 'ending' ? words('음성 끝내는 중…', 'Ending voice…')
      : view.notice ? `${words('안내', 'Notice')}: ${view.notice}` : view.speaking ? words('듣는 중', 'Listening') : view.playing ? words('말하는 중', 'Speaking') : words('음성 켜짐', 'Voice on');
    return <div className={`master-voice live ${view.speaking ? 'speaking' : view.playing ? 'playing' : ''}`} role="status">
      {view.phase === 'live' ? <span className="master-voice-dot" aria-hidden /> : <LoaderCircle size={13} className="spin" />}
      <span className="master-voice-label">{label}</span>
      {usage && <small>{usage}</small>}
      <button className="master-voice-end" onClick={voice.stop} disabled={view.phase === 'ending'} title={words('음성 끊기 (맡긴 일은 계속됩니다)', 'End voice (work already sent continues)')}><PhoneOff size={13} />{words('끊기', 'End')}</button>
    </div>;
  }
  if (!voice.end) return usage && voice.status?.today.seconds ? <div className="master-voice idle"><small>{words('음성', 'Voice')} · {usage}</small></div> : null;
  const pending = voice.status?.pending ?? 0;
  return <div className="master-voice ended" role="status">
    <span className="master-voice-label">{voice.end.error ?? endReason(voice.end.reason, words)}{pending ? words(` 전할 소식 ${pending}개가 기다립니다.`, ` ${pending} update${pending > 1 ? 's' : ''} waiting.`) : ''}</span>
    {usage && <small>{usage}</small>}
    <button className="master-voice-restart" onClick={voice.start} disabled={!voice.supported}><Mic size={13} />{words('다시 시작', 'Restart')}</button>
    <button className="icon-button" onClick={voice.dismiss} aria-label={words('닫기', 'Dismiss')}><X size={13} /></button>
  </div>;
}
