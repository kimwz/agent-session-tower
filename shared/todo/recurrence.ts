import { addDays, addMonths, dateParts, daysBetween, daysInMonth, formatDate, isWorkday, maxDate, nthWeekday, weekday } from './dates.js';
import type { TodoRecurrence } from './types.js';

/**
 * Repeating dates. A rule is anchored on the task's date: completing the task moves the date to the rule's next
 * occurrence after both the current date and today, so missed occurrences are skipped (Todoist's `every`). With
 * `fromCompletion` the next date counts from the day it was completed instead (`every!`).
 */

const LIMIT = 50_000;

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
  for (let left = count; left > 0;) { next = addDays(next, 1); if (isWorkday(next)) left--; }
  return next;
}

/** Occurrences of an anchored rule strictly after `anchor`, in order, where `anchor` is itself an occurrence. */
function* scheduleAfter(rule: TodoRecurrence, anchor: string): Generator<string> {
  const interval = rule.interval;
  switch (rule.freq) {
    case 'day':
      for (let date = anchor; ;) { date = rule.workdays ? stepWorkdays(date, interval) : addDays(date, interval); yield date; }
    case 'week': {
      const days = new Set(rule.weekdays);
      const weekStart = addDays(anchor, -weekday(anchor));
      for (let date = addDays(anchor, 1); ; date = addDays(date, 1)) {
        if (Math.floor(daysBetween(weekStart, date) / 7) % interval === 0 && days.has(weekday(date))) yield date;
      }
    }
    case 'month': {
      const { year, month } = dateParts(anchor);
      for (let step = 0; ; step += interval) {
        const first = addMonths(formatDate(year, month, 1), step, 1);
        const { year: y, month: m } = dateParts(first);
        const last = daysInMonth(y, m);
        const dates = rule.nth
          ? [nthWeekday(y, m, rule.nth.n, rule.nth.weekday)].filter((date): date is string => date !== undefined)
          : [...new Set((rule.monthDays ?? []).map(day => formatDate(y, m, day === -1 ? last : Math.min(day, last))))].sort();
        for (const date of dates) if (date > anchor) yield date;
      }
    }
    case 'year': {
      const [month, day] = rule.yearDate ?? [dateParts(anchor).month, dateParts(anchor).day];
      const { year } = dateParts(anchor);
      for (let step = 0; ; step += interval) {
        const y = year + step;
        const date = formatDate(y, month, Math.min(day, daysInMonth(y, month)));
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

/** The date a repeating task moves to when completed on `today`, or null when the rule has ended (`until` passed). */
export function nextOccurrence(rule: TodoRecurrence, due: string, today: string): string | null {
  let next: string | undefined;
  if (rule.fromCompletion) next = afterCompletion(rule, today);
  else {
    const after = maxDate(due, today);
    let count = 0;
    for (const date of scheduleAfter(rule, due)) {
      if (date > after) { next = date; break; }
      if (++count > LIMIT) throw new Error('The repeating rule finds no next date.');
    }
  }
  return next !== undefined && (!rule.until || next <= rule.until) ? next : null;
}

/** Later occurrences after `due` up to `to` (at most `limit`), for showing a repeating task's future dates. */
export function futureOccurrences(rule: TodoRecurrence, due: string, to: string, limit = 400): string[] {
  const dates: string[] = [];
  const end = rule.until && rule.until < to ? rule.until : to;
  if (rule.fromCompletion) {
    for (let date = afterCompletion(rule, due); date <= end && dates.length < limit; date = afterCompletion(rule, date)) dates.push(date);
    return dates;
  }
  let count = 0;
  for (const date of scheduleAfter(rule, due)) {
    if (date > end || dates.length >= limit || ++count > LIMIT) break;
    dates.push(date);
  }
  return dates;
}
