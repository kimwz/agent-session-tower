import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, LoaderCircle, Pencil, Plus, ShieldCheck, Trash2, TriangleAlert, X } from 'lucide-react';
import type { PermissionOverview, PermissionProvider, PermissionRequest, PermissionRule, PermissionRuleInput } from '../../../shared/permissions';
import { claudeRule, codexRule, ruleIsBroad, ruleProblem } from '../../../shared/permissions';
import { authPost } from '../auth/AuthGate';
import { locale, translateMessage, useI18n } from '../i18n/i18n';
import { onOpenPermissions } from './permissions-open';

const operation = <T,>(token: string, name: string, input: unknown = {}) => authPost<{ result: T }>(`/api/v1/permissions.${name}`, token, input).then(response => response.result);
const folderName = (path: string) => path.split('/').filter(Boolean).at(-1) || path;
const date = (value: string) => { const time = new Date(value); return Number.isNaN(time.getTime()) ? '' : time.toLocaleString(locale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); };

/** The header button: every allow rule, and how many agent requests wait for the owner. */
export function PermissionsButton({ token, projects, onOpenSession }: { token: string; projects: string[]; onOpenSession: (id: string) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<{ cwd?: string } | null>(null);
  const [count, setCount] = useState(0);
  const refresh = useCallback(() => { if (token) void operation<PermissionOverview>(token, 'overview').then(overview => setCount(overview.pending)).catch(() => setCount(0)); }, [token]);
  useEffect(() => { refresh(); const timer = setInterval(refresh, 60_000); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => onOpenPermissions(cwd => setOpen({ cwd })), []);
  const label = count ? t('권한 · 요청 {0}개', { 0: count }) : t('권한');
  return <><button className={`icon-button skills-button ${open ? 'active' : ''}`} title={label} aria-label={label} disabled={!token} onClick={() => setOpen({})}>
    <ShieldCheck size={18} />{count > 0 && <span className="skills-count" aria-hidden="true">{count > 9 ? '9+' : count}</span>}
  </button>{open && <PermissionsPanel token={token} cwd={open.cwd} projects={projects} onOpenSession={id => { setOpen(null); onOpenSession(id); }} onClose={() => { setOpen(null); refresh(); }} />}</>;
}

/** A rule being written: `id` edits a saved rule; `deciding` allows that request as edited. */
type Draft = PermissionRuleInput & { id?: string; deciding?: string };
export const ruleDraft = (rule: PermissionRuleInput & { id?: string }): Draft => ({ ...(rule.id ? { id: rule.id } : {}), kind: rule.kind, value: rule.value, providers: rule.providers, scope: rule.scope,
  ...(rule.cwd ? { cwd: rule.cwd } : {}), ...(rule.note ? { note: rule.note } : {}) });
type Tab = 'requests' | 'rules';

/** Allow rules for Claude Code and Codex in one list, everywhere or for one folder, and the requests agents sent. */
export function PermissionsPanel({ token, cwd, projects, onClose, onOpenSession }: { token: string; cwd?: string; projects: string[]; onClose: () => void; onOpenSession: (id: string) => void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [overview, setOverview] = useState<PermissionOverview | null>(null);
  const [tab, setTab] = useState<Tab>('rules');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [resume, setResume] = useState(true);
  const shown = useCallback((all: PermissionOverview): PermissionOverview => cwd ? { ...all, rules: all.rules.filter(rule => rule.scope === 'global' || rule.cwd === cwd), requests: all.requests.filter(request => request.cwd === cwd),
    targets: all.targets.filter(target => target.scope === 'global' || target.cwd === cwd), pending: all.requests.filter(request => request.cwd === cwd && request.status === 'pending').length } : all, [cwd]);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    void operation<PermissionOverview>(token, 'overview', cwd ? { cwd } : {}).then(value => { setOverview(value); if (value.pending) setTab('requests'); }).catch(error => setError(error instanceof Error ? error.message : String(error)));
    return () => { element?.close(); if (opener?.isConnected) opener.focus(); };
  }, [token, cwd]);
  async function act(name: string, input: unknown, done = '') {
    if (busy) return false;
    setBusy(true); setError(''); setNotice('');
    try {
      const next = await operation<PermissionOverview>(token, name, input);
      setOverview(shown(next));
      if (next.resumed && 'error' in next.resumed) setError(t('결정은 저장했지만 대화에 알리지 못했습니다: {0}', { 0: translateMessage(next.resumed.error) }));
      else if (done) setNotice(next.resumed ? `${done} ${t("요청한 대화에 알렸습니다.")}` : done);
      return true;
    }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); return false; }
    finally { setBusy(false); }
  }
  const pending = overview?.requests.filter(request => request.status === 'pending') ?? [];
  const decided = overview?.requests.filter(request => request.status !== 'pending') ?? [];
  const title = cwd ? t('{0}의 권한', { 0: folderName(cwd) }) : t('권한');
  const newRule = (): Draft => ({ kind: 'command', value: '', providers: ['claude', 'codex'], scope: cwd ? 'project' : 'global', ...(cwd ? { cwd } : {}) });
  async function save(next: Draft) {
    const rule: PermissionRuleInput = { kind: next.kind, value: next.value, providers: next.providers, scope: next.scope, ...(next.scope === 'project' && next.cwd ? { cwd: next.cwd } : {}), ...(next.note?.trim() ? { note: next.note.trim() } : {}) };
    const ok = next.deciding ? await act('decide', { id: next.deciding, approve: true, rule, resume }, t('요청을 수정해 허용했습니다.'))
      : await act('save', { ...(next.id ? { id: next.id } : {}), rule }, t('규칙을 저장했습니다.'));
    if (ok) { setDraft(null); if (next.deciding && pending.length <= 1) setTab('rules'); }
  }
  return createPortal(<dialog ref={dialog} className="auth-dialog skills-dialog permissions-dialog" aria-labelledby="permissions-title" onCancel={event => { if (draft) { event.preventDefault(); setDraft(null); } else onClose(); }} onClick={event => { if (event.target === event.currentTarget && !draft) onClose(); }}><div className="auth-panel">
    <header><h2 id="permissions-title"><ShieldCheck size={17} />{title}</h2><div><button className="icon-button" aria-label={t('닫기')} onClick={onClose}><X size={20} /></button></div></header>
    <p className="auth-hint">{cwd ? t('이 프로젝트에서 Claude Code와 Codex가 묻지 않고 할 수 있는 일입니다. 이 프로젝트의 규칙과 모든 프로젝트에 쓰이는 규칙이 함께 보입니다.')
      : t('Claude Code와 Codex가 묻거나 막지 않고 할 수 있는 일을 한곳에서 관리합니다. 에이전트가 막힌 작업에 필요한 권한을 요청하면 여기서 허용합니다.')}</p>
    {error && <p className="auth-error" role="alert">{translateMessage(error)}</p>}
    {notice && <p className="notification-notice" role="status">{notice}</p>}
    {overview?.lost && <div className="permission-warning" role="alert"><TriangleAlert size={15} /><div><p>{t('이전 권한 기록을 읽지 못해 {0}에 옮겨 두었습니다. Tower가 전에 쓴 Codex tower.rules 파일이 남아 있을 수 있으니 ~/.codex/rules와 프로젝트의 .codex/rules를 확인하세요.', { 0: overview.lost })}</p>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => void act('acknowledge', {})}>{t('확인했습니다')}</button></div></div>}
    {draft ? <RuleEditor draft={draft} cwd={cwd} projects={projects} busy={busy} onCancel={() => setDraft(null)} onSave={next => void save(next)} />
      : !overview ? !error && <LoaderCircle className="spin" aria-label={t('불러오는 중')} /> : <>
      <nav className="skills-tabs" role="tablist" aria-label={t('권한 메뉴')}>
        <button role="tab" aria-selected={tab === 'requests'} className={tab === 'requests' ? 'active' : ''} onClick={() => setTab('requests')}>{t('요청')}{pending.length > 0 && <span className="skills-count inline">{pending.length}</span>}</button>
        <button role="tab" aria-selected={tab === 'rules'} className={tab === 'rules' ? 'active' : ''} onClick={() => setTab('rules')}>{t('규칙 {0}', { 0: overview.rules.length })}</button>
      </nav>
      {tab === 'requests' && <section className="permission-requests">
        {pending.length > 0 && <label className="skill-pinned permission-resume"><input type="checkbox" checked={resume} disabled={busy} onChange={event => setResume(event.target.checked)} />{t('결정을 요청한 대화에 보내 이어서 진행')}
          <small>{t('허용하거나 거절하면 그 대화에 내 메시지로 결과를 보냅니다. 에이전트가 일하는 중이면 그 턴이 끝난 뒤에 보냅니다. 허용한 규칙은 다음 턴부터 적용됩니다.')}</small></label>}
        {pending.length ? pending.map(request => <RequestCard key={request.id} request={request} busy={busy} onOpenSession={onOpenSession}
          onApprove={() => void act('decide', { id: request.id, approve: true, resume }, t('{0} 규칙을 허용했습니다.', { 0: request.rule.value }))}
          onEdit={() => setDraft({ ...ruleDraft(request.rule), deciding: request.id })}
          onDeny={() => void act('decide', { id: request.id, approve: false, resume }, t('요청을 거절했습니다.'))} />)
          : <p className="auth-empty">{t('기다리는 요청이 없습니다. Tower에서 시작한 대화의 에이전트는 막힌 작업에 필요한 권한을 permissions_request 도구로 요청할 수 있습니다.')}</p>}
        {decided.length > 0 && <details className="skills-watching"><summary>{t('처리한 요청 {0}', { 0: decided.length })}</summary>
          <ul className="permission-history">{decided.map(request => <li key={request.id}><span className={`skill-badge ${request.status === 'approved' ? 'pinned' : ''}`}>{request.status === 'approved' ? t('허용') : t('거절')}</span>
            <code>{request.rule.value}</code><small>{folderName(request.cwd)} · {date(request.decidedAt ?? request.createdAt)}</small></li>)}</ul></details>}
      </section>}
      {tab === 'rules' && <RuleList overview={overview} cwd={cwd} busy={busy} onNew={() => setDraft(newRule())} onEdit={rule => setDraft(ruleDraft(rule))}
        onDelete={rule => { if (window.confirm(t('{0} 규칙을 삭제할까요? 다음 턴부터 적용되지 않습니다.', { 0: rule.value }))) void act('delete', { id: rule.id }, t('규칙을 삭제했습니다.')); }} />}
    </>}
  </div></dialog>, document.body);
}

