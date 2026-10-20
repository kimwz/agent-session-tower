import { useContext, useId, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, CalendarDays, Check, ChevronRight, Clock3, Flag, Github, MessageCircle, MessageSquare, MoreHorizontal, Paperclip, Repeat } from 'lucide-react';
import type { TodoAgent, TodoTask } from '../../../shared/todo/types';
import { statusLabels } from '../common/lib';
import { translate as t, translateMessage } from '../i18n/i18n';
import { SessionContextIcon } from '../sessions/SessionContextIcon';
import { agentLook, TodoAgentContext } from './todo-agents';

const stop = (event: { stopPropagation(): void }) => event.stopPropagation();
/**
 * A control on a card keeps its presses to itself: the board drags a card from a mouse press (MouseSensor), a held
 * touch (TouchSensor) or a pointer press, so each of them stops at the control.
 */
export const OWN_PRESS = { onPointerDown: stop, onMouseDown: stop, onTouchStart: stop } as const;
import { useFileDrop } from './attachments/Attachments';
import { isOpen, type TodoWorld } from './todo-model';
import { setSubtasksFolded, subtasksFolded } from './todo-prefs';
import { colorOf, dateLabel, durationLabel, monthDay, recurrenceLabel } from './todo-format';
import { subtaskWindow, type CardContext } from './todo-views';

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
  { key: 'github', visible: (task, { world }) => !!world.github?.issues[task.id], render: (task, { world }) => { const issue = world.github!.issues[task.id];
    return <a className={`todo-chip github ${issue.error ? 'error' : ''}`} href={issue.url} target="_blank" rel="noreferrer" title={issue.error ? `${issue.repo}#${issue.number} — ${translateMessage(issue.error)}` : `${issue.repo}#${issue.number}`}
      onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}><Github size={11} />#{issue.number}</a>; } },
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
 * or the work it handed out runs and grey otherwise, with a dot when something waits for the owner and the count of
 * that running work.
 */
export function AgentIcon({ agent }: { agent: TodoAgent }) {
  const { session, running } = useContext(TodoAgentContext);
  const description = useId();
  const look = agentLook(agent, agent.sessionId ? session(agent.sessionId) : undefined, running(agent.taskId));
  const label = [t('이슈 마스터'), statusLabels[look.status], ...(look.running ? [t('맡긴 작업 {0}개 진행 중', { 0: look.running })] : [])].join(' · ');
  return <span className={`chat-context-icon todo-agent-icon ${look.status}`}>
    <SessionContextIcon provider={look.provider} usage={look.usage} descriptionId={description} compact label={label} />
    {look.flag && <i className={`todo-agent-flag ${look.flag}`} aria-hidden="true" />}
    {look.running > 0 && <b className="todo-agent-running" aria-hidden="true">{look.running}</b>}
  </span>;
}

/**
 * A todo at work (its issue master, or work it handed out, still running) wears the canvas's moving border, as a working
 * agent does. Only cards with an issue master read the sessions, so a session's update redraws just those.
 */
function AgentActivity({ agent }: { agent: TodoAgent }) {
  const { session, running } = useContext(TodoAgentContext);
  const look = agentLook(agent, agent.sessionId ? session(agent.sessionId) : undefined, running(agent.taskId));
  return look.status === 'working' ? <span className="agent-activity-border" aria-hidden="true" /> : null;
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
  // A completed card (the completed list) lists none: its sub-tasks are in its detail.
  const listed = task.completedAt ? [] : (context.children.get(task.id) ?? []).filter(child => !context.shown?.has(child.id));
  const rowUnread = (child: TodoTask) => !child.completedAt && (!!context.unread?.has(child.id) || !!context.unreadBelow?.has(child.id));
  const subtasks: CardSubtasksProps = { task, listed, world: context.world, unread: rowUnread, readOnly, onOpen, onComplete, onReopen, onChat };
  // A completed card (a repeating task's past occurrence among them) is done with.
  const unread = !task.completedAt && !!context.unread?.has(task.id);
  const chips = CARD_META.filter(chip => chip.visible(task, context));
  const agent = context.world.agents[task.id];
  // A file dragged from the computer is not a card being dragged (dnd-kit follows the pointer, not HTML drag events).
  // A paste is the detail's: a card taking one would attach files to whichever card the keyboard is on.
  const drop = useFileDrop(files => onFiles?.(task, files), !onFiles || readOnly || !!task.completedAt);
  const { onDragOver, onDragLeave, onDrop } = drop.handlers;
  const dropHandlers = { onDragOver, onDragLeave, onDrop };
  return <div className={`todo-card ${selected ? 'selected' : ''} ${task.completedAt ? 'done' : ''} ${drop.over ? 'file-target' : ''} ${unread ? 'unread' : ''}`} data-task={task.id} data-select={selectId} tabIndex={0} role="button" aria-label={task.content}
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
    {agent && !task.completedAt && <AgentActivity agent={agent} />}
    <div className="todo-card-main">
      <CheckCircle task={task} disabled={readOnly} onComplete={() => onComplete(task)} onCompleteNext={() => onCompleteNext(task)} onReopen={onReopen && (() => onReopen(task))} />
      <div className="todo-card-body">
        <span className="todo-card-title" title={task.content}>{unread && <UnreadDot />}{task.content}</span>
        {task.description && <span className="todo-card-description">{plain(task.description)}</span>}
        {chips.length > 0 && <div className="todo-meta">{chips.map(chip => <span key={chip.key} className="todo-meta-item">{chip.render(task, context)}</span>)}</div>}
      </div>
      {/* With an issue master, its state; without, a way to start one, offered to a mouse over the card (a phone has the detail's chat). */}
      {onChat && (agent || (!readOnly && !task.completedAt)) && <button type="button" className={`todo-card-chat icon-button ${agent ? 'active' : ''}`} aria-label={t('이슈 채팅')} title={t('이슈 채팅')}
        {...OWN_PRESS} onClick={event => { event.stopPropagation(); onChat(task.id); }}>
        {agent ? <AgentIcon agent={agent} /> : <MessageCircle size={14} />}
      </button>}
      {onMenu && !readOnly && <button type="button" className="todo-card-more icon-button" aria-label={t('작업 메뉴')} onClick={event => { event.stopPropagation(); onMenu(task, event.currentTarget); }}><MoreHorizontal size={15} /></button>}
    </div>
    {(listed.length > 0 || (!task.completedAt && (context.world.subtaskCounts[task.id]?.total ?? 0) > 0)) &&
      (listed.some(child => context.world.agents[child.id]) ? <LiveSubtasks {...subtasks} /> : <CardSubtasks {...subtasks} />)}
  </div>;
}

interface CardSubtasksProps extends Pick<TaskCardProps, 'task' | 'readOnly' | 'onOpen' | 'onComplete' | 'onReopen' | 'onChat'> {
  /** The sub-tasks the card lists, in their order. */
  listed: TodoTask[];
  world: TodoWorld;
  /** A sub-task's row shows the unread dot: its own comments or those of one below it. */
  unread?: (task: TodoTask) => boolean;
  /** Sub-tasks at work: never left out of the list. */
  working?: (task: TodoTask) => boolean;
}

/**
 * The list of a card that has a sub-task with an issue master: it reads the sessions to know which of them work, so only
 * such cards draw again on a session's update.
 */
function LiveSubtasks(props: CardSubtasksProps) {
  const { session, running } = useContext(TodoAgentContext);
  const working = (child: TodoTask) => {
    const agent = props.world.agents[child.id];
    return !!agent && agentLook(agent, agent.sessionId ? session(agent.sessionId) : undefined, running(child.id)).status === 'working';
  };
  return <CardSubtasks {...props} working={working} />;
}

/**
 * A card's sub-tasks. They show unless the owner folded them on this card; the fold is remembered (todo-prefs.ts). A few
 * of them show, completed ones struck through, and those at work whatever the fold (`subtaskWindow`); all of them are in
 * the task's detail.
 */
function CardSubtasks({ task, listed, world, unread, working, readOnly, onOpen, onComplete, onReopen, onChat }: CardSubtasksProps) {
  const [folded, setFolded] = useState(() => subtasksFolded(task.id));
  // Unread ones show whatever the fold, as those at work do.
  const { shown, more } = subtaskWindow(listed, child => !!working?.(child) || !!unread?.(child), folded);
  return <div className="todo-card-subtasks">
    <button type="button" className="todo-subtask-toggle" aria-expanded={!folded} onClick={event => { event.stopPropagation(); setSubtasksFolded(task.id, !folded); setFolded(!folded); }}>
      <ChevronRight size={12} />{subtaskToggleText(world, task.id, listed.filter(isOpen).length)}
    </button>
    {shown.length > 0 && <ul>{shown.map(child => <li key={child.id} className={child.completedAt ? 'done' : undefined}>
      <CheckCircle task={child} size="small" disabled={readOnly} onComplete={() => onComplete(child)} onReopen={onReopen && (() => onReopen(child))} />
      <button type="button" className="todo-subtask-title" onClick={event => { event.stopPropagation(); onOpen(child.id); }}>{unread?.(child) && <UnreadDot />}{child.content}</button>
      {world.agents[child.id] && <SubtaskAgent task={child} agent={world.agents[child.id]} onChat={onChat} />}
    </li>)}</ul>}
    {more > 0 && <button type="button" className="todo-subtask-more" {...OWN_PRESS} onClick={event => { event.stopPropagation(); onOpen(task.id); }}>{t('{0}건 더 있음', { 0: more })}</button>}
  </div>;
}

/**
 * A sub-task's issue master on its row (a card's list, the parent's detail), as a card shows its own: the moving border
 * while it works (not on a completed one), and its icon, which opens that sub-task's chat.
 */
export function SubtaskAgent({ task, agent, onChat }: { task: TodoTask; agent: TodoAgent; onChat?: (id: string) => void }) {
  return <>
    {!task.completedAt && <AgentActivity agent={agent} />}
    {onChat ? <button type="button" className="todo-subtask-chat icon-button" aria-label={t('이슈 채팅')} title={t('이슈 채팅')}
      {...OWN_PRESS} onClick={event => { event.stopPropagation(); onChat(task.id); }}><AgentIcon agent={agent} /></button>
      : <span className="todo-subtask-chat"><AgentIcon agent={agent} /></span>}
  </>;
}

/** New comments the owner has not seen, as the sessions list marks new activity. */
export const UnreadDot = () => <i className="unread-dot" title={t('새 댓글')} aria-label={t('새 댓글')} />;

/** The first line of a Markdown description, without its marks. A single `~` is text (a range: 18~20%); `~~` is a mark. */
export const plain = (text: string) => (text.split('\n').find(line => line.trim()) ?? '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/~~/g, '').replace(/[#>*_`[\]]/g, '').trim().slice(0, 140);
