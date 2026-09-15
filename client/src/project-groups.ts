import { translate as t } from './i18n';
import type { ProjectGroup, Session } from '../../shared/types';

export function projectGroupLabel(cwd: string, title?: string, fallback?: string): string {
  return title?.trim() || fallback || cwd.split('/').filter(Boolean).at(-1) || t("프로젝트 없음");
}

export function projectGroupChoices(sessions: Session[], groups: ProjectGroup[]): [string, string][] {
  const titles = new Map(groups.map(group => [group.cwd, group.title]));
  const choices = new Map<string, string>();
  for (const session of sessions) {
    if (session.cwd) choices.set(session.cwd, projectGroupLabel(session.cwd, titles.get(session.cwd), session.project));
  }
  for (const group of groups) {
    if (group.pinned && !choices.has(group.cwd)) choices.set(group.cwd, projectGroupLabel(group.cwd, group.title));
  }
  return [...choices].sort(([aPath, aTitle], [bPath, bTitle]) => aTitle.localeCompare(bTitle) || aPath.localeCompare(bPath));
}

/** Pins bypass card filters, but still respect an explicit folder or group search. */
export function visiblePinnedProjectGroups(groups: ProjectGroup[], sessions: Session[], project: string, query: string): ProjectGroup[] {
  const term = query.trim().toLocaleLowerCase();
  const labels = new Map(sessions.filter(session => session.cwd).map(session => [session.cwd, session.project]));
  return groups.filter(group => group.pinned && (project === 'all' || group.cwd === project)
    && (!term || `${group.title} ${group.cwd} ${labels.get(group.cwd) || ''}`.toLocaleLowerCase().includes(term)));
}

/** Keep the card ordering intact; empty pins follow in a stable, readable order. */
export function includePinnedProjectGroups(grouped: [string, Session[]][], pins: ProjectGroup[]): [string, Session[]][] {
  const present = new Set(grouped.map(([cwd]) => cwd));
  return [...grouped, ...pins.filter(group => !present.has(group.cwd))
    .sort((a, b) => projectGroupLabel(a.cwd, a.title).localeCompare(projectGroupLabel(b.cwd, b.title)) || a.cwd.localeCompare(b.cwd))
    .map(group => [group.cwd, []] as [string, Session[]])];
}
