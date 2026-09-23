import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarClock, CircleDot, Globe, History, KeyRound, Pencil, Play, Plus, RotateCcw, Settings2, Slack, Trash2, X, Zap } from 'lucide-react';
import type { ProviderHealth, Session } from '../../../shared/types';
import { GITHUB_API, type GitHubCheck, type HttpCondition, type HttpTestResult, type Trigger, TriggerAuditEntry, TriggerEvent, TriggerInput, TriggerOverview, TriggerSecret, TriggerSettings, TriggerSummary } from '../../../shared/triggers';
import { EffortPicker, ModelPicker } from '../chat/ModelPicker';
import { authPost } from '../auth/AuthGate';
import { absoluteTime, relativeTime, sessionTitle } from '../common/lib';
import { translateMessage, useI18n } from '../i18n/i18n';
import { SlackPanel } from '../slack/SlackPanel';

type Tab = 'triggers' | 'history' | 'settings';
type Source = TriggerInput['source'];
type HttpSource = Extract<Source, { kind: 'http' }>;
type GitHubSource = Extract<Source, { kind: 'github' }>;
interface Context { token: string; providers: ProviderHealth[]; projects: [string, string][]; sessions: Session[] }

/** Calls a Tower operation (shared/api/operations.ts) as the owner. */
export function towerOperation<T>(token: string, operation: string, input: unknown = {}): Promise<T> {
  return authPost<{ result: T }>(`/api/v1/${operation}`, token, input).then(response => response.result);
}

export function TriggerButton({ token, overview, ...context }: Omit<Context, 'token'> & { token: string; overview?: TriggerOverview }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [slack, setSlack] = useState(false);
  const attention = overview?.storageError || overview?.triggers.some(item => item.paused || item.error || item.lastEvent?.status === 'error' || item.lastEvent?.status === 'uncertain');
  return <>
    <button className={`icon-button trigger-button ${attention ? 'attention' : ''}`} aria-label={t('트리거')} title={t('트리거')} disabled={!token} onClick={() => setOpen(true)}><Zap size={18} /></button>
    {open && <TriggerPanel {...context} token={token} overview={overview} onClose={() => setOpen(false)} onOpenSlack={() => { setOpen(false); setSlack(true); }} />}
    {slack && <SlackPanel providers={context.providers} token={token} onClose={() => setSlack(false)} />}
  </>;
}

export function TriggerPanel({ token, overview, providers, projects, sessions, onClose, onOpenSlack }: Context & { overview?: TriggerOverview; onClose: () => void; onOpenSlack: () => void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<Tab>('triggers');
  const [triggers, setTriggers] = useState<Trigger[] | null>(null);
  const [editing, setEditing] = useState<Trigger | 'new' | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const available = Boolean(overview);
  const refresh = useCallback(async () => {
    if (!available) return;
    try { setTriggers((await towerOperation<{ triggers: Trigger[] }>(token, 'triggers.list')).triggers); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [available, token]);
  const revisions = overview?.triggers.map(item => `${item.id}:${item.revision}`).join(',');
  useEffect(() => { void refresh(); }, [refresh, revisions]);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); if (opener?.isConnected) opener.focus(); };
  }, []);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await work(); await refresh(); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { setBusy(false); }
  };
  const close = () => { if (!editing || window.confirm(t('저장하지 않은 트리거 변경 사항을 버릴까요?'))) onClose(); };
  const summaries = new Map(overview?.triggers.map(item => [item.id, item]));
  const slack = overview?.triggers.find(item => item.kind === 'slack');
  return createPortal(<dialog ref={dialog} className="slack-dialog trigger-dialog" aria-labelledby="trigger-title" onCancel={event => { event.preventDefault(); close(); }}><div className="slack-panel">
    <header className="slack-head"><div><h2 id="trigger-title">{t('트리거')}</h2><p>{t('일정이나 외부 이벤트가 생기면 프로젝트 에이전트에게 작업을 맡깁니다.')}</p></div><button className="icon-button" aria-label={t('닫기')} onClick={close}><X size={18} /></button></header>
    <nav className="slack-tabs" role="tablist">{([['triggers', t('트리거'), CalendarClock], ['history', t('기록'), History], ['settings', t('설정'), Settings2]] as const).map(([id, label, Icon]) =>
      <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}><Icon size={14} />{label}</button>)}</nav>
    <div className="slack-body">
      {error && <p role="alert" className="slack-error">{translateMessage(error)}</p>}
      {overview?.storageError && <p role="alert" className="slack-error">{translateMessage(overview.storageError)}</p>}
      {!available ? <section className="trigger-list"><p className="slack-empty">{t('실행 워커가 새 버전으로 교체되면 트리거를 사용할 수 있습니다. 진행 중인 작업이 끝나면 자동으로 교체됩니다.')}</p>
        <ol className="slack-rule-list"><li className="slack-rule"><div className="slack-rule-row"><Slack size={16} /><span className="slack-rule-text"><strong>Slack</strong></span><button type="button" className="secondary-button" onClick={onOpenSlack}>{t('Slack 설정')}</button></div></li></ol></section>
        : tab === 'triggers' ? (editing
          ? <TriggerEditor key={editing === 'new' ? 'new' : editing.id} trigger={editing === 'new' ? undefined : editing} token={token} providers={providers} projects={projects} sessions={sessions} busy={busy}
            onCancel={() => setEditing(null)} onSave={input => run(async () => {
              if (editing === 'new') await towerOperation(token, 'triggers.create', { trigger: input });
              else await towerOperation(token, 'triggers.update', { id: editing.id, expectedRevision: editing.revision, trigger: input });
            }).then(ok => { if (ok) setEditing(null); })} />
          : <section className="trigger-list">
            <div className="slack-rules-intro"><p>{t('정한 시간마다, 또는 HTTP 응답이 조건에 맞을 때 지시를 프로젝트 에이전트에게 보냅니다. 에이전트가 트리거를 바꾸면 기록에 남고 되돌릴 수 있습니다.')}</p>
              <div className="slack-actions"><button type="button" className="secondary-button" onClick={() => setEditing('new')}><Plus size={14} />{t('트리거 추가')}</button></div></div>
            <ol className="slack-rule-list">
              {slack && <SlackRow summary={slack} onOpen={onOpenSlack} />}
              {!slack && <li className="slack-rule disabled"><div className="slack-rule-row"><Slack size={16} /><span className="slack-rule-text"><strong>Slack</strong><small>{t('연결되지 않음')}</small></span><button type="button" className="secondary-button" onClick={onOpenSlack}>{t('Slack 연결')}</button></div></li>}
              {triggers?.map(trigger => <TriggerRow key={trigger.id} trigger={trigger} summary={summaries.get(trigger.id)} busy={busy}
                onToggle={enabled => void run(() => towerOperation(token, 'triggers.setEnabled', { id: trigger.id, expectedRevision: trigger.revision, enabled }))}
                onRun={() => void run(() => towerOperation(token, 'triggers.run', { id: trigger.id }))}
                onEdit={() => setEditing(trigger)}
                onDelete={() => void run(() => towerOperation(token, 'triggers.delete', { id: trigger.id, expectedRevision: trigger.revision }))} />)}
            </ol>
            {triggers && !triggers.length && <p className="slack-empty">{t('아직 만든 트리거가 없습니다.')}</p>}
          </section>)
        : tab === 'history' ? <TriggerHistory token={token} overview={overview!} onChanged={refresh} />
        : <><TriggerLimits token={token} /><TriggerSecrets token={token} /></>}
    </div>
  </div></dialog>, document.body);
}

