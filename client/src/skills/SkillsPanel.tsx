import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { FolderChip } from '../settings/FolderChip';
import { SettingsFrameContext, SettingsPane, useSettingsGuard } from '../settings/SettingsPane';
import { Archive, ArrowLeft, Check, ChevronRight, Download, Eye, FolderInput, FolderOpen, Globe, Layers, Link2, LoaderCircle, Merge, MoreHorizontal, Pencil, Pin, PinOff, Plus, RefreshCw, ScrollText, Settings2, Sparkles, Trash2, Upload, X } from 'lucide-react';
import type { Skill, SkillBundle, SkillDetail, SkillImportChoice, SkillImportPlan, SkillOverview, SkillProposal, SkillScope, SkillTargets } from '../../../shared/skills';
import { MAX_SKILL_DESCRIPTION, proposalReady, SKILL_NAME, targetsCover, targetsRevision } from '../../../shared/skills';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { api } from '../common/lib';
import { locale, translate as t, translateMessage, useI18n } from '../i18n/i18n';

const post = <T = SkillOverview>(path: string, token: string, body: unknown) => api<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token }, body: JSON.stringify(body) });
const query = (cwd?: string, extra: Record<string, string> = {}) => { const params = new URLSearchParams({ ...(cwd ? { cwd } : {}), ...extra }).toString(); return params ? `?${params}` : ''; };
const date = (value: string) => { const time = new Date(value); return Number.isNaN(time.getTime()) ? '' : time.toLocaleDateString(locale(), { month: 'short', day: 'numeric' }); };
const folderName = (path: string) => path.split('/').filter(Boolean).at(-1) || path;

type Draft = { dir?: string; revision?: string; name: string; description: string; body: string; scope: SkillScope; projectCwd?: string; pinned: boolean; proposalId?: string; external?: boolean; separate?: string;
  /** A skill kept in Tower: where it applies, and the value it was opened with. */
  targets?: SkillTargets; targetsRevision?: string };
type View = 'mine' | 'proposals' | 'all' | 'guidance' | 'backup' | 'settings';

/** Where a new skill or a proposal starts applying: the project it came from, or everywhere for a global one. */
const startTargets = (cwd?: string): SkillTargets => ({ all: false, projects: cwd ? [cwd] : [] });
const proposalTargets = (proposal: SkillProposal): SkillTargets => proposal.scope === 'project' && proposal.cwd ? { all: false, projects: [proposal.cwd] } : { all: true, projects: [] };
/** A skill's projects with one project switched on or off. */
export function toggleTargets(targets: SkillTargets, cwd: string, on: boolean): SkillTargets {
  return { all: false, projects: on ? [...new Set([...targets.projects, cwd])] : targets.projects.filter(item => item !== cwd) };
}
/** What a request says about targets: everywhere, or exactly the chosen projects. */
const targetsBody = (targets: SkillTargets) => targets.all ? { all: true } : { all: false, projects: targets.projects };

/**
 * The owner's skills: the ones kept in Tower first, each applying to the projects chosen for it; proposals beside them;
 * every other skill on the computer, guidance, backups and the advisor behind the ⋯ menu.
 */
