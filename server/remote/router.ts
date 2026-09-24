import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Http2ServerRequest, Http2ServerResponse } from 'node:http2';
import type { Backend } from '../http/server.js';
import type { RequestContext } from '../http/request-context.js';
import { approvalResponse, ATTACHMENT_BODY_BYTES, errorDisposition, errorStatus, httpError, parseAutoPrompt, parseCreateSession, parseMessage, readJson, UUID } from '../http/requests.js';
import { publicSnapshot } from '../http/public-snapshot.js';
import { SnapshotStream } from '../http/snapshot-stream.js';
import { SseClient } from '../http/sse-client.js';
import { isImageAttachment } from '../../shared/attachments.js';
import { normalizeSessionTitle } from '../stores/session-titles.js';
import { assertWorkspace, createWorkspaceDirectory, listWorkspaceTree, MAX_WORKSPACE_FILE_BYTES, readWorkspaceFile, saveWorkspaceFile } from '../workspace-files.js';
import type { WorkspaceTerminalBackend } from '../workspace-terminals.js';
import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AutoPromptJob, RunOrigin, Session } from '../../shared/types.js';
import type { RemoteExclusionStore } from './exclusions.js';
import { remoteJob, remoteJobVisible, remotePage, remoteRepository, remoteRun, remoteSession, remoteSessionIds, remoteSnapshot, type RemoteScope } from './visibility.js';
import type { RepositoryAction } from '../../shared/repositories.js';

type Request = IncomingMessage | Http2ServerRequest;
// The HTTP/2 compatibility response offers the same calls as an HTTP/1 response.
type Reply = ServerResponse;
/** A paired controller, as its authenticated link identified it. */
export interface RemotePrincipal { controllerId: string }

export interface RemoteRouterOptions {
  backend: Backend;
  exclusions: RemoteExclusionStore;
  /** This computer's shells; a controller opens and joins them in folders it can see. */
  terminals?: WorkspaceTerminalBackend;
  /** Mutating requests one controller may make per minute. */
  mutationsPerMinute?: number;
}

const NOT_FOUND = '찾을 수 없습니다.';
const FOLDER_NOT_FOUND = '작업 폴더를 찾을 수 없습니다.';
const notFound = () => httpError(404, NOT_FOUND);
const REQUEST_ID_HEADER = 'x-tower-request-id';

/**
 * Serves one machine's Tower to its paired controllers. Only the requests listed here exist for them; each
 * answers with remote views that leave out excluded folders and coordinator conversations. Local management
 * (accounts, pairing, the exclusion list) has no route here at all.
 */