function SlackRow({ summary, onOpen }: { summary: TriggerSummary; onOpen: () => void }) {
  const { t } = useI18n();
  return <li className={`slack-rule ${summary.enabled ? '' : 'disabled'}`}><div className="slack-rule-row">
    <Slack size={16} />
    <span className="slack-rule-text"><strong>{summary.name}</strong><small>{summary.enabled ? t('새 멘션을 받는 중') : t('새 멘션 받지 않음 · 받은 대화는 계속 처리')}</small></span>
    {summary.error && <span className="slack-badges"><span className="warn">{t('오류')}</span></span>}
    <button type="button" className="secondary-button" onClick={onOpen}>{t('Slack 설정')}</button>
  </div></li>;
}

export function scheduleLabel(trigger: Pick<Trigger, 'source'>, t: (key: string, values?: Record<string, string | number>) => string): string {
  const schedule = trigger.source.schedule;
  const when = schedule.type === 'interval' ? schedule.everySeconds % 3600 === 0 ? t('{0}시간마다', { 0: schedule.everySeconds / 3600 }) : t('{0}분마다', { 0: Math.round(schedule.everySeconds / 60) })
    : `${schedule.expression} · ${schedule.timezone}`;
  if (trigger.source.kind === 'github') {
    const watch = trigger.source.watch;
    const repos = watch.repos?.length ? ` · ${watch.repos[0]}${watch.repos.length > 1 ? ` +${watch.repos.length - 1}` : ''}` : '';
    return `GitHub · ${watch.type === 'issue-opened' ? t('새 이슈') : t('나에게 할당')}${repos} · ${when}`;
  }
  if (trigger.source.kind !== 'http') return when;
  let host = trigger.source.request.url;
  try { host = new URL(host).host; } catch { /* shown as written */ }
  return `${trigger.source.request.method} ${host} · ${when}`;
}

function TriggerRow({ trigger, summary, busy, onToggle, onRun, onEdit, onDelete }: { trigger: Trigger; summary?: TriggerSummary; busy: boolean; onToggle: (enabled: boolean) => void; onRun: () => void; onEdit: () => void; onDelete: () => void }) {
  const { t } = useI18n();
  const [confirm, setConfirm] = useState(false);
  const last = summary?.lastEvent;
  const status = summary?.paused ? t('일시 정지') : last ? eventStatusLabel(last.status, t) : undefined;
  return <li className={`slack-rule ${trigger.enabled ? '' : 'disabled'}`}><div className="slack-rule-row">
    <label className="slack-switch" title={t('활성')}><input type="checkbox" aria-label={t('활성')} checked={trigger.enabled} disabled={busy} onChange={event => onToggle(event.target.checked)} /><span /></label>
    <button type="button" className="slack-rule-summary" onClick={onEdit}>
      {trigger.source.kind === 'http' ? <Globe size={16} /> : trigger.source.kind === 'github' ? <CircleDot size={16} /> : <CalendarClock size={16} />}
      <span className="slack-rule-text"><strong>{trigger.name}</strong><small>{scheduleLabel(trigger, t)}{summary?.nextRunAt ? ` · ${t('다음 실행')} ${absoluteTime(summary.nextRunAt)}` : ''}</small></span>
      <span className="slack-badges">
        <span>{trigger.handler.provider === 'claude' ? 'Claude' : 'Codex'}</span>
        {trigger.updatedBy.kind === 'agent' && <span className="accent" title={trigger.updatedBy.sessionId}>{t('에이전트가 변경')}</span>}
        {status && <span className={summary?.paused || last?.status === 'error' || last?.status === 'uncertain' ? 'warn' : ''} title={summary?.paused?.reason ?? last?.error ?? last?.reason}>{status}</span>}
        {summary?.error && <span className="warn" title={summary.error}>{t('요청 실패')}</span>}
      </span>
    </button>
    <div className="slack-rule-tools">
      <button type="button" className="icon-button" aria-label={t('지금 실행')} title={t('지금 실행')} disabled={busy} onClick={onRun}><Play size={15} /></button>
      <button type="button" className="icon-button" aria-label={t('편집')} title={t('편집')} onClick={onEdit}><Pencil size={15} /></button>
      {confirm ? <button type="button" className="slack-danger" onClick={() => { setConfirm(false); onDelete(); }} onBlur={() => setConfirm(false)}>{t('삭제 확인')}</button>
        : <button type="button" className="icon-button" aria-label={t('삭제')} title={t('삭제')} onClick={() => setConfirm(true)}><Trash2 size={15} /></button>}
    </div>
  </div></li>;
}

