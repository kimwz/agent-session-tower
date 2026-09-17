import type { Snapshot } from '../../shared/types.js';
import { computeConversationRevision } from '../../shared/conversation-revision.js';

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
