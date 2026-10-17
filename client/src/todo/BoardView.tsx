import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { closestCorners, DndContext, DragOverlay, pointerWithin, useDroppable, type CollisionDetection, type DragEndEvent, type DragOverEvent, type DragStartEvent } from '@dnd-kit/core';
import { arrayMove, horizontalListSortingStrategy, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useTodoSensors } from './todo-dnd';
import { GripVertical, MoreHorizontal, Plus } from 'lucide-react';
import type { TodoTask } from '../../../shared/todo/types';
import { translate as t } from '../i18n/i18n';
import { TaskCard, type TaskCardProps } from './TaskCard';
import type { BoardColumn, CardContext } from './todo-views';

/**
 * Columns of cards. Cards are dragged with a mouse, a held touch or the keyboard: within a column to put them in order
 * (when the list keeps a hand-made order), onto another column (or its tab on a phone) to change what the column
 * stands for. A project's section columns are put in order by dragging their headers.
 */

export interface BoardProps {
  columns: BoardColumn[];
  context: CardContext;
  /**
   * Cards can be put in order within a column: siblings in a section column, the tasks of one date in a date column
   * (`onDrop` then gets the card before the drop, and `dropOps` makes it a move within that date).
   */
  manual: boolean;
  /** Section columns can be put in order and a section added. */
  sections: boolean;
  mobile: boolean;
  selectedId: string | null;
  card: Omit<TaskCardProps, 'task' | 'context' | 'selected'>;
  onAdd: (column: BoardColumn) => void;
  onDrop: (task: TodoTask, column: BoardColumn, afterId: string | null | undefined) => void;
  /** A card put in order among its own date's tasks in a column of several dates. */
  onDayMove?: (task: TodoTask, afterId: string | null) => void;
  onSectionMove: (sectionId: string, afterId: string | null) => void;
  onAddSection: (name: string) => void;
  onSectionMenu: (sectionId: string, anchor: HTMLElement) => void;
  /** Completed tasks shown at the end, when the display asks for them. */
  completed?: ReactNode;
}

const cardId = (id: string) => `task:${id}`;
const columnDrop = (id: string) => `column:${id}`;
const sectionDrag = (id: string) => `section:${id}`;

/** A press on a card's empty area first lands on the column under it; the card wins when the pointer is on it. */
const collisions: CollisionDetection = args => {
  const within = pointerWithin(args);
  const card = within.find(item => String(item.id).startsWith('task:'));
  if (card) return [card];
  if (within.length) return within;
  return closestCorners(args);
};

