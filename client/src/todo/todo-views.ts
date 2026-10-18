import type { Direction } from './todo-shortcuts';
import { liveProjectIds } from '../../../shared/todo/compose';
import { addDays } from '../../../shared/todo/dates';
import { compareDay } from '../../../shared/todo/day-order';
import type { TodoOp } from '../../../shared/todo/ops';
import type { TodoPriority, TodoProject, TodoSection, TodoTask } from '../../../shared/todo/types';
import { translate as t } from '../i18n/i18n';
import { byOrder, isOpen, type TodoWorld } from './todo-model';
import { dateLabel, longDate, priorityName } from './todo-format';
import { viewKey, type TodoView } from './todo-url';

/**
 * What a list shows: its title, and its tasks laid out in columns by a grouping. A grouping is one entry of
 * `GROUPINGS`, a pure function from the list's tasks to columns, so a new way to group is one entry here.
 */

export type GroupKey = 'section' | 'date' | 'priority' | 'project';
export type SortKey = 'manual' | 'date' | 'priority' | 'name';

/** What dropping a card on a column changes. */
export type ColumnDrop =
  | { kind: 'section'; projectId: string; sectionId: string | null }
  | { kind: 'date'; date: string | null }
  | { kind: 'priority'; priority: TodoPriority }
  | { kind: 'project'; projectId: string };

export interface BoardColumn {
  id: string;
  title: string;
  /** A second line under the title, such as the date of `오늘`. */
  note?: string;
  tone?: 'overdue' | 'today';
  tasks: TodoTask[];
  /** null: cards cannot be dropped here (overdue). */
  drop: ColumnDrop | null;
  /** A section column, whose header can be dragged and renamed. */
  sectionId?: string;
  /** Read only: an archived project's or section's tasks, shown but never moved, completed or changed here. */
  locked?: boolean;
  /** A collapsed section: its header and count only; a card still drops on it. */
  collapsed?: boolean;
  /** How many tasks it holds when they are not shown (collapsed). */
  count?: number;
  /** How many of its first tasks show, the rest behind "더 보기" (the overview's columns); all when absent. */
  shown?: number;
  /** What a task added in this column starts with. */
  preset: { projectId?: string; sectionId?: string | null; dueDate?: string; priority?: TodoPriority };
}

export interface DisplaySettings {
  group: GroupKey;
  sort: SortKey;
  completed: boolean;
  /** Calendar: month or week, later occurrences of repeating tasks, and coloring by priority or project. */
  calendar: 'month' | 'week';
  future: boolean;
  colorBy: 'priority' | 'project';
}

export interface ViewContext {
  world: TodoWorld;
  today: string;
  /** Upcoming: the first date shown. */
  start: string;
  query: string;
  searchResults: TodoTask[] | null;
}

export const UPCOMING_DAYS = 14;

/**
 * What a list shows on the calendar: every open task of it, sub-tasks included, since the calendar places tasks by
 * date rather than by where they sit; the date lists show every task.
 */
export function calendarTasks(view: TodoView, context: ViewContext): TodoTask[] {
  const tasks = openTasks(context.world);
  switch (view.kind) {
    case 'inbox': case 'project': { const project = projectOf(context.world, view); return project ? tasks.filter(task => task.projectId === project.id) : []; }
    case 'all': case 'today': case 'upcoming': return tasks;
    case 'label': case 'search': return viewTasks(view, context);
  }
}

/** The groupings a kind of list offers, its default first. */
export function groupingsFor(view: TodoView): GroupKey[] {
  switch (view.kind) {
    case 'project': case 'inbox': return ['section', 'priority', 'date'];
    // Each project in its sections, one after another (`overviewGroups`).
    case 'all': return ['section'];
    case 'today': return ['date', 'priority', 'project'];
    case 'upcoming': return ['date'];
    case 'label': return ['project', 'priority', 'date'];
    case 'search': return ['project', 'priority'];
  }
}
export const defaultDisplay = (view: TodoView): DisplaySettings => ({ group: groupingsFor(view)[0], sort: 'manual', completed: false, calendar: 'month', future: true, colorBy: 'priority' });

