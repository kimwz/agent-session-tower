import { addDays, addMonths, dateParts, formatDate, weekday } from '../../../../shared/todo/dates';
import { futureOccurrences } from '../../../../shared/todo/recurrence';
import type { TodoTask } from '../../../../shared/todo/types';

/**
 * The calendar's arithmetic, apart from drawing: which dates a month or week shows, where a time sits in the time grid
 * and back, how overlapping blocks share a day's width, and what each day holds. Weeks start on Monday.
 */

export type CalendarMode = 'month' | 'week';

/** Minutes per row of the time grid, and the grid's height for an hour. */
export const SLOT_MINUTES = 30;
export const HOUR_HEIGHT = 48;
/** Moves and resizes land on quarter hours. */
export const SNAP_MINUTES = 15;
export const DAY_MINUTES = 1440;
/** A timed task without a duration is drawn as half an hour. */
export const DEFAULT_DURATION = 30;

export const mondayOf = (date: string) => addDays(date, -((weekday(date) + 6) % 7));
export const monthStart = (date: string) => { const { year, month } = dateParts(date); return formatDate(year, month, 1); };

/** The weeks a month view shows: whole Monday-to-Sunday weeks covering the month of `date`. */
export function monthWeeks(date: string): string[][] {
  const first = monthStart(date);
  const last = addDays(addMonths(first, 1), -1);
  const weeks: string[][] = [];
  for (let start = mondayOf(first); start <= last; start = addDays(start, 7)) weeks.push(Array.from({ length: 7 }, (_, index) => addDays(start, index)));
  return weeks;
}

/** The days a time grid shows: the Monday-based week of `date`, or `count` days from it (a phone's three). */
export function gridDays(date: string, count: 7 | 3): string[] {
  const start = count === 7 ? mondayOf(date) : date;
  return Array.from({ length: count }, (_, index) => addDays(start, index));
}

/** The next or previous page of the calendar. */
export function shiftAnchor(date: string, mode: CalendarMode, days: 7 | 3, step: 1 | -1): string {
  return mode === 'month' ? addMonths(monthStart(date), step) : addDays(date, step * days);
}

/** The first and last date shown. */
export function visibleRange(date: string, mode: CalendarMode, days: 7 | 3): { from: string; to: string } {
  if (mode === 'month') { const weeks = monthWeeks(date); return { from: weeks[0][0], to: weeks[weeks.length - 1][6] }; }
  const list = gridDays(date, days);
  return { from: list[0], to: list[list.length - 1] };
}

export const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
export const timeOf = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
export const minutesToY = (minutes: number) => minutes / 60 * HOUR_HEIGHT;

/** The time at `y` pixels into the grid, snapped, kept so the day still holds `length` minutes after it. */
export function yToMinutes(y: number, length = 0, snap = SNAP_MINUTES): number {
  const raw = Math.round(y / HOUR_HEIGHT * 60 / snap) * snap;
  return Math.min(Math.max(0, raw), DAY_MINUTES - Math.max(snap, Math.min(length, DAY_MINUTES)));
}

/** The duration a block's bottom edge at `bottom` pixels gives, from its start; at least one snap, at most to midnight. */
export function resizeMinutes(start: number, bottom: number, snap = SNAP_MINUTES): number {
  const end = Math.round(bottom / HOUR_HEIGHT * 60 / snap) * snap;
  return Math.min(Math.max(snap, end - start), DAY_MINUTES - start);
}

/** The slot a click at `y` falls in: its start, on the half hour. */
export const slotAt = (y: number) => Math.min(DAY_MINUTES - SLOT_MINUTES, Math.max(0, Math.floor(y / HOUR_HEIGHT * 60 / SLOT_MINUTES) * SLOT_MINUTES));

export interface Placed { id: string; start: number; end: number; column: number; columns: number }

