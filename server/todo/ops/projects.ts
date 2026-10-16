import { randomUUID } from 'node:crypto';
import type { TodoOpOf } from '../../../shared/todo/ops.js';
import { invalid, missing, stale, type TodoContext } from '../context.js';

/** Projects nest at most this many levels (a top-level project is level 1). */
export const MAX_PROJECT_LEVELS = 3;

interface ProjectRow { id: string; parent_id: string | null; inbox: number; archived_at: string | null; deleted_at: string | null; deleted_with: string | null }
interface SectionRow { id: string; project_id: string; deleted_at: string | null; deleted_with: string | null }

export function liveProject(ctx: TodoContext, id: string): ProjectRow {
  const project = ctx.get<ProjectRow>('SELECT * FROM todo_projects WHERE id = ?', id);
  if (!project || project.deleted_at) throw missing('프로젝트를 찾을 수 없습니다.');
  return project;
}
export function liveSection(ctx: TodoContext, id: string): SectionRow {
  const section = ctx.get<SectionRow>('SELECT * FROM todo_sections WHERE id = ?', id);
  if (!section || section.deleted_at) throw missing('섹션을 찾을 수 없습니다.');
  return section;
}

const level = (ctx: TodoContext, id: string) => ctx.get<{ n: number }>(`WITH RECURSIVE up(id, n) AS (SELECT parent_id, 1 FROM todo_projects WHERE id = ?
  UNION ALL SELECT p.parent_id, up.n + 1 FROM todo_projects p JOIN up ON p.id = up.id WHERE up.id IS NOT NULL) SELECT MAX(n) AS n FROM up`, id)?.n ?? 1;
/** The project and every project below it. */
const subtree = (ctx: TodoContext, id: string) => ctx.all<ProjectRow & { depth: number }>(`WITH RECURSIVE down(id, depth) AS (SELECT ?, 0
  UNION ALL SELECT p.id, down.depth + 1 FROM todo_projects p JOIN down ON p.parent_id = down.id) SELECT p.*, down.depth AS depth FROM down JOIN todo_projects p ON p.id = down.id`, id);

function parentFor(ctx: TodoContext, parentId: string | null | undefined, height: number): string | null {
  if (!parentId) return null;
  const parent = liveProject(ctx, parentId);
  if (parent.inbox) throw invalid('관리함 아래에는 프로젝트를 만들 수 없습니다.');
  if (level(ctx, parent.id) + 1 + height > MAX_PROJECT_LEVELS) throw invalid(`프로젝트는 ${MAX_PROJECT_LEVELS}단계까지 넣을 수 있습니다.`);
  return parent.id;
}

