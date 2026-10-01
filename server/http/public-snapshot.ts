import type { Snapshot } from '../../shared/types.js';
import { computeConversationRevision } from '../../shared/conversation-revision.js';
import { sessionSelector, sessionSummary, type SessionScope } from '../../shared/session-scope.js';

/** Native history supplies the transcript; broadcasts need only output change markers. */
export function publicSnapshot(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    sessions: snapshot.sessions.map(({ filePath: _filePath, ...session }) => ({
      ...session, readRevision: computeConversationRevision(session, snapshot.runs),
    })),
    runs: snapshot.runs.map(run => ({ ...run, output: '' })),
  };
}

/** Views of one public snapshot for pages that hold only some sessions; the shared work is done once. */
export function scopedViews(snapshot: Snapshot, now = Date.now()): (scope: SessionScope) => Snapshot {
  const select = sessionSelector(snapshot, now);
  let summary: Snapshot['sessionSummary'];
  return scope => ({ ...snapshot, sessions: select(scope), sessionScope: scope, sessionSummary: summary ??= sessionSummary(snapshot.sessions, snapshot.runs) });
}
