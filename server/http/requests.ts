import type { IncomingMessage } from 'node:http';
import type { Http2ServerRequest } from 'node:http2';
import type { AutoPromptRequest, CreateSessionRequest, MessageAttachments, RunApprovalResponse } from '../../shared/types.js';
import { MAX_ATTACHMENTS, MAX_TOTAL_ATTACHMENT_BYTES } from '../../shared/attachments.js';
import { requestedEffort, requestedModel } from '../providers/models.js';
import { requestedApprovalsReviewer } from '../providers/approvals.js';
import { normalizeSessionTitle } from '../stores/session-titles.js';

/** Request bodies that carry attachments may hold the base64 form of the largest allowed upload. */
export const ATTACHMENT_BODY_BYTES = Math.ceil(MAX_TOTAL_ATTACHMENT_BYTES / 3) * 4 + 256 * 1024;
export const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

export const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

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
export function parseCreateSession(body: Record<string, unknown>): CreateSessionRequest {
  if (body.provider !== 'claude' && body.provider !== 'codex') throw httpError(400, 'Claude 또는 Codex를 선택하세요.');
  if (typeof body.cwd !== 'string' || !body.cwd.trim()) throw httpError(400, '작업 폴더의 절대 경로를 입력하세요.');
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 32_000) throw httpError(400, '메시지는 1자 이상, 32,000자 이하여야 합니다.');
  const title = body.title === undefined ? undefined : normalizeSessionTitle(body.title);
  const model = requestedModel(body.model);
  const effort = requestedEffort(body.effort, body.provider);
  // Like the model override, an unusable value fails before admission; only a Codex thread has a reviewer.
  const reviewer = requestedApprovalsReviewer(body.codexApprovalsReviewer);
  return { provider: body.provider, cwd: body.cwd, prompt: body.prompt.trim(), ...(title ? { title } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}),
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

export function parseAutoPrompt(body: Record<string, unknown>): AutoPromptRequest {
  if (Object.keys(body).some(key => !['requestId', 'provider', 'cwd', 'prompt', 'attachments', 'codexApprovalsReviewer', 'model', 'effort'].includes(key))) {
    throw httpError(400, 'Auto Prompt 요청에는 폴더, 도구, 프롬프트와 첨부 파일만 지정할 수 있습니다.');
  }
  if (typeof body.requestId !== 'string' || !UUID.test(body.requestId)) throw httpError(400, 'Auto Prompt 요청 ID가 올바르지 않습니다.');
  if (body.provider !== 'claude' && body.provider !== 'codex') throw httpError(400, 'Claude 또는 Codex를 선택하세요.');
  if (body.cwd !== undefined && (typeof body.cwd !== 'string' || !body.cwd.startsWith('/') || body.cwd.length > 4096 || body.cwd.includes('\0'))) {
    throw httpError(400, '목록에서 작업 폴더를 선택하거나 Auto를 선택하세요.');
  }
  if (body.attachments !== undefined && !Array.isArray(body.attachments)) throw httpError(400, '첨부 파일 목록 형식이 올바르지 않습니다.');
  const attachments = body.attachments as AutoPromptRequest['attachments'];
  if ((attachments?.length || 0) > MAX_ATTACHMENTS) throw httpError(413, `첨부 파일은 최대 ${MAX_ATTACHMENTS}개까지 보낼 수 있습니다.`);
  if (typeof body.prompt !== 'string' || (!body.prompt.trim() && !attachments?.length) || body.prompt.length > 32_000) {
    throw httpError(400, '메시지나 첨부 파일을 추가하세요. 메시지는 32,000자 이하여야 합니다.');
  }
  const reviewer = requestedApprovalsReviewer(body.codexApprovalsReviewer);
  const model = requestedModel(body.model);
  const effort = requestedEffort(body.effort, body.provider);
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}), requestId: body.requestId, provider: body.provider, prompt: body.prompt,
    ...(body.cwd !== undefined ? { cwd: body.cwd as string } : {}), ...(attachments ? { attachments } : {}),
    ...(reviewer && body.provider === 'codex' ? { codexApprovalsReviewer: reviewer } : {}) };
}

/** The status a failure answers with: its own when it carries one, otherwise judged from the message. */
export function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : '';
  return typeof error === 'object' && error && 'statusCode' in error ? Number((error as { statusCode: unknown }).statusCode)
    : /not found|unknown session|찾을 수 없/i.test(message) ? 404 : /busy|already|resum|subagent|queue|재개|대기열|CLI|executable/i.test(message) ? 409 : 500;
}

/** Where an error came from matters to a caller deciding whether to send again. */
export type Disposition = 'not-admitted' | 'uncertain';
export function errorDisposition(error: unknown): Disposition | undefined {
  const value = (error as { disposition?: unknown })?.disposition;
  if (value === 'handoff' || value === 'not-admitted') return 'not-admitted';
  if (value === 'uncertain') return 'uncertain';
  return undefined;
}
