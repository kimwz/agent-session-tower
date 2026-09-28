import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Eye, Link2, LoaderCircle, Pencil, Pin, PinOff, Plus, RefreshCw, Sparkles, Trash2, X } from 'lucide-react';
import type { Skill, SkillDetail, SkillOverview, SkillProposal, SkillScope, SkillSummary } from '../../../shared/skills';
import { MAX_SKILL_DESCRIPTION, proposalReady, SKILL_NAME } from '../../../shared/skills';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { api } from '../common/lib';
import { locale, translate as t, translateMessage, useI18n } from '../i18n/i18n';
import { onOpenSkills } from './skills-open';

const post = (path: string, token: string, body: unknown) => api<SkillOverview>(path, { method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token }, body: JSON.stringify(body) });
const query = (cwd?: string, extra: Record<string, string> = {}) => { const params = new URLSearchParams({ ...(cwd ? { cwd } : {}), ...extra }).toString(); return params ? `?${params}` : ''; };
const date = (value: string) => { const time = new Date(value); return Number.isNaN(time.getTime()) ? '' : time.toLocaleDateString(locale(), { month: 'short', day: 'numeric' }); };
const folderName = (path: string) => path.split('/').filter(Boolean).at(-1) || path;

/** The header button: opens every skill, and shows how many proposals wait for the owner. */
export function SkillsButton({ token, projects, onOpenSession }: { token: string; projects: string[]; onOpenSession: (id: string) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<{ cwd?: string } | null>(null);
  const [count, setCount] = useState(0);
  const refresh = useCallback(() => { if (token) void api<SkillSummary>('/api/skills/summary').then(summary => setCount(summary.proposals)).catch(() => setCount(0)); }, [token]);
  useEffect(() => { refresh(); const timer = setInterval(refresh, 60_000); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => onOpenSkills(cwd => setOpen({ cwd })), []);
  const label = count ? t('스킬 · 추천 {0}개', { 0: count }) : t('스킬');
  return <><button className={`icon-button skills-button ${open ? 'active' : ''}`} data-master-panel="skills" title={label} aria-label={label} disabled={!token} onClick={() => setOpen({})}>
    <Sparkles size={18} />{count > 0 && <span className="skills-count" aria-hidden="true">{count > 9 ? '9+' : count}</span>}
  </button>{open && <SkillsPanel token={token} cwd={open.cwd} projects={projects} onOpenSession={id => { setOpen(null); onOpenSession(id); }} onClose={() => { setOpen(null); refresh(); }} />}</>;
}

type Draft = { dir?: string; revision?: string; name: string; description: string; body: string; scope: SkillScope; projectCwd?: string; pinned: boolean; proposalId?: string; external?: boolean };
type Tab = 'skills' | 'proposals' | 'settings';

/** The owner's skills where the panel was opened (every skill, or one project's with the global ones), proposals and settings. */
export function SkillsPanel({ token, cwd, projects, onClose, onOpenSession }: { token: string; cwd?: string; projects: string[]; onClose: () => void; onOpenSession: (id: string) => void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [overview, setOverview] = useState<SkillOverview | null>(null);
  const [tab, setTab] = useState<Tab>('skills');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => setOverview(await api<SkillOverview>(`/api/skills${query(cwd)}`)), [cwd]);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    void load().catch(error => setError(error instanceof Error ? error.message : String(error)));
    return () => { element?.close(); if (opener?.isConnected) opener.focus(); };
  }, [load]);
  // The 7-day analysis takes minutes; the panel follows it until it ends.
  const analysing = overview?.advisor.backfill?.running;
  useEffect(() => {
    if (!analysing) return;
    const timer = setInterval(() => void load().catch(() => {}), 4_000);
    return () => clearInterval(timer);
  }, [analysing, load]);
  async function act(action: () => Promise<SkillOverview>, done = '') {
    if (busy) return false;
    setBusy(true); setError(''); setNotice('');
    try { setOverview(await action()); if (done) setNotice(done); return true; }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); return false; }
    finally { setBusy(false); }
  }
  const mutate = (action: string, body: Record<string, unknown>, done = '') => act(() => post(`/api/skills/${action}`, token, { ...body, ...(cwd ? { cwd } : {}) }), done);
  async function edit(skill: Skill) {
    setError('');
    try {
      const detail = await api<SkillDetail>(`/api/skills/detail${query(cwd, { dir: skill.dir })}`);
      setDraft({ dir: detail.dir, revision: detail.revision, name: detail.name, description: detail.description, body: detail.body, scope: detail.scope, projectCwd: detail.cwd, pinned: detail.pinned, external: detail.external });
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  const review = (proposal: SkillProposal) => setDraft({ name: proposal.name, description: proposal.description, body: proposal.body, scope: proposal.scope, projectCwd: proposal.cwd, pinned: true, proposalId: proposal.id });
  const accept = (proposal: SkillProposal) => void mutate('save', { name: proposal.name, description: proposal.description, body: proposal.body, scope: proposal.scope, projectCwd: proposal.cwd, pinned: true, proposalId: proposal.id },
    t('{0} 스킬을 등록했습니다.', { 0: proposal.name }));
  const ready = overview?.proposals.filter(proposalReady) ?? [];
  const watching = overview?.proposals.filter(proposal => !proposalReady(proposal)) ?? [];
  const title = cwd ? t('{0}의 스킬', { 0: folderName(cwd) }) : t('스킬');
  return createPortal(<dialog ref={dialog} className="auth-dialog skills-dialog" aria-labelledby="skills-title" onCancel={event => { if (draft) { event.preventDefault(); setDraft(null); } else onClose(); }} onClick={event => { if (event.target === event.currentTarget && !draft) onClose(); }}><div className="auth-panel">
    <header><h2 id="skills-title"><Sparkles size={17} />{title}</h2><div><button className="icon-button" aria-label={t('닫기')} onClick={onClose}><X size={20} /></button></div></header>
    <p className="auth-hint">{cwd ? t('이 프로젝트에서 Claude Code와 Codex가 쓸 수 있는 스킬입니다. 이 프로젝트의 스킬과 모든 프로젝트에 쓰이는 전역 스킬이 함께 보입니다.')
      : t('자주 하는 작업 방식을 스킬로 두면 Claude Code와 Codex가 같은 요청을 같은 순서로 처리합니다. “항상 확인”으로 둔 스킬은 Tower가 모든 턴 시작 때 에이전트에게 알려 줍니다.')}</p>
    {error && <p className="auth-error" role="alert">{translateMessage(error)}</p>}
    {notice && <p className="notification-notice" role="status">{notice}</p>}
    {draft ? <SkillEditor draft={draft} cwd={cwd} projects={projects} busy={busy} onCancel={() => setDraft(null)}
      onSave={async next => { if (await mutate('save', { ...next }, t('{0} 스킬을 저장했습니다.', { 0: next.name }))) { setDraft(null); if (next.proposalId) setTab('skills'); } }} />
      : !overview ? !error && <LoaderCircle className="spin" aria-label={t('불러오는 중')} /> : <>
      <nav className="skills-tabs" role="tablist" aria-label={t('스킬 메뉴')}>
        {(['skills', 'proposals', 'settings'] as Tab[]).map(item => <button key={item} role="tab" aria-selected={tab === item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>
          {item === 'skills' ? t('스킬 {0}', { 0: overview.skills.length }) : item === 'proposals' ? <>{t('추천')}{ready.length > 0 && <span className="skills-count inline">{ready.length}</span>}</> : t('자동 추천 설정')}
        </button>)}
      </nav>
      {tab === 'skills' && <SkillList overview={overview} cwd={cwd} busy={busy} onNew={() => setDraft({ name: '', description: '', body: '', scope: cwd ? 'project' : 'global', ...(cwd ? { projectCwd: cwd } : {}), pinned: false })}
        onEdit={skill => void edit(skill)} onPin={skill => void mutate('pin', { dir: skill.dir, pinned: !skill.pinned })}
        onLink={skill => void mutate('link', { dir: skill.dir }, t('{0} 스킬을 Claude Code와 Codex 모두에 연결했습니다.', { 0: skill.name }))}
        onDelete={skill => { if (window.confirm(t('{0} 스킬을 삭제할까요? 폴더는 Tower 상태 폴더의 skills-trash로 옮겨집니다.', { 0: skill.name }))) void mutate('delete', { dir: skill.dir }, t('{0} 스킬을 삭제했습니다.', { 0: skill.name })); }} />}
      {tab === 'proposals' && <section className="skills-proposals">
        {ready.length ? ready.map(proposal => <ProposalCard key={proposal.id} proposal={proposal} busy={busy} onReview={review} onAccept={accept} onOpenSession={onOpenSession}
          onDismiss={item => void mutate('dismiss', { id: item.id }, t('{0} 추천을 무시했습니다. 다시 추천하지 않습니다.', { 0: item.name }))} />)
          : <p className="auth-empty">{overview.settings.enabled ? t('아직 추천이 없습니다. 세션이 끝날 때마다 작업 방식을 정리하다가, 같은 방식이 두 번 이상 보이거나 “앞으로 항상”처럼 말하면 추천합니다.') : t('자동 추천이 꺼져 있습니다.')}</p>}
        {watching.length > 0 && <details className="skills-watching"><summary>{t('관찰 중 {0}', { 0: watching.length })}</summary>
          <p className="auth-hint">{t('한 세션에서만 본 작업 방식입니다. 다른 세션에서 한 번 더 보이면 추천으로 올라옵니다.')}</p>
          {watching.map(proposal => <ProposalCard key={proposal.id} proposal={proposal} busy={busy} onReview={review} onAccept={accept} onOpenSession={onOpenSession}
            onDismiss={item => void mutate('dismiss', { id: item.id })} />)}
        </details>}
        {overview.notes.length > 0 && <details className="skills-notes"><summary>{t('최근 작업 패턴 기록 {0}', { 0: overview.notes.length })}</summary><ul>
          {overview.notes.map(note => <li key={`${note.at}-${note.sessionId}`}><button type="button" className="link-button" onClick={() => onOpenSession(note.sessionId)}>{note.title}</button><small>{date(note.at)} · {folderName(note.cwd)}</small><p>{note.note}</p></li>)}
        </ul></details>}
      </section>}
      {tab === 'settings' && <AdvisorSettings overview={overview} busy={busy} onChange={body => void mutate('settings', body)}
        onBackfill={() => void mutate('backfill', { days: 7 }, t('최근 7일 요청을 분석하기 시작했습니다. 몇 분 걸립니다.'))} onRefresh={() => void act(async () => api<SkillOverview>(`/api/skills${query(cwd)}`))} />}
    </>}
  </div></dialog>, document.body);
}

function SkillList({ overview, cwd, busy, onNew, onEdit, onPin, onLink, onDelete }: { overview: SkillOverview; cwd?: string; busy: boolean; onNew: () => void; onEdit: (skill: Skill) => void; onPin: (skill: Skill) => void; onLink: (skill: Skill) => void; onDelete: (skill: Skill) => void }) {
  const { t } = useI18n();
  const [filter, setFilter] = useState('');
  const shown = useMemo(() => overview.skills.filter(skill => !filter.trim() || `${skill.name} ${skill.description}`.toLowerCase().includes(filter.trim().toLowerCase())), [overview.skills, filter]);
  const groups: [string, Skill[]][] = [[t('이 프로젝트'), shown.filter(skill => skill.scope === 'project')], [t('전역 · 모든 프로젝트'), shown.filter(skill => skill.scope === 'global')]];
  return <section className="skills-list">
    <div className="skills-toolbar"><input type="search" placeholder={t('스킬 찾기')} aria-label={t('스킬 찾기')} value={filter} onChange={event => setFilter(event.target.value)} />
      <button className="secondary-button" disabled={busy} onClick={onNew}><Plus size={14} />{t('새 스킬')}</button></div>
    {groups.map(([label, skills]) => (skills.length > 0 || (label === t('이 프로젝트') && cwd)) && <div key={label} className="skills-group"><h3>{label} <span className="auth-count">{skills.length}</span></h3>
      {skills.length ? <ul>{skills.map(skill => <li key={skill.dir} className={`skill-row ${skill.pinned ? 'pinned' : ''}`}>
        <div className="skill-row-main"><strong>{skill.name}</strong>
          <span className="skill-badges">{skill.providers.map(provider => <span key={provider} className={`skill-badge ${provider}`}>{provider === 'claude' ? 'Claude' : 'Codex'}</span>)}
            {skill.pinned && <span className="skill-badge pinned">{t('항상 확인')}</span>}{skill.external && <span className="skill-badge external" title={t('skills 명령으로 설치한 스킬입니다. 다시 설치하면 여기서 고친 내용이 바뀝니다.')}>{t('외부 설치')}</span>}
            {skill.scope === 'project' && skill.cwd && skill.cwd !== cwd && <span className="skill-badge" title={skill.cwd}>{folderName(skill.cwd)}</span>}</span>
          <p>{skill.description || t('설명 없음')}</p></div>
        <div className="skill-row-actions">
          <button className="icon-button" title={skill.pinned ? t('항상 확인 끄기') : t('항상 확인: 모든 턴 시작 때 에이전트에게 알려 줍니다')} aria-label={skill.pinned ? t('항상 확인 끄기') : t('항상 확인 켜기')} aria-pressed={skill.pinned} disabled={busy} onClick={() => onPin(skill)}>{skill.pinned ? <PinOff size={15} /> : <Pin size={15} />}</button>
          {skill.providers.length < 2 && <button className="icon-button" title={t('Claude Code와 Codex 모두에 연결')} aria-label={t('Claude Code와 Codex 모두에 연결')} disabled={busy} onClick={() => onLink(skill)}><Link2 size={15} /></button>}
          <button className="icon-button" title={t('편집')} aria-label={t('{0} 편집', { 0: skill.name })} disabled={busy} onClick={() => onEdit(skill)}><Pencil size={15} /></button>
          <button className="icon-button" title={t('삭제')} aria-label={t('{0} 삭제', { 0: skill.name })} disabled={busy} onClick={() => onDelete(skill)}><Trash2 size={15} /></button>
        </div>
      </li>)}</ul> : <p className="auth-empty">{t('이 프로젝트에만 쓰는 스킬이 아직 없습니다.')}</p>}
    </div>)}
    {!shown.length && !cwd && <p className="auth-empty">{filter ? t('찾는 스킬이 없습니다.') : t('아직 스킬이 없습니다.')}</p>}
  </section>;
}

function SkillEditor({ draft: initial, cwd, projects, busy, onCancel, onSave }: { draft: Draft; cwd?: string; projects: string[]; busy: boolean; onCancel: () => void; onSave: (draft: Draft) => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(initial);
  const editing = Boolean(draft.dir);
  const nameError = draft.name && !SKILL_NAME.test(draft.name) ? t('영어 소문자, 숫자, 하이픈만 쓸 수 있습니다.') : '';
  const choices = [...new Set([...(cwd ? [cwd] : []), ...(draft.projectCwd ? [draft.projectCwd] : []), ...projects])];
  const set = (patch: Partial<Draft>) => setDraft(value => ({ ...value, ...patch }));
  return <form className="skill-editor" onSubmit={event => { event.preventDefault(); if (!nameError) onSave(draft); }}>
    <h3>{editing ? t('{0} 편집', { 0: draft.name }) : draft.proposalId ? t('추천 검토 후 등록') : t('새 스킬')}</h3>
    {draft.external && <p className="auth-hint">{t('skills 명령으로 설치한 스킬입니다. 다시 설치하면 여기서 고친 내용이 바뀝니다.')}</p>}
    <label>{t('이름')}<input value={draft.name} disabled={editing || busy} required maxLength={64} placeholder="cross-verified-delivery" spellCheck={false} onChange={event => set({ name: event.target.value.toLowerCase().replace(/\s+/g, '-') })} />
      {nameError ? <small className="auth-error">{nameError}</small> : <small>{t('폴더 이름이 됩니다. 영어 소문자, 숫자, 하이픈.')}</small>}</label>
    {!editing && <fieldset className="skill-scope"><legend>{t('적용 범위')}</legend>
      <label><input type="radio" name="scope" checked={draft.scope === 'global'} disabled={busy} onChange={() => set({ scope: 'global' })} />{t('전역 · 모든 프로젝트')}</label>
      <label><input type="radio" name="scope" checked={draft.scope === 'project'} disabled={busy || !choices.length} onChange={() => set({ scope: 'project', projectCwd: draft.projectCwd ?? choices[0] })} />{t('한 프로젝트')}</label>
      {draft.scope === 'project' && <select value={draft.projectCwd ?? ''} disabled={busy} aria-label={t('프로젝트')} onChange={event => set({ projectCwd: event.target.value })}>{choices.map(item => <option key={item} value={item}>{folderName(item)} · {item}</option>)}</select>}
    </fieldset>}
    <label>{t('언제 쓰는 스킬인가요?')}<textarea rows={3} value={draft.description} required maxLength={MAX_SKILL_DESCRIPTION} disabled={busy} placeholder={t('예: 새 기능을 구현하거나 설계를 바꾸는 요청을 받았을 때. 설계 → 교차 검증 → 구현 → 교차 검증 순서로 진행한다.')} onChange={event => set({ description: event.target.value })} />
      <small>{t('에이전트는 이 설명을 보고 스킬을 쓸지 정합니다. 무엇을 하는지와 언제 쓰는지를 함께 쓰세요.')}</small></label>
    <label>{t('작업 순서와 규칙 (Markdown)')}<textarea className="skill-body" rows={16} value={draft.body} disabled={busy} spellCheck={false} placeholder={'## 순서\n1. …\n2. …\n\n## 규칙\n- …'} onChange={event => set({ body: event.target.value })} /></label>
    <label className="skill-pinned"><input type="checkbox" checked={draft.pinned} disabled={busy} onChange={event => set({ pinned: event.target.checked })} />{t('항상 확인')}<small>{t('Tower가 모든 턴 시작 때(트리거, Slack, 마스터, 직접 대화) 이 스킬을 확인하라고 에이전트에게 알려 줍니다.')}</small></label>
    <footer><button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>{t('취소')}</button>
      <button type="submit" className="primary-button" disabled={busy || !draft.name || !!nameError || !draft.description.trim() || (draft.scope === 'project' && !draft.projectCwd)}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{draft.proposalId ? t('등록') : t('저장')}</button></footer>
  </form>;
}

function ProposalCard({ proposal, busy, onReview, onAccept, onDismiss, onOpenSession }: { proposal: SkillProposal; busy: boolean; onReview: (proposal: SkillProposal) => void; onAccept: (proposal: SkillProposal) => void; onDismiss: (proposal: SkillProposal) => void; onOpenSession: (id: string) => void }) {
  const { t } = useI18n();
  const [preview, setPreview] = useState(false);
  return <article className="skill-proposal">
    <header><strong>{proposal.name}</strong><span className="skill-badges"><span className="skill-badge">{proposal.scope === 'global' ? t('전역') : folderName(proposal.cwd ?? '')}</span>
      {proposal.explicit && <span className="skill-badge pinned">{t('직접 요청한 규칙')}</span>}<span className="skill-badge">{t('세션 {0}개에서 발견', { 0: new Set(proposal.evidence.map(item => item.sessionId)).size })}</span></span></header>
    <p>{proposal.description}</p>
    {proposal.reason && <p className="skill-proposal-reason">{proposal.reason}</p>}
    <ul className="skill-evidence">{proposal.evidence.slice(-5).map(item => <li key={item.sessionId}><button type="button" className="link-button" onClick={() => onOpenSession(item.sessionId)}>{item.title}</button><small>{date(item.at)}</small></li>)}</ul>
    {preview && <pre className="skill-preview">{proposal.body}</pre>}
    <footer><button type="button" className="secondary-button" onClick={() => setPreview(value => !value)}><Eye size={14} />{preview ? t('내용 접기') : t('내용 보기')}</button>
      <span />
      <button type="button" className="secondary-button" disabled={busy} onClick={() => onDismiss(proposal)}>{t('무시')}</button>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => onReview(proposal)}><Pencil size={14} />{t('검토 후 등록')}</button>
      <button type="button" className="primary-button" disabled={busy} onClick={() => onAccept(proposal)}><Check size={14} />{t('바로 등록')}</button></footer>
  </article>;
}

function AdvisorSettings({ overview, busy, onChange, onBackfill, onRefresh }: { overview: SkillOverview; busy: boolean; onChange: (body: Record<string, unknown>) => void; onBackfill: () => void; onRefresh: () => void }) {
  const { t } = useI18n();
  const { settings, advisor } = overview;
  const time = (value?: string) => value ? new Date(value).toLocaleString(locale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  return <section className="skills-settings">
    <label className="skill-pinned"><input type="checkbox" checked={settings.enabled} disabled={busy} onChange={event => onChange({ enabled: event.target.checked })} />{t('세션이 끝나면 작업 방식을 정리하고 스킬 추천')}
      <small>{t('이 컴퓨터에서 직접 한 세션이 10분 동안 조용하면, 그 세션의 요청과 마지막 답변 앞부분, 지금 있는 스킬과 추천 목록을 아래 모델에 보내 작업 방식을 한두 문장으로 정리합니다. 트리거, Slack, 다른 에이전트나 다른 컴퓨터가 시작한 작업과 닫은 세션은 읽지 않습니다. 대화 기록은 남지 않으며 하루 40번까지 부릅니다.')}</small></label>
    <label className="decision-provider">{t('정리할 모델')}<select value={settings.provider} disabled={busy} onChange={event => onChange({ provider: event.target.value })}>
      <option value="claude">Claude Sonnet</option><option value="codex">Codex GPT-5.6 Terra</option></select></label>
    <p className="auth-hint">{advisor.running ? t('지금 세션을 정리하고 있습니다.') : advisor.lastRunAt ? t('마지막 정리 {0}', { 0: time(advisor.lastRunAt) }) : t('아직 정리한 세션이 없습니다.')}
      {advisor.lastError && <><br /><span className="auth-error">{t('마지막 오류: {0}', { 0: advisor.lastError })}</span></>}</p>
    <h3>{t('지난 작업 분석')}</h3>
    <p className="auth-hint">{t('최근 7일 동안 직접 한 세션들의 요청을 한 번에 모아, 반복되는 작업 방식을 추천으로 올립니다.')}</p>
    <div className="skills-toolbar"><button className="secondary-button" disabled={busy || advisor.backfill?.running} onClick={onBackfill}>{advisor.backfill?.running ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}{advisor.backfill?.running ? t('분석하는 중…') : t('최근 7일 분석')}</button>
      <button className="icon-button" title={t('새로고침')} aria-label={t('새로고침')} disabled={busy} onClick={onRefresh}><RefreshCw size={14} /></button></div>
    {advisor.backfill?.at && !advisor.backfill.running && <p className="auth-hint">{advisor.backfill.error ? <span className="auth-error">{t('분석 실패: {0}', { 0: advisor.backfill.error })}</span> : t('{0}에 분석해 추천 {1}개를 올렸습니다.', { 0: time(advisor.backfill.at), 1: advisor.backfill.proposals ?? 0 })}</p>}
  </section>;
}
