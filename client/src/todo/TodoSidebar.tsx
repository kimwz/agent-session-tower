import { useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, CalendarDays, CalendarRange, ChevronDown, ChevronRight, FolderTree, Github, Hash, Heart, Inbox, Layers, MoreHorizontal, Palette, Pencil, Plus, Search, Tag, Trash2 } from 'lucide-react';
import type { TodoLabel, TodoProject } from '../../../shared/todo/types';
import { translate as t } from '../i18n/i18n';
import { GitHubBindingDialog } from './GitHubBindingDialog';
import { GitHubMark } from './GitHubMark';
import { Menu, Popover, type MenuItem } from './Popover';
import { colorOf, TODO_COLORS } from './todo-format';
import type { TodoWorld } from './todo-model';
import { labelStepOp, parentCandidates, projectStepOp, type Step } from './todo-moves';
import { newId, type TodoClient } from './todo-store';
import { projectTree, type ProjectNode, type SidebarCounts } from './todo-views';
import { viewKey, type TodoView } from './todo-url';

/**
 * The Todo page's navigation: add and search, everything at once, the inbox and date lists with their counts,
 * favorites, the project tree and labels. Projects and labels are made, renamed, colored, put in order and removed from
 * their rows; a project is moved under another from its menu, and an archived one opens to be read.
 */

const STEPS: { step: Step; label: string; icon: ReactNode }[] = [
  { step: 'up', label: '위로 옮기기', icon: <ArrowUp size={13} /> },
  { step: 'down', label: '아래로 옮기기', icon: <ArrowDown size={13} /> },
];

export interface SidebarProps {
  world: TodoWorld;
  counts: SidebarCounts;
  view: TodoView;
  query: string;
  client: TodoClient;
  readOnly: boolean;
  searchRef: RefObject<HTMLInputElement | null>;
  onNavigate: (view: TodoView, query?: string) => void;
  onAdd: () => void;
}

type Editing = { kind: 'project' | 'label'; id: string } | { kind: 'new-project'; parentId: string | null } | { kind: 'new-label' } | null;

function NameInput({ initial, label, onSave, onCancel, pattern }: { initial: string; label: string; onSave: (name: string) => void; onCancel: () => void; pattern?: RegExp }) {
  const [value, setValue] = useState(initial);
  const save = (event?: FormEvent) => { event?.preventDefault(); const name = value.trim(); if (name && name !== initial && (!pattern || pattern.test(name))) onSave(name); else onCancel(); };
  return <form className="todo-side-input" onSubmit={save}>
    <input autoFocus value={value} maxLength={120} aria-label={label} placeholder={label} onChange={event => setValue(event.target.value)} onBlur={() => save()}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onCancel(); } }} />
  </form>;
}

function ColorGrid({ anchor, value, onPick, onClose }: { anchor: RefObject<HTMLElement | null>; value: string; onPick: (color: string) => void; onClose: () => void }) {
  return <Popover anchor={anchor} onClose={onClose} label={t('색')} className="todo-color-popover">
    <div className="todo-color-grid">{Object.entries(TODO_COLORS).map(([name, hex]) => <button key={name} type="button" aria-label={name} aria-pressed={name === value} style={{ background: hex }} onClick={() => { onPick(name); onClose(); }} />)}</div>
  </Popover>;
}

function Row({ active, icon, label, count, tone, onClick, menu, depth = 0, toggle, badge }: { active: boolean; icon: ReactNode; label: string; count?: number; tone?: string; onClick: (anchor: HTMLElement) => void; menu?: (anchor: HTMLButtonElement) => void; depth?: number; toggle?: ReactNode; badge?: ReactNode }) {
  const more = useRef<HTMLButtonElement>(null);
  return <li className={`todo-side-row ${active ? 'active' : ''}`} style={{ paddingLeft: 8 + depth * 14 }}>
    {toggle}
    <button type="button" className="todo-side-link" aria-current={active ? 'page' : undefined} onClick={event => onClick(event.currentTarget)}>{icon}<span>{label}</span>{badge}</button>
    {count ? <span className={`todo-side-count ${tone ?? ''}`}>{count}</span> : null}
    {menu && <button ref={more} type="button" className="icon-button todo-side-more" aria-label={t('“{0}” 메뉴', { 0: label })} onClick={() => more.current && menu(more.current)}><MoreHorizontal size={14} /></button>}
  </li>;
}

/** A project's level in the tree: 1 at the top. */
const depthOf = (projects: readonly TodoProject[], project: TodoProject) => { let n = 1; for (let up = project.parentId; up && n < 5; up = projects.find(item => item.id === up)?.parentId ?? null) n++; return n; };