export const projectOf = (world: TodoWorld, view: TodoView): TodoProject | undefined =>
  view.kind === 'inbox' ? world.projects.find(project => project.inbox) : view.kind === 'project' ? world.projects.find(project => project.id === view.id) : undefined;

/** Projects shown: not archived, and not inside an archived one. */
const liveProjects = (world: TodoWorld) => liveProjectIds(world.projects);

/** Sections archived: their tasks leave every list, and show read-only only in their project's "archived sections". */
export const archivedSectionIds = (world: Pick<TodoWorld, 'sections'>) => new Set(world.sections.filter(section => section.archivedAt).map(section => section.id));

export function openTasks(world: TodoWorld): TodoTask[] {
  const live = liveProjects(world), shelved = archivedSectionIds(world);
  return Object.values(world.tasks).filter(task => isOpen(task) && live.has(task.projectId) && !(task.sectionId && shelved.has(task.sectionId)));
}

/**
 * The tasks a list holds, before grouping: top-level ones in a project (in every project for the overview), every
 * dated one in date lists.
 */
export function viewTasks(view: TodoView, context: ViewContext): TodoTask[] {
  const { world, today } = context;
  const tasks = openTasks(world);
  switch (view.kind) {
    case 'inbox': case 'project': { const project = projectOf(world, view); return project ? tasks.filter(task => task.projectId === project.id && !task.parentId) : []; }
    case 'all': return tasks.filter(task => !task.parentId);
    case 'today': return tasks.filter(task => task.dueDate !== null && task.dueDate <= today);
    case 'upcoming': return tasks.filter(task => task.dueDate !== null && task.dueDate < addDays(context.start, UPCOMING_DAYS));
    case 'label': return tasks.filter(task => task.labelIds.includes(view.id));
    case 'search': {
      const open = new Set(tasks.map(task => task.id));
      return (context.searchResults ?? []).filter(task => open.has(task.id)).map(task => world.tasks[task.id] ?? task);
    }
  }
}

const SORTS: Record<SortKey, (a: TodoTask, b: TodoTask) => number> = {
  manual: byOrder,
  date: (a, b) => compare(a.dueDate ?? '9999', b.dueDate ?? '9999') || compare(a.dueTime ?? '99', b.dueTime ?? '99') || byOrder(a, b),
  priority: (a, b) => a.priority - b.priority || byOrder(a, b),
  name: (a, b) => a.content.localeCompare(b.content) || byOrder(a, b),
};
/** Outside sections and dates, timed tasks come first by time, then by priority. */
const BY_TIME = (a: TodoTask, b: TodoTask) => compare(a.dueTime ?? '99', b.dueTime ?? '99') || a.priority - b.priority || byOrder(a, b);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Date columns keep the order put by hand within each date (shared/todo/day-order.ts). */
export function sortTasks(tasks: TodoTask[], sort: SortKey, group: GroupKey): TodoTask[] {
  return [...tasks].sort(sort !== 'manual' || group === 'section' ? SORTS[sort] : group === 'date' ? compareDay : BY_TIME);
}

/**
 * Whether cards can be put in order by hand: among siblings in section columns, and among the tasks of one date in
 * date columns.
 */
export const manualOrder = (display: DisplaySettings) => (display.group === 'section' || display.group === 'date') && display.sort === 'manual';

type Grouping = (view: TodoView, tasks: TodoTask[], context: ViewContext) => BoardColumn[];

const PRIORITIES: TodoPriority[] = [1, 2, 3, 4];

