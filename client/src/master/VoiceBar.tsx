import { useLayoutEffect, useRef } from 'react';
import { Mic, MicOff, Play, Send, Square, Volume2, X } from 'lucide-react';
import type { MasterMissed, MasterVoiceStatus } from '../../../shared/master';
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
  /** Hears again an answer the master could not read aloud (`MasterVoiceStatus.missed`), or stops being told of it. */
  replayMissed(entry: string): void;
  dismissMissed(entry: string): void;
  /** Sends what is being said, or what waits unsent, now. */
  finish(): void;
  /** Drops what waits unsent. */
  discard(): void;
  dismiss(): void;
  /**
   * Where the voice bar has no floating button beside it (the master's panel covers it), the bar ends voice itself.
   */
  end?: () => void;
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

/** Why an answer was not read aloud, as the owner is told beside the voice. */
export function missedText(missed: MasterMissed, words: (ko: string, en: string) => string): string {
  if (missed.reason === 'empty') return words('읽을 내용이 없어 소리로 읽지 않았어요. 답은 화면에 있어요.', 'Nothing in the answer could be read aloud; it is on the screen.');
  const why: Record<Exclude<MasterMissed['reason'], 'empty'>, [string, string]> = {
    failed: ['재생이 끊겼어요', 'playback failed'],
    timeout: ['페이지가 재생 결과를 알리지 않았어요', 'the page never told how it went'],
    expired: ['재생 차례를 너무 오래 기다렸어요', 'it waited too long to play'],
    blocked: ['브라우저가 소리 재생을 막았어요', 'the browser blocked sound'],
    audio: ['음성을 만들지 못했어요', 'its speech could not be made'],
    limit: ['오늘 음성 한도에 닿았어요', "today's voice limit was reached"],
    queue: ['읽을 답이 너무 많이 밀렸어요', 'too much was waiting to be read'],
    away: ['음성이 켜진 페이지가 없었어요', 'no page had voice on'],
    stopped: ['멈췄어요', 'it was stopped'],
    restart: ['마스터가 다시 시작했어요', 'the master restarted'],
  };
  const [ko, en] = why[missed.reason];
  return missed.heard ? words(`답을 끝까지 읽지 못했어요 · ${ko}`, `The answer was not read to its end: ${en}`) : words(`답을 소리로 읽지 못했어요 · ${ko}`, `The answer was not read aloud: ${en}`);
}

/** How close to the end a scroller must be to keep following it (px). */
const FOLLOW_SLACK = 8;
/** Whether `box` is scrolled to its end, so what is added next should be followed. */
export function atEnd(box: Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= FOLLOW_SLACK;
}

/**
 * Keeps what is heard showing its latest words as it grows or its box changes height, unless the owner scrolled up
 * to read what came before; scrolling back down, or new speech, follows again. Marks the box while earlier words are
 * out of sight above.
 */
function useFollowEnd(text: string, writing: boolean, long: boolean) {
  const box = useRef<HTMLSpanElement>(null);
  const follow = useRef(true);
  const wasWriting = useRef(false);
  const mark = (element: HTMLElement) => element.classList.toggle('scrolled', element.scrollTop > 0);
  useLayoutEffect(() => {
    if (writing && !wasWriting.current) follow.current = true;
    wasWriting.current = writing;
    const element = box.current;
    if (!element) return;
    if (follow.current) element.scrollTop = element.scrollHeight;
    mark(element);
  }, [text, writing, long]);
  const onScroll = () => {
    const element = box.current;
    if (!element) return;
    follow.current = atEnd(element);
    mark(element);
  };
  return { ref: box, onScroll };
}

