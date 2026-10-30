import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { TowerError } from '../../shared/errors.js';
import { TodoRequestSchema, type TodoRequest } from '../../shared/todo/ops.js';
import type { TodoAgent, TodoChanges, TodoCommentAuthor, TodoCompletedPage, TodoGitHubBinding, TodoGitHubImport, TodoOverview, TodoTask, TodoTaskDetail } from '../../shared/todo/types.js';
import type { TodoFiles } from '../todo/files.js';
import { readJson, UUID } from './requests.js';
import { byteRange } from './sinks.js';

/** The owner's todos as this Tower's own pages use them. A controlling computer has no route to these. */
export interface TodoBackend {
  overview(): TodoOverview;
  detail(id: string): TodoTaskDetail;
  completed(input: { projectId?: string; labelId?: string; before?: string; since?: string; until?: string; limit?: number }): TodoCompletedPage;
  search(query: string, input: { completed?: boolean; limit?: number }): TodoTask[];
  /** `by` is who sent it: comments it creates are recorded as theirs. */
  apply(request: TodoRequest, by: TodoCommentAuthor): TodoChanges;
  /** Starts a todo's issue master with the owner's first message (server/todo/agents.ts). */
  startAgent?(id: string, text: string): Promise<TodoAgent>;
  /** Records a session an issue master made (POST /api/sessions on its behalf) in its todo's family. */
  issueSession?(taskId: string, sessionId: string): void;
  /** An Auto Prompt job an issue master sent: a new session it makes joins that todo's family. */
  issueJob?(taskId: string, jobId: string): void;
  /** The sessions of open issue masters' families, with their todo. */
  agentSessions?(): Record<string, { taskId: string; title: string }>;
  /** The empty issue chat's first-message buttons: the saved list, or null for the defaults. */
  chatPresets?(): string[] | null;
  /** Saves the owner's list (`null` goes back to the defaults); refuses an invalid one whole. */
  setChatPresets?(presets: unknown): string[] | null;
  /**
   * GitHub links of projects and sections (server/todo/github/sync.ts); only the owner's page reaches them, except
   * `importIssue`, which adds a todo as the ops route does.
   */
  github?: {
    check(repo: string): Promise<{ login: string; repo: string; private: boolean; canPush: boolean }>;
    link(input: { kind: 'project' | 'section'; id: string; repo: string }): Promise<TodoGitHubBinding>;
    unlink(id: string): void;
    importIssue(request: TodoRequest, taskId: string): Promise<TodoGitHubImport>;
  };
  /** Attachments; absent where they cannot be kept. */
  files?: Pick<TodoFiles, 'startUpload' | 'uploadOffset' | 'appendUpload' | 'completeUpload' | 'cancelUpload' | 'openFile'>;
}

export const TODO_OPS_PATH = '/api/todos/ops';
export const TODO_IMPORT_PATH = '/api/todos/github/import';
export const CHAT_PRESETS_PATH = '/api/todos/chat-presets';
/** A request of 100 operations with long descriptions fits; nothing the page sends comes near it otherwise. */
const MAX_TODO_BODY = 4 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const number = (value: string | null) => value === null || !/^\d{1,4}$/.test(value) ? undefined : Number(value);
const UPLOAD = /^\/api\/todos\/uploads\/([^/]+?)(?:\/(complete|cancel))?$/;
const FILE = /^\/api\/todos\/files\/([^/]+)$/;
const AGENT = /^\/api\/todos\/tasks\/([^/]+)\/agent$/;
const GITHUB_BINDING = /^\/api\/todos\/github\/bindings\/([^/]+)$/;
const MAX_AGENT_TEXT = 32_000;


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
 * Sends an attachment, or the byte range asked for. Always as a download that cannot run in Tower's origin, except one
 * asked for inline that can be shown (see TodoFiles.openFile): an image whose bytes are one, or video or audio to play.
 */
