import { useRef, useState, type ReactNode } from 'react';
import { ArrowRight, CalendarDays, Check, ChevronRight, Clock3, Flag, MessageSquare, MoreHorizontal, Paperclip, Repeat } from 'lucide-react';
import type { TodoTask } from '../../../shared/todo/types';
import { translate as t } from '../i18n/i18n';
import { isOpen } from './todo-model';
import { colorOf, dateLabel, durationLabel, monthDay, recurrenceLabel } from './todo-format';
import type { CardContext } from './todo-views';

/**
 * A task on the board: a check circle in its priority's color, its title, and one line of what it has. The line is a
 * list of chips, each shown only when the task has that value, so a new property is one entry in `CARD_META`.
 */

export interface MetaChip { key: string; visible: (task: TodoTask, context: CardContext) => boolean; render: (task: TodoTask, context: CardContext) => ReactNode }

export const CARD_META: MetaChip[] = [
  { key: 'date', visible: task => !!task.dueDate, render: (task, { today }) => <span className={`todo-chip date ${task.dueDate! < today ? 'overdue' : task.dueDate === today ? 'today' : ''}`} title={task.recurrence ? recurrenceLabel(task.recurrence) : undefined}>
    <CalendarDays size={11} />{dateLabel(task.dueDate!, today)}{task.dueTime && ` ${task.dueTime}`}{task.recurrence && <Repeat size={10} aria-label={recurrenceLabel(task.recurrence)} />}
  </span> },
  { key: 'deadline', visible: task => !!task.deadlineDate, render: (task, { today }) => <span className={`todo-chip deadline ${task.deadlineDate! < today ? 'overdue' : ''}`} title={t('마감일')}><Flag size={11} />{t('마감 {0}', { 0: monthDay(task.deadlineDate!, today) })}</span> },
  { key: 'duration', visible: task => !!task.durationMin, render: task => <span className="todo-chip"><Clock3 size={11} />{durationLabel(task.durationMin!)}</span> },
  { key: 'labels', visible: task => task.labelIds.length > 0, render: (task, { world }) => <>{task.labelIds.map(id => world.labels.find(label => label.id === id)).filter(label => !!label).map(label =>
    <span key={label!.id} className="todo-chip label" style={{ color: colorOf(label!.color) }}>@{label!.name}</span>)}</> },
  // Sub-tasks are counted by the card's own fold-out list below this line.
  { key: 'comments', visible: (task, { world }) => (world.commentCounts[task.id] ?? 0) > 0, render: (task, { world }) => <span className="todo-chip" title={t('댓글')}><MessageSquare size={11} />{world.commentCounts[task.id]}</span> },
  // Attachments counted by the server; the upload itself lives in the task detail.
  { key: 'files', visible: (task, { world }) => (world.fileCounts[task.id] ?? 0) > 0, render: (task, { world }) => <span className="todo-chip" title={t('첨부 파일')}><Paperclip size={11} />{world.fileCounts[task.id]}</span> },
  { key: 'next', visible: (task, { next }) => (next.get(task.id) ?? 0) > 0, render: (task, { next }) => <span className="todo-chip next" title={t('후속 작업')}><ArrowRight size={11} />{t('다음 {0}', { 0: next.get(task.id)! })}</span> },
  { key: 'project', visible: (task, { showProject }) => showProject, render: (task, { world }) => { const project = world.projects.find(item => item.id === task.projectId); return project ? <span className="todo-chip project"><i style={{ background: colorOf(project.color) }} />{project.inbox ? t('관리함') : project.name}</span> : null; } },
];