/** Voice in this tab: listening or not, what is being heard or read aloud, and today's use. */
export function VoiceBar({ voice }: { voice: VoiceControls }) {
  const words = useWords();
  const usage = voiceUsage(voice.status, words);
  const view = voice.view;
  const writing = Boolean(view && !view.playing && (view.capturing || view.hearing));
  const long = Boolean(view && (writing || (!view.playing && view.draft)));
  const follow = useFollowEnd(view ? `${view.heard ?? ''}|${view.draft ?? ''}|${view.playing?.text ?? ''}` : '', writing, long);
  if (view) {
    const playing = view.playing;
    const missed = voice.status?.missed;
    const label = playing ? (playing.kind === 'notice' ? `${words('되돌릴 수 없는 작업', 'Irreversible change')}: ${playing.text}` : playing.text)
      : view.capturing ? `${view.waiting ? words('듣고 있어요 · 이어서 말씀하세요', 'Listening · go on') : words('듣고 있어요', 'Listening')}: ${view.heard || '…'}`
      : view.hearing ? `${words('듣고 있어요', 'Listening')}: ${view.draft ? `${view.draft} …` : '…'}`
      : view.draft ? `${words('아직 보내지 않은 말', 'Not sent yet')}: ${view.draft}`
      : view.listening ? (view.heard ? `${words('들은 말', 'Heard')}: ${view.heard}` : words('듣는 중 — 말씀하세요', 'Listening — go ahead'))
      : view.muted ? words('마이크 뮤트됨 · 답과 소식은 계속 읽어 드려요', 'Microphone muted · answers and news are still read aloud')
      : words('음성 켜짐 · 맡긴 일 소식은 읽어 드려요', 'Voice on · news of finished work is read aloud');
    // What is heard or read aloud has a line of its own; today's use sits beside the buttons below it, so neither covers the other.
    return <div className={`master-voice live ${writing ? 'speaking' : playing ? 'playing' : ''} ${long ? 'long' : ''}`}>
      <div className="master-voice-now" role="status">
        <span className="master-voice-dot" aria-hidden />
        {playing ? <Volume2 size={13} /> : view.listening ? <Mic size={13} /> : <MicOff size={13} />}
        <span className="master-voice-label" ref={follow.ref} onScroll={follow.onScroll}>{label}{writing && <span className="master-voice-caret" aria-hidden />}</span>
      </div>
      {view.error && <small className="master-voice-error">{view.error}</small>}
      {!playing && missed && <div className="master-voice-missed" role="status">
        <small title={missed.text}>{missedText(missed, words)}</small>
        {missed.reason !== 'empty' && missed.reason !== 'limit' && <button className="master-voice-restart" onClick={() => voice.replayMissed(missed.entry)} title={missed.text}><Play size={12} />{words('답 다시 듣기', 'Hear again')}</button>}
        <button className="icon-button" onClick={() => voice.dismissMissed(missed.entry)} aria-label={words('알림 닫기', 'Dismiss')}><X size={12} /></button>
      </div>}
      <div className="master-voice-controls">
      {usage && <small className="master-voice-usage">{usage}</small>}
      <div className="master-voice-actions">
        {!playing && (view.capturing || view.draft) && <button className="master-voice-restart" onClick={voice.finish} title={words('말이 끝났다고 보고 지금 보내기', 'Done speaking: send it now')}><Send size={12} />{words('보내기', 'Send')}</button>}
        {!playing && !view.capturing && view.draft && <button className="secondary-button" onClick={voice.discard}><X size={12} />{words('지우기', 'Discard')}</button>}
        {playing && <button className="master-voice-restart" onClick={voice.skip}><Square size={12} />{playing.kind === 'notice' ? words('취소', 'Cancel') : words('멈춤', 'Stop')}</button>}
        {!playing && (view.listening
          ? <button className="secondary-button" onClick={voice.mute} title={words('마이크만 끕니다. 답과 소식은 계속 읽어 드려요.', 'Turns only the microphone off; answers and news are still read aloud.')}><MicOff size={12} />{words('마이크 뮤트', 'Mute microphone')}</button>
          : <button className="master-voice-restart" onClick={voice.listen}><Mic size={12} />{view.muted ? words('뮤트 해제', 'Unmute') : words('다시 듣기', 'Listen')}</button>)}
        {voice.end && <button className="master-voice-end" onClick={voice.end}><Square size={12} />{words('음성 대화 끝내기', 'End voice')}</button>}
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
