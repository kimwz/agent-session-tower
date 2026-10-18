import type { TowerPage } from '../todo/PageSwitch';
import { digitOf, TYPING_FIELDS } from '../todo/todo-shortcuts';

type PageKey = Pick<KeyboardEvent, 'code' | 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'repeat' | 'defaultPrevented' | 'isComposing'>;

/** The page a key switches to: `1` the canvas, `2` the todos, by where the key sits (a Korean input mode included). */
export function pageShortcut(event: PageKey): TowerPage | undefined {
  if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.defaultPrevented || event.isComposing) return undefined;
  const digit = digitOf(event);
  return digit === 1 ? 'canvas' : digit === 2 ? 'todo' : undefined;
}

/** Where `1` and `2` are not the page's: a field being typed in, a dialog, a workspace window, or a Todo popover or Quick Add. */
export const PAGE_KEYS_OFF = `${TYPING_FIELDS}, dialog, [role="dialog"], [aria-modal="true"], .workspace-overlay, .todo-popover`;
