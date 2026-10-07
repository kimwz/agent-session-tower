import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Mic, Play, RefreshCw, Square, Trash2 } from 'lucide-react';
import { DEFAULT_MASTER_VOICE, MASTER_PLAYBACK_RATES, MASTER_TTS_MODELS, type MasterOverview, type MasterVoiceSettings } from '../../../shared/master';
import { api } from '../common/lib';
import { post } from './api';
import { useWords } from './strings';
import { voiceUsage } from './VoiceBar';
import { applyPlaybackRate } from './voice-sound';

/** The master's settings: its session, and voice. The master itself has no limits to set. */
export function MasterSettingsView({ token, overview, onNewSession }: { token: string; overview: MasterOverview | undefined; onNewSession(): void }) {
  const words = useWords();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const settings = overview?.settings;

  const save = async (body: Record<string, unknown>) => {
    setBusy(true); setError('');
    try { await post<MasterOverview>('/api/master/settings', token, body); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const voice = (patch: Partial<MasterVoiceSettings>) => save({ voice: patch });
  const [voiceKey, setVoiceKey] = useState('');
  const [voices, setVoices] = useState<VoiceChoice[]>([]);
  const voiceConfigured = Boolean(overview?.voiceConfigured);
  useEffect(() => {
    if (!voiceConfigured) { setVoices([]); return; }
    void api<VoiceChoice[]>('/api/master/voice/voices').then(setVoices).catch(() => setVoices([]));
  }, [voiceConfigured]);
  if (!overview || !settings) return <div className="master-settings"><LoaderCircle className="spin" size={16} /></div>;
  return <div className="master-settings">
    <section>
      <h3>{words('마스터 세션', 'Master session')}</h3>
      <p>{overview.session ? `${overview.session.provider === 'claude' ? 'Claude Code' : 'Codex'} · ${overview.session.title ?? overview.session.id}` : words('아직 없습니다.', 'None yet.')}</p>
      <p>{words('모델과 추론 수준은 대화창에서 여느 세션처럼 고릅니다. 다른 도구로 바꾸거나 새로 시작하려면 새 마스터 세션을 여세요.', 'Choose the model and reasoning in the conversation, as in any session. To switch tools or start fresh, open a new master session.')}</p>
      {overview.followState === 'moved-aside' ? <p className="master-error" role="alert">{words('마스터가 지켜보던 일의 기록을 읽지 못해 따로 옮겨 두고 새로 시작했습니다. 그 전에 맡긴 일은 끝나도 보고되지 않습니다.', 'The master’s record of followed work could not be read; it was moved aside and started over. Work handed out before is not reported when it ends.')}</p> : null}
      {overview.followState === 'not-saved' ? <p className="master-error" role="alert">{words('마스터가 지켜보던 일의 기록을 읽지 못해 그대로 두었습니다. Tower를 다시 시작할 때까지 새로 맡긴 일은 저장되지 않습니다.', 'The master’s record of followed work could not be read and was left as it is. Newly handed-out work is not saved until Tower restarts.')}</p> : null}
      {overview.failedReports ? <p className="master-error">{words(`끝난 일 ${overview.failedReports}건의 보고를 마스터 세션에 전하지 못했습니다. 세션 목록에서 확인해 주세요.`, `${overview.failedReports} reports of finished work could not be given to the master session. Check them in the session list.`)}</p> : null}
      <div className="master-key-row"><button className="secondary-button" disabled={busy} onClick={onNewSession}><RefreshCw size={13} />{words('새 마스터 세션', 'New master session')}</button></div>
    </section>
    <section>
      <h3><Mic size={14} />{words('음성', 'Voice')}</h3>
      <p>{words('마스터 대화를 열면 버튼 옆에 나오는 마이크로 말로 시킵니다. 말한 것은 ElevenLabs가 받아쓰고, 답과 맡긴 일 소식은 ElevenLabs 목소리로 읽어 드립니다. 읽는 동안에는 마이크를 쉬게 합니다.', 'Talk to the master with the microphone beside the button while its conversation is open. ElevenLabs writes down what you say and reads answers and news aloud; the microphone rests while it reads.')}</p>
      {voiceConfigured ? <div className="master-key-row"><span>{words('ElevenLabs 키 등록됨', 'ElevenLabs key saved')} {overview.voiceKeyHint}</span><button className="secondary-button" disabled={busy} onClick={() => void save({ voiceKey: null })}><Trash2 size={13} />{words('삭제', 'Remove')}</button></div> : null}
      <form className="master-key-row" onSubmit={event => { event.preventDefault(); if (voiceKey.trim()) void save({ voiceKey: voiceKey.trim() }).then(() => setVoiceKey('')); }}>
        <input type="password" autoComplete="off" value={voiceKey} onChange={event => setVoiceKey(event.target.value)} placeholder={voiceConfigured ? words('새 ElevenLabs 키로 바꾸기', 'Replace the ElevenLabs key') : words('ElevenLabs API 키', 'ElevenLabs API key')} aria-label={words('ElevenLabs API 키', 'ElevenLabs API key')} />
        <button className="master-primary" disabled={busy || !voiceKey.trim()}>{words('저장', 'Save')}</button>
      </form>
      <p>{voiceUsage(overview.voice, words)}</p>
      <VoicePicker token={token} voices={voices} current={(settings.voice ?? DEFAULT_MASTER_VOICE).voiceId} model={(settings.voice ?? DEFAULT_MASTER_VOICE).model} rate={(settings.voice ?? DEFAULT_MASTER_VOICE).playbackRate ?? 1} busy={busy} onChoose={voiceId => void voice({ voiceId })} onRate={playbackRate => void voice({ playbackRate })} />
      <label className="master-field">{words('읽어 주기 모델', 'Reading model')}
        <select value={(settings.voice ?? DEFAULT_MASTER_VOICE).model} disabled={busy} onChange={event => void voice({ model: event.target.value as MasterVoiceSettings['model'] })}>
          {MASTER_TTS_MODELS.map(model => <option key={model} value={model}>{model === 'eleven_v4_turbo' ? words('v4 터보 (빠름, 추천)', 'v4 Turbo (fast, recommended)') : model === 'eleven_v3_conversational' ? words('v3 대화형 (빠름)', 'v3 conversational (fast)') : model === 'eleven_v3' ? words('v3 (표현력, 느림, 두 배 비쌈)', 'v3 (expressive, slower, twice the price)') : words('flash v2.5 (가장 빠름, 밝은 말투 없음)', 'flash v2.5 (fastest, no bright tone)')}</option>)}
        </select>
      </label>
      <label className="master-field">{words('말 끝으로 볼 멈춤 (밀리초, 600–3000)', 'Pause that ends what you say (ms, 600–3000)')}
        <input type="number" min={600} max={3000} step={100} value={(settings.voice ?? DEFAULT_MASTER_VOICE).endSilenceMs} disabled={busy} onChange={event => void voice({ endSilenceMs: Math.max(600, Math.min(3000, Math.round(Number(event.target.value) / 100) * 100 || 1000)) })} />
      </label>
      <label className="master-field">{words('요청이 없으면 듣기 끄기 (분, 1–30)', 'Stop listening after no request for (minutes, 1–30)')}
        <input type="number" min={1} max={30} value={(settings.voice ?? DEFAULT_MASTER_VOICE).listenMinutes} disabled={busy} onChange={event => void voice({ listenMinutes: Math.max(1, Math.min(30, Math.floor(Number(event.target.value) || 5))) })} />
      </label>
      <label className="master-toggle"><input type="checkbox" checked={(settings.voice ?? DEFAULT_MASTER_VOICE).readReports} disabled={busy} onChange={event => void voice({ readReports: event.target.checked })} />{words('음성을 켠 탭에서 맡긴 일 소식을 읽어 주고 다시 듣기 (마스터 창을 닫아도)', 'Read news of finished work aloud (and listen again) while voice is on, with the master open or closed')}</label>
      <label className="master-field">{words('하루 음성 비용 한도 ($, 0 = 없음)', 'Daily voice limit ($, 0 = none)')}
        <input type="number" min={0} max={1000} step={0.5} value={(settings.voice ?? DEFAULT_MASTER_VOICE).dailyDollars} disabled={busy} onChange={event => void voice({ dailyDollars: Math.max(0, Math.min(1000, Math.round((Number(event.target.value) || 0) * 100) / 100)) })} />
      </label>
    </section>
    {error && <div className="master-error" role="alert">{error}</div>}
  </div>;
}

interface VoiceChoice { id: string; name: string; category?: string }

/**
 * The account's voices, each with a short Korean sample to hear before choosing it, and how fast answers are read:
 * samples play at that speed, and choosing one plays the current voice's sample at it.
 */
function VoicePicker({ token, voices, current, model, rate, busy, onChoose, onRate }: { token: string; voices: VoiceChoice[]; current: string; model: string; rate: number; busy: boolean; onChoose(voiceId: string): void; onRate(rate: number): void }) {
  const words = useWords();
  const player = useRef<HTMLAudioElement | null>(null);
  /** The speed samples play at: the one just chosen, before the saved settings come back with it. */
  const speed = useRef(rate);
  useEffect(() => { speed.current = rate; }, [rate]);
  /** Counts clicks: a sample that arrives after another was asked for (or stopped) is not played. */
  const asked = useRef(0);
  const [playing, setPlaying] = useState<{ id: string; loading: boolean }>();
  const [error, setError] = useState('');
  const stop = () => { asked.current++; player.current?.pause(); setPlaying(undefined); };
  // Stopped when the settings close, and when the model changes: a sample shows how the chosen model reads.
  useEffect(() => stop, [model]);
  const preview = async (id: string, restart = false) => {
    const again = playing?.id === id && !restart;
    stop(); setError('');
    if (again) return;
    const mine = asked.current;
    const element = (player.current ??= new Audio());
    element.onended = element.onerror = element.onplaying = null;
    // Started by the click itself: phones play later sound only from an element a click already played.
    element.src = '/master-silence.wav';
    void element.play().catch(() => {});
    setPlaying({ id, loading: true });
    try {
      const { audio } = await post<{ audio: string }>('/api/master/voice/preview', token, { voiceId: id });
      if (asked.current !== mine) return;
      element.onended = () => { if (asked.current === mine) setPlaying(undefined); };
      element.onerror = () => { if (asked.current === mine) { setPlaying(undefined); setError(words('미리 듣기를 재생하지 못했습니다.', 'Could not play the sample.')); } };
      element.onplaying = () => applyPlaybackRate(element, speed.current);
      element.src = audio;
      applyPlaybackRate(element, speed.current);
      setPlaying({ id, loading: false });
      await element.play();
    } catch (reason) {
      if (asked.current !== mine) return;
      setPlaying(undefined);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const listed = voices.some(item => item.id === current);
  const rows: VoiceChoice[] = listed || !voices.length ? voices : [{ id: current, name: words('지금 목소리 (목록에 없음)', 'Current voice (not listed)') }, ...voices];
  return <div className="master-field">
    {words('목소리', 'Voice')}
    {!voices.length ? <p>{words('ElevenLabs 키를 넣으면 이 계정의 목소리 목록과 미리 듣기가 나옵니다.', 'Add an ElevenLabs key to list and hear the account\'s voices.')}</p>
      : <div className="master-voices" role="radiogroup" aria-label={words('목소리', 'Voice')}>
        {rows.map(item => {
          const chosen = item.id === current;
          const state = playing?.id === item.id ? (playing.loading ? 'loading' : 'playing') : undefined;
          return <div key={item.id} className={chosen ? 'chosen' : undefined}>
            <label className="master-voice-choose">
              <input type="radio" name="master-voice" value={item.id} checked={chosen} disabled={busy} onChange={() => onChoose(item.id)} />
              <span>{item.name}{item.category && item.category !== 'premade' ? ` (${item.category})` : ''}</span>
            </label>
            <button type="button" className="master-voice-preview" disabled={state === 'loading'} onClick={() => void preview(item.id)} aria-label={state === 'playing' ? words(`${item.name} 미리 듣기 멈추기`, `Stop ${item.name} sample`) : words(`${item.name} 미리 듣기`, `Hear ${item.name}`)} title={words('미리 듣기', 'Hear a sample')}>
              {state === 'loading' ? <LoaderCircle className="spin" size={13} /> : state === 'playing' ? <Square size={12} /> : <Play size={13} />}
            </button>
          </div>;
        })}
      </div>}
    <div className="master-rates" role="radiogroup" aria-label={words('읽는 속도', 'Reading speed')}>
      <span>{words('읽는 속도', 'Reading speed')}</span>
      {MASTER_PLAYBACK_RATES.map(value => <label key={value} className={Math.abs(value - rate) < 0.01 ? 'chosen' : undefined}>
        <input type="radio" name="master-rate" value={value} checked={Math.abs(value - rate) < 0.01} disabled={busy} onChange={() => {}} onClick={() => {
          speed.current = value;
          if (Math.abs(value - rate) >= 0.01) onRate(value);
          // Heard at once (the chosen speed again too), started by the click itself: phones play only then.
          if (voices.length) void preview(current, true);
        }} />{value.toFixed(1)}×
      </label>)}
    </div>
    <small className="master-rates-hint">{words('높낮이는 그대로 두고 빠르게 재생합니다. 답, 맡긴 일 소식, 미리 듣기에 모두 적용됩니다.', 'Plays faster with the pitch kept: answers, news of finished work and samples alike.')}</small>
    {error && <span className="master-error" role="alert">{error}</span>}
  </div>;
}
