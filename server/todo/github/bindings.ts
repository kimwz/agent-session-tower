import { randomUUID } from 'node:crypto';
import { TowerError } from '../../../shared/errors.js';
import type { TodoGitHubBinding } from '../../../shared/todo/types.js';
import type { TodoContext } from '../context.js';
import { githubBindingOf } from '../rows.js';

/**
 * Which repository a todo belongs to. A section's link comes before its project's; a sub-project has its own (none is
 * inherited); a sub-task goes with the task at its top.
 */

export const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export interface BindingRow extends TodoGitHubBinding { polledAt: string | null }

const bindingOf = (row: Record<string, unknown>): BindingRow => ({ ...githubBindingOf(row), polledAt: (row.polled_at ?? null) as string | null });

export const liveBindings = (ctx: TodoContext): BindingRow[] => ctx.all('SELECT * FROM todo_github_bindings WHERE deleted_at IS NULL ORDER BY created_at').map(bindingOf);

/** The link a task syncs through, if any. */
export function bindingOfTask(ctx: TodoContext, taskId: string, bindings: readonly BindingRow[] = liveBindings(ctx)): BindingRow | undefined {
  if (!bindings.length) return undefined;
  let row = ctx.get<{ id: string; parent_id: string | null; project_id: string; section_id: string | null }>('SELECT id, parent_id, project_id, section_id FROM todo_tasks WHERE id = ?', taskId);
  for (let depth = 0; row?.parent_id && depth < 10; depth++) row = ctx.get('SELECT id, parent_id, project_id, section_id FROM todo_tasks WHERE id = ?', row.parent_id);
  return row ? bindingOfPlace(row.project_id, row.section_id, bindings) : undefined;
}

/** The link a top-level task in this project and section would sync through. */
export function bindingOfPlace(projectId: string, sectionId: string | null, bindings: readonly BindingRow[]): BindingRow | undefined {
  return (sectionId ? bindings.find(item => item.scope.kind === 'section' && item.scope.id === sectionId) : undefined)
    ?? bindings.find(item => item.scope.kind === 'project' && item.scope.id === projectId);
}

/** Links a project or section to a repository, in place of the link it had. */
export function linkScope(ctx: TodoContext, input: { kind: 'project' | 'section'; id: string; repo: string; account: string }): TodoGitHubBinding {
  if (!REPO.test(input.repo)) throw new TowerError('invalid', 'repo는 owner/name 형식이어야 합니다.');
  const table = input.kind === 'project' ? 'todo_projects' : 'todo_sections';
  if (!ctx.get(`SELECT 1 FROM ${table} WHERE id = ? AND deleted_at IS NULL`, input.id)) throw new TowerError('not-found', input.kind === 'project' ? '프로젝트를 찾을 수 없습니다.' : '섹션을 찾을 수 없습니다.');
  ctx.run('UPDATE todo_github_bindings SET deleted_at = ? WHERE scope_kind = ? AND scope_id = ? AND deleted_at IS NULL', ctx.now, input.kind, input.id);
  const id = randomUUID();
  ctx.run('INSERT INTO todo_github_bindings (id, scope_kind, scope_id, repo, account, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, input.kind, input.id, input.repo, input.account, ctx.now);
  return githubBindingOf(ctx.get('SELECT * FROM todo_github_bindings WHERE id = ?', id)!);
}

/** Ends a link: todos stop syncing; their issues stay as they are on GitHub. */
export function unlink(ctx: TodoContext, id: string): void {
  if (!ctx.run('UPDATE todo_github_bindings SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', ctx.now, id)) throw new TowerError('not-found', 'GitHub 연결을 찾을 수 없습니다.');
}
