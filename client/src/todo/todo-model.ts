import { dayBefore, reorderDay } from '../../../shared/todo/day-order';
import { nextOccurrence } from '../../../shared/todo/recurrence';
import { keyBetween } from '../../../shared/todo/sort-key';
import type { TodoOp, TodoOpOf } from '../../../shared/todo/ops';
import type { TodoAgent, TodoAvailability, TodoChanges, TodoComment, TodoFile, TodoLabel, TodoLink, TodoOverview, TodoProject, TodoRestoreProgress, TodoSection, TodoSubtaskCount, TodoTask, TodoTaskDetail } from '../../../shared/todo/types';

/**
 * What the Todo page knows: the open overview, every task it has seen (completed and deleted ones too, so undoing a
 * change can show them again), and the task whose detail is open. The server's answers are the truth; `applyOps`
 * shows a change before the answer arrives with the same rules the server keeps, and the answer replaces it.
 */
export interface TodoWorld {
  availability: TodoAvailability;
  revision: number;
  projects: TodoProject[];
  sections: TodoSection[];
  labels: TodoLabel[];
  tasks: Record<string, TodoTask>;
  links: Record<string, TodoLink>;
  commentCounts: Record<string, number>;
  /** Attachments per open task. */
  fileCounts: Record<string, number>;
  /** The newest comment the owner did not write, per open task (`TodoOverview.outside`). */
  outside: Record<string, string>;
  /** Sub-tasks per task that has any, completed ones counted apart: the overview's, then each answer's. */
  subtaskCounts: Record<string, TodoSubtaskCount>;
  /** Issue masters of todos, by todo id: those not `closed` (`TodoOverview.agents`). */
  agents: Record<string, TodoAgent>;
  /** Bringing back a restored backup's attachments. */
  restore?: TodoRestoreProgress;
  /** The empty issue chat's buttons the owner saved; absent shows the defaults (`TodoOverview.chatPresets`). */
  chatPresets?: string[];
  /** GitHub links and open todos' issues (`TodoOverview.github`). */
  github?: TodoOverview['github'];
  detail: TodoTaskDetail | null;
}

export const emptyWorld = (): TodoWorld => ({
  availability: { state: 'ready' }, revision: 0, projects: [], sections: [], labels: [], tasks: {}, links: {}, commentCounts: {}, fileCounts: {}, outside: {}, subtaskCounts: {}, agents: {}, detail: null,
});

export const isOpen = (task: TodoTask | undefined): boolean => !!task && !task.completedAt && !task.deletedAt;
export const byOrder = <T extends { sortKey: string; id: string }>(a: T, b: T) => a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
export const inboxOf = (world: Pick<TodoWorld, 'projects'>) => world.projects.find(project => project.inbox);

/**
 * A new overview replaces what it covers; completed and deleted tasks the page saw stay known, and the completed
 * sub-tasks of open tasks come with it (the cards show them among the open ones). Those are all of them: one the page
 * saw completed under an open task that is no longer among them was deleted or moved elsewhere (by another page).
 */
export function worldFromOverview(overview: TodoOverview, previous?: TodoWorld): TodoWorld {
  const tasks: Record<string, TodoTask> = {};
  // A completed sub-task of an open task is left out here; the overview's own list puts back those still there.
  const open = overview.doneSubtasks && new Set(overview.tasks.map(task => task.id));
  const gone = (task: TodoTask) => !!open && !task.deletedAt && !!task.parentId && open.has(task.parentId);
  for (const task of Object.values(previous?.tasks ?? {})) if (!isOpen(task) && !gone(task)) tasks[task.id] = task;
  for (const task of [...overview.tasks, ...(overview.doneSubtasks ?? [])]) tasks[task.id] = task;
  return {
    availability: overview.availability, revision: overview.revision,
    projects: [...overview.projects].sort(byOrder), sections: [...overview.sections].sort(byOrder), labels: [...overview.labels].sort(byOrder),
    tasks, links: Object.fromEntries(overview.links.map(link => [link.id, link])), commentCounts: { ...overview.commentCounts },
    fileCounts: { ...(overview.fileCounts ?? {}) }, outside: { ...(overview.outside ?? {}) }, subtaskCounts: { ...(overview.subtaskCounts ?? {}) }, agents: { ...(overview.agents ?? {}) }, ...(overview.restore ? { restore: overview.restore } : {}),
    ...(overview.chatPresets ? { chatPresets: [...overview.chatPresets] } : {}),
    ...(overview.github ? { github: overview.github } : {}),
    detail: previous?.detail ? syncDetail(previous.detail, tasks) : null,
  };
}

