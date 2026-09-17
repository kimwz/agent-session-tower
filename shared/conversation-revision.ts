import type { Run, Session } from './types.js';

/** Keep this format stable: existing browser read markers persist across deployments. */
export function computeConversationRevision(session: Session, runs: readonly Run[] = []): string {
  const latest = runs.filter(run => run.sessionId === session.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))[0];
  const content = JSON.stringify([
    session.messageCount, session.lastMessage, session.lastRequestAt || '', session.lastCompletedAt || '',
    latest ? [latest.id, latest.status, latest.output, latest.error || ''] : null,
  ]);
  let first = 2166136261;
  let second = 5381;
  for (let i = 0; i < content.length; i++) {
    const character = content.charCodeAt(i);
    first = Math.imul(first ^ character, 16777619);
    second = Math.imul(second, 33) ^ character;
  }
  return `${content.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
}
