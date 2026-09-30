import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { FolderChip } from '../settings/FolderChip';
import { SettingsFrameContext, SettingsPane, useSettingsGuard } from '../settings/SettingsPane';
import { Bot, Check, LoaderCircle, Pencil, Plus, Trash2, TriangleAlert } from 'lucide-react';
import type { PermissionAutoReview, PermissionOverview, PermissionProvider, PermissionRequest, PermissionRule, PermissionRuleInput } from '../../../shared/permissions';
import { AUTO_REVIEW_MODELS, waitingForOwner as waiting, claudeRule, codexRule, dangerousContinuations, ruleIsBroad, ruleProblem } from '../../../shared/permissions';
import { authPost } from '../auth/AuthGate';
import { locale, translateMessage, useI18n } from '../i18n/i18n';

export const permissionOperation = <T,>(token: string, name: string, input: unknown = {}) => authPost<{ result: T }>(`/api/v1/permissions.${name}`, token, input).then(response => response.result);
const folderName = (path: string) => path.split('/').filter(Boolean).at(-1) || path;
const date = (value: string) => { const time = new Date(value); return Number.isNaN(time.getTime()) ? '' : time.toLocaleString(locale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); };

/** A rule being written: `id` edits a saved rule; `deciding` allows that request as edited. */
type Draft = PermissionRuleInput & { id?: string; deciding?: string };
export const ruleDraft = (rule: PermissionRuleInput & { id?: string }): Draft => ({ ...(rule.id ? { id: rule.id } : {}), kind: rule.kind, value: rule.value, providers: rule.providers, scope: rule.scope,
  ...(rule.cwd ? { cwd: rule.cwd } : {}), ...(rule.note ? { note: rule.note } : {}) });
type Tab = 'requests' | 'rules';

