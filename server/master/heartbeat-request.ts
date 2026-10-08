import type { Run, SessionDetail } from '../../shared/types.js';
import { latestNativeUserMessage } from '../runs/native-user-message.js';
import { sameRequest } from './session.js';

/** Identify this tracked work's latest native request, including system-notice continuations. */
export async function heartbeatRequest(runs: readonly Run[], run: Run, detail: SessionDetail): Promise<{ nativeRequestId: string; requestRunId: string } | undefined> {
  if ((detail.skipped ?? 0) > 0) return undefined;
  const user = await latestNativeUserMessage({ nativeSessionId: id => id }, run.sessionId, async () => detail);
  if (!user) return undefined;
  const lineage: Run[] = [];
  let current: Run | undefined = run;
  while (current) {
    if (lineage.length >= 32 || lineage.some(item => item.id === current!.id) || current.sessionId !== run.sessionId) return undefined;
    lineage.push(current);
    if (current.scheduled?.resume !== 'update' && current.scheduled?.resume !== 'permission') break;
    const parentId: string = current.scheduled.afterRunId;
    current = runs.find(item => item.id === parentId);
    if (!current) return undefined;
  }
  // Delivered steering is a real request, whereas Claude may project Tower's resume notice as system data.
  const ids = new Set(lineage.map(item => item.id));
  const steering = runs.filter(item => item.sessionId === run.sessionId && item.steering?.state === 'delivered' && ids.has(item.steering.targetRunId))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const requests = steering
    ? [...lineage.filter(item => Date.parse(item.createdAt) > Date.parse(steering.createdAt)), steering]
    : lineage;
  const matched = requests.find(item => {
    const expected = item.prompt.replace(/\s+/g, ' ').trim();
    return expected && sameRequest(user.text, expected) && Date.parse(user.timestamp) >= Date.parse(item.createdAt);
  });
  return matched ? { nativeRequestId: user.id, requestRunId: matched.id } : undefined;
}
