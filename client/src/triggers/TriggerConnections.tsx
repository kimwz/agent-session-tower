import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CircleDot, Globe, KeyRound, Slack, Trash2 } from 'lucide-react';
import type { GitHubCheck, TriggerSecret, TriggerSettings, TriggerSummary } from '../../../shared/triggers';
import { translateMessage, useI18n } from '../i18n/i18n';
import { towerOperation } from './trigger-helpers';

function Card({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return <section className="trigger-card"><h4>{icon}{title}</h4>{children}</section>;
}

/** Where triggers get in: Slack, GitHub, saved secrets, and which internal addresses HTTP triggers may call. */
export function TriggerConnections({ token, slack, onOpenSlack }: { token: string; slack?: TriggerSummary; onOpenSlack: () => void }) {
  const { t } = useI18n();
  const [check, setCheck] = useState<GitHubCheck | string>('');
  const [checking, setChecking] = useState(false);
  const verify = async () => {
    setChecking(true); setCheck('');
    try { setCheck((await towerOperation<{ result: GitHubCheck }>(token, 'triggers.checkGitHub', { auth: { type: 'gh' } })).result); }
    catch (cause) { setCheck(cause instanceof Error ? cause.message : String(cause)); }
    finally { setChecking(false); }
  };
  return <div className="trigger-connections">
    <Card icon={<Slack size={16} />} title="Slack">
      <p>{slack ? slack.enabled ? t('연결됨 · 새 멘션을 받는 중') : t('연결됨 · 새 멘션 받지 않음') : t('연결되지 않음')}</p>
      {slack?.error && <p className="slack-error">{translateMessage(slack.error)}</p>}
      <div className="slack-actions"><button type="button" className="secondary-button" onClick={onOpenSlack}>{slack ? t('Slack 설정') : t('Slack 연결')}</button></div>
    </Card>
    <Card icon={<CircleDot size={16} />} title="GitHub">
      <p>{t('GitHub 트리거는 이 컴퓨터의 gh 로그인이나, 아래에 https://api.github.com 용으로 저장한 토큰으로 이슈를 확인합니다.')}</p>
      <div className="trigger-preview">
        <button type="button" className="secondary-button" disabled={checking} onClick={() => void verify()}>{checking ? t('확인 중') : t('gh 로그인 확인')}</button>
        {typeof check === 'string' ? check && <p className="slack-error">{translateMessage(check)}</p>
          : check.ok ? <p>{t('{0} 계정으로 로그인되어 있습니다.', { 0: check.login ?? '' })}</p> : <p className="slack-error">{translateMessage(check.error ?? '')}</p>}
      </div>
    </Card>
    <TriggerSecrets token={token} />
    <PrivateHosts token={token} />
  </div>;
}

function TriggerSecrets({ token }: { token: string }) {
  const { t } = useI18n();
  const [secrets, setSecrets] = useState<TriggerSecret[] | null>(null);
  const [draft, setDraft] = useState({ name: '', origin: '', value: '' });
  const [status, setStatus] = useState('');
  const [confirm, setConfirm] = useState('');
  const load = useCallback(() => towerOperation<{ secrets: TriggerSecret[] }>(token, 'secrets.list').then(result => setSecrets(result.secrets), cause => setStatus(String(cause))), [token]);
  useEffect(() => { void load(); }, [load]);
  const act = async (work: () => Promise<unknown>) => {
    try { await work(); setStatus(''); await load(); return true; }
    catch (cause) { setStatus(cause instanceof Error ? cause.message : String(cause)); return false; }
  };
  return <Card icon={<KeyRound size={16} />} title={t('API 키와 토큰')}>
    <p>{t('HTTP 헤더에 넣을 API 키나 GitHub 토큰을 저장합니다. 정한 주소(origin)에만, 내가 고른 트리거에서만 보내며 에이전트는 값을 볼 수 없습니다.')}</p>
    {secrets?.length ? <ol className="slack-activity">{secrets.map(secret => <li key={secret.id}>
      <strong>{secret.name}</strong><span>{secret.origin} · {t('트리거 {0}개에서 사용', { 0: secret.triggerIds.length })}</span>
      {confirm === secret.id ? <button type="button" className="slack-danger" onBlur={() => setConfirm('')} onClick={() => { setConfirm(''); void act(() => towerOperation(token, 'secrets.delete', { id: secret.id })); }}>{t('삭제 확인')}</button>
        : <button type="button" className="secondary-button" onClick={() => setConfirm(secret.id)}><Trash2 size={13} />{t('삭제')}</button>}
    </li>)}</ol> : secrets && <p className="trigger-note">{t('저장한 비밀이 없습니다.')}</p>}
    <form className="trigger-secret-form" onSubmit={event => { event.preventDefault(); void act(() => towerOperation(token, 'secrets.create', { secret: draft })).then(ok => { if (ok) setDraft({ name: '', origin: '', value: '' }); }); }}>
      <label>{t('이름')}<input required maxLength={100} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <label>{t('보낼 주소 (origin)')}<input required type="url" placeholder="https://api.github.com" value={draft.origin} onChange={event => setDraft({ ...draft, origin: event.target.value })} /></label>
      <label>{t('값')}<input required type="password" autoComplete="off" maxLength={4000} placeholder="Bearer …" value={draft.value} onChange={event => setDraft({ ...draft, value: event.target.value })} /></label>
      <div className="slack-actions"><button className="secondary-button"><KeyRound size={13} />{t('비밀 저장')}</button></div>
    </form>
    {status && <p role="alert" className="slack-error">{translateMessage(status)}</p>}
  </Card>;
}

/** Settings are saved whole; each form loads them fresh and changes only its own part. */
function useTriggerSettings(token: string) {
  const [settings, setSettings] = useState<TriggerSettings | null>(null);
  const [status, setStatus] = useState('');
  useEffect(() => { void towerOperation<{ settings: TriggerSettings }>(token, 'triggers.settings').then(result => setSettings(result.settings), cause => setStatus(String(cause))); }, [token]);
  const save = async (patch: Partial<TriggerSettings>, done: string) => {
    try {
      const current = (await towerOperation<{ settings: TriggerSettings }>(token, 'triggers.settings')).settings;
      const saved = (await towerOperation<{ settings: TriggerSettings }>(token, 'triggers.updateSettings', { settings: { ...current, ...patch } })).settings;
      setSettings(saved); setStatus(done);
    } catch (cause) { setStatus(cause instanceof Error ? cause.message : String(cause)); }
  };
  return { settings, setSettings, status, save };
}

function PrivateHosts({ token }: { token: string }) {
  const { t } = useI18n();
  const { settings, status, save } = useTriggerSettings(token);
  const [hosts, setHosts] = useState<string | null>(null);
  // A worker from before HTTP triggers has no such setting.
  if (!settings?.privateHosts) return null;
  const text = hosts ?? settings.privateHosts.join('\n');
  return <Card icon={<Globe size={16} />} title={t('HTTP 트리거가 부를 수 있는 내부 주소')}>
    <form className="trigger-hosts" onSubmit={event => { event.preventDefault(); void save({ privateHosts: text.split('\n').map(line => line.trim()).filter(Boolean) }, t('저장했습니다.')); }}>
      <label>{t('한 줄에 하나씩: 호스트 이름이나 CIDR (예: 127.0.0.1, 192.168.0.0/16). Tower 자신은 항상 제외됩니다.')}<textarea rows={3} value={text} onChange={event => setHosts(event.target.value)} /></label>
      <div className="slack-actions"><button className="secondary-button">{t('저장')}</button>{status && <span role="status">{translateMessage(status)}</span>}</div>
    </form>
  </Card>;
}

/** Limits for all triggers together; only the owner changes them. */
export function TriggerLimits({ token }: { token: string }) {
  const { t } = useI18n();
  const { settings, setSettings, status, save } = useTriggerSettings(token);
  if (!settings) return <p role="status">{status || t('불러오는 중')}</p>;
  const field = (key: 'maxTriggers' | 'maxConcurrentRuns' | 'maxEventsPerHour', label: string, max: number) => <label>{label}<input type="number" min={1} max={max} value={settings[key]} onChange={event => setSettings({ ...settings, [key]: Math.min(max, Math.max(1, Number(event.target.value) || 1)) })} /></label>;
  return <form className="trigger-card trigger-limits" onSubmit={event => { event.preventDefault(); void save({ maxTriggers: settings.maxTriggers, maxConcurrentRuns: settings.maxConcurrentRuns, maxEventsPerHour: settings.maxEventsPerHour }, t('저장했습니다.')); }}>
    <p>{t('모든 트리거에 함께 적용되는 한도입니다. 에이전트는 바꿀 수 없습니다.')}</p>
    <div className="trigger-grid">
      {field('maxTriggers', t('최대 트리거 수'), 200)}
      {field('maxConcurrentRuns', t('동시에 실행할 트리거 작업 수'), 10)}
      {field('maxEventsPerHour', t('모든 트리거의 시간당 최대 실행'), 600)}
    </div>
    <div className="slack-actions"><button className="primary-button">{t('저장')}</button>{status && <span role="status">{translateMessage(status)}</span>}</div>
  </form>;
}
