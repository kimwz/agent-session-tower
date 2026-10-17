/**
 * The Todo page's keys (design 7.6): `Q` add, `/` search, `Shift+V` board or calendar, `G` then `T`/`U`/`I` today,
 * upcoming, inbox; on the chosen task `E` complete, `Shift+E` complete and add the next, `N` add the next, `1`–`4`
 * priority, `Enter` open; `Esc` close; `⌘Z`/`Ctrl+Z` undo the last change.
 */

export type TodoShortcut =
  | { action: 'add' | 'search' | 'layout' | 'today' | 'upcoming' | 'inbox' | 'complete' | 'complete-next' | 'add-next' | 'open' | 'close' | 'undo' }
  | { action: 'priority'; priority: 1 | 2 | 3 | 4 };

export interface ShortcutKey { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean; isComposing?: boolean }

/** Reads one key; `pending` is whether `G` was the key before. Answers what to do and whether `G` now waits. */
export function readShortcut(event: ShortcutKey, pending: boolean): { shortcut?: TodoShortcut; pending: boolean } {
  if (event.isComposing) return { pending: false };
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
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
    case '1': case '2': case '3': case '4': return { shortcut: { action: 'priority', priority: Number(key) as 1 | 2 | 3 | 4 }, pending: false };
    case 'Enter': return { shortcut: { action: 'open' }, pending: false };
    case 'Escape': return { shortcut: { action: 'close' }, pending: false };
    default: return { pending: false };
  }
}

/** Keys go to a field being typed in, not to the page. */
export const typingIn = (element: Element | null) => !!element?.closest('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]), textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