export function SkillsPanel({ token, cwd, projects, onClearFolder, onChanged, onOpenSession }: { token: string; cwd?: string; projects: string[]; onClearFolder: () => void; onChanged: () => void; onOpenSession: (id: string) => void }) {
  const { t } = useI18n();
  const { active } = useContext(SettingsFrameContext);
  const [overview, setOverview] = useState<SkillOverview | null>(null);
  const [view, setView] = useState<View>('mine');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => setOverview(await api<SkillOverview>(`/api/skills${query(cwd)}`)), [cwd]);
  // Asked again when shown again: proposals arrive while the owner looks elsewhere.
  useEffect(() => { if (active) void load().catch(error => setError(error instanceof Error ? error.message : String(error))); }, [load, active]);
  // The 7-day analysis takes minutes; the panel follows it until it ends.
  const analysing = overview?.advisor.backfill?.running;
  useEffect(() => {
    if (!analysing || !active) return;
    const timer = setInterval(() => void load().catch(() => {}), 4_000);
    return () => clearInterval(timer);
  }, [analysing, active, load]);
  async function act(action: () => Promise<SkillOverview>, done = '') {
    if (busy) return false;
    setBusy(true); setError(''); setNotice('');
    try { setOverview(await action()); if (done) setNotice(done); onChanged(); return true; }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); return false; }
    finally { setBusy(false); }
  }
  const mutate = (action: string, body: Record<string, unknown>, done = '') => act(() => post(`/api/skills/${action}`, token, { ...body, ...(cwd ? { cwd } : {}) }), done);
  async function edit(skill: Skill) {
    setError('');
    try {
      const detail = await api<SkillDetail>(`/api/skills/detail${query(cwd, { dir: skill.dir })}`);
      const kept = detail.copies?.find(copy => copy.dir === detail.dir)?.providers;
      setDraft({ dir: detail.dir, revision: detail.revision, name: detail.name, description: detail.description, body: detail.body, scope: detail.scope, projectCwd: detail.cwd, pinned: detail.pinned, external: detail.external,
        ...(detail.managed && detail.targets ? { targets: detail.targets, targetsRevision: targetsRevision(detail.targets) } : {}),
        ...(detail.copies && kept ? { separate: kept.map(provider => provider === 'claude' ? 'Claude Code' : 'Codex').join('·') } : {}) });
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  const create = () => setDraft({ name: '', description: '', body: '', scope: 'global', pinned: true, targets: startTargets(cwd) });
  const review = (proposal: SkillProposal) => setDraft({ name: proposal.name, description: proposal.description, body: proposal.body, scope: proposal.scope, projectCwd: proposal.cwd, pinned: true, proposalId: proposal.id, targets: proposalTargets(proposal) });
  const accept = (proposal: SkillProposal) => void mutate('save', { name: proposal.name, description: proposal.description, body: proposal.body, targets: targetsBody(proposalTargets(proposal)), pinned: true, proposalId: proposal.id },
    t('{0} 스킬을 등록했습니다.', { 0: proposal.name }));
  const remove = (skill: Pick<Skill, 'dir' | 'name'>) => window.confirm(t('{0} 스킬을 삭제할까요? 폴더는 Tower 상태 폴더의 skills-trash로 옮겨집니다.', { 0: skill.name }))
    ? mutate('delete', { dir: skill.dir }, t('{0} 스킬을 삭제했습니다.', { 0: skill.name })) : Promise.resolve(false);
  const ready = overview?.proposals.filter(proposalReady) ?? [];
  const watching = overview?.proposals.filter(proposal => !proposalReady(proposal)) ?? [];
  const secondary: Partial<Record<View, string>> = { all: t('전체 스킬'), guidance: t('내 지침'), backup: t('백업'), settings: t('자동 추천 설정') };
  // Esc steps back one level: out of the editor, then out of a view behind the ⋯ menu.
  useSettingsGuard({
    escape: () => { if (draft) { setDraft(null); return true; } if (secondary[view]) { setView('mine'); return true; } return false; },
    leave: () => !draft || window.confirm(t('저장하지 않은 변경 사항을 버릴까요?')),
  });
  const tabs = draft || !overview || secondary[view] ? undefined : [{ id: 'mine' as View, label: <>{t('내 스킬')}<span className="skills-segment-count">{overview.stored?.length ?? 0}</span></> },
    { id: 'proposals' as View, label: t('추천'), count: ready.length }];
  return <SettingsPane title={t('스킬')} scope="auth-panel skills-scope" chip={cwd ? <FolderChip cwd={cwd} onClear={onClearFolder} /> : undefined}
    description={t('자주 하는 작업 방식을 에이전트가 같은 순서로 따르게 합니다')} actions={!draft && overview && <MoreMenu view={view} onChoose={setView} />} tabs={tabs} tab={view} onTab={setView}>
    {error && <p className="auth-error" role="alert">{translateMessage(error)}</p>}
    {notice && <p className="notification-notice" role="status">{notice}</p>}
    {draft ? <SkillEditor draft={draft} cwd={cwd} projects={projects} busy={busy} onCancel={() => setDraft(null)}
      onDelete={draft.dir ? () => void remove({ dir: draft.dir!, name: draft.name }).then(done => { if (done) setDraft(null); }) : undefined}
      onSave={async next => {
        const { targets, targetsRevision: opened, ...rest } = next;
        const body = targets ? { ...rest, targets: targetsBody(targets), ...(next.dir ? { targetsRevision: opened } : {}) } : rest;
        if (await mutate('save', body, t('{0} 스킬을 저장했습니다.', { 0: next.name }))) { setDraft(null); if (next.proposalId) setView('mine'); }
      }} />
      : !overview ? !error && <LoaderCircle className="spin" aria-label={t('불러오는 중')} /> : <>
      {secondary[view] && <div className="skills-subhead"><button type="button" className="skills-back" onClick={() => setView('mine')}><ArrowLeft size={14} />{t('내 스킬')}</button><h3>{secondary[view]}</h3></div>}
      {view === 'mine' && <TowerSkills overview={overview} cwd={cwd} busy={busy} proposals={ready.length} onNew={create} onEdit={skill => void edit(skill)} onProposals={() => setView('proposals')} onAll={() => setView('all')}
        onToggle={(skill, on) => { const targets = skill.targets!;
          void mutate('assign', { dir: skill.dir, targets: targetsBody(toggleTargets(targets, cwd!, on)), targetsRevision: targetsRevision(targets) },
            on ? t('{0} 스킬을 이 프로젝트에 적용했습니다.', { 0: skill.name }) : t('{0} 스킬을 이 프로젝트에서 뺐습니다.', { 0: skill.name })); }} />}
      {view === 'all' && <SkillList overview={overview} cwd={cwd} busy={busy} onNew={create}
        onEdit={skill => void edit(skill)} onPin={skill => void mutate('pin', { dir: skill.dir, pinned: !skill.pinned })}
        onLink={skill => void mutate('link', { dir: skill.dir }, t('{0} 스킬을 Claude Code와 Codex 모두에 연결했습니다.', { 0: skill.name }))}
        onMerge={skill => void mutate('merge', { dir: skill.dir }, t('{0} 스킬의 복사본을 하나로 합쳤습니다.', { 0: skill.name }))}
        onAdopt={skill => { if (window.confirm(`${t('{0} 스킬 폴더를 타워 폴더로 옮기고, 원래 자리에는 링크를 남깁니다. 에이전트는 계속 같은 스킬을 씁니다. 옮길까요?', { 0: skill.name })}${skill.external ? `\n\n${t('skills 명령으로 설치한 스킬입니다. 옮긴 뒤 skills 명령으로 다시 설치하거나 업데이트하면 타워에 둔 폴더가 바뀝니다.')}` : ''}`)) void mutate('adopt', { dir: skill.dir }, t('{0} 스킬을 타워로 옮겼습니다.', { 0: skill.name })); }}
        onDelete={skill => void remove(skill)} />}
      {view === 'proposals' && <section className="skills-proposals">
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
      {view === 'guidance' && <GuidanceEditor overview={overview} busy={busy} onSave={(owner, revision) => void mutate('guidance', { owner, revision }, t('지침을 저장했습니다. 새로 시작하는 대화부터 적용됩니다.'))
        // After a save refused because the guidance changed elsewhere, the latest version is fetched; the draft stays in the editor.
        .then(saved => { if (!saved) void load().catch(() => {}); })} />}
      {view === 'backup' && <Backup overview={overview} token={token} projects={projects} busy={busy} onImport={body => mutate('import', body, t('백업을 가져왔습니다.'))} onError={setError} />}
      {view === 'settings' && <AdvisorSettings overview={overview} busy={busy} onChange={body => void mutate('settings', body)}
        onBackfill={() => void mutate('backfill', { days: 7 }, t('최근 7일 요청을 분석하기 시작했습니다. 몇 분 걸립니다.'))} onRefresh={() => void act(async () => api<SkillOverview>(`/api/skills${query(cwd)}`))} />}
    </>}
  </SettingsPane>;
}

/** The views used now and then, kept out of sight behind one button. */
function MoreMenu({ view, onChoose }: { view: View; onChoose: (view: View) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    box.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const close = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    // Escape closes the menu only, never the panel under it, wherever the focus is.
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape, true); };
  }, [open]);
  const items: [View, string, typeof Eye][] = [['all', t('전체 스킬 보기'), Layers], ['guidance', t('내 지침'), ScrollText], ['backup', t('백업'), Archive], ['settings', t('자동 추천 설정'), Settings2]];
  return <div className="skills-more" ref={box}>
    <button className={`icon-button ${open ? 'active' : ''}`} aria-label={t('더 보기')} title={t('더 보기')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}><MoreHorizontal size={18} /></button>
    {open && <div className="skills-more-menu" role="menu">{items.map(([item, label, Icon]) => <button key={item} role="menuitem" className={view === item ? 'active' : ''} onClick={() => { setOpen(false); onChoose(item); }}><Icon size={15} />{label}</button>)}</div>}
  </div>;
}