export function TodoSidebar({ world, counts, view, query, client, readOnly, searchRef, onNavigate, onAdd }: SidebarProps) {
  const [editing, setEditing] = useState<Editing>(null);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; items: (MenuItem | 'separator')[]; label: string } | null>(null);
  const [color, setColor] = useState<{ anchor: HTMLElement; value: string; pick: (color: string) => void } | null>(null);
  // Choosing a new parent opens once the project's menu has closed, at the same place.
  const [parentFor, setParentFor] = useState<TodoProject | null>(null);
  // The GitHub link dialog opens once the project's menu has closed, at the same place.
  const [githubFor, setGithubFor] = useState<TodoProject | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set(['archived']));
  const [search, setSearch] = useState(query);
  const menuAnchor = useRef<HTMLElement | null>(null);
  const colorAnchor = useRef<HTMLElement | null>(null);
  const current = viewKey(view);
  const tree = projectTree(world);
  const archived = world.projects.filter(project => project.archivedAt);
  const favorites = [...world.projects.filter(project => project.favorite && !project.archivedAt), ...world.labels.filter(label => label.favorite)];
  const inbox = world.projects.find(project => project.inbox);
  const fold = (key: string) => setFolded(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const openMenu = (anchor: HTMLElement, label: string, items: (MenuItem | 'separator')[]) => { menuAnchor.current = anchor; setMenu({ anchor, items, label }); };
  const githubOf = (projectId: string) => world.github?.bindings.find(binding => binding.scope.kind === 'project' && binding.scope.id === projectId);
  const removed = (name: string) => client.toast(t('“{0}” 삭제', { 0: name }), 'info', client.undoActions());

  const projectMenu = (project: TodoProject, anchor: HTMLElement, depth: number) => openMenu(anchor, project.name, [
    { key: 'rename', label: t('이름 바꾸기'), icon: <Pencil size={13} />, run: () => setEditing({ kind: 'project', id: project.id }) },
    ...(depth < 2 ? [{ key: 'child', label: t('하위 프로젝트 추가'), icon: <Plus size={13} />, run: () => setEditing({ kind: 'new-project', parentId: project.id }) }] : []),
    { key: 'favorite', label: project.favorite ? t('즐겨찾기에서 빼기') : t('즐겨찾기에 추가'), icon: <Heart size={13} />, run: () => client.apply([{ op: 'project.update', id: project.id, patch: { favorite: !project.favorite } }]) },
    { key: 'color', label: t('색 바꾸기'), icon: <Palette size={13} />, run: () => { colorAnchor.current = anchor; setColor({ anchor, value: project.color, pick: value => client.apply([{ op: 'project.update', id: project.id, patch: { color: value } }]) }); } },
    ...placeItems(project, anchor),
    'separator',
    { key: 'github', label: githubOf(project.id) ? t('GitHub 연결 바꾸기…') : t('GitHub 연결…'), icon: <Github size={13} />, run: () => { menuAnchor.current = anchor; setGithubFor(project); } },
    { key: 'archive', label: t('보관'), icon: <Archive size={13} />, run: () => { if (client.apply([{ op: 'project.update', id: project.id, patch: { archived: true } }])) client.toast(t('“{0}” 보관', { 0: project.name }), 'info', client.undoActions()); } },
    { key: 'delete', label: t('삭제'), danger: true, icon: <Trash2 size={13} />, run: () => { if (client.apply([{ op: 'project.delete', id: project.id }])) { removed(project.name); if (current === `p:${project.id}`) onNavigate({ kind: 'today' }); } } },
  ]);
  // Up, down and under another project, after a line when there is any.
  const placeItems = (project: TodoProject, anchor: HTMLElement): (MenuItem | 'separator')[] => {
    const items: MenuItem[] = STEPS.flatMap(({ step, label, icon }) => { const op = projectStepOp(world.projects, project, step); return op ? [{ key: step, label: t(label), icon, run: () => client.apply([op]) }] : []; });
    if (parentCandidates(world, project.id).length) items.push({ key: 'parent', label: t('상위 프로젝트 바꾸기'), icon: <FolderTree size={13} />, run: () => { menuAnchor.current = anchor; setParentFor(project); } });
    return items.length ? ['separator', ...items] : [];
  };
  const labelMenu = (label: TodoLabel, anchor: HTMLElement) => openMenu(anchor, label.name, [
    { key: 'rename', label: t('이름 바꾸기'), icon: <Pencil size={13} />, run: () => setEditing({ kind: 'label', id: label.id }) },
    { key: 'favorite', label: label.favorite ? t('즐겨찾기에서 빼기') : t('즐겨찾기에 추가'), icon: <Heart size={13} />, run: () => client.apply([{ op: 'label.update', id: label.id, patch: { favorite: !label.favorite } }]) },
    { key: 'color', label: t('색 바꾸기'), icon: <Palette size={13} />, run: () => { colorAnchor.current = anchor; setColor({ anchor, value: label.color, pick: value => client.apply([{ op: 'label.update', id: label.id, patch: { color: value } }]) }); } },
    'separator',
    ...STEPS.flatMap(({ step, label: name, icon }) => { const op = labelStepOp(world.labels, label.id, step); return op ? [{ key: step, label: t(name), icon, run: () => client.apply([op]) }] : []; }),
    ...(world.labels.length > 1 ? ['separator' as const] : []),
    { key: 'delete', label: t('삭제'), danger: true, icon: <Trash2 size={13} />, run: () => { if (client.apply([{ op: 'label.delete', id: label.id }])) { removed(label.name); if (current === `l:${label.id}`) onNavigate({ kind: 'today' }); } } },
  ]);

  const renderProject = (node: ProjectNode): ReactNode => {
    const { project } = node;
    const key = `p:${project.id}`;
    const hidden = folded.has(key);
    return <li key={project.id} className="todo-side-group">
      {editing?.kind === 'project' && editing.id === project.id
        ? <NameInput initial={project.name} label={t('프로젝트 이름')} onCancel={() => setEditing(null)} onSave={name => { client.apply([{ op: 'project.update', id: project.id, patch: { name } }]); setEditing(null); }} />
        : <ul><Row active={current === key} depth={node.depth} icon={<i className="todo-dot" style={{ background: colorOf(project.color) }} />} label={project.name} count={counts.projects[project.id]}
          onClick={() => onNavigate({ kind: 'project', id: project.id })} menu={readOnly ? undefined : anchor => projectMenu(project, anchor, node.depth)}
          badge={githubOf(project.id) && <GitHubMark binding={githubOf(project.id)!} />}
          toggle={node.children.length ? <button type="button" className="todo-side-fold" aria-label={hidden ? t('펼치기') : t('접기')} aria-expanded={!hidden} onClick={() => fold(key)}>{hidden ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</button> : undefined} /></ul>}
      {editing?.kind === 'new-project' && editing.parentId === project.id && <NameInput initial="" label={t('하위 프로젝트 이름')} onCancel={() => setEditing(null)}
        onSave={name => { client.apply([{ op: 'project.create', id: newId(), name, parentId: project.id }]); setEditing(null); }} />}
      {!hidden && node.children.length > 0 && <ul>{node.children.map(renderProject)}</ul>}
    </li>;
  };

  const section = (key: string, title: string, add: (() => void) | undefined, body: ReactNode) => <div className="todo-side-section">
    <div className="todo-side-heading">
      <button type="button" aria-expanded={!folded.has(key)} onClick={() => fold(key)}>{title}{folded.has(key) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</button>
      {add && !readOnly && <button type="button" className="icon-button" aria-label={t('{0} 추가', { 0: title })} onClick={add}><Plus size={14} /></button>}
    </div>
    {!folded.has(key) && body}
  </div>;

  return <nav className="todo-sidebar" aria-label={t('할 일 탐색')}>
    <button type="button" className="todo-side-add" onClick={onAdd} disabled={readOnly} title={`${t('작업 추가')} (Q)`}><Plus size={15} />{t('작업 추가')}<kbd>Q</kbd></button>
    <form className="search-wrap todo-side-search" role="search" onSubmit={event => { event.preventDefault(); if (search.trim()) onNavigate({ kind: 'search' }, search.trim()); }}>
      <Search size={14} /><input ref={searchRef} type="search" value={search} placeholder={t('검색')} aria-label={t('작업 검색')} maxLength={200} onChange={event => setSearch(event.target.value)} /><kbd>/</kbd>
    </form>
    <ul className="todo-side-nav">
      <Row active={current === 'all'} icon={<Layers size={15} />} label={t('전체')} onClick={() => onNavigate({ kind: 'all' })} />
      <Row active={current === 'inbox' || (!!inbox && current === `p:${inbox.id}`)} icon={<Inbox size={15} />} label={t('관리함')} count={counts.inbox} onClick={() => onNavigate({ kind: 'inbox' })} />
      <Row active={current === 'today'} icon={<CalendarDays size={15} />} label={t('오늘')} count={counts.today} tone={counts.overdue ? 'overdue' : undefined} onClick={() => onNavigate({ kind: 'today' })} />
      <Row active={current === 'upcoming'} icon={<CalendarRange size={15} />} label={t('다가오는')} onClick={() => onNavigate({ kind: 'upcoming' })} />
    </ul>
    {favorites.length > 0 && section('favorites', t('즐겨찾기'), undefined, <ul>{favorites.map(item => 'inbox' in item
      ? <Row key={item.id} active={current === `p:${item.id}`} icon={<i className="todo-dot" style={{ background: colorOf(item.color) }} />} label={item.name} count={counts.projects[item.id]} onClick={() => onNavigate({ kind: 'project', id: item.id })} />
      : <Row key={item.id} active={current === `l:${item.id}`} icon={<Tag size={14} style={{ color: colorOf(item.color) }} />} label={item.name} count={counts.labels[item.id]} onClick={() => onNavigate({ kind: 'label', id: item.id })} />)}</ul>)}
    {section('projects', t('내 프로젝트'), () => setEditing({ kind: 'new-project', parentId: null }), <>
      <ul>{tree.map(renderProject)}</ul>
      {editing?.kind === 'new-project' && editing.parentId === null && <NameInput initial="" label={t('프로젝트 이름')} onCancel={() => setEditing(null)}
        onSave={name => { const id = newId(); if (client.apply([{ op: 'project.create', id, name }])) onNavigate({ kind: 'project', id }); setEditing(null); }} />}
      {!tree.length && editing?.kind !== 'new-project' && <p className="todo-side-empty"><Hash size={12} />{t('프로젝트가 없습니다')}</p>}
    </>)}
    {section('labels', t('라벨'), () => setEditing({ kind: 'new-label' }), <>
      <ul>{world.labels.map(label => editing?.kind === 'label' && editing.id === label.id
        ? <li key={label.id}><NameInput initial={label.name} label={t('라벨 이름')} pattern={/^[^\s#@%/]{1,60}$/} onCancel={() => setEditing(null)} onSave={name => { client.apply([{ op: 'label.update', id: label.id, patch: { name } }]); setEditing(null); }} /></li>
        : <Row key={label.id} active={current === `l:${label.id}`} icon={<Tag size={14} style={{ color: colorOf(label.color) }} />} label={label.name} count={counts.labels[label.id]}
          onClick={() => onNavigate({ kind: 'label', id: label.id })} menu={readOnly ? undefined : anchor => labelMenu(label, anchor)} />)}</ul>
      {editing?.kind === 'new-label' && <NameInput initial="" label={t('라벨 이름 (띄어쓰기 없이)')} pattern={/^[^\s#@%/]{1,60}$/} onCancel={() => setEditing(null)}
        onSave={name => { client.apply([{ op: 'label.create', id: newId(), name }]); setEditing(null); }} />}
      {!world.labels.length && editing?.kind !== 'new-label' && <p className="todo-side-empty"><Tag size={12} />{t('라벨이 없습니다')}</p>}
    </>)}
    {archived.length > 0 && section('archived', t('보관된 프로젝트'), undefined, <ul>{archived.map(project => {
      const open = (anchor: HTMLElement) => openMenu(anchor, project.name, [
        { key: 'unarchive', label: t('보관 해제'), icon: <ArchiveRestore size={13} />, disabled: readOnly, run: () => { if (client.apply([{ op: 'project.update', id: project.id, patch: { archived: false } }])) onNavigate({ kind: 'project', id: project.id }); } },
        { key: 'delete', label: t('삭제'), danger: true, icon: <Trash2 size={13} />, disabled: readOnly, run: () => { if (client.apply([{ op: 'project.delete', id: project.id }])) removed(project.name); } },
      ]);
      // Opening it shows its tasks to read; its menu brings it back or deletes it.
      return <Row key={project.id} active={current === `p:${project.id}`} icon={<Archive size={14} />} label={project.name} onClick={() => onNavigate({ kind: 'project', id: project.id })} menu={open} />;
    })}</ul>)}
    {menu && <Menu anchor={menuAnchor} label={menu.label} items={menu.items} onClose={() => setMenu(null)} />}
    {githubFor && !menu && <GitHubBindingDialog anchor={menuAnchor} client={client} scope={{ kind: 'project', id: githubFor.id }} name={githubFor.name} binding={githubOf(githubFor.id)} onClose={() => setGithubFor(null)} />}
    {parentFor && !menu && <Menu anchor={menuAnchor} label={t('상위 프로젝트 바꾸기')} onClose={() => setParentFor(null)} items={parentCandidates(world, parentFor.id).map(parent => parent
      ? { key: parent.id, label: <span style={{ paddingLeft: (depthOf(world.projects, parent) - 1) * 12 }}>{parent.name}</span>, icon: <i className="todo-dot" style={{ background: colorOf(parent.color) }} />, run: () => client.apply([{ op: 'project.move', id: parentFor.id, parentId: parent.id }]) }
      : { key: 'top', label: t('없음 (최상위)'), icon: <Hash size={13} />, run: () => client.apply([{ op: 'project.move', id: parentFor.id, parentId: null }]) })} />}
    {color && <ColorGrid anchor={colorAnchor} value={color.value} onPick={color.pick} onClose={() => setColor(null)} />}
  </nav>;
}
