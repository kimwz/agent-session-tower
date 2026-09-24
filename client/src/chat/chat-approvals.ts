import { api, ApiError } from '../common/lib';
import type { Run, RunApprovalResponse } from '../../../shared/types';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { pathFor } from '../remote/scope';

export type ApprovalDecision = RunApprovalResponse;
type Result = 'accepted' | 'stale';
type State = 'idle' | 'submitting' | 'settled';
const pending = new Map<string, { promise: Promise<Result>; state: State; runId: string; approvalId: string }>();
const listeners = new Set<() => void>();
const keyFor = (runId: string, approvalId: string) => JSON.stringify([runId, approvalId]);
const changed = () => listeners.forEach(listener => listener());
export function subscribeApprovalDecisions(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function approvalDecisionState(runId: string, approvalId: string): State { return pending.get(keyFor(runId, approvalId))?.state || 'idle'; }
export function safeApprovalUrl(value: string): string | undefined {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}
/** Blank required text/list fields are explicit empty answers; untouched optional fields stay absent. */
export function formApprovalContent(schema: Record<string, unknown>, values: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  const emptyRequired = (Array.isArray(schema.required) ? schema.required : []).filter((name): name is string => typeof name === 'string' && !Object.hasOwn(values, name))
    .flatMap(name => {
      const field = properties[name];
      if (field.type === 'array') return [[name, []]];
      if (field.type === 'string' && !field.enum && !field.oneOf && !field.format && !(typeof field.minLength === 'number' && field.minLength > 0)) return [[name, '']];
      return [];
    });
  return { ...Object.fromEntries(emptyRequired), ...values };
}

/** Pass the complete authoritative snapshot, never conversation-filtered runs. No answers are retained. */
export function reconcileApprovalDecisions(runs: readonly Run[]) {
  for (const [key, entry] of pending) {
    if (entry.state !== 'settled') continue;
    const run = runs.find(run => run.id === entry.runId);
    if (!run || !['running', 'queued'].includes(run.status) || !run.approvals?.some(approval => approval.id === entry.approvalId)) pending.delete(key);
  }
}

/** A repeated click or remount must not submit a second decision while one is in flight. */
export function submitApprovalDecision(runId: string, approvalId: string, decision: ApprovalDecision, token: string): Promise<'accepted' | 'stale'> {
  const key = keyFor(runId, approvalId);
  const existing = pending.get(key);
  if (existing) return existing.promise;
  const request = api(pathFor(runId, id => `/api/runs/${encodeURIComponent(id)}/approvals/${encodeURIComponent(approvalId)}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token },
    body: JSON.stringify(typeof decision === 'string' ? { decision } : decision),
  }).then(() => 'accepted' as const).catch(error => {
    if (error instanceof ApiError && error.status === 409) return 'stale' as const;
    throw error;
  }).then(result => { const entry = pending.get(key); if (entry) entry.state = 'settled'; changed(); return result; }, error => { pending.delete(key); changed(); throw error; });
  pending.set(key, { promise: request, state: 'submitting', runId, approvalId });
  changed();
  return request;
}
