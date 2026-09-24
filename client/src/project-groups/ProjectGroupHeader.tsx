import { translate as t, translateMessage, useI18n } from '../i18n/i18n';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye, EyeOff, Folder, Grip, LoaderCircle, Pencil, Pin, Plus, X } from 'lucide-react';
import type { ProjectGroupPatch } from '../../../shared/types';
import type { RepositoryAction, RepositoryStatus } from '../../../shared/repositories';
import { RepositorySync } from './RepositorySync';
import { WorkspaceActions } from '../workspace/WorkspaceActions';
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
  manual: boolean;
  disabled: boolean;
  saving: boolean;
  error?: string;
  onUpdate: (patch: ProjectGroupPatch) => Promise<boolean>;
  onCreate: (cwd: string) => void;
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

export function ProjectGroupHeader({ data }: { data: ProjectGroupHeaderData }) {
  useI18n();
  const [editing, setEditing] = useState(false);
  const folder = splitScopedId(data.path);
  const actionable = folder.id.startsWith('/');
  const disabled = data.disabled || data.saving || !actionable;
  const viewDisabled = (data.viewDisabled ?? data.disabled) || data.saving || !actionable;
  return <>
    <div className="project-group-heading">
      <div className="project-group-title"><Folder size={16} aria-hidden="true" /><strong title={data.name}><bdi dir="ltr">{projectGroupDisplayTitle(data.name)}</bdi></strong><button className="project-group-action nodrag nopan" aria-label={t("{0} 그룹 제목 편집", { 0: data.name })} title={t("그룹 제목 편집")} disabled={disabled} onClick={() => setEditing(true)}><Pencil size={13} /></button></div>
      <div className="project-group-location"><div className="project-group-path folder-tail" title={folder.id}><bdi dir="ltr">{folder.id}</bdi></div>{data.repository && data.onRepositoryAction && <RepositorySync status={data.repository} busy={data.active > 0} disabled={data.disabled} onAction={data.onRepositoryAction} />}</div>
      <div className="project-group-bottom"><span>{data.count}{t("개 세션")}{data.active > 0 && t(" · {0}개 작업 중", { 0: data.active })}</span><div className="project-group-actions nodrag nopan">
        <WorkspaceActions cwd={data.path} token={data.token || ''} disabled={(data.workspaceDisabled ?? data.disabled) || data.saving || !actionable} note={data.workspaceNote} machine={data.machine} />
        <button className={`project-group-action ${data.pinned ? 'pinned' : ''}`} aria-label={t("{0} 그룹 {1}", { 0: data.name, 1: data.pinned ? t("고정 해제") : t("고정") })} aria-pressed={data.pinned} title={data.pinned ? t("그룹 고정 해제") : t("세션이 없어도 그룹 유지")} disabled={viewDisabled} onClick={() => { void data.onUpdate({ cwd: data.path, pinned: !data.pinned }); }}>{data.saving && !editing ? <LoaderCircle size={14} className="spin" /> : <Pin size={14} />}</button>
        <button className={`project-group-action ${data.hidden ? 'is-hidden' : ''}`} aria-label={data.hidden ? t("{0} 폴더 숨김 해제", { 0: data.name }) : t("{0} 폴더 숨기기", { 0: data.name })} aria-pressed={data.hidden} title={data.hidden ? t("폴더 숨김 해제") : t("폴더와 세션을 캔버스에서 숨기기")} disabled={viewDisabled} onClick={() => { void data.onUpdate({ cwd: data.path, hidden: !data.hidden }); }}>{data.hidden ? <EyeOff size={15} /> : <Eye size={15} />}</button>
        <button className="project-group-action" aria-label={t("{0} 폴더에 새 세션", { 0: data.name })} title={t("이 폴더에 새 세션")} disabled={data.disabled || !actionable} onClick={() => data.onCreate(data.path)}><Plus size={17} /></button>
      </div>{data.manual && <Grip size={12} className="project-drag-grip" aria-hidden="true" />}</div>
      {data.error && !editing && <p className="project-group-error nodrag nopan" role="alert">{translateMessage(data.error)}</p>}
    </div>
    {editing && <GroupTitleDialog data={data} onClose={() => setEditing(false)} />}
  </>;
}
