/**
 * What this browser remembers about how the Todo page looks, beside the display settings (DisplayMenu.tsx): which
 * cards have their sub-tasks folded, and whether the overview shows Today beside it. Sub-tasks show unless folded; the
 * newest 500 folds are kept. Without storage (a private window that refuses it) both last until the page is reloaded.
 */

const FOLDED_KEY = 'tower.todo.collapsedSubtasks';
const MAX_FOLDED = 500;
let memory: string[] | null = null;
/** Saving failed once: this page's memory is what is known, not storage. */
let unsaved = false;

function read(): string[] {
  if (memory) return memory;
  try {
    const saved = JSON.parse(window.localStorage.getItem(FOLDED_KEY) ?? '[]') as unknown;
    memory = Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string').slice(-MAX_FOLDED) : [];
    // best-effort: unreadable or damaged storage starts with nothing folded.
  } catch { memory = []; }
  return memory;
}

export const subtasksFolded = (taskId: string): boolean => read().includes(taskId);

export function setSubtasksFolded(taskId: string, folded: boolean): void {
  // Read again first, as another tab may have folded something since; not when saving fails, as memory has the folds.
  if (!unsaved) memory = null;
  memory = [...read().filter(id => id !== taskId), ...(folded ? [taskId] : [])].slice(-MAX_FOLDED);
  // best-effort: storage that refuses keeps the fold for this page only.
  try { window.localStorage.setItem(FOLDED_KEY, JSON.stringify(memory)); unsaved = false; } catch { unsaved = true; }
}

const TODAY_PANEL_KEY = 'tower.todo.overviewToday';
/** The overview's Today panel as this page last set it, kept when storage refuses it. */
let todayPanel: boolean | null = null;

/** Whether the overview shows Today beside it: on until the owner turns it off. */
export function todayPanelShown(): boolean {
  if (todayPanel !== null) return todayPanel;
  // best-effort: unreadable storage shows the panel.
  try { return window.localStorage.getItem(TODAY_PANEL_KEY) !== 'off'; } catch { return true; }
}

export function setTodayPanelShown(shown: boolean): void {
  todayPanel = shown;
  // best-effort: storage that refuses keeps the choice for this page only.
  try { window.localStorage.setItem(TODAY_PANEL_KEY, shown ? 'on' : 'off'); todayPanel = null; } catch { /* kept above */ }
}

/** For tests: forget what was read, so the next read sees storage again. */
export const forgetFoldedForTests = () => { memory = null; unsaved = false; todayPanel = null; };
