import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { DndContext, DragOverlay, useDraggable, useDroppable, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { CalendarX, ChevronLeft, ChevronRight, Flag, Repeat } from 'lucide-react';
import { dateParts, weekday } from '../../../../shared/todo/dates';
import type { TodoOp } from '../../../../shared/todo/ops';
import type { TodoTask } from '../../../../shared/todo/types';
import { getLanguage, translate as t } from '../../i18n/i18n';
import { Popover } from '../Popover';
import type { QuickAddPreset } from '../QuickAdd';
import { colorOf, dateLabel, longDate, monthDay, weekdayName } from '../todo-format';
import { pointerOrNearest, useTodoSensors } from '../todo-dnd';
import type { TodoWorld } from '../todo-model';
import { cellEntries, resizeCommit, DAY_MINUTES, DEFAULT_DURATION, dayEntries, gridDays, HOUR_HEIGHT, minutesToY, monthWeeks, overflow, placeBlocks, resizeMinutes, shiftAnchor, slotAt, spanOf, timeOf, visibleRange, yToMinutes, type CalendarEntry, type CalendarMode, type DayEntries } from './calendar-layout';

/**
 * The calendar layout of a list: a month of days, or a week (three days on a phone) with an all-day row over a time
 * grid. Tasks are dragged to another day, time or the all-day row; a block's bottom edge sets its duration; an empty
 * day or slot adds a task there; undated tasks wait in a side panel to be dragged in. Later occurrences of repeating
 * tasks show faded and cannot be moved.
 */

export interface CalendarProps {
  tasks: TodoTask[];
  world: TodoWorld;
  today: string;
  mode: CalendarMode;
  future: boolean;
  colorBy: 'priority' | 'project';
  mobile: boolean;
  readOnly: boolean;
  onMode: (mode: CalendarMode) => void;
  onOpen: (id: string) => void;
  onAdd: (preset: QuickAddPreset) => void;
  onChange: (ops: TodoOp[]) => void;
}

const PRIORITY_COLORS = { 1: 'var(--p1)', 2: 'var(--p2)', 3: 'var(--p3)', 4: '#7d8aa0' } as const;
const MONTH_FIT = 4;

type Drop = { kind: 'day' | 'allday' | 'time'; date: string };

/** The patch a drop makes, or null when nothing changes. */
export function dropPatch(task: TodoTask, drop: Drop, start?: number): Extract<TodoOp, { op: 'task.update' }>['patch'] | null {
  if (drop.kind === 'day') return task.dueDate === drop.date ? null : { dueDate: drop.date };
  if (drop.kind === 'allday') return task.dueDate === drop.date && !task.dueTime ? null : { dueDate: drop.date, dueTime: null };
  const dueTime = timeOf(start ?? 0);
  if (task.dueDate === drop.date && task.dueTime === dueTime) return null;
  // An all-day or undated task placed in a slot takes that time and half an hour (design 7.4); a timed one keeps its length.
  return { dueDate: drop.date, dueTime, ...(task.dueTime ? {} : { durationMin: DEFAULT_DURATION }) };
}

function useColor(colorBy: CalendarProps['colorBy'], world: TodoWorld) {
  return (task: TodoTask) => colorBy === 'project' ? colorOf(world.projects.find(project => project.id === task.projectId)?.color ?? 'charcoal') : PRIORITY_COLORS[task.priority];
}

function Entry({ entry, color, onOpen, draggable, compact }: { entry: CalendarEntry; color: string; onOpen: (id: string) => void; draggable: boolean; compact?: boolean }) {
  if (entry.kind === 'future') return <FutureEntry entry={entry} color={color} compact={compact} />;
  return <TaskEntry entry={entry} color={color} onOpen={onOpen} draggable={draggable} compact={compact} />;
}

/** A later occurrence of a repeating task: shown only, never opened or moved, since any change would change the real one. */
function FutureEntry({ entry, color, compact }: { entry: CalendarEntry; color: string; compact?: boolean }) {
  const { task } = entry;
  // A press on it is not a press on the empty day under it.
  return <span className={`todo-cal-entry future ${compact ? 'compact' : ''}`} style={{ '--entry-color': color } as CSSProperties} title={t('“{0}”의 다음 반복 (예정)', { 0: task.content })} onClick={event => event.stopPropagation()}>
    <i />{task.dueTime && <time>{task.dueTime}</time>}<span>{task.content}</span><Repeat size={10} />
  </span>;
}

function TaskEntry({ entry, color, onOpen, draggable, compact }: { entry: CalendarEntry; color: string; onOpen: (id: string) => void; draggable: boolean; compact?: boolean }) {
  const { task } = entry;
  const drag = useDraggable({ id: `${entry.kind}:${task.id}:${entry.date}`, data: { task }, disabled: !draggable || entry.kind !== 'task' });
  return <button ref={drag.setNodeRef} type="button" className={`todo-cal-entry ${entry.kind} ${drag.isDragging ? 'dragging' : ''} ${compact ? 'compact' : ''}`} style={{ '--entry-color': color } as CSSProperties}
    title={task.content} onClick={event => { event.stopPropagation(); onOpen(task.id); }} {...drag.attributes} {...drag.listeners}>
    {entry.kind === 'deadline' ? <Flag size={10} /> : <i />}
    {entry.kind !== 'deadline' && task.dueTime && <time>{task.dueTime}</time>}
    <span>{entry.kind === 'deadline' ? t('마감: {0}', { 0: task.content }) : task.content}</span>
    {entry.kind !== 'deadline' && task.recurrence && <Repeat size={10} />}
  </button>;
}

function MonthCell({ date, month, today, entries, color, props }: { date: string; month: number; today: string; entries: DayEntries | undefined; color: (task: TodoTask) => string; props: CalendarProps & { selected: string; onSelect: (date: string) => void } }) {
  const drop = useDroppable({ id: `day:${date}`, data: { drop: { kind: 'day', date } satisfies Drop }, disabled: props.readOnly });
  const more = useRef<HTMLButtonElement>(null);
  const [showAll, setShowAll] = useState(false);
  const list = cellEntries(entries);
  const deadlines = entries?.deadlines ?? [];
  const { shown, more: hidden } = overflow(list.length + deadlines.length, MONTH_FIT);
  const all = [...list, ...deadlines];
  const outside = dateParts(date).month !== month;
  return <div ref={drop.setNodeRef} role="gridcell" aria-label={longDate(date)} className={`todo-cal-cell ${outside ? 'outside' : ''} ${date === today ? 'today' : ''} ${date < today ? 'past' : ''} ${drop.isOver ? 'drop-target' : ''} ${props.mobile && date === props.selected ? 'selected' : ''}`}
    onClick={() => props.mobile ? props.onSelect(date) : !props.readOnly && props.onAdd({ dueDate: date })}>
    <span className="todo-cal-day">{dateParts(date).day}</span>
    {props.mobile
      ? all.length > 0 && <span className="todo-cal-dots">{all.slice(0, 3).map((entry, index) => <i key={index} className={entry.kind} style={{ background: color(entry.task) }} />)}</span>
      : <>
        {all.slice(0, shown).map(entry => <Entry key={`${entry.kind}:${entry.task.id}`} entry={entry} color={color(entry.task)} onOpen={props.onOpen} draggable={!props.readOnly} compact />)}
        {hidden > 0 && <button ref={more} type="button" className="todo-cal-more" onClick={event => { event.stopPropagation(); setShowAll(true); }}>{t('+{0}개', { 0: hidden })}</button>}
        {showAll && <Popover anchor={more} onClose={() => setShowAll(false)} label={longDate(date)} className="todo-cal-day-popover">
          <h4>{longDate(date)}</h4>
          {all.map(entry => <Entry key={`${entry.kind}:${entry.task.id}`} entry={entry} color={color(entry.task)} onOpen={props.onOpen} draggable={false} />)}
        </Popover>}
      </>}
  </div>;
}

function MonthView({ props, days, anchor, color, selected, onSelect }: { props: CalendarProps; days: Map<string, DayEntries>; anchor: string; color: (task: TodoTask) => string; selected: string; onSelect: (date: string) => void }) {
  const weeks = monthWeeks(anchor);
  const month = dateParts(anchor).month;
  const day = days.get(selected);
  const selectedEntries = [...cellEntries(day), ...(day?.deadlines ?? [])];
  return <>
    <div className="todo-cal-month" role="grid" aria-label={t('월간')}>
      <div className="todo-cal-weekdays" role="row">{[1, 2, 3, 4, 5, 6, 0].map(index => <span key={index} role="columnheader">{weekdayName(index)}</span>)}</div>
      {weeks.map(week => <div key={week[0]} className="todo-cal-week" role="row">
        {week.map(date => <MonthCell key={date} date={date} month={month} today={props.today} entries={days.get(date)} color={color} props={{ ...props, selected, onSelect }} />)}
      </div>)}
    </div>
    {props.mobile && <section className="todo-cal-agenda" aria-label={longDate(selected)}>
      <header><h3>{dateLabel(selected, props.today)}</h3><span>{longDate(selected)}</span>
        {!props.readOnly && <button type="button" className="todo-tool" onClick={() => props.onAdd({ dueDate: selected })}>{t('작업 추가')}</button>}</header>
      {selectedEntries.length ? selectedEntries.map(entry => <Entry key={`${entry.kind}:${entry.task.id}`} entry={entry} color={color(entry.task)} onOpen={props.onOpen} draggable={!props.readOnly} />)
        : <p className="todo-muted">{t('일정이 없습니다')}</p>}
    </section>}
  </>;
}

function AllDayCell({ date, entries, color, props }: { date: string; entries: DayEntries | undefined; color: (task: TodoTask) => string; props: CalendarProps }) {
  const drop = useDroppable({ id: `allday:${date}`, data: { drop: { kind: 'allday', date } satisfies Drop }, disabled: props.readOnly });
  return <div ref={drop.setNodeRef} className={`todo-cal-allday-cell ${drop.isOver ? 'drop-target' : ''}`} onClick={() => !props.readOnly && props.onAdd({ dueDate: date })}>
    {[...(entries?.allDay ?? []), ...(entries?.deadlines ?? [])].map(entry => <Entry key={`${entry.kind}:${entry.task.id}`} entry={entry} color={color(entry.task)} onOpen={props.onOpen} draggable={!props.readOnly} compact />)}
  </div>;
}

function Block({ entry, placed, color, props, preview }: { entry: CalendarEntry; placed: { column: number; columns: number }; color: string; props: CalendarProps; preview: { minutes: number } | null }) {
  const { task } = entry;
  const span = spanOf(task);
  const movable = entry.kind === 'task' && !props.readOnly;
  const drag = useDraggable({ id: `block:${task.id}:${entry.date}`, data: { task, block: true }, disabled: !movable });
  const [resize, setResize] = useState<number | null>(null);
  const length = (resize ?? span.end - span.start);
  const start = preview?.minutes ?? span.start;
  const style = {
    '--entry-color': color,
    top: minutesToY(span.start), height: Math.max(18, minutesToY(length) - 2),
    left: `calc(${(placed.column / placed.columns) * 100}% + 2px)`, width: `calc(${100 / placed.columns}% - 4px)`,
    transform: drag.transform ? `translate3d(${drag.transform.x}px, ${drag.transform.y}px, 0)` : undefined,
  } as CSSProperties;
  const onResize = (event: ReactPointerEvent<HTMLSpanElement>) => {
    event.stopPropagation();
    event.preventDefault();
    const column = event.currentTarget.closest('[data-time-column]')?.getBoundingClientRect();
    if (!column) return;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const from = event.clientY;
    // Null until the edge really moves: a press alone, or a block clipped at midnight, keeps its duration.
    let value: number | null = null;
    const move = (next: PointerEvent) => {
      if (value === null && Math.abs(next.clientY - from) < 3) return;
      value = resizeMinutes(span.start, next.clientY - column.top);
      setResize(value);
    };
    const end = (finish: PointerEvent) => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end);
      setResize(null);
      const durationMin = resizeCommit(task.durationMin ?? DEFAULT_DURATION, value, finish.type === 'pointercancel');
      if (durationMin !== null) props.onChange([{ op: 'task.update', id: task.id, patch: { durationMin } }]);
    };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
  };
  if (entry.kind === 'future') return <div className={`todo-cal-block future ${length < 45 ? 'short' : ''}`} style={style} title={t('“{0}”의 다음 반복 (예정)', { 0: task.content })} onClick={event => event.stopPropagation()}>
    <time>{timeOf(start)}</time><span>{task.content}</span>
  </div>;
  return <div ref={drag.setNodeRef} className={`todo-cal-block ${entry.kind} ${drag.isDragging ? 'dragging' : ''} ${length < 45 ? 'short' : ''}`} style={style} title={task.content}
    onClick={event => { event.stopPropagation(); props.onOpen(task.id); }} {...drag.attributes} {...drag.listeners} role="button"
    onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); props.onOpen(task.id); } else drag.listeners?.onKeyDown?.(event); }}>
    <time>{timeOf(start)}{length >= 45 && `–${timeOf(Math.min(DAY_MINUTES - 1, start + length))}`}</time>
    <span>{task.content}</span>
    {movable && <span className="todo-cal-resize" aria-hidden="true" onPointerDown={onResize} onMouseDown={event => event.stopPropagation()} onTouchStart={event => event.stopPropagation()} onClick={event => event.stopPropagation()} />}
  </div>;
}

