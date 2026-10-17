import type { TodoLabel, TodoOverview, TodoProject, TodoSection, TodoTask } from '../../../shared/todo/types.js';

const at = '2026-10-14T00:00:00.000Z';

export const project = (id: string, patch: Partial<TodoProject> = {}): TodoProject => ({
  id, parentId: null, name: id, color: 'blue', favorite: false, inbox: false, layout: 'board', archivedAt: null, sortKey: id, createdAt: at, updatedAt: at, deletedAt: null, ...patch,
});
export const section = (id: string, projectId: string, patch: Partial<TodoSection> = {}): TodoSection => ({
  id, projectId, name: id, collapsed: false, archivedAt: null, sortKey: id, createdAt: at, updatedAt: at, deletedAt: null, ...patch,
});
export const label = (id: string, patch: Partial<TodoLabel> = {}): TodoLabel => ({ id, name: id, color: 'red', favorite: false, sortKey: id, createdAt: at, updatedAt: at, deletedAt: null, ...patch });
export const task = (id: string, patch: Partial<TodoTask> = {}): TodoTask => ({
  id, projectId: 'inbox', sectionId: null, parentId: null, content: id, description: '', priority: 4, dueDate: null, dueTime: null, recurrence: null, durationMin: null,
  deadlineDate: null, labelIds: [], sortKey: id, dayOrder: null, completedAt: null, createdAt: at, updatedAt: at, deletedAt: null, ...patch,
});
export const overview = (tasks: TodoTask[], patch: Partial<TodoOverview> = {}): TodoOverview => ({
  availability: { state: 'ready' }, revision: 1, projects: [project('inbox', { inbox: true, name: 'Inbox' })], sections: [], labels: [], tasks, links: [], commentCounts: {}, fileCounts: {}, subtaskCounts: {}, ...patch,
});