function upsert<T extends { id: string; sortKey: string; deletedAt: string | null }>(list: T[], items: T[]): T[] {
  if (!items.length) return list;
  const map = new Map(list.map(item => [item.id, item]));
  for (const item of items) if (item.deletedAt) map.delete(item.id); else map.set(item.id, item);
  return [...map.values()].sort(byOrder);
}

/** The detail's tasks follow the newest known versions of them. */
function syncDetail(detail: TodoTaskDetail, tasks: Record<string, TodoTask>): TodoTaskDetail {
  const latest = (task: TodoTask) => tasks[task.id] ?? task;
  const below = new Set([detail.task.id]);
  const subtasks: TodoTask[] = [];
  // Every task below it, including ones made or moved there since the detail was read.
  const all = new Map(detail.subtasks.map(task => [task.id, latest(task)]));
  for (const task of Object.values(tasks)) if (task.parentId && !all.has(task.id)) all.set(task.id, task);
  let added = true;
  const placed = new Set<string>();
  while (added) {
    added = false;
    for (const task of [...all.values()].sort(byOrder)) {
      if (placed.has(task.id) || !task.parentId || !below.has(task.parentId) || task.deletedAt) continue;
      below.add(task.id); placed.add(task.id); subtasks.push(task); added = true;
    }
  }
  return {
    ...detail, task: latest(detail.task), subtasks,
    previous: detail.previous.map(item => ({ ...item, task: latest(item.task) })).filter(item => !item.task.deletedAt),
    next: detail.next.map(item => ({ ...item, task: latest(item.task) })).filter(item => !item.task.deletedAt),
  };
}

function withComments(world: TodoWorld, comments: TodoComment[]): TodoWorld {
  const detail = world.detail;
  if (!detail || !comments.length) return world;
  const mine = comments.filter(comment => comment.taskId === detail.task.id);
  if (!mine.length) return world;
  const map = new Map(detail.comments.map(comment => [comment.id, comment]));
  for (const comment of mine) if (comment.deletedAt) map.delete(comment.id); else map.set(comment.id, comment);
  const list = [...map.values()].sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);
  const counts = { ...world.commentCounts };
  if (list.length) counts[detail.task.id] = list.length; else delete counts[detail.task.id];
  const next = { ...detail, comments: list };
  // A deleted comment's files stop showing with it.
  return { ...world, commentCounts: counts, fileCounts: countFromDetail(world.fileCounts, next), detail: next };
}

function withLinks(world: TodoWorld, links: TodoLink[], removed: string[]): TodoWorld {
  if (!links.length && !removed.length) return world;
  const map = { ...world.links };
  for (const id of removed) delete map[id];
  for (const link of links) map[link.id] = link;
  let detail = world.detail;
  if (detail) {
    const id = detail.task.id;
    const gone = new Set(removed);
    const known = (list: { link: TodoLink; task: TodoTask }[]) => list.filter(item => !gone.has(item.link.id));
    const previous = known(detail.previous), next = known(detail.next);
    for (const link of links) {
      if (link.toTaskId === id && !previous.some(item => item.link.id === link.id) && world.tasks[link.fromTaskId]) previous.push({ link, task: world.tasks[link.fromTaskId] });
      if (link.fromTaskId === id && !next.some(item => item.link.id === link.id) && world.tasks[link.toTaskId]) next.push({ link, task: world.tasks[link.toTaskId] });
    }
    detail = { ...detail, previous, next };
  }
  return { ...world, links: map, detail };
}

