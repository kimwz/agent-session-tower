import { Cron } from 'croner';
import type { Schedule } from '../../shared/triggers.js';

const invalid = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
/** A slot this late is a missed run (sleep, downtime), not an on-time one. */
export const LATE_AFTER_MS = 90_000;
export const CATCH_UP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Five-field cron or the common @-shortcuts, never seconds: the finest schedule is once a minute. */
export function validateSchedule(schedule: Schedule): void {
  if (schedule.type === 'interval') return;
  const fields = schedule.expression.trim().split(/\s+/);
  if (!(fields.length === 5 || (fields.length === 1 && /^@(yearly|annually|monthly|weekly|daily|hourly)$/.test(fields[0])))) {
    throw invalid('Use a five-field cron expression (minute hour day month weekday) or @hourly, @daily, @weekly, @monthly.');
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: schedule.timezone }).format(0); }
  catch { throw invalid(`Unknown time zone: ${schedule.timezone}`); }
  try { cron(schedule).nextRun(); }
  catch (error) { throw invalid(`Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`); }
}

function cron(schedule: Extract<Schedule, { type: 'cron' }>): Cron {
  return new Cron(schedule.expression.trim(), { timezone: schedule.timezone, paused: true, mode: '5-part' });
}

/**
 * The first scheduled time strictly after `after`. Interval schedules count from their anchor.
 * A local time that does not exist that day (daylight-saving gap) is skipped, not moved; a local
 * time that happens twice runs once.
 */
export function nextSlot(schedule: Schedule, after: number, anchor: number): number | undefined {
  if (schedule.type === 'interval') {
    const every = schedule.everySeconds * 1000;
    return anchor + (Math.floor(Math.max(0, after - anchor) / every) + 1) * every;
  }
  const pattern = cron(schedule);
  let next = pattern.nextRun(new Date(after));
  for (let steps = 0; next && !pattern.match(next) && steps < 1000; steps++) next = pattern.nextRun(next);
  return next && pattern.match(next) ? next.getTime() : undefined;
}

/** The latest scheduled time in (from, until], searching at most one catch-up window back. */
export function latestSlot(schedule: Schedule, from: number, until: number, anchor: number): number | undefined {
  let cursor = Math.max(from, until - CATCH_UP_WINDOW_MS - 1);
  let latest: number | undefined;
  for (let steps = 0; steps < 100_000; steps++) {
    const next = nextSlot(schedule, cursor, anchor);
    if (next === undefined || next > until) return latest;
    latest = next; cursor = next;
  }
  return latest;
}

export function previewSlots(schedule: Schedule, from: number, count = 5): string[] {
  validateSchedule(schedule);
  const slots: string[] = [];
  let cursor = from;
  for (let index = 0; index < count; index++) {
    const next = nextSlot(schedule, cursor, from);
    if (next === undefined) break;
    slots.push(new Date(next).toISOString()); cursor = next;
  }
  return slots;
}