/** Allow rules for Claude Code and Codex in one list, everywhere or for one folder, and the requests agents sent. */
export function PermissionsPanel({ token, cwd, projects, pending: waitingCount, onClearFolder, onChanged, onOpenSession }: { token: string; cwd?: string; projects: string[]; pending: number; onClearFolder: () => void; onChanged: () => void; onOpenSession: (id: string) => void }) {
  const { t } = useI18n();
  const { active } = useContext(SettingsFrameContext);
  const [overview, setOverview] = useState<PermissionOverview | null>(null);
  const [tab, setTab] = useState<Tab>('rules');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [resume, setResume] = useState(true);
  const shown = useCallback((all: PermissionOverview): PermissionOverview => cwd ? { ...all, rules: all.rules.filter(rule => rule.scope === 'global' || rule.cwd === cwd), requests: all.requests.filter(request => request.cwd === cwd),
    targets: all.targets.filter(target => target.scope === 'global' || target.cwd === cwd), pending: all.requests.filter(request => request.cwd === cwd && waiting(request)).length } : all, [cwd]);
  // The requests tab is chosen once, on opening; later reloads leave the owner where they are.
  const opened = useRef(false);
  // Asked again when shown again and when the page sees the number of waiting requests change.
  useEffect(() => {
    if (!active) return;
    void permissionOperation<PermissionOverview>(token, 'overview', cwd ? { cwd } : {}).then(value => { if (!opened.current && value.pending) setTab('requests'); opened.current = true; setOverview(value); }).catch(error => setError(error instanceof Error ? error.message : String(error)));
  }, [token, cwd, active, waitingCount]);
  // While the reviewer works on a request, the panel follows it: the waiting count does not change until it is done.
  const reviewing = Boolean(overview?.requests.some(request => request.status === 'pending' && (request.review?.status === 'queued' || request.review?.status === 'running')));
  useEffect(() => {
    if (!active || !reviewing) return;
    const timer = setInterval(() => { void permissionOperation<PermissionOverview>(token, 'overview', cwd ? { cwd } : {}).then(setOverview).catch(() => {}); }, 4000);
    return () => clearInterval(timer);
  }, [token, cwd, active, reviewing]);
  useSettingsGuard({
    escape: () => { if (!draft) return false; setDraft(null); return true; },
    leave: () => !draft || window.confirm(t('저장하지 않은 변경 사항을 버릴까요?')),
  });
  async function act(name: string, input: unknown, done = '') {
    if (busy) return false;
    setBusy(true); setError(''); setNotice('');
    try {
      const next = await permissionOperation<PermissionOverview>(token, name, input);
      setOverview(shown(next));
      onChanged();
      if (next.resumed && 'error' in next.resumed) setError(t('결정은 저장했지만 대화에 알리지 못했습니다: {0}', { 0: translateMessage(next.resumed.error) }));
      else if (done) setNotice(`${next.resumed ? `${done} ${t("요청한 대화에 알렸습니다.")}` : done}${next.replaced?.length ? ` ${t('겹치던 자동 허용 규칙 {0}을(를) 지웠습니다.', { 0: next.replaced.join(', ') })}` : ''}`);
      return true;
    }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); return false; }
    finally { setBusy(false); }
  }
  const pending = overview?.requests.filter(request => request.status === 'pending') ?? [];
  const decided = overview?.requests.filter(request => request.status !== 'pending') ?? [];
  const newRule = (): Draft => ({ kind: 'command', value: '', providers: ['claude', 'codex'], scope: cwd ? 'project' : 'global', ...(cwd ? { cwd } : {}) });
  async function save(next: Draft) {
    const rule: PermissionRuleInput = { kind: next.kind, value: next.value, providers: next.providers, scope: next.scope, ...(next.scope === 'project' && next.cwd ? { cwd: next.cwd } : {}), ...(next.note?.trim() ? { note: next.note.trim() } : {}) };
    const ok = next.deciding ? await act('decide', { id: next.deciding, approve: true, rule, resume }, t('요청을 수정해 허용했습니다.'))
      : await act('save', { ...(next.id ? { id: next.id } : {}), rule }, t('규칙을 저장했습니다.'));
    if (ok) { setDraft(null); if (next.deciding && pending.length <= 1) setTab('rules'); }
  }
  return <SettingsPane title={t('권한')} scope="auth-panel skills-scope" chip={cwd ? <FolderChip cwd={cwd} onClear={onClearFolder} /> : undefined}
    description={t('Claude Code와 Codex가 묻지 않고 할 수 있는 일')}
    tabs={draft || !overview ? undefined : [{ id: 'requests' as Tab, label: t('요청'), count: pending.filter(waiting).length, urgent: true }, { id: 'rules' as Tab, label: t('규칙 {0}', { 0: overview.rules.length }) }]} tab={tab} onTab={setTab}>
    <p className="auth-hint">{cwd ? t('이 프로젝트에서 Claude Code와 Codex가 묻지 않고 할 수 있는 일입니다. 이 프로젝트의 규칙과 모든 프로젝트에 쓰이는 규칙이 함께 보입니다.')
      : t('Claude Code와 Codex가 묻거나 막지 않고 할 수 있는 일을 한곳에서 관리합니다. 에이전트가 막힌 작업에 필요한 권한을 요청하면 여기서 허용합니다.')}</p>
    {error && <p className="auth-error" role="alert">{translateMessage(error)}</p>}
    {notice && <p className="notification-notice" role="status">{notice}</p>}
    {overview?.lost && <div className="permission-warning" role="alert"><TriangleAlert size={15} /><div><p>{t('이전 권한 기록을 읽지 못해 {0}에 옮겨 두었습니다. Tower가 전에 쓴 Codex tower.rules 파일이 남아 있을 수 있으니 ~/.codex/rules와 프로젝트의 .codex/rules를 확인하세요.', { 0: overview.lost })}</p>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => void act('acknowledge', {})}>{t('확인했습니다')}</button></div></div>}
    {draft ? <RuleEditor draft={draft} cwd={cwd} projects={projects} busy={busy} onCancel={() => setDraft(null)} onSave={next => void save(next)} />
      : !overview ? !error && <LoaderCircle className="spin" aria-label={t('불러오는 중')} /> : <>
      {tab === 'requests' && <section className="permission-requests">
        {overview.autoReview && <AutoReviewSettings settings={overview.autoReview} busy={busy} onSave={settings => void act('saveAutoReview', { settings }, settings.enabled ? t('자동 검토 설정을 저장했습니다.') : t('자동 검토를 껐습니다.'))} />}
        {pending.length > 0 && <label className="skill-pinned permission-resume"><input type="checkbox" checked={resume} disabled={busy} onChange={event => setResume(event.target.checked)} />{t('결정을 요청한 대화에 보내 이어서 진행')}
          <small>{t('허용하거나 거절하면 그 대화에 내 메시지로 결과를 보냅니다. 에이전트가 일하는 중이면 그 턴이 끝난 뒤에 보냅니다. 허용한 규칙은 다음 턴부터 적용됩니다.')}</small></label>}
        {pending.length ? pending.map(request => <RequestCard key={request.id} request={request} busy={busy} onOpenSession={onOpenSession}
          onApprove={() => void act('decide', { id: request.id, approve: true, resume }, t('{0} 규칙을 허용했습니다.', { 0: request.rule.value }))}
          onEdit={() => setDraft({ ...ruleDraft(request.rule), deciding: request.id })}
          onDeny={() => void act('decide', { id: request.id, approve: false, resume }, t('요청을 거절했습니다.'))} />)
          : <p className="auth-empty">{t('기다리는 요청이 없습니다. Tower에서 시작한 대화의 에이전트는 막힌 작업에 필요한 권한을 permissions_request 도구로 요청할 수 있습니다.')}</p>}
        {decided.length > 0 && <details className="skills-watching"><summary>{t('처리한 요청 {0}', { 0: decided.length })}</summary>
          <ul className="permission-history">{decided.map(request => <li key={request.id}><span className={`skill-badge ${request.status === 'approved' ? 'pinned' : ''}`}>{decidedLabel(request, t)}</span>
            <code>{request.rule.value}</code><small>{folderName(request.cwd)} · {date(request.decidedAt ?? request.createdAt)}</small>
            {request.decidedBy === 'auto' && request.review?.reason && <p className="permission-review-reason"><Bot size={13} />{request.review.reason}{request.review.suggestion ? ` → ${request.review.suggestion}` : ''}</p>}</li>)}</ul></details>}
      </section>}
      {tab === 'rules' && <RuleList overview={overview} cwd={cwd} busy={busy} onNew={() => setDraft(newRule())} onEdit={rule => setDraft(ruleDraft(rule))}
        onDelete={rule => { if (window.confirm(t('{0} 규칙을 삭제할까요? 다음 턴부터 적용되지 않습니다.', { 0: rule.value }))) void act('delete', { id: rule.id }, t('규칙을 삭제했습니다.')); }} />}
    </>}
  </SettingsPane>;
}

