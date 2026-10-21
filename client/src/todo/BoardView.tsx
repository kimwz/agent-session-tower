import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { closestCorners, DndContext, DragOverlay, pointerWithin, useDroppable, type CollisionDetection, type DragEndEvent, type DragOverEvent, type DragStartEvent } from '@dnd-kit/core';
import { horizontalListSortingStrategy, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useTodoSensors } from './todo-dnd';
import { GripVertical, Inbox, MoreHorizontal, Plus } from 'lucide-react';
import type { TodoGitHubBinding, TodoProject, TodoTask } from '../../../shared/todo/types';
import { translate as t } from '../i18n/i18n';
import { TaskCard, type TaskCardProps } from './TaskCard';
import { colorOf } from './todo-format';
import { dayAfterOf, dropPlace, inTodayPanel, OVERVIEW_SHOWN, sectionDropAfter, shownTasks, TODAY_PANEL, todayPanelDrop, type BoardColumn, type BoardGroup, type CardContext, type TodayPanel } from './todo-views';
import { GitHubMark } from './GitHubMark';

/**
 * Columns of cards. Cards are dragged with a mouse, a held touch or the keyboard: within a column to put them in order
 * (when the list keeps a hand-made order), onto another column (or its tab on a phone) to change what the column
 * stands for. A project's section columns are put in order by dragging their headers.
 *
 * The overview (`groups`) shows one project after another, each with its section columns, in one drag area: a card
 * goes to another project's section, and a section moves only among its own project's. Beside it, Today (`today`) shows
 * in an area of its own in the same drag area: a card from the overview let go anywhere there is dated today.
 */

export interface BoardProps {
  columns: BoardColumn[];
  /** The overview: projects one under another, each with its columns (then `columns` is all of them, in order). */
  groups?: BoardGroup[];
  /** A project's header on the overview opens its own list. */
  onGroup?: (project: TodoProject) => void;
  /** "더 보기" and "접기" on a column that shows only its first cards (`BoardColumn.shown`). */
  onFold?: (columnId: string) => void;
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
  /** Read-only tasks (archived project or section) wherever they show: never picked up, changed or attached to. */
  taskLocked?: (task: TodoTask) => boolean;
  onSectionMove: (sectionId: string, afterId: string | null) => void;
  onAddSection: (name: string) => void;
  onSectionMenu: (sectionId: string, anchor: HTMLElement) => void;
  /** A section's GitHub link, shown beside its name. */
  sectionBinding?: (sectionId: string) => TodoGitHubBinding | undefined;
  /** Completed tasks shown at the end, when the display asks for them. */
  completed?: ReactNode;
  /**
   * Today beside the overview (todo-views `todayPanel`), with its own cards' context and whether its cards keep an
   * order by hand (the Today list's display), and the date it names.
   */
  today?: TodayPanel & { context: CardContext; manual: boolean; note: string };
}

/** A card's drag id; the Today panel's (`area`) differ, as a task can show there and on the overview at once. */
const cardId = (id: string, area?: string) => area ? `task:${area}:${id}` : `task:${id}`;
const columnDrop = (id: string) => `column:${id}`;
const sectionDrag = (id: string) => `section:${id}`;

/**
 * A press on a card's empty area first lands on the column under it; the card wins when the pointer is on it, and a
 * column of the Today panel wins over the panel around it, which takes what is let go anywhere else in it. Off every column the nearest one takes it, but on the
 * overview, where the nearest can be another project's, nothing does (a keyboard drag, without a pointer, still goes to
 * the nearest).
 */
export const collisionsFor = (overview: boolean): CollisionDetection => args => {
  // Only what is in the area under the pointer: a card scrolled out of sight sideways on the overview still measures
  // where it would be, under the Today panel.
  const panel = args.droppableRects.get(TODAY_PANEL), pointer = args.pointerCoordinates;
  const inPanel = !!panel && !!pointer && pointer.x >= panel.left && pointer.x <= panel.right && pointer.y >= panel.top && pointer.y <= panel.bottom;
  const ofPanel = (id: string) => id === TODAY_PANEL || id.startsWith('task:today:') || id.startsWith('column:today/');
  const within = pointerWithin(args).filter(item => !panel || !pointer || ofPanel(String(item.id)) === inPanel);
  const card = within.find(item => String(item.id).startsWith('task:'));
  if (card) return [card];
  const inner = within.filter(item => item.id !== TODAY_PANEL);
  if (inner.length) return inner;
  if (within.length) return within;
  return overview && args.pointerCoordinates ? [] : closestCorners(args);
};
const collisions = collisionsFor(false), overviewCollisions = collisionsFor(true);

