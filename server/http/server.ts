import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readWebAsset } from './web-assets.js';
import { normalizeSessionTitle } from '../stores/session-titles.js';
import { ATTACHMENT_BODY_BYTES, approvalResponse, errorDisposition, errorStatus, parseAutoPrompt, parseCreateSession, parseMessage, readJson, UUID } from './requests.js';
import type { RequestContext } from './request-context.js';
import type { RemoteExclusionStore } from '../remote/exclusions.js';
import { handleLinkRoute, type LinkRoutes } from '../link/routes.js';
import type { RemoteNodes } from '../link/nodes.js';
import { proxyToNode } from '../link/proxy.js';
import { normalizeProjectGroupPatch } from '../stores/project-groups.js';
import type { Attachment, AutoPromptJob, AutoPromptRequest, CreateSessionRequest, MessageAttachments, ProjectGroup, ProjectGroupPatch, Snapshot, Session, SessionDetail, Run, RunApprovalResponse } from '../../shared/types.js';
import { isImageAttachment } from '../../shared/attachments.js';
import { SseClient } from './sse-client.js';
import { publicSnapshot } from './public-snapshot.js';
import { SnapshotStream, type FrameFormat } from './snapshot-stream.js';
import { APP_VERSION, HEALTH_APPLICATION_ID, REQUEST_TOKEN_HEADER } from '../../shared/app-identity.js';
import { assertWorkspace, listWorkspaceTree, readWorkspaceFile, saveWorkspaceFile, createWorkspaceDirectory, MAX_WORKSPACE_FILE_BYTES } from '../workspace-files.js';
import { WorkspaceTerminals, type WorkspaceTerminalBackend } from '../workspace-terminals.js';
import type { AuthStore } from '../auth/store.js';
import { requestIdentity, sessionCookie, setSessionCookie } from './auth.js';
import type { AuthStatus } from '../../shared/auth.js';
import type { SlackPublicStatus } from '../../shared/slack.js';
import { OPERATIONS, isOperationName } from '../../shared/api/operations.js';
import type { RepositoryAction, RepositoryStatus } from '../../shared/repositories.js';