function Providers({ providers }: { providers: PermissionProvider[] }) {
  return <>{providers.map(provider => <span key={provider} className={`skill-badge ${provider}`}>{provider === 'claude' ? 'Claude' : 'Codex'}</span>)}</>;
}

/** What each provider will read for this rule, exactly. */
function NativePreview({ rule, warnCodex = false }: { rule: Pick<PermissionRuleInput, 'kind' | 'value' | 'providers'>; warnCodex?: boolean }) {
  const { t } = useI18n();
  if (ruleProblem({ ...rule, scope: 'global' })) return null;
  return <dl className="permission-native">
    {rule.providers.includes('claude') && <><dt>Claude Code</dt><dd><code>{claudeRule(rule)}</code></dd></>}
    {rule.kind === 'command' && rule.providers.includes('codex') && <><dt>Codex</dt><dd><code>{codexRule(rule)}</code></dd></>}
    {warnCodex && rule.kind === 'command' && rule.providers.includes('codex') && <dd className="permission-broad"><TriangleAlert size={13} />{t('Codex 규칙은 트리거와 공개 에이전트를 포함한 이 컴퓨터의 모든 Codex 실행에 적용됩니다.')}</dd>}
    {ruleIsBroad(rule) && <dd className="permission-broad"><TriangleAlert size={13} />{t('넓은 규칙입니다. 이 프로그램으로 하는 거의 모든 일을 묻지 않고 허용합니다.')}</dd>}
  </dl>;
}

