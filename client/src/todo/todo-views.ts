import { addDays } from '../../../shared/todo/dates';
import type { TodoOp } from '../../../shared/todo/ops';
import type { TodoPriority, TodoProject, TodoTask } from '../../../shared/todo/types';
import { translate as t } from '../i18n/i18n';
import { byOrder, isOpen, type TodoWorld } from './todo-model';
import { dateLabel, longDate, priorityName } from './todo-format';
import type { TodoView } from './todo-url';

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
    case 'today': case 'upcoming': return tasks;
    case 'label': case 'search': return viewTasks(view, context);
  }
}

/** The groupings a kind of list offers, its default first. */
export function groupingsFor(view: TodoView): GroupKey[] {
  switch (view.kind) {
    case 'project': case 'inbox': return ['section', 'priority', 'date'];
    case 'today': return ['date', 'priority', 'project'];
    case 'upcoming': return ['date'];
    case 'label': case 'search': return ['project', 'priority'];
  }
}
export const defaultDisplay = (view: TodoView): DisplaySettings => ({ group: groupingsFor(view)[0], sort: 'manual', completed: false, calendar: 'month', future: true, colorBy: 'priority' });

export const projectOf = (world: TodoWorld, view: TodoView): TodoProject | undefined =>
  view.kind === 'inbox' ? world.projects.find(project => project.inbox) : view.kind === 'project' ? world.projects.find(project => project.id === view.id) : undefined;

/** Projects shown: not archived, and not inside an archived one. */
function liveProjects(world: TodoWorld): Set<string> {
  const byId = new Map(world.projects.map(project => [project.id, project]));
  const live = new Set<string>();
  for (const project of world.projects) {
    let current: TodoProject | undefined = project, ok = true;
    for (let depth = 0; current && depth < 5; depth++) { if (current.archivedAt) { ok = false; break; } current = current.parentId ? byId.get(current.parentId) : undefined; }
    if (ok) live.add(project.id);
  }
  return live;
}

export function openTasks(world: TodoWorld): TodoTask[] {
  const live = liveProjects(world);
  return Object.values(world.tasks).filter(task => isOpen(task) && live.has(task.projectId));
}

/** The tasks a list holds, before grouping: top-level ones in a project, every dated one in date lists. */
export function viewTasks(view: TodoView, context: ViewContext): TodoTask[] {
  const { world, today } = context;
  const tasks = openTasks(world);
  switch (view.kind) {
    case 'inbox': case 'project': { const project = projectOf(world, view); return project ? tasks.filter(task => task.projectId === project.id && !task.parentId) : []; }
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
/** Within a day, timed tasks come first by time, then by priority. */
const DAY_ORDER = (a: TodoTask, b: TodoTask) => compare(a.dueTime ?? '99', b.dueTime ?? '99') || a.priority - b.priority || byOrder(a, b);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function sortTasks(tasks: TodoTask[], sort: SortKey, group: GroupKey): TodoTask[] {
  return [...tasks].sort(sort === 'manual' && group !== 'section' ? DAY_ORDER : SORTS[sort]);
}

/** Whether cards can be put in order by hand: only among siblings, in their own order. */
export const manualOrder = (display: DisplaySettings) => display.group === 'section' && display.sort === 'manual';

type Grouping = (view: TodoView, tasks: TodoTask[], context: ViewContext) => BoardColumn[];

const PRIORITIES: TodoPriority[] = [1, 2, 3, 4];

export const GROUPINGS: Record<GroupKey, Grouping> = {
  section: (view, tasks, { world }) => {
    const project = projectOf(world, view);
    if (!project) return [];
    const sections = world.sections.filter(section => section.projectId === project.id && !section.archivedAt);
    return [
      { id: 'section:none', title: t('섹션 없음'), tasks: tasks.filter(task => !task.sectionId || !sections.some(section => section.id === task.sectionId)), drop: { kind: 'section', projectId: project.id, sectionId: null }, preset: { projectId: project.id, sectionId: null } },
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
    case 'date': return task.dueDate === drop.date ? [] : [{ op: 'task.update', id: task.id, patch: { dueDate: drop.date } }];
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

/** The view's title. */
export function viewTitle(view: TodoView, world: TodoWorld, query: string): string {
  switch (view.kind) {
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
}

export function cardContext(world: TodoWorld, today: string, showProject: boolean): CardContext {
  const children = new Map<string, TodoTask[]>();
  for (const task of Object.values(world.tasks)) {
    if (!task.parentId || task.deletedAt) continue;
    const list = children.get(task.parentId);
    if (list) list.push(task); else children.set(task.parentId, [task]);
  }
  for (const list of children.values()) list.sort(byOrder);
  const next = new Map<string, number>();
  for (const link of Object.values(world.links)) if (isOpen(world.tasks[link.toTaskId]) && !world.tasks[link.fromTaskId]?.deletedAt) next.set(link.fromTaskId, (next.get(link.fromTaskId) ?? 0) + 1);
  return { world, today, showProject, children, next };
}
