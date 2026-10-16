import type { IncomingMessage, ServerResponse } from 'node:http';
import { TowerError } from '../../shared/errors.js';
import { TodoRequestSchema, type TodoRequest } from '../../shared/todo/ops.js';
import type { TodoChanges, TodoCompletedPage, TodoOverview, TodoTask, TodoTaskDetail } from '../../shared/todo/types.js';
import { readJson } from './requests.js';

/** The owner's todos as this Tower's own pages use them. A controlling computer has no route to these. */
export interface TodoBackend {
  overview(): TodoOverview;
  detail(id: string): TodoTaskDetail;
  completed(input: { projectId?: string; before?: string; limit?: number }): TodoCompletedPage;
  search(query: string, input: { completed?: boolean; limit?: number }): TodoTask[];
  apply(request: TodoRequest): TodoChanges;
}

export const TODO_OPS_PATH = '/api/todos/ops';
/** A request of 100 operations with long descriptions fits; nothing the page sends comes near it otherwise. */
const MAX_TODO_BODY = 4 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const number = (value: string | null) => value === null || !/^\d{1,4}$/.test(value) ? undefined : Number(value);

/** Answers `/api/todos…`; false for any other path. */
export async function todoRoute(req: IncomingMessage, res: ServerResponse, url: URL, path: string, todos: TodoBackend | undefined,
  json: (res: ServerResponse, status: number, body: unknown) => void): Promise<boolean> {
  if (path !== '/api/todos' && !path.startsWith('/api/todos/')) return false;
  if (!todos) { json(res, 503, { error: '할 일을 사용할 수 없습니다.' }); return true; }
  if (req.method === 'GET' && path === '/api/todos') { json(res, 200, todos.overview()); return true; }
  if (req.method === 'GET' && path === '/api/todos/completed') {
    const projectId = url.searchParams.get('projectId') ?? undefined, before = url.searchParams.get('before') ?? undefined;
    if (projectId !== undefined && !ID.test(projectId)) throw new TowerError('invalid', '프로젝트 id가 올바르지 않습니다.');
    if (before !== undefined && (before.length > 40 || !Number.isFinite(Date.parse(before)))) throw new TowerError('invalid', 'before는 시각이어야 합니다.');
    json(res, 200, todos.completed({ projectId, before, limit: number(url.searchParams.get('limit')) }));
    return true;
  }
  if (req.method === 'GET' && path === '/api/todos/search') {
    const query = (url.searchParams.get('q') ?? '').trim();
    if (!query || query.length > 200) throw new TowerError('invalid', '검색어는 1~200자여야 합니다.');
    json(res, 200, { tasks: todos.search(query, { completed: url.searchParams.get('completed') === '1', limit: number(url.searchParams.get('limit')) }) });
    return true;
  }
  const task = /^\/api\/todos\/tasks\/([^/]+)$/.exec(path);
  if (req.method === 'GET' && task) {
    if (!ID.test(task[1])) throw new TowerError('invalid', '작업 id가 올바르지 않습니다.');
    json(res, 200, todos.detail(task[1]));
    return true;
  }
  if (req.method === 'POST' && path === TODO_OPS_PATH) {
    const parsed = TodoRequestSchema.safeParse(await readJson(req, MAX_TODO_BODY));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new TowerError('invalid', `할 일 변경 형식이 올바르지 않습니다: ${issue ? `${issue.path.join('.')} ${issue.message}` : ''}`.trim());
    }
    json(res, 200, todos.apply(parsed.data));
    return true;
  }
  json(res, 404, { error: 'API 경로를 찾을 수 없습니다.' });
  return true;
}