function RequestCard({ request, busy, onApprove, onEdit, onDeny, onOpenSession }: { request: PermissionRequest; busy: boolean; onApprove: () => void; onEdit: () => void; onDeny: () => void; onOpenSession: (id: string) => void }) {
  const { t } = useI18n();
  return <article className="skill-proposal permission-request">
    <header><code className="permission-value">{request.rule.value}</code><span className="skill-badges"><Providers providers={request.rule.providers} />
      <span className="skill-badge">{request.rule.scope === 'global' ? t('모든 프로젝트') : folderName(request.rule.cwd ?? request.cwd)}</span></span></header>
    <p>{request.reason}</p>
    <NativePreview rule={request.rule} warnCodex />
    <p className="permission-meta"><button type="button" className="link-button" onClick={() => onOpenSession(request.sessionId)}>{t('요청한 대화 열기')}</button><small>{folderName(request.cwd)} · {date(request.createdAt)}</small></p>
    <footer><span />
      <button type="button" className="secondary-button" disabled={busy} onClick={onDeny}>{t('거절')}</button>
      <button type="button" className="secondary-button" disabled={busy} onClick={onEdit}><Pencil size={14} />{t('수정 후 허용')}</button>
      <button type="button" className="primary-button" disabled={busy} onClick={onApprove}><Check size={14} />{t('허용')}</button></footer>
  </article>;
}