function Providers({ providers }: { providers: PermissionProvider[] }) {
  return <>{providers.map(provider => <span key={provider} className={`skill-badge ${provider}`}>{provider === 'claude' ? 'Claude' : 'Codex'}</span>)}</>;
}

/** What each provider will read for this rule, exactly. */
function NativePreview({ rule, warnCodex = false, guarded = false }: { rule: Pick<PermissionRuleInput, 'kind' | 'value' | 'providers'>; warnCodex?: boolean; guarded?: boolean }) {
  const { t } = useI18n();
  if (ruleProblem({ ...rule, scope: 'global' })) return null;
  const dangers = guarded && rule.kind === 'command' ? dangerousContinuations(rule.value) : [];
  return <dl className="permission-native">
    {rule.providers.includes('claude') && <><dt>Claude Code</dt><dd><code>{claudeRule(rule)}</code></dd></>}
    {rule.kind === 'command' && rule.providers.includes('codex') && <><dt>Codex</dt><dd><code>{codexRule(rule)}</code></dd></>}
    {warnCodex && rule.kind === 'command' && rule.providers.includes('codex') && <dd className="permission-broad"><TriangleAlert size={13} />{t('Codex 규칙은 트리거와 공개 에이전트를 포함한 이 컴퓨터의 모든 Codex 실행에 적용됩니다.')}</dd>}
    {ruleIsBroad(rule) && <dd className="permission-broad"><TriangleAlert size={13} />{t('넓은 규칙입니다. 이 프로그램으로 하는 거의 모든 일을 묻지 않고 허용합니다.')}</dd>}
    {guarded && rule.kind === 'command' && dangers.length > 0 && <><dt>{t('함께 막는 인자')}</dt><dd><code>{dangers.join('  ')}</code></dd></>}
  </dl>;
}

function decidedLabel(request: PermissionRequest, t: (text: string, values?: Record<string, string | number>) => string): string {
  if (request.status === 'withdrawn') return t('범위 축소 요청');
  if (request.status === 'approved') return request.decidedBy === 'auto' ? t('자동 허용') : t('허용');
  return t('거절');
}

