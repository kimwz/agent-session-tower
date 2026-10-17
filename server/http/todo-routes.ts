import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { TowerError } from '../../shared/errors.js';
import { TodoRequestSchema, type TodoRequest } from '../../shared/todo/ops.js';
import type { TodoChanges, TodoCompletedPage, TodoOverview, TodoTask, TodoTaskDetail } from '../../shared/todo/types.js';
import type { TodoFiles } from '../todo/files.js';
import { readJson, UUID } from './requests.js';
import { byteRange } from './sinks.js';

/** The owner's todos as this Tower's own pages use them. A controlling computer has no route to these. */
export interface TodoBackend {
  overview(): TodoOverview;
  detail(id: string): TodoTaskDetail;
  completed(input: { projectId?: string; labelId?: string; before?: string; limit?: number }): TodoCompletedPage;
  search(query: string, input: { completed?: boolean; limit?: number }): TodoTask[];
  apply(request: TodoRequest): TodoChanges;
  /** Attachments; absent where they cannot be kept. */
  files?: Pick<TodoFiles, 'startUpload' | 'uploadOffset' | 'appendUpload' | 'completeUpload' | 'cancelUpload' | 'openFile'>;
}

export const TODO_OPS_PATH = '/api/todos/ops';
/** A request of 100 operations with long descriptions fits; nothing the page sends comes near it otherwise. */
const MAX_TODO_BODY = 4 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const number = (value: string | null) => value === null || !/^\d{1,4}$/.test(value) ? undefined : Number(value);
const UPLOAD = /^\/api\/todos\/uploads\/([^/]+?)(?:\/(complete|cancel))?$/;
const FILE = /^\/api\/todos\/files\/([^/]+)$/;

/** An upload that is not where the page thought answers where it is, so the page resumes from there. */
async function atOffset<T>(json: (res: ServerResponse, status: number, body: unknown) => void, res: ServerResponse, work: () => Promise<T>): Promise<T | undefined> {
  try { return await work(); }
  catch (error) {
    const offset = (error as { offset?: unknown }).offset;
    if (error instanceof TowerError && error.kind === 'conflict' && typeof offset === 'number') { json(res, 409, { error: error.message, offset }); return undefined; }
    throw error;
  }
}

/**
 * Sends an attachment, or the byte range asked for. Always as a download that cannot run in Tower's origin, except an
 * image asked for inline whose bytes are a PNG, JPEG, GIF or WebP.
 */