function RuleList({ overview, cwd, busy, onNew, onEdit, onDelete }: { overview: PermissionOverview; cwd?: string; busy: boolean; onNew: () => void; onEdit: (rule: PermissionRule) => void; onDelete: (rule: PermissionRule) => void }) {
  const { t } = useI18n();
  const projects = [...new Set(overview.rules.filter(rule => rule.scope === 'project').map(rule => rule.cwd!))].sort();
  if (cwd && !projects.includes(cwd)) projects.unshift(cwd);
  const groups: Array<[string, string, PermissionRule[]]> = [
    ...projects.map(folder => [folder, folder === cwd ? t('이 프로젝트') : folderName(folder), overview.rules.filter(rule => rule.scope === 'project' && rule.cwd === folder)] as [string, string, PermissionRule[]]),
    ['global', t('모든 프로젝트'), overview.rules.filter(rule => rule.scope === 'global')],
  ];
  const failed = overview.targets.filter(target => target.error);
  return <section className="skills-list">
    <div className="skills-toolbar"><span className="auth-hint">{t('허용 규칙만 관리합니다. 막는 규칙은 각 에이전트 설정에서 직접 관리하세요.')}</span>
      <button className="secondary-button" disabled={busy} onClick={onNew}><Plus size={14} />{t('규칙 추가')}</button></div>
    {failed.map(target => <p key={target.path} className="auth-error" role="alert">{t('{0}에 쓰지 못했습니다: {1}', { 0: target.path, 1: translateMessage(target.error!) })}</p>)}
    {groups.map(([key, label, rules]) => <div key={key} className="skills-group"><h3 title={key === 'global' ? undefined : key}>{label} <span className="auth-count">{rules.length}</span></h3>
      {rules.length ? <ul>{rules.map(rule => <li key={rule.id} className="skill-row">
        <div className="skill-row-main"><code className="permission-value">{rule.value}</code>
          <span className="skill-badges"><Providers providers={rule.providers} />{rule.kind === 'claude' && <span className="skill-badge">{t('Claude 규칙')}</span>}{rule.source === 'request' && <span className="skill-badge pinned">{t('요청으로 허용')}</span>}</span>
          {rule.note && <p>{rule.note}</p>}
          <NativePreview rule={rule} /></div>
        <div className="skill-row-actions">
          <button className="icon-button" title={t('편집')} aria-label={t('{0} 편집', { 0: rule.value })} disabled={busy} onClick={() => onEdit(rule)}><Pencil size={15} /></button>
          <button className="icon-button" title={t('삭제')} aria-label={t('{0} 삭제', { 0: rule.value })} disabled={busy} onClick={() => onDelete(rule)}><Trash2 size={15} /></button>
        </div>
      </li>)}</ul> : <p className="auth-empty">{key === 'global' ? t('모든 프로젝트에 쓰는 규칙이 아직 없습니다.') : t('이 프로젝트에만 쓰는 규칙이 아직 없습니다.')}</p>}
    </div>)}
    <details className="skills-watching"><summary>{t('규칙이 적용되는 곳')}</summary>
      <p className="auth-hint"><strong>Claude Code</strong> · {t('트리거, Slack, GitHub, 공개 에이전트를 포함해 이 컴퓨터에서 Tower가 시작하는 모든 턴에 설정으로 함께 넘깁니다. 승인을 기다리도록 설정한 작업도 허용한 동작은 묻지 않습니다. 터미널에서 직접 연 Claude 세션에는 적용되지 않고, 사용자 설정 파일도 바꾸지 않습니다. 한 프로젝트 규칙은 그 폴더와 하위 폴더에서 시작한 턴에 적용됩니다.')}</p>
      <p className="auth-hint"><strong>Codex</strong> · {t('Tower만 쓰는 tower.rules 파일에 씁니다. Codex는 실행마다 규칙을 따로 받을 수 없어서, 트리거와 공개 에이전트를 포함한 이 컴퓨터의 모든 Codex 실행이 읽습니다. 프로젝트 규칙은 신뢰한 프로젝트에서만 읽고, 프로젝트 파일은 git 제외 목록에 넣어 저장소에 올라가지 않게 합니다.')}</p>
      <p className="auth-hint">{t('바뀐 규칙은 두 에이전트 모두 다음 턴부터 적용됩니다.')}</p>
      <ul className="permission-history">{overview.targets.map(target => <li key={target.path}><span className="skill-badge codex">Codex</span><code>{target.path}</code><small>{t('규칙 {0}개', { 0: target.rules })}</small></li>)}</ul>
    </details>
  </section>;
}

