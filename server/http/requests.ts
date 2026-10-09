import type { AttachmentUploads } from '../stores/attachment-uploads.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Http2ServerRequest } from 'node:http2';
import type { AutoPromptInput, NewSessionInput, MessageAttachments, RunApprovalResponse } from '../../shared/types.js';
import { MAX_ATTACHMENTS, MAX_TOTAL_ATTACHMENT_BYTES } from '../../shared/attachments.js';
import { requestedEffort, requestedModel } from '../providers/models.js';
import { requestedApprovalsReviewer } from '../providers/approvals.js';
import { normalizeSessionTitle } from '../stores/session-titles.js';
import { AUTO_PROMPT_SUGGESTION_MIN_CHARS, type AutoPromptSuggestionRequest } from '../../shared/decisions.js';
import { fromStatus, statusOf, TowerError } from '../../shared/errors.js';

/** Request bodies that carry attachments may hold the base64 form of the largest allowed upload. */
export const ATTACHMENT_BODY_BYTES = Math.ceil(MAX_TOTAL_ATTACHMENT_BYTES / 3) * 4 + 256 * 1024;
export const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

export const httpError = (status: number, message: string) => fromStatus(status, message);
/** A Tower session id as requests name it: `provider:nativeId`, or a scoped form; never control characters. */
export const validTargetSessionId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);

export async function readJson(req: IncomingMessage | Http2ServerRequest, maximum = 128 * 1024): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maximum) throw httpError(413, '요청 본문이 너무 큽니다.');
    chunks.push(chunk);
  }
  try {
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch {
    throw httpError(400, '올바른 JSON 형식이 아닙니다.');
  }
}

/** Accept one unambiguous response envelope; provider code validates its pending schema. */
export function approvalResponse(body: Record<string, unknown>): RunApprovalResponse | undefined {
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

/** A new session request, validated before admission. Throws an HTTP error for anything else. */
export function parseCreateSession(body: Record<string, unknown>): NewSessionInput {
  if (body.attachmentIds !== undefined) throw httpError(400, '새 세션의 첨부 파일은 Auto Prompt로 보내세요.');
  if (body.modelRole !== undefined && body.modelRole !== 'master.worker') throw httpError(400, '알 수 없는 작업 모델 역할입니다.');
  if (body.provider !== 'claude' && body.provider !== 'codex' && !(body.provider === undefined && body.modelRole === 'master.worker')) throw httpError(400, 'Claude 또는 Codex를 선택하세요.');
  if (typeof body.cwd !== 'string' || !body.cwd.trim()) throw httpError(400, '작업 폴더의 절대 경로를 입력하세요.');
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 32_000) throw httpError(400, '메시지는 1자 이상, 32,000자 이하여야 합니다.');
  const title = body.title === undefined ? undefined : normalizeSessionTitle(body.title);
  const model = requestedModel(body.model);
  const effort = requestedEffort(body.effort, body.provider);
  // Like the model override, an unusable value fails before admission; only a Codex thread has a reviewer.
  const reviewer = requestedApprovalsReviewer(body.codexApprovalsReviewer);
  return { ...(body.modelRole ? { modelRole: body.modelRole } : {}), provider: body.provider, cwd: body.cwd, prompt: body.prompt.trim(), ...(title ? { title } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}),
    ...(reviewer && body.provider === 'codex' ? { codexApprovalsReviewer: reviewer } : {}) };
}

export interface MessageRequest { prompt: string; attachments: MessageAttachments }
export function parseMessage(body: Record<string, unknown>): MessageRequest {
  if ((body.attachments !== undefined && !Array.isArray(body.attachments)) || (body.attachmentIds !== undefined && !Array.isArray(body.attachmentIds))) throw httpError(400, '첨부 파일 목록 형식이 올바르지 않습니다.');
  const attachments = body.attachments as MessageAttachments['attachments'];
  const attachmentIds = body.attachmentIds as MessageAttachments['attachmentIds'];
  const count = (attachments?.length || 0) + (attachmentIds?.length || 0);
  if (count > MAX_ATTACHMENTS) throw httpError(413, `첨부 파일은 최대 ${MAX_ATTACHMENTS}개까지 보낼 수 있습니다.`);
  if (typeof body.prompt !== 'string' || (!body.prompt.trim() && !count) || body.prompt.length > 32_000) throw httpError(400, '메시지나 첨부 파일을 추가하세요. 메시지는 32,000자 이하여야 합니다.');
  const model = requestedModel(body.model);
  const effort = requestedEffort(body.effort);
  return { prompt: body.prompt.trim(), attachments: { attachments, attachmentIds, ...(model ? { model } : {}), ...(effort ? { effort } : {}) } };
}