/**
 * Side by side where they overlap: blocks that overlap each other form a cluster, each takes the first column free at
 * its start, and every block of a cluster divides the width by the cluster's columns.
 */
export function placeBlocks(blocks: readonly { id: string; start: number; end: number }[]): Placed[] {
  const sorted = [...blocks].sort((a, b) => a.start - b.start || b.end - a.end || (a.id < b.id ? -1 : 1));
  const placed: Placed[] = [];
  let cluster: Placed[] = [];
  let clusterEnd = -1;
  const close = () => { const columns = Math.max(0, ...cluster.map(item => item.column + 1)); for (const item of cluster) item.columns = columns; cluster = []; };
  for (const block of sorted) {
    if (block.start >= clusterEnd) { close(); clusterEnd = -1; }
    const busy = new Set(cluster.filter(item => item.end > block.start).map(item => item.column));
    let column = 0;
    while (busy.has(column)) column++;
    const item: Placed = { ...block, column, columns: 1 };
    cluster.push(item); placed.push(item);
    clusterEnd = Math.max(clusterEnd, block.end);
  }
  close();
  return placed;
}

export type CalendarEntry =
  | { kind: 'task'; task: TodoTask; date: string }
  /** A later occurrence of a repeating task: shown faded, never moved. */
  | { kind: 'future'; task: TodoTask; date: string }
  | { kind: 'deadline'; task: TodoTask; date: string };

export interface DayEntries { allDay: CalendarEntry[]; timed: CalendarEntry[]; deadlines: CalendarEntry[] }

/** The span of a timed entry in minutes, inside its day. */
export function spanOf(task: TodoTask): { start: number; end: number } {
  const start = minutesOf(task.dueTime ?? '00:00');
  return { start, end: Math.min(DAY_MINUTES, start + (task.durationMin ?? DEFAULT_DURATION)) };
}

/** Everything each day from `from` to `to` holds: all-day tasks, timed tasks by time, and deadlines. */
export function dayEntries(tasks: readonly TodoTask[], from: string, to: string, options: { future: boolean }): Map<string, DayEntries> {
  const days = new Map<string, DayEntries>();
  const day = (date: string) => { let entry = days.get(date); if (!entry) days.set(date, entry = { allDay: [], timed: [], deadlines: [] }); return entry; };
  const add = (entry: CalendarEntry) => {
    if (entry.date < from || entry.date > to) return;
    if (entry.kind === 'deadline') day(entry.date).deadlines.push(entry);
    else (entry.task.dueTime ? day(entry.date).timed : day(entry.date).allDay).push(entry);
  };
  for (const task of tasks) {
    if (task.dueDate) {
      add({ kind: 'task', task, date: task.dueDate });
      if (options.future && task.recurrence && task.dueDate <= to) for (const date of futureOccurrences(task.recurrence, task.dueDate, to, 120)) add({ kind: 'future', task, date });
    }
    if (task.deadlineDate) add({ kind: 'deadline', task, date: task.deadlineDate });
  }
  const byTime = (a: CalendarEntry, b: CalendarEntry) => (a.task.dueTime ?? '') < (b.task.dueTime ?? '') ? -1 : (a.task.dueTime ?? '') > (b.task.dueTime ?? '') ? 1 : a.task.priority - b.task.priority || (a.task.sortKey < b.task.sortKey ? -1 : 1);
  for (const entry of days.values()) { entry.allDay.sort(byTime); entry.timed.sort(byTime); }
  return days;
}

/** A month cell's entries in the order shown: all-day first, then timed by time; deadlines are chips of their own. */
export const cellEntries = (entries: DayEntries | undefined): CalendarEntry[] => entries ? [...entries.allDay, ...entries.timed] : [];

/** How many entries fit a month cell before `+n`. */
export function overflow(count: number, fit: number): { shown: number; more: number } {
  return count <= fit ? { shown: count, more: 0 } : { shown: Math.max(0, fit - 1), more: count - Math.max(0, fit - 1) };
}