export const GROUPINGS: Record<GroupKey, Grouping> = {
  section: (view, tasks, { world }) => {
    const project = projectOf(world, view);
    if (!project) return [];
    const sections = world.sections.filter(section => section.projectId === project.id && !section.archivedAt);
    return [
      // An archived section's tasks are not without one: they show with it, when archived sections are shown.
      { id: 'section:none', title: t('섹션 없음'), tasks: tasks.filter(task => !task.sectionId || !world.sections.some(section => section.id === task.sectionId)), drop: { kind: 'section', projectId: project.id, sectionId: null }, preset: { projectId: project.id, sectionId: null } },
      ...sections.map((section): BoardColumn => ({ id: `section:${section.id}`, title: section.name, sectionId: section.id, tasks: tasks.filter(task => task.sectionId === section.id), drop: { kind: 'section', projectId: project.id, sectionId: section.id }, preset: { projectId: project.id, sectionId: section.id } })),
    ];
  },
  date: (view, tasks, { world, today, start }) => {
    // In a project, a task added under a date stays in the project.
    const project = projectOf(world, view)?.id;
    const preset = (dueDate?: string) => ({ ...(project ? { projectId: project } : {}), ...(dueDate ? { dueDate } : {}) });
    const overdue: BoardColumn = { id: 'date:overdue', title: t('기한 지남'), tone: 'overdue', tasks: tasks.filter(task => task.dueDate !== null && task.dueDate < today), drop: null, preset: preset() };
    if (view.kind === 'upcoming') {
      const days = Array.from({ length: UPCOMING_DAYS }, (_, index) => addDays(start, index));
      return [
        ...(start <= today && overdue.tasks.length ? [overdue] : []),
        ...days.map((date): BoardColumn => ({ id: `date:${date}`, title: longDate(date), note: relativeNote(date, today), tone: date === today ? 'today' : undefined,
          tasks: tasks.filter(task => task.dueDate === date), drop: date < today ? null : { kind: 'date', date }, preset: preset(date) })),
      ];
    }
    // The Today list names the date in its title already.
    const todayColumn: BoardColumn = { id: 'date:today', title: t('오늘'), note: view.kind === 'today' ? undefined : longDate(today), tone: 'today', tasks: tasks.filter(task => task.dueDate === today), drop: { kind: 'date', date: today }, preset: preset(today) };
    if (view.kind === 'today') return [...(overdue.tasks.length ? [overdue] : []), todayColumn];
    const tomorrow = addDays(today, 1), week = addDays(today, 7);
    return [
      ...(overdue.tasks.length ? [overdue] : []), todayColumn,
      { id: 'date:tomorrow', title: t('내일'), note: longDate(tomorrow), tasks: tasks.filter(task => task.dueDate === tomorrow), drop: { kind: 'date', date: tomorrow }, preset: preset(tomorrow) },
      { id: 'date:week', title: t('7일 안'), tasks: tasks.filter(task => task.dueDate !== null && task.dueDate > tomorrow && task.dueDate <= week), drop: null, preset: preset() },
      { id: 'date:later', title: t('나중에'), tasks: tasks.filter(task => task.dueDate !== null && task.dueDate > week), drop: null, preset: preset() },
      { id: 'date:none', title: t('날짜 없음'), tasks: tasks.filter(task => task.dueDate === null), drop: { kind: 'date', date: null }, preset: preset() },
    ];
  },
  priority: (view, tasks, { world, today }) => PRIORITIES.map(priority => ({
    id: `priority:${priority}`, title: priorityName(priority), tasks: tasks.filter(task => task.priority === priority), drop: { kind: 'priority', priority },
    preset: { priority, ...(view.kind === 'today' ? { dueDate: today } : {}), ...(projectOf(world, view) ? { projectId: projectOf(world, view)!.id } : {}) },
  })),
  project: (view, tasks, { world, today }) => projectOrder(world)
    .filter(project => tasks.some(task => task.projectId === project.id))
    .map(project => ({
      id: `project:${project.id}`, title: project.inbox ? t('관리함') : project.name, tasks: tasks.filter(task => task.projectId === project.id), drop: { kind: 'project', projectId: project.id },
      preset: { projectId: project.id, ...(view.kind === 'today' ? { dueDate: today } : {}) },
    })),
};