export function createRemoteRouter({ backend, exclusions, terminals, mutationsPerMinute = 60 }: RemoteRouterOptions) {
  const streams = new Map<string, { stream: SnapshotStream; clients: Set<SseClient> }>();
  /** Terminal output streams to controllers; they end when the sharing list changes (the shells go on). */
  const shellStreams = new Set<Reply>();
  const rates = new Map<string, { count: number; at: number }>();
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  /** Resolves where every folder in the snapshot really is, so views are exact instead of hiding the unresolved. */
  const prepare = () => {
    const snapshot = backend.snapshot();
    const paths = [...snapshot.sessions.map(item => item.cwd), ...(snapshot.groups ?? []).map(item => item.cwd),
      ...(snapshot.autoPrompts ?? []).flatMap(item => [item.cwd, item.decision?.cwd].filter((path): path is string => Boolean(path))),
      ...(snapshot.repositories ?? []).flatMap(item => [item.cwd, item.root])];
    return exclusions.prepare(paths);
  };
  const publish = () => {
    if (scheduled || !streams.size) return;
    scheduled = setTimeout(() => {
      void prepare().catch(() => {}).then(() => {
        scheduled = undefined;
        for (const [controllerId, entry] of [...streams]) {
          // A view that cannot be built safely (for example while the worker is being replaced) ends that stream only.
          try { entry.stream.publish(); } catch { disconnect(controllerId); }
        }
      });
    }, 200);
  };
  const unsubscribe = backend.subscribe(publish);
  // A frame built or queued under the old list must never go out: end every stream; controllers reconnect to a fresh view.
  const listChanged = () => {
    for (const id of [...streams.keys()]) disconnect(id);
    for (const res of [...shellStreams]) res.end();
    shellStreams.clear();
  };
  exclusions.on('change', listChanged);
  exclusions.on('resolved', publish);
  const heartbeat = setInterval(() => { for (const entry of streams.values()) for (const client of entry.clients) client.heartbeat(); }, 15_000);
  heartbeat.unref();
  // Folder locations are checked again from time to time, so a symlink pointed elsewhere is noticed without other activity.
  const recheck = setInterval(publish, 30_000);
  recheck.unref();
  const disconnect = (controllerId: string) => {
    const entry = streams.get(controllerId);
    if (!entry) return;
    streams.delete(controllerId);
    for (const client of entry.clients) client.end();
    entry.stream.close();
  };

  const scope = (): RemoteScope => {
    const coordinators = backend.coordinators?.();
    // A worker that cannot name its coordinator conversations cannot keep them private; serve nothing.
    if (!coordinators) throw Object.assign(httpError(503, '그 컴퓨터의 실행 작업자가 업데이트를 기다리고 있습니다. 잠시 후 다시 시도하세요.'), { disposition: 'not-admitted' });
    return { matcher: exclusions.matcher(), coordinators };
  };
  const view = (principal: RemotePrincipal) => remoteSnapshot(publicSnapshot(backend.snapshot()), scope(), principal.controllerId);
  const visibleSessions = (current: RemoteScope) => remoteSessionIds(backend.snapshot().sessions, current);
  const session = (id: string): Session => {
    const current = scope();
    const found = backend.session?.(id);
    if (!found || !visibleSessions(current).has(found.id)) throw notFound();
    return found;
  };
  /**
   * A decision about one conversation looks at its folders again now, not at an earlier look that a
   * re-pointed symlink could have made stale. Used before acting on it and again right before answering.
   */
  const confirm = async (id: string): Promise<Session> => {
    const found = session(id);
    const chain: string[] = [];
    for (let current: Session | undefined = found, depth = 0; current && depth < 32; current = current.parentId ? backend.session?.(current.parentId) : undefined, depth++) chain.push(current.cwd);
    await exclusions.prepare(chain, { fresh: true });
    return session(id);
  };
  const stillVisible = async (id: string) => { await prepare(); await confirm(id); };
  /** The same fresh look for an Auto Prompt job: every folder and conversation it touched. */
  const jobVisible = async (job: AutoPromptJob, principal: RemotePrincipal): Promise<RemoteScope | undefined> => {
    const sessions = [job.decision?.sessionId, job.sessionId].flatMap(id => { const found = id ? backend.session?.(id) : undefined; return found ? [found.cwd] : []; });
    await exclusions.prepare([job.cwd, job.decision?.cwd, ...sessions].filter((path): path is string => Boolean(path)), { fresh: true });
    const current = scope();
    return remoteJobVisible(job, current, visibleSessions(current), principal.controllerId) ? current : undefined;
  };
  const run = async (id: string) => {
    const current = scope();
    const snapshot = backend.snapshot();
    const found = snapshot.runs.find(item => item.id === id);
    if (!found || !remoteSessionIds(snapshot.sessions, current).has(found.sessionId)) throw notFound();
    await confirm(found.sessionId);
    return found;
  };
  const folderAllowed = async (cwd: string) => {
    if (!cwd.startsWith('/') || await exclusions.excludesNow(cwd)) throw httpError(404, FOLDER_NOT_FOUND);
  };
  /** Auto Prompt only takes folders Tower lists; to a controller, one it cannot see is simply not there. */
  const listedFolder = async (cwd: string) => {
    await folderAllowed(cwd);
    const view = remoteSnapshot(backend.snapshot(), scope());
    if (!view.sessions.some(item => item.cwd === cwd) && !view.groups?.some(item => item.cwd === cwd)) throw httpError(404, FOLDER_NOT_FOUND);
  };
  const context = (principal: RemotePrincipal, requestId?: string): RequestContext => ({ origin: { kind: 'owner', controllerId: principal.controllerId } satisfies RunOrigin, ...(requestId ? { requestId } : {}) });
  const requestId = (req: Request) => {
    const value = req.headers[REQUEST_ID_HEADER];
    if (typeof value !== 'string' || !UUID.test(value)) throw httpError(400, '원격 요청에는 요청 ID가 필요합니다.');
    return value.toLowerCase();
  };
  const json = (res: Reply, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  /** A shell a controller may use: one Tower knows the folder and opener of, in a folder shared right now. */
  const shell = async (id: string) => {
    const found = (await terminals?.list?.())?.find(item => item.id === id && !item.exited);
    if (!found || await exclusions.excludesNow(found.cwd)) throw httpError(404, '터미널을 찾을 수 없습니다. 새 터미널을 여세요.');
    return found;
  };
  /** A path inside a shared folder that is not itself in an excluded folder. */
  const sharedPath = async (cwd: unknown, path: unknown) => {
    if (typeof cwd !== 'string') throw httpError(404, FOLDER_NOT_FOUND);
    await listedFolder(cwd);
    if (typeof path === 'string' && path && await exclusions.excludesNow(join(cwd, path))) throw httpError(404, '파일을 찾을 수 없습니다.');
    return cwd;
  };
  const limit = (principal: RemotePrincipal) => {
    const now = Date.now();
    const rate = rates.get(principal.controllerId);
    if (!rate || now - rate.at > 60_000) rates.set(principal.controllerId, { count: 1, at: now });
    else if (++rate.count > mutationsPerMinute) throw httpError(429, '요청이 너무 많습니다. 잠시 후 다시 시도하세요.');
  };

  const events = (req: Request, res: Reply, principal: RemotePrincipal, patches: boolean) => {
    scope();
    let entry = streams.get(principal.controllerId);
    if (!entry) {
      entry = { stream: new SnapshotStream(() => view(principal)), clients: new Set() };
      streams.set(principal.controllerId, entry);
    }
    const current = entry;
    if (current.clients.size >= 8) throw httpError(503, '열린 원격 연결이 너무 많습니다.');
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const client = new SseClient(res, () => {
      current.clients.delete(client);
      current.stream.detach(client);
      if (!current.clients.size && streams.get(principal.controllerId) === current) streams.delete(principal.controllerId);
    });
    current.clients.add(client);
    current.stream.attach(client, patches, 'retry: 2000\n\n');
    req.once('close', () => client.end());
  };

  const route = async (req: Request, res: Reply, principal: RemotePrincipal, url: URL): Promise<void> => {
    const path = decodeURIComponent(url.pathname);
    const method = req.method;
    if (method === 'GET' && path === '/api/snapshot') return json(res, 200, view(principal));
    if (method === 'GET' && path === '/api/events') return events(req, res, principal, url.searchParams.get('patch') === '1');
    const detail = path.match(/^\/api\/sessions\/([^/]+)$/);
    if (method === 'GET' && detail) {
      const found = await confirm(detail[1]);
      const beforeValue = url.searchParams.get('before');
      const before = beforeValue === null ? undefined : Number(beforeValue);
      const pageSize = Number(url.searchParams.get('limit') || 100);
      if ((before !== undefined && (!Number.isSafeInteger(before) || before < 0)) || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) throw httpError(400, '올바르지 않은 페이지 요청입니다.');
      const page = await backend.detail(found.id, before, pageSize);
      if (!page) throw notFound();
      await stillVisible(found.id);
      return json(res, 200, remotePage(page));
    }
    const attachment = path.match(/^\/api\/attachments\/([^/]+)$/);
    if ((method === 'GET' || method === 'HEAD') && attachment) {
      if (!backend.attachment) throw notFound();
      const { metadata, content, sessionId } = await backend.attachment(attachment[1]).catch(() => { throw notFound(); });
      // A worker too old to say whose file this is cannot prove it is shared.
      if (!sessionId) throw notFound();
      await confirm(sessionId);
      const inline = isImageAttachment(metadata.mimeType);
      res.writeHead(200, {
        'Content-Type': inline ? metadata.mimeType : 'application/octet-stream', 'Content-Length': content.length, 'Cache-Control': 'no-store',
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(metadata.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
        'Content-Security-Policy': "sandbox; default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(method === 'HEAD' ? undefined : content);
      return;
    }
    // Workspace answers are checked against the sharing list again once they are ready: it may have changed
    // while a folder or file was being read.
    if (method === 'GET' && path === '/api/workspace/tree') {
      const at = url.searchParams.get('path') ?? '';
      const cwd = await sharedPath(url.searchParams.get('cwd'), at);
      const shared = async (entry: string) => !await exclusions.excludesNow(join(cwd, entry));
      // Excluded folders inside a shared one are left out of its listing, and do not count toward its limit.
      const listed = await listWorkspaceTree(cwd, at, backend.snapshot(), shared);
      await sharedPath(cwd, at);
      const kept = await Promise.all(listed.entries.map(entry => shared(entry.path)));
      return json(res, 200, { entries: listed.entries.filter((_, index) => kept[index]) });
    }
    if (method === 'GET' && path === '/api/workspace/file') {
      const cwd = await sharedPath(url.searchParams.get('cwd'), url.searchParams.get('path'));
      const file = await readWorkspaceFile(cwd, url.searchParams.get('path'), backend.snapshot());
      await sharedPath(cwd, url.searchParams.get('path'));
      return json(res, 200, file);
    }
    const terminal = path.match(/^\/api\/workspace\/terminals\/([0-9a-f-]{36})\/(events|input|resize|close)$/);
    if (method === 'GET' && path === '/api/workspace/terminals') {
      const cwd = await sharedPath(url.searchParams.get('cwd'), '');
      const root = await realpath(cwd).catch(() => cwd);
      const shells = (await terminals?.list?.()) ?? [];
      await sharedPath(cwd, '');
      // Another controller is not named: which computers control this one is not a controller's business.
      return json(res, 200, { terminals: shells.filter(item => item.cwd === root && !item.exited).map(item => ({ id: item.id, openedAt: item.openedAt,
        origin: item.opener === principal.controllerId ? 'self' : item.opener === 'local' ? 'computer' : 'controller' })) });
    }
    if (method === 'GET' && terminal?.[2] === 'events') {
      if (!terminals) throw notFound();
      const cursor = req.headers['last-event-id'];
      if (Array.isArray(cursor)) throw httpError(400, '터미널 출력 위치가 올바르지 않습니다.');
      // Registered before the check, so a change to the sharing list from here on ends this stream.
      shellStreams.add(res);
      res.once('close', () => shellStreams.delete(res));
      await shell(terminal[1]);
      await terminals.attach(terminal[1], res, cursor);
      return;
    }
    const autoPrompt = path.match(/^\/api\/auto-prompts\/([a-f\d-]+)(\/cancel)?$/i);
    if (method === 'GET' && autoPrompt && !autoPrompt[2] && UUID.test(autoPrompt[1])) {
      const job = backend.getAutoPrompt?.(autoPrompt[1]);
      const current = job && await jobVisible(job, principal);
      if (!job || !current) throw notFound();
      return json(res, 200, { job: remoteJob(job, principal.controllerId, current.matcher.revision) });
    }
    if (method !== 'POST') throw notFound();
    // Keystrokes have their own per-shell budget.
    if (terminal?.[2] === 'input' || terminal?.[2] === 'resize') {
      if (!terminals) throw notFound();
      await shell(terminal[1]);
      const body = await readJson(req);
      if (terminal[2] === 'input') { if (Object.keys(body).some(key => key !== 'data')) throw httpError(400, '터미널 요청 형식이 올바르지 않습니다.'); await terminals.input(terminal[1], body.data); }
      else { if (Object.keys(body).some(key => key !== 'cols' && key !== 'rows')) throw httpError(400, '터미널 요청 형식이 올바르지 않습니다.'); await terminals.resize(terminal[1], body.cols, body.rows); }
      return json(res, 200, { ok: true });
    }
    limit(principal);
    if (terminal?.[2] === 'close') {
      if (!terminals) throw notFound();
      await shell(terminal[1]);
      if (Object.keys(await readJson(req)).length) throw httpError(400, '터미널 요청 형식이 올바르지 않습니다.');
      await terminals.close(terminal[1]);
      return json(res, 200, { ok: true });
    }
    if (path === '/api/workspace/terminals') {
      if (!terminals?.list) throw notFound();
      const body = await readJson(req);
      if (Object.keys(body).some(key => !['cwd', 'cols', 'rows'].includes(key))) throw httpError(400, '폴더와 터미널 크기만 지정할 수 있습니다.');
      const id = requestId(req);
      const cwd = await sharedPath(body.cwd, '');
      // A shell a controller opens must be one every controller can find and this computer can close.
      if (await terminals.list() === undefined) throw Object.assign(httpError(503, '그 컴퓨터의 터미널 호스트가 이전 버전이라 여기서 터미널을 열 수 없습니다. 그 컴퓨터에서 열린 터미널이 모두 닫히면 새 버전으로 바뀝니다.'), { disposition: 'not-admitted' });
      const root = await assertWorkspace(cwd, backend.snapshot());
      return json(res, 200, await terminals.create(root, body.cols, body.rows, { opener: principal.controllerId, requestId: id }));
    }
    if (path === '/api/workspace/file') {
      const body = await readJson(req, 6 * MAX_WORKSPACE_FILE_BYTES + 16 * 1024);
      await sharedPath(body.cwd, body.path);
      return json(res, 200, await saveWorkspaceFile(body, backend.snapshot()));
    }
    if (path === '/api/workspace/directory') {
      const body = await readJson(req);
      const cwd = await sharedPath(body.cwd, body.path);
      // A folder made by a request sent again after its answer was lost is already there: that is success.
      try { return json(res, 200, await createWorkspaceDirectory(body, backend.snapshot())); }
      catch (error) {
        if (errorStatus(error) === 409 && typeof body.path === 'string' && await stat(join(cwd, body.path)).then(info => info.isDirectory(), () => false)) return json(res, 200, { path: body.path });
        throw error;
      }
    }
    if (path === '/api/sessions') {
      const input = parseCreateSession(await readJson(req));
      const id = requestId(req);
      await folderAllowed(input.cwd);
      if (!backend.createSession) throw httpError(503, '새 세션을 생성할 수 없습니다.');
      const result = await backend.createSession(input, context(principal, id));
      // A retry answers with what the first request made; that must still be shared.
      if (await exclusions.excludesNow(result.session.cwd)) throw notFound();
      return json(res, 202, { session: remoteSession(result.session), run: remoteRun(result.run) });
    }
    const message = path.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (message) {
      const found = await confirm(message[1]);
      const body = parseMessage(await readJson(req, ATTACHMENT_BODY_BYTES));
      const created = await backend.enqueue(found.id, body.prompt, body.attachments, context(principal, requestId(req)));
      await stillVisible(found.id);
      return json(res, 202, { run: remoteRun(created) });
    }
    const title = path.match(/^\/api\/sessions\/([^/]+)\/title$/);
    if (title) {
      const found = await confirm(title[1]);
      const value = normalizeSessionTitle((await readJson(req)).title);
      if (!backend.setTitle) throw httpError(503, '제목을 저장할 수 없습니다.');
      const updated = await backend.setTitle(found.id, value);
      if (!updated) throw notFound();
      await stillVisible(found.id);
      return json(res, 200, { session: remoteSession(updated) });
    }
    const closed = path.match(/^\/api\/sessions\/([^/]+)\/(close|reopen)$/);
    if (closed) {
      const found = await confirm(closed[1]);
      await readJson(req);
      if (!backend.setClosed) throw httpError(503, '세션 표시 상태를 저장할 수 없습니다.');
      const updated = await backend.setClosed(found.id, closed[2] === 'close');
      if (!updated) throw notFound();
      await stillVisible(found.id);
      return json(res, 200, { session: remoteSession(updated) });
    }
    const approval = url.pathname.match(/^\/api\/runs\/([^/]+)\/approvals\/([^/]+)$/);
    if (approval) {
      const found = await run(decodeURIComponent(approval[1]));
      const response = approvalResponse(await readJson(req));
      if (response === undefined) throw httpError(400, '승인 응답 형식이 올바르지 않습니다. 실행 내용은 변경할 수 없습니다.');
      if (!backend.respondToApproval) throw httpError(503, '이 실행기의 승인 요청을 처리할 수 없습니다.');
      const answered = await backend.respondToApproval(found.id, decodeURIComponent(approval[2]), response);
      await stillVisible(found.sessionId);
      return json(res, 200, { run: remoteRun(answered) });
    }
    const runAction = path.match(/^\/api\/runs\/([^/]+)\/(steer|cancel|dismiss)$/);
    if (runAction) {
      const found = await run(runAction[1]);
      const body = await readJson(req);
      if (runAction[2] === 'steer') {
        if (Object.keys(body).length) throw httpError(400, '끼워넣기 요청의 내용은 변경할 수 없습니다.');
        if (!backend.steerRun) throw httpError(503, '이 실행기는 요청 끼워넣기를 지원하지 않습니다.');
        const steered = await backend.steerRun(found.id);
        await stillVisible(found.sessionId);
        return json(res, 200, { run: remoteRun(steered) });
      }
      if (runAction[2] === 'cancel') { await backend.cancel(found.id); return json(res, 200, { ok: true }); }
      if (!backend.dismiss) throw httpError(503, '실패 기록을 지울 수 없습니다.');
      await backend.dismiss(found.id);
      return json(res, 200, { ok: true });
    }
    if (path === '/api/auto-prompts') {
      const request = parseAutoPrompt(await readJson(req, ATTACHMENT_BODY_BYTES));
      if (request.cwd) await listedFolder(request.cwd);
      if (!backend.startAutoPrompt) throw httpError(503, 'Auto Prompt를 현재 사용할 수 없습니다.');
      const job = await backend.startAutoPrompt(request, context(principal, request.requestId.toLowerCase()));
      // A retry of a finished request answers with that job; it is shown only while everything it touched is shared.
      const current = await jobVisible(job, principal);
      if (!current) throw notFound();
      return json(res, 202, { job: remoteJob(job, principal.controllerId, current.matcher.revision) });
    }
    if (autoPrompt && autoPrompt[2] && UUID.test(autoPrompt[1])) {
      if (Object.keys(await readJson(req)).length) throw httpError(400, '취소 요청 본문은 비워 두세요.');
      const job = backend.getAutoPrompt?.(autoPrompt[1]);
      if (!job || !await jobVisible(job, principal)) throw notFound();
      if (!backend.cancelAutoPrompt) throw httpError(503, 'Auto Prompt를 현재 사용할 수 없습니다.');
      const cancelled = await backend.cancelAutoPrompt(job.id);
      const after = await jobVisible(cancelled, principal);
      if (!after) throw notFound();
      return json(res, 200, { job: remoteJob(cancelled, principal.controllerId, after.matcher.revision) });
    }
    if (path === '/api/repositories') {
      const body = await readJson(req, 8192);
      if (typeof body.cwd !== 'string' || !['pull', 'push', 'refresh'].includes(body.action as string) || Object.keys(body).some(key => key !== 'cwd' && key !== 'action')) throw httpError(400, '프로젝트 폴더와 작업(pull, push, refresh)을 지정하세요.');
      await folderAllowed(body.cwd);
      // A pull or push changes the whole repository, so its root must be known and shared before anything runs.
      const known = backend.snapshot().repositories?.find(item => item.cwd === body.cwd);
      if (body.action !== 'refresh' && (!known || await exclusions.excludesNow(known.root))) throw httpError(404, FOLDER_NOT_FOUND);
      if (!backend.repositoryAction) throw httpError(503, 'Git 상태를 확인할 수 없습니다.');
      const status = await backend.repositoryAction(body.cwd, body.action as RepositoryAction);
      // The repository can reach beyond the folder asked about; its root must be shared too.
      if (await exclusions.excludesNow(status.root)) throw httpError(404, FOLDER_NOT_FOUND);
      return json(res, 200, { repository: remoteRepository(status) });
    }
    if (path === '/api/groups') {
      // Pins and screen hiding belong to whoever is looking; a controller keeps its own. Only the name is shared.
      const body = await readJson(req);
      if (Object.keys(body).some(key => key !== 'cwd' && key !== 'title') || typeof body.cwd !== 'string' || body.title === undefined) throw httpError(400, '폴더 이름만 바꿀 수 있습니다.');
      await folderAllowed(body.cwd);
      if (!backend.setGroup) throw httpError(503, '폴더 그룹을 저장할 수 없습니다.');
      const group = await backend.setGroup({ cwd: body.cwd, title: normalizeSessionTitle(body.title) });
      return json(res, 200, { group: { cwd: group.cwd, title: group.title, pinned: group.pinned } });
    }
    throw notFound();
  };

  return {
    async handle(req: Request, response: ServerResponse | Http2ServerResponse, principal: RemotePrincipal): Promise<void> {
      const res = response as Reply;
      try {
        await prepare();
        await route(req, res, principal, new URL(req.url || '/', 'http://remote.invalid'));
      } catch (error) {
        const status = errorStatus(error);
        const disposition = errorDisposition(error);
        const message = error instanceof Error && (status < 500 || status === 503) ? error.message : '요청을 처리하지 못했습니다.';
        if (!res.headersSent) json(res, status, { error: message, ...(disposition ? { disposition } : {}) });
        else res.end();
      }
    },
    /** Ends every stream a controller holds, such as when its link closes. */
    disconnect,
    dispose(): void {
      unsubscribe();
      exclusions.off('change', listChanged);
      exclusions.off('resolved', publish);
      clearInterval(heartbeat);
      clearInterval(recheck);
      if (scheduled) clearTimeout(scheduled);
      for (const id of [...streams.keys()]) disconnect(id);
      for (const res of shellStreams) res.end();
      shellStreams.clear();
    },
  };
}
export type RemoteRouter = ReturnType<typeof createRemoteRouter>;