/** Files of a task that show: not deleted, and (for a comment's) on a comment that shows. */
export function visibleFiles(files: readonly TodoFile[], commentIds: ReadonlySet<string>): TodoFile[] {
  return files.filter(file => !file.deletedAt && (file.commentId === null || commentIds.has(file.commentId)));
}

/** The open task's attachment count, from its detail: the count the server reports, whatever order answers came in. */
function countFromDetail(counts: Record<string, number>, detail: TodoTaskDetail): Record<string, number> {
  const shown = visibleFiles(detail.files, new Set(detail.comments.map(comment => comment.id))).length;
  const next = { ...counts };
  if (shown) next[detail.task.id] = shown; else delete next[detail.task.id];
  return next;
}

/**
 * Files added, deleted or restored. The open detail keeps them all (a deleted one with `deletedAt`, to undo); counts
 * follow what shows, judged from the detail when the file is in it and from the change alone when it is not.
 */
function withFiles(world: TodoWorld, files: readonly TodoFile[]): TodoWorld {
  if (!files.length) return world;
  const counts = { ...world.fileCounts };
  let detail = world.detail;
  for (const file of files) {
    const before = detail?.files.find(item => item.id === file.id);
    const shown = before ? !before.deletedAt : !!file.deletedAt;
    const delta = Number(!file.deletedAt) - Number(shown);
    if (delta) { const next = (counts[file.taskId] ?? 0) + delta; if (next > 0) counts[file.taskId] = next; else delete counts[file.taskId]; }
    if (detail && detail.task.id === file.taskId) detail = { ...detail, files: before ? detail.files.map(item => item.id === file.id ? { ...item, ...file } : item) : [...detail.files, file] };
  }
  return { ...world, fileCounts: detail ? countFromDetail(counts, detail) : counts, detail };
}

/** Counts with `changed` put in; a task with no sub-tasks left has none. */
function withCounts(counts: Record<string, TodoSubtaskCount>, changed: Record<string, TodoSubtaskCount>): Record<string, TodoSubtaskCount> {
  const next = { ...counts };
  for (const [id, count] of Object.entries(changed)) if (count.total > 0) next[id] = count; else delete next[id];
  return next;
}

/** What a task adds to its parent's count: nothing deleted, one to the total, and one to the done ones when completed. */
const share = (task: TodoTask | undefined) => !task?.parentId || task.deletedAt ? null : { parentId: task.parentId, done: task.completedAt ? 1 : 0 };

/** The counts after an immediate change, from how each task it changed counted before and counts now. */
function shiftCounts(before: TodoWorld, after: TodoWorld): Record<string, TodoSubtaskCount> {
  const changed: Record<string, TodoSubtaskCount> = {};
  const add = (task: TodoTask | undefined, sign: 1 | -1) => {
    const item = share(task);
    if (!item) return;
    const count = changed[item.parentId] ??= { ...(after.subtaskCounts[item.parentId] ?? { done: 0, total: 0 }) };
    count.total += sign; count.done += sign * item.done;
  };
  for (const [id, task] of Object.entries(after.tasks)) {
    if (before.tasks[id] === task) continue;
    add(before.tasks[id], -1);
    add(task, 1);
  }
  return Object.keys(changed).length ? withCounts(after.subtaskCounts, changed) : after.subtaskCounts;
}

/** A request's answer: what it changed, as the server now has it. */
export function mergeChanges(world: TodoWorld, changes: TodoChanges): TodoWorld {
  const tasks = { ...world.tasks };
  for (const task of changes.tasks) tasks[task.id] = task;
  let next: TodoWorld = {
    ...world, revision: Math.max(world.revision, changes.revision), subtaskCounts: changes.subtaskCounts ? withCounts(world.subtaskCounts, changes.subtaskCounts) : world.subtaskCounts,
    projects: upsert(world.projects, changes.projects), sections: upsert(world.sections, changes.sections), labels: upsert(world.labels, changes.labels), tasks,
    agents: changes.agents ? withAgents(world.agents, changes.agents) : world.agents,
  };
  next = withLinks(next, changes.links, changes.removedLinks);
  next = withComments(next, changes.comments);
  next = withFiles(next, changes.files ?? []);
  return next.detail ? { ...next, detail: syncDetail(next.detail, tasks) } : next;
}

