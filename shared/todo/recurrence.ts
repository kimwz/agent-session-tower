import { addDays, addMonths, dateParts, daysBetween, daysInMonth, formatDate, isWorkday, maxDate, nthWeekday, validDate, weekday } from './dates.js';
import type { TodoRecurrence } from './types.js';

/**
 * Repeating dates. A rule is anchored on the task's date: completing the task moves the date to the rule's next
 * occurrence after both the current date and today, so missed occurrences are skipped (Todoist's `every`). With
 * `fromCompletion` the next date counts from the day it was completed instead (`every!`).
 */

const LIMIT = 50_000;
/** The last date a task can have. */
const LAST = '9999-12-31';

/**
 * Fills in what a rule takes from the date it starts on (which weekday, which day of the month), so later dates do not
 * drift: a monthly task on the 31st stays on the 31st (or the month's last day) instead of moving to the 28th for good.
 */
export function anchoredRecurrence(rule: TodoRecurrence, due: string): TodoRecurrence {
  if (rule.fromCompletion) return { freq: rule.freq, interval: rule.interval, fromCompletion: true, ...(rule.freq === 'day' && rule.workdays ? { workdays: true } : {}), ...(rule.until ? { until: rule.until } : {}) };
  const { month, day } = dateParts(due);
  const base = { freq: rule.freq, interval: rule.interval, ...(rule.until ? { until: rule.until } : {}) };
  switch (rule.freq) {
    case 'day': return { ...base, ...(rule.workdays ? { workdays: true } : {}) };
    case 'week': return { ...base, weekdays: [...new Set(rule.weekdays?.length ? rule.weekdays : [weekday(due)])].sort((a, b) => a - b) };
    case 'month': return rule.nth ? { ...base, nth: rule.nth } : { ...base, monthDays: [...new Set(rule.monthDays?.length ? rule.monthDays : [day])].sort((a, b) => a - b) };
    case 'year': return { ...base, yearDate: rule.yearDate ?? [month, day] };
  }
}

function stepWorkdays(date: string, count: number): string {
  let next = date;
  for (let left = count; left > 0 && validDate(next);) { next = addDays(next, 1); if (validDate(next) && isWorkday(next)) left--; }
  return next;
}

/**
 * Occurrences of an anchored rule strictly after `anchor` and up to `stop`, in order, where `anchor` is itself an
 * occurrence. It ends at `stop` even when a rule finds nothing (the fifth Monday of a February, every four years).
 */
function* scheduleAfter(rule: TodoRecurrence, anchor: string, stop: string): Generator<string> {
  const interval = rule.interval;
  const ended = (date: string) => !validDate(date) || date > stop;
  switch (rule.freq) {
    case 'day':
      for (let date = anchor; ;) {
        if (ended(date = rule.workdays ? stepWorkdays(date, interval) : addDays(date, interval))) return;
        yield date;
      }
    case 'week': {
      const days = new Set(rule.weekdays);
      const weekStart = addDays(anchor, -weekday(anchor));
      for (let date = addDays(anchor, 1); !ended(date); date = addDays(date, 1)) {
        if (Math.floor(daysBetween(weekStart, date) / 7) % interval === 0 && days.has(weekday(date))) yield date;
      }
      return;
    }
    case 'month': {
      const { year, month } = dateParts(anchor);
      for (let step = 0; ; step += interval) {
        const first = formatDate(year, month + step, 1);
        if (ended(first)) return;
        const { year: y, month: m } = dateParts(first);
        const last = daysInMonth(y, m);
        const dates = rule.nth
          ? [nthWeekday(y, m, rule.nth.n, rule.nth.weekday)].filter((date): date is string => date !== undefined)
          : [...new Set((rule.monthDays ?? []).map(day => formatDate(y, m, day === -1 ? last : Math.min(day, last))))].sort();
        for (const date of dates) if (date > anchor && !ended(date)) yield date;
      }
    }
    case 'year': {
      const [month, day] = rule.yearDate ?? [dateParts(anchor).month, dateParts(anchor).day];
      const { year } = dateParts(anchor);
      for (let step = 0; ; step += interval) {
        const y = year + step;
        if (y > 9999) return;
        const date = formatDate(y, month, Math.min(day, daysInMonth(y, month)));
        if (ended(date)) return;
        if (date > anchor) yield date;
      }
    }
  }
}

function afterCompletion(rule: TodoRecurrence, today: string): string {
  switch (rule.freq) {
    case 'day': return rule.workdays ? stepWorkdays(today, rule.interval) : addDays(today, rule.interval);
    case 'week': return addDays(today, 7 * rule.interval);
    case 'month': return addMonths(today, rule.interval);
    case 'year': return addMonths(today, 12 * rule.interval);
  }
}

/**
 * The date a repeating task moves to when completed on `today`: always after its current date, so an occurrence is
 * never done twice. Null when the rule has ended (`until` passed, or no date is left before year 10000).
 */
export function nextOccurrence(rule: TodoRecurrence, due: string, today: string): string | null {
  const stop = rule.until && rule.until < LAST ? rule.until : LAST;
  let next: string | undefined;
  if (rule.fromCompletion) {
    // Done early, it counts from its own date instead, so it still moves on.
    next = afterCompletion(rule, today);
    if (validDate(next) && next <= due) next = afterCompletion(rule, due);
  } else {
    const after = maxDate(due, today);
    let count = 0;
    for (const date of scheduleAfter(rule, due, stop)) {
      if (date > after) { next = date; break; }
      if (++count > LIMIT) return null;
    }
  }
  return next !== undefined && validDate(next) && next > due && next <= stop ? next : null;
}

/** Later occurrences after `due` up to `to` (at most `limit`), for showing a repeating task's future dates. */
export function futureOccurrences(rule: TodoRecurrence, due: string, to: string, limit = 400): string[] {
  const dates: string[] = [];
  const end = rule.until && rule.until < to ? rule.until : to;
  if (rule.fromCompletion) {
    for (let date = afterCompletion(rule, due); validDate(date) && date <= end && dates.length < limit; date = afterCompletion(rule, date)) dates.push(date);
    return dates;
  }
  for (const date of scheduleAfter(rule, due, end)) {
    if (dates.length >= limit) break;
    dates.push(date);
  }
  return dates;
}
