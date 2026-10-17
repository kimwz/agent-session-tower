import type { TowerPage } from '../todo/PageSwitch';

type PageKey = Pick<KeyboardEvent, 'code' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'repeat' | 'defaultPrevented' | 'isComposing'>;

/** The page a key switches to: `1` the canvas, `2` the todos, by where the key sits (a Korean input mode included). */
export function pageShortcut(event: PageKey): TowerPage | undefined {
  if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.defaultPrevented || event.isComposing) return undefined;
  if (event.code === 'Digit1' || event.code === 'Numpad1') return 'canvas';
  if (event.code === 'Digit2' || event.code === 'Numpad2') return 'todo';
  return undefined;
}

/** Where `1` and `2` stay letters: a field being typed in, a dialog, or one of the Todo page's popovers, menus or Quick Add. */
export const PAGE_KEYS_OFF = 'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]), textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], dialog, [role="dialog"], [aria-modal="true"], .todo-popover';
