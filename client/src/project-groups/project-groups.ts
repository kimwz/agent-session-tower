import { translate as t } from '../i18n/i18n';
import type { ProjectGroup, Session } from '../../../shared/types';
import { localPart } from '../remote/scope';

/** Temporary worktrees stay in session history but do not occupy the canvas, on any computer. */
function temporaryCanvasProject(cwd: string): boolean {
  return /^\/(?:private\/)?tmp(?:\/|$)/.test(localPart(cwd));
}

export function projectGroupLabel(cwd: string, title?: string, fallback?: string): string {
  return title?.trim() || fallback || localPart(cwd).split('/').filter(Boolean).at(-1) || t("프로젝트 없음");
}

export function projectGroupChoices(sessions: Session[], groups: ProjectGroup[]): [string, string][] {
  const titles = new Map(groups.map(group => [group.cwd, group.title]));
  const choices = new Map<string, string>();
  for (const session of sessions) {
    if (session.cwd) choices.set(session.cwd, projectGroupLabel(session.cwd, titles.get(session.cwd), session.project));
  }
  for (const group of groups) {
    if ((group.pinned || group.hidden) && !choices.has(group.cwd)) choices.set(group.cwd, projectGroupLabel(group.cwd, group.title));
  }
  return [...choices].sort(([aPath, aTitle], [bPath, bTitle]) => aTitle.localeCompare(bTitle) || aPath.localeCompare(bPath));
}

/** Persisted frames respect folder/search filters. Revealed hidden frames remain restorable beyond the card limit. */
export function visiblePinnedProjectGroups(groups: ProjectGroup[], sessions: Session[], project: string, query: string, showHidden = false, matchingSessions: Session[] = []): ProjectGroup[] {
  const term = query.trim().toLocaleLowerCase();
  const labels = new Map(sessions.filter(session => session.cwd).map(session => [session.cwd, session.project]));
  const matchingFolders = new Set(matchingSessions.map(session => session.cwd));
  return groups.filter(group => !temporaryCanvasProject(group.cwd) && (group.pinned || (showHidden && group.hidden)) && (showHidden || !group.hidden)
    && (project === 'all' || group.cwd === project)
    && (!term || `${group.title} ${group.cwd} ${labels.get(group.cwd) || ''}`.toLocaleLowerCase().includes(term)
      || (showHidden && group.hidden && matchingFolders.has(group.cwd))));
}

/** Hiding changes only the canvas projection, never session membership or the existing filters. */
export function canvasVisibleSessions(sessions: Session[], groups: ProjectGroup[], showHidden: boolean): Session[] {
  const hidden = new Set(groups.filter(group => group.hidden).map(group => group.cwd));
  const visible = sessions.filter(session => !temporaryCanvasProject(session.cwd) && (showHidden || !hidden.has(session.cwd)));
  return visible.length === sessions.length ? sessions : visible;
}

/** Keep the card ordering intact; empty pins follow in a stable, readable order. */
export function includePinnedProjectGroups(grouped: [string, Session[]][], pins: ProjectGroup[]): [string, Session[]][] {
  const present = new Set(grouped.map(([cwd]) => cwd));
  return [...grouped, ...pins.filter(group => !present.has(group.cwd))
    .sort((a, b) => projectGroupLabel(a.cwd, a.title).localeCompare(projectGroupLabel(b.cwd, b.title)) || a.cwd.localeCompare(b.cwd))
    .map(group => [group.cwd, []] as [string, Session[]])];
}