const relativeNote = (date: string, today: string) => { const label = dateLabel(date, today); return label === longDate(date) ? undefined : label; };

export function boardColumns(view: TodoView, display: DisplaySettings, context: ViewContext): BoardColumn[] {
  const group = groupingsFor(view).includes(display.group) ? display.group : groupingsFor(view)[0];
  return GROUPINGS[group](view, viewTasks(view, context), context).map(column => ({ ...column, tasks: sortTasks(column.tasks, display.sort, group) }));
}

/** Where moving a section one place left or right puts it (`afterId`), or undefined at either end. */
export function sectionMoveTarget(sections: readonly { id: string; sortKey: string }[], id: string, direction: 'left' | 'right'): string | null | undefined {
  const list = [...sections].sort(byOrder);
  const index = list.findIndex(item => item.id === id);
  if (index < 0) return undefined;
  if (direction === 'left') return index === 0 ? undefined : index === 1 ? null : list[index - 2].id;
  return index === list.length - 1 ? undefined : list[index + 1].id;
}

/** What `drop` changes for `task`, as operations; empty when nothing changes. */
export function dropOps(task: TodoTask, drop: ColumnDrop, afterId?: string | null): TodoOp[] {
  switch (drop.kind) {
    case 'section':
      if (task.projectId === drop.projectId && task.sectionId === drop.sectionId && afterId === undefined) return [];
      return [{ op: 'task.move', id: task.id, projectId: drop.projectId, sectionId: drop.sectionId, parentId: null, ...(afterId !== undefined ? { afterId } : {}) }];
    // Within its own date, a placed card is put in order among that date's tasks; elsewhere it takes the column's date.
    case 'date':
      if (task.dueDate !== drop.date) return [{ op: 'task.update', id: task.id, patch: { dueDate: drop.date } }];
      return drop.date && afterId !== undefined && afterId !== task.id ? [{ op: 'task.move', id: task.id, dayAfterId: afterId }] : [];
    case 'priority': return task.priority === drop.priority ? [] : [{ op: 'task.update', id: task.id, patch: { priority: drop.priority } }];
    case 'project': return task.projectId === drop.projectId ? [] : [{ op: 'task.move', id: task.id, projectId: drop.projectId, sectionId: null, parentId: null }];
  }
}

export interface SidebarCounts { inbox: number; today: number; overdue: number; projects: Record<string, number>; labels: Record<string, number> }

export function sidebarCounts(world: TodoWorld, today: string): SidebarCounts {
  const counts: SidebarCounts = { inbox: 0, today: 0, overdue: 0, projects: {}, labels: {} };
  const inbox = world.projects.find(project => project.inbox)?.id;
  for (const task of openTasks(world)) {
    if (!task.parentId) {
      counts.projects[task.projectId] = (counts.projects[task.projectId] ?? 0) + 1;
      if (task.projectId === inbox) counts.inbox++;
    }
    if (task.dueDate !== null && task.dueDate <= today) { counts.today++; if (task.dueDate < today) counts.overdue++; }
    for (const label of task.labelIds) counts.labels[label] = (counts.labels[label] ?? 0) + 1;
  }
  return counts;
}

export interface ProjectNode { project: TodoProject; depth: number; children: ProjectNode[] }

/** The project tree below the inbox, archived ones left out. */
export function projectTree(world: TodoWorld): ProjectNode[] {
  const live = liveProjects(world);
  const list = world.projects.filter(project => !project.inbox && live.has(project.id));
  const build = (parentId: string | null, depth: number): ProjectNode[] => list.filter(project => project.parentId === parentId && depth < 4).sort(byOrder)
    .map(project => ({ project, depth, children: build(project.id, depth + 1) }));
  return build(null, 0);
}