const groupName = (group: BoardGroup) => group.project.inbox ? t('관리함') : group.project.name;

const transformOf = (transform: { x: number; y: number } | null) => transform ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)` : undefined;

/**
 * A card's drag starts on the card itself: Space lifts it (Enter opens it), a key on one of its buttons is that button's,
 * and a touch held on the check circle completes and adds the next task instead.
 */
function SortableCard({ task, column, dndId, ...props }: { task: TodoTask; column: BoardColumn; dndId: string } & Omit<TaskCardProps, 'task'>) {
  // A column that stands for no value (overdue, later) stays a target, so a card put back where it was lands on its own
  // column (which the drop then ignores) rather than on the nearest other one.
  // A locked column's cards (an archived project or section) are shown, never picked up.
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: dndId, data: { type: 'task', task, column }, disabled: { draggable: !!column.locked, droppable: false } });
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
      <h3>{column.title}{column.sectionId && board.sectionBinding?.(column.sectionId) && <GitHubMark binding={board.sectionBinding(column.sectionId)!} />}</h3>
      <span className="todo-column-count">{column.tasks.length || ''}</span>
      {column.note && <span className="todo-column-note">{column.note}</span>}
      {column.sectionId && <button ref={menu} type="button" className="icon-button todo-column-more" aria-label={t('섹션 메뉴')} onClick={() => menu.current && board.onSectionMenu(column.sectionId!, menu.current)}><MoreHorizontal size={14} /></button>}
    </header>
    <div ref={setNodeRef} className="todo-column-cards">
      {children}
      {column.shown !== undefined && column.tasks.length > column.shown
        ? <button type="button" className="todo-fold-cards" onClick={() => board.onFold?.(column.id)}>{t('더 보기')} <b>{column.tasks.length - column.shown}</b></button>
        : board.onFold && !inTodayPanel(column) && column.tasks.length > OVERVIEW_SHOWN && <button type="button" className="todo-fold-cards" onClick={() => board.onFold?.(column.id)}>{t('접기')}</button>}
      {column.drop && <button type="button" className="todo-add-card" onClick={() => board.onAdd(column)}><Plus size={14} />{t('작업 추가')}</button>}
    </div>
  </section>;
}

function ColumnTab({ column, index, current, onPick }: { column: BoardColumn; index: number; current: boolean; onPick: (index: number) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: `tab:${column.id}`, data: { type: 'column', column }, disabled: !column.drop });
  return <button ref={setNodeRef} type="button" role="tab" aria-selected={current} className={`${current ? 'current' : ''} ${isOver ? 'drop-target' : ''} ${column.tone ?? ''}`} onClick={() => onPick(index)}>
    {column.title}{(column.count ?? column.tasks.length) > 0 && <b>{column.count ?? column.tasks.length}</b>}
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

/** The Today panel: its own scroll area, all of it a target for cards from the overview. */
function TodayArea({ panel, over, count, children }: { panel: TodayPanel; over: boolean; count: number; children: ReactNode }) {
  const { setNodeRef } = useDroppable({ id: TODAY_PANEL, data: { type: 'column', column: panel.target } });
  return <section ref={setNodeRef} className={`todo-board todo-today-panel ${over ? 'drop-target' : ''}`} aria-label={t('오늘')}>
    {children}
    {count === 0 && <p className="todo-muted todo-today-empty">{t('오늘 할 일을 모두 끝냈습니다.')}</p>}
  </section>;
}

export function BoardView(board: BoardProps) {
  const { columns, groups, context, manual, mobile } = board;
  const overview = !!groups;
  const sensors = useTodoSensors();
  const [activeTask, setActiveTask] = useState<TodoTask | null>(null);
  // Anything dragged, a card or a section: the arrow keys are the drag's meanwhile.
  const [dragging, setDragging] = useState(false);
  const [overColumn, setOverColumn] = useState<string | null>(null);
  // The column the dragged card came from: one from the overview over the Today panel is dated today, whatever takes it.
  const [fromColumn, setFromColumn] = useState<BoardColumn | null>(null);
  const [current, setCurrent] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const tabMenu = useRef<HTMLButtonElement>(null);
  // The sections that can trade places: one project's (each group's on the overview).
  const sectionLists = useMemo(() => (groups ? groups.map(group => group.columns) : [columns]).map(list => list.filter(column => column.sectionId).map(column => column.sectionId!)), [groups, columns]);

  // A phone shows one column at a time; the tabs follow the swipes (and the arrow keys), by where each column starts.
  const columnStarts = () => { const element = scroller.current; const all = element ? [...element.querySelectorAll<HTMLElement>(':scope > .todo-column')] : []; return all.map(column => column.offsetLeft - (all[0]?.offsetLeft ?? 0)); };
  useEffect(() => {
    const element = scroller.current;
    if (!mobile || !element || overview) return;
    const onScroll = () => { const starts = columnStarts(); let nearest = 0; starts.forEach((start, index) => { if (Math.abs(start - element.scrollLeft) < Math.abs(starts[nearest] - element.scrollLeft)) nearest = index; }); setCurrent(nearest); };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, [mobile, overview]);
  const sectionItems = useMemo(() => sectionLists.map(list => list.map(sectionDrag)), [sectionLists]);
  useEffect(() => { if (current >= columns.length) setCurrent(Math.max(0, columns.length - 1)); }, [columns.length, current]);
  const pick = (index: number) => { setCurrent(index); scroller.current?.scrollTo({ left: columnStarts()[index] ?? 0, behavior: 'smooth' }); };

  const columnOf = (data: Record<string, unknown> | undefined) => data?.column as BoardColumn | undefined;
  const onStart = (event: DragStartEvent) => {
    setDragging(true);
    const data = event.active.data.current;
    if (data?.type === 'task') { setActiveTask(data.task as TodoTask); setFromColumn(columnOf(data) ?? null); }
  };
  const stop = () => { setActiveTask(null); setFromColumn(null); setOverColumn(null); setDragging(false); };
  const intoToday = (target: Pick<BoardColumn, 'id'> | undefined, source: BoardColumn | null | undefined) => !!board.today && !!target && !!source && todayPanelDrop(source, target) === 'today';
  /** Whether cards are put in order by hand in `column`: the Today panel's as the Today list keeps them. */
  const manualIn = (column: BoardColumn) => inTodayPanel(column) ? !!board.today?.manual : manual;
  const onOver = (event: DragOverEvent) => setOverColumn(columnOf(event.over?.data.current)?.id ?? null);
  const onEnd = (event: DragEndEvent) => {
    stop();
    const { active, over } = event;
    if (!over) return;
    const data = active.data.current;
    if (data?.type === 'section') {
      const sectionOf = (id: string | number) => String(id).startsWith('section:') ? String(id).slice('section:'.length) : '';
      const afterId = sectionDropAfter(sectionLists, sectionOf(active.id), sectionOf(over.id));
      if (afterId !== undefined) board.onSectionMove(sectionOf(active.id), afterId);
      return;
    }
    if (data?.type !== 'task') return;
    const task = data.task as TodoTask, source = columnOf(data)!, target = columnOf(over.data.current);
    const overTask = over.data.current?.type === 'task' ? (over.data.current.task as TodoTask) : undefined;
    if (board.today && target) {
      const drop = todayPanelDrop(source, target);
      if (drop === 'stay') return;
      if (drop === 'today') { board.onDrop(task, board.today.target, undefined); return; }
    }
    // In a column of several dates (overdue, the next days, later), a card put among its own date's tasks takes its
    // place there; it never changes its date by being dropped in the column it came from.
    if (target && manualIn(target) && !target.drop && target.id === source.id && !target.locked && overTask) {
      const afterId = dayAfterOf(target.tasks, task.id, overTask.id);
      if (afterId !== undefined) board.onDayMove?.(task, afterId);
      return;
    }
    if (!target?.drop) return;
    const place = dropPlace(task.id, source, target, overTask?.id, { manual: manualIn(target), emptyFirst: !!groups && !inTodayPanel(target) });
    if (place) board.onDrop(task, target, place.afterId);
  };

  // A card from the overview over the Today panel lights the panel, not the column of it under the pointer.
  const overToday = !!overColumn && !!activeTask && intoToday({ id: overColumn }, fromColumn);
  const renderColumn = (column: BoardColumn, area?: 'today') => <Column key={column.id} column={column} board={board} active={!!activeTask} over={overColumn === column.id && !overToday}>
    <SortableContext items={shownTasks(column).map(task => cardId(task.id, area))} strategy={verticalListSortingStrategy}>
      {shownTasks(column).map(task => <SortableCard key={task.id} dndId={cardId(task.id, area)} task={task} column={column.locked || !board.taskLocked?.(task) ? column : { ...column, locked: true }} context={area ? board.today!.context : context} selected={board.selectedId === task.id} {...board.card}
        {...(column.locked || board.taskLocked?.(task) ? { readOnly: true } : {})} />)}
    </SortableContext>
  </Column>;
  const todayCount = board.today?.columns.reduce((sum, column) => sum + column.tasks.length, 0) ?? 0;

  const overviewBoard = groups && <div ref={scroller} className={`todo-board todo-overview ${dragging ? 'dragging' : ''}`}>
    {groups.map((group, index) => <section key={group.project.id} className="todo-group" aria-label={groupName(group)} style={{ '--depth': group.depth } as CSSProperties}>
      <header className="todo-group-head">
        <button type="button" className="todo-group-title" onClick={() => board.onGroup?.(group.project)}>
          {group.project.inbox ? <Inbox size={14} /> : <i className="todo-dot" style={{ background: colorOf(group.project.color) }} />}
          {group.parents.length > 0 && <span className="todo-group-path">{group.parents.join(' / ')} /</span>}
          <h3>{groupName(group)}</h3>
        </button>
        <span className="todo-column-count">{group.count || ''}</span>
      </header>
      <div className="todo-group-columns">
        <SortableContext items={sectionItems[index]} strategy={horizontalListSortingStrategy}>
          {group.columns.map(column => renderColumn(column))}
        </SortableContext>
      </div>
    </section>)}
  </div>;

  return <DndContext sensors={sensors} collisionDetection={overview ? overviewCollisions : collisions} onDragStart={onStart} onDragOver={onOver} onDragEnd={onEnd} onDragCancel={stop}>
    {mobile && !groups && (columns.length > 1 || columns[current]?.sectionId) && <div className="todo-column-tabs-bar">
      <div className="todo-column-tabs" role="tablist" aria-label={t('열')}>
        {columns.map((column, index) => <ColumnTab key={column.id} column={column} index={index} current={index === current} onPick={pick} />)}
      </div>
      {/* A phone has no column headers: the shown section's menu (rename, move, delete) sits beside the tabs. */}
      {columns[current]?.sectionId && <button ref={tabMenu} type="button" className="icon-button" aria-label={t('“{0}” 섹션 메뉴', { 0: columns[current].title })}
        onClick={() => tabMenu.current && board.onSectionMenu(columns[current].sectionId!, tabMenu.current)}><MoreHorizontal size={15} /></button>}
    </div>}
    {/* Today and the overview side by side, each scrolling on its own. */}
    {groups ? board.today ? <div className="todo-board-split">
      <TodayArea panel={board.today} over={overToday} count={todayCount}>
        <header className="todo-today-head"><h3>{t('오늘')}</h3><span className="todo-column-note">{board.today.note}</span><span className="todo-column-count">{todayCount || ''}</span></header>
        {board.today.columns.map(column => renderColumn(column, 'today'))}
      </TodayArea>
      {overviewBoard}
    </div> : overviewBoard : <div ref={scroller} className={`todo-board ${dragging ? 'dragging' : ''}`}>
      <SortableContext items={sectionItems[0]} strategy={horizontalListSortingStrategy}>
        {columns.map(column => renderColumn(column))}
      </SortableContext>
      {board.sections && <AddSection onAdd={board.onAddSection} />}
      {board.completed}
    </div>}
    <DragOverlay dropAnimation={null}>{activeTask && <div className="todo-drag-overlay"><TaskCard task={activeTask} context={fromColumn && inTodayPanel(fromColumn) && board.today ? board.today.context : context} {...board.card} /></div>}</DragOverlay>
  </DndContext>;
}