/** What Tower's reviewer is doing with, or made of, a request still pending. */
function ReviewNote({ request }: { request: PermissionRequest }) {
  const { t } = useI18n();
  const review = request.review;
  if (!review) return null;
  const label = review.status === 'queued' || review.status === 'running' ? t('자동 검토 중')
    : review.status === 'skipped' ? t('자동 검토 대상 아님') : review.status === 'failed' ? t('자동 검토 실패') : t('자동 검토: 소유자 판단 필요');
  return <p className="permission-review-reason">{review.status === 'queued' || review.status === 'running' ? <LoaderCircle className="spin" size={13} /> : <Bot size={13} />}
    <strong>{label}</strong>{review.reason ? ` · ${translateMessage(review.reason)}` : ''}</p>;
}

/** The owner's setting for Tower's permission reviewer. */
function AutoReviewSettings({ settings, busy, onSave }: { settings: PermissionAutoReview; busy: boolean; onSave: (settings: PermissionAutoReview) => void }) {
  const { t } = useI18n();
  const change = (patch: Partial<PermissionAutoReview>) => {
    const next = { ...settings, ...patch };
    if (patch.provider && !AUTO_REVIEW_MODELS[patch.provider].includes(next.model)) next.model = AUTO_REVIEW_MODELS[patch.provider][0]!;
    onSave(next);
  };
  return <div className="permission-auto-review">
    <label className="skill-pinned"><input type="checkbox" checked={settings.enabled} disabled={busy} onChange={event => change({ enabled: event.target.checked })} />{t('자동 검토')}
      <small>{t('에이전트가 권한을 요청하면 별도 모델이 이 작업에 대한 소유자의 지시(Tower에서 직접 입력한 요청, 확인한 스킬과 지침)와 작업 내역을 보고, 작업에 필요하고 위험하지 않으면 그 프로젝트에만 허용합니다. 범위가 넓으면 더 좁게 다시 요청하게 하고, 그 밖에는 이유를 남겨 소유자에게 넘깁니다. 옵션이 든 명령 규칙, 넓은 규칙, 삭제·비밀·네트워크 명령, 소유자 규칙과 겹치는 규칙, 공개 에이전트의 요청, Tower 밖이나 이전 버전에서 시작한 대화의 요청은 항상 소유자가 정합니다.')}</small></label>
    {settings.enabled && <div className="permission-auto-review-options">
      <label>{t('검토 모델')}<select value={`${settings.provider}:${settings.model}`} disabled={busy} onChange={event => { const [provider, model] = event.target.value.split(':') as [PermissionProvider, string]; change({ provider, model }); }}>
        {(['claude', 'codex'] as const).flatMap(provider => AUTO_REVIEW_MODELS[provider].map(model => <option key={`${provider}:${model}`} value={`${provider}:${model}`}>{provider === 'claude' ? 'Claude' : 'Codex'} · {model}</option>))}
      </select></label>
      <label className="skill-pinned"><input type="checkbox" checked={settings.resume} disabled={busy} onChange={event => change({ resume: event.target.checked })} />{t('검토 결과를 요청한 대화에 알리기')}</label>
    </div>}
  </div>;
}

function RequestCard({ request, busy, onApprove, onEdit, onDeny, onOpenSession }: { request: PermissionRequest; busy: boolean; onApprove: () => void; onEdit: () => void; onDeny: () => void; onOpenSession: (id: string) => void }) {
  const { t } = useI18n();
  return <article className="skill-proposal permission-request">
    <header><code className="permission-value">{request.rule.value}</code><span className="skill-badges"><Providers providers={request.rule.providers} />
      <span className="skill-badge">{request.rule.scope === 'global' ? t('모든 프로젝트') : folderName(request.rule.cwd ?? request.cwd)}</span></span></header>
    <p>{request.reason}</p>
    <ReviewNote request={request} />
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
          <span className="skill-badges"><Providers providers={rule.providers} />{rule.kind === 'claude' && <span className="skill-badge">{t('Claude 규칙')}</span>}{rule.source === 'request' && <span className="skill-badge pinned">{t('요청으로 허용')}</span>}{rule.source === 'auto' && <span className="skill-badge pinned">{t('자동 검토로 허용')}</span>}</span>
          {rule.note && <p>{rule.note}</p>}
          <NativePreview rule={rule} guarded={rule.source === 'auto'} /></div>
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