/** Every project as the sidebar lists it: the inbox, then the tree depth first. */
export function projectOrder(world: TodoWorld): TodoProject[] {
  const walk = (nodes: ProjectNode[]): TodoProject[] => nodes.flatMap(node => [node.project, ...walk(node.children)]);
  return [...world.projects.filter(project => project.inbox), ...walk(projectTree(world))];
}

/** The lists `V` offers, numbered from 0: everything, the Inbox, Today, Upcoming, then the first six projects as the sidebar lists them. */
export function switchTargets(world: TodoWorld): TodoView[] {
  const projects = projectOrder(world).filter(project => !project.inbox).slice(0, 6);
  return [{ kind: 'all' }, { kind: 'inbox' }, { kind: 'today' }, { kind: 'upcoming' }, ...projects.map((project): TodoView => ({ kind: 'project', id: project.id }))];
}

/** Where `view` is in `switchTargets`, the Inbox opened as its project (`p:<inbox>`) included; -1 when it is not there. */
export function switchIndex(world: TodoWorld, view: TodoView): number {
  const key = projectOf(world, view)?.inbox ? 'inbox' : viewKey(view);
  return switchTargets(world).findIndex(target => viewKey(target) === key);
}

/** The view's title. */
export function viewTitle(view: TodoView, world: TodoWorld, query: string): string {
  switch (view.kind) {
    case 'all': return t('전체');
    case 'today': return t('오늘');
    case 'upcoming': return t('다가오는');
    case 'inbox': return t('관리함');
    case 'project': return world.projects.find(project => project.id === view.id)?.name ?? t('프로젝트');
    case 'label': return `@${world.labels.find(label => label.id === view.id)?.name ?? ''}`;
    case 'search': return query ? t('“{0}” 검색', { 0: query }) : t('검색');
  }
}

/** What cards read besides their task, indexed once per render: sub-tasks, and open tasks that follow (`→ 다음 n`). */
export interface CardContext {
  world: TodoWorld;
  today: string;
  showProject: boolean;
  children: ReadonlyMap<string, TodoTask[]>;
  next: ReadonlyMap<string, number>;
  /** Tasks that have a card of their own here: a sub-task among them is not listed again under its parent. */
  shown?: ReadonlySet<string>;
}

export function cardContext(world: TodoWorld, today: string, showProject: boolean, shown?: ReadonlySet<string>): CardContext {
  const children = new Map<string, TodoTask[]>();
  for (const task of Object.values(world.tasks)) {
    if (!task.parentId || task.deletedAt) continue;
    const list = children.get(task.parentId);
    if (list) list.push(task); else children.set(task.parentId, [task]);
  }
  for (const list of children.values()) list.sort(byOrder);
  const next = new Map<string, number>();
  for (const link of Object.values(world.links)) if (isOpen(world.tasks[link.toTaskId]) && !world.tasks[link.fromTaskId]?.deletedAt) next.set(link.fromTaskId, (next.get(link.fromTaskId) ?? 0) + 1);
  return { world, today, showProject, children, next, ...(shown ? { shown } : {}) };
}

/**
 * The card an arrow key goes to on the board: up and down within a column, left and right to the next column that has
 * cards (the same place, or its last card). Without a chosen card (or one no longer shown), the first card there is.
 */
export function moveSelection(columns: readonly Pick<BoardColumn, 'tasks'>[], from: string | null, direction: Direction): string | null {
  const filled = columns.map(column => column.tasks.map(task => task.id)).filter(ids => ids.length);
  if (!filled.length) return null;
  const column = from ? filled.findIndex(ids => ids.includes(from)) : -1;
  if (column < 0) return filled[0][0];
  const ids = filled[column], row = ids.indexOf(from!);
  if (direction === 'up') return ids[Math.max(0, row - 1)];
  if (direction === 'down') return ids[Math.min(ids.length - 1, row + 1)];
  const next = filled[column + (direction === 'left' ? -1 : 1)];
  return next ? next[Math.min(row, next.length - 1)] : from;
}

