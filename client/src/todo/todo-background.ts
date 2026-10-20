/**
 * A click on the Todo page's empty space, as a click on the canvas's empty pane: it closes what is shown over the page
 * and does nothing else. The canvas's pane is React Flow's to tell (`onPaneClick`); the page tells its own here.
 */

/** What a click on the page acts on itself; a click on anything else in the main area is on its empty space. */
export const PAGE_CONTROLS = '.todo-card, .todo-cal-entry, .todo-cal-block, button, a, input, textarea, select, label, summary, [role="button"], [role="tab"], [role="radio"], .todo-popover';

export interface PageClick {
  /** The element in the page's main area the click ended on; null for anything outside it. */
  target: Pick<Element, 'closest'> | null;
  /** The press began on the same element (not a drop), and no popover was open then (the click did not close one). */
  plain: boolean;
}

/**
 * What a click on the page's empty space closes, if anything: the conversation over the page first (as Esc closes it
 * first), else the open task. A click on a control is none (a card opens that card, and the conversation gives way).
 */
export function backgroundClose(click: PageClick, over: { conversation?: () => void; task?: () => void }): (() => void) | undefined {
  const close = over.conversation ?? over.task;
  if (!close || !click.plain || !click.target || click.target.closest(PAGE_CONTROLS)) return undefined;
  return close;
}
