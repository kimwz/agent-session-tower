import { api, ApiError } from './lib';

export type ApprovalDecision = 'allow' | 'deny';
const pending = new Map<string, Promise<'accepted' | 'stale'>>();

/** A repeated click or remount must not submit a second decision while one is in flight. */
export function submitApprovalDecision(runId: string, approvalId: string, decision: ApprovalDecision, token: string): Promise<'accepted' | 'stale'> {
  const key = JSON.stringify([runId, approvalId]);
  const existing = pending.get(key);
  if (existing) return existing;
  const request = api(`/api/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token },
    body: JSON.stringify({ decision }),
  }).then(() => 'accepted' as const).catch(error => {
    if (error instanceof ApiError && error.status === 409) return 'stale' as const;
    throw error;
  }).finally(() => { pending.delete(key); });
  pending.set(key, request);
  return request;
}