export function archivedColumns(view: TodoView, display: DisplaySettings, context: ViewContext, projectId: string): BoardColumn[] {
  const group = groupingsFor(view).includes(display.group) ? display.group : groupingsFor(view)[0];
  const tasks = Object.values(context.world.tasks).filter(task => isOpen(task) && task.projectId === projectId && !task.parentId);
  return GROUPINGS[group](view, tasks, context).map(column => ({ ...column, drop: null, sectionId: undefined, locked: true, tasks: sortTasks(column.tasks, display.sort, group) }));
}

/**
 * A project's section columns as its sections say: a collapsed one shows its header and count only (a card still
 * drops on it), and an archived one leaves the board with its tasks, to show read-only after the others when asked.
 */
export function shapeSections(columns: readonly BoardColumn[], sections: readonly TodoSection[], options: { collapse: boolean; showArchived: boolean; tasks?: readonly TodoTask[] }): { columns: BoardColumn[]; archived: number } {
  const archived = sections.filter(section => section.archivedAt).sort((a, b) => a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0);
  const archivedIds = new Set(archived.map(section => section.id));
  const byId = new Map(sections.map(section => [section.id, section]));
  // The archived sections' open top-level tasks (no list holds them, see openTasks).
  const stored = (options.tasks ?? []).filter(task => isOpen(task) && !task.parentId && task.sectionId && archivedIds.has(task.sectionId)).sort(byOrder);
  const shaped = columns.map(column => {
    if (column.id === 'section:none' && archivedIds.size) return { ...column, tasks: column.tasks.filter(task => !task.sectionId || !archivedIds.has(task.sectionId)) };
    const section = column.sectionId ? byId.get(column.sectionId) : undefined;
    if (options.collapse && section?.collapsed) return { ...column, tasks: [], collapsed: true, count: column.tasks.length, note: t('접힘 · {0}', { 0: column.tasks.length }) };
    return column;
  });
  if (options.showArchived) for (const section of archived) shaped.push({
    id: `section:${section.id}`, title: section.name, note: t('보관됨'), sectionId: section.id, drop: null, locked: true, preset: {}, tasks: stored.filter(task => task.sectionId === section.id),
  });
  return { columns: shaped, archived: archived.length };
}

/** How many cards each of the overview's columns shows before "더 보기". */
export const OVERVIEW_SHOWN = 3;

/**
 * One project on the overview: its header (with the names of the projects above it) and its section columns, as its
 * own board makes them, and how many open top-level tasks it has.
 */
export interface BoardGroup { project: TodoProject; depth: number; parents: string[]; columns: BoardColumn[]; count: number }

/**
 * The overview (`all`): the Inbox, then every project shown in the sidebar's order, sub-projects each on their own
 * (a project's board leaves out its sub-projects' tasks), each with the section columns its own board shows. A column's
 * id names its project, since every project has its own "섹션 없음".
 */
export function overviewGroups(display: DisplaySettings, context: ViewContext): BoardGroup[] {
  const { world } = context;
  type Place = { project: TodoProject; depth: number; parents: string[] };
  const walk = (nodes: ProjectNode[], parents: string[]): Place[] => nodes.flatMap(node => [{ project: node.project, depth: node.depth, parents }, ...walk(node.children, [...parents, node.project.name])]);
  const inbox = world.projects.filter(project => project.inbox).map(project => ({ project, depth: 0, parents: [] }));
  return [...inbox, ...walk(projectTree(world), [])].map(({ project, depth, parents }) => {
    const columns = boardColumns({ kind: 'project', id: project.id }, { ...display, group: 'section' }, context);
    const shaped = shapeSections(columns, world.sections.filter(section => section.projectId === project.id), { collapse: true, showArchived: false }).columns;
    return { project, depth, parents, count: columns.reduce((sum, column) => sum + column.tasks.length, 0), columns: shaped.map(column => ({ ...column, id: `${project.id}/${column.id}` })) };
  });
}