async function sendFile(req: IncomingMessage, res: ServerResponse, files: NonNullable<TodoBackend['files']>, id: string, inline: boolean, json: (res: ServerResponse, status: number, body: unknown) => void): Promise<void> {
  const { file, handle, image } = await files.openFile(id, inline);
  try {
    const name = encodeURIComponent(file.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    const wanted = byteRange(req.headers.range, file.size);
    if (wanted === null) { res.setHeader('Content-Range', `bytes */${file.size}`); json(res, 416, { error: '요청한 범위가 파일 밖입니다.' }); return; }
    const { start, end } = wanted ?? { start: 0, end: file.size - 1 };
    res.writeHead(wanted ? 206 : 200, {
      'Content-Type': image ?? 'application/octet-stream', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
      ...(wanted ? { 'Content-Range': `bytes ${start}-${end}/${file.size}` } : {}),
      'Content-Disposition': `${image ? 'inline' : 'attachment'}; filename="attachment"; filename*=UTF-8''${name}`,
      // The owner's browser may keep it; nothing between may.
      'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'none'",
    });
    if (req.method === 'HEAD' || end < start) { res.end(); return; }
    await pipeline(handle.createReadStream({ start, end, autoClose: false }), res);
  } finally { await handle.close(); }
}

/** Answers `/api/todos…`; false for any other path. */
export async function todoRoute(req: IncomingMessage, res: ServerResponse, url: URL, path: string, todos: TodoBackend | undefined,
  json: (res: ServerResponse, status: number, body: unknown) => void): Promise<boolean> {
  if (path !== '/api/todos' && !path.startsWith('/api/todos/')) return false;
  if (!todos) { json(res, 503, { error: '할 일을 사용할 수 없습니다.' }); return true; }
  if (req.method === 'GET' && path === '/api/todos') { json(res, 200, todos.overview()); return true; }
  if (req.method === 'GET' && path === '/api/todos/completed') {
    const projectId = url.searchParams.get('projectId') ?? undefined, labelId = url.searchParams.get('labelId') ?? undefined, before = url.searchParams.get('before') ?? undefined;
    if (projectId !== undefined && !ID.test(projectId)) throw new TowerError('invalid', '프로젝트 id가 올바르지 않습니다.');
    if (labelId !== undefined && !ID.test(labelId)) throw new TowerError('invalid', '라벨 id가 올바르지 않습니다.');
    if (before !== undefined && before.length > 60) throw new TowerError('invalid', '완료 목록 커서가 올바르지 않습니다.');
    json(res, 200, todos.completed({ projectId, labelId, before, limit: number(url.searchParams.get('limit')) }));
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
  if (path === '/api/todos/uploads' || UPLOAD.test(path) || FILE.test(path)) return todoFileRoute(req, res, url, path, todos, json);
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

/** Uploads (resumable, as the chat's) and attachments. The server answers JSON only to these, never to the bytes themselves. */
async function todoFileRoute(req: IncomingMessage, res: ServerResponse, url: URL, path: string, todos: TodoBackend,
  json: (res: ServerResponse, status: number, body: unknown) => void): Promise<boolean> {
  const files = todos.files;
  if (!files) { req.resume(); json(res, 503, { error: '첨부 파일을 사용할 수 없습니다.' }); return true; }
  const file = FILE.exec(path);
  if (file) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: '허용되지 않은 요청입니다.' }); return true; }
    if (!ID.test(file[1])) throw new TowerError('not-found', '첨부 파일을 찾을 수 없습니다.');
    await sendFile(req, res, files, file[1], url.searchParams.get('inline') === '1', json);
    return true;
  }
  if (path === '/api/todos/uploads') {
    if (req.method !== 'POST') { json(res, 405, { error: '허용되지 않은 요청입니다.' }); return true; }
    const body = await readJson(req, 8 * 1024);
    if (Object.keys(body).some(key => !['taskId', 'commentId', 'name', 'mimeType', 'size'].includes(key))) throw new TowerError('invalid', '첨부 파일 형식이 올바르지 않습니다.');
    json(res, 201, await files.startUpload(body as unknown as Parameters<typeof files.startUpload>[0]));
    return true;
  }
  const [, id, action] = UPLOAD.exec(path)!;
  if (!UUID.test(id)) throw new TowerError('not-found', '업로드를 찾을 수 없습니다. 파일을 다시 첨부하세요.');
  if (req.method === 'GET' && !action) { json(res, 200, { offset: await files.uploadOffset(id) }); return true; }
  if (req.method !== 'POST') { json(res, 405, { error: '허용되지 않은 요청입니다.' }); return true; }
  if (action) {
    if (Object.keys(await readJson(req, 1024)).length) throw new TowerError('invalid', '요청 본문은 비워 두세요.');
    if (action === 'cancel') { await files.cancelUpload(id); json(res, 200, { ok: true }); return true; }
    const attached = await atOffset(json, res, () => files.completeUpload(id));
    if (attached) json(res, 200, attached);
    return true;
  }
  try {
    if (req.headers['content-type'] !== 'application/octet-stream') throw new TowerError('unsupported', '파일 내용(application/octet-stream)을 보내세요.');
    const raw = url.searchParams.get('offset');
    if (raw === null || !/^\d{1,15}$/.test(raw)) throw new TowerError('invalid', '업로드 위치가 올바르지 않습니다.');
    const result = await atOffset(json, res, () => files.appendUpload(id, Number(raw), req.iterator({ destroyOnReturn: false })));
    if (result) json(res, 200, result);
  } finally { req.resume(); }
  return true;
}
