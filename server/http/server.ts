import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readWebAsset } from './web-assets.js';
import { normalizeSessionTitle } from '../stores/session-titles.js';
import { normalizeProjectGroupPatch } from '../stores/project-groups.js';
import type { Attachment, AutoPromptJob, AutoPromptRequest, CreateSessionRequest, MessageAttachments, ProjectGroup, ProjectGroupPatch, Snapshot, Session, SessionDetail, Run, RunApprovalResponse } from '../../shared/types.js';
import { isImageAttachment, MAX_ATTACHMENTS, MAX_TOTAL_ATTACHMENT_BYTES } from '../../shared/attachments.js';
import { requestedModel } from '../providers/models.js';
import { requestedApprovalsReviewer } from '../providers/approvals.js';
import { SseClient } from './sse-client.js';
import { publicSnapshot } from './public-snapshot.js';
import { APP_VERSION, HEALTH_APPLICATION_ID, REQUEST_TOKEN_HEADER } from '../../shared/app-identity.js';

export interface Backend {
  snapshot(): Snapshot;
  detail(id: string, before?: number, limit?: number): Promise<SessionDetail | undefined>;
  setTitle?(id: string, title: string): Promise<Session | undefined>;
  setClosed?(id: string, closed: boolean): Promise<Session | undefined>;
  setGroup?(patch: ProjectGroupPatch): Promise<ProjectGroup>;
  createSession?(input: CreateSessionRequest): Promise<{ session: Session; run: Run }>;
  startAutoPrompt?(input: AutoPromptRequest): Promise<AutoPromptJob>;
  getAutoPrompt?(id: string): AutoPromptJob | undefined;
  cancelAutoPrompt?(id: string): Promise<AutoPromptJob>;
  enqueue(id: string, prompt: string, attachments?: MessageAttachments): Promise<Run>;
  attachment?(id: string): Promise<{ metadata: Attachment; content: Buffer }>;
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
  remote?: { password: string; origins: ReadonlySet<string> };
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
export function createMonitorServer({ port, clientDir, backend, remote }: HttpOptions) {
  const token = randomBytes(32).toString('hex');
  const credentialHash = remote ? createHash('sha256').update(`monitor:${remote.password}`).digest() : undefined;
  const clients = new Set<SseClient>();
  const rates = new Map<string, { count: number; at: number }>();
  let sequence = 0;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const snapshot = () => publicSnapshot(backend.snapshot());
  const frame = () => `id: ${++sequence}\nevent: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`;
  const broadcast = () => {
    scheduled = undefined;
    if (!clients.size) return;
    const data = frame();
    for (const client of clients) client.snapshot(data);
  };
  const unsubscribe = backend.subscribe(() => {
    if (!scheduled) scheduled = setTimeout(broadcast, 200);
  });
  const heartbeat = setInterval(() => {
    for (const client of clients) client.heartbeat();
  }, 15_000);
  heartbeat.unref();

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
      if (credentialHash && !authenticated(req.headers.authorization, credentialHash)) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Agent Session Tower", charset="UTF-8"');
        return json(res, 401, { error: '원격 접속 인증이 필요합니다.' });
      }
      if (req.method === 'POST') {
        const header = req.headers[REQUEST_TOKEN_HEADER.toLowerCase()];
        if (typeof header !== 'string' || !/^[a-f0-9]{64}$/.test(header) || !timingSafeEqual(Buffer.from(header), Buffer.from(token))) {
          return json(res, 403, { error: '연결 인증이 만료되었습니다. 페이지를 새로고침하세요.' });
        }
        if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: 'JSON 요청이 필요합니다.' });
        const key = req.socket.remoteAddress || 'local';
        const now = Date.now();
        const rate = rates.get(key);
        if (!rate || now - rate.at > 60_000) rates.set(key, { count: 1, at: now });
        else if (++rate.count > 30) return json(res, 429, { error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' });
      }
      if (req.method === 'GET' && path === '/api/bootstrap') return json(res, 200, { token });
      if (req.method === 'GET' && path === '/api/snapshot') return json(res, 200, snapshot());
      if (req.method === 'POST' && path === '/api/auto-prompts') {
        const body = await readJson(req, Math.ceil(MAX_TOTAL_ATTACHMENT_BYTES / 3) * 4 + 256 * 1024);
        if (Object.keys(body).some(key => !['requestId', 'provider', 'cwd', 'prompt', 'attachments', 'codexApprovalsReviewer'].includes(key))) {
          return json(res, 400, { error: 'Auto Prompt 요청에는 폴더, 도구, 프롬프트와 첨부 파일만 지정할 수 있습니다.' });
        }
        if (typeof body.requestId !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(body.requestId)) {
          return json(res, 400, { error: 'Auto Prompt 요청 ID가 올바르지 않습니다.' });
        }
        if (body.provider !== 'claude' && body.provider !== 'codex') return json(res, 400, { error: 'Claude 또는 Codex를 선택하세요.' });
        if (body.cwd !== undefined && (typeof body.cwd !== 'string' || !body.cwd.startsWith('/') || body.cwd.length > 4096 || body.cwd.includes('\0'))) {
          return json(res, 400, { error: '목록에서 작업 폴더를 선택하거나 Auto를 선택하세요.' });
        }
        if (body.attachments !== undefined && !Array.isArray(body.attachments)) return json(res, 400, { error: '첨부 파일 목록 형식이 올바르지 않습니다.' });
        const attachments = body.attachments as AutoPromptRequest['attachments'];
        if ((attachments?.length || 0) > MAX_ATTACHMENTS) return json(res, 413, { error: `첨부 파일은 최대 ${MAX_ATTACHMENTS}개까지 보낼 수 있습니다.` });
        if (typeof body.prompt !== 'string' || (!body.prompt.trim() && !attachments?.length) || body.prompt.length > 32_000) {
          return json(res, 400, { error: '메시지나 첨부 파일을 추가하세요. 메시지는 32,000자 이하여야 합니다.' });
        }
        const reviewer = requestedApprovalsReviewer(body.codexApprovalsReviewer);
        if (!backend.startAutoPrompt) return json(res, 503, { error: 'Auto Prompt를 현재 사용할 수 없습니다.' });
        const job = await backend.startAutoPrompt({ requestId: body.requestId, provider: body.provider, prompt: body.prompt,
          ...(body.cwd !== undefined ? { cwd: body.cwd as string } : {}), ...(attachments ? { attachments } : {}),
          ...(reviewer && body.provider === 'codex' ? { codexApprovalsReviewer: reviewer } : {}) });
        return json(res, 202, { job });
      }
      const autoPromptMatch = url.pathname.match(/^\/api\/auto-prompts\/([a-f\d-]+)(\/cancel)?$/i);
      if (autoPromptMatch && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(autoPromptMatch[1])) {
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
        const client = new SseClient(res, () => clients.delete(client));
        clients.add(client);
        client.snapshot(`retry: 2000\n\n${frame()}`);
        return;
      }
      if (req.method === 'POST' && path === '/api/sessions') {
        const body = await readJson(req);
        if (body.provider !== 'claude' && body.provider !== 'codex') return json(res, 400, { error: 'Claude 또는 Codex를 선택하세요.' });
        if (typeof body.cwd !== 'string' || !body.cwd.trim()) return json(res, 400, { error: '작업 폴더의 절대 경로를 입력하세요.' });
        if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 32_000) return json(res, 400, { error: '메시지는 1자 이상, 32,000자 이하여야 합니다.' });
        const title = body.title === undefined ? undefined : normalizeSessionTitle(body.title);
        if (!backend.createSession) return json(res, 503, { error: '새 세션을 생성할 수 없습니다.' });
        const model = requestedModel(body.model);
        // Like the model override, an unusable value fails before admission; only a Codex thread has a reviewer.
        const reviewer = requestedApprovalsReviewer(body.codexApprovalsReviewer);
        const result = await backend.createSession({ provider: body.provider, cwd: body.cwd, prompt: body.prompt.trim(), ...(title ? { title } : {}), ...(model ? { model } : {}),
          ...(reviewer && body.provider === 'codex' ? { codexApprovalsReviewer: reviewer } : {}) });
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
        const body = await readJson(req, Math.ceil(MAX_TOTAL_ATTACHMENT_BYTES / 3) * 4 + 256 * 1024);
        if ((body.attachments !== undefined && !Array.isArray(body.attachments)) || (body.attachmentIds !== undefined && !Array.isArray(body.attachmentIds))) return json(res, 400, { error: '첨부 파일 목록 형식이 올바르지 않습니다.' });
        const attachments = body.attachments as MessageAttachments['attachments'];
        const attachmentIds = body.attachmentIds as MessageAttachments['attachmentIds'];
        const count = (attachments?.length || 0) + (attachmentIds?.length || 0);
        if (count > MAX_ATTACHMENTS) return json(res, 413, { error: `첨부 파일은 최대 ${MAX_ATTACHMENTS}개까지 보낼 수 있습니다.` });
        if (typeof body.prompt !== 'string' || (!body.prompt.trim() && !count) || body.prompt.length > 32_000) return json(res, 400, { error: '메시지나 첨부 파일을 추가하세요. 메시지는 32,000자 이하여야 합니다.' });
        const model = requestedModel(body.model);
        const run = await backend.enqueue(messageMatch[1], body.prompt.trim(), { attachments, attachmentIds, ...(model ? { model } : {}) });
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
      const status = typeof error === 'object' && error && 'statusCode' in error ? Number(error.statusCode) : /not found|unknown session|찾을 수 없/i.test(message) ? 404 : /busy|already|resum|subagent|queue|재개|대기열|CLI|executable/i.test(message) ? 409 : 500;
      if (!res.headersSent) json(res, status, { error: message });
      else res.end();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.on('clientError', (_err, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  const dispose = () => {
    unsubscribe();
    clearInterval(heartbeat);
    if (scheduled) clearTimeout(scheduled);
    for (const client of clients) client.end();
    clients.clear();
  };
  server.on('close', dispose);
  return { server, dispose };
}

function authenticated(header: string | undefined, expectedHash: Buffer): boolean {
  if (!header || header.length > 2048) return false;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header);
  if (!match) return false;
  const credentials = Buffer.from(match[1], 'base64');
  if (credentials.toString('base64') !== match[1]) return false;
  return timingSafeEqual(createHash('sha256').update(credentials).digest(), expectedHash);
}

/** Accept one unambiguous response envelope; provider code validates its pending schema. */
function approvalResponse(body: Record<string, unknown>): RunApprovalResponse | undefined {
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  const keys = Object.keys(body);
  if (keys.length === 1 && (body.decision === 'allow' || body.decision === 'deny')) return body.decision;
  if (keys.length === 1 && record(body.answers) && Object.values(body.answers).every(answer => record(answer)
    && Object.keys(answer).length === 1 && Array.isArray(answer.answers) && answer.answers.every(value => typeof value === 'string'))) {
    return body as Extract<RunApprovalResponse, { answers: unknown }>;
  }
  if (keys.length === 2 && keys.includes('action') && keys.includes('content')
    && (body.action === 'accept' || body.action === 'decline' || body.action === 'cancel')
    && (body.content === null || record(body.content)) && (body.action === 'accept' || body.content === null)) {
    return body as Extract<RunApprovalResponse, { action: unknown }>;
  }
  return undefined;
}

async function readJson(req: IncomingMessage, maximum = 128 * 1024): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw Object.assign(new Error('요청 본문이 너무 큽니다.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error('올바른 JSON 형식이 아닙니다.'), { statusCode: 400 });
  }
}