/** The overview's columns as they show: each its first cards (`OVERVIEW_SHOWN`), but those opened (`expanded`) whole. */
export const foldGroups = (groups: readonly BoardGroup[], expanded: ReadonlySet<string>): BoardGroup[] =>
  groups.map(group => ({ ...group, columns: group.columns.map(column => expanded.has(column.id) ? column : { ...column, shown: OVERVIEW_SHOWN }) }));

/** The tasks of `column` that have a card: those `shown`, or all. */
export const shownTasks = (column: Pick<BoardColumn, 'tasks' | 'shown'>): TodoTask[] => column.shown === undefined ? column.tasks : column.tasks.slice(0, column.shown);

/**
 * Where a card let go on column `target` goes, as `dropOps`' `afterId` (undefined: wherever the server puts it), or
 * null when nothing changes. On a card it takes that card's place. A collapsed column shows no cards, so what is let go
 * on it goes first; so does what is let go on a column's empty space when `emptyFirst` (the overview, whose columns may
 * hide cards after the third), and otherwise last. Without an order kept by hand, only another column changes anything,
 * and the card goes where the server puts it but first on a folded column or the overview, as by hand.
 */
export function dropPlace(taskId: string, source: Pick<BoardColumn, 'id' | 'tasks'>, target: Pick<BoardColumn, 'id' | 'tasks' | 'collapsed'>, overId: string | undefined, options: { manual: boolean; emptyFirst: boolean }): { afterId: string | null | undefined } | null {
  if (!options.manual) return target.id === source.id ? null : { afterId: target.collapsed || options.emptyFirst ? null : undefined };
  const list = target.tasks.filter(item => item.id !== taskId);
  const over = overId && !target.collapsed ? target.tasks.findIndex(item => item.id === overId) : -1;
  const index = over >= 0 ? over : target.collapsed || options.emptyFirst ? 0 : list.length;
  if (target.id === source.id && source.tasks.findIndex(item => item.id === taskId) === index) return null;
  return { afterId: index === 0 ? null : list[index - 1]?.id ?? list.at(-1)?.id ?? null };
}

/**
 * Where section `activeId` let go on section `overId` goes (the section before it, null: first), among the list of
 * `lists` that holds it (one project's sections): undefined when it stays, or when `overId` is another project's.
 */
export function sectionDropAfter(lists: readonly (readonly string[])[], activeId: string, overId: string): string | null | undefined {
  const list = lists.find(ids => ids.includes(activeId)) ?? [];
  const from = list.indexOf(activeId), to = list.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return undefined;
  const order = list.filter(id => id !== activeId);
  order.splice(to, 0, activeId);
  const index = order.indexOf(activeId);
  return index > 0 ? order[index - 1] : null;
}

/**
 * Where a card dropped on `overId` goes among its own date's tasks in a column of several dates: the task before it
 * there (null: first), or undefined when it was not dropped among its own date (dropping never changes the date here).
 */
export function dayAfterOf(tasks: readonly TodoTask[], id: string, overId: string): string | null | undefined {
  const from = tasks.findIndex(item => item.id === id), to = tasks.findIndex(item => item.id === overId);
  if (from < 0 || to < 0 || from === to || !tasks[from].dueDate || tasks[to].dueDate !== tasks[from].dueDate) return undefined;
  const order = [...tasks];
  order.splice(to, 0, ...order.splice(from, 1));
  const before = order.slice(0, to).filter(item => item.dueDate === tasks[from].dueDate);
  return before.at(-1)?.id ?? null;
}

/** Read only: a task of an archived project (or one above it) or of an archived section, wherever it shows. */
export function taskLocked(world: Pick<TodoWorld, 'projects' | 'sections'>, task: Pick<TodoTask, 'projectId' | 'sectionId'> | undefined): boolean {
  if (!task) return false;
  return !liveProjectIds(world.projects).has(task.projectId) || (!!task.sectionId && archivedSectionIds(world).has(task.sectionId));
}
