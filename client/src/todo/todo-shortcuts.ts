/**
 * The Todo page's keys: `Q` add, `/` search, `B` board, `C` calendar, `W`/`M` calendar by week or month, `Shift+V`
 * board or calendar, `V` the list of lists to go to (`readSwitchKey`), `G` then `A`/`T`/`U`/`I` everything, today, upcoming, inbox;
 * arrows move the chosen task on the board; on the chosen task `E` complete, `Shift+E` complete and add the next, `N`
 * add the next, `Enter` open; `Esc` close, or let go of the chosen task; `⌘Z`/`Ctrl+Z` undo the last change. `1` and
 * `2` switch pages (app/page-shortcuts.ts).
 */

export type Direction = 'up' | 'down' | 'left' | 'right';
export type TodoShortcut =
  | { action: 'add' | 'search' | 'views' | 'layout' | 'board' | 'calendar' | 'week' | 'month' | 'all' | 'today' | 'upcoming' | 'inbox' | 'complete' | 'complete-next' | 'add-next' | 'open' | 'close' | 'undo' }
  | { action: 'move'; direction: Direction };

const ARROWS: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

export interface ShortcutKey { key: string; code?: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean; isComposing?: boolean; repeat?: boolean }

/** The number a key gives by where it sits; a number pad counts only as numbers (with Num Lock off its keys are arrows). */
export function digitOf(event: Pick<ShortcutKey, 'code' | 'key'>): number | undefined {
  const digit = event.code?.match(/^Digit([0-9])$/)?.[1] ?? (event.code?.startsWith('Numpad') && /^[0-9]$/.test(event.key) ? event.key : undefined);
  return digit === undefined ? undefined : Number(digit);
}

/** Reads one key; `pending` is whether `G` was the key before. Answers what to do and whether `G` now waits. */
export function readShortcut(event: ShortcutKey, pending: boolean): { shortcut?: TodoShortcut; pending: boolean } {
  if (event.isComposing) return { pending: false };
  // Letters and digits by where they sit, as the canvas reads them, so a Korean input mode keeps the same keys.
  const physical = event.code?.match(/^(?:Key|Digit)([A-Z0-9])$/)?.[1];
  const key = physical ? physical.toLowerCase() : event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && key === 'z') return { shortcut: { action: 'undo' }, pending: false };
  if (event.metaKey || event.ctrlKey || event.altKey) return { pending: false };
  if (pending) {
    const go = ({ a: 'all', t: 'today', u: 'upcoming', i: 'inbox' } as const)[key as 'a' | 't' | 'u' | 'i'];
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
    case 'v': return { shortcut: { action: 'views' }, pending: false };
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

export type SwitchKey = { action: 'choose' | 'mark'; index: number } | { action: 'close' };

/**
 * A key while the list of lists (`V`) is open, `count` entries long with entry `index` marked: a number chooses the
 * entry it numbers, from 0 (by where the key sits, as the page keys read numbers), the up and down arrows mark the
 * entry above or below (around at either end), `Enter` chooses the marked one and `V` closes the list (not when held
 * down, so the press that opened it does not close it). Escape is the popover's own. Nothing for a key the list leaves
 * alone.
 */
export function readSwitchKey(event: ShortcutKey, count: number, index: number): SwitchKey | undefined {
  if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return undefined;
  const digit = event.shiftKey ? undefined : digitOf(event);
  if (digit !== undefined) return digit < count ? { action: 'choose', index: digit } : undefined;
  if (event.key === 'ArrowDown') return { action: 'mark', index: (index + 1) % count };
  if (event.key === 'ArrowUp') return { action: 'mark', index: (index - 1 + count) % count };
  // The list can shrink while open (a project archived elsewhere).
  if (event.key === 'Enter' && !event.shiftKey) return { action: 'choose', index: Math.min(index, count - 1) };
  if (!event.shiftKey && !event.repeat && (event.code === 'KeyV' || event.key.toLowerCase() === 'v')) return { action: 'close' };
  return undefined;
}

/** Fields being typed in: keys go to them, not to the page. */
export const TYPING_FIELDS = 'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]), textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]';
export const typingIn = (element: Element | null) => !!element?.closest(TYPING_FIELDS);
