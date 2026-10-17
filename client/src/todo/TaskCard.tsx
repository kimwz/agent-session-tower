import { useContext, useId, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, CalendarDays, Check, ChevronRight, Clock3, Flag, MessageCircle, MessageSquare, MoreHorizontal, Paperclip, Repeat } from 'lucide-react';
import type { TodoAgent, TodoTask } from '../../../shared/todo/types';
import { statusLabels } from '../common/lib';
import { translate as t } from '../i18n/i18n';
import { SessionContextIcon } from '../sessions/SessionContextIcon';
import { agentLook, TodoAgentContext } from './todo-agents';
import { useFileDrop } from './attachments/Attachments';
import { isOpen, type TodoWorld } from './todo-model';
import { setSubtasksFolded, subtasksFolded } from './todo-prefs';
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

/** Done and all sub-tasks of each task, from the server (`TodoWorld.subtaskCounts`, which may not have come yet). */

/** The sub-task toggle's words: done of all from the server's counts, else the open ones the card lists. */
export function subtaskToggleText(world: TodoWorld, taskId: string, open: number): string {
  const count = world.subtaskCounts[taskId];
  return count && count.total > 0 ? t('하위 작업 {0}/{1}', { 0: count.done, 1: count.total }) : t('하위 작업 {0}', { 0: open });
}

