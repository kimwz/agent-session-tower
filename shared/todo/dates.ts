/**
 * Local calendar dates as `YYYY-MM-DD` strings. Todo dates float: they mean the same day wherever the page is, so all
 * arithmetic is done on the date alone (in UTC, where no day is skipped or doubled), never on a moment in time.
 */

export const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function validDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return year >= 1970 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

export const validTime = (value: unknown): value is string => typeof value === 'string' && TIME.test(value);

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const parts = (date: string): [number, number, number] => {
  const match = DATE.exec(date);
  if (!match) throw new Error(`Not a date: ${date}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};
const pad = (value: number, size = 2) => String(value).padStart(size, '0');

export function formatDate(year: number, month: number, day: number): string {
  // Date.UTC normalizes overflow (month 13, day 0), so callers can step freely.
  const value = new Date(Date.UTC(year, month - 1, day));
  return `${pad(value.getUTCFullYear(), 4)}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
}

export function dateParts(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = parts(date);
  return { year, month, day };
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = parts(date);
  return formatDate(year, month, day + days);
}

/** Adds months, keeping the day when the target month has it and the month's last day when it does not (Jan 31 → Feb 28). */
export function addMonths(date: string, months: number, day = parts(date)[2]): string {
  const [year, month] = parts(date);
  const first = new Date(Date.UTC(year, month - 1 + months, 1));
  const targetYear = first.getUTCFullYear(), targetMonth = first.getUTCMonth() + 1;
  return formatDate(targetYear, targetMonth, Math.min(day, daysInMonth(targetYear, targetMonth)));
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(date: string): number {
  const [year, month, day] = parts(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export const isWorkday = (date: string) => { const day = weekday(date); return day !== 0 && day !== 6; };

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  const [a, b] = [parts(from), parts(to)];
  return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86_400_000);
}

/** Months from the month of `from` to the month of `to`. */
export function monthsBetween(from: string, to: string): number {
  const [a, b] = [parts(from), parts(to)];
  return (b[0] - a[0]) * 12 + (b[1] - a[1]);
}

/** The `n`th (1–5) or last (-1) given weekday of a month, or undefined when the month has no such day. */
export function nthWeekday(year: number, month: number, n: number, day: number): string | undefined {
  if (n === -1) {
    const last = daysInMonth(year, month);
    const lastWeekday = weekday(formatDate(year, month, last));
    return formatDate(year, month, last - ((lastWeekday - day + 7) % 7));
  }
  const firstWeekday = weekday(formatDate(year, month, 1));
  const date = 1 + ((day - firstWeekday + 7) % 7) + (n - 1) * 7;
  return date <= daysInMonth(year, month) ? formatDate(year, month, date) : undefined;
}

export const maxDate = (a: string, b: string) => a > b ? a : b;