export function parseAutoPrompt(body: Record<string, unknown>): AutoPromptInput {
  if (Object.keys(body).some(key => !['modelRole', 'requestId', 'provider', 'cwd', 'sessionMode', 'targetSessionId', 'prompt', 'attachments', 'attachmentIds', 'codexApprovalsReviewer', 'model', 'effort'].includes(key))) {
    throw httpError(400, 'Auto Prompt 요청에는 폴더, 도구, 프롬프트와 첨부 파일만 지정할 수 있습니다.');
  }
  if (typeof body.requestId !== 'string' || !UUID.test(body.requestId)) throw httpError(400, 'Auto Prompt 요청 ID가 올바르지 않습니다.');
  if (body.modelRole !== undefined && body.modelRole !== 'master.worker') throw httpError(400, '알 수 없는 작업 모델 역할입니다.');
  if (body.provider !== 'claude' && body.provider !== 'codex' && !(body.provider === undefined && body.modelRole === 'master.worker')) throw httpError(400, 'Claude 또는 Codex를 선택하세요.');
  if (body.cwd !== undefined && (typeof body.cwd !== 'string' || !body.cwd.startsWith('/') || body.cwd.length > 4096 || body.cwd.includes('\0'))) {
    throw httpError(400, '목록에서 작업 폴더를 선택하거나 Auto를 선택하세요.');
  }
  // A new conversation in the chosen folder, without asking the router (an accepted suggestion does this).
  // A chosen place without asking the router (an accepted suggestion): a new conversation, or one to continue, in `cwd`.
  if (body.sessionMode !== undefined && (body.sessionMode !== 'new' || body.cwd === undefined)) throw httpError(400, '새 세션 요청에는 작업 폴더가 필요합니다.');
  if (body.targetSessionId !== undefined && (!validTargetSessionId(body.targetSessionId) || body.cwd === undefined || body.sessionMode !== undefined)) {
    throw httpError(400, '이어갈 세션과 그 작업 폴더를 함께 지정하세요.');
  }
  if ((body.attachments !== undefined && !Array.isArray(body.attachments)) || (body.attachmentIds !== undefined && !Array.isArray(body.attachmentIds))) throw httpError(400, '첨부 파일 목록 형식이 올바르지 않습니다.');
  const attachments = body.attachments as AutoPromptInput['attachments'];
  const attachmentIds = body.attachmentIds as AutoPromptInput['attachmentIds'];
  const count = (attachments?.length || 0) + (attachmentIds?.length || 0);
  if (count > MAX_ATTACHMENTS) throw httpError(413, `첨부 파일은 최대 ${MAX_ATTACHMENTS}개까지 보낼 수 있습니다.`);
  if (typeof body.prompt !== 'string' || (!body.prompt.trim() && !count) || body.prompt.length > 32_000) {
    throw httpError(400, '메시지나 첨부 파일을 추가하세요. 메시지는 32,000자 이하여야 합니다.');
  }
  const reviewer = requestedApprovalsReviewer(body.codexApprovalsReviewer);
  const model = requestedModel(body.model);
  const effort = requestedEffort(body.effort, body.provider);
  return { ...(body.modelRole ? { modelRole: body.modelRole } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}), requestId: body.requestId, provider: body.provider, prompt: body.prompt,
    ...(body.cwd !== undefined ? { cwd: body.cwd as string } : {}), ...(body.sessionMode === 'new' ? { sessionMode: 'new' as const } : {}),
    ...(body.targetSessionId !== undefined ? { targetSessionId: body.targetSessionId as string } : {}), ...(attachments ? { attachments } : {}), ...(attachmentIds ? { attachmentIds } : {}),
    ...(reviewer && body.provider === 'codex' ? { codexApprovalsReviewer: reviewer } : {}) };
}

export function parseAutoPromptSuggestion(body: Record<string, unknown>): AutoPromptSuggestionRequest {
  if (Object.keys(body).some(key => !['prompt', 'provider', 'cwd', 'node'].includes(key))) throw httpError(400, '추천 요청에는 요청 내용, 도구, 폴더와 컴퓨터만 지정할 수 있습니다.');
  if (typeof body.prompt !== 'string' || body.prompt.trim().length < AUTO_PROMPT_SUGGESTION_MIN_CHARS || body.prompt.length > 32_000) {
    throw httpError(400, `추천은 ${AUTO_PROMPT_SUGGESTION_MIN_CHARS}자 이상, 32,000자 이하의 요청에만 받을 수 있습니다.`);
  }
  if (body.provider !== 'claude' && body.provider !== 'codex') throw httpError(400, 'Claude 또는 Codex를 선택하세요.');
  if (body.cwd !== undefined && (typeof body.cwd !== 'string' || !body.cwd.startsWith('/') || body.cwd.length > 4096 || body.cwd.includes('\0'))) {
    throw httpError(400, '목록에서 작업 폴더를 선택하거나 Auto를 선택하세요.');
  }
  if (body.node !== undefined && (typeof body.node !== 'string' || !/^[a-f0-9]{32}$/.test(body.node))) throw httpError(400, '연결된 컴퓨터가 아닙니다.');
  return { prompt: body.prompt, provider: body.provider, ...(body.cwd !== undefined ? { cwd: body.cwd as string } : {}), ...(body.node !== undefined ? { node: body.node as string } : {}) };
}