const targetsLabel = (targets: SkillTargets) => targets.all ? t('모든 프로젝트') : !targets.projects.length ? t('적용 안 함')
  : targets.projects.length === 1 ? folderName(targets.projects[0]!) : t('{0} 외 {1}', { 0: folderName(targets.projects[0]!), 1: targets.projects.length - 1 });

/** The skills kept in Tower, one quiet row each: what it is, where it applies; a click opens it. */
export function TowerSkills({ overview, cwd, busy, proposals, onNew, onEdit, onToggle, onProposals, onAll }: { overview: SkillOverview; cwd?: string; busy: boolean; proposals: number; onNew: () => void; onEdit: (skill: Skill) => void; onToggle: (skill: Skill, on: boolean) => void; onProposals: () => void; onAll: () => void }) {
  const { t } = useI18n();
  const [filter, setFilter] = useState('');
  const stored = overview.stored ?? [];
  const needle = filter.trim().toLowerCase();
  const shown = stored.filter(skill => !needle || `${skill.name} ${skill.description}`.toLowerCase().includes(needle)).sort((a, b) => a.name.localeCompare(b.name));
  return <section className="tower-skills">
    {proposals > 0 && <button type="button" className="skills-suggest" onClick={onProposals}><Sparkles size={14} />{t('추천 스킬 {0}개가 기다리고 있습니다', { 0: proposals })}<ChevronRight size={14} /></button>}
    {stored.length > 0 && <div className="skills-toolbar"><input type="search" placeholder={t('스킬 찾기')} aria-label={t('스킬 찾기')} value={filter} onChange={event => setFilter(event.target.value)} />
      <button className="primary-button" disabled={busy} onClick={onNew}><Plus size={14} />{t('새 스킬')}</button></div>}
    {!stored.length ? <div className="skills-empty">
      <Sparkles size={22} />
      <p>{t('타워에 등록한 스킬이 없습니다.')}</p>
      <small>{t('자주 하는 작업 방식을 스킬로 등록하고 적용할 프로젝트를 고르면, 그 프로젝트의 Claude Code와 Codex가 같은 순서로 일합니다.')}</small>
      <button className="primary-button" disabled={busy} onClick={onNew}><Plus size={14} />{t('새 스킬')}</button>
      <button type="button" className="link-button" onClick={onAll}>{t('이 컴퓨터의 다른 스킬 보기')}</button>
    </div> : !shown.length ? <p className="auth-empty">{t('찾는 스킬이 없습니다.')}</p>
      : <ul>{shown.map(skill => {
        const targets = skill.targets;
        const here = Boolean(cwd && targets && targetsCover(targets, cwd));
        // Applied to a folder above this one: switched there, not here.
        const inherited = Boolean(here && targets && !targets.all && targets.projects.some(project => project !== cwd && targetsCover({ all: false, projects: [project] }, cwd!)));
        return <li key={skill.dir} className={`tower-skill ${cwd && !here ? 'elsewhere' : ''}`}>
          <button type="button" className="tower-skill-open" onClick={() => onEdit(skill)} aria-label={t('{0} 열기', { 0: skill.name })}>
            <span className="tower-skill-name"><strong>{skill.name}</strong>{!skill.pinned && <span className="skill-badge quiet" title={t('턴 시작 때 알리지 않습니다. 에이전트가 설명을 보고 스스로 고를 때만 씁니다.')}>{t('알림 끔')}</span>}</span>
            <span className="tower-skill-description">{skill.description || t('설명 없음')}</span>
          </button>
          {targets && <span className={`skill-target-chip ${targets.all ? 'all' : !targets.projects.length ? 'none' : ''}`} title={targets.all ? t('모든 프로젝트') : targets.projects.join('\n') || t('어느 프로젝트에도 적용하지 않습니다')}>{targets.all ? <Globe size={12} /> : <FolderOpen size={12} />}{targetsLabel(targets)}</span>}
          {cwd && targets && <label className="skill-switch" title={targets.all ? t('모든 프로젝트에 적용 중입니다. 바꾸려면 스킬을 여세요.') : inherited ? t('상위 폴더에 적용돼 있습니다. 바꾸려면 스킬을 여세요.') : t('이 프로젝트에 적용')}>
            <input type="checkbox" role="switch" checked={here} disabled={busy || targets.all || inherited} aria-label={t('{0}를 이 프로젝트에 적용', { 0: skill.name })} onChange={event => onToggle(skill, event.target.checked)} /><span aria-hidden="true" /></label>}
          <ChevronRight size={16} className="tower-skill-chevron" aria-hidden="true" />
        </li>;
      })}</ul>}
  </section>;
}

