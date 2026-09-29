import { translate as t, translateMessage, useI18n } from '../i18n/i18n';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CodeXml, Eye, EyeOff, Folder, LoaderCircle, Pencil, Pin, Plus, Settings, ShieldCheck, Sparkles, Terminal, X } from 'lucide-react';
import { openSkills, useSkillSummary } from '../skills/skills-open';
import { openPermissions } from '../permissions/permissions-open';
import type { ProjectGroupPatch } from '../../../shared/types';
import type { RepositoryAction, RepositoryStatus } from '../../../shared/repositories';
import { RepositorySync } from './RepositorySync';
import type { SessionDraft } from '../sessions/NewSessionDialog';
import { useOpenWorkspace } from '../workspace/WorkspaceOverlay';
import { projectGroupDisplayTitle } from './project-group-title';
import { localPart, splitScopedId } from '../remote/scope';

export type ProjectGroupHeaderData = {
  token?: string;
  name: string;
  title: string;
  path: string;
  count: number;
  active: number;
  pinned: boolean;
  hidden: boolean;
  /** How many session cards sit side by side in this folder. */
  columns: number;
  onColumnsChange: (columns: number) => void;
  disabled: boolean;
  saving: boolean;
  error?: string;
  onUpdate: (patch: ProjectGroupPatch) => Promise<boolean>;
  onCreate: (cwd: string, draft?: SessionDraft) => void;
  repository?: RepositoryStatus;
  /** Resolves to an error message when the action failed. */
  onRepositoryAction?: (cwd: string, action: RepositoryAction) => Promise<string | undefined>;
  /** Pinning and hiding are kept by this Tower; they stay available while another computer is away. */
  viewDisabled?: boolean;
  /** Files and terminals need only a connection, not a computer ready for new work. */
  workspaceDisabled?: boolean;
  workspaceNote?: string;
  /** The joined computer the folder is on. */
  machine?: string;
};

function GroupTitleDialog({ data, onClose }: { data: ProjectGroupHeaderData; onClose: () => void }) {
  useI18n();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const [draft, setDraft] = useState(data.title);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current;
    element?.showModal();
    input.current?.focus();
    input.current?.select();
    return () => { element?.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);

  return createPortal(<dialog ref={dialog} className="group-title-dialog nodrag nopan" aria-labelledby={`${id}-heading`} tabIndex={-1}
    onCancel={event => { event.preventDefault(); if (!inFlight.current) onClose(); }}
    onKeyDown={event => {
      event.stopPropagation();
      if ((event.key === 'Escape' || event.key === 'Enter') && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
      if (event.key === 'Escape' && inFlight.current) event.preventDefault();
    }}
    onClick={event => {
      event.stopPropagation();
      if (event.target !== event.currentTarget || inFlight.current) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <form onSubmit={async event => {
      event.preventDefault();
      if (inFlight.current || data.disabled || data.saving) return;
      inFlight.current = true;
      try { if (await data.onUpdate({ cwd: data.path, title: draft.trim() })) onClose(); }
      finally { inFlight.current = false; }
    }} aria-busy={data.saving}>
      <header><h2 id={`${id}-heading`}>{t("그룹 제목")}</h2><button type="button" className="icon-button" aria-label={t("그룹 제목 편집 닫기")} disabled={data.saving} onClick={onClose}><X size={18} /></button></header>
      <p className="group-title-path">{localPart(data.path)}</p>
      <label htmlFor={`${id}-title`}>{t("표시할 이름")}</label>
      <input ref={input} id={`${id}-title`} value={draft} onChange={event => setDraft(event.target.value)} placeholder={t("비워두면 폴더 이름을 표시합니다")} maxLength={120} disabled={data.saving} autoComplete="off" />
      <p className="group-title-help">{t("폴더 경로는 그대로 유지됩니다.")}</p>
      {data.error && <p className="group-title-error" role="alert">{translateMessage(data.error)}</p>}
      <footer><button type="button" className="secondary-button" disabled={data.saving} onClick={onClose}>{t("취소")}</button><button type="submit" className="group-title-save" disabled={data.disabled || data.saving}>{data.saving && <LoaderCircle size={14} className="spin" />}{data.saving ? t("저장 중…") : t("저장")}</button></footer>
    </form>
  </dialog>, document.body);
}

const COLUMN_CHOICES = [1, 2, 3, 4];

/** Everything about a folder except pinning, which stays on its header. */
export function ProjectGroupMenu({ data, onEditTitle, onDone }: { data: ProjectGroupHeaderData; onEditTitle: () => void; onDone: () => void }) {
  useI18n();
  const openWorkspace = useOpenWorkspace();
  const actionable = localPart(data.path).startsWith('/');
  const disabled = data.disabled || data.saving || !actionable;
  const viewDisabled = (data.viewDisabled ?? data.disabled) || data.saving || !actionable;
  const workspaceUnavailable = (data.workspaceDisabled ?? data.disabled) || data.saving || !actionable || !data.token || !openWorkspace;
  const workspaceNote = workspaceUnavailable && actionable ? data.workspaceNote : undefined;
  const act = (action: () => void) => () => { onDone(); action(); };
  const skillSummary = useSkillSummary();
  const proposed = Boolean(skillSummary.projects?.includes(localPart(data.path)));
  return <>
    <button type="button" disabled={data.disabled || !actionable} onClick={act(() => data.onCreate(data.path))}><Plus size={15} />{t("이 폴더에 새 세션")}</button>
    <button type="button" disabled={workspaceUnavailable} onClick={act(() => openWorkspace?.(data.path, 'editor', data.machine))}><CodeXml size={15} />{t("브라우저 코드 에디터 열기")}</button>
    <button type="button" disabled={workspaceUnavailable} onClick={act(() => openWorkspace?.(data.path, 'terminal', data.machine))}><Terminal size={15} />{t("브라우저 터미널 열기")}</button>
    {workspaceNote && <p className="project-group-menu-note">{workspaceNote}</p>}
    {!data.machine && <button type="button" disabled={!actionable || !data.token} onClick={act(() => openSkills(data.path))}><Sparkles size={15} />{t("이 폴더의 스킬")}{proposed && <span className="skills-dot" title={t("이 폴더에 추천 스킬이 있습니다")} aria-label={t("추천 있음")} />}</button>}
    {!data.machine && <button type="button" disabled={!actionable || !data.token} onClick={act(() => openPermissions(data.path))}><ShieldCheck size={15} />{t("이 폴더의 권한")}</button>}
    <button type="button" disabled={disabled} onClick={act(onEditTitle)}><Pencil size={14} />{t("그룹 제목 편집")}</button>
    <button type="button" aria-pressed={data.hidden} disabled={viewDisabled} onClick={act(() => { void data.onUpdate({ cwd: data.path, hidden: !data.hidden }); })}>{data.hidden ? <EyeOff size={15} /> : <Eye size={15} />}{data.hidden ? t("폴더 숨김 해제") : t("폴더와 세션을 캔버스에서 숨기기")}</button>
    <div className="project-group-columns" role="group" aria-label={t("한 줄에 놓을 세션 수")}><span>{t("한 줄에 놓을 세션 수")}</span><div>
      {COLUMN_CHOICES.map(value => <button type="button" key={value} aria-pressed={data.columns === value} aria-label={t("한 줄에 {0}개", { 0: value })} onClick={() => data.onColumnsChange(value)}>{value}</button>)}
    </div></div>
  </>;
}

function ProjectGroupSettings({ data, onEditTitle }: { data: ProjectGroupHeaderData; onEditTitle: () => void }) {
  useI18n();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLElement>(null);
  const close = (refocus = false) => { setOpen(false); if (refocus) trigger.current?.focus({ preventScroll: true }); };
  // The canvas scales its nodes; the menu opens on the page so it stays readable and above the cards.
  useLayoutEffect(() => {
    if (!open) { setPlace(null); return; }
    const bounds = trigger.current?.getBoundingClientRect();
    if (!bounds) return;
    const width = menu.current?.offsetWidth || 240;
    setPlace({ top: bounds.bottom + 6, left: Math.max(8, Math.min(bounds.right - width, window.innerWidth - width - 8)) });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('button:enabled')?.focus({ preventScroll: true });
    const outside = (event: Event) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    const moved = (event: Event) => { if (!(event.target instanceof Node && menu.current?.contains(event.target))) setOpen(false); };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside, true);
    document.addEventListener('keydown', escape, true);
    document.addEventListener('wheel', moved, true);
    window.addEventListener('resize', moved);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside, true);
      document.removeEventListener('keydown', escape, true);
      document.removeEventListener('wheel', moved, true);
      window.removeEventListener('resize', moved);
    };
  }, [open]);
  return <>
    <button ref={trigger} type="button" className="project-group-action project-group-settings-trigger" aria-label={t("{0} 폴더 설정", { 0: data.name })} title={t("폴더 설정")} aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}><Settings size={15} /></button>
    {open && createPortal(<section ref={menu} id={id} aria-label={t("{0} 폴더 설정", { 0: data.name })} className="project-group-menu nodrag nopan" style={place ? { top: place.top, left: place.left } : { visibility: 'hidden' }}
      onKeyDown={event => event.stopPropagation()}>
      <ProjectGroupMenu data={data} onEditTitle={onEditTitle} onDone={() => close()} />
    </section>, document.body)}
  </>;
}

