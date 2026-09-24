import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Gauge, History, Pencil, Play, Plug, Plus, RotateCcw, Trash2, X, Zap } from 'lucide-react';
import type { ProviderHealth, Session } from '../../../shared/types';
import type { Trigger, TriggerAuditEntry, TriggerEvent, TriggerOverview, TriggerSummary } from '../../../shared/triggers';
import { absoluteTime, relativeTime } from '../common/lib';
import { translateMessage, useI18n } from '../i18n/i18n';
import { SlackPanel } from '../slack/SlackPanel';
import { TriggerConnections, TriggerLimits } from './TriggerConnections';
import { TriggerEditor } from './TriggerEditor';
import { KIND_ICONS, TriggerTypePicker } from './TriggerKinds';
import { auditActionLabel, eventStatusLabel, kindLabel, scheduleLabel, towerOperation, TriggerMachine, type SourceKind } from './trigger-helpers';

export { blankGitHubSource, blankHttpSource, blankTrigger, eventStatusLabel, scheduleLabel, towerOperation } from './trigger-helpers';

type Tab = 'triggers' | 'history' | 'connections' | 'limits';
interface Context { token: string; providers: ProviderHealth[]; projects: [string, string][]; sessions: Session[] }
/** A joined computer; `ready` when its triggers can be managed from here now (connected, with a Tower that can). */
export interface TriggerComputer { node: string; name: string; providers: ProviderHealth[]; ready: boolean; connected: boolean }
/** Folders and conversations a trigger on that computer can aim at, named as that computer knows them. */
export type TriggerTargets = (node: string) => { projects: [string, string][]; sessions: Session[] };
/** What the triggers tab shows: the list, the kind picker for a new trigger, or the editor. */
type View = { page: 'list' } | { page: 'pick' } | { page: 'edit'; kind: SourceKind; trigger?: Trigger };

export function TriggerButton({ token, overview, computers = [], targets, ...context }: Omit<Context, 'token'> & { token: string; overview?: TriggerOverview; computers?: TriggerComputer[]; targets?: TriggerTargets }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [slack, setSlack] = useState(false);
  const attention = overview?.storageError || overview?.triggers.some(item => item.paused || item.error || item.lastEvent?.status === 'error' || item.lastEvent?.status === 'uncertain');
  return <>
    <button className={`icon-button trigger-button ${attention ? 'attention' : ''}`} aria-label={t('트리거')} title={t('트리거')} disabled={!token} onClick={() => setOpen(true)}><Zap size={18} /></button>
    {open && <TriggerPanel {...context} token={token} overview={overview} computers={computers} targets={targets} onClose={() => setOpen(false)} onOpenSlack={() => { setOpen(false); setSlack(true); }} />}
    {slack && <SlackPanel providers={context.providers} token={token} onClose={() => setSlack(false)} />}
  </>;
}

