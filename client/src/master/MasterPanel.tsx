import { pickFor, presetFor, useModelSettings } from '../models/model-settings';
import { useState } from 'react';
import { Bot, LoaderCircle, Settings, X } from 'lucide-react';
import type { MasterBinding, MasterOverview } from '../../../shared/master';
import type { Provider } from '../../../shared/types';
import { post } from './api';
import { MasterSettingsView } from './MasterSettings';
import { useWords } from './strings';
import { VoiceBar, type VoiceControls } from './VoiceBar';

/**
 * The master's own panel: starting its session, and its settings. The conversation itself is the master session,
 * shown like any session.
 */
export function MasterPanel({ token, overview, voice, top, onClose, onStarted }: {
  token: string; overview: MasterOverview | undefined; voice: VoiceControls; top?: number; onClose(): void; onStarted(sessionId: string): void;
}) {
  const words = useWords();
  const [settings, setSettings] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const starting = !overview?.session || replacing;
  return <aside className="master-panel" role="dialog" aria-label={words('마스터 에이전트', 'Master agent')} style={top !== undefined ? { '--master-top': `${top}px` } as React.CSSProperties : undefined}>
    <header className="master-header">
      <Bot size={17} />
      <h2>{words('마스터', 'Master')}</h2>
      <span className="master-state">{overview?.session ? `${overview.session.provider === 'claude' ? 'Claude' : 'Codex'}${overview.session.status ? ` · ${overview.session.status}` : ''}` : words('세션 없음', 'No session')}</span>
      {overview?.session && <button className={`icon-button ${settings ? 'active' : ''}`} onClick={() => setSettings(value => !value)} aria-label={words('마스터 설정', 'Master settings')} title={words('마스터 설정', 'Master settings')}><Settings size={16} /></button>}
      <button className="icon-button" onClick={onClose} aria-label={words('닫기', 'Close')} title={words('닫기', 'Close')}><X size={16} /></button>
    </header>
    {starting && !settings
      ? <MasterStart token={token} replace={replacing} current={overview?.session?.provider} onCancel={replacing ? () => setReplacing(false) : undefined} onStarted={binding => { setReplacing(false); onStarted(binding.sessionId); }} />
      : <MasterSettingsView token={token} overview={overview} onNewSession={() => { setSettings(false); setReplacing(true); }} />}
    {/* The panel covers the floating button that ends voice, so the bar here does it. */}
    <VoiceBar voice={{ ...voice, end: voice.stop }} />
  </aside>;
}

/** The master's first message, which starts its session with the chosen tool. */
function MasterStart({ token, replace, current, onCancel, onStarted }: { token: string; replace: boolean; current?: Provider; onCancel?: () => void; onStarted(binding: MasterBinding): void }) {
  const words = useWords();
  // Settings › Models' "master agent" role; the owner may still change both here. An untouched model is the role's.
  const { settings } = useModelSettings(token);
  const [chosen, setChosen] = useState<Provider | undefined>(current);
  const provider = chosen ?? presetFor(settings, 'master.session', [])?.provider ?? 'claude';
  const setProvider = (next: Provider) => { setChosen(next); setEdited(undefined); };
  const [edited, setEdited] = useState<string>();
  const role = pickFor(settings, 'master.session', provider);
  const model = edited ?? role.model ?? '';
  const setModel = (next: string) => setEdited(next);
  const effort = edited === undefined ? role.effort : undefined;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const start = async () => {
    if (!text.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const answer = await post<{ binding: MasterBinding }>('/api/master/start', token, { provider, text: text.trim(), ...(model.trim() ? { model: model.trim() } : {}), ...(effort ? { effort } : {}), ...(replace ? { replace: true } : {}) });
      onStarted(answer.binding);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  return <div className="master-settings">
    <section>
      <h3>{replace ? words('새 마스터 세션', 'New master session') : words('마스터 시작', 'Start the master')}</h3>
      <p>{words('마스터는 Tower가 전용 폴더에 두는 Claude 또는 Codex 세션입니다. 구독 로그인으로만 대화하고 API 키는 쓰지 않습니다. 모든 도구를 쓸 수 있고, 프로젝트 작업은 다른 세션에 맡긴 뒤 끝나면 결과를 알려 줍니다.',
        'The master is a Claude or Codex session Tower keeps in its own folder. It talks only through your subscription sign-in, never an API key. It has every tool, hands project work to other sessions and reports when it ends.')}</p>
      {replace && <p>{words('이제부터 새 세션이 마스터가 됩니다. 지금 마스터 세션은 기록으로 남지만, 마스터 폴더의 세션이라 캔버스와 세션 목록에는 나오지 않습니다.', 'The new session becomes the master. The current one is kept, but as a session in the master\'s folder it is not shown on the canvas or in the session list.')}</p>}
      <label className="master-field">{words('도구', 'Tool')}
        <select value={provider} disabled={busy} onChange={event => setProvider(event.target.value as Provider)}>
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
        </select>
      </label>
      <label className="master-field">{words('모델 (비우면 기본)', 'Model (empty for the default)')}
        <input value={model} disabled={busy} onChange={event => setModel(event.target.value)} placeholder={provider === 'claude' ? words('Claude 기본값', 'Claude default') : words('Codex 기본값', 'Codex default')} maxLength={80} />
      </label>
      <label className="master-field">{words('첫 메시지', 'First message')}
        <textarea rows={3} value={text} disabled={busy} maxLength={32_000} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void start(); } }}
          placeholder={words('예: 지금 작업 중인 세션 알려줘', 'For example: what is working right now?')} />
      </label>
      <div className="master-key-row">
        <button className="master-primary" disabled={busy || !text.trim()} onClick={() => void start()}>{busy ? <LoaderCircle size={13} className="spin" /> : words('시작', 'Start')}</button>
        {onCancel && <button className="secondary-button" disabled={busy} onClick={onCancel}>{words('취소', 'Cancel')}</button>}
      </div>
      {error && <div className="master-error" role="alert">{error}</div>}
    </section>
  </div>;
}