/** Everywhere, or the chosen projects: chips for the chosen ones, and a searchable list of the projects Tower knows. */
export function ProjectPicker({ value, projects, cwd, disabled, onChange }: { value: SkillTargets; projects: string[]; cwd?: string; disabled: boolean; onChange: (value: SkillTargets) => void }) {
  const { t } = useI18n();
  const [filter, setFilter] = useState('');
  const options = useMemo(() => [...new Set([...(cwd ? [cwd] : []), ...value.projects, ...projects])], [cwd, value.projects, projects]);
  const needle = filter.trim().toLowerCase();
  const shown = options.filter(path => !needle || path.toLowerCase().includes(needle));
  const toggle = (path: string, on: boolean) => onChange({ ...value, projects: on ? [...value.projects, path] : value.projects.filter(item => item !== path) });
  return <fieldset className="skill-targets" disabled={disabled}><legend>{t('적용 프로젝트')}</legend>
    <div className="skill-target-modes" role="radiogroup" aria-label={t('적용 프로젝트')}>
      <button type="button" role="radio" aria-checked={value.all} className={value.all ? 'active' : ''} onClick={() => onChange({ ...value, all: true })}><Globe size={13} />{t('모든 프로젝트')}</button>
      <button type="button" role="radio" aria-checked={!value.all} className={!value.all ? 'active' : ''} onClick={() => onChange({ ...value, all: false })}><FolderOpen size={13} />{t('고른 프로젝트')}{!value.all && value.projects.length > 0 && <span className="skills-segment-count">{value.projects.length}</span>}</button>
    </div>
    {value.all ? <small>{t('모든 프로젝트의 Claude Code와 Codex가 이 스킬을 씁니다.')}</small> : <>
      {value.projects.length ? <ul className="skill-target-chips">{value.projects.map(path => <li key={path} title={path}>{folderName(path)}
        <button type="button" aria-label={t('{0} 빼기', { 0: folderName(path) })} onClick={() => toggle(path, false)}><X size={12} /></button></li>)}</ul>
        : <small>{t('아직 고른 프로젝트가 없습니다. 이대로 저장하면 등록만 되고 어디에도 적용되지 않습니다.')}</small>}
      {options.length > 5 && <input type="search" className="skill-target-search" placeholder={t('프로젝트 찾기')} aria-label={t('프로젝트 찾기')} value={filter} onChange={event => setFilter(event.target.value)} />}
      <ul className="skill-target-options">{shown.map(path => <li key={path}><label><input type="checkbox" checked={value.projects.includes(path)} onChange={event => toggle(path, event.target.checked)} />
        <strong>{folderName(path)}</strong><small title={path}><bdi dir="ltr">{path}</bdi></small></label></li>)}</ul>
      {!shown.length && <small>{options.length ? t('찾는 프로젝트가 없습니다.') : t('Tower가 아는 프로젝트가 아직 없습니다.')}</small>}
    </>}
  </fieldset>;
}