export function TriggerPanel({ token, overview: ownOverview, providers: ownProviders, projects: ownProjects, sessions: ownSessions, computers = [], targets, onClose, onOpenSlack }: Context & { overview?: TriggerOverview; computers?: TriggerComputer[]; targets?: TriggerTargets; onClose: () => void; onOpenSlack: () => void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<Tab>('triggers');
  const [triggers, setTriggers] = useState<Trigger[] | null>(null);
  const [view, setView] = useState<View>({ page: 'list' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // The computer whose triggers are shown. Once chosen it stays chosen: a computer that goes away is shown as away,
  // and nothing meant for it is ever done here instead. Its overview comes with its list, not with this page's.
  const [node, setNode] = useState('');
  const computer = node ? computers.find(item => item.node === node) : undefined;
  const away = Boolean(node) && !computer?.ready;
  const [remoteOverview, setRemoteOverview] = useState<TriggerOverview>();
  const overview = node ? remoteOverview : ownOverview;
  const providers = node ? computer?.providers ?? [] : ownProviders;
  const { projects, sessions } = node && targets ? targets(node) : { projects: ownProjects, sessions: ownSessions };
  const available = node ? !away : Boolean(ownOverview);
  const target = node || undefined;
  // An answer for a computer no longer shown, or older than a later one, is dropped; so is a change's outcome.
  const asked = useRef(0);
  const shown = useRef(target);
  const refresh = useCallback(async () => {
    if (!available || target !== shown.current) return;
    const mine = ++asked.current;
    try {
      const result = await towerOperation<{ triggers: Trigger[]; overview: TriggerOverview }>(token, 'triggers.list', {}, target);
      if (mine !== asked.current || target !== shown.current) return;
      setTriggers(result.triggers);
      if (target) setRemoteOverview(result.overview);
      setError('');
    }
    catch (cause) { if (mine === asked.current && target === shown.current) setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [available, token, target]);
  const revisions = ownOverview?.triggers.map(item => `${item.id}:${item.revision}`).join(',');
  useEffect(() => { void refresh(); }, [refresh, target ? '' : revisions]);
  // Another computer's triggers are not on this page's live stream; they are asked for again while shown.
  useEffect(() => {
    if (!target || away) return;
    const timer = window.setInterval(() => { void refresh(); }, 5000);
    return () => window.clearInterval(timer);
  }, [target, away, refresh]);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); if (opener?.isConnected) opener.focus(); };
  }, []);
  const run = async (work: () => Promise<unknown>) => {
    const from = target;
    setBusy(true); setError('');
    try { await work(); await refresh(); return true; }
    catch (cause) { if (from === shown.current) setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { setBusy(false); }
  };
  const editing = view.page === 'edit';
  const leave = (next: () => void) => { if (!editing || window.confirm(t('저장하지 않은 트리거 변경 사항을 버릴까요?'))) next(); };
  const choose = (next: string) => leave(() => { asked.current++; shown.current = next || undefined; setNode(next); setTriggers(null); setRemoteOverview(undefined); setError(''); setView({ page: 'list' }); if (next && (tab === 'connections' || tab === 'limits')) setTab('triggers'); });
  const name = computer?.name ?? t('연결된 컴퓨터');
  const coordinators = new Set(target ? (triggers ?? []).filter(item => item.handler.kind === 'coordinator').map(item => item.id) : []);
  const close = () => leave(onClose);
  const summaries = new Map(overview?.triggers.map(item => [item.id, item]));
  const slack = target ? undefined : overview?.triggers.find(item => item.kind === 'slack');
  const tabs = [['triggers', t('트리거'), Zap], ['history', t('기록'), History], ['connections', t('연결'), Plug], ['limits', t('한도'), Gauge]] as const;
  return createPortal(<TriggerMachine.Provider value={target ? { node: target, name } : {}}><dialog ref={dialog} className="slack-dialog trigger-dialog" aria-labelledby="trigger-title" onCancel={event => { event.preventDefault(); close(); }}><div className="slack-panel">
    <header className="slack-head"><div><h2 id="trigger-title">{t('트리거')}</h2><p>{target ? t('{0}의 트리거입니다. 정한 때가 되면 그 컴퓨터에서 실행됩니다.', { 0: name }) : t('정한 시간이나 GitHub·HTTP·Slack에서 일이 생기면 프로젝트 에이전트에게 작업을 맡깁니다.')}</p></div>
      {computers.length > 0 && <label className="trigger-computer">{t('컴퓨터')}<select value={node} onChange={event => choose(event.target.value)}>
        <option value="">{t('이 컴퓨터')}</option>{computers.map(item => <option key={item.node} value={item.node} disabled={!item.ready && item.node !== node}>
          {item.ready ? item.name : !item.connected ? t('{0} (오프라인)', { 0: item.name }) : t('{0} (Tower 업데이트 필요)', { 0: item.name })}</option>)}</select></label>}
      <button className="icon-button" aria-label={t('닫기')} onClick={close}><X size={18} /></button></header>
    <nav className="slack-tabs" role="tablist">{tabs.map(([id, label, Icon]) =>
      <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => leave(() => { setView({ page: 'list' }); setTab(id); })}><Icon size={14} />{label}</button>)}</nav>
    <div className="slack-body">
      {error && <p role="alert" className="slack-error">{translateMessage(error)}</p>}
      {overview?.storageError && <p role="alert" className="slack-error">{translateMessage(overview.storageError)}</p>}
      {away && editing && <p role="alert" className="slack-error">{t('{0}에 지금 연결되어 있지 않아 저장할 수 없습니다. 다시 연결되면 저장할 수 있습니다.', { 0: name })}</p>}
      {away && !editing ? <section className="trigger-list"><p className="slack-empty">{computer?.connected
        ? t('{0}의 Tower를 업데이트하면 여기서 트리거를 관리할 수 있습니다.', { 0: name })
        : t('{0}에 지금 연결되어 있지 않습니다. 다시 연결되면 트리거를 보여 줍니다. 그 컴퓨터의 트리거는 그대로 실행됩니다.', { 0: name })}</p></section>
      : !available && !target ? <section className="trigger-list"><p className="slack-empty">{t('실행 워커가 새 버전으로 교체되면 트리거를 사용할 수 있습니다. 진행 중인 작업이 끝나면 자동으로 교체됩니다.')}</p>
        <ol className="slack-rule-list"><SlackRow onOpen={onOpenSlack} /></ol></section>
        : tab === 'triggers' ? view.page === 'edit'
          ? <TriggerEditor key={view.trigger?.id ?? `new:${view.kind}`} kind={view.kind} trigger={view.trigger} token={token} providers={providers} projects={projects} sessions={sessions} busy={busy || away}
            onCancel={() => leave(() => setView({ page: 'list' }))} onSave={input => run(async () => {
              if (!view.trigger) await towerOperation(token, 'triggers.create', { trigger: input }, target);
              else await towerOperation(token, 'triggers.update', { id: view.trigger.id, expectedRevision: view.trigger.revision, trigger: input }, target);
            }).then(ok => { if (ok) setView({ page: 'list' }); })} />
          : view.page === 'pick' || (triggers && !triggers.length)
            ? <section className="trigger-list">
              <div className="trigger-toolbar"><h3>{view.page === 'pick' ? t('어떤 트리거를 만들까요?') : t('첫 트리거를 만들어 보세요')}</h3>
                {view.page === 'pick' && <button type="button" className="secondary-button" onClick={() => setView({ page: 'list' })}>{t('취소')}</button>}</div>
              <TriggerTypePicker slackConnected={Boolean(slack)} onPick={kind => setView({ page: 'edit', kind })} onSlack={onOpenSlack} remote={Boolean(target)} />
              {target && <p className="trigger-note">{t('Slack과 GitHub 트리거는 계정 확인이 필요해 {0}의 Tower에서 만듭니다.', { 0: name })}</p>}
              {view.page !== 'pick' && slack && <ol className="slack-rule-list"><SlackRow summary={slack} onOpen={onOpenSlack} /></ol>}
            </section>
            : <section className="trigger-list">
              <div className="trigger-toolbar"><p>{t('에이전트가 트리거를 바꾸면 기록에 남고 되돌릴 수 있습니다.')}</p>
                <button type="button" className="primary-button" onClick={() => setView({ page: 'pick' })}><Plus size={14} />{t('트리거 추가')}</button></div>
              <ol className="slack-rule-list">
                {slack && <SlackRow summary={slack} onOpen={onOpenSlack} />}
                {triggers?.map(trigger => <TriggerRow key={trigger.id} trigger={trigger} summary={summaries.get(trigger.id)} busy={busy} remote={target ? name : undefined}
                  onToggle={enabled => void run(() => towerOperation(token, 'triggers.setEnabled', { id: trigger.id, expectedRevision: trigger.revision, enabled }, target))}
                  onRun={() => void run(() => towerOperation(token, 'triggers.run', { id: trigger.id }, target))}
                  onEdit={() => setView({ page: 'edit', kind: trigger.source.kind, trigger })}
                  onDelete={() => void run(() => towerOperation(token, 'triggers.delete', { id: trigger.id, expectedRevision: trigger.revision }, target))} />)}
              </ol>
              {!slack && !target && <p className="trigger-note">{t('Slack 멘션도 트리거로 쓸 수 있습니다. 연결 탭에서 연결하세요.')}</p>}
            </section>
        : tab === 'history' ? overview ? <TriggerHistory key={node || 'here'} token={token} overview={overview} coordinators={coordinators} onChanged={refresh} /> : null
        : target ? <p className="trigger-note">{tab === 'connections' ? t('{0}의 연결과 비밀 값은 그 컴퓨터의 Tower에서 설정합니다.', { 0: name }) : t('{0}의 트리거 한도는 그 컴퓨터의 Tower에서 설정합니다.', { 0: name })}</p>
        : tab === 'connections' ? <TriggerConnections token={token} slack={slack} onOpenSlack={onOpenSlack} />
        : <TriggerLimits token={token} />}
    </div>
  </div></dialog></TriggerMachine.Provider>, document.body);
}

/** Slack's own settings are one click away, even while an older worker cannot report on triggers. */
function SlackRow({ summary, onOpen }: { summary?: TriggerSummary; onOpen: () => void }) {
  const { t } = useI18n();
  const Icon = KIND_ICONS.slack;
  return <li className={`slack-rule ${summary && !summary.enabled ? 'disabled' : ''}`}><div className="slack-rule-row">
    <span className="trigger-kind"><Icon size={16} /></span>
    <span className="slack-rule-text"><strong>{kindLabel('slack', t)}</strong>{summary && <small>{summary.enabled ? t('새 멘션을 받는 중') : t('새 멘션 받지 않음 · 받은 대화는 계속 처리')}</small>}</span>
    {summary?.error && <span className="slack-badges"><span className="warn">{t('오류')}</span></span>}
    <button type="button" className="secondary-button" onClick={onOpen}>{t('Slack 설정')}</button>
  </div></li>;
}

/** `remote` names the joined computer the trigger is on, when it is not this one. */
function TriggerRow({ trigger, summary, busy, remote, onToggle, onRun, onEdit, onDelete }: { trigger: Trigger; summary?: TriggerSummary; busy: boolean; remote?: string; onToggle: (enabled: boolean) => void; onRun: () => void; onEdit: () => void; onDelete: () => void }) {
  const { t } = useI18n();
  const [confirm, setConfirm] = useState(false);
  const last = summary?.lastEvent;
  const status = summary?.paused ? t('일시 정지') : last ? eventStatusLabel(last.status, t) : undefined;
  const Icon = KIND_ICONS[trigger.source.kind];
  const polled = trigger.source.kind !== 'schedule';
  return <li className={`slack-rule ${trigger.enabled ? '' : 'disabled'}`}><div className="slack-rule-row">
    {/* A coordinator trigger on another computer can be turned off from here, and is turned on there. */}
    <label className="slack-switch" title={remote && trigger.handler.kind === 'coordinator' && !trigger.enabled ? t('코디네이터 트리거는 {0}의 Tower에서 켭니다.', { 0: remote }) : trigger.enabled ? t('켜짐') : t('꺼짐')}>
      <input type="checkbox" aria-label={t('활성')} checked={trigger.enabled} disabled={busy || (Boolean(remote) && trigger.handler.kind === 'coordinator' && !trigger.enabled)} onChange={event => onToggle(event.target.checked)} /><span /></label>
    <button type="button" className="slack-rule-summary" onClick={onEdit}>
      <span className="trigger-kind" title={kindLabel(trigger.source.kind, t)}><Icon size={16} /></span>
      <span className="slack-rule-text"><strong>{trigger.name}</strong><small>{scheduleLabel(trigger, t)}{trigger.enabled && summary?.nextRunAt ? ` · ${polled ? t('다음 확인') : t('다음 실행')} ${absoluteTime(summary.nextRunAt)}` : ''}</small></span>
      <span className="slack-badges">
        {trigger.handler.kind === 'coordinator' && <span>{t('코디네이터')}</span>}
        {trigger.updatedBy.kind === 'agent' && <span className="accent" title={trigger.updatedBy.sessionId}>{t('에이전트가 변경')}</span>}
        {trigger.remoteEdited && (remote
          ? <span title={t('원격에서 마지막으로 바꾼 트리거는 {0}이(가) 원격 공유에서 제외한 폴더를 쓰지 않습니다.', { 0: remote })}>{t('원격에서 변경')}</span>
          : <span title={t('다른 컴퓨터에서 마지막으로 바꾼 트리거는 이 컴퓨터가 원격 공유에서 제외한 폴더를 쓰지 않습니다.')}>{t('다른 컴퓨터에서 변경')}</span>)}
        {status && <span className={summary?.paused || last?.status === 'error' || last?.status === 'uncertain' ? 'warn' : ''} title={summary?.paused?.reason ?? last?.error ?? last?.reason}>{status}</span>}
        {summary?.error && <span className="warn" title={summary.error}>{t('확인 실패')}</span>}
      </span>
    </button>
    <div className="slack-rule-tools">
      <button type="button" className="icon-button" aria-label={polled ? t('지금 확인') : t('지금 실행')} disabled={busy || !trigger.enabled || (Boolean(remote) && trigger.handler.kind === 'coordinator')} onClick={onRun}
        title={remote && trigger.handler.kind === 'coordinator' ? t('코디네이터 트리거는 {0}의 Tower에서 실행합니다.', { 0: remote }) : trigger.enabled ? polled ? t('지금 확인') : t('지금 실행') : t('켜야 실행할 수 있습니다.')}><Play size={15} /></button>
      <button type="button" className="icon-button" aria-label={t('편집')} title={t('편집')} onClick={onEdit}><Pencil size={15} /></button>
      {confirm ? <button type="button" className="slack-danger" onClick={() => { setConfirm(false); onDelete(); }} onBlur={() => setConfirm(false)}>{t('삭제 확인')}</button>
        : <button type="button" className="icon-button" aria-label={t('삭제')} title={t('삭제')} onClick={() => setConfirm(true)}><Trash2 size={15} /></button>}
    </div>
  </div></li>;
}

/** Audit actions whose label and trigger name already say everything; the stored summary would only repeat them. */
const SELF_EVIDENT = new Set<TriggerAuditEntry['action']>(['create', 'delete', 'enable', 'disable']);

/** `coordinators`: triggers on another computer that are changed there, so they are not reverted or restored from here. */
function TriggerHistory({ token, overview, coordinators = new Set(), onChanged }: { token: string; overview: TriggerOverview; coordinators?: ReadonlySet<string>; onChanged: () => Promise<void> }) {
  const { t } = useI18n();
  const { node } = useContext(TriggerMachine);
  const [audit, setAudit] = useState<TriggerAuditEntry[]>([]);
  const [events, setEvents] = useState<TriggerEvent[]>(overview.recent);
  const [deleted, setDeleted] = useState<Trigger[]>([]);
  const [error, setError] = useState('');
  // An answer older than a later one is dropped.
  const asked = useRef(0);
  const load = useCallback(async () => {
    const mine = ++asked.current;
    try {
      const [log, runs, removed] = await Promise.all([towerOperation<{ audit: TriggerAuditEntry[] }>(token, 'triggers.audit', { limit: 100 }, node),
        towerOperation<{ events: TriggerEvent[] }>(token, 'triggers.events', { limit: 100 }, node), towerOperation<{ triggers: Trigger[] }>(token, 'triggers.deleted', {}, node)]);
      if (mine !== asked.current) return;
      setAudit(log.audit); setEvents(runs.events); setDeleted(removed.triggers); setError('');
    } catch (cause) { if (mine === asked.current) setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [token, node]);
  useEffect(() => { void load(); }, [load, overview.recent[0]?.updatedAt]);
  const act = async (operation: string, input: unknown) => {
    try { await towerOperation(token, operation, input, node); await Promise.all([load(), onChanged()]); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const currentRevision = new Map(overview.triggers.map(item => [item.id, item.revision]));
  return <section className="trigger-history">
    {error && <p role="alert" className="slack-error">{translateMessage(error)}</p>}
    <h3>{t('최근 실행')}</h3>
    {events.length ? <ol className="trigger-log">{events.map(event => { const Icon = event.kind === 'manual' ? Play : KIND_ICONS[event.kind]; return <li key={event.id}>
      <Icon size={14} /><div><p><strong>{event.triggerName}</strong><span className={`trigger-status ${event.status}`}>{eventStatusLabel(event.status, t)}</span></p>
        <small>{absoluteTime(event.occurredAt)} · {event.summary}</small>
        {(event.error || event.reason) && <small className={event.error ? 'slack-error' : ''}>{translateMessage(event.error ?? event.reason!)}</small>}</div>
    </li>; })}</ol> : <p className="trigger-note">{t('아직 실행 기록이 없습니다.')}</p>}
    <h3>{t('변경 기록')}</h3>
    {audit.length ? <ol className="trigger-log">{audit.map(entry => <li key={entry.id}>
      <Pencil size={14} /><div><p><strong>{entry.triggerName || t('트리거 설정')}</strong><span>{auditActionLabel(entry.action, t)}</span></p>
      <small>{relativeTime(entry.at)} · {entry.actor.kind === 'agent' ? entry.actor.controllerId ? t('원격 제어로 시작한 에이전트 ({0})', { 0: entry.actor.sessionId ?? '?' }) : t('에이전트 ({0})', { 0: entry.actor.sessionId ?? '?' })
        : entry.actor.kind === 'owner' ? entry.actor.controllerId ? t('원격 제어') : t('나') : t('시스템')}</small>
      {!SELF_EVIDENT.has(entry.action) && <small className="trigger-detail" title={entry.summary}>{entry.summary}</small>}</div>
      {entry.fromRevision && currentRevision.has(entry.triggerId) && !coordinators.has(entry.triggerId) && ['update', 'revert'].includes(entry.action) &&
        <button type="button" className="secondary-button" onClick={() => void act('triggers.revert', { id: entry.triggerId, revision: entry.fromRevision, expectedRevision: currentRevision.get(entry.triggerId) })}><RotateCcw size={13} />{t('이 변경 전으로 되돌리기')}</button>}
    </li>)}</ol> : <p className="trigger-note">{t('아직 변경 기록이 없습니다.')}</p>}
    {deleted.length > 0 && <><h3>{t('삭제한 트리거')}</h3><ol className="trigger-log">{deleted.map(trigger => { const Icon = KIND_ICONS[trigger.source.kind]; return <li key={`${trigger.id}:${trigger.revision}`}>
      <Icon size={14} /><div><p><strong>{trigger.name}</strong><span>{kindLabel(trigger.source.kind, t)}</span></p><small>{relativeTime(trigger.updatedAt)}</small></div>
      {!(node && trigger.handler.kind === 'coordinator') && <button type="button" className="secondary-button" onClick={() => void act('triggers.restore', { id: trigger.id })}><RotateCcw size={13} />{t('복원 (꺼진 상태)')}</button>}
    </li>; })}</ol></>}
  </section>;
}

