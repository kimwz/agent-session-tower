import { useSyncExternalStore } from 'react';
import type { SkillSummary } from '../../../shared/skills';

/** Opens the skills panel from anywhere on the page, such as a project folder's menu; the header button shows it. */
const listeners = new Set<(cwd?: string) => void>();

export function openSkills(cwd?: string): void { for (const listener of listeners) listener(cwd); }

export function onOpenSkills(listener: (cwd?: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The latest proposal count the header button fetched, so a project folder's menu can point at its own proposals. */
let summary: SkillSummary = { proposals: 0 };
const watchers = new Set<() => void>();
export function publishSkillSummary(next: SkillSummary): void { summary = next; for (const watcher of watchers) watcher(); }
export function useSkillSummary(): SkillSummary {
  return useSyncExternalStore(watcher => { watchers.add(watcher); return () => { watchers.delete(watcher); }; }, () => summary, () => summary);
}