function SkillList({ overview, cwd, busy, onNew, onEdit, onPin, onLink, onMerge, onAdopt, onDelete }: { overview: SkillOverview; cwd?: string; busy: boolean; onNew: () => void; onEdit: (skill: Skill) => void; onPin: (skill: Skill) => void; onLink: (skill: Skill) => void; onMerge: (skill: Skill) => void; onAdopt: (skill: Skill) => void; onDelete: (skill: Skill) => void }) {
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
            {skill.managed && <span className="skill-badge managed" title={t('타워 폴더에 있어 백업하고 옮길 수 있습니다.')}>{t('타워 관리')}</span>}
            {skill.targets && <span className={`skill-target-chip ${skill.targets.all ? 'all' : !skill.targets.projects.length ? 'none' : ''}`} title={skill.targets.projects.join('\n')}>{targetsLabel(skill.targets)}</span>}
            {!skill.providers.length && !skill.targets && <span className="skill-badge unlinked" title={t('타워 폴더에만 있고 에이전트 폴더에 연결되지 않았습니다. 연결을 누르면 Claude Code와 Codex가 씁니다.')}>{t('연결 안 됨')}</span>}
            {skill.pinned && <span className="skill-badge pinned">{t('항상 확인')}</span>}{skill.external && <span className="skill-badge external" title={t('skills 명령으로 설치한 스킬입니다. 다시 설치하면 여기서 고친 내용이 바뀝니다.')}>{t('외부 설치')}</span>}
            {skill.copies && <span className="skill-badge copies" title={skill.copiesDiffer ? t('Claude Code와 Codex가 각자 다른 폴더의 복사본을 씁니다. 내용이 조금 달라(보통 각자 자기 이름을 적음) 합치지 않았습니다.') : t('같은 내용의 복사본이 Claude Code와 Codex 폴더에 따로 있습니다. 하나로 합치면 고칠 때 한 번에 바뀝니다.')}>{skill.copiesDiffer ? t('에이전트별 복사본') : t('복사본 {0}개', { 0: skill.copies.length })}</span>}
            {skill.scope === 'project' && skill.cwd && skill.cwd !== cwd && <span className="skill-badge" title={skill.cwd}>{folderName(skill.cwd)}</span>}</span>
          <p>{skill.description || t('설명 없음')}</p></div>
        <div className="skill-row-actions">
          <button className="icon-button" title={skill.pinned ? t('항상 확인 끄기') : t('항상 확인: 모든 턴 시작 때 에이전트에게 알려 줍니다')} aria-label={skill.pinned ? t('항상 확인 끄기') : t('항상 확인 켜기')} aria-pressed={skill.pinned} disabled={busy} onClick={() => onPin(skill)}>{skill.pinned ? <PinOff size={15} /> : <Pin size={15} />}</button>
          {skill.copies && !skill.copiesDiffer && <button className="icon-button" title={t('복사본을 하나로 합치기')} aria-label={t('{0} 복사본을 하나로 합치기', { 0: skill.name })} disabled={busy} onClick={() => onMerge(skill)}><Merge size={15} /></button>}
          {skill.managed === false && <button className="icon-button" title={t('타워로 옮기기: 백업하고 다른 컴퓨터로 옮길 수 있게 타워 폴더에 둡니다')} aria-label={t('{0} 타워로 옮기기', { 0: skill.name })} disabled={busy || skill.copiesDiffer} onClick={() => onAdopt(skill)}><FolderInput size={15} /></button>}
          {skill.providers.length < 2 && !skill.targets && <button className="icon-button" title={t('Claude Code와 Codex 모두에 연결')} aria-label={t('Claude Code와 Codex 모두에 연결')} disabled={busy} onClick={() => onLink(skill)}><Link2 size={15} /></button>}
          <button className="icon-button" title={t('편집')} aria-label={t('{0} 편집', { 0: skill.name })} disabled={busy} onClick={() => onEdit(skill)}><Pencil size={15} /></button>
          <button className="icon-button" title={t('삭제')} aria-label={t('{0} 삭제', { 0: skill.name })} disabled={busy} onClick={() => onDelete(skill)}><Trash2 size={15} /></button>
        </div>
      </li>)}</ul> : <p className="auth-empty">{t('이 프로젝트에만 쓰는 스킬이 아직 없습니다.')}</p>}
    </div>)}
    {!shown.length && !cwd && <p className="auth-empty">{filter ? t('찾는 스킬이 없습니다.') : t('아직 스킬이 없습니다.')}</p>}
  </section>;
}

