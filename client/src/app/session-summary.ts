import type { Session } from '../../../shared/types';
import type { SessionSummary } from '../../../shared/session-scope';
import type { ProjectFolder } from '../project-groups/project-groups';

type CanvasFolder = Pick<Session, 'cwd' | 'node' | 'project'>;
export interface PageSummary {
  counts: SessionSummary['counts'];
  /** Folders for project choices and folder search: every folder a main session ran in. */
  folders: ProjectFolder[];
  /** Folders of open main sessions: saved canvas places of the others are let go. */
  openFolders: CanvasFolder[];
  /** This computer's answer to whether anything would be on the canvas with no time filter. */
  canvasHistory: boolean;
  /** Open main sessions the summary does not cover (joined computers'), for the page to judge itself. */
  uncounted: Session[];
}

/**
 * What the page shows about all sessions. This computer's page holds only some of its sessions, so its numbers
 * come from the summary the server sends with them; a joined computer's sessions are all at hand and counted
 * here. Without a summary every held session is counted, as before. `mains`: the page's main sessions.
 */
export function pageSummary(local: SessionSummary | undefined, mains: readonly Session[]): PageSummary {
  const counted = local ? mains.filter(session => session.node) : [...mains];
  const open = counted.filter(session => !session.closed);
  const counts = { ...(local?.counts ?? { open: 0, closed: 0, working: 0, completed: 0 }) };
  counts.open += open.length;
  counts.closed += counted.length - open.length;
  counts.working += open.filter(session => session.status === 'working').length;
  counts.completed += open.filter(session => session.status === 'completed').length;
  return {
    counts,
    folders: [...local?.projects ?? [], ...counted],
    openFolders: [...(local?.projects ?? []).filter(folder => folder.open), ...open],
    canvasHistory: local?.canvasHistory ?? false,
    uncounted: open,
  };
}