function TimeColumn({ date, entries, color, props, dragging }: { date: string; entries: DayEntries | undefined; color: (task: TodoTask) => string; props: CalendarProps; dragging: { id: string; minutes: number } | null }) {
  const drop = useDroppable({ id: `time:${date}`, data: { drop: { kind: 'time', date } satisfies Drop }, disabled: props.readOnly });
  const timed = entries?.timed ?? [];
  const placed = new Map(placeBlocks(timed.map(entry => ({ id: `${entry.kind}:${entry.task.id}`, ...spanOf(entry.task) }))).map(item => [item.id, item]));
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return <div ref={drop.setNodeRef} data-time-column={date} className={`todo-cal-column ${date === props.today ? 'today' : ''} ${drop.isOver ? 'drop-target' : ''}`}
    onClick={event => { if (props.readOnly || event.target !== event.currentTarget) return; const minutes = slotAt(event.clientY - event.currentTarget.getBoundingClientRect().top); props.onAdd({ dueDate: date, dueTime: timeOf(minutes), durationMin: DEFAULT_DURATION }); }}>
    {date === props.today && <i className="todo-cal-now" style={{ top: minutesToY(nowMinutes) }} />}
    {timed.map(entry => <Block key={`${entry.kind}:${entry.task.id}`} entry={entry} placed={placed.get(`${entry.kind}:${entry.task.id}`)!} color={color(entry.task)} props={props}
      preview={dragging && dragging.id === `block:${entry.task.id}:${entry.date}` ? { minutes: dragging.minutes } : null} />)}
  </div>;
}

