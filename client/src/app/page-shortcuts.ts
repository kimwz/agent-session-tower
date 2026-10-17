import type { TowerPage } from '../todo/PageSwitch';
import { TYPING_FIELDS } from '../todo/todo-shortcuts';

type PageKey = Pick<KeyboardEvent, 'code' | 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'repeat' | 'defaultPrevented' | 'isComposing'>;

/** The page a key switches to: `1` the canvas, `2` the todos, by where the key sits (a Korean input mode included). */
export function pageShortcut(event: PageKey): TowerPage | undefined {
  if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.defaultPrevented || event.isComposing) return undefined;
  // A number pad counts only as numbers: with Num Lock off its keys are arrows.
  if (event.code === 'Digit1' || (event.code === 'Numpad1' && event.key === '1')) return 'canvas';
  if (event.code === 'Digit2' || (event.code === 'Numpad2' && event.key === '2')) return 'todo';
  return undefined;
}

/** Where `1` and `2` are not the page's: a field being typed in, a dialog, a workspace window, or a Todo popover or Quick Add. */
export const PAGE_KEYS_OFF = `${TYPING_FIELDS}, dialog, [role="dialog"], [aria-modal="true"], .workspace-overlay, .todo-popover`;
