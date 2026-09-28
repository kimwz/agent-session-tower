import { useEffect, useState } from 'react';
import { KeyRound, LoaderCircle, Mic, Trash2 } from 'lucide-react';
import { DEFAULT_MASTER_VOICE, MASTER_CLAUDE_MODELS, MASTER_EFFORTS, MASTER_MODELS, MASTER_OPENAI_MODELS, MASTER_TTS_MODELS, masterProvider, type MasterOverview, type MasterSettings, type MasterVoiceSettings } from '../../../shared/master';
import type { LinkOverview } from '../../../shared/link';
import { api } from '../common/lib';
import { post } from './api';
import { useWords } from './strings';
import { voiceUsage } from './VoiceBar';

/**
 * The master's settings. The key for the chosen model (OpenAI for GPT, Anthropic for Claude) turns it on. Everything else has a default that lets the master do whatever
 * the owner asks; the limits here are optional.
 */
export function MasterSettingsView({ token, overview, onDone }: { token: string; overview: MasterOverview | undefined; onDone(): void }) {
  const words = useWords();
  const [key, setKey] = useState('');
  const [claudeKey, setClaudeKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [nodes, setNodes] = useState<Array<{ id: string; name: string }>>([]);
  const settings = overview?.settings;

  useEffect(() => {
    void api<LinkOverview>('/api/link').then(link => setNodes((link.nodes ?? []).map(node => ({ id: node.id, name: node.label || node.name })))).catch(() => {});
  }, []);

  const save = async (body: Record<string, unknown>) => {
    setBusy(true); setError('');
    try { await post<MasterOverview>('/api/master/settings', token, body); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const guards = (patch: Partial<MasterSettings['guards']>) => save({ guards: patch });
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
      <h3><KeyRound size={14} />{words('OpenAI API 키', 'OpenAI API key')}</h3>
      <p>{words('GPT 모델에 씁니다. platform.openai.com에서 만든 API 키를 넣으세요. 키는 이 컴퓨터에만 저장되고 다시 보여 주지 않습니다.', 'Used for GPT models. Enter an API key from platform.openai.com. It is stored on this computer only and never shown again.')}</p>
      {overview.keyHint ? <div className="master-key-row"><span>{words('등록됨', 'Saved')} {overview.keyHint}</span><button className="secondary-button" disabled={busy} onClick={() => void save({ apiKey: null })}><Trash2 size={13} />{words('삭제', 'Remove')}</button></div> : null}
      <form className="master-key-row" onSubmit={event => { event.preventDefault(); if (key.trim()) void save({ apiKey: key.trim() }).then(() => setKey('')); }}>
        <input type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} placeholder={overview.keyHint ? words('새 키로 바꾸기', 'Replace with a new key') : 'sk-…'} aria-label={words('OpenAI API 키', 'OpenAI API key')} />
        <button className="master-primary" disabled={busy || !key.trim()}>{busy ? <LoaderCircle size={13} className="spin" /> : words('저장', 'Save')}</button>
      </form>
    </section>
    <section>
      <h3><KeyRound size={14} />{words('Anthropic API 키', 'Anthropic API key')}</h3>
      <p>{words('Claude Opus 모델에 씁니다. platform.claude.com에서 만든 API 키를 넣으세요. Claude Code 로그인(구독)으로는 쓸 수 없습니다. 키는 이 컴퓨터에만 저장되고 다시 보여 주지 않습니다.', 'Used for Claude Opus models. Enter an API key from platform.claude.com; a Claude Code sign-in (subscription) does not work here. It is stored on this computer only and never shown again.')}</p>
      {overview.anthropicKeyHint ? <div className="master-key-row"><span>{words('등록됨', 'Saved')} {overview.anthropicKeyHint}</span><button className="secondary-button" disabled={busy} onClick={() => void save({ anthropicKey: null })}><Trash2 size={13} />{words('삭제', 'Remove')}</button></div> : null}
      <form className="master-key-row" onSubmit={event => { event.preventDefault(); if (claudeKey.trim()) void save({ anthropicKey: claudeKey.trim() }).then(() => setClaudeKey('')); }}>
        <input type="password" autoComplete="off" value={claudeKey} onChange={event => setClaudeKey(event.target.value)} placeholder={overview.anthropicKeyHint ? words('새 키로 바꾸기', 'Replace with a new key') : 'sk-ant-…'} aria-label={words('Anthropic API 키', 'Anthropic API key')} />
        <button className="master-primary" disabled={busy || !claudeKey.trim()}>{busy ? <LoaderCircle size={13} className="spin" /> : words('저장', 'Save')}</button>
      </form>
    </section>
    <section>
      <h3>{words('동작', 'Behaviour')}</h3>
      <label className="master-toggle"><input type="checkbox" checked={settings.enabled} disabled={busy} onChange={event => void save({ enabled: event.target.checked })} />{words('마스터 켜기', 'Master on')}</label>
      <label className="master-field">{words('모델', 'Model')}
        <select value={MASTER_MODELS.includes(settings.model as typeof MASTER_MODELS[number]) ? settings.model : ''} disabled={busy} onChange={event => { if (event.target.value) void save({ model: event.target.value }); }}>
          <optgroup label={words('GPT (OpenAI 키)', 'GPT (OpenAI key)')}>{MASTER_OPENAI_MODELS.map(model => <option key={model} value={model}>{model}</option>)}</optgroup>
          <optgroup label={words('Claude (Anthropic 키)', 'Claude (Anthropic key)')}>{MASTER_CLAUDE_MODELS.map(model => <option key={model} value={model}>{model === 'claude-opus-5-5' ? 'Claude Opus 5.5' : 'Claude Opus 5'}</option>)}</optgroup>
          {!MASTER_MODELS.includes(settings.model as typeof MASTER_MODELS[number]) && <option value="">{settings.model}</option>}
        </select>
      </label>
      {!overview.configured && <p className="master-error">{masterProvider(settings.model) === 'anthropic' ? words('Claude 모델은 위에 Anthropic API 키를 넣어야 답합니다.', 'Claude models answer once an Anthropic API key is saved above.') : words('GPT 모델은 위에 OpenAI API 키를 넣어야 답합니다.', 'GPT models answer once an OpenAI API key is saved above.')}</p>}
      <label className="master-field">{words('추론 수준', 'Reasoning')}
        <select value={settings.effort} disabled={busy} onChange={event => void save({ effort: event.target.value })}>{MASTER_EFFORTS.map(effort => <option key={effort} value={effort}>{effort}</option>)}</select>
      </label>
      <label className="master-toggle"><input type="checkbox" checked={settings.showResults} disabled={busy} onChange={event => void save({ showResults: event.target.checked })} />{words('찾은 세션을 내 화면에 열기', 'Open what it finds on my screen')}</label>
    </section>
    <section>
      <h3><Mic size={14} />{words('음성', 'Voice')}</h3>
      <p>{words('입력창의 마이크 버튼으로 말로 시킵니다. 말한 것은 ElevenLabs가 받아쓰고, 답과 맡긴 일 소식은 ElevenLabs 목소리로 읽어 드립니다. 읽는 동안에는 마이크를 쉬게 합니다.', 'Talk to the master with the microphone button. ElevenLabs writes down what you say and reads answers and news aloud; the microphone rests while it reads.')}</p>
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
    <section>
      <h3>{words('제한 (선택)', 'Limits (optional)')}</h3>
      <p>{words('기본은 요청한 일을 모두 합니다. 필요하면 여기서 제한을 켜세요.', 'By default the master does everything you ask. Turn limits on here if you want them.')}</p>
      <label className="master-toggle"><input type="checkbox" checked={settings.guards.hideSecrets} disabled={busy} onChange={event => void guards({ hideSecrets: event.target.checked })} />{words('키와 토큰을 모델에 보내지 않기 (참조로 바꿔 전달)', 'Keep keys and tokens out of the model (passed as references)')}</label>
      <label className="master-toggle"><input type="checkbox" checked={settings.guards.localOnlyPages} disabled={busy} onChange={event => void guards({ localOnlyPages: event.target.checked })} />{words('계정 관리와 Tower 업데이트는 이 컴퓨터에서 한 요청만', 'Account management and Tower updates only for requests made on this computer')}</label>
      <label className="master-toggle"><input type="checkbox" checked={settings.guards.eventTurnsReadOnly} disabled={busy} onChange={event => void guards({ eventTurnsReadOnly: event.target.checked })} />{words('맡긴 일이 끝나 보고할 때는 조회만', 'Only look things up when reporting finished work')}</label>
      <label className="master-field">{words('한 번에 되돌릴 수 없는 작업 수 (0 = 제한 없음)', 'Irreversible changes per request (0 = no limit)')}
        <input type="number" min={0} max={1000} value={settings.guards.maxIrreversiblePerTurn} disabled={busy} onChange={event => void guards({ maxIrreversiblePerTurn: Math.max(0, Math.min(1000, Math.floor(Number(event.target.value) || 0))) })} />
      </label>
      {nodes.length > 0 && <fieldset className="master-nodes"><legend>{words('읽기만 할 컴퓨터', 'Computers to only read from')}</legend>
        {nodes.map(node => <label key={node.id} className="master-toggle"><input type="checkbox" checked={settings.guards.readOnlyNodes.includes(node.id)} disabled={busy}
          onChange={event => void guards({ readOnlyNodes: event.target.checked ? [...settings.guards.readOnlyNodes, node.id] : settings.guards.readOnlyNodes.filter(id => id !== node.id) })} />{node.name}</label>)}
      </fieldset>}
    </section>
    {error && <div className="master-error" role="alert">{error}</div>}
    {(overview.configured || overview.keyHint || overview.anthropicKeyHint) && <button className="secondary-button master-settings-done" onClick={onDone}>{words('대화로 돌아가기', 'Back to the conversation')}</button>}
  </div>;
}
