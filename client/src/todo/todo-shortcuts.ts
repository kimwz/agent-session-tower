/**
 * The Todo page's keys: `Q` add, `/` search, `B` board, `C` calendar, `W`/`M` calendar by week or month, `Shift+V`
 * board or calendar, `G` then `T`/`U`/`I` today, upcoming, inbox; arrows move the chosen task on the board; on the
 * chosen task `E` complete, `Shift+E` complete and add the next, `N` add the next, `Enter` open; `Esc` close, or let
 * go of the chosen task; `⌘Z`/`Ctrl+Z` undo the last change. `1` and `2` switch pages (app/page-shortcuts.ts).
 */

export type Direction = 'up' | 'down' | 'left' | 'right';
export type TodoShortcut =
  | { action: 'add' | 'search' | 'layout' | 'board' | 'calendar' | 'week' | 'month' | 'today' | 'upcoming' | 'inbox' | 'complete' | 'complete-next' | 'add-next' | 'open' | 'close' | 'undo' }
  | { action: 'move'; direction: Direction };

const ARROWS: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

export interface ShortcutKey { key: string; code?: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean; isComposing?: boolean }

/** Reads one key; `pending` is whether `G` was the key before. Answers what to do and whether `G` now waits. */
export function readShortcut(event: ShortcutKey, pending: boolean): { shortcut?: TodoShortcut; pending: boolean } {
  if (event.isComposing) return { pending: false };
  // Letters and digits by where they sit, as the canvas reads them, so a Korean input mode keeps the same keys.
  const physical = event.code?.match(/^(?:Key|Digit)([A-Z0-9])$/)?.[1];
  const key = physical ? physical.toLowerCase() : event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && key === 'z') return { shortcut: { action: 'undo' }, pending: false };
  if (event.metaKey || event.ctrlKey || event.altKey) return { pending: false };
  if (pending) {
    const go = ({ t: 'today', u: 'upcoming', i: 'inbox' } as const)[key as 't' | 'u' | 'i'];
    return go && !event.shiftKey ? { shortcut: { action: go }, pending: false } : { pending: false };
  }
  if (event.shiftKey) {
    if (key === 'v') return { shortcut: { action: 'layout' }, pending: false };
    if (key === 'e') return { shortcut: { action: 'complete-next' }, pending: false };
    return { pending: false };
  }
  switch (key) {
    case 'q': return { shortcut: { action: 'add' }, pending: false };
    case '/': return { shortcut: { action: 'search' }, pending: false };
    case 'g': return { pending: true };
    case 'e': return { shortcut: { action: 'complete' }, pending: false };
    case 'n': return { shortcut: { action: 'add-next' }, pending: false };
    case 'b': return { shortcut: { action: 'board' }, pending: false };
    case 'c': return { shortcut: { action: 'calendar' }, pending: false };
    case 'w': return { shortcut: { action: 'week' }, pending: false };
    case 'm': return { shortcut: { action: 'month' }, pending: false };
    case 'Enter': return { shortcut: { action: 'open' }, pending: false };
    case 'Escape': return { shortcut: { action: 'close' }, pending: false };
    default: return ARROWS[key] ? { shortcut: { action: 'move', direction: ARROWS[key] }, pending: false } : { pending: false };
  }
}

/** Keys go to a field being typed in, not to the page. */
export const typingIn = (element: Element | null) => !!element?.closest('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]), textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