function RuleEditor({ draft: initial, cwd, projects, busy, onCancel, onSave }: { draft: Draft; cwd?: string; projects: string[]; busy: boolean; onCancel: () => void; onSave: (draft: Draft) => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(initial);
  const set = (patch: Partial<Draft>) => setDraft(value => ({ ...value, ...patch }));
  const choices = [...new Set([...(cwd ? [cwd] : []), ...(draft.cwd ? [draft.cwd] : []), ...projects])];
  const problem = draft.value.trim() ? ruleProblem(draft) : undefined;
  const toggle = (provider: PermissionProvider, on: boolean) => set({ providers: (['claude', 'codex'] as const).filter(item => item === provider ? on : draft.providers.includes(item)) });
  return <form className="skill-editor" onSubmit={event => { event.preventDefault(); if (!problem) onSave(draft); }}>
    <h3>{draft.deciding ? t('요청 수정 후 허용') : draft.id ? t('규칙 편집') : t('규칙 추가')}</h3>
    <fieldset className="skill-scope"><legend>{t('종류')}</legend>
      <label><input type="radio" name="kind" checked={draft.kind === 'command'} disabled={busy} onChange={() => set({ kind: 'command', providers: ['claude', 'codex'] })} />{t('명령어')}</label>
      <label><input type="radio" name="kind" checked={draft.kind === 'claude'} disabled={busy} onChange={() => set({ kind: 'claude', providers: ['claude'] })} />{t('Claude 규칙')}</label>
    </fieldset>
    <label>{draft.kind === 'command' ? t('허용할 명령어 앞부분') : t('Claude Code 권한 규칙')}
      <input value={draft.value} required maxLength={320} disabled={busy} spellCheck={false} placeholder={draft.kind === 'command' ? 'gh pr merge' : 'WebFetch(domain:example.com)'} onChange={event => set({ value: event.target.value })} />
      {problem ? <small className="auth-error">{translateMessage(problem)}</small>
        : <small>{draft.kind === 'command' ? t('이 단어들로 시작하는 명령을 인자와 상관없이 허용합니다. 따옴표, 파이프, 와일드카드는 쓰지 않습니다.') : t('Bash 외 도구용입니다. 예: WebFetch(domain:example.com), mcp__서버__도구, Edit(/경로/**)')}</small>}</label>
    {draft.kind === 'command' && <fieldset className="skill-scope"><legend>{t('적용할 에이전트')}</legend>
      <label><input type="checkbox" checked={draft.providers.includes('claude')} disabled={busy} onChange={event => toggle('claude', event.target.checked)} />Claude Code</label>
      <label><input type="checkbox" checked={draft.providers.includes('codex')} disabled={busy} onChange={event => toggle('codex', event.target.checked)} />Codex</label>
    </fieldset>}
    <fieldset className="skill-scope"><legend>{t('적용 범위')}</legend>
      <label><input type="radio" name="scope" checked={draft.scope === 'global'} disabled={busy} onChange={() => set({ scope: 'global' })} />{t('모든 프로젝트')}</label>
      <label><input type="radio" name="scope" checked={draft.scope === 'project'} disabled={busy || !choices.length} onChange={() => set({ scope: 'project', cwd: draft.cwd ?? choices[0] })} />{t('한 프로젝트')}</label>
      {draft.scope === 'project' && <select value={draft.cwd ?? ''} disabled={busy} aria-label={t('프로젝트')} onChange={event => set({ cwd: event.target.value })}>{choices.map(item => <option key={item} value={item}>{folderName(item)} · {item}</option>)}</select>}
    </fieldset>
    <NativePreview rule={draft} warnCodex />
    <label>{t('메모 (선택)')}<input value={draft.note ?? ''} maxLength={500} disabled={busy} placeholder={t('왜 허용하는지')} onChange={event => set({ note: event.target.value })} /></label>
    <footer><button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>{t('취소')}</button>
      <button type="submit" className="primary-button" disabled={busy || !draft.value.trim() || !!problem}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{draft.deciding ? t('허용') : t('저장')}</button></footer>
  </form>;
}
