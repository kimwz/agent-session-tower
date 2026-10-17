import { useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { Archive, CalendarDays, CalendarRange, ChevronDown, ChevronRight, Hash, Heart, Inbox, MoreHorizontal, Palette, Pencil, Plus, Search, Tag, Trash2 } from 'lucide-react';
import type { TodoLabel, TodoProject } from '../../../shared/todo/types';
import { translate as t } from '../i18n/i18n';
import { Menu, Popover, type MenuItem } from './Popover';
import { colorOf, TODO_COLORS } from './todo-format';
import type { TodoWorld } from './todo-model';
import { newId, type TodoClient } from './todo-store';
import { projectTree, type ProjectNode, type SidebarCounts } from './todo-views';
import { viewKey, type TodoView } from './todo-url';

/**
 * The Todo page's navigation: add and search, the inbox and date lists with their counts, favorites, the project tree
 * and labels. Projects and labels are made, renamed, colored and removed from their rows.
 */

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

function Row({ active, icon, label, count, tone, onClick, menu, depth = 0, toggle }: { active: boolean; icon: ReactNode; label: string; count?: number; tone?: string; onClick: () => void; menu?: (anchor: HTMLButtonElement) => void; depth?: number; toggle?: ReactNode }) {
  const more = useRef<HTMLButtonElement>(null);
  return <li className={`todo-side-row ${active ? 'active' : ''}`} style={{ paddingLeft: 8 + depth * 14 }}>
    {toggle}
    <button type="button" className="todo-side-link" aria-current={active ? 'page' : undefined} onClick={onClick}>{icon}<span>{label}</span></button>
    {count ? <span className={`todo-side-count ${tone ?? ''}`}>{count}</span> : null}
    {menu && <button ref={more} type="button" className="icon-button todo-side-more" aria-label={t('“{0}” 메뉴', { 0: label })} onClick={() => more.current && menu(more.current)}><MoreHorizontal size={14} /></button>}
  </li>;
}

export function TodoSidebar({ world, counts, view, query, client, readOnly, searchRef, onNavigate, onAdd }: SidebarProps) {
  const [editing, setEditing] = useState<Editing>(null);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; items: (MenuItem | 'separator')[]; label: string } | null>(null);
  const [color, setColor] = useState<{ anchor: HTMLElement; value: string; pick: (color: string) => void } | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [search, setSearch] = useState(query);
  const menuAnchor = useRef<HTMLElement | null>(null);
  const colorAnchor = useRef<HTMLElement | null>(null);
  const current = viewKey(view);
  const tree = projectTree(world);
  const favorites = [...world.projects.filter(project => project.favorite && !project.archivedAt), ...world.labels.filter(label => label.favorite)];
  const inbox = world.projects.find(project => project.inbox);
  const fold = (key: string) => setFolded(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const openMenu = (anchor: HTMLElement, label: string, items: (MenuItem | 'separator')[]) => { menuAnchor.current = anchor; setMenu({ anchor, items, label }); };
  const removed = (name: string) => client.toast(t('“{0}” 삭제', { 0: name }), 'info', [{ label: t('되돌리기'), run: () => client.undo() }]);

  const projectMenu = (project: TodoProject, anchor: HTMLElement, depth: number) => openMenu(anchor, project.name, [
    { key: 'rename', label: t('이름 바꾸기'), icon: <Pencil size={13} />, run: () => setEditing({ kind: 'project', id: project.id }) },
    ...(depth < 2 ? [{ key: 'child', label: t('하위 프로젝트 추가'), icon: <Plus size={13} />, run: () => setEditing({ kind: 'new-project', parentId: project.id }) }] : []),
    { key: 'favorite', label: project.favorite ? t('즐겨찾기에서 빼기') : t('즐겨찾기에 추가'), icon: <Heart size={13} />, run: () => client.apply([{ op: 'project.update', id: project.id, patch: { favorite: !project.favorite } }]) },
    { key: 'color', label: t('색 바꾸기'), icon: <Palette size={13} />, run: () => { colorAnchor.current = anchor; setColor({ anchor, value: project.color, pick: value => client.apply([{ op: 'project.update', id: project.id, patch: { color: value } }]) }); } },
    'separator',
    { key: 'archive', label: t('보관'), icon: <Archive size={13} />, run: () => { if (client.apply([{ op: 'project.update', id: project.id, patch: { archived: true } }])) client.toast(t('“{0}” 보관', { 0: project.name }), 'info', [{ label: t('되돌리기'), run: () => client.undo() }]); } },
    { key: 'delete', label: t('삭제'), danger: true, icon: <Trash2 size={13} />, run: () => { if (client.apply([{ op: 'project.delete', id: project.id }])) { removed(project.name); if (current === `p:${project.id}`) onNavigate({ kind: 'today' }); } } },
  ]);
  const labelMenu = (label: TodoLabel, anchor: HTMLElement) => openMenu(anchor, label.name, [
    { key: 'rename', label: t('이름 바꾸기'), icon: <Pencil size={13} />, run: () => setEditing({ kind: 'label', id: label.id }) },
    { key: 'favorite', label: label.favorite ? t('즐겨찾기에서 빼기') : t('즐겨찾기에 추가'), icon: <Heart size={13} />, run: () => client.apply([{ op: 'label.update', id: label.id, patch: { favorite: !label.favorite } }]) },
    { key: 'color', label: t('색 바꾸기'), icon: <Palette size={13} />, run: () => { colorAnchor.current = anchor; setColor({ anchor, value: label.color, pick: value => client.apply([{ op: 'label.update', id: label.id, patch: { color: value } }]) }); } },
    'separator',
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
    {menu && <Menu anchor={menuAnchor} label={menu.label} items={menu.items} onClose={() => setMenu(null)} />}
    {color && <ColorGrid anchor={colorAnchor} value={color.value} onPick={color.pick} onClose={() => setColor(null)} />}
  </nav>;
}