export function eventStatusLabel(status: TriggerEvent['status'], t: (key: string) => string): string {
  const labels: Record<TriggerEvent['status'], string> = { queued: '대기', claimed: '시작 중', running: '실행 중', completed: '완료', error: '오류', cancelled: '취소됨', uncertain: '확인 불가', skipped: '건너뜀', coalesced: '합쳐짐' };
  return t(labels[status]);
}

const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
export function blankHttpSource(schedule: Source['schedule'] = { type: 'interval', everySeconds: 300 }): HttpSource {
  return { kind: 'http', schedule, request: { method: 'GET', url: '', headers: [], timeoutSeconds: 30 }, condition: { type: 'changed' } };
}
export function blankGitHubSource(schedule: Source['schedule'] = { type: 'interval', everySeconds: 300 }): GitHubSource {
  return { kind: 'github', schedule, auth: { type: 'gh' }, account: '', watch: { type: 'issue-opened', repos: [], authorAssociation: ['OWNER', 'MEMBER', 'COLLABORATOR'] } };
}
export function blankTrigger(): TriggerInput {
  return { name: '', enabled: true, source: { kind: 'schedule', schedule: { type: 'cron', expression: '0 9 * * 1-5', timezone: browserZone() }, catchUp: 'latest' },
    handler: { kind: 'task', instructions: '', provider: 'codex', approvals: 'auto', target: { node: 'local', mode: 'auto' } }, policy: { overlap: 'skip', maxEventsPerHour: 20 } };
}

