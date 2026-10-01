import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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

/**
 * Resting the pointer on a session in the list shows its latest tasks beside it, so what it works on is known without
 * opening it. It only shows: the row underneath keeps every click, and moving away, scrolling or pressing closes it.
 */
export function useSessionTasksPeek(tasks: readonly SessionTask[] | undefined): { anchor: React.RefObject<HTMLButtonElement | null>; enter: () => void; leave: () => void; panel: ReactNode } {
  const anchor = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ left: number; top: number }>();
  const has = !!tasks?.length;
  const enter = () => { clearTimeout(timer.current); if (has) timer.current = setTimeout(() => setOpen(true), PEEK_DELAY_MS); };
  const leave = () => { clearTimeout(timer.current); setOpen(false); };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { if (!has) leave(); }, [has]);
  // Beside the row, to its right, inside the window; under it when the window has no room on the right.
  useLayoutEffect(() => {
    if (!open) { setPlace(undefined); return; }
    const row = anchor.current?.getBoundingClientRect();
    if (!row) return;
    const height = card.current?.offsetHeight ?? 160;
    const top = Math.max(8, Math.min(row.top, window.innerHeight - height - 8));
    setPlace(row.right + 10 + PANEL_WIDTH <= window.innerWidth - 8 ? { left: row.right + 10, top }
      : { left: Math.max(8, Math.min(row.left, window.innerWidth - PANEL_WIDTH - 8)), top: Math.min(row.bottom + 6, window.innerHeight - height - 8) });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    window.addEventListener('wheel', leave, { passive: true });
    window.addEventListener('scroll', leave, true);
    window.addEventListener('resize', leave);
    window.addEventListener('pointerdown', leave, true);
    return () => { window.removeEventListener('wheel', leave); window.removeEventListener('scroll', leave, true); window.removeEventListener('resize', leave); window.removeEventListener('pointerdown', leave, true); };
  }, [open]);
  const panel = open && has ? createPortal(<div ref={card} className="session-tasks-peek" role="tooltip"
    style={{ width: PANEL_WIDTH, ...(place ? { left: place.left, top: place.top } : { visibility: 'hidden', left: 0, top: 0 }) }}><SessionTasksCard tasks={tasks} /></div>, document.body) : null;
  return { anchor, enter, leave, panel };
}
