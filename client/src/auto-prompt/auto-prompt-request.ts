import type { AutoPromptJob, AutoPromptRequest } from '../../../shared/types';
import { api, ApiError } from '../common/lib';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { nodePath, scopedId, scopeJob } from '../remote/scope';

export const autoPromptPending = (job: AutoPromptJob) => job.status === 'queued' || job.status === 'routing' || job.status === 'dispatching';

/** Snapshots and individual responses can arrive out of order. Never roll a job back. */
export function newerAutoPromptJob(current: AutoPromptJob | undefined, incoming: AutoPromptJob): AutoPromptJob {
  if (!current || current.id !== incoming.id) return incoming;
  if (!autoPromptPending(current)) return current;
  if (incoming.updatedAt < current.updatedAt) return current;
  const order = { queued: 0, routing: 1, dispatching: 2, completed: 3, error: 3, cancelled: 3 };
  if (order[incoming.status] < order[current.status]) return current;
  if (current.status === 'routing' && incoming.status === 'routing' && current.stage === 'session' && incoming.stage === 'directory') return current;
  return incoming;
}

type RequestApi = typeof api;
export type AutoPromptOutcome = { job: AutoPromptJob } | { error: unknown; uncertain: boolean };
export interface AutoPromptAttempt {
  id: string;
  send: (token: string) => Promise<AutoPromptOutcome>;
  takeCompletedSession: (job: AutoPromptJob) => string | undefined;
}

/**
 * One immutable request survives dialog close, response loss, and explicit retries. On a joined computer
 * (`node`) the request and its job carry that computer's name in this page.
 */
export function createAutoPromptAttempt(request: AutoPromptRequest, requestApi: RequestApi = api, node?: string): AutoPromptAttempt {
  const id = scopedId(node, request.requestId);
  const body = JSON.stringify(request);
  const named = (result: { job: AutoPromptJob }) => node ? { job: scopeJob(node, result.job) } : result;
  let inFlight: Promise<AutoPromptOutcome> | undefined;
  let completionTaken = false;
  // Once one send could have been taken, a later refusal speaks only for itself, never for that earlier send.
  let everUncertain = false;
  async function submit(token: string): Promise<AutoPromptOutcome> {
    try {
      return named(await requestApi<{ job: AutoPromptJob }>(nodePath(node, '/api/auto-prompts'), {
        method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token }, body, signal: AbortSignal.timeout(20_000),
      }));
    } catch (error) {
      // The server said it did not take the request (such as a worker that must update first): nothing to recover.
      if (!everUncertain && error instanceof ApiError && error.disposition === 'not-admitted') return { error, uncertain: false };
      try {
        return named(await requestApi<{ job: AutoPromptJob }>(nodePath(node, `/api/auto-prompts/${encodeURIComponent(request.requestId)}`), { signal: AbortSignal.timeout(10_000) }));
      } catch (lookupError) {
        // A missing job alone does not prove that an interrupted POST was rejected.
        const rejected = !everUncertain && error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408
          && lookupError instanceof ApiError && lookupError.status === 404;
        if (!rejected) everUncertain = true;
        return { error, uncertain: !rejected };
      }
    }
  }
  return { id, takeCompletedSession(job) {
    if (completionTaken || job.id !== id || job.status !== 'completed' || !job.sessionId) return undefined;
    completionTaken = true;
    return job.sessionId;
  }, send(token) {
    if (!inFlight) inFlight = submit(token).finally(() => { inFlight = undefined; });
    return inFlight;
  } };
}