/** The check circle: completes on a press; held on a touch screen, completes and adds the next task. */
export function CheckCircle({ task, onComplete, onCompleteNext, onReopen, size = 'normal', disabled }: { task: TodoTask; onComplete: () => void; onCompleteNext?: () => void; onReopen?: () => void; size?: 'normal' | 'small'; disabled?: boolean }) {
  const held = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const long = useRef(false);
  const done = !!task.completedAt;
  return <button type="button" className={`todo-check p${task.priority} ${size} ${done ? 'done' : ''}`} aria-label={done ? t('“{0}” 완료 취소', { 0: task.content }) : t('“{0}” 완료', { 0: task.content })} aria-pressed={done} disabled={disabled}
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

/**
 * A todo's issue master as the chat header shows a session: the provider's orb in its context ring, in colour while it
 * works and grey otherwise, with a dot when something waits for the owner.
 */
export function AgentIcon({ agent }: { agent: TodoAgent }) {
  const { session } = useContext(TodoAgentContext);
  const description = useId();
  const look = agentLook(agent, agent.sessionId ? session(agent.sessionId) : undefined);
  const label = `${t('이슈 마스터')} · ${statusLabels[look.status]}`;
  return <span className={`chat-context-icon todo-agent-icon ${look.status}`}>
    <SessionContextIcon provider={look.provider} usage={look.usage} descriptionId={description} compact label={label} />
    {look.flag && <i className={`todo-agent-flag ${look.flag}`} aria-hidden="true" />}
  </span>;
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
  /** What choosing this card chooses: the task, or one of its completions in the completed list. */
  selectId?: string;
  /** Files dropped on the card, for its task's description; not offered on a completed card. */
  onFiles?: (task: TodoTask, files: File[]) => void;
  /** Shown only (an archived project): nothing on it changes the task. */
  readOnly?: boolean;
  /** Opens the task's issue chat. */
  onChat?: (id: string) => void;
}

export function TaskCard({ task, context, selected, onOpen, onComplete, onCompleteNext, onReopen, onMenu, onSelect, selectId = task.id, onFiles, readOnly, onChat }: TaskCardProps) {
  // Sub-tasks show unless the owner folded them on this card; the fold is remembered (todo-prefs.ts). Completed ones
  // are in the task's detail.
  const [folded, setFolded] = useState(() => subtasksFolded(task.id));
  // A completed card (the completed list) lists none: its sub-tasks are in its detail.
  const children = task.completedAt ? [] : (context.children.get(task.id) ?? []).filter(child => isOpen(child) && !context.shown?.has(child.id));
  const chips = CARD_META.filter(chip => chip.visible(task, context));
  const agent = context.world.agents[task.id];
  // A file dragged from the computer is not a card being dragged (dnd-kit follows the pointer, not HTML drag events).
  // A paste is the detail's: a card taking one would attach files to whichever card the keyboard is on.
  const drop = useFileDrop(files => onFiles?.(task, files), !onFiles || readOnly || !!task.completedAt);
  const { onDragOver, onDragLeave, onDrop } = drop.handlers;
  const dropHandlers = { onDragOver, onDragLeave, onDrop };
  return <div className={`todo-card ${selected ? 'selected' : ''} ${task.completedAt ? 'done' : ''} ${drop.over ? 'file-target' : ''}`} data-task={task.id} data-select={selectId} tabIndex={0} role="button" aria-label={task.content}
    {...dropHandlers}
    onClick={() => onOpen(task.id)} onFocus={() => onSelect?.(selectId)}
    onPointerMove={event => {
      // Only a mouse that moves chooses: cards passing under a still mouse while the arrow keys scroll do not.
      if (event.pointerType !== 'mouse' || selected) return;
      onSelect?.(selectId);
      // With the keyboard on another card (or a button in one), it follows the mouse, so Enter opens the card that shows
      // chosen. A field or the task's detail keeps the keyboard.
      const active = document.activeElement;
      if (active instanceof HTMLElement && !event.currentTarget.contains(active) && active.closest('.todo-card')) event.currentTarget.focus({ preventScroll: true });
    }}
    onKeyDown={event => { if (event.key === 'Enter' && event.target === event.currentTarget) { event.preventDefault(); onOpen(task.id); } }}>
    <div className="todo-card-main">
      <CheckCircle task={task} disabled={readOnly} onComplete={() => onComplete(task)} onCompleteNext={() => onCompleteNext(task)} onReopen={onReopen && (() => onReopen(task))} />
      <div className="todo-card-body">
        <span className="todo-card-title">{task.content}</span>
        {task.description && <span className="todo-card-description">{plain(task.description)}</span>}
        {chips.length > 0 && <div className="todo-meta">{chips.map(chip => <span key={chip.key} className="todo-meta-item">{chip.render(task, context)}</span>)}</div>}
      </div>
      {/* With an issue master, its state; without, a way to start one, offered to a mouse over the card (a phone has the detail's chat). */}
      {onChat && (agent || (!readOnly && !task.completedAt)) && <button type="button" className={`todo-card-chat icon-button ${agent ? 'active' : ''}`} aria-label={t('이슈 채팅')} title={t('이슈 채팅')}
        onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onChat(task.id); }}>
        {agent ? <AgentIcon agent={agent} /> : <MessageCircle size={14} />}
      </button>}
      {onMenu && !readOnly && <button type="button" className="todo-card-more icon-button" aria-label={t('작업 메뉴')} onClick={event => { event.stopPropagation(); onMenu(task, event.currentTarget); }}><MoreHorizontal size={15} /></button>}
    </div>
    {(children.length > 0 || (!task.completedAt && (context.world.subtaskCounts[task.id]?.total ?? 0) > 0)) && <div className="todo-card-subtasks">
      <button type="button" className="todo-subtask-toggle" aria-expanded={!folded} onClick={event => { event.stopPropagation(); setSubtasksFolded(task.id, !folded); setFolded(!folded); }}>
        <ChevronRight size={12} />{subtaskToggleText(context.world, task.id, children.length)}
      </button>
      {!folded && <ul>{children.map(child => <li key={child.id}>
        <CheckCircle task={child} size="small" disabled={readOnly} onComplete={() => onComplete(child)} onReopen={onReopen && (() => onReopen(child))} />
        <button type="button" className="todo-subtask-title" onClick={event => { event.stopPropagation(); onOpen(child.id); }}>{child.content}</button>
      </li>)}</ul>}
    </div>}
  </div>;
}

/** The first line of a Markdown description, without its marks. */
export const plain = (text: string) => (text.split('\n').find(line => line.trim()) ?? '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#>*_`~[\]]/g, '').trim().slice(0, 140);
