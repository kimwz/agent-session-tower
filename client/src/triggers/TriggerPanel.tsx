import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarClock, History, Pencil, Play, Plus, RotateCcw, Settings2, Slack, Trash2, X, Zap } from 'lucide-react';
import type { ProviderHealth, Session } from '../../../shared/types';
import type { Trigger, TriggerAuditEntry, TriggerEvent, TriggerInput, TriggerOverview, TriggerSettings, TriggerSummary } from '../../../shared/triggers';
import { EffortPicker, ModelPicker } from '../chat/ModelPicker';
import { authPost } from '../auth/AuthGate';
import { absoluteTime, relativeTime, sessionTitle } from '../common/lib';
import { translateMessage, useI18n } from '../i18n/i18n';
import { SlackPanel } from '../slack/SlackPanel';

type Tab = 'triggers' | 'history' | 'settings';
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
            <div className="slack-rules-intro"><p>{t('예약 실행은 정한 시간마다 지시를 프로젝트 에이전트에게 보냅니다. 에이전트가 트리거를 바꾸면 기록에 남고 되돌릴 수 있습니다.')}</p>
              <div className="slack-actions"><button type="button" className="secondary-button" onClick={() => setEditing('new')}><Plus size={14} />{t('예약 실행 추가')}</button></div></div>
            <ol className="slack-rule-list">
              {slack && <SlackRow summary={slack} onOpen={onOpenSlack} />}
              {!slack && <li className="slack-rule disabled"><div className="slack-rule-row"><Slack size={16} /><span className="slack-rule-text"><strong>Slack</strong><small>{t('연결되지 않음')}</small></span><button type="button" className="secondary-button" onClick={onOpenSlack}>{t('Slack 연결')}</button></div></li>}
              {triggers?.map(trigger => <TriggerRow key={trigger.id} trigger={trigger} summary={summaries.get(trigger.id)} busy={busy}
                onToggle={enabled => void run(() => towerOperation(token, 'triggers.setEnabled', { id: trigger.id, expectedRevision: trigger.revision, enabled }))}
                onRun={() => void run(() => towerOperation(token, 'triggers.run', { id: trigger.id }))}
                onEdit={() => setEditing(trigger)}
                onDelete={() => void run(() => towerOperation(token, 'triggers.delete', { id: trigger.id, expectedRevision: trigger.revision }))} />)}
            </ol>
            {triggers && !triggers.length && <p className="slack-empty">{t('아직 예약 실행이 없습니다.')}</p>}
          </section>)
        : tab === 'history' ? <TriggerHistory token={token} overview={overview!} onChanged={refresh} />
        : <TriggerLimits token={token} />}
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
  if (schedule.type === 'interval') return schedule.everySeconds % 3600 === 0 ? t('{0}시간마다', { 0: schedule.everySeconds / 3600 }) : t('{0}분마다', { 0: Math.round(schedule.everySeconds / 60) });
  return `${schedule.expression} · ${schedule.timezone}`;
}

