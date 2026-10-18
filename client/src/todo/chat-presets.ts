import { DEFAULT_CHAT_PRESETS } from '../../../shared/todo/chat-presets';
import { translate as t } from '../i18n/i18n';

/**
 * The empty issue chat's first-message buttons as the page shows them: the owner's saved list as written, else the
 * defaults in the page's language (shared/todo/chat-presets.ts).
 */
export const shownChatPresets = (saved: readonly string[] | null | undefined): string[] => saved ? [...saved] : DEFAULT_CHAT_PRESETS.map(preset => t(preset));

/** The settings editor's rows as they are saved: trimmed, blank rows left out. */
export const presetsToSave = (rows: readonly string[]): string[] => rows.map(row => row.trim()).filter(Boolean);

/**
 * Whether the editor's rows differ from what they started from. The start is kept as shown then, so the page's
 * language changing under untouched defaults is no edit; blank rows are not saved, so they are no edit either.
 */
export const presetsDirty = (rows: readonly string[], baseline: readonly string[]): boolean => JSON.stringify(presetsToSave(rows)) !== JSON.stringify(baseline);

/** Moves a row from one place to another, as a drag in the settings editor does. */
export function movePreset<T>(rows: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return [...rows];
  const next = [...rows];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