async function sendFile(req: IncomingMessage, res: ServerResponse, files: NonNullable<TodoBackend['files']>, id: string, inline: boolean, json: (res: ServerResponse, status: number, body: unknown) => void): Promise<void> {
  const opened = await files.openFile(id, inline);
  const { file, handle } = opened;
  try {
    const name = encodeURIComponent(file.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    const wanted = byteRange(req.headers.range, file.size);
    if (wanted === null) { res.setHeader('Content-Range', `bytes */${file.size}`); json(res, 416, { error: '요청한 범위가 파일 밖입니다.' }); return; }
    const { start, end } = wanted ?? { start: 0, end: file.size - 1 };
    res.writeHead(wanted ? 206 : 200, {
      'Content-Type': opened.inline ?? 'application/octet-stream', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
      ...(wanted ? { 'Content-Range': `bytes ${start}-${end}/${file.size}` } : {}),
      'Content-Disposition': `${opened.inline ? 'inline' : 'attachment'}; filename="attachment"; filename*=UTF-8''${name}`,
      // The owner's browser may keep it; nothing between may.
      'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'none'",
    });
    if (req.method === 'HEAD' || end < start) { res.end(); return; }
    await pipeline(handle.createReadStream({ start, end, autoClose: false }), res);
  } finally { await handle.close(); }
}

/**
 * Answers `/api/todos…`; false for any other path. `owner` says the request is the owner's own page (see
 * server/http/server.ts), which starting an issue master and saving the chat presets need, and which makes the comments
 * a change creates the owner's; any other caller here (the master, a local agent) is an agent.
 */
export async function todoRoute(req: IncomingMessage, res: ServerResponse, url: URL, path: string, todos: TodoBackend | undefined,
  json: (res: ServerResponse, status: number, body: unknown) => void, owner = false): Promise<boolean> {
  if (path !== '/api/todos' && !path.startsWith('/api/todos/')) return false;
  if (!todos) { json(res, 503, { error: '할 일을 사용할 수 없습니다.' }); return true; }
  if (req.method === 'GET' && path === '/api/todos') { json(res, 200, todos.overview()); return true; }
  if (req.method === 'GET' && path === '/api/todos/completed') {
    const projectId = url.searchParams.get('projectId') ?? undefined, labelId = url.searchParams.get('labelId') ?? undefined, before = url.searchParams.get('before') ?? undefined;
    if (projectId !== undefined && !ID.test(projectId)) throw new TowerError('invalid', '프로젝트 id가 올바르지 않습니다.');
    if (labelId !== undefined && !ID.test(labelId)) throw new TowerError('invalid', '라벨 id가 올바르지 않습니다.');
    if (before !== undefined && before.length > 60) throw new TowerError('invalid', '완료 목록 커서가 올바르지 않습니다.');
    // The store checks a bound's form (a time as `toISOString` writes it).
    const since = url.searchParams.get('since') ?? undefined, until = url.searchParams.get('until') ?? undefined;
    json(res, 200, todos.completed({ projectId, labelId, before, since, until, limit: number(url.searchParams.get('limit')) }));
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
  if (req.method === 'GET' && path === '/api/todos/agents/sessions') {
    if (!todos.agentSessions) { json(res, 503, { error: '이슈 마스터를 사용할 수 없습니다.' }); return true; }
    json(res, 200, { sessions: todos.agentSessions() });
    return true;
  }
  if (path === CHAT_PRESETS_PATH && (req.method === 'GET' || req.method === 'POST')) {
    if (!todos.chatPresets || !todos.setChatPresets) { json(res, 503, { error: '채팅 프리셋을 사용할 수 없습니다.' }); return true; }
    if (req.method === 'GET') { json(res, 200, { presets: todos.chatPresets() }); return true; }
    if (!owner) { json(res, 403, { error: '채팅 프리셋은 소유자의 화면에서만 바꿀 수 있습니다.' }); return true; }
    const body = await readJson(req, 64 * 1024);
    if (Object.keys(body).some(key => key !== 'presets') || !('presets' in body)) throw new TowerError('invalid', '채팅 프리셋 형식이 올바르지 않습니다.');
    json(res, 200, { presets: todos.setChatPresets(body.presets) });
    return true;
  }
  const agent = AGENT.exec(path);
  if (req.method === 'POST' && agent) {
    if (!owner) { json(res, 403, { error: '이슈 마스터는 소유자의 화면에서만 시작할 수 있습니다.' }); return true; }
    if (!ID.test(agent[1])) throw new TowerError('invalid', '작업 id가 올바르지 않습니다.');
    const body = await readJson(req, 256 * 1024);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (Object.keys(body).some(key => key !== 'text') || !text || text.length > MAX_AGENT_TEXT) throw new TowerError('invalid', `첫 메시지는 1자 이상, ${MAX_AGENT_TEXT.toLocaleString('en-US')}자 이하여야 합니다.`);
    if (!todos.startAgent) { json(res, 503, { error: '이슈 마스터를 사용할 수 없습니다.' }); return true; }
    json(res, 202, { agent: await todos.startAgent(agent[1], text) });
    return true;
  }
  if (req.method === 'POST' && path === TODO_IMPORT_PATH) {
    // Adding a todo whose title is an issue's address: open to whoever may add todos, as the ops route is.
    const body = await readJson(req, MAX_TODO_BODY);
    const parsed = TodoRequestSchema.safeParse(body.request);
    if (!parsed.success || typeof body.taskId !== 'string' || !ID.test(body.taskId) || Object.keys(body).some(key => key !== 'request' && key !== 'taskId')) throw new TowerError('invalid', '가져오기 요청 형식이 올바르지 않습니다.');
    if (!todos.github) { json(res, 503, { error: 'GitHub 동기화를 사용할 수 없습니다.' }); return true; }
    json(res, 200, await upstream(todos.github.importIssue(parsed.data, body.taskId)));
    return true;
  }
  if (path.startsWith('/api/todos/github/')) return githubRoute(req, res, path, todos, json, owner);
  if (path === '/api/todos/uploads' || UPLOAD.test(path) || FILE.test(path)) return todoFileRoute(req, res, url, path, todos, json);
  if (req.method === 'POST' && path === TODO_OPS_PATH) {
    const parsed = TodoRequestSchema.safeParse(await readJson(req, MAX_TODO_BODY));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new TowerError('invalid', `할 일 변경 형식이 올바르지 않습니다: ${issue ? `${issue.path.join('.')} ${issue.message}` : ''}`.trim());
    }
    json(res, 200, todos.apply(parsed.data, owner ? 'owner' : 'agent'));
    return true;
  }
  json(res, 404, { error: 'API 경로를 찾을 수 없습니다.' });
  return true;
}

/** GitHub's own refusals are told as they came, as an upstream problem. */
const upstream = <T>(work: Promise<T>) => work.catch(error => { throw error instanceof TowerError ? error : new TowerError('upstream', error instanceof Error ? error.message : String(error)); });

/** Linking projects and sections to GitHub repositories: the owner's page only, never an agent. */
async function githubRoute(req: IncomingMessage, res: ServerResponse, path: string, todos: TodoBackend,
  json: (res: ServerResponse, status: number, body: unknown) => void, owner: boolean): Promise<boolean> {
  if (!owner) { req.resume(); json(res, 403, { error: 'GitHub 연결은 소유자의 화면에서만 바꿀 수 있습니다.' }); return true; }
  const github = todos.github;
  if (!github) { req.resume(); json(res, 503, { error: 'GitHub 동기화를 사용할 수 없습니다.' }); return true; }
  const repoOf = (body: Record<string, unknown>) => typeof body.repo === 'string' ? body.repo.trim() : '';
  if (req.method === 'POST' && path === '/api/todos/github/check') {
    const body = await readJson(req, 4 * 1024);
    json(res, 200, await upstream(github.check(repoOf(body))));
    return true;
  }
  if (req.method === 'POST' && path === '/api/todos/github/bindings') {
    const body = await readJson(req, 4 * 1024);
    const kind = body.kind, id = body.id;
    if ((kind !== 'project' && kind !== 'section') || typeof id !== 'string' || !ID.test(id)) throw new TowerError('invalid', '연결할 프로젝트나 섹션이 올바르지 않습니다.');
    json(res, 200, { binding: await upstream(github.link({ kind, id, repo: repoOf(body) })) });
    return true;
  }
  const binding = GITHUB_BINDING.exec(path);
  if (req.method === 'DELETE' && binding) {
    req.resume();
    github.unlink(binding[1]);
    json(res, 200, { unlinked: true });
    return true;
  }
  req.resume();
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
