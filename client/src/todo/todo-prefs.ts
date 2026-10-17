/**
 * What this browser remembers about how the Todo page looks, beside the display settings (DisplayMenu.tsx): which
 * cards have their sub-tasks folded. Sub-tasks show unless folded; the newest 500 folds are kept. Without storage
 * (a private window that refuses it) the folds last until the page is reloaded.
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

/** For tests: forget what was read, so the next read sees storage again. */
export const forgetFoldedForTests = () => { memory = null; unsaved = false; };