function WeekView({ props, days, list, color, dragging }: { props: CalendarProps; days: Map<string, DayEntries>; list: string[]; color: (task: TodoTask) => string; dragging: { id: string; minutes: number } | null }) {
  const scroller = useRef<HTMLDivElement>(null);
  // The grid opens at eight in the morning.
  useLayoutEffect(() => { if (scroller.current) scroller.current.scrollTop = minutesToY(8 * 60) - 8; }, []);
  const columns = { gridTemplateColumns: `52px repeat(${list.length}, minmax(0, 1fr))` };
  // The day heads and the all-day row scroll with the grid (held at its top) so their columns always line up.
  return <div className="todo-cal-week-view">
    <div ref={scroller} className="todo-cal-grid-scroll">
      <div className="todo-cal-sticky">
        <div className="todo-cal-week-head" style={columns}>
          <span />
          {list.map(date => <div key={date} className={`todo-cal-head-day ${date === props.today ? 'today' : ''}`}><span>{weekdayName(weekday(date))}</span><b>{dateParts(date).day}</b></div>)}
        </div>
        <div className="todo-cal-allday" style={columns}>
          <span className="todo-cal-gutter-label">{t('종일')}</span>
          {list.map(date => <AllDayCell key={date} date={date} entries={days.get(date)} color={color} props={props} />)}
        </div>
      </div>
      <div className="todo-cal-grid" style={{ ...columns, height: minutesToY(DAY_MINUTES) }}>
        <div className="todo-cal-hours">{Array.from({ length: 24 }, (_, hour) => <span key={hour} style={{ top: minutesToY(hour * 60) }}>{hour ? `${String(hour).padStart(2, '0')}:00` : ''}</span>)}</div>
        {list.map(date => <TimeColumn key={date} date={date} entries={days.get(date)} color={color} props={props} dragging={dragging} />)}
      </div>
    </div>
  </div>;
}