export function createProject(ctx: TodoContext, op: TodoOpOf<'project.create'>): void {
  if (ctx.get('SELECT 1 FROM todo_projects WHERE id = ?', op.id)) throw invalid('같은 id의 프로젝트가 이미 있습니다.');
  const parentId = parentFor(ctx, op.parentId, 0);
  const key = ctx.place('todo_projects', 'parent_id IS ? AND inbox = 0', [parentId], op.afterId);
  ctx.run('INSERT INTO todo_projects (id, parent_id, name, color, sort_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    op.id, parentId, op.name, op.color ?? 'charcoal', key, ctx.now, ctx.now);
  ctx.touched.projects.add(op.id);
}

export function updateProject(ctx: TodoContext, op: TodoOpOf<'project.update'>): void {
  const project = liveProject(ctx, op.id);
  const { patch } = op;
  if (project.inbox && (patch.archived || patch.name !== undefined)) throw invalid('관리함은 이름을 바꾸거나 보관할 수 없습니다.');
  const columns: Record<string, string | number | null> = {};
  if (patch.name !== undefined) columns.name = patch.name;
  if (patch.color !== undefined) columns.color = patch.color;
  if (patch.favorite !== undefined) columns.favorite = patch.favorite ? 1 : 0;
  if (patch.layout !== undefined) columns.layout = patch.layout;
  if (patch.archived !== undefined) columns.archived_at = patch.archived ? project.archived_at ?? ctx.now : null;
  const names = Object.keys(columns);
  if (!names.length) return;
  ctx.run(`UPDATE todo_projects SET ${names.map(name => `${name} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...names.map(name => columns[name]), ctx.now, project.id);
  ctx.touched.projects.add(project.id);
}

export function moveProject(ctx: TodoContext, op: TodoOpOf<'project.move'>): void {
  const project = liveProject(ctx, op.id);
  if (project.inbox) throw invalid('관리함은 옮길 수 없습니다.');
  const below = subtree(ctx, project.id);
  const parentId = op.parentId === undefined ? project.parent_id : op.parentId;
  if (parentId && below.some(row => row.id === parentId)) throw invalid('프로젝트를 자기 하위 프로젝트 아래로 옮길 수 없습니다.');
  const target = op.parentId === undefined ? project.parent_id : parentFor(ctx, op.parentId, Math.max(...below.map(row => row.depth)));
  const key = ctx.place('todo_projects', 'parent_id IS ? AND inbox = 0', [target], op.afterId, project.id);
  ctx.run('UPDATE todo_projects SET parent_id = ?, sort_key = ?, updated_at = ? WHERE id = ?', target, key, ctx.now, project.id);
  ctx.touched.projects.add(project.id);
}

/** Deleting a project deletes what is in it, all with one time, so restoring brings back exactly that. */
export function deleteProject(ctx: TodoContext, op: TodoOpOf<'project.delete'>): void {
  const project = liveProject(ctx, op.id);
  if (project.inbox) throw invalid('관리함은 지울 수 없습니다.');
  const batch = randomUUID();
  for (const row of subtree(ctx, project.id)) {
    if (row.deleted_at) continue;
    ctx.run('UPDATE todo_projects SET deleted_at = ?, deleted_with = ?, updated_at = ? WHERE id = ?', ctx.now, batch, ctx.now, row.id);
    ctx.touched.projects.add(row.id);
    for (const table of ['todo_sections', 'todo_tasks'] as const) {
      for (const { id } of ctx.all<{ id: string }>(`SELECT id FROM ${table} WHERE project_id = ? AND deleted_at IS NULL`, row.id)) {
        ctx.run(`UPDATE ${table} SET deleted_at = ?, deleted_with = ?, updated_at = ? WHERE id = ?`, ctx.now, batch, ctx.now, id);
        ctx.touched[table === 'todo_sections' ? 'sections' : 'tasks'].add(id);
      }
    }
  }
}

export function restoreProject(ctx: TodoContext, op: TodoOpOf<'project.restore'>): void {
  const project = ctx.get<ProjectRow>('SELECT * FROM todo_projects WHERE id = ?', op.id);
  if (!project) throw missing('프로젝트를 찾을 수 없습니다.');
  if (!project.deleted_at) return;
  if (project.parent_id) liveProject(ctx, project.parent_id);
  const batch = project.deleted_with;
  ctx.keepKeyUnique('todo_projects', 'parent_id IS ? AND inbox = 0', [project.parent_id], project.id);
  for (const row of subtree(ctx, project.id)) {
    if (!row.deleted_at || row.deleted_with !== batch) continue;
    ctx.run('UPDATE todo_projects SET deleted_at = NULL, deleted_with = NULL, updated_at = ? WHERE id = ?', ctx.now, row.id);
    ctx.touched.projects.add(row.id);
    for (const table of ['todo_sections', 'todo_tasks'] as const) {
      for (const { id } of ctx.all<{ id: string }>(`SELECT id FROM ${table} WHERE project_id = ? AND deleted_with = ?`, row.id, batch)) {
        ctx.run(`UPDATE ${table} SET deleted_at = NULL, deleted_with = NULL, updated_at = ? WHERE id = ?`, ctx.now, id);
        ctx.touched[table === 'todo_sections' ? 'sections' : 'tasks'].add(id);
      }
    }
  }
}

export function createSection(ctx: TodoContext, op: TodoOpOf<'section.create'>): void {
  if (ctx.get('SELECT 1 FROM todo_sections WHERE id = ?', op.id)) throw invalid('같은 id의 섹션이 이미 있습니다.');
  const project = liveProject(ctx, op.projectId);
  const key = ctx.place('todo_sections', 'project_id = ?', [project.id], op.afterId);
  ctx.run('INSERT INTO todo_sections (id, project_id, name, sort_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', op.id, project.id, op.name, key, ctx.now, ctx.now);
  ctx.touched.sections.add(op.id);
}

export function updateSection(ctx: TodoContext, op: TodoOpOf<'section.update'>): void {
  const section = liveSection(ctx, op.id);
  const { patch } = op;
  const columns: Record<string, string | number | null> = {};
  if (patch.name !== undefined) columns.name = patch.name;
  if (patch.collapsed !== undefined) columns.collapsed = patch.collapsed ? 1 : 0;
  if (patch.archived !== undefined) columns.archived_at = patch.archived ? ctx.now : null;
  const names = Object.keys(columns);
  if (!names.length) return;
  ctx.run(`UPDATE todo_sections SET ${names.map(name => `${name} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...names.map(name => columns[name]), ctx.now, section.id);
  ctx.touched.sections.add(section.id);
}

export function moveSection(ctx: TodoContext, op: TodoOpOf<'section.move'>): void {
  const section = liveSection(ctx, op.id);
  const key = ctx.place('todo_sections', 'project_id = ?', [section.project_id], op.afterId, section.id);
  ctx.run('UPDATE todo_sections SET sort_key = ?, updated_at = ? WHERE id = ?', key, ctx.now, section.id);
  ctx.touched.sections.add(section.id);
}

export function deleteSection(ctx: TodoContext, op: TodoOpOf<'section.delete'>): void {
  const section = liveSection(ctx, op.id);
  const batch = randomUUID();
  ctx.run('UPDATE todo_sections SET deleted_at = ?, deleted_with = ?, updated_at = ? WHERE id = ?', ctx.now, batch, ctx.now, section.id);
  ctx.touched.sections.add(section.id);
  for (const { id } of ctx.all<{ id: string }>('SELECT id FROM todo_tasks WHERE section_id = ? AND deleted_at IS NULL', section.id)) {
    ctx.run('UPDATE todo_tasks SET deleted_at = ?, deleted_with = ?, updated_at = ? WHERE id = ?', ctx.now, batch, ctx.now, id);
    ctx.touched.tasks.add(id);
  }
}

export function restoreSection(ctx: TodoContext, op: TodoOpOf<'section.restore'>): void {
  const section = ctx.get<SectionRow>('SELECT * FROM todo_sections WHERE id = ?', op.id);
  if (!section) throw missing('섹션을 찾을 수 없습니다.');
  if (!section.deleted_at) return;
  liveProject(ctx, section.project_id);
  const batch = section.deleted_with;
  ctx.run('UPDATE todo_sections SET deleted_at = NULL, deleted_with = NULL, updated_at = ? WHERE id = ?', ctx.now, section.id);
  ctx.touched.sections.add(section.id);
  ctx.keepKeyUnique('todo_sections', 'project_id = ?', [section.project_id], section.id);
  for (const { id } of ctx.all<{ id: string }>('SELECT id FROM todo_tasks WHERE section_id = ? AND deleted_with = ?', section.id, batch)) {
    ctx.run('UPDATE todo_tasks SET deleted_at = NULL, deleted_with = NULL, updated_at = ? WHERE id = ?', ctx.now, id);
    ctx.touched.tasks.add(id);
  }
}

const labelNameTaken = (ctx: TodoContext, name: string, self?: string) =>
  Boolean(ctx.get('SELECT 1 FROM todo_labels WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL AND id IS NOT ?', name, self ?? null));

export function createLabel(ctx: TodoContext, op: TodoOpOf<'label.create'>): void {
  if (ctx.get('SELECT 1 FROM todo_labels WHERE id = ?', op.id)) throw invalid('같은 id의 라벨이 이미 있습니다.');
  if (labelNameTaken(ctx, op.name)) throw stale('같은 이름의 라벨이 이미 있습니다.');
  const key = ctx.place('todo_labels', '1 = 1', [], undefined);
  ctx.run('INSERT INTO todo_labels (id, name, color, sort_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', op.id, op.name, op.color ?? 'charcoal', key, ctx.now, ctx.now);
  ctx.touched.labels.add(op.id);
}

function liveLabel(ctx: TodoContext, id: string): { id: string } {
  const label = ctx.get<{ id: string; deleted_at: string | null }>('SELECT id, deleted_at FROM todo_labels WHERE id = ?', id);
  if (!label || label.deleted_at) throw missing('라벨을 찾을 수 없습니다.');
  return label;
}

export function updateLabel(ctx: TodoContext, op: TodoOpOf<'label.update'>): void {
  const label = liveLabel(ctx, op.id);
  const { patch } = op;
  if (patch.name !== undefined && labelNameTaken(ctx, patch.name, label.id)) throw stale('같은 이름의 라벨이 이미 있습니다.');
  const columns: Record<string, string | number> = {};
  if (patch.name !== undefined) columns.name = patch.name;
  if (patch.color !== undefined) columns.color = patch.color;
  if (patch.favorite !== undefined) columns.favorite = patch.favorite ? 1 : 0;
  const names = Object.keys(columns);
  if (!names.length) return;
  ctx.run(`UPDATE todo_labels SET ${names.map(name => `${name} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...names.map(name => columns[name]), ctx.now, label.id);
  ctx.touched.labels.add(label.id);
}

export function moveLabel(ctx: TodoContext, op: TodoOpOf<'label.move'>): void {
  const label = liveLabel(ctx, op.id);
  const key = ctx.place('todo_labels', '1 = 1', [], op.afterId, label.id);
  ctx.run('UPDATE todo_labels SET sort_key = ?, updated_at = ? WHERE id = ?', key, ctx.now, label.id);
  ctx.touched.labels.add(label.id);
}

/** A deleted label disappears from its tasks until it is restored. */
export function deleteLabel(ctx: TodoContext, op: TodoOpOf<'label.delete'>): void {
  const label = liveLabel(ctx, op.id);
  ctx.run('UPDATE todo_labels SET deleted_at = ?, updated_at = ? WHERE id = ?', ctx.now, ctx.now, label.id);
  ctx.touched.labels.add(label.id);
  for (const { task_id } of ctx.all<{ task_id: string }>('SELECT task_id FROM todo_task_labels WHERE label_id = ?', label.id)) ctx.touched.tasks.add(task_id);
}

export function restoreLabel(ctx: TodoContext, op: TodoOpOf<'label.restore'>): void {
  const label = ctx.get<{ id: string; name: string; deleted_at: string | null }>('SELECT id, name, deleted_at FROM todo_labels WHERE id = ?', op.id);
  if (!label) throw missing('라벨을 찾을 수 없습니다.');
  if (!label.deleted_at) return;
  if (labelNameTaken(ctx, label.name, label.id)) throw stale('같은 이름의 라벨이 이미 있습니다.');
  ctx.run('UPDATE todo_labels SET deleted_at = NULL, updated_at = ? WHERE id = ?', ctx.now, label.id);
  ctx.touched.labels.add(label.id);
  ctx.keepKeyUnique('todo_labels', '1 = 1', [], label.id);
  for (const { task_id } of ctx.all<{ task_id: string }>('SELECT task_id FROM todo_task_labels WHERE label_id = ?', label.id)) ctx.touched.tasks.add(task_id);
}