/** The status a failure answers with: its own when it carries one, otherwise judged from the message. */
export function errorStatus(error: unknown): number {
  if (error instanceof TowerError) return Number(statusOf(error));
  const message = error instanceof Error ? error.message : '';
  return typeof error === 'object' && error && 'statusCode' in error ? Number((error as { statusCode: unknown }).statusCode)
    : /not found|unknown session|찾을 수 없/i.test(message) ? 404 : /busy|already|resum|subagent|queue|재개|대기열|CLI|executable/i.test(message) ? 409 : 500;
}

/** Where an error came from matters to a caller deciding whether to send again. */
export type Disposition = 'not-admitted' | 'uncertain';
export function errorDisposition(error: unknown): Disposition | undefined {
  const value = (error as { disposition?: unknown })?.disposition;
  if (value === 'handoff' || value === 'not-admitted') return 'not-admitted';
  if (value === 'uncertain' || value === 'unknown' || value === 'committed') return 'uncertain';
  return undefined;
}

type Request = IncomingMessage | Http2ServerRequest;
type Target = { kind: 'chat' | 'auto'; sessionId: string };
export const uploadProgressPath = (path: string) => /^\/api\/(?:nodes\/[a-f0-9]{32}\/)?attachment-uploads\/[a-f0-9-]{36}(?:\/(complete|cancel))?$/.test(path);
export const uploadAppendPath = (path: string) => /^\/api\/(?:nodes\/[a-f0-9]{32}\/)?attachment-uploads\/[a-f0-9-]{36}$/.test(path);
const running = new WeakMap<AttachmentUploads, number>();
export async function attachmentUploadRoute(req: Request, res: ServerResponse, url: URL, uploads: AttachmentUploads | undefined, owner: string,
  authorize: (target: Target) => Promise<Target>, available: () => boolean, mutation: () => void = () => {}): Promise<boolean> {
  const path = decodeURIComponent(url.pathname);
  const start = path.match(/^\/api\/(sessions|auto-prompts)\/([^/]+)\/attachment-uploads$/);
  const item = path.match(/^\/api\/attachment-uploads\/([a-f0-9-]{36})(?:\/(complete|cancel))?$/);
  if (!start && !item) return false;
  if (!uploads) throw httpError(503, '원본 파일 업로드를 사용할 수 없습니다.');
  const json = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  if (start && req.method === 'POST') {
    mutation();
    if (!available()) throw Object.assign(httpError(503, '실행 작업자가 원본 첨부 지원 업데이트를 기다리고 있습니다. 잠시 후 다시 시도하세요.'), { disposition: 'not-admitted' });
    if (!req.headers['content-type']?.startsWith('application/json')) throw httpError(415, 'JSON 요청이 필요합니다.');
    const target = await authorize({ kind: start[1] === 'sessions' ? 'chat' : 'auto', sessionId: start[2] });
    if (target.kind === 'auto') {
      if (!UUID.test(target.sessionId)) throw httpError(400, '요청 ID 형식이 올바르지 않습니다.');
      target.sessionId = target.sessionId.toLowerCase();
    }
    const body = await readJson(req);
    if (Object.keys(body).some(key => !['name', 'mimeType', 'size'].includes(key))) throw httpError(400, '첨부 파일 형식이 올바르지 않습니다.');
    json(201, await uploads.start(target, body.name as string, body.mimeType as string, body.size as number, owner)); return true;
  }
  if (!item || !['GET', 'POST'].includes(req.method ?? '') || (req.method === 'GET' && item[2])) throw httpError(404, '찾을 수 없습니다.');
  if (req.method === 'GET') {
    const state = await uploads.status(item[1], owner);
    await authorize(state.target);
    json(200, { offset: state.offset }); return true;
  }
  const active = running.get(uploads) ?? 0;
  if (active >= 4) throw httpError(429, '동시에 업로드하는 파일이 너무 많습니다. 잠시 후 다시 시도하세요.');
  running.set(uploads, active + 1);
  try {
    const state = await uploads.status(item[1], owner);
    await authorize(state.target);
    if (item[2]) {
      if (!req.headers['content-type']?.startsWith('application/json')) throw httpError(415, 'JSON 요청이 필요합니다.');
      if (Object.keys(await readJson(req)).length) throw httpError(400, '첨부 파일 형식이 올바르지 않습니다.');
      if (item[2] === 'cancel') { await uploads.cancel(item[1], owner); json(200, { ok: true }); }
      else { const attachment = await uploads.complete(item[1], owner); await authorize(state.target); json(200, { attachment }); }
      return true;
    }
    if (req.headers['content-type'] !== 'application/octet-stream') throw httpError(415, '원본 파일 요청이 필요합니다.');
    const raw = url.searchParams.get('offset');
    if (raw === null || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw httpError(400, '업로드 위치가 올바르지 않습니다.');
    const result = await uploads.append(item[1], owner, Number(raw), req.iterator({ destroyOnReturn: false }));
    await authorize(state.target); json(200, result);
  } catch (error) { req.resume(); throw error; }
  finally { running.set(uploads, (running.get(uploads) ?? 1) - 1); }
  return true;
}
