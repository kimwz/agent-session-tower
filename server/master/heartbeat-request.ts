import type { Run, SessionDetail } from '../../shared/types.js';
import { latestNativeUserMessage } from '../runs/native-user-message.js';
import { heartbeatRunLineage } from '../runs/continuations.js';
import { sameRequest } from './session.js';

/** Identify this tracked work's latest native request, including system-notice continuations. */
export async function heartbeatRequest(runs: readonly Run[], run: Run, detail: SessionDetail): Promise<{ nativeRequestId: string; requestRunId: string } | undefined> {
  if ((detail.skipped ?? 0) > 0) return undefined;
  const user = await latestNativeUserMessage({ nativeSessionId: id => id }, run.sessionId, async () => detail);
  if (!user) return undefined;
  const lineage = heartbeatRunLineage(runs, run);
  if (!lineage || lineage.some(item => item.ownerStopped)) return undefined;
  // Trusted Tower notice provenance, never a text prefix, distinguishes system steering from a new request.
  const ids = new Set(lineage.map(item => item.id));
  const steering = runs.filter(item => item.sessionId === run.sessionId && item.steering?.state === 'delivered' && ids.has(item.steering.targetRunId))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const genuine = steering.find(item => !item.updateWrapUp && item.permissionNotice?.targetRunId !== item.steering!.targetRunId);
  const requests = [...lineage, ...steering].filter(item => !genuine || Date.parse(item.createdAt) >= Date.parse(genuine.createdAt))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const matched = requests.find(item => {
    const expected = item.prompt.replace(/\s+/g, ' ').trim();
    return expected && sameRequest(user.text, expected) && Date.parse(user.timestamp) >= Date.parse(item.createdAt);
  });
  return matched ? { nativeRequestId: user.id, requestRunId: matched.id } : undefined;
}
