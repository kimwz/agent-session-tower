import { isAbsolute } from 'node:path';
import type { Run, Session } from '../../shared/types.js';
import { attachmentMetadata } from '../stores/attachments.js';
import { validEffort, validModelId } from '../providers/models.js';
import { PROVIDERS } from '../providers/discovery.js';

/** Nothing restored from disk is trusted: these guards decide what may re-enter the queue. */
export const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

export interface CreatedSession {
  session: Session;
  runId: string;
  confirmed: boolean;
  seenNative?: boolean;
  title?: string;
}

export function isSavedRun(value: unknown): value is Run {
  if (!value || typeof value !== 'object') return false;
  const run = value as Partial<Run>;
  return typeof run.id === 'string' && typeof run.sessionId === 'string' && typeof run.prompt === 'string'
    && typeof run.createdAt === 'string' && typeof run.output === 'string'
    && (run.model === undefined || validModelId(run.model))
    && (run.effort === undefined || validEffort(run.effort))
    && (run.codexApprovalsReviewer === undefined || ['user', 'auto_review'].includes(run.codexApprovalsReviewer))
    && (run.autoPromptId === undefined || UUID.test(run.autoPromptId))
    && (run.steering === undefined || isSavedSteering(run.steering, run))
    && (run.attachments === undefined || (Array.isArray(run.attachments) && run.attachments.length <= 10 && run.attachments.every(item => attachmentMetadata(item))))
    && ['queued', 'running', 'completed', 'error', 'cancelled'].includes(run.status ?? '');
}

export function isSavedSteering(value: unknown, run: Partial<Run>): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const steering = value as Partial<NonNullable<Run['steering']>>;
  const timestamp = (candidate: unknown): candidate is string => typeof candidate === 'string' && Number.isFinite(Date.parse(candidate));
  return typeof steering.targetRunId === 'string' && UUID.test(steering.targetRunId) && steering.targetRunId !== run.id
    && ['sending', 'delivered', 'uncertain'].includes(steering.state ?? '') && timestamp(steering.requestedAt)
    && (steering.deliveredAt === undefined || timestamp(steering.deliveredAt))
    && (steering.state !== 'delivered' || steering.deliveredAt !== undefined)
    && run.status !== 'queued';
}

export function isCreatedSession(value: unknown): value is CreatedSession {
  if (!value || typeof value !== 'object') return false;
  const created = value as Partial<CreatedSession>;
  const session = created.session;
  return typeof created.runId === 'string' && typeof created.confirmed === 'boolean' && !!session
    && PROVIDERS.includes(session.provider) && typeof session.id === 'string' && session.id.startsWith(`${session.provider}:`)
    && typeof session.nativeId === 'string' && (!created.confirmed || UUID.test(session.nativeId))
    && typeof session.cwd === 'string' && isAbsolute(session.cwd)
    && typeof session.title === 'string' && typeof session.createdAt === 'string' && typeof session.updatedAt === 'string'
    && typeof session.lastMessage === 'string' && (created.title === undefined || typeof created.title === 'string');
}