function TriggerEditor({ trigger, token, providers, projects, sessions, busy, onCancel, onSave }: Omit<Context, 'token'> & { token: string; trigger?: Trigger; busy: boolean; onCancel: () => void; onSave: (input: TriggerInput) => void }) {
  const { t } = useI18n();
  const [input, setInput] = useState<TriggerInput>(() => trigger ? { name: trigger.name, enabled: trigger.enabled, source: trigger.source, handler: trigger.handler, policy: trigger.policy } : blankTrigger());
  const [preview, setPreview] = useState<string[] | string>('');
  const schedule = input.source.schedule;
  const handler = input.handler;
  const setSchedule = (next: typeof schedule) => setInput({ ...input, source: { ...input.source, schedule: next } });
  const http = input.source.kind !== 'schedule';
  const setKind = (kind: Source['kind']) => {
    if (kind === input.source.kind) return;
    // Outside content never continues an existing session.
    const target = kind !== 'schedule' && handler.target.mode === 'session' ? { node: 'local' as const, mode: 'auto' as const } : handler.target;
    const interval = schedule.type === 'interval' ? schedule : undefined;
    setInput({ ...input, source: kind === 'http' ? blankHttpSource(interval) : kind === 'github' ? blankGitHubSource(interval) : { kind: 'schedule', schedule, catchUp: 'latest' }, handler: { ...handler, target } });
  };
  const setHandler = (patch: Partial<typeof handler>) => setInput({ ...input, handler: { ...handler, ...patch } });
  const provider = providers.find(item => item.provider === handler.provider);
  const candidates = sessions.filter(session => session.provider === handler.provider && !session.isSubagent && session.resumable).slice(0, 80);
  const showPreview = async () => {
    try { setPreview((await towerOperation<{ runs: string[] }>(token, 'triggers.preview', { schedule })).runs); }
    catch (cause) { setPreview(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <form className="slack-rule-editor trigger-editor" onSubmit={event => { event.preventDefault(); onSave(input); }}><fieldset disabled={busy} className="slack-rules">
    <label>{t('이름')}<input required maxLength={120} value={input.name} onChange={event => setInput({ ...input, name: event.target.value })} /></label>
    <label>{t('시작 조건')}<select value={input.source.kind} onChange={event => setKind(event.target.value as Source['kind'])}>
      <option value="schedule">{t('정한 시간 (예약 실행)')}</option><option value="http">{t('HTTP 응답 확인')}</option><option value="github">{t('GitHub 이슈')}</option></select></label>
    {input.source.kind === 'http' && <HttpFields token={token} source={input.source} onChange={source => setInput({ ...input, source })} />}
    {input.source.kind === 'github' && <GitHubFields token={token} source={input.source} onChange={source => setInput({ ...input, source })}
      onAccount={(login, auth) => setInput(previous => previous.source.kind === 'github' && JSON.stringify(previous.source.auth) === JSON.stringify(auth) ? { ...previous, source: { ...previous.source, account: login } } : previous)} />}
    <fieldset className="slack-group"><legend>{http ? t('확인 주기') : t('일정')}</legend><div className="slack-rule-options">
      <label>{t('방식')}<select value={schedule.type} onChange={event => setSchedule(event.target.value === 'interval' ? { type: 'interval', everySeconds: 3600 } : { type: 'cron', expression: '0 9 * * 1-5', timezone: browserZone() })}>
        <option value="cron">{t('크론')}</option><option value="interval">{t('일정 간격')}</option></select></label>
      {schedule.type === 'cron' ? <>
        <label>{t('크론 표현식')}<small>{t('분 시 일 월 요일 (예: 0 9 * * 1-5 = 평일 9시)')}</small><input required value={schedule.expression} onChange={event => setSchedule({ ...schedule, expression: event.target.value })} /></label>
        <label className="wide">{t('시간대')}<input required value={schedule.timezone} onChange={event => setSchedule({ ...schedule, timezone: event.target.value })} /></label>
      </> : <label>{t('간격 (분)')}<input type="number" required min={1} max={44640} value={Math.round(schedule.everySeconds / 60)} onChange={event => setSchedule({ type: 'interval', everySeconds: Math.max(1, Number(event.target.value) || 1) * 60 })} /></label>}
      {input.source.kind === 'schedule' ? <label className="wide">{t('놓친 실행')}<small>{t('컴퓨터가 잠자기 상태였거나 Tower가 꺼져 있던 동안의 실행')}</small><select value={input.source.catchUp} onChange={event => setInput({ ...input, source: { ...input.source, catchUp: event.target.value as 'latest' | 'skip' } as Source })}>
        <option value="latest">{t('하루 안에 놓친 가장 최근 시간을 한 번 실행')}</option><option value="skip">{t('건너뛰기')}</option></select></label>
        : <p className="wide trigger-note">{input.source.kind === 'github' ? t('놓친 사이에 생긴 이슈도 다음 확인에서 찾습니다.') : t('잠자기나 종료로 확인을 놓쳤다면 다시 켜진 뒤 한 번만 확인합니다.')}</p>}
    </div>
    <div className="trigger-preview"><button type="button" className="secondary-button" onClick={() => void showPreview()}>{t('다음 실행 시간 보기')}</button>
      {typeof preview === 'string' ? preview && <p className="slack-error">{translateMessage(preview)}</p> : <ol>{preview.map(time => <li key={time}>{absoluteTime(time)}</li>)}</ol>}</div>
    </fieldset>
    <label>{t('지시')}<small>{input.source.kind === 'github' ? t('이슈마다 에이전트에게 보내는 내용입니다. 이슈 내용은 지시가 아닌 참고 자료로 함께 전달됩니다.') : http ? t('실행될 때마다 에이전트에게 보내는 내용입니다. 받은 응답은 지시가 아닌 참고 자료로 함께 전달됩니다.') : t('실행될 때마다 에이전트에게 보내는 내용입니다.')}</small><textarea required rows={5} maxLength={8000} value={handler.instructions} onChange={event => setHandler({ instructions: event.target.value })} /></label>
    <fieldset className="slack-group"><legend>{t('실행')}</legend><div className="slack-rule-options">
      <label>{t('에이전트')}<select value={handler.provider} onChange={event => setHandler({ provider: event.target.value as 'claude' | 'codex', model: undefined, effort: undefined,
        target: handler.target.mode === 'session' ? { node: 'local', mode: 'auto' } : handler.target })}><option value="codex">Codex</option><option value="claude">Claude</option></select></label>
      <label>{t('모델')}<span className="trigger-model"><ModelPicker provider={provider} value={handler.model} onChange={model => setHandler({ model, effort: undefined })} />
        <EffortPicker provider={provider} model={handler.model ?? provider?.defaultModel} value={handler.effort} onChange={effort => setHandler({ effort })} /></span></label>
      <label>{t('승인')}<select value={handler.approvals} onChange={event => setHandler({ approvals: event.target.value as 'auto' | 'owner' })}>
        <option value="auto">{t('자동 승인 (사람 개입 최소)')}</option><option value="owner">{t('직접 승인 (Tower에서 대기)')}</option></select></label>
      <label>{t('보낼 곳')}<select value={handler.target.mode} onChange={event => {
        const mode = event.target.value;
        setHandler({ target: mode === 'folder' ? { node: 'local', mode: 'folder', cwd: projects[0]?.[0] ?? '' } : mode === 'session' ? { node: 'local', mode: 'session', sessionId: candidates[0]?.id ?? '' } : { node: 'local', mode: 'auto' } });
      }}><option value="auto">{http ? t('Auto (프로젝트 자동 선택, 새 세션)') : t('Auto (프로젝트와 세션 자동 선택)')}</option><option value="folder">{t('폴더의 새 세션')}</option>
        {!http && <option value="session">{t('기존 세션에 이어서')}</option>}</select></label>
      {handler.target.mode === 'folder' && <label className="wide">{t('폴더')}<select required value={handler.target.cwd} onChange={event => setHandler({ target: { node: 'local', mode: 'folder', cwd: event.target.value } })}>
        {projects.map(([cwd, title]) => <option key={cwd} value={cwd}>{title} — {cwd}</option>)}</select></label>}
      {handler.target.mode === 'session' && <label className="wide">{t('세션')}<select required value={handler.target.sessionId} onChange={event => setHandler({ target: { node: 'local', mode: 'session', sessionId: event.target.value } })}>
        {candidates.map(session => <option key={session.id} value={session.id}>{sessionTitle(session)} — {session.project}</option>)}</select>
        {handler.provider === 'codex' && <small>{t('기존 Codex 세션은 자체 승인 설정을 유지합니다.')}</small>}</label>}
    </div></fieldset>
    <fieldset className="slack-group"><legend>{t('정책')}</legend><div className="slack-rule-options">
      <label>{t('이전 실행이 끝나지 않았을 때')}<select value={input.policy.overlap} onChange={event => setInput({ ...input, policy: { ...input.policy, overlap: event.target.value as 'skip' | 'queue' | 'parallel' } })}>
        <option value="skip">{t('건너뛰기')}</option><option value="queue">{t('하나만 대기')}</option><option value="parallel">{t('동시에 실행')}</option></select></label>
      <label>{t('시간당 최대 실행')}<small>{t('넘으면 자동으로 일시 정지합니다.')}</small><input type="number" min={1} max={60} value={input.policy.maxEventsPerHour} onChange={event => setInput({ ...input, policy: { ...input.policy, maxEventsPerHour: Math.min(60, Math.max(1, Number(event.target.value) || 1)) } })} /></label>
    </div></fieldset>
    <div className="slack-actions"><button type="button" className="secondary-button" onClick={onCancel}>{t('취소')}</button><button className="primary-button">{trigger ? t('저장') : t('만들기')}</button></div>
  </fieldset></form>;
}

const CONDITIONS: Array<[HttpCondition['type'], string]> = [['changed', '값이 바뀌면 실행'], ['match', '조건을 만족하게 되면 실행'], ['every-success', '성공 응답마다 실행']];
const OPERATORS: Array<[Extract<HttpCondition, { type: 'match' }>['operator'], string]> = [['equals', '같음'], ['not-equals', '다름'], ['contains', '포함'], ['exists', '값이 있음'], ['gt', '보다 큼'], ['lt', '보다 작음']];

function HttpFields({ token, source, onChange }: { token: string; source: HttpSource; onChange: (source: HttpSource) => void }) {
  const { t } = useI18n();
  const [secrets, setSecrets] = useState<TriggerSecret[]>([]);
  const [result, setResult] = useState<HttpTestResult | string>('');
  const [testing, setTesting] = useState(false);
  useEffect(() => { void towerOperation<{ secrets: TriggerSecret[] }>(token, 'secrets.list').then(value => setSecrets(value.secrets), () => setSecrets([])); }, [token]);
  const request = source.request;
  const condition = source.condition;
  const setRequest = (patch: Partial<HttpSource['request']>) => onChange({ ...source, request: { ...request, ...patch } });
  const setCondition = (next: HttpCondition) => onChange({ ...source, condition: next });
  const setHeader = (index: number, header: HttpSource['request']['headers'][number]) => setRequest({ headers: request.headers.map((item, position) => position === index ? header : item) });
  let origin = '';
  try { origin = new URL(request.url).origin; } catch { /* not a URL yet */ }
  const usable = secrets.filter(secret => secret.origin === origin);
  const test = async () => {
    setTesting(true); setResult('');
    try { setResult((await towerOperation<{ result: HttpTestResult }>(token, 'triggers.testHttp', { request, condition })).result); }
    catch (cause) { setResult(cause instanceof Error ? cause.message : String(cause)); }
    finally { setTesting(false); }
  };
  return <>
    <fieldset className="slack-group"><legend>{t('요청')}</legend><div className="slack-rule-options">
      <label>{t('메서드')}<select value={request.method} onChange={event => setRequest({ method: event.target.value as 'GET' | 'POST', ...(event.target.value === 'GET' ? { body: undefined } : {}) })}>
        <option value="GET">GET</option><option value="POST">POST</option></select></label>
      <label>{t('제한 시간 (초)')}<input type="number" min={1} max={45} value={request.timeoutSeconds} onChange={event => setRequest({ timeoutSeconds: Math.min(45, Math.max(1, Number(event.target.value) || 1)) })} /></label>
      <label className="wide">URL<small>{t('이 컴퓨터나 사설 네트워크 주소는 설정에서 허용한 곳만 부를 수 있습니다.')}</small><input required type="url" maxLength={4000} placeholder="https://api.example.com/status" value={request.url} onChange={event => setRequest({ url: event.target.value })} /></label>
      <div className="wide trigger-headers"><span>{t('헤더')}</span>
        {request.headers.map((header, index) => <div key={index} className="trigger-header-row">
          <input aria-label={t('헤더 이름')} placeholder="Accept" required maxLength={100} value={header.name} onChange={event => setHeader(index, { ...header, name: event.target.value })} />
          {'secretId' in header
            ? <select aria-label={t('비밀 값')} required value={header.secretId} onChange={event => setHeader(index, { name: header.name, secretId: event.target.value })}>
              <option value="">{t('비밀 값 선택')}</option>
              {secrets.filter(secret => secret.origin === origin || secret.id === header.secretId).map(secret => <option key={secret.id} value={secret.id}>{secret.name} — {secret.origin}</option>)}</select>
            : <input aria-label={t('헤더 값')} maxLength={4000} value={header.value} onChange={event => setHeader(index, { name: header.name, value: event.target.value })} />}
          <button type="button" className="secondary-button" title={t('값과 저장된 비밀 사이 전환')} onClick={() => setHeader(index, 'secretId' in header ? { name: header.name, value: '' } : { name: header.name, secretId: usable[0]?.id ?? '' })}>
            <KeyRound size={13} />{'secretId' in header ? t('값 직접 입력') : t('비밀 사용')}</button>
          <button type="button" className="icon-button" aria-label={t('헤더 삭제')} onClick={() => setRequest({ headers: request.headers.filter((_item, position) => position !== index) })}><Trash2 size={14} /></button>
        </div>)}
        {request.headers.length < 20 && <button type="button" className="secondary-button" onClick={() => setRequest({ headers: [...request.headers, { name: '', value: '' }] })}><Plus size={13} />{t('헤더 추가')}</button>}
        {request.headers.some(header => 'secretId' in header) && !usable.length && <small>{t('이 주소에 쓸 수 있는 비밀이 없습니다. 설정 탭에서 이 주소용 비밀을 먼저 저장하세요.')}</small>}
      </div>
      {request.method === 'POST' && <label className="wide">{t('본문')}<textarea rows={4} maxLength={64000} value={request.body ?? ''} onChange={event => setRequest({ body: event.target.value || undefined })} /></label>}
    </div></fieldset>
    <fieldset className="slack-group"><legend>{t('실행 조건')}</legend><div className="slack-rule-options">
      <label className="wide">{t('언제 실행할까요')}<select value={condition.type} onChange={event => setCondition(event.target.value === 'match' ? { type: 'match', pointer: '', operator: 'equals', value: '' }
        : event.target.value === 'changed' ? { type: 'changed' } : { type: 'every-success' })}>{CONDITIONS.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select>
        {condition.type !== 'every-success' && <small>{t('처음 받은 응답은 기준으로만 쓰고 실행하지 않습니다.')}</small>}</label>
      {condition.type !== 'every-success' && <label className="wide">{t('볼 값 (JSON Pointer)')}<small>{t('예: /status, /items/0/id. 비우면 응답 전체')}</small>
        <input maxLength={500} placeholder="/status" value={condition.pointer ?? ''} onChange={event => setCondition({ ...condition, pointer: event.target.value || undefined })} /></label>}
      {condition.type === 'match' && <>
        <label>{t('비교')}<select value={condition.operator} onChange={event => setCondition({ ...condition, operator: event.target.value as typeof condition.operator })}>
          {OPERATORS.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label>
        {condition.operator !== 'exists' && <label>{t('값')}<input maxLength={1000} value={condition.value ?? ''} onChange={event => setCondition({ ...condition, value: event.target.value })} /></label>}
      </>}
    </div>
    <div className="trigger-preview">
      <button type="button" className="secondary-button" disabled={testing || !request.url} onClick={() => void test()}>{testing ? t('보내는 중') : t('요청 테스트')}</button>
      {request.method === 'POST' && <small>{t('POST 요청은 테스트에서도 실제로 전송됩니다.')}</small>}
      {typeof result === 'string' ? result && <p className="slack-error">{translateMessage(result)}</p>
        : <div className="trigger-test-result">
          {result.status !== undefined && <strong>HTTP {result.status}{result.contentType ? ` · ${result.contentType}` : ''}</strong>}
          {result.error && <p className="slack-error">{translateMessage(result.error)}</p>}
          {result.selected !== undefined && <p>{t('선택한 값')}: <code>{typeof result.selected === 'string' ? result.selected : JSON.stringify(result.selected)}</code></p>}
          {result.matched !== undefined && <p>{result.matched ? t('지금 조건을 만족합니다.') : t('지금은 조건을 만족하지 않습니다.')}</p>}
          {result.body && <pre>{result.body}{result.truncated ? '\n…' : ''}</pre>}
        </div>}
    </div></fieldset>
  </>;
}

const MEMBERS = ['OWNER', 'MEMBER', 'COLLABORATOR'] as const;
const list = (value: string) => value.split(/[\n,]/).map(item => item.trim()).filter(Boolean);

function GitHubFields({ token, source, onChange, onAccount }: { token: string; source: GitHubSource; onChange: (source: GitHubSource) => void;
  /** Sets the checked account, only if the sign-in it was checked with is still the one chosen. */
  onAccount: (login: string, auth: GitHubSource['auth']) => void }) {
  const { t } = useI18n();
  const [secrets, setSecrets] = useState<TriggerSecret[]>([]);
  const [check, setCheck] = useState<GitHubCheck | string>('');
  const [checking, setChecking] = useState(false);
  const checks = useRef(0);
  const reset = () => { checks.current++; setCheck(''); setChecking(false); };
  // Typed text is kept as written, so a trailing comma or line does not vanish while typing.
  const [repos, setRepos] = useState(source.watch.repos?.join('\n') ?? '');
  const [labels, setLabels] = useState(source.watch.type === 'issue-opened' ? source.watch.labels?.join(', ') ?? '' : '');
  const [authors, setAuthors] = useState(source.watch.type === 'issue-opened' ? source.watch.authors?.join(', ') ?? '' : '');
  useEffect(() => { void towerOperation<{ secrets: TriggerSecret[] }>(token, 'secrets.list').then(value => setSecrets(value.secrets.filter(secret => secret.origin === GITHUB_API)), () => setSecrets([])); }, [token]);
  const watch = source.watch;
  const setWatch = (next: GitHubSource['watch']) => onChange({ ...source, watch: next });
  const association = watch.type !== 'issue-opened' ? 'members' : watch.authorAssociation === 'any' ? 'any'
    : [...watch.authorAssociation].sort().join() === [...MEMBERS].sort().join() ? 'members' : 'custom';
  const verify = async () => {
    setChecking(true); setCheck('');
    const auth = source.auth;
    const asked = ++checks.current;
    try {
      const result = (await towerOperation<{ result: GitHubCheck }>(token, 'triggers.checkGitHub', { auth })).result;
      // A reply to a check started before the sign-in changed is not shown.
      if (asked !== checks.current) return;
      setCheck(result);
      if (result.ok && result.login) onAccount(result.login, auth);
    } catch (cause) { if (asked === checks.current) setCheck(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (asked === checks.current) setChecking(false); }
  };
  return <>
    <fieldset className="slack-group"><legend>{t('GitHub 연결')}</legend><div className="slack-rule-options">
      <label>{t('인증')}<select value={source.auth.type} onChange={event => { reset(); onChange({ ...source, account: '', auth: event.target.value === 'token' ? { type: 'token', secretId: secrets[0]?.id ?? '' } : { type: 'gh' } }); }}>
        <option value="gh">{t('이 컴퓨터의 gh 로그인')}</option><option value="token">{t('저장한 토큰')}</option></select></label>
      {source.auth.type === 'token' && <label>{t('토큰')}<select required value={source.auth.secretId} onChange={event => { reset(); onChange({ ...source, account: '', auth: { type: 'token', secretId: event.target.value } }); }}>
        <option value="">{t('비밀 값 선택')}</option>{secrets.map(secret => <option key={secret.id} value={secret.id}>{secret.name}</option>)}</select>
        {!secrets.length && <small>{t('설정 탭에서 https://api.github.com 용 비밀로 토큰을 먼저 저장하세요.')}</small>}</label>}
      <div className="wide trigger-preview">
        <button type="button" className="secondary-button" disabled={checking} onClick={() => void verify()}>{checking ? t('확인 중') : t('연결 확인')}</button>
        {typeof check === 'string' ? check && <p className="slack-error">{translateMessage(check)}</p>
          : check.ok ? <p>{t('{0} 계정으로 확인합니다.', { 0: check.login ?? '' })}</p> : <p className="slack-error">{translateMessage(check.error ?? '')}</p>}
        {!source.account && <small>{t('저장하기 전에 연결을 확인해 계정을 정하세요.')}</small>}
        {source.account && typeof check === 'string' && <small>{t('{0} 계정으로 확인합니다.', { 0: source.account })}</small>}
      </div>
    </div></fieldset>
    <fieldset className="slack-group"><legend>{t('감시')}</legend><div className="slack-rule-options">
      <label className="wide">{t('무엇을 볼까요')}<select value={watch.type} onChange={event => setWatch(event.target.value === 'assigned-to-me'
        ? { type: 'assigned-to-me', ...(list(repos).length ? { repos: list(repos) } : {}), includePullRequests: false }
        : { type: 'issue-opened', repos: list(repos), authorAssociation: [...MEMBERS], ...(list(labels).length ? { labels: list(labels) } : {}), ...(list(authors).length ? { authors: list(authors) } : {}) })}>
        <option value="issue-opened">{t('저장소에 새로 열린 이슈')}</option><option value="assigned-to-me">{t('나에게 새로 할당된 이슈')}</option></select>
        <small>{t('처음 확인할 때 이미 있던 이슈로는 실행하지 않습니다.')}</small></label>
      <label className="wide">{t('저장소')}<small>{watch.type === 'issue-opened' ? t('한 줄에 하나씩 owner/name') : t('비우면 모든 저장소, 한 줄에 하나씩 owner/name')}</small>
        <textarea rows={2} required={watch.type === 'issue-opened'} value={repos} onChange={event => { setRepos(event.target.value); const names = list(event.target.value);
          setWatch(watch.type === 'issue-opened' ? { ...watch, repos: names } : { ...watch, ...(names.length ? { repos: names } : { repos: undefined }) }); }} /></label>
      {watch.type === 'issue-opened' ? <>
        <label>{t('라벨')}<small>{t('쉼표로 구분, 하나라도 있으면')}</small><input value={labels} onChange={event => { setLabels(event.target.value); const names = list(event.target.value); setWatch({ ...watch, labels: names.length ? names : undefined }); }} /></label>
        <label>{t('작성자')}<small>{t('쉼표로 구분, 비우면 누구나')}</small><input value={authors} onChange={event => { setAuthors(event.target.value); const names = list(event.target.value); setWatch({ ...watch, authors: names.length ? names : undefined }); }} /></label>
        <label className="wide">{t('작성자 범위')}<select value={association} onChange={event => { if (event.target.value !== 'custom') setWatch({ ...watch, authorAssociation: event.target.value === 'any' ? 'any' : [...MEMBERS] }); }}>
          <option value="members">{t('저장소 소유자·멤버·협업자 (권장)')}</option><option value="any">{t('누구나 (공개 저장소라면 외부인도)')}</option>
          {association === 'custom' && watch.authorAssociation !== 'any' && <option value="custom">{watch.authorAssociation.join(', ')}</option>}</select></label>
      </> : <label className="trigger-checkbox"><input type="checkbox" checked={watch.includePullRequests} onChange={event => setWatch({ ...watch, includePullRequests: event.target.checked })} />{t('풀 리퀘스트도 포함')}</label>}
    </div></fieldset>
  </>;
}

function TriggerHistory({ token, overview, onChanged }: { token: string; overview: TriggerOverview; onChanged: () => Promise<void> }) {
  const { t } = useI18n();
  const [audit, setAudit] = useState<TriggerAuditEntry[]>([]);
  const [events, setEvents] = useState<TriggerEvent[]>(overview.recent);
  const [deleted, setDeleted] = useState<Trigger[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const [log, runs, removed] = await Promise.all([towerOperation<{ audit: TriggerAuditEntry[] }>(token, 'triggers.audit', { limit: 100 }),
        towerOperation<{ events: TriggerEvent[] }>(token, 'triggers.events', { limit: 100 }), towerOperation<{ triggers: Trigger[] }>(token, 'triggers.deleted')]);
      setAudit(log.audit); setEvents(runs.events); setDeleted(removed.triggers); setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [token]);
  useEffect(() => { void load(); }, [load, overview.recent[0]?.updatedAt]);
  const act = async (operation: string, input: unknown) => {
    try { await towerOperation(token, operation, input); await Promise.all([load(), onChanged()]); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const currentRevision = new Map(overview.triggers.map(item => [item.id, item.revision]));
  return <section className="trigger-history">
    {error && <p role="alert" className="slack-error">{translateMessage(error)}</p>}
    <h3>{t('최근 실행')}</h3>
    {events.length ? <ol className="slack-activity">{events.map(event => <li key={event.id}>
      <strong>{event.triggerName} · {eventStatusLabel(event.status, t)}</strong><span>{absoluteTime(event.occurredAt)} · {event.summary}</span>
      {(event.error || event.reason) && <p className={event.error ? 'slack-error' : ''}>{translateMessage(event.error ?? event.reason!)}</p>}
    </li>)}</ol> : <p>{t('아직 실행 기록이 없습니다.')}</p>}
    <h3>{t('변경 기록')}</h3>
    {audit.length ? <ol className="slack-activity">{audit.map(entry => <li key={entry.id}>
      <strong>{entry.triggerName || t('설정')} · {entry.summary}</strong>
      <span>{relativeTime(entry.at)} · {entry.actor.kind === 'agent' ? t('에이전트 ({0})', { 0: entry.actor.sessionId ?? '?' }) : entry.actor.kind === 'owner' ? t('나') : t('시스템')}</span>
      {entry.fromRevision && currentRevision.has(entry.triggerId) && ['update', 'revert'].includes(entry.action) &&
        <button type="button" className="secondary-button" onClick={() => void act('triggers.revert', { id: entry.triggerId, revision: entry.fromRevision, expectedRevision: currentRevision.get(entry.triggerId) })}><RotateCcw size={13} />{t('이 변경 전으로 되돌리기')}</button>}
    </li>)}</ol> : <p>{t('아직 변경 기록이 없습니다.')}</p>}
    {deleted.length > 0 && <><h3>{t('삭제한 트리거')}</h3><ol className="slack-activity">{deleted.map(trigger => <li key={`${trigger.id}:${trigger.revision}`}>
      <strong>{trigger.name}</strong><span>{relativeTime(trigger.updatedAt)}</span>
      <button type="button" className="secondary-button" onClick={() => void act('triggers.restore', { id: trigger.id })}><RotateCcw size={13} />{t('복원 (꺼진 상태)')}</button>
    </li>)}</ol></>}
  </section>;
}

function TriggerLimits({ token }: { token: string }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<TriggerSettings | null>(null);
  const [hosts, setHosts] = useState('');
  const [status, setStatus] = useState('');
  useEffect(() => { void towerOperation<{ settings: TriggerSettings }>(token, 'triggers.settings').then(result => { setSettings(result.settings); setHosts((result.settings.privateHosts ?? []).join('\n')); }, cause => setStatus(String(cause))); }, [token]);
  if (!settings) return <p role="status">{status || t('불러오는 중')}</p>;
  const field = (key: 'maxTriggers' | 'maxConcurrentRuns' | 'maxEventsPerHour', label: string, max: number) => <label>{label}<input type="number" min={1} max={max} value={settings[key]} onChange={event => setSettings({ ...settings, [key]: Math.min(max, Math.max(1, Number(event.target.value) || 1)) })} /></label>;
  return <form className="slack-settings" onSubmit={event => { event.preventDefault(); void towerOperation(token, 'triggers.updateSettings', { settings }).then(() => setStatus(t('저장했습니다.')), cause => setStatus(cause instanceof Error ? cause.message : String(cause))); }}>
    <p>{t('모든 트리거에 함께 적용되는 한도입니다. 에이전트는 바꿀 수 없습니다.')}</p>
    {field('maxTriggers', t('최대 트리거 수'), 200)}
    {field('maxConcurrentRuns', t('동시에 실행할 트리거 작업 수'), 10)}
    {field('maxEventsPerHour', t('모든 트리거의 시간당 최대 실행'), 600)}
    {/* A worker from before HTTP triggers has no such setting; the list appears once it is updated. */}
    {settings.privateHosts && <label>{t('HTTP 트리거가 부를 수 있는 내부 주소')}<small>{t('한 줄에 하나씩: 호스트 이름이나 CIDR (예: 127.0.0.1, 192.168.0.0/16). Tower 자신은 항상 제외됩니다.')}</small>
      <textarea rows={3} value={hosts} onChange={event => { setHosts(event.target.value); setSettings({ ...settings, privateHosts: event.target.value.split('\n').map(line => line.trim()).filter(Boolean) }); }} /></label>}
    <div className="slack-actions"><button className="primary-button">{t('저장')}</button>{status && <span role="status">{translateMessage(status)}</span>}</div>
  </form>;
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
  return <section className="slack-settings trigger-secrets">
    <h3>{t('헤더 비밀')}</h3>
    <p>{t('API 키 같은 헤더 값을 저장합니다. 정한 주소(origin)에만, 내가 고른 트리거에서만 보내며 에이전트는 값을 볼 수 없습니다.')}</p>
    {secrets?.length ? <ol className="slack-activity">{secrets.map(secret => <li key={secret.id}>
      <strong>{secret.name}</strong><span>{secret.origin} · {t('트리거 {0}개에서 사용', { 0: secret.triggerIds.length })}</span>
      {confirm === secret.id ? <button type="button" className="slack-danger" onBlur={() => setConfirm('')} onClick={() => { setConfirm(''); void act(() => towerOperation(token, 'secrets.delete', { id: secret.id })); }}>{t('삭제 확인')}</button>
        : <button type="button" className="secondary-button" onClick={() => setConfirm(secret.id)}><Trash2 size={13} />{t('삭제')}</button>}
    </li>)}</ol> : secrets && <p className="slack-empty">{t('저장한 비밀이 없습니다.')}</p>}
    <form className="trigger-secret-form" onSubmit={event => { event.preventDefault(); void act(() => towerOperation(token, 'secrets.create', { secret: draft })).then(ok => { if (ok) setDraft({ name: '', origin: '', value: '' }); }); }}>
      <label>{t('이름')}<input required maxLength={100} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <label>{t('보낼 주소 (origin)')}<input required type="url" placeholder="https://api.example.com" value={draft.origin} onChange={event => setDraft({ ...draft, origin: event.target.value })} /></label>
      <label>{t('값')}<input required type="password" autoComplete="off" maxLength={4000} placeholder="Bearer …" value={draft.value} onChange={event => setDraft({ ...draft, value: event.target.value })} /></label>
      <div className="slack-actions"><button className="primary-button"><KeyRound size={13} />{t('비밀 저장')}</button></div>
    </form>
    {status && <p role="alert" className="slack-error">{translateMessage(status)}</p>}
  </section>;
}
