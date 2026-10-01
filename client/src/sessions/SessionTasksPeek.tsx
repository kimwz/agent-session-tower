import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { SessionTask } from '../../../shared/types';
import { relativeTime } from '../common/lib';
import { translate as t } from '../i18n/i18n';
import { Stage } from '../chat/SessionTasks';
import { taskTimeline } from '../chat/session-tasks';

/** How long the pointer rests on a session before its recent tasks show. */
export const PEEK_DELAY_MS = 600;
export const PEEK_TASKS = 3;
const PANEL_WIDTH = 300;

/** A session's latest tasks, newest first, as the floating card shows them. */
export function SessionTasksCard({ tasks }: { tasks?: readonly SessionTask[] }) {
  const { items } = taskTimeline(tasks);
  const more = items.length - PEEK_TASKS;
  return <>
    <strong>{t('최근 작업')}</strong>
    <ol>{items.slice(0, PEEK_TASKS).map(task => <li key={task.id} className={task.current ? 'current' : undefined}>
      <span className="session-tasks-peek-title">{task.title}</span>
      <span className="session-tasks-peek-meta"><Stage stage={task.stage} /><time dateTime={task.updatedAt}>{relativeTime(task.updatedAt)}</time></span>
    </li>)}</ol>
    {more > 0 && <span className="session-tasks-peek-more">{t('이전 작업 {0}개 더', { 0: more })}</span>}
  </>;
}

type Box = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>;

/**
 * Where the card goes: right of the row, inside the window; under it when the window has no room on the right.
 * Nothing for a row that is not laid out (a hidden list), so a card never shows where no row is.
 */
export function peekPlacement(row: Box, cardHeight: number, viewport: { width: number; height: number }, width = PANEL_WIDTH): { left: number; top: number } | undefined {
  if (!row.width || !row.height) return undefined;
  const top = Math.max(8, Math.min(row.top, viewport.height - cardHeight - 8));
  if (row.right + 10 + width <= viewport.width - 8) return { left: row.right + 10, top };
  return { left: Math.max(8, Math.min(row.left, viewport.width - width - 8)), top: Math.max(8, Math.min(row.bottom + 6, viewport.height - cardHeight - 8)) };
}

/**
 * Resting the mouse on a session in the list shows its latest tasks beside it, so what it works on is known without
 * opening it. Only a mouse rests: a touch or a press never opens it. It only shows — the row underneath keeps every
 * click — and leaving, pressing, or scrolling the list closes it.
 */
export function useSessionTasksPeek(tasks: readonly SessionTask[] | undefined) {
  const anchor = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ left: number; top: number }>();
  const has = !!tasks?.length;
  const leave = () => { clearTimeout(timer.current); timer.current = undefined; setOpen(false); };
  const enter = (event: ReactPointerEvent) => { clearTimeout(timer.current); if (has && event.pointerType === 'mouse') timer.current = setTimeout(() => setOpen(true), PEEK_DELAY_MS); };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { if (!has) leave(); }, [has]);
  // Looked at on every render while open, so a list that moves under it keeps the card beside its row.
  useLayoutEffect(() => {
    if (!open) { if (place) setPlace(undefined); return; }
    const row = anchor.current?.getBoundingClientRect();
    const next = row && peekPlacement(row, card.current?.offsetHeight ?? 160, { width: window.innerWidth, height: window.innerHeight });
    if (!next) { leave(); return; }
    if (next.left !== place?.left || next.top !== place?.top) setPlace(next);
  });
  useEffect(() => {
    if (!open) return;
    // Only scrolling what holds the row moves it; a chat following new messages elsewhere leaves the card alone.
    const scrolled = (event: Event) => { if (event.target instanceof Node && event.target.contains(anchor.current)) leave(); };
    window.addEventListener('wheel', leave, { passive: true });
    window.addEventListener('scroll', scrolled, true);
    window.addEventListener('resize', leave);
    window.addEventListener('pointerdown', leave, true);
    return () => { window.removeEventListener('wheel', leave); window.removeEventListener('scroll', scrolled, true); window.removeEventListener('resize', leave); window.removeEventListener('pointerdown', leave, true); };
  }, [open]);
  const panel = open && has ? createPortal(<div ref={card} className="session-tasks-peek" role="tooltip"
    style={{ width: PANEL_WIDTH, ...(place ? { left: place.left, top: place.top } : { visibility: 'hidden', left: 0, top: 0 }) }}><SessionTasksCard tasks={tasks} /></div>, document.body) : null;
  return { anchor, panel, rowProps: { onPointerEnter: enter, onPointerLeave: leave, onPointerDown: leave } };
}