export function ProjectGroupHeader({ data }: { data: ProjectGroupHeaderData }) {
  useI18n();
  const [editing, setEditing] = useState(false);
  const folder = splitScopedId(data.path);
  const actionable = folder.id.startsWith('/');
  const viewDisabled = (data.viewDisabled ?? data.disabled) || data.saving || !actionable;
  return <>
    <div className="project-group-heading">
      <div className="project-group-title"><Folder size={16} aria-hidden="true" /><strong title={data.name}><bdi dir="ltr">{projectGroupDisplayTitle(data.name)}</bdi></strong></div>
      <div className="project-group-location"><div className="project-group-path folder-tail" title={folder.id}><bdi dir="ltr">{folder.id}</bdi></div>{data.repository && data.onRepositoryAction && <RepositorySync status={data.repository} busy={data.active > 0} disabled={data.disabled} onAction={data.onRepositoryAction} onDelegate={draft => data.onCreate(data.path, draft)} />}</div>
      <div className="project-group-bottom"><span>{data.count}{t("개 세션")}{data.active > 0 && t(" · {0}개 작업 중", { 0: data.active })}</span><div className="project-group-actions nodrag nopan">
        <button className={`project-group-action ${data.pinned ? 'pinned' : ''}`} aria-label={t("{0} 그룹 {1}", { 0: data.name, 1: data.pinned ? t("고정 해제") : t("고정") })} aria-pressed={data.pinned} title={data.pinned ? t("그룹 고정 해제") : t("세션이 없어도 그룹 유지")} disabled={viewDisabled} onClick={() => { void data.onUpdate({ cwd: data.path, pinned: !data.pinned }); }}>{data.saving && !editing ? <LoaderCircle size={14} className="spin" /> : <Pin size={14} />}</button>
        <ProjectGroupSettings data={data} onEditTitle={() => setEditing(true)} />
      </div></div>
      {data.error && !editing && <p className="project-group-error nodrag nopan" role="alert">{translateMessage(data.error)}</p>}
    </div>
    {editing && <GroupTitleDialog data={data} onClose={() => setEditing(false)} />}
  </>;
}
