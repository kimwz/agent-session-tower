/**
 * What this browser remembers about how the Todo page looks, beside the display settings (DisplayMenu.tsx): which
 * cards have their sub-tasks folded. Sub-tasks show unless folded; the newest 500 folds are kept. Without storage
 * (a private window that refuses it) the folds last until the page is reloaded.
 */

const FOLDED_KEY = 'tower.todo.collapsedSubtasks';
const MAX_FOLDED = 500;
let memory: string[] | null = null;

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
  memory = [...read().filter(id => id !== taskId), ...(folded ? [taskId] : [])].slice(-MAX_FOLDED);
  // best-effort: storage that refuses keeps the fold for this page only.
  try { window.localStorage.setItem(FOLDED_KEY, JSON.stringify(memory)); } catch { /* best-effort: see above */ }
}

/** For tests: forget what was read, so the next read sees storage again. */
export const forgetFoldedForTests = () => { memory = null; };
