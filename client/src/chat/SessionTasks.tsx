import { useRef, useState } from 'react';
import { ChevronUp } from 'lucide-react';
import type { SessionTask } from '../../../shared/types';
import { absoluteTime, relativeTime } from '../common/lib';
import { translate as t, useI18n } from '../i18n/i18n';
import { stageTone, taskTimeline } from './session-tasks';

/** A task's stage as a pill in the color of its kind of work. */
export function Stage({ stage }: { stage: string }) {
  return <span className={`session-task-stage ${stageTone(stage)}`}>{stage}</span>;
}

/**
 * What the conversation works on now, right above where the next message is written: the current task and its stage.
 * Opening it shows every task the conversation worked on above it, newest at the bottom beside the current line.
 */
export function SessionTasks({ tasks, initiallyOpen = false }: { tasks?: readonly SessionTask[]; initiallyOpen?: boolean }) {
  useI18n();
  const [open, setOpen] = useState(initiallyOpen);
  const line = useRef<HTMLButtonElement>(null);
  const { current, items } = taskTimeline(tasks);
  if (!current) return null;
  const fold = () => { setOpen(false); requestAnimationFrame(() => line.current?.focus({ preventScroll: true })); };
  return <section className={`session-tasks${open ? ' open' : ''}`} aria-label={t('세션 작업')} onKeyDown={event => { if (open && event.key === 'Escape') { event.preventDefault(); fold(); } }}>
    {open && <ol className="session-tasks-list">
      {items.map(task => <li key={task.id} className={`session-task ${stageTone(task.stage)}${task.current ? ' current' : ''}`}>
        <span className="session-task-dot" aria-hidden="true" />
        <div className="session-task-body">
          <span className="session-task-title">{task.title}</span>
          <span className="session-task-meta">
            <Stage stage={task.stage} />
            {task.current && <span className="session-task-now">{t('지금 작업')}</span>}
            <time dateTime={task.updatedAt} title={absoluteTime(task.updatedAt)}>{relativeTime(task.updatedAt)}</time>
          </span>
        </div>
      </li>)}
    </ol>}
    <button ref={line} type="button" className="session-tasks-line" aria-expanded={open} title={open ? t('접기') : t('이 세션의 작업 모두 보기')} onClick={() => setOpen(!open)}>
      <Stage stage={current.stage} />
      <span className="session-tasks-title">{current.title}</span>
      {items.length > 1 && <span className="session-tasks-count" aria-label={t('작업 {0}개', { 0: items.length })}>{items.length}</span>}
      <ChevronUp size={13} className={open ? 'rotate' : ''} aria-hidden="true" />
    </button>
  </section>;
}
