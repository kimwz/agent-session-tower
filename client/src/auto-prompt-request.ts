import type { AutoPromptJob, AutoPromptRequest } from '../../shared/types';
import { api, ApiError } from './lib';

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

/** One immutable request survives dialog close, response loss, and explicit retries. */
export function createAutoPromptAttempt(request: AutoPromptRequest, requestApi: RequestApi = api): AutoPromptAttempt {
  const id = request.requestId;
  const body = JSON.stringify(request);
  let inFlight: Promise<AutoPromptOutcome> | undefined;
  let completionTaken = false;
  async function submit(token: string): Promise<AutoPromptOutcome> {
    try {
      return await requestApi<{ job: AutoPromptJob }>('/api/auto-prompts', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token }, body, signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      try {
        return await requestApi<{ job: AutoPromptJob }>(`/api/auto-prompts/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10_000) });
      } catch (lookupError) {
        // A missing job alone does not prove that an interrupted POST was rejected.
        const rejected = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408
          && lookupError instanceof ApiError && lookupError.status === 404;
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
