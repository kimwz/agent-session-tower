import { useSyncExternalStore } from 'react';
import type { SkillSummary } from '../../../shared/skills';
import { openSettings } from '../settings/settings-open';

/** Opens the skills from anywhere on the page, such as a project folder's menu, narrowed to that folder. */
export function openSkills(cwd?: string): boolean { return openSettings({ section: 'skills', cwd }); }

/** The latest proposal count the settings button fetched, so a project folder's menu can point at its own proposals. */
let summary: SkillSummary = { proposals: 0 };
const watchers = new Set<() => void>();
export function publishSkillSummary(next: SkillSummary): void { summary = next; for (const watcher of watchers) watcher(); }
export function useSkillSummary(): SkillSummary {
  return useSyncExternalStore(watcher => { watchers.add(watcher); return () => { watchers.delete(watcher); }; }, () => summary, () => summary);
}