/** Issue masters that changed; null is one that is `closed` or gone. */
export function withAgents(agents: Record<string, TodoAgent>, changed: Record<string, TodoAgent | null>): Record<string, TodoAgent> {
  const next = { ...agents };
  for (const [taskId, agent] of Object.entries(changed)) if (agent && agent.state !== 'closed') next[taskId] = agent; else delete next[taskId];
  return next;
}

export function withDetail(world: TodoWorld, detail: TodoTaskDetail | null): TodoWorld {
  if (!detail) return { ...world, detail: null };
  const tasks = { ...world.tasks, [detail.task.id]: detail.task };
  for (const task of detail.subtasks) tasks[task.id] = task;
  for (const item of [...detail.previous, ...detail.next]) tasks[item.task.id] = item.task;
  const counts = { ...world.commentCounts };
  if (detail.comments.length) counts[detail.task.id] = detail.comments.length; else delete counts[detail.task.id];
  return { ...world, tasks, commentCounts: counts, fileCounts: countFromDetail(world.fileCounts, detail), detail };
}

/** Siblings of a task: the same project, section and parent. */
export function siblingsOf(world: TodoWorld, place: { projectId: string; sectionId: string | null; parentId: string | null }, except?: string): TodoTask[] {
  return Object.values(world.tasks).filter(task => isOpen(task) && task.id !== except && task.projectId === place.projectId
    && task.sectionId === place.sectionId && task.parentId === place.parentId).sort(byOrder);
}

/** The key the server would give: after `afterId` (when it is still a sibling), first for null, last when absent. */
export function placeKey(siblings: readonly { id: string; sortKey: string }[], afterId: string | null | undefined): string {
  const keys = siblings.map(item => item.sortKey);
  const anchor = afterId ? siblings.findIndex(item => item.id === afterId) : -1;
  try {
    if (afterId === null) return keyBetween(null, keys[0] ?? null);
    if (anchor < 0) return keyBetween(keys[keys.length - 1] ?? null, null);
    const after = keys.slice(anchor + 1).find(key => key > keys[anchor]) ?? null;
    return keyBetween(keys[anchor], after);
  } catch {
    // best-effort: equal keys from another page; the server's answer places it exactly.
    return `${keys[anchor] ?? keys[keys.length - 1] ?? ''}V`;
  }
}

/** The task before `id` among its siblings: where a move puts it back. */
export function previousSibling(world: TodoWorld, id: string): string | null {
  const task = world.tasks[id];
  if (!task) return null;
  const list = siblingsOf(world, task);
  const index = list.findIndex(item => item.id === id);
  return index > 0 ? list[index - 1].id : null;
}

function descendants(world: TodoWorld, id: string): TodoTask[] {
  const result: TodoTask[] = [];
  const queue = [id];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const task of Object.values(world.tasks)) if (task.parentId === parent && !task.deletedAt) { result.push(task); queue.push(task.id); }
  }
  return result;
}

/** The open tasks of a date, which the server puts in order together (shared/todo/day-order.ts). */
const dayTasks = (world: TodoWorld, date: string) => Object.values(world.tasks).filter(task => isOpen(task) && task.dueDate === date);

export interface ApplyContext { now: string; today: string }

function patchTask(world: TodoWorld, id: string, patch: Partial<TodoTask>): TodoWorld {
  const task = world.tasks[id];
  return task ? { ...world, tasks: { ...world.tasks, [id]: { ...task, ...patch } } } : world;
}