/** The check circle: completes on a press; held on a touch screen, completes and adds the next task. */
export function CheckCircle({ task, onComplete, onCompleteNext, onReopen, size = 'normal' }: { task: TodoTask; onComplete: () => void; onCompleteNext?: () => void; onReopen?: () => void; size?: 'normal' | 'small' }) {
  const held = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const long = useRef(false);
  const done = !!task.completedAt;
  return <button type="button" className={`todo-check p${task.priority} ${size} ${done ? 'done' : ''}`} aria-label={done ? t('“{0}” 완료 취소', { 0: task.content }) : t('“{0}” 완료', { 0: task.content })} aria-pressed={done}
    onPointerDown={event => {
      if (event.pointerType !== 'touch' || !onCompleteNext || done) return;
      long.current = false;
      held.current = setTimeout(() => { long.current = true; navigator.vibrate?.(15); onCompleteNext(); }, 550);
    }}
    onPointerUp={() => clearTimeout(held.current)} onPointerLeave={() => clearTimeout(held.current)} onPointerCancel={() => clearTimeout(held.current)}
    onContextMenu={event => { if (onCompleteNext) event.preventDefault(); }}
    onClick={event => { event.stopPropagation(); if (long.current) { long.current = false; return; } if (done) onReopen?.(); else onComplete(); }}>
    <Check size={size === 'small' ? 9 : 11} strokeWidth={3} />
  </button>;
}

export interface TaskCardProps {
  task: TodoTask;
  context: CardContext;
  selected?: boolean;
  onOpen: (id: string) => void;
  onComplete: (task: TodoTask) => void;
  onCompleteNext: (task: TodoTask) => void;
  onReopen?: (task: TodoTask) => void;
  /** Opens the card's menu from its button. */
  onMenu?: (task: TodoTask, anchor: HTMLElement) => void;
  onSelect?: (id: string) => void;
}

export function TaskCard({ task, context, selected, onOpen, onComplete, onCompleteNext, onReopen, onMenu, onSelect }: TaskCardProps) {
  const [expanded, setExpanded] = useState(false);
  const children = (context.children.get(task.id) ?? []).filter(child => isOpen(child) || (expanded && child.completedAt));
  const chips = CARD_META.filter(chip => chip.visible(task, context));
  return <div className={`todo-card ${selected ? 'selected' : ''} ${task.completedAt ? 'done' : ''}`} data-task={task.id} tabIndex={0} role="button" aria-label={task.content}
    onClick={() => onOpen(task.id)} onFocus={() => onSelect?.(task.id)} onMouseEnter={() => onSelect?.(task.id)}
    onKeyDown={event => { if (event.key === 'Enter' && event.target === event.currentTarget) { event.preventDefault(); onOpen(task.id); } }}>
    <div className="todo-card-main">
      <CheckCircle task={task} onComplete={() => onComplete(task)} onCompleteNext={() => onCompleteNext(task)} onReopen={onReopen && (() => onReopen(task))} />
      <div className="todo-card-body">
        <span className="todo-card-title">{task.content}</span>
        {task.description && <span className="todo-card-description">{plain(task.description)}</span>}
        {chips.length > 0 && <div className="todo-meta">{chips.map(chip => <span key={chip.key} className="todo-meta-item">{chip.render(task, context)}</span>)}</div>}
      </div>
      {onMenu && <button type="button" className="todo-card-more icon-button" aria-label={t('작업 메뉴')} onClick={event => { event.stopPropagation(); onMenu(task, event.currentTarget); }}><MoreHorizontal size={15} /></button>}
    </div>
    {children.length > 0 && <div className="todo-card-subtasks">
      <button type="button" className="todo-subtask-toggle" aria-expanded={expanded} onClick={event => { event.stopPropagation(); setExpanded(value => !value); }}>
        <ChevronRight size={12} />{t('하위 작업 {0}', { 0: children.filter(isOpen).length })}
      </button>
      {expanded && <ul>{children.map(child => <li key={child.id} className={child.completedAt ? 'done' : ''}>
        <CheckCircle task={child} size="small" onComplete={() => onComplete(child)} onReopen={onReopen && (() => onReopen(child))} />
        <button type="button" className="todo-subtask-title" onClick={event => { event.stopPropagation(); onOpen(child.id); }}>{child.content}</button>
      </li>)}</ul>}
    </div>}
  </div>;
}

/** The first line of a Markdown description, without its marks. */
export const plain = (text: string) => (text.split('\n').find(line => line.trim()) ?? '').replace(/[#>*_`~[\]]/g, '').replace(/\(([^)]*)\)/g, '').trim().slice(0, 140);
