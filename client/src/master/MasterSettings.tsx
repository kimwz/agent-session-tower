import { useEffect, useState } from 'react';
import { LoaderCircle, Mic, RefreshCw, Trash2 } from 'lucide-react';
import { DEFAULT_MASTER_VOICE, MASTER_TTS_MODELS, type MasterOverview, type MasterVoiceSettings } from '../../../shared/master';
import { api } from '../common/lib';
import { post } from './api';
import { useWords } from './strings';
import { voiceUsage } from './VoiceBar';

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
  const [voices, setVoices] = useState<Array<{ id: string; name: string; category?: string }>>([]);
  const voiceConfigured = Boolean(overview?.voiceConfigured);
  useEffect(() => {
    if (!voiceConfigured) { setVoices([]); return; }
    void api<Array<{ id: string; name: string; category?: string }>>('/api/master/voice/voices').then(setVoices).catch(() => setVoices([]));
  }, [voiceConfigured]);
  if (!overview || !settings) return <div className="master-settings"><LoaderCircle className="spin" size={16} /></div>;
  return <div className="master-settings">
    <section>
      <h3>{words('마스터 세션', 'Master session')}</h3>
      <p>{overview.session ? `${overview.session.provider === 'claude' ? 'Claude Code' : 'Codex'} · ${overview.session.title ?? overview.session.id}` : words('아직 없습니다.', 'None yet.')}</p>
      <p>{words('모델과 추론 수준은 대화창에서 여느 세션처럼 고릅니다. 다른 도구로 바꾸거나 새로 시작하려면 새 마스터 세션을 여세요.', 'Choose the model and reasoning in the conversation, as in any session. To switch tools or start fresh, open a new master session.')}</p>
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
      <label className="master-field">{words('목소리', 'Voice')}
        <select value={(settings.voice ?? DEFAULT_MASTER_VOICE).voiceId} disabled={busy || !voices.length} onChange={event => void voice({ voiceId: event.target.value })}>
          {!voices.some(item => item.id === (settings.voice ?? DEFAULT_MASTER_VOICE).voiceId) && <option value={(settings.voice ?? DEFAULT_MASTER_VOICE).voiceId}>{voices.length ? words('기본 목소리', 'Default voice') : words('키를 넣으면 목록이 나옵니다', 'Add a key to list voices')}</option>}
          {voices.map(item => <option key={item.id} value={item.id}>{item.name}{item.category && item.category !== 'premade' ? ` (${item.category})` : ''}</option>)}
        </select>
      </label>
      <label className="master-field">{words('읽어 주기 모델', 'Reading model')}
        <select value={(settings.voice ?? DEFAULT_MASTER_VOICE).model} disabled={busy} onChange={event => void voice({ model: event.target.value as MasterVoiceSettings['model'] })}>
          {MASTER_TTS_MODELS.map(model => <option key={model} value={model}>{model === 'eleven_v3_conversational' ? words('v3 대화형 (빠름, 추천)', 'v3 conversational (fast, recommended)') : model === 'eleven_v3' ? words('v3 (표현력, 느림, 두 배 비쌈)', 'v3 (expressive, slower, twice the price)') : words('flash v2.5 (가장 빠름, 밝은 말투 없음)', 'flash v2.5 (fastest, no bright tone)')}</option>)}
        </select>
      </label>
      <label className="master-field">{words('말 끝으로 볼 멈춤 (밀리초, 600–3000)', 'Pause that ends what you say (ms, 600–3000)')}
        <input type="number" min={600} max={3000} step={100} value={(settings.voice ?? DEFAULT_MASTER_VOICE).endSilenceMs} disabled={busy} onChange={event => void voice({ endSilenceMs: Math.max(600, Math.min(3000, Math.round(Number(event.target.value) / 100) * 100 || 1000)) })} />
      </label>
      <label className="master-field">{words('요청이 없으면 듣기 끄기 (분, 1–30)', 'Stop listening after no request for (minutes, 1–30)')}
        <input type="number" min={1} max={30} value={(settings.voice ?? DEFAULT_MASTER_VOICE).listenMinutes} disabled={busy} onChange={event => void voice({ listenMinutes: Math.max(1, Math.min(30, Math.floor(Number(event.target.value) || 5))) })} />
      </label>
      <label className="master-toggle"><input type="checkbox" checked={(settings.voice ?? DEFAULT_MASTER_VOICE).readReports} disabled={busy} onChange={event => void voice({ readReports: event.target.checked })} />{words('음성을 켠 탭에서 마스터 창이 열려 있으면 맡긴 일 소식을 읽어 주고 다시 듣기', 'Read news of finished work aloud (and listen again) while voice is on with the master open')}</label>
      <label className="master-field">{words('하루 음성 비용 한도 ($, 0 = 없음)', 'Daily voice limit ($, 0 = none)')}
        <input type="number" min={0} max={1000} step={0.5} value={(settings.voice ?? DEFAULT_MASTER_VOICE).dailyDollars} disabled={busy} onChange={event => void voice({ dailyDollars: Math.max(0, Math.min(1000, Math.round((Number(event.target.value) || 0) * 100) / 100)) })} />
      </label>
    </section>
    {error && <div className="master-error" role="alert">{error}</div>}
  </div>;
}