const OPTIMISTIC: { [N in TodoOp['op']]?: (world: TodoWorld, op: TodoOpOf<N>, context: ApplyContext) => TodoWorld } = {
  'task.create': (world, op, { now }) => {
    const parent = op.parentId ? world.tasks[op.parentId] : undefined;
    const projectId = parent?.projectId ?? op.projectId ?? inboxOf(world)?.id ?? '';
    const sectionId = parent ? parent.sectionId : op.sectionId ?? null;
    const place = { projectId, sectionId, parentId: parent?.id ?? null };
    const task: TodoTask = {
      id: op.id, ...place, content: op.content, description: op.description ?? '', priority: op.priority ?? 4, dueDate: op.dueDate ?? null,
      dueTime: op.dueDate ? op.dueTime ?? null : null, recurrence: op.dueDate ? op.recurrence ?? null : null, durationMin: op.durationMin ?? null,
      deadlineDate: op.deadlineDate ?? null, labelIds: op.labelIds ?? [], sortKey: placeKey(siblingsOf(world, place), op.afterId), dayOrder: null, completedAt: null,
      createdAt: now, updatedAt: now, deletedAt: null, ...(op.slackThread ? { slackThread: op.slackThread } : {}),
    };
    return { ...world, tasks: { ...world.tasks, [task.id]: task } };
  },
  'task.update': (world, op, { now }) => {
    const task = world.tasks[op.id];
    if (!task) return world;
    const { slackThread, ...fields } = op.patch;
    const patch: Partial<TodoTask> = { ...fields, ...(slackThread !== undefined ? { slackThread: slackThread ?? undefined } : {}), updatedAt: now };
    // Clearing the date clears what depends on it, as the server does.
    if (op.patch.dueDate === null) { patch.dueTime = null; patch.recurrence = null; }
    return patchTask(world, op.id, patch);
  },
  'task.move': (world, op, { now }) => {
    const task = world.tasks[op.id];
    if (!task) return world;
    if (op.dayAfterId !== undefined) {
      if (!isOpen(task) || !task.dueDate) return world;
      let next = world;
      for (const item of reorderDay(dayTasks(world, task.dueDate), op.id, op.dayAfterId)) {
        if (next.tasks[item.id]?.dayOrder !== item.dayOrder) next = patchTask(next, item.id, { dayOrder: item.dayOrder, ...(item.id === op.id ? { updatedAt: now } : {}) });
      }
      return next;
    }
    const parent = op.parentId ? world.tasks[op.parentId] : undefined;
    const moved = op.parentId !== undefined || op.projectId !== undefined || op.sectionId !== undefined;
    const projectId = parent?.projectId ?? (moved ? op.projectId ?? task.projectId : task.projectId);
    const sectionId = parent ? parent.sectionId : op.sectionId !== undefined ? op.sectionId : op.projectId && op.projectId !== task.projectId ? null : task.sectionId;
    const place = { projectId, sectionId, parentId: parent?.id ?? (moved ? null : task.parentId) };
    // After a completed sibling (the server counts those too), among all of them.
    const anchor = op.afterId ? world.tasks[op.afterId] : undefined;
    const list = anchor && !isOpen(anchor) && !anchor.deletedAt
      ? Object.values(world.tasks).filter(item => !item.deletedAt && item.id !== op.id && item.projectId === place.projectId && item.sectionId === place.sectionId && item.parentId === place.parentId).sort(byOrder)
      : siblingsOf(world, place, op.id);
    let next = patchTask(world, op.id, { ...place, sortKey: placeKey(list, op.afterId), updatedAt: now });
    if (projectId !== task.projectId || sectionId !== task.sectionId) for (const below of descendants(world, op.id)) next = patchTask(next, below.id, { projectId, sectionId });
    return next;
  },
  'task.complete': (world, op, { now }) => {
    const task = world.tasks[op.id];
    if (!task) return world;
    let next = world;
    const following = task.recurrence && task.dueDate ? nextOccurrence(task.recurrence, task.dueDate, op.today) : null;
    next = following ? patchTask(next, op.id, { dueDate: following, updatedAt: now }) : patchTask(next, op.id, { completedAt: now, updatedAt: now });
    for (const below of descendants(world, op.id)) if (!below.completedAt) next = patchTask(next, below.id, { completedAt: now });
    return next;
  },
  'task.uncomplete': (world, op, { now }) => {
    const task = world.tasks[op.id];
    if (!task) return world;
    let next = patchTask(world, op.id, { completedAt: null, updatedAt: now });
    // An open task never sits below a completed one.
    for (let parent = task.parentId ? next.tasks[task.parentId] : undefined; parent; parent = parent.parentId ? next.tasks[parent.parentId] : undefined) {
      if (parent.completedAt) next = patchTask(next, parent.id, { completedAt: null });
    }
    return next;
  },
  'task.delete': (world, op, { now }) => {
    let next = patchTask(world, op.id, { deletedAt: now });
    for (const below of descendants(world, op.id)) next = patchTask(next, below.id, { deletedAt: now });
    return next;
  },
  'task.restore': (world, op) => patchTask(world, op.id, { deletedAt: null }),
  'link.create': (world, op, { now }) => withLinks(world, [{ id: op.id, fromTaskId: op.fromTaskId, toTaskId: op.toTaskId, kind: 'next', createdAt: now }], []),
  'link.delete': (world, op) => withLinks(world, [], [op.id]),
  'project.create': (world, op, { now }) => ({ ...world, projects: [...world.projects, {
    id: op.id, parentId: op.parentId ?? null, name: op.name, color: op.color ?? 'charcoal', favorite: false, inbox: false, layout: 'board' as const, archivedAt: null,
    sortKey: placeKey(world.projects.filter(project => !project.inbox && project.parentId === (op.parentId ?? null)), op.afterId), createdAt: now, updatedAt: now, deletedAt: null,
  }].sort(byOrder) }),
  'project.update': (world, op, { now }) => ({ ...world, projects: world.projects.map(project => project.id !== op.id ? project : {
    ...project, ...(op.patch.name !== undefined ? { name: op.patch.name } : {}), ...(op.patch.color !== undefined ? { color: op.patch.color } : {}),
    ...(op.patch.favorite !== undefined ? { favorite: op.patch.favorite } : {}), ...(op.patch.layout !== undefined ? { layout: op.patch.layout } : {}),
    ...(op.patch.archived !== undefined ? { archivedAt: op.patch.archived ? now : null } : {}), updatedAt: now,
  }) }),
  'project.delete': (world, op) => ({ ...world, projects: world.projects.filter(project => project.id !== op.id) }),
  'section.create': (world, op, { now }) => ({ ...world, sections: [...world.sections, {
    id: op.id, projectId: op.projectId, name: op.name, collapsed: false, archivedAt: null,
    sortKey: placeKey(world.sections.filter(section => section.projectId === op.projectId), op.afterId), createdAt: now, updatedAt: now, deletedAt: null,
  }].sort(byOrder) }),
  'section.update': (world, op, { now }) => ({ ...world, sections: world.sections.map(section => section.id !== op.id ? section : {
    ...section, ...(op.patch.name !== undefined ? { name: op.patch.name } : {}), ...(op.patch.collapsed !== undefined ? { collapsed: op.patch.collapsed } : {}),
    ...(op.patch.archived !== undefined ? { archivedAt: op.patch.archived ? now : null } : {}), updatedAt: now,
  }) }),
  'section.move': (world, op) => {
    const section = world.sections.find(item => item.id === op.id);
    if (!section) return world;
    const sortKey = placeKey(world.sections.filter(item => item.projectId === section.projectId && item.id !== op.id), op.afterId);
    return { ...world, sections: world.sections.map(item => item.id === op.id ? { ...item, sortKey } : item).sort(byOrder) };
  },
  'section.delete': (world, op, { now }) => {
    const next = { ...world, sections: world.sections.filter(section => section.id !== op.id) };
    const tasks = { ...next.tasks };
    for (const task of Object.values(tasks)) if (task.sectionId === op.id && !task.deletedAt) tasks[task.id] = { ...task, deletedAt: now };
    return { ...next, tasks };
  },
  'label.create': (world, op, { now }) => ({ ...world, labels: [...world.labels, {
    id: op.id, name: op.name, color: op.color ?? 'charcoal', favorite: false, sortKey: placeKey(world.labels, undefined), createdAt: now, updatedAt: now, deletedAt: null,
  }].sort(byOrder) }),
  'label.update': (world, op, { now }) => ({ ...world, labels: world.labels.map(label => label.id !== op.id ? label : {
    ...label, ...(op.patch.name !== undefined ? { name: op.patch.name } : {}), ...(op.patch.color !== undefined ? { color: op.patch.color } : {}),
    ...(op.patch.favorite !== undefined ? { favorite: op.patch.favorite } : {}), updatedAt: now,
  }) }),
  'label.delete': (world, op) => ({ ...world, labels: world.labels.filter(label => label.id !== op.id) }),
  // The page is the owner's own, so its comment is theirs (the server records it so too).
  'comment.create': (world, op, { now }) => withComments(world, [{ id: op.id, taskId: op.taskId, body: op.body, author: 'owner', createdAt: now, updatedAt: now, deletedAt: null }]),
  'comment.update': (world, op, { now }) => {
    const comment = world.detail?.comments.find(item => item.id === op.id);
    return comment ? withComments(world, [{ ...comment, body: op.body, updatedAt: now }]) : world;
  },
  'file.delete': (world, op, { now }) => {
    const file = world.detail?.files.find(item => item.id === op.id);
    return file ? withFiles(world, [{ ...file, deletedAt: now }]) : world;
  },
  'file.restore': (world, op) => {
    const file = world.detail?.files.find(item => item.id === op.id);
    return file ? withFiles(world, [{ ...file, deletedAt: null }]) : world;
  },
  'comment.delete': (world, op, { now }) => {
    const comment = world.detail?.comments.find(item => item.id === op.id);
    return comment ? withComments(world, [{ ...comment, deletedAt: now }]) : world;
  },
};

