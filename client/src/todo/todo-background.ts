/**
 * A click on the Todo page's empty space, as a click on the canvas's empty pane: it closes what is shown over the page
 * and does nothing else. The canvas's pane is React Flow's to tell (`onPaneClick`); the page tells its own here.
 */

/** What a click on the page acts on itself; a click on anything else in the main area is on its empty space. */
export const PAGE_CONTROLS = '.todo-card, .todo-cal-entry, .todo-cal-block, button, a, input, textarea, select, label, summary, [role="button"], [role="tab"], [role="radio"], .todo-popover';

export interface PageClick {
  /** Where the click ended, and where its press began (read before the press closed any popover). */
  target: EventTarget | null;
  pressedOn: EventTarget | null;
  /** A popover was open when the press began: the click closed it. */
  popover: boolean;
  /** The target is inside the page's main area. */
  inside: (target: Element) => boolean;
}

/**
 * What a click on the page's empty space closes, if anything: the conversation over the page first (as Esc closes it
 * first), else the open task. A click that closed a popover, or that ends somewhere else than it began (a drop), is
 * none; nor is one on a control (a card opens that card, which makes the conversation give way by itself).
 */
export function backgroundClose(click: PageClick, over: { conversation?: () => void; task?: () => void }): (() => void) | undefined {
  if (click.popover || click.pressedOn !== click.target) return undefined;
  const close = over.conversation ?? over.task;
  if (!close || !(click.target instanceof Element) || !click.inside(click.target) || click.target.closest(PAGE_CONTROLS)) return undefined;
  return close;
}