function SkillEditor({ draft: initial, cwd, projects, busy, onCancel, onSave, onDelete }: { draft: Draft; cwd?: string; projects: string[]; busy: boolean; onCancel: () => void; onSave: (draft: Draft) => void; onDelete?: () => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(initial);
  const editing = Boolean(draft.dir);
  const nameError = draft.name && !SKILL_NAME.test(draft.name) ? t('영어 소문자, 숫자, 하이픈만 쓸 수 있습니다.') : '';
  const set = (patch: Partial<Draft>) => setDraft(value => ({ ...value, ...patch }));
  return <form className="skill-editor" onSubmit={event => { event.preventDefault(); if (!nameError) onSave(draft); }}>
    <h3>{editing ? t('{0} 편집', { 0: draft.name }) : draft.proposalId ? t('추천 검토 후 등록') : t('새 스킬')}</h3>
    {draft.separate && <p className="auth-hint">{t('이 스킬은 에이전트마다 따로 복사본이 있습니다. 저장하면 {0}가 쓰는 복사본만 바뀝니다.', { 0: draft.separate })}</p>}
    {draft.external && <p className="auth-hint">{t('skills 명령으로 설치한 스킬입니다. 다시 설치하면 여기서 고친 내용이 바뀝니다.')}</p>}
    <label>{t('이름')}<input value={draft.name} disabled={editing || busy} required maxLength={64} placeholder="cross-verified-delivery" spellCheck={false} onChange={event => set({ name: event.target.value.toLowerCase().replace(/\s+/g, '-') })} />
      {nameError ? <small className="auth-error">{nameError}</small> : <small>{t('폴더 이름이 됩니다. 영어 소문자, 숫자, 하이픈.')}</small>}</label>
    <label>{t('언제 쓰는 스킬인가요?')}<textarea rows={3} value={draft.description} required maxLength={MAX_SKILL_DESCRIPTION} disabled={busy} placeholder={t('예: 새 기능을 구현하거나 설계를 바꾸는 요청을 받았을 때. 설계 → 교차 검증 → 구현 → 교차 검증 순서로 진행한다.')} onChange={event => set({ description: event.target.value })} />
      <small>{t('에이전트는 이 설명을 보고 스킬을 쓸지 정합니다. 무엇을 하는지와 언제 쓰는지를 함께 쓰세요.')}</small></label>
    {draft.targets && <ProjectPicker value={draft.targets} projects={projects} cwd={cwd} disabled={busy} onChange={targets => set({ targets })} />}
    <label>{t('작업 순서와 규칙 (Markdown)')}<textarea className="skill-body" rows={12} value={draft.body} disabled={busy} spellCheck={false} placeholder={'## 순서\n1. …\n2. …\n\n## 규칙\n- …'} onChange={event => set({ body: event.target.value })} /></label>
    <label className="skill-pinned"><input type="checkbox" checked={draft.pinned} disabled={busy} onChange={event => set({ pinned: event.target.checked })} />{t('항상 확인')}<small>{t('Tower가 모든 턴 시작 때(트리거, Slack, 마스터, 직접 대화) 이 스킬을 확인하라고 에이전트에게 알려 줍니다.')}</small></label>
    <footer>{onDelete && <button type="button" className="secondary-button skill-delete" disabled={busy} onClick={onDelete}><Trash2 size={14} />{t('삭제')}</button>}
      <span /><button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>{t('취소')}</button>
      <button type="submit" className="primary-button" disabled={busy || !draft.name || !!nameError || !draft.description.trim()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{draft.proposalId ? t('등록') : t('저장')}</button></footer>
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

/** The owner's own guidance, kept in Tower and given to every agent with Tower's text. */
function GuidanceEditor({ overview, busy, onSave }: { overview: SkillOverview; busy: boolean; onSave: (owner: string, revision: string) => void }) {
  const { t } = useI18n();
  const guidance = overview.guidance;
  const [owner, setOwner] = useState(guidance?.owner ?? '');
  const [saved, setSaved] = useState(guidance?.owner ?? '');
  // A newer saved text replaces the editor only while it holds no edits of its own; a draft survives a failed save.
  useEffect(() => { const next = guidance?.owner ?? ''; setOwner(current => current === saved ? next : current); setSaved(next); }, [guidance?.owner, guidance?.revision]);
  if (!guidance) return <p className="auth-empty">{t('실행 워커가 새 버전으로 바뀌면 지침을 관리할 수 있습니다.')}</p>;
  return <section className="skills-guidance">
    <p className="auth-hint">{t('모든 Claude Code와 Codex 대화가 받는 내 지침입니다. 타워 폴더(guidance/owner.md)에 있어 백업하고 옮길 수 있습니다. 요청과 프로젝트 지침이 먼저입니다.')}</p>
    {!guidance.installed && <p className="auth-hint">{t('이 타워는 기본 상태 폴더가 아니어서 에이전트 지침에 넣지 않고 저장만 합니다.')}</p>}
    <textarea className="skill-body" rows={14} value={owner} disabled={busy} spellCheck={false} aria-label={t('내 지침')} placeholder={t('예: 답은 항상 한국어로 합니다. 배포 전에는 반드시 테스트를 돌립니다.')} onChange={event => setOwner(event.target.value)} />
    <div className="skills-toolbar"><span /><button className="primary-button" disabled={busy || owner === guidance.owner} onClick={() => onSave(owner, guidance.revision)}><Check size={14} />{t('저장')}</button></div>
    <details><summary>{t('타워가 넣는 기본 지침 보기')}</summary><pre className="skill-preview">{guidance.tower}</pre></details>
  </section>;
}

/** Chosen skills and guidance out to a file, and back in on this or another computer. */
function Backup({ overview, token, projects, busy, onImport, onError }: { overview: SkillOverview; token: string; projects: string[]; busy: boolean; onImport: (body: Record<string, unknown>) => Promise<boolean>; onError: (message: string) => void }) {
  const { t } = useI18n();
  const stored = overview.stored ?? [];
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(stored.map(skill => skill.dir)));
  const [withGuidance, setWithGuidance] = useState(Boolean(overview.guidance?.owner.trim()));
  const [working, setWorking] = useState(false);
  const [bundle, setBundle] = useState<SkillBundle | null>(null);
  const [plan, setPlan] = useState<SkillImportPlan | null>(null);
  const [choices, setChoices] = useState<Record<number, SkillImportChoice>>({});
  const [guidanceMode, setGuidanceMode] = useState<'skip' | 'replace' | 'append'>('skip');
  const [pins, setPins] = useState(true);
  const external = overview.skills.filter(skill => skill.managed === false).length;
  async function download() {
    setWorking(true); onError('');
    try {
      const data = await post<SkillBundle>('/api/skills/export', token, { dirs: [...chosen], guidance: withGuidance });
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = `tower-skills-${new Date().toISOString().slice(0, 10)}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setWorking(false); }
  }
  /** Asks what importing the backup would do here now; after an import that partly failed, the answer shows what came in. */
  async function planFor(data: SkillBundle) {
    const next = await post<SkillImportPlan>('/api/skills/import-plan', token, data);
    setBundle(data); setPlan(next);
    setChoices(Object.fromEntries(next.items.map(item => [item.index, { index: item.index, action: item.conflict === 'new' && (item.scope === 'global' || item.cwd) ? 'add' : 'skip', ...(item.cwd ? { cwd: item.cwd } : {}) }])));
    // Someone else's guidance would reach every conversation: it is shown, and taken only when chosen.
    setGuidanceMode('skip');
  }
  async function read(file: File) {
    setWorking(true); onError(''); setPlan(null);
    try { await planFor(JSON.parse(await file.text()) as SkillBundle); }
    catch (error) { onError(error instanceof SyntaxError ? t('백업 파일을 읽을 수 없습니다.') : error instanceof Error ? error.message : String(error)); }
    finally { setWorking(false); }
  }
  // Choosing a project for an item that was skipped means taking it.
  const setChoice = (index: number, patch: Partial<SkillImportChoice>) => setChoices(value => ({ ...value, [index]: { ...value[index], ...patch,
    ...(patch.cwd && value[index]?.action === 'skip' ? { action: 'add' as const } : {}) } }));
  const taking = Object.values(choices).some(choice => choice.action !== 'skip') || guidanceMode !== 'skip';
  const place = (skill: Skill) => skill.scope === 'global' ? t('전역') : folderName(skill.cwd ?? '');
  return <section className="skills-backup">
    <h3>{t('내보내기')}</h3>
    <p className="auth-hint">{t('고른 스킬과 내 지침을 파일 하나로 받습니다. 다른 컴퓨터의 타워에서 가져오면 됩니다.')}{external > 0 && ` ${t('타워 폴더 밖의 스킬 {0}개는 스킬 탭에서 “타워로 옮기기”를 해야 백업할 수 있습니다.', { 0: external })}`}</p>
    {stored.length ? <ul className="skills-checklist">{stored.map(skill => <li key={skill.dir}><label><input type="checkbox" checked={chosen.has(skill.dir)} disabled={busy || working}
      onChange={event => setChosen(value => { const next = new Set(value); if (event.target.checked) next.add(skill.dir); else next.delete(skill.dir); return next; })} />
      <strong>{skill.name}</strong><span className="skill-badge">{place(skill)}</span>{skill.pinned && <span className="skill-badge pinned">{t('항상 확인')}</span>}</label></li>)}</ul>
      : <p className="auth-empty">{t('타워 폴더에 있는 스킬이 아직 없습니다.')}</p>}
    <label className="skill-pinned"><input type="checkbox" checked={withGuidance} disabled={busy || working || !overview.guidance?.owner.trim()} onChange={event => setWithGuidance(event.target.checked)} />{t('내 지침도 함께')}</label>
    <div className="skills-toolbar"><span /><button className="primary-button" disabled={busy || working || (!chosen.size && !withGuidance)} onClick={() => void download()}>{working ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}{t('선택한 것 내보내기')}</button></div>
    <h3>{t('가져오기')}</h3>
    <label className="secondary-button skills-file"><Upload size={14} />{t('백업 파일 고르기')}<input type="file" accept="application/json,.json" disabled={busy || working} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void read(file); }} /></label>
    {plan && bundle && <div className="skills-import">
      <p className="auth-hint">{t('{0}에서 {1}에 내보낸 백업입니다.', { 0: plan.from || '?', 1: plan.exportedAt ? new Date(plan.exportedAt).toLocaleString(locale()) : '?' })}</p>
      <ul className="skills-checklist">{plan.items.map(item => { const choice = choices[item.index]; return <li key={item.index}>
        <strong>{item.name}</strong><span className="skill-badge">{item.scope === 'global' ? t('전역') : folderName(item.fromCwd ?? '')}</span>
        {item.conflict === 'external' ? <small>{t('타워 밖에 같은 이름의 스킬이 있어 건너뜁니다.')}</small>
          : <select value={choice?.action ?? 'skip'} disabled={busy || working} aria-label={t('{0} 가져오기 방법', { 0: item.name })} onChange={event => setChoice(item.index, { action: event.target.value as SkillImportChoice['action'] })}>
            <option value="skip">{t('건너뛰기')}</option>{(item.conflict === 'new' || item.scope === 'project') && <option value="add">{t('가져오기')}</option>}
            {(item.conflict === 'managed' || item.scope === 'project') && <option value="replace">{t('타워에 있는 것을 바꾸기')}</option>}</select>}
        {item.scope === 'project' && item.conflict !== 'external' && <select value={choice?.cwd ?? ''} disabled={busy || working} aria-label={t('{0}를 둘 프로젝트', { 0: item.name })} onChange={event => setChoice(item.index, { cwd: event.target.value || undefined })}>
          <option value="">{t('프로젝트 고르기')}</option>{[...new Set([...(item.cwd ? [item.cwd] : []), ...projects])].map(path => <option key={path} value={path}>{folderName(path)} · {path}</option>)}</select>}
      </li>; })}</ul>
      {plan.guidance && <details className="skills-guidance-preview"><summary>{t('백업에 든 지침 보기')}</summary><pre className="skill-preview">{bundle.guidance}</pre></details>}
      {plan.guidance && <fieldset className="skill-scope"><legend>{t('백업에 든 지침')}</legend>
        {(['skip', 'append', 'replace'] as const).map(mode => <label key={mode}><input type="radio" name="guidance-mode" checked={guidanceMode === mode} onChange={() => setGuidanceMode(mode)} />{mode === 'skip' ? t('가져오지 않기') : mode === 'append' ? t('내 지침 뒤에 붙이기') : t('내 지침을 바꾸기')}</label>)}</fieldset>}
      <label className="skill-pinned"><input type="checkbox" checked={pins} onChange={event => setPins(event.target.checked)} />{t('“항상 확인”도 그대로')}</label>
      <div className="skills-toolbar"><span /><button className="primary-button" disabled={busy || working || !taking} onClick={async () => {
        const selected = Object.values(choices).filter(choice => choice.action !== 'skip');
        if (await onImport({ bundle, choices: selected, guidance: guidanceMode, pins })) { setPlan(null); setBundle(null); }
        else await planFor(bundle).catch(() => {});
      }}><Check size={14} />{t('가져오기')}</button></div>
    </div>}
  </section>;
}