/** Shows operations before the server answers. Operations without a visible effect of their own wait for the answer. */
export function applyOps(world: TodoWorld, ops: readonly TodoOp[], context: ApplyContext): TodoWorld {
  let next = world;
  for (const op of ops) {
    const apply = OPTIMISTIC[op.op] as ((world: TodoWorld, op: TodoOp, context: ApplyContext) => TodoWorld) | undefined;
    if (apply) next = apply(next, op, context);
  }
  if (next === world) return next;
  next = { ...next, subtaskCounts: shiftCounts(world, next) };
  return next.detail ? { ...next, detail: syncDetail(next.detail, next.tasks) } : next;
}

/** What the fields were; a task without a Slack thread had `null` there, as a patch clears it. */
const taskFieldsOf = (task: TodoTask, fields: string[]) => Object.fromEntries(fields.map(field => [field, field === 'slackThread' ? task.slackThread ?? null : task[field as keyof TodoTask]]));

/**
 * The operations that put things back as they were before `ops`, in reverse order; null when one of them cannot be
 * undone this way (reopening a task, which would need a new completion).
 */
export function inverseOps(world: TodoWorld, ops: readonly TodoOp[], newId: () => string): TodoOp[] | null {
  const inverse: TodoOp[] = [];
  for (const op of ops) {
    switch (op.op) {
      case 'task.create': inverse.push({ op: 'task.delete', id: op.id }); break;
      case 'task.update': {
        const task = world.tasks[op.id];
        if (!task) return null;
        const fields = Object.keys(op.patch);
        // Clearing a date clears its time and repeat, so undoing it brings those back too.
        if (op.patch.dueDate === null) fields.push('dueTime', 'recurrence');
        inverse.push({ op: 'task.update', id: op.id, patch: taskFieldsOf(task, [...new Set(fields)]) as TodoOpOf<'task.update'>['patch'] });
        break;
      }
      case 'task.move': {
        const task = world.tasks[op.id];
        if (!task) return null;
        if (op.dayAfterId !== undefined) {
          if (!task.dueDate) return null;
          inverse.push({ op: 'task.move', id: op.id, dayAfterId: dayBefore(dayTasks(world, task.dueDate), op.id) });
          break;
        }
        inverse.push(task.parentId ? { op: 'task.move', id: op.id, parentId: task.parentId, afterId: previousSibling(world, op.id) }
          : { op: 'task.move', id: op.id, projectId: task.projectId, sectionId: task.sectionId, parentId: null, afterId: previousSibling(world, op.id) });
        break;
      }
      case 'task.duplicate': inverse.push({ op: 'task.delete', id: op.copyId }); break;
      case 'task.complete': inverse.push({ op: 'task.uncomplete', id: op.id, completionId: op.completionId }); break;
      case 'task.delete': inverse.push({ op: 'task.restore', id: op.id }); break;
      case 'task.restore': inverse.push({ op: 'task.delete', id: op.id }); break;
      case 'link.create': inverse.push({ op: 'link.delete', id: op.id }); break;
      case 'link.delete': {
        const link = world.links[op.id] ?? [...(world.detail?.previous ?? []), ...(world.detail?.next ?? [])].find(item => item.link.id === op.id)?.link;
        if (!link) return null;
        inverse.push({ op: 'link.create', id: newId(), fromTaskId: link.fromTaskId, toTaskId: link.toTaskId });
        break;
      }
      case 'project.create': inverse.push({ op: 'project.delete', id: op.id }); break;
      case 'project.delete': inverse.push({ op: 'project.restore', id: op.id }); break;
      case 'project.update': {
        const project = world.projects.find(item => item.id === op.id);
        if (!project) return null;
        const patch: TodoOpOf<'project.update'>['patch'] = {};
        if (op.patch.name !== undefined) patch.name = project.name;
        if (op.patch.color !== undefined) patch.color = project.color;
        if (op.patch.favorite !== undefined) patch.favorite = project.favorite;
        if (op.patch.layout !== undefined) patch.layout = project.layout;
        if (op.patch.archived !== undefined) patch.archived = !!project.archivedAt;
        inverse.push({ op: 'project.update', id: op.id, patch });
        break;
      }
      case 'section.create': inverse.push({ op: 'section.delete', id: op.id }); break;
      case 'section.delete': inverse.push({ op: 'section.restore', id: op.id }); break;
      case 'section.update': {
        const section = world.sections.find(item => item.id === op.id);
        if (!section) return null;
        const patch: TodoOpOf<'section.update'>['patch'] = {};
        if (op.patch.name !== undefined) patch.name = section.name;
        if (op.patch.collapsed !== undefined) patch.collapsed = section.collapsed;
        if (op.patch.archived !== undefined) patch.archived = !!section.archivedAt;
        inverse.push({ op: 'section.update', id: op.id, patch });
        break;
      }
      case 'section.move': {
        const section = world.sections.find(item => item.id === op.id);
        if (!section) return null;
        const list = world.sections.filter(item => item.projectId === section.projectId);
        const index = list.findIndex(item => item.id === op.id);
        inverse.push({ op: 'section.move', id: op.id, afterId: index > 0 ? list[index - 1].id : null });
        break;
      }
      case 'label.create': inverse.push({ op: 'label.delete', id: op.id }); break;
      case 'label.delete': inverse.push({ op: 'label.restore', id: op.id }); break;
      case 'comment.create': inverse.push({ op: 'comment.delete', id: op.id }); break;
      case 'file.delete': inverse.push({ op: 'file.restore', id: op.id }); break;
      case 'file.restore': inverse.push({ op: 'file.delete', id: op.id }); break;
      case 'comment.delete': inverse.push({ op: 'comment.restore', id: op.id }); break;
      case 'comment.update': {
        const comment = world.detail?.comments.find(item => item.id === op.id);
        if (!comment) return null;
        inverse.push({ op: 'comment.update', id: op.id, body: comment.body });
        break;
      }
      default: return null;
    }
  }
  return inverse.reverse();
}

/** Whether an answer changed what the open detail shows, which then is read again for its activity and history. */
export function touchesDetail(detail: TodoTaskDetail | null, changes: TodoChanges): boolean {
  if (!detail) return false;
  const ids = new Set([detail.task.id, ...detail.subtasks.map(task => task.id)]);
  return changes.tasks.some(task => ids.has(task.id) || (!!task.parentId && ids.has(task.parentId)))
    || changes.comments.some(comment => comment.taskId === detail.task.id)
    || (changes.files ?? []).some(file => file.taskId === detail.task.id)
    || changes.links.some(link => ids.has(link.fromTaskId) || ids.has(link.toTaskId))
    || changes.removedLinks.some(id => [...detail.previous, ...detail.next].some(item => item.link.id === id));
}