function Unscheduled({ tasks, color, props }: { tasks: TodoTask[]; color: (task: TodoTask) => string; props: CalendarProps }) {
  return <aside className="todo-cal-unscheduled" aria-label={t('날짜 없음')}>
    <h3>{t('날짜 없음')}<span>{tasks.length || ''}</span></h3>
    {tasks.length ? <div>{tasks.map(task => <Entry key={task.id} entry={{ kind: 'task', task, date: '' }} color={color(task)} onOpen={props.onOpen} draggable={!props.readOnly} />)}</div>
      : <p className="todo-muted">{t('날짜 없는 작업이 없습니다')}</p>}
    {!props.readOnly && tasks.length > 0 && <p className="todo-muted todo-cal-hint">{t('끌어서 날짜나 시간에 놓으세요')}</p>}
  </aside>;
}

/** `10월 12일 – 18일`, or both months when the days cross one. */
export function periodTitle(first: string, last: string): string {
  if (dateParts(first).month !== dateParts(last).month) return `${monthDay(first)} – ${monthDay(last)}`;
  return `${monthDay(first)} – ${getLanguage() === 'en' ? dateParts(last).day : `${dateParts(last).day}일`}`;
}

export function CalendarView(props: CalendarProps) {
  const { tasks, today, mode, future, mobile } = props;
  const span = mobile ? 3 : 7;
  const [anchor, setAnchor] = useState(today);
  const [selected, setSelected] = useState(today);
  const [panel, setPanel] = useState(false);
  const [active, setActive] = useState<{ task: TodoTask; block: boolean } | null>(null);
  const [dragging, setDragging] = useState<{ id: string; minutes: number } | null>(null);
  const sensors = useTodoSensors('free');
  const color = useColor(props.colorBy, props.world);
  const range = visibleRange(anchor, mode, span);
  const days = useMemo(() => dayEntries(tasks, range.from, range.to, { future }), [tasks, range.from, range.to, future]);
  const undated = useMemo(() => tasks.filter(task => !task.dueDate), [tasks]);
  useEffect(() => { setAnchor(today); setSelected(today); }, [mode, today]);
  const list = gridDays(anchor, span);
  const title = mode === 'month'
    ? getLanguage() === 'en' ? `${monthDay(anchor).split(' ')[0]} ${dateParts(anchor).year}` : `${dateParts(anchor).year}년 ${dateParts(anchor).month}월`
    : periodTitle(list[0], list[list.length - 1]);
  const showsToday = today >= range.from && today <= range.to && (mode === 'week' || dateParts(anchor).month === dateParts(today).month);

  const startMinutes = (event: DragEndEvent | { active: DragEndEvent['active'] }, date: string, task: TodoTask) => {
    const column = document.querySelector(`[data-time-column="${date}"]`)?.getBoundingClientRect();
    const top = event.active.rect.current.translated?.top;
    return column && top !== undefined ? yToMinutes(top - column.top, task.durationMin ?? DEFAULT_DURATION) : undefined;
  };
  const onStart = (event: DragStartEvent) => {
    const data = event.active.data.current as { task: TodoTask; block?: boolean } | undefined;
    if (data) setActive({ task: data.task, block: !!data.block });
  };
  const onMove = (event: { active: DragEndEvent['active']; over: DragEndEvent['over'] }) => {
    const data = event.active.data.current as { task: TodoTask; block?: boolean } | undefined;
    const drop = event.over?.data.current?.drop as Drop | undefined;
    if (!data?.block || drop?.kind !== 'time') { if (dragging) setDragging(null); return; }
    const minutes = startMinutes(event, drop.date, data.task);
    if (minutes !== undefined && minutes !== dragging?.minutes) setDragging({ id: String(event.active.id), minutes });
  };
  const onEnd = (event: DragEndEvent) => {
    setActive(null); setDragging(null);
    const data = event.active.data.current as { task: TodoTask } | undefined;
    const drop = event.over?.data.current?.drop as Drop | undefined;
    if (!data || !drop) return;
    const patch = dropPatch(data.task, drop, drop.kind === 'time' ? startMinutes(event, drop.date, data.task) : undefined);
    if (patch) props.onChange([{ op: 'task.update', id: data.task.id, patch }]);
  };

  return <div className={`todo-calendar ${panel ? 'with-panel' : ''}`}>
    <div className="todo-cal-toolbar">
      <div className="todo-week-nav">
        <button type="button" className="icon-button" aria-label={mode === 'month' ? t('이전 달') : t('이전')} onClick={() => setAnchor(value => shiftAnchor(value, mode, span, -1))}><ChevronLeft size={15} /></button>
        <button type="button" className="todo-tool" disabled={showsToday} onClick={() => { setAnchor(today); setSelected(today); }}>{t('오늘')}</button>
        <button type="button" className="icon-button" aria-label={mode === 'month' ? t('다음 달') : t('다음')} onClick={() => setAnchor(value => shiftAnchor(value, mode, span, 1))}><ChevronRight size={15} /></button>
      </div>
      <h3 className="todo-cal-title">{title}</h3>
      <div className="todo-segmented" role="radiogroup" aria-label={t('달력 보기')}>
        <button type="button" role="radio" aria-checked={mode === 'month'} onClick={() => props.onMode('month')}>{t('월간')}</button>
        <button type="button" role="radio" aria-checked={mode === 'week'} onClick={() => props.onMode('week')}>{mobile ? t('3일') : t('주간')}</button>
      </div>
      <button type="button" className={`todo-tool ${panel ? 'active' : ''}`} aria-pressed={panel} onClick={() => setPanel(value => !value)}><CalendarX size={14} /><span>{t('날짜 없음')}</span>{undated.length > 0 && <b className="todo-cal-count">{undated.length}</b>}</button>
    </div>
    <DndContext sensors={sensors} collisionDetection={pointerOrNearest} onDragStart={onStart} onDragMove={onMove} onDragEnd={onEnd} onDragCancel={() => { setActive(null); setDragging(null); }}>
      <div className="todo-cal-body">
        {panel && mobile && <Unscheduled tasks={undated} color={color} props={props} />}
        <div className="todo-cal-main">
          {mode === 'month' ? <MonthView props={props} days={days} anchor={anchor} color={color} selected={selected} onSelect={setSelected} />
            : <WeekView props={props} days={days} list={list} color={color} dragging={dragging} />}
        </div>
        {panel && !mobile && <Unscheduled tasks={undated} color={color} props={props} />}
      </div>
      <DragOverlay dropAnimation={null}>{active && !active.block && <div className="todo-cal-entry overlay" style={{ '--entry-color': color(active.task) } as CSSProperties}><i /><span>{active.task.content}</span></div>}</DragOverlay>
    </DndContext>
  </div>;
}