export interface Backend {
  /** Tower operations (see shared/api/operations.ts), run by the worker as the owner. */
  api?(operation: string, input: unknown): Promise<unknown>;
  slackOverview?(): Promise<SlackPublicStatus>;
  slackMutate?(action: string, body: Record<string, unknown>): Promise<SlackPublicStatus>;
  snapshot(): Snapshot;
  detail(id: string, before?: number, limit?: number): Promise<SessionDetail | undefined>;
  setTitle?(id: string, title: string): Promise<Session | undefined>;
  setClosed?(id: string, closed: boolean): Promise<Session | undefined>;
  setGroup?(patch: ProjectGroupPatch): Promise<ProjectGroup>;
  repositoryAction?(cwd: string, action: RepositoryAction): Promise<RepositoryStatus>;
  createSession?(input: CreateSessionRequest, context?: RequestContext): Promise<{ session: Session; run: Run }>;
  startAutoPrompt?(input: AutoPromptRequest, context?: RequestContext): Promise<AutoPromptJob>;
  getAutoPrompt?(id: string): AutoPromptJob | undefined;
  cancelAutoPrompt?(id: string): Promise<AutoPromptJob>;
  enqueue(id: string, prompt: string, attachments?: MessageAttachments, context?: RequestContext): Promise<Run>;
  /** `sessionId` names the conversation the file belongs to; absent from workers that predate it. */
  attachment?(id: string): Promise<{ metadata: Attachment; content: Buffer; sessionId?: string }>;
  /** The session with this Tower or native ID, resolved the same way requests about it are. */
  session?(id: string): Session | undefined;
  /** Coordinator conversations (Slack, GitHub) that stay on this machine. Undefined while unknown. */
  coordinators?(): ReadonlySet<string> | undefined;
  cancel(id: string): Promise<void>;
  steerRun?(id: string): Promise<Run>;
  respondToApproval?(runId: string, approvalId: string, response: RunApprovalResponse): Promise<Run>;
  dismiss?(id: string): Promise<void>;
  subscribe(listener: () => void): () => void;
}
export interface HttpOptions {
  port: number;
  clientDir: string;
  backend: Backend;
  remote?: { origins: ReadonlySet<string> };
  auth?: AuthStore;
  workspaceTerminals?: WorkspaceTerminalBackend;
  /** The list of folders never shared with remote controllers; managed only from this machine's own browser. */
  exclusions?: RemoteExclusionStore;
  /** Remote computers, managed from this Tower's own pages; or why they are unavailable. */
  links?: LinkRoutes | { error: string };
  /** Joined computers this page shows and works with through their links. */
  nodes?: RemoteNodes;
}
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json',
};
function publicSession<T extends { filePath?: string }>(session: T): Omit<T, 'filePath'> {
  const { filePath: _, ...safe } = session;
  return safe;
}
export function createMonitorServer({ port, clientDir, backend, remote, auth, workspaceTerminals = new WorkspaceTerminals(), exclusions, links, nodes }: HttpOptions) {
  const token = randomBytes(32).toString('hex');
  const streams = new Map<string, Set<() => void>>();
  const unsubscribeAuth = auth?.onRevoke(id => {
    for (const close of streams.get(id) || []) close();
    streams.delete(id);
  });
  const trackStream = (id: string, res: ServerResponse, close: () => void) => {
    if (!id) return;
    const active = streams.get(id) || new Set<() => void>();
    active.add(close);
    streams.set(id, active);
    res.once('close', () => { active.delete(close); if (!active.size) streams.delete(id); });
  };
  const rates = new Map<string, { count: number; at: number }>();
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const snapshot = () => publicSnapshot(backend.snapshot());
  const stream = new SnapshotStream(snapshot);
  const clients = new Set<SseClient>();
  const unsubscribe = backend.subscribe(() => {
    if (!scheduled) scheduled = setTimeout(() => { scheduled = undefined; stream.publish(); }, 200);
  });
  const heartbeat = setInterval(() => {
    for (const client of clients) client.heartbeat();
    stream.resendToCompletePages(60_000);
  }, 15_000);
  heartbeat.unref();
  // Each joined computer's snapshot travels on the same browser connection as this Tower's, in its own frames.
  const nodeStreams = new Map<string, SnapshotStream>();
  const nodeClients = new Set<SseClient>();
  const nodeFrames = (id: string): FrameFormat => ({ key: id,
    snapshot: (sequence, snapshot) => `event: node\ndata: ${JSON.stringify({ node: id, sequence, snapshot })}\n\n`,
    patch: (sequence, patch) => `event: node\ndata: ${JSON.stringify({ node: id, sequence, patch })}\n\n` });
  const nodeChanged = (id: string) => {
    if (!nodes?.snapshot(id)) return;
    let feed = nodeStreams.get(id);
    if (!feed) { feed = new SnapshotStream(() => nodes.snapshot(id)!, Date.now, nodeFrames(id)); nodeStreams.set(id, feed); }
    for (const client of nodeClients) if (!feed.has(client)) feed.attach(client, true);
    feed.publish();
  };
  const nodeRemoved = (id: string) => {
    nodeStreams.get(id)?.release();
    nodeStreams.delete(id);
    for (const client of nodeClients) client.snapshot(`event: node\ndata: ${JSON.stringify({ node: id, removed: true })}\n\n`, id);
  };
  nodes?.on('change', nodeChanged);
  nodes?.on('removed', nodeRemoved);

  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const address = server.address();
    const effectivePort = address && typeof address === 'object' ? address.port : port;
    const hosts = new Set([`localhost:${effectivePort}`, `127.0.0.1:${effectivePort}`, `[::1]:${effectivePort}`]);
    if (address && typeof address === 'object' && address.address.startsWith('127.')) hosts.add(`${address.address}:${effectivePort}`);
    const origins = new Set([...hosts].map(host => `http://${host}`));
    // Public origins may become available after the HTTP listener starts.
    // Trust only explicitly supplied origins, never proxy headers.
    for (const origin of remote?.origins || []) {
      try {
        const parsed = new URL(origin);
        if (['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin) {
          hosts.add(parsed.host);
          origins.add(origin);
        }
      } catch { /* Ignore malformed configured origins. */ }
    }
    if (!req.headers.host || !hosts.has(req.headers.host)) return json(res, 403, { error: '허용되지 않은 호스트입니다.' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: '다른 사이트에서의 접근은 허용되지 않습니다.' });
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) return json(res, 403, { error: '허용되지 않은 출처입니다.' });
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const path = decodeURIComponent(url.pathname);
      if (req.method === 'GET' && path === '/api/health') return json(res, 200, {
        ok: true, application: HEALTH_APPLICATION_ID, pid: process.pid, version: APP_VERSION,
        bindHost: address && typeof address === 'object' ? address.address : undefined,
        remoteAccess: Boolean(remote),
      });
      const identity = requestIdentity(req);
      const sessionId = sessionCookie(req);
      const authenticated = identity.local || Boolean(auth?.session(sessionId, identity.ip));
      const authStatus = (signedIn = authenticated): AuthStatus => ({
        local: identity.local, authenticated: signedIn, configured: Boolean(auth?.configured()), token,
        ...(signedIn && auth?.username() ? { username: auth.username() } : {}),
      });
      // Only the login shell and its static assets are public; all application data stays behind this gate.
      const publicAsset = (req.method === 'GET' || req.method === 'HEAD') && (path === '/' || path === '/favicon.svg' || path.startsWith('/assets/'));
      if (req.method === 'GET' && path === '/api/auth/status') return json(res, 200, authStatus());
      const login = req.method === 'POST' && path === '/api/auth/login';
      if (!authenticated && !login && !publicAsset) return json(res, 401, { error: '로그인이 필요합니다.' });
      const adminRoute = ['/api/auth/overview', '/api/auth/credentials', '/api/auth/unblock'].includes(path);
      if (adminRoute && !identity.local) return json(res, 403, { error: '계정 관리는 로컬 접속에서만 사용할 수 있습니다.' });
      if (req.method === 'POST') {
        const header = req.headers[REQUEST_TOKEN_HEADER.toLowerCase()];
        if (typeof header !== 'string' || !/^[a-f0-9]{64}$/.test(header) || !timingSafeEqual(Buffer.from(header), Buffer.from(token))) {
          return json(res, 403, { error: '연결 인증이 만료되었습니다. 페이지를 새로고침하세요.' });
        }
        if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: 'JSON 요청이 필요합니다.' });
        // Keystrokes and resize events have their own per-terminal byte/request budget.
        // Reading Tower state is not a mutation; only changes count against the request budget.
        const read = path.match(/^\/api\/v1\/([a-z]+\.[a-zA-Z]+)$/)?.[1];
        const readOnly = read !== undefined && isOperationName(read) && !OPERATIONS[read].write;
        if (!login && !readOnly && !/^\/api\/workspace\/terminals\/[0-9a-f-]{36}\/(input|resize)$/.test(path)) {
          const key = req.socket.remoteAddress || 'local';
          const now = Date.now();
          const rate = rates.get(key);
          if (!rate || now - rate.at > 60_000) rates.set(key, { count: 1, at: now });
          else if (++rate.count > 30) return json(res, 429, { error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' });
        }
      }
      const secureOrigin = origins.has(`https://${req.headers.host}`) && !origins.has(`http://${req.headers.host}`);
      const operation = path.match(/^\/api\/v1\/([a-z]+\.[a-zA-Z]+)$/);
      if (operation && req.method === 'POST') {
        if (!isOperationName(operation[1])) return json(res, 404, { error: 'Unknown Tower operation.' });
        if (!backend.api) return json(res, 503, { error: 'Tower operations are unavailable.' });
        return json(res, 200, { result: await backend.api(operation[1], await readJson(req, 1_000_000)) });
      }
      if (path === '/api/slack' && req.method === 'GET') {
        if (!backend.slackOverview) return json(res, 503, { error: 'Slack 연동을 사용할 수 없습니다.' });
        return json(res, 200, await backend.slackOverview());
      }
      const slackAction = path.match(/^\/api\/slack\/(connect|disconnect|settings|rules|tone\/collect|tone\/save|replies\/approve)$/);
      if (slackAction && req.method === 'POST') {
        if (!backend.slackMutate) return json(res, 503, { error: 'Slack 연동을 사용할 수 없습니다.' });
        const body = await readJson(req, 1_000_000);
        return json(res, 200, await backend.slackMutate(slackAction[1], body));
      }
      if (login) {
        if (identity.local) return json(res, 200, authStatus(true));
        if (!auth) return json(res, 503, { error: '서버의 로컬 계정 관리에서 계정을 설정하세요.' });
        const body = await readJson(req, 4096);
        if (typeof body.username !== 'string' || typeof body.password !== 'string' || body.username.length > 64 || body.password.length > 256
          || Object.keys(body).some(key => key !== 'username' && key !== 'password')) return json(res, 400, { error: '로그인 요청 형식이 올바르지 않습니다.' });
        const result = await auth.login(identity.ip, body.username, body.password);
        if (result.status === 'blocked') return json(res, 403, { error: '이 IP는 로그인 5회 실패로 차단되었습니다. 로컬 계정 관리에서 해제하세요.' });
        if (result.status === 'unconfigured') return json(res, 503, { error: '서버의 로컬 계정 관리에서 계정을 설정하세요.' });
        if (result.status !== 'success' || !result.sessionId) return json(res, 401, { error: 'ID 또는 비밀번호가 올바르지 않습니다.' });
        if (sessionId) auth.logout(sessionId);
        setSessionCookie(req, res, result.sessionId, secureOrigin);
        return json(res, 200, authStatus(true));
      }
      if (req.method === 'POST' && path === '/api/auth/logout') {
        auth?.logout(sessionId);
        setSessionCookie(req, res, '', secureOrigin);
        return json(res, 200, { ok: true });
      }
      if (adminRoute && !auth) return json(res, 503, { error: '계정 관리를 사용할 수 없습니다.' });
      if (req.method === 'GET' && path === '/api/auth/overview') return json(res, 200, auth!.overview());
      if (req.method === 'POST' && path === '/api/auth/credentials') {
        const body = await readJson(req, 4096);
        if (typeof body.username !== 'string' || typeof body.password !== 'string' || Object.keys(body).some(key => key !== 'username' && key !== 'password')) return json(res, 400, { error: '계정 요청 형식이 올바르지 않습니다.' });
        await auth!.setCredentials(body.username, body.password);
        return json(res, 200, auth!.overview());
      }
      if (req.method === 'POST' && path === '/api/auth/unblock') {
        const body = await readJson(req, 4096);
        if (typeof body.ip !== 'string' || Object.keys(body).some(key => key !== 'ip')) return json(res, 400, { error: 'IP 주소를 지정하세요.' });
        await auth!.unblock(body.ip);
        return json(res, 200, auth!.overview());
      }
      if (req.method === 'GET' && path === '/api/bootstrap') return json(res, 200, { token });
      if (req.method === 'GET' && path === '/api/snapshot') return json(res, 200, snapshot());
      if (req.method === 'GET' && path === '/api/workspace/tree') {
        return json(res, 200, await listWorkspaceTree(url.searchParams.get('cwd'), url.searchParams.get('path') ?? '', backend.snapshot()));
      }
      if (req.method === 'GET' && path === '/api/workspace/file') {
        return json(res, 200, await readWorkspaceFile(url.searchParams.get('cwd'), url.searchParams.get('path'), backend.snapshot()));
      }
      if (req.method === 'POST' && path === '/api/workspace/file') {
        return json(res, 200, await saveWorkspaceFile(await readJson(req, 6 * MAX_WORKSPACE_FILE_BYTES + 16 * 1024), backend.snapshot()));
      }
      if (req.method === 'POST' && path === '/api/workspace/directory') {
        return json(res, 200, await createWorkspaceDirectory(await readJson(req), backend.snapshot()));
      }
      if (req.method === 'POST' && path === '/api/workspace/terminals') {
        const body = await readJson(req);
        if (Object.keys(body).some(key => !['cwd', 'cols', 'rows'].includes(key))) return json(res, 400, { error: '폴더와 터미널 크기만 지정할 수 있습니다.' });
        const cwd = await assertWorkspace(body.cwd, backend.snapshot());
        return json(res, 200, await workspaceTerminals.create(cwd, body.cols, body.rows));
      }
      const terminalMatch = path.match(/^\/api\/workspace\/terminals\/([0-9a-f-]{36})\/(events|input|resize|close)$/);
      if (terminalMatch && req.method === 'GET' && terminalMatch[2] === 'events') {
        const cursor = req.headers['last-event-id'];
        if (Array.isArray(cursor)) return json(res, 400, { error: '터미널 출력 위치가 올바르지 않습니다.' });
        await workspaceTerminals.attach(terminalMatch[1], res, cursor);
        if (!identity.local) {
          if (!auth?.session(sessionId, identity.ip)) res.end();
          else trackStream(sessionId, res, () => { res.end(); });
        }
        return;
      }
      if (terminalMatch && req.method === 'POST' && terminalMatch[2] !== 'events') {
        const body = await readJson(req);
        const action = terminalMatch[2];
        const allowed = action === 'input' ? ['data'] : action === 'resize' ? ['cols', 'rows'] : [];
        if (Object.keys(body).some(key => !allowed.includes(key))) return json(res, 400, { error: '터미널 요청 형식이 올바르지 않습니다.' });
        if (action === 'input') await workspaceTerminals.input(terminalMatch[1], body.data);
        else if (action === 'resize') await workspaceTerminals.resize(terminalMatch[1], body.cols, body.rows);
        else await workspaceTerminals.close(terminalMatch[1]);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/auto-prompts') {
        const request = parseAutoPrompt(await readJson(req, ATTACHMENT_BODY_BYTES));
        if (!backend.startAutoPrompt) return json(res, 503, { error: 'Auto Prompt를 현재 사용할 수 없습니다.' });
        return json(res, 202, { job: await backend.startAutoPrompt(request) });
      }
      const autoPromptMatch = url.pathname.match(/^\/api\/auto-prompts\/([a-f\d-]+)(\/cancel)?$/i);
      if (autoPromptMatch && UUID.test(autoPromptMatch[1])) {
        const id = autoPromptMatch[1];
        if (req.method === 'GET' && !autoPromptMatch[2]) {
          const job = backend.getAutoPrompt?.(id);
          return job ? json(res, 200, { job }) : json(res, 404, { error: 'Auto Prompt 요청을 찾을 수 없습니다.' });
        }
        if (req.method === 'POST' && autoPromptMatch[2]) {
          if (Object.keys(await readJson(req)).length) return json(res, 400, { error: '취소 요청 본문은 비워 두세요.' });
          if (!backend.cancelAutoPrompt) return json(res, 503, { error: 'Auto Prompt를 현재 사용할 수 없습니다.' });
          return json(res, 200, { job: await backend.cancelAutoPrompt(id) });
        }
      }
      if (req.method === 'POST' && path === '/api/groups') {
        const patch = normalizeProjectGroupPatch(await readJson(req));
        if (!backend.setGroup) return json(res, 503, { error: '폴더 그룹을 저장할 수 없습니다.' });
        return json(res, 200, { group: await backend.setGroup(patch) });
      }
      // This Tower's own pages decide what stays out of remote sharing, whether opened here or after signing in.
      // Requests from a remote controller come through its link, which has no route to this.
      if (path === '/api/remote/exclusions' && (req.method === 'GET' || req.method === 'POST')) {
        if (!exclusions) return json(res, 503, { error: '원격 공유 제외 목록을 사용할 수 없습니다.' });
        if (req.method === 'POST') {
          const body = await readJson(req, 16 * 1024);
          const keys = Object.keys(body);
          if (keys.length !== 1 || !['add', 'remove', 'reset'].includes(keys[0]) || (keys[0] === 'reset' && body.reset !== true)) return json(res, 400, { error: '추가하거나 제거할 폴더 하나를 지정하세요.' });
          if (keys[0] === 'add') await exclusions.add(body.add); else if (keys[0] === 'remove') await exclusions.remove(body.remove); else await exclusions.reset();
        }
        return json(res, 200, { folders: exclusions.list(), revision: exclusions.revision, ...(exclusions.error ? { error: exclusions.error } : {}) });
      }
      if (links && await handleLinkRoute(req, res, path, links, json)) return;
      const nodeRoute = url.pathname.match(/^\/api\/nodes\/([a-f0-9]{32})\/(.+)$/);
      if (nodes && nodeRoute) {
        if (nodeRoute[2] === 'view' && req.method === 'POST') {
          // How this Tower shows another computer's folder stays here.
          const body = await readJson(req, 8192);
          if (Object.keys(body).some(key => !['cwd', 'pinned', 'hidden'].includes(key)) || (body.pinned === undefined && body.hidden === undefined)) return json(res, 400, { error: '고정 또는 숨김 상태를 지정하세요.' });
          await nodes.setView(nodeRoute[1], body.cwd, { pinned: body.pinned, hidden: body.hidden });
          return json(res, 200, { ok: true });
        }
        if (!nodes.known(nodeRoute[1])) return json(res, 404, { error: '연결된 컴퓨터가 아닙니다.' });
        return proxyToNode(req, res, nodes.session(nodeRoute[1]), `/api/${nodeRoute[2]}${url.search}`);
      }
      if (req.method === 'POST' && path === '/api/repositories') {
        const body = await readJson(req, 8192);
        if (typeof body.cwd !== 'string' || !body.cwd.startsWith('/') || body.cwd.includes('\0') || !['pull', 'push', 'refresh'].includes(body.action as string)) {
          return json(res, 400, { error: '프로젝트 폴더와 작업(pull, push, refresh)을 지정하세요.' });
        }
        if (!backend.repositoryAction) return json(res, 503, { error: 'Git 상태를 확인할 수 없습니다.' });
        return json(res, 200, { repository: await backend.repositoryAction(body.cwd, body.action as RepositoryAction) });
      }
      const attachmentMatch = path.match(/^\/api\/attachments\/([^/]+)$/);
      if ((req.method === 'GET' || req.method === 'HEAD') && attachmentMatch) {
        if (!backend.attachment) return json(res, 404, { error: '첨부 파일을 찾을 수 없습니다.' });
        const { metadata, content } = await backend.attachment(attachmentMatch[1]);
        const inline = isImageAttachment(metadata.mimeType);
        res.setHeader('Content-Type', inline ? metadata.mimeType : 'application/octet-stream');
        res.setHeader('Content-Length', content.length);
        res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(metadata.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`);
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
        res.statusCode = 200;
        return res.end(req.method === 'HEAD' ? undefined : content);
      }
      if (req.method === 'GET' && path === '/api/events') {
        if (clients.size >= 40) return json(res, 503, { error: '열린 모니터 연결이 너무 많습니다.' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        const client = new SseClient(res, () => {
          clients.delete(client); stream.detach(client);
          nodeClients.delete(client);
          for (const feed of nodeStreams.values()) feed.detach(client);
        });
        clients.add(client);
        if (!identity.local) trackStream(sessionId, res, () => client.end());
        // Pages that predate patches omit the parameter and keep receiving complete snapshots.
        stream.attach(client, url.searchParams.get('patch') === '1', 'retry: 2000\n\n');
        // Pages that know about joined computers ask for them; others see only this Tower, as before.
        if (nodes && url.searchParams.get('nodes') === '1' && url.searchParams.get('patch') === '1') {
          nodeClients.add(client);
          for (const id of nodes.ids()) nodeChanged(id);
        }
        return;
      }
      if (req.method === 'POST' && path === '/api/sessions') {
        const input = parseCreateSession(await readJson(req));
        if (!backend.createSession) return json(res, 503, { error: '새 세션을 생성할 수 없습니다.' });
        const result = await backend.createSession(input);
        return json(res, 202, { ...result, session: publicSession(result.session) });
      }
      const detailMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
      if (req.method === 'GET' && detailMatch) {
        const beforeValue = url.searchParams.get('before');
        const before = beforeValue === null ? undefined : Number(beforeValue);
        const limit = Number(url.searchParams.get('limit') || 100);
        if ((before !== undefined && (!Number.isSafeInteger(before) || before < 0)) || !Number.isInteger(limit) || limit < 1 || limit > 200) {
          return json(res, 400, { error: '올바르지 않은 페이지 요청입니다.' });
        }
        const detail = await backend.detail(detailMatch[1], before, limit);
        if (!detail) return json(res, 404, { error: '세션을 찾을 수 없습니다. 원본 기록이 이동되었을 수 있습니다.' });
        return json(res, 200, { ...detail, session: publicSession(detail.session) });
      }
      const titleMatch = path.match(/^\/api\/sessions\/([^/]+)\/title$/);
      if (req.method === 'POST' && titleMatch) {
        const title = normalizeSessionTitle((await readJson(req)).title);
        if (!backend.setTitle) return json(res, 503, { error: '제목을 저장할 수 없습니다.' });
        const session = await backend.setTitle(titleMatch[1], title);
        if (!session) return json(res, 404, { error: '세션을 찾을 수 없습니다. 원본 기록이 이동되었을 수 있습니다.' });
        return json(res, 200, { session: publicSession(session) });
      }
      const closedMatch = path.match(/^\/api\/sessions\/([^/]+)\/(close|reopen)$/);
      if (req.method === 'POST' && closedMatch) {
        await readJson(req);
        if (!backend.setClosed) return json(res, 503, { error: '세션 표시 상태를 저장할 수 없습니다.' });
        const session = await backend.setClosed(closedMatch[1], closedMatch[2] === 'close');
        if (!session) return json(res, 404, { error: '세션을 찾을 수 없습니다. 원본 기록이 이동되었을 수 있습니다.' });
        return json(res, 200, { session: publicSession(session) });
      }
      const messageMatch = path.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (req.method === 'POST' && messageMatch) {
        const message = parseMessage(await readJson(req, ATTACHMENT_BODY_BYTES));
        const run = await backend.enqueue(messageMatch[1], message.prompt, message.attachments);
        return json(res, 202, { run });
      }
      // Provider request IDs are opaque and may contain an encoded slash.
      const approvalMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/approvals\/([^/]+)$/);
      if (req.method === 'POST' && approvalMatch) {
        const body = await readJson(req);
        const response = approvalResponse(body);
        if (response === undefined) return json(res, 400, { error: '승인 응답 형식이 올바르지 않습니다. 실행 내용은 변경할 수 없습니다.' });
        if (!backend.respondToApproval) return json(res, 503, { error: '이 실행기의 승인 요청을 처리할 수 없습니다.' });
        const run = await backend.respondToApproval(decodeURIComponent(approvalMatch[1]), decodeURIComponent(approvalMatch[2]), response);
        return json(res, 200, { run });
      }
      const steerMatch = path.match(/^\/api\/runs\/([^/]+)\/steer$/);
      if (req.method === 'POST' && steerMatch) {
        const body = await readJson(req);
        if (Object.keys(body).length) return json(res, 400, { error: '끼워넣기 요청의 내용은 변경할 수 없습니다.' });
        if (!backend.steerRun) return json(res, 503, { error: '이 실행기는 요청 끼워넣기를 지원하지 않습니다.' });
        return json(res, 200, { run: await backend.steerRun(decodeURIComponent(steerMatch[1])) });
      }
      const cancelMatch = path.match(/^\/api\/runs\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && cancelMatch) {
        await readJson(req);
        await backend.cancel(cancelMatch[1]);
        return json(res, 200, { ok: true });
      }
      const dismissMatch = path.match(/^\/api\/runs\/([^/]+)\/dismiss$/);
      if (req.method === 'POST' && dismissMatch) {
        await readJson(req);
        if (!backend.dismiss) return json(res, 503, { error: '실패 기록을 지울 수 없습니다.' });
        await backend.dismiss(dismissMatch[1]);
        return json(res, 200, { ok: true });
      }
      if (path.startsWith('/api/')) return json(res, 404, { error: 'API 경로를 찾을 수 없습니다.' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: '허용되지 않은 요청입니다.' });
      const asset = await readWebAsset(clientDir, path);
      if (!asset) return json(res, 404, { error: '파일을 찾을 수 없습니다.' });
      res.setHeader('Content-Type', contentTypes[asset.extension] || 'application/octet-stream');
      if (!remote && path.startsWith('/assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.statusCode = 200;
      res.end(req.method === 'HEAD' ? undefined : asset.content);
    } catch (error) {
      const message = error instanceof Error ? error.message : '요청을 처리하지 못했습니다.';
      const disposition = errorDisposition(error);
      if (!res.headersSent) json(res, errorStatus(error), { error: message, ...(disposition ? { disposition } : {}) });
      else res.end();
    }
  });
  // A large attachment for another computer can arrive slowly when the link to it is slow.
  server.requestTimeout = 120_000;
  server.headersTimeout = 10_000;
  server.on('clientError', (_err, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  const dispose = () => {
    workspaceTerminals.dispose();
    unsubscribeAuth?.();
    for (const active of streams.values()) for (const close of active) close();
    streams.clear();
    unsubscribe();
    clearInterval(heartbeat);
    if (scheduled) clearTimeout(scheduled);
    stream.close();
    nodes?.off('change', nodeChanged);
    nodes?.off('removed', nodeRemoved);
    for (const feed of nodeStreams.values()) feed.release();
    nodeStreams.clear();
    nodeClients.clear();
    for (const client of clients) client.end();
    clients.clear();
  };
  server.on('close', dispose);
  return { server, dispose };
}
