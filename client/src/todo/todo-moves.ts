import { liveProjectIds } from '../../../shared/todo/compose';
import type { TodoOp } from '../../../shared/todo/ops';
import type { TodoLabel, TodoProject, TodoTask } from '../../../shared/todo/types';
import { byOrder, type TodoWorld } from './todo-model';
import { projectOrder, sectionMoveTarget } from './todo-views';

/**
 * Moves made from menus and the detail's sub-task list, as operations: a project or label one place up or down, a
 * project under another, a sub-task among its siblings, under another task or out of its parent. The server keeps the
 * rules (depth, cycles) and refuses what breaks them; these only offer what it would accept.
 */

/** Projects nest at most this many levels, as the server keeps (server/todo/ops/projects.ts). */
const MAX_PROJECT_LEVELS = 3;

export type Step = 'up' | 'down';

/** Moving one place up or down among `siblings` (`afterId`), or undefined at either end. */
export const stepTarget = (siblings: readonly { id: string; sortKey: string }[], id: string, step: Step) => sectionMoveTarget(siblings, id, step === 'up' ? 'left' : 'right');

/** The projects listed beside `project` in the sidebar: the same parent, not archived, not the inbox. */
export function projectSiblings(projects: readonly TodoProject[], project: TodoProject): TodoProject[] {
  const live = liveProjectIds(projects);
  return projects.filter(item => !item.inbox && !item.deletedAt && item.parentId === project.parentId && (live.has(item.id) || item.id === project.id)).sort(byOrder);
}

export function projectStepOp(projects: readonly TodoProject[], project: TodoProject, step: Step): TodoOp | null {
  const afterId = stepTarget(projectSiblings(projects, project), project.id, step);
  return afterId === undefined ? null : { op: 'project.move', id: project.id, afterId };
}

export function labelStepOp(labels: readonly TodoLabel[], id: string, step: Step): TodoOp | null {
  const afterId = stepTarget(labels.filter(label => !label.deletedAt), id, step);
  return afterId === undefined ? null : { op: 'label.move', id, afterId };
}

/**
 * Where project `id` can go: the top level (null) when it has a parent, and every shown project that keeps it and its
 * own sub-projects within three levels — never itself, one below it, or its present parent. In the sidebar's order.
 */
export function parentCandidates(world: TodoWorld, id: string): (TodoProject | null)[] {
  const byId = new Map(world.projects.map(project => [project.id, project]));
  const self = byId.get(id);
  if (!self) return [];
  const below = new Set([id]);
  let height = 0;
  for (let frontier = [id]; frontier.length && height <= MAX_PROJECT_LEVELS; height++) {
    frontier = world.projects.filter(project => !project.deletedAt && project.parentId && frontier.includes(project.parentId) && !below.has(project.id)).map(project => project.id);
    if (!frontier.length) break;
    for (const child of frontier) below.add(child);
  }
  const level = (project: TodoProject) => { let n = 1; for (let up = project.parentId; up && n <= MAX_PROJECT_LEVELS; up = byId.get(up)?.parentId ?? null) n++; return n; };
  const fits = projectOrder(world).filter(project => !project.inbox && !below.has(project.id) && project.id !== self.parentId && level(project) + 1 + height <= MAX_PROJECT_LEVELS);
  return [...(self.parentId ? [null] : []), ...fits];
}

/** Sub-task `id` put where `overId` is among its siblings (the same parent's sub-tasks), or null when it stays. */
export function subtaskReorderOp(siblings: readonly TodoTask[], id: string, overId: string): TodoOp | null {
  const list = [...siblings].sort(byOrder);
  const from = list.findIndex(item => item.id === id), to = list.findIndex(item => item.id === overId);
  if (from < 0 || to < 0 || from === to || !list[from].parentId) return null;
  const order = list.filter(item => item.id !== id);
  order.splice(to, 0, list[from]);
  const index = order.findIndex(item => item.id === id);
  return { op: 'task.move', id, parentId: list[from].parentId, afterId: index > 0 ? order[index - 1].id : null };
}

/**
 * Found tasks `task` can go under: not itself, one below it, its present parent, a completed or deleted one, or one in
 * an archived project or section (`shelved`), which is read-only.
 */
export function moveUnderCandidates(tasks: Readonly<Record<string, TodoTask>>, task: TodoTask, found: readonly TodoTask[], shelved: (task: TodoTask) => boolean = () => false): TodoTask[] {
  const below = (candidate: string) => { for (let item = tasks[candidate], count = 0; item?.parentId && count < 10; item = tasks[item.parentId], count++) if (item.parentId === task.id) return true; return false; };
  return found.filter(item => item.id !== task.id && item.id !== task.parentId && !item.completedAt && !item.deletedAt && !shelved(item) && !below(item.id));
}

/** A sub-task made a task of its own, in its parent's project and section, right after the task it was under. */
export function outOfParentOp(tasks: Readonly<Record<string, TodoTask>>, task: TodoTask): TodoOp | null {
  if (!task.parentId) return null;
  let top = tasks[task.parentId];
  for (let count = 0; top?.parentId && tasks[top.parentId] && count < 10; count++) top = tasks[top.parentId];
  return { op: 'task.move', id: task.id, parentId: null, ...(top && !top.parentId ? { afterId: top.id } : {}) };
}
