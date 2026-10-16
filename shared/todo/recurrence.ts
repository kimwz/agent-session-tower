import { addDays, addMonths, dateParts, daysBetween, daysInMonth, formatDate, isWorkday, maxDate, monthsBetween, nthWeekday, validDate, weekday } from './dates.js';
import type { TodoRecurrence } from './types.js';

/**
 * Repeating dates. A rule is anchored on the task's date: completing the task moves the date to the rule's next
 * occurrence after both the current date and today, so missed occurrences are skipped (Todoist's `every`). With
 * `fromCompletion` the next date counts from the day it was completed instead (`every!`).
 */

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

/** The Friday before a weekend day, else the day itself: counting workdays from either lands on the same days. */
const workdayBase = (date: string) => { const day = weekday(date); return day === 6 ? addDays(date, -1) : day === 0 ? addDays(date, -2) : date; };

/** Workdays after `from` (a workday) up to and including `to`. */
function workdaysBetween(from: string, to: string): number {
  const days = daysBetween(from, to), weeks = Math.floor(days / 7);
  let count = weeks * 5;
  for (let index = weeks * 7 + 1; index <= days; index++) if (isWorkday(addDays(from, index))) count++;
  return count;
}

function stepWorkdays(date: string, count: number): string {
  let next = date;
  for (let left = count; left > 0 && validDate(next);) { next = addDays(next, 1); if (validDate(next) && isWorkday(next)) left--; }
  return next;
}

/**
 * Occurrences of an anchored rule after `from` (and after `anchor`) up to `stop`, in order, where `anchor` is itself an
 * occurrence. It starts near `from` instead of walking from `anchor`, so a date missed for years costs no more than one
 * missed yesterday, and it ends at `stop` even when a rule finds nothing (the fifth Monday of a February, every four
 * years).
 */
function* scheduleAfter(rule: TodoRecurrence, anchor: string, stop: string, from = anchor): Generator<string> {
  const interval = rule.interval;
  const ended = (date: string) => !validDate(date) || date > stop;
  const after = maxDate(anchor, from);
  switch (rule.freq) {
    case 'day': {
      let date: string;
      if (rule.workdays) {
        // The occurrence before `after` on the anchor's beat: five workdays are seven days from a workday.
        const base = workdayBase(anchor);
        const skipped = Math.floor(workdaysBetween(base, after) / interval) * interval;
        date = stepWorkdays(addDays(base, Math.floor(skipped / 5) * 7), skipped % 5);
      } else date = addDays(anchor, Math.floor(daysBetween(anchor, after) / interval) * interval);
      for (;;) {
        if (ended(date = rule.workdays ? stepWorkdays(date, interval) : addDays(date, interval))) return;
        if (date > after) yield date;
      }
    }
    case 'week': {
      const days = new Set(rule.weekdays);
      const weekStart = addDays(anchor, -weekday(anchor));
      const skipped = Math.floor(Math.floor(daysBetween(weekStart, after) / 7) / interval) * interval;
      for (let date = maxDate(addDays(anchor, 1), addDays(weekStart, skipped * 7)); !ended(date); date = addDays(date, 1)) {
        if (date > after && Math.floor(daysBetween(weekStart, date) / 7) % interval === 0 && days.has(weekday(date))) yield date;
      }
      return;
    }
    case 'month': {
      const { year, month } = dateParts(anchor);
      for (let step = Math.floor(monthsBetween(anchor, after) / interval) * interval; ; step += interval) {
        const first = formatDate(year, month + step, 1);
        if (ended(first)) return;
        const { year: y, month: m } = dateParts(first);
        const last = daysInMonth(y, m);
        const dates = rule.nth
          ? [nthWeekday(y, m, rule.nth.n, rule.nth.weekday)].filter((date): date is string => date !== undefined)
          : [...new Set((rule.monthDays ?? []).map(day => formatDate(y, m, day === -1 ? last : Math.min(day, last))))].sort();
        for (const date of dates) if (date > after && !ended(date)) yield date;
      }
    }
    case 'year': {
      const [month, day] = rule.yearDate ?? [dateParts(anchor).month, dateParts(anchor).day];
      const { year } = dateParts(anchor);
      for (let step = Math.floor((dateParts(after).year - year) / interval) * interval; ; step += interval) {
        const y = year + step;
        if (y > 9999) return;
        const date = formatDate(y, month, Math.min(day, daysInMonth(y, month)));
        if (ended(date)) return;
        if (date > after) yield date;
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
 * The date a repeating task moves to when completed on `today`: always after its current date, so completing it
 * always moves it on. Null when the rule has ended (`until` passed, or no date is left before year 10000).
 */
export function nextOccurrence(rule: TodoRecurrence, due: string, today: string): string | null {
  const stop = rule.until && rule.until < LAST ? rule.until : LAST;
  let next: string | undefined;
  if (rule.fromCompletion) {
    // Done early, it counts from its own date instead, so it still moves on.
    next = afterCompletion(rule, today);
    if (validDate(next) && next <= due) next = afterCompletion(rule, due);
  } else {
    // The first one found is the answer: the search starts after both the date and today.
    next = scheduleAfter(rule, due, stop, today).next().value ?? undefined;
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