const transformOf = (transform: { x: number; y: number } | null) => transform ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)` : undefined;

/**
 * A card's drag starts on the card itself: Space lifts it (Enter opens it), a key on one of its buttons is that button's,
 * and a touch held on the check circle completes and adds the next task instead.
 */
function SortableCard({ task, column, ...props }: { task: TodoTask; column: BoardColumn } & Omit<TaskCardProps, 'task'>) {
  // A column that stands for no value (overdue, later) stays a target, so a card put back where it was lands on its own
  // column (which the drop then ignores) rather than on the nearest other one.
  // A locked column's cards (an archived project or section) are shown, never picked up.
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: cardId(task.id), data: { type: 'task', task, column }, disabled: { draggable: !!column.locked, droppable: false } });
  const style: CSSProperties = { transform: transformOf(transform), transition, opacity: isDragging ? 0.35 : undefined };
  const control = (target: EventTarget) => target instanceof Element && !!target.closest('button, a, input, textarea');
  return <div ref={setNodeRef} style={style} className="todo-sortable" {...attributes} {...listeners} tabIndex={-1} role={undefined}
    onKeyDown={event => { if (!control(event.target)) listeners?.onKeyDown?.(event); }}
    onTouchStart={event => { if (!(event.target instanceof Element && event.target.closest('.todo-check'))) listeners?.onTouchStart?.(event); }}>
    <TaskCard task={task} {...props} />
  </div>;
}

function Column({ column, board, active, over, children }: { column: BoardColumn; board: BoardProps; active: boolean; over: boolean; children: ReactNode }) {
  const { setNodeRef } = useDroppable({ id: columnDrop(column.id), data: { type: 'column', column } });
  const sortable = useSortable({ id: sectionDrag(column.sectionId ?? column.id), data: { type: 'section', column }, disabled: !board.sections || !column.sectionId });
  const menu = useRef<HTMLButtonElement>(null);
  const style: CSSProperties = { transform: transformOf(sortable.transform), transition: sortable.transition };
  return <section ref={sortable.setNodeRef} style={style} className={`todo-column ${column.tone ?? ''} ${column.collapsed ? 'collapsed' : ''} ${column.locked ? 'locked' : ''} ${over && active && column.drop ? 'drop-target' : ''} ${sortable.isDragging ? 'dragging' : ''}`} data-column={column.id} aria-label={column.title}>
    <header className="todo-column-head">
      {board.sections && column.sectionId && !column.locked && <button type="button" className="todo-column-grip" aria-label={t('“{0}” 섹션 옮기기', { 0: column.title })} {...sortable.attributes} {...sortable.listeners}><GripVertical size={13} /></button>}
      <h3>{column.title}</h3>
      <span className="todo-column-count">{column.tasks.length || ''}</span>
      {column.note && <span className="todo-column-note">{column.note}</span>}
      {column.sectionId && <button ref={menu} type="button" className="icon-button todo-column-more" aria-label={t('섹션 메뉴')} onClick={() => menu.current && board.onSectionMenu(column.sectionId!, menu.current)}><MoreHorizontal size={14} /></button>}
    </header>
    <div ref={setNodeRef} className="todo-column-cards">
      {children}
      {column.drop && <button type="button" className="todo-add-card" onClick={() => board.onAdd(column)}><Plus size={14} />{t('작업 추가')}</button>}
    </div>
  </section>;
}

function ColumnTab({ column, index, current, onPick }: { column: BoardColumn; index: number; current: boolean; onPick: (index: number) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: `tab:${column.id}`, data: { type: 'column', column }, disabled: !column.drop });
  return <button ref={setNodeRef} type="button" role="tab" aria-selected={current} className={`${current ? 'current' : ''} ${isOver ? 'drop-target' : ''} ${column.tone ?? ''}`} onClick={() => onPick(index)}>
    {column.title}{column.tasks.length > 0 && <b>{column.tasks.length}</b>}
  </button>;
}

function AddSection({ onAdd }: { onAdd: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const save = () => { if (name.trim()) onAdd(name.trim()); setName(''); setEditing(false); };
  return <div className="todo-column todo-add-section">
    {editing ? <form onSubmit={event => { event.preventDefault(); save(); }}>
      <input autoFocus value={name} maxLength={120} placeholder={t('섹션 이름')} aria-label={t('섹션 이름')} onChange={event => setName(event.target.value)} onBlur={save} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setName(''); setEditing(false); } }} />
    </form> : <button type="button" onClick={() => setEditing(true)}><Plus size={14} />{t('섹션 추가')}</button>}
  </div>;
}

export function BoardView(board: BoardProps) {
  const { columns, context, manual, mobile } = board;
  const sensors = useTodoSensors();
  const [activeTask, setActiveTask] = useState<TodoTask | null>(null);
  // Anything dragged, a card or a section: the arrow keys are the drag's meanwhile.
  const [dragging, setDragging] = useState(false);
  const [overColumn, setOverColumn] = useState<string | null>(null);
  const [current, setCurrent] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const tabMenu = useRef<HTMLButtonElement>(null);
  const sectionIds = useMemo(() => columns.filter(column => column.sectionId).map(column => sectionDrag(column.sectionId!)), [columns]);

  // A phone shows one column at a time; the tabs follow the swipes (and the arrow keys), by where each column starts.
  const columnStarts = () => { const element = scroller.current; const all = element ? [...element.querySelectorAll<HTMLElement>(':scope > .todo-column')] : []; return all.map(column => column.offsetLeft - (all[0]?.offsetLeft ?? 0)); };
  useEffect(() => {
    const element = scroller.current;
    if (!mobile || !element) return;
    const onScroll = () => { const starts = columnStarts(); let nearest = 0; starts.forEach((start, index) => { if (Math.abs(start - element.scrollLeft) < Math.abs(starts[nearest] - element.scrollLeft)) nearest = index; }); setCurrent(nearest); };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, [mobile]);
  useEffect(() => { if (current >= columns.length) setCurrent(Math.max(0, columns.length - 1)); }, [columns.length, current]);
  const pick = (index: number) => { setCurrent(index); scroller.current?.scrollTo({ left: columnStarts()[index] ?? 0, behavior: 'smooth' }); };

  const columnOf = (data: Record<string, unknown> | undefined) => data?.column as BoardColumn | undefined;
  const onStart = (event: DragStartEvent) => {
    setDragging(true);
    const data = event.active.data.current;
    if (data?.type === 'task') setActiveTask(data.task as TodoTask);
  };
  const onOver = (event: DragOverEvent) => setOverColumn(columnOf(event.over?.data.current)?.id ?? null);
  const onEnd = (event: DragEndEvent) => {
    setActiveTask(null); setOverColumn(null); setDragging(false);
    const { active, over } = event;
    if (!over) return;
    const data = active.data.current;
    if (data?.type === 'section') {
      const from = sectionIds.indexOf(String(active.id)), to = sectionIds.indexOf(String(over.id));
      if (from < 0 || to < 0 || from === to) return;
      const order = sectionIds.filter(id => id !== active.id);
      order.splice(to, 0, String(active.id));
      const index = order.indexOf(String(active.id));
      board.onSectionMove((columnOf(data)!.sectionId)!, index > 0 ? order[index - 1].slice('section:'.length) : null);
      return;
    }
    if (data?.type !== 'task') return;
    const task = data.task as TodoTask, source = columnOf(data)!, target = columnOf(over.data.current);
    const overTask = over.data.current?.type === 'task' ? (over.data.current.task as TodoTask) : undefined;
    // In a column of several dates (overdue, the next days, later), a card put among its own date's tasks takes its
    // place there; it never changes its date by being dropped in the column it came from.
    if (manual && target && !target.drop && target.id === source.id && !target.locked && task.dueDate && overTask?.dueDate === task.dueDate && overTask.id !== task.id) {
      const from = target.tasks.findIndex(item => item.id === task.id), to = target.tasks.findIndex(item => item.id === overTask.id);
      const order = arrayMove(target.tasks, from, to);
      const before = order.slice(0, order.findIndex(item => item.id === task.id)).filter(item => item.dueDate === task.dueDate);
      board.onDayMove?.(task, before.at(-1)?.id ?? null);
      return;
    }
    if (!target?.drop) return;
    const list = target.tasks.filter(item => item.id !== task.id);
    if (!manual) { if (target.id !== source.id) board.onDrop(task, target, undefined); return; }
    let index = overTask ? target.tasks.findIndex(item => item.id === overTask.id) : list.length;
    if (target.id === source.id) {
      const from = source.tasks.findIndex(item => item.id === task.id);
      if (from === index || index < 0) return;
    } else if (index < 0) index = list.length;
    board.onDrop(task, target, index === 0 ? null : list[index - 1]?.id ?? (list.length ? list[list.length - 1].id : null));
  };

  const renderColumn = (column: BoardColumn) => <Column key={column.id} column={column} board={board} active={!!activeTask} over={overColumn === column.id}>
    <SortableContext items={column.tasks.map(task => cardId(task.id))} strategy={verticalListSortingStrategy}>
      {column.tasks.map(task => <SortableCard key={task.id} task={task} column={column} context={context} selected={board.selectedId === task.id} {...board.card}
        {...(column.locked ? { readOnly: true, onMenu: undefined, onFiles: undefined } : {})} />)}
    </SortableContext>
  </Column>;

  return <DndContext sensors={sensors} collisionDetection={collisions} onDragStart={onStart} onDragOver={onOver} onDragEnd={onEnd} onDragCancel={() => { setActiveTask(null); setOverColumn(null); setDragging(false); }}>
    {mobile && (columns.length > 1 || columns[current]?.sectionId) && <div className="todo-column-tabs-bar">
      <div className="todo-column-tabs" role="tablist" aria-label={t('열')}>
        {columns.map((column, index) => <ColumnTab key={column.id} column={column} index={index} current={index === current} onPick={pick} />)}
      </div>
      {/* A phone has no column headers: the shown section's menu (rename, move, delete) sits beside the tabs. */}
      {columns[current]?.sectionId && <button ref={tabMenu} type="button" className="icon-button" aria-label={t('“{0}” 섹션 메뉴', { 0: columns[current].title })}
        onClick={() => tabMenu.current && board.onSectionMenu(columns[current].sectionId!, tabMenu.current)}><MoreHorizontal size={15} /></button>}
    </div>}
    <div ref={scroller} className={`todo-board ${dragging ? 'dragging' : ''}`}>
      <SortableContext items={sectionIds} strategy={horizontalListSortingStrategy}>
        {columns.map(renderColumn)}
      </SortableContext>
      {board.sections && <AddSection onAdd={board.onAddSection} />}
      {board.completed}
    </div>
    <DragOverlay dropAnimation={null}>{activeTask && <div className="todo-drag-overlay"><TaskCard task={activeTask} context={context} {...board.card} /></div>}</DragOverlay>
  </DndContext>;
}