function TriggerRow({ trigger, summary, busy, onToggle, onRun, onEdit, onDelete }: { trigger: Trigger; summary?: TriggerSummary; busy: boolean; onToggle: (enabled: boolean) => void; onRun: () => void; onEdit: () => void; onDelete: () => void }) {
  const { t } = useI18n();
  const [confirm, setConfirm] = useState(false);
  const last = summary?.lastEvent;
  const status = summary?.paused ? t('일시 정지') : last ? eventStatusLabel(last.status, t) : undefined;
  return <li className={`slack-rule ${trigger.enabled ? '' : 'disabled'}`}><div className="slack-rule-row">
    <label className="slack-switch" title={t('활성')}><input type="checkbox" aria-label={t('활성')} checked={trigger.enabled} disabled={busy} onChange={event => onToggle(event.target.checked)} /><span /></label>
    <button type="button" className="slack-rule-summary" onClick={onEdit}>
      <CalendarClock size={16} />
      <span className="slack-rule-text"><strong>{trigger.name}</strong><small>{scheduleLabel(trigger, t)}{summary?.nextRunAt ? ` · ${t('다음 실행')} ${absoluteTime(summary.nextRunAt)}` : ''}</small></span>
      <span className="slack-badges">
        <span>{trigger.handler.provider === 'claude' ? 'Claude' : 'Codex'}</span>
        {trigger.updatedBy.kind === 'agent' && <span className="accent" title={trigger.updatedBy.sessionId}>{t('에이전트가 변경')}</span>}
        {status && <span className={summary?.paused || last?.status === 'error' || last?.status === 'uncertain' ? 'warn' : ''} title={summary?.paused?.reason ?? last?.error ?? last?.reason}>{status}</span>}
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
  const setHandler = (patch: Partial<typeof handler>) => setInput({ ...input, handler: { ...handler, ...patch } });
  const provider = providers.find(item => item.provider === handler.provider);
  const candidates = sessions.filter(session => session.provider === handler.provider && !session.isSubagent && session.resumable).slice(0, 80);
  const showPreview = async () => {
    try { setPreview((await towerOperation<{ runs: string[] }>(token, 'triggers.preview', { schedule })).runs); }
    catch (cause) { setPreview(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <form className="slack-rule-editor trigger-editor" onSubmit={event => { event.preventDefault(); onSave(input); }}><fieldset disabled={busy} className="slack-rules">
    <label>{t('이름')}<input required maxLength={120} value={input.name} onChange={event => setInput({ ...input, name: event.target.value })} /></label>
    <fieldset className="slack-group"><legend>{t('일정')}</legend><div className="slack-rule-options">
      <label>{t('방식')}<select value={schedule.type} onChange={event => setSchedule(event.target.value === 'interval' ? { type: 'interval', everySeconds: 3600 } : { type: 'cron', expression: '0 9 * * 1-5', timezone: browserZone() })}>
        <option value="cron">{t('크론')}</option><option value="interval">{t('일정 간격')}</option></select></label>
      {schedule.type === 'cron' ? <>
        <label>{t('크론 표현식')}<small>{t('분 시 일 월 요일 (예: 0 9 * * 1-5 = 평일 9시)')}</small><input required value={schedule.expression} onChange={event => setSchedule({ ...schedule, expression: event.target.value })} /></label>
        <label className="wide">{t('시간대')}<input required value={schedule.timezone} onChange={event => setSchedule({ ...schedule, timezone: event.target.value })} /></label>
      </> : <label>{t('간격 (분)')}<input type="number" required min={1} max={44640} value={Math.round(schedule.everySeconds / 60)} onChange={event => setSchedule({ type: 'interval', everySeconds: Math.max(1, Number(event.target.value) || 1) * 60 })} /></label>}
      <label className="wide">{t('놓친 실행')}<small>{t('컴퓨터가 잠자기 상태였거나 Tower가 꺼져 있던 동안의 실행')}</small><select value={input.source.catchUp} onChange={event => setInput({ ...input, source: { ...input.source, catchUp: event.target.value as 'latest' | 'skip' } })}>
        <option value="latest">{t('하루 안에 놓친 가장 최근 시간을 한 번 실행')}</option><option value="skip">{t('건너뛰기')}</option></select></label>
    </div>
    <div className="trigger-preview"><button type="button" className="secondary-button" onClick={() => void showPreview()}>{t('다음 실행 시간 보기')}</button>
      {typeof preview === 'string' ? preview && <p className="slack-error">{translateMessage(preview)}</p> : <ol>{preview.map(time => <li key={time}>{absoluteTime(time)}</li>)}</ol>}</div>
    </fieldset>
    <label>{t('지시')}<small>{t('실행될 때마다 에이전트에게 보내는 내용입니다.')}</small><textarea required rows={5} maxLength={8000} value={handler.instructions} onChange={event => setHandler({ instructions: event.target.value })} /></label>
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
      }}><option value="auto">{t('Auto (프로젝트와 세션 자동 선택)')}</option><option value="folder">{t('폴더의 새 세션')}</option><option value="session">{t('기존 세션에 이어서')}</option></select></label>
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
  const [status, setStatus] = useState('');
  useEffect(() => { void towerOperation<{ settings: TriggerSettings }>(token, 'triggers.settings').then(result => setSettings(result.settings), cause => setStatus(String(cause))); }, [token]);
  if (!settings) return <p role="status">{status || t('불러오는 중')}</p>;
  const field = (key: keyof TriggerSettings, label: string, max: number) => <label>{label}<input type="number" min={1} max={max} value={settings[key]} onChange={event => setSettings({ ...settings, [key]: Math.min(max, Math.max(1, Number(event.target.value) || 1)) })} /></label>;
  return <form className="slack-settings" onSubmit={event => { event.preventDefault(); void towerOperation(token, 'triggers.updateSettings', { settings }).then(() => setStatus(t('저장했습니다.')), cause => setStatus(cause instanceof Error ? cause.message : String(cause))); }}>
    <p>{t('모든 트리거에 함께 적용되는 한도입니다. 에이전트는 바꿀 수 없습니다.')}</p>
    {field('maxTriggers', t('최대 트리거 수'), 200)}
    {field('maxConcurrentRuns', t('동시에 실행할 트리거 작업 수'), 10)}
    {field('maxEventsPerHour', t('모든 트리거의 시간당 최대 실행'), 600)}
    <div className="slack-actions"><button className="primary-button">{t('저장')}</button>{status && <span role="status">{translateMessage(status)}</span>}</div>
  </form>;
}
