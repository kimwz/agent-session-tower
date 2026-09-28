import { useEffect, useState } from 'react';
import { KeyRound, LoaderCircle, Mic, Trash2 } from 'lucide-react';
import { DEFAULT_MASTER_VOICE, MASTER_EFFORTS, MASTER_MODELS, MASTER_VOICES, type MasterOverview, type MasterSettings, type MasterVoiceSettings } from '../../../shared/master';
import type { LinkOverview } from '../../../shared/link';
import { api } from '../common/lib';
import { post } from './api';
import { useWords } from './strings';
import { voiceUsage } from './VoiceBar';

/**
 * The master's settings. The OpenAI key turns it on. Everything else has a default that lets the master do whatever
 * the owner asks; the limits here are optional.
 */
export function MasterSettingsView({ token, overview, onDone }: { token: string; overview: MasterOverview | undefined; onDone(): void }) {
  const words = useWords();
  const [key, setKey] = useState('');
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
  const number = (value: string, max: number) => Math.max(0, Math.min(max, Math.floor(Number(value) || 0)));
  if (!overview || !settings) return <div className="master-settings"><LoaderCircle className="spin" size={16} /></div>;
  return <div className="master-settings">
    <section>
      <h3><KeyRound size={14} />{words('OpenAI API 키', 'OpenAI API key')}</h3>
      <p>{words('platform.openai.com에서 만든 API 키를 넣으면 마스터가 켜집니다. 키는 이 컴퓨터에만 저장되고 다시 보여 주지 않습니다.', 'Enter an API key from platform.openai.com to turn the master on. It is stored on this computer only and never shown again.')}</p>
      {overview.configured ? <div className="master-key-row"><span>{words('등록됨', 'Saved')} {overview.keyHint}</span><button className="secondary-button" disabled={busy} onClick={() => void save({ apiKey: null })}><Trash2 size={13} />{words('삭제', 'Remove')}</button></div> : null}
      <form className="master-key-row" onSubmit={event => { event.preventDefault(); if (key.trim()) void save({ apiKey: key.trim() }).then(() => setKey('')); }}>
        <input type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} placeholder={overview.configured ? words('새 키로 바꾸기', 'Replace with a new key') : 'sk-…'} aria-label={words('OpenAI API 키', 'OpenAI API key')} />
        <button className="master-primary" disabled={busy || !key.trim()}>{busy ? <LoaderCircle size={13} className="spin" /> : words('저장', 'Save')}</button>
      </form>
    </section>
    <section>
      <h3>{words('동작', 'Behaviour')}</h3>
      <label className="master-toggle"><input type="checkbox" checked={settings.enabled} disabled={busy} onChange={event => void save({ enabled: event.target.checked })} />{words('마스터 켜기', 'Master on')}</label>
      <label className="master-field">{words('모델', 'Model')}
        <select value={MASTER_MODELS.includes(settings.model as typeof MASTER_MODELS[number]) ? settings.model : ''} disabled={busy} onChange={event => { if (event.target.value) void save({ model: event.target.value }); }}>
          {MASTER_MODELS.map(model => <option key={model} value={model}>{model}</option>)}
          {!MASTER_MODELS.includes(settings.model as typeof MASTER_MODELS[number]) && <option value="">{settings.model}</option>}
        </select>
      </label>
      <label className="master-field">{words('추론 수준', 'Reasoning')}
        <select value={settings.effort} disabled={busy} onChange={event => void save({ effort: event.target.value })}>{MASTER_EFFORTS.map(effort => <option key={effort} value={effort}>{effort}</option>)}</select>
      </label>
      <label className="master-toggle"><input type="checkbox" checked={settings.showResults} disabled={busy} onChange={event => void save({ showResults: event.target.checked })} />{words('찾은 세션을 내 화면에 열기', 'Open what it finds on my screen')}</label>
    </section>
    <section>
      <h3><Mic size={14} />{words('음성', 'Voice')}</h3>
      <p>{words('입력창의 마이크 버튼으로 마스터와 말로 대화합니다 (OpenAI GPT-Live, 분당 약 $0.05). 한국어 음성 품질은 직접 확인해 주세요.', 'Talk to the master with the microphone button by the message box (OpenAI GPT-Live, about $0.05 a minute).')}</p>
      <p>{voiceUsage(overview.voice, words)}</p>
      <label className="master-field">{words('목소리', 'Voice')}
        <select value={(settings.voice ?? DEFAULT_MASTER_VOICE).voice} disabled={busy} onChange={event => void voice({ voice: event.target.value })}>{MASTER_VOICES.map(name => <option key={name} value={name}>{name}</option>)}</select>
      </label>
      <label className="master-field">{words('말이 없으면 끄기 (초, 0 = 끄지 않음)', 'End after silence (seconds, 0 = never)')}
        <input type="number" min={0} max={600} value={(settings.voice ?? DEFAULT_MASTER_VOICE).silenceSeconds} disabled={busy} onChange={event => void voice({ silenceSeconds: number(event.target.value, 600) })} />
      </label>
      <label className="master-toggle"><input type="checkbox" checked={(settings.voice ?? DEFAULT_MASTER_VOICE).autoWake} disabled={busy} onChange={event => void voice({ autoWake: event.target.checked })} />{words('말이 없어 꺼진 뒤 전할 소식이 오면 다시 켜서 말하기 (마스터 창이 열려 있을 때만)', 'After a quiet end, turn back on to tell news (only while the master panel is open)')}</label>
      <label className="master-field">{words('하루 음성 한도 (분, 0 = 없음)', 'Daily voice limit (minutes, 0 = none)')}
        <input type="number" min={0} max={1440} value={(settings.voice ?? DEFAULT_MASTER_VOICE).dailyMinutes} disabled={busy} onChange={event => void voice({ dailyMinutes: number(event.target.value, 1440) })} />
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
    {overview.configured && <button className="secondary-button master-settings-done" onClick={onDone}>{words('대화로 돌아가기', 'Back to the conversation')}</button>}
  </div>;
}
