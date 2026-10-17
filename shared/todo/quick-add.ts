import { addDays, addMonths, dateParts, daysInMonth, formatDate, isWorkday, nthWeekday, validDate, weekday } from './dates.js';
import type { TodoPriority, TodoRecurrence } from './types.js';

/**
 * Quick Add: a task typed in one line, where a few words set its properties. `#project`, `/section`, `@label`,
 * `p1`–`p4`, `{deadline}`, and a small Korean and English grammar of dates, times, durations and repeats. A word is
 * read only where it stands alone (between spaces), so a title keeps words that merely contain one; and the owner can
 * turn any recognized word back into plain text by its `key`.
 */

export type QuickAddKind = 'project' | 'section' | 'label' | 'priority' | 'deadline' | 'repeat' | 'date' | 'time' | 'duration';

export interface QuickAddToken {
  kind: QuickAddKind;
  start: number;
  end: number;
  text: string;
  /** Names the word for `ignored`: the same word stays plain text wherever it is typed. */
  key: string;
}

export interface QuickAddContext {
  /** The page's local date. */
  today: string;
  projects: readonly { id: string; name: string }[];
  sections: readonly { id: string; projectId: string; name: string }[];
  labels: readonly { id: string; name: string }[];
  /** The project a `/section` belongs to when no `#project` is typed. */
  defaultProjectId?: string;
  /** Keys of words the owner turned back into plain text. */
  ignored?: ReadonlySet<string>;
}

export interface QuickAddResult {
  /** The title: the text without its recognized words. */
  content: string;
  tokens: QuickAddToken[];
  projectId?: string;
  sectionId?: string;
  labelIds: string[];
  /** `@names` of labels that do not exist yet. */
  newLabels: string[];
  priority?: TodoPriority;
  dueDate?: string;
  dueTime?: string;
  durationMin?: number;
  recurrence?: TodoRecurrence;
  deadlineDate?: string;
}

const WEEKDAY_KO: Record<string, number> = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
const WEEKDAY_EN: [RegExp, number][] = [
  [/^sun(day)?$/, 0], [/^mon(day)?$/, 1], [/^tue(s|sday)?$/, 2], [/^wed(nesday)?$/, 3], [/^thu(r|rs|rsday)?$/, 4], [/^fri(day)?$/, 5], [/^sat(urday)?$/, 6],
];
const EN_DAY = 'sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rsday|rs|r)?|fri(?:day)?|sat(?:urday)?';
/** Alone, a weekday is read only by its full name: `sun` or `wed` in a title stays a word. */
const EN_DAY_FULL = 'sunday|monday|tuesday|wednesday|thursday|friday|saturday';
const KO_DAY = '[일월화수목금토]요일';
const KO_DAY_SHORT = '[일월화수목금토](?:요일)?';
const MONTHS_EN = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const EN_MONTH = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const ORDINAL_KO: Record<string, 1 | 2 | 3 | 4 | 5 | -1> = { 첫째: 1, 첫번째: 1, 둘째: 2, 두번째: 2, 셋째: 3, 세번째: 3, 넷째: 4, 네번째: 4, 다섯째: 5, 마지막: -1 };
const ORDINAL_EN: Record<string, 1 | 2 | 3 | 4 | 5 | -1> = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5, last: -1 };

const koDay = (text: string) => WEEKDAY_KO[text[0]];
/** `월,수`, `월수`, `월요일과 금요일`: every weekday named, the 일 of 요일 aside. */
const koDays = (text: string) => [...new Set([...text.replace(/요일/g, '').matchAll(/[일월화수목금토]/g)].map(match => WEEKDAY_KO[match[0]]))].sort((a, b) => a - b);
const enDay = (text: string) => WEEKDAY_EN.find(([pattern]) => pattern.test(text.toLowerCase()))?.[1] ?? -1;
const enMonth = (text: string) => MONTHS_EN.indexOf(text.slice(0, 3).toLowerCase()) + 1;
/** `mon, wed`, `monday and friday`. */
const enDays = (text: string) => [...new Set(text.split(/\s*,\s*|\s+and\s+|\s+/).filter(Boolean).map(enDay).filter(day => day >= 0))].sort((a, b) => a - b);

/** Days after `today` until the next `day` (1–7: today never counts). */
const daysUntil = (today: string, day: number) => ((day - weekday(today) + 6) % 7) + 1;
/** Monday-based week: the given weekday in this week (0) or next week (1). */
function weekdayOfWeek(today: string, day: number, weeks: number): string {
  const monday = addDays(today, -((weekday(today) + 6) % 7) + 7 * weeks);
  return addDays(monday, (day + 6) % 7);
}
/** A month and day from now on: this year's, or next year's when it has passed. */
function upcomingDate(today: string, month: number, day: number): string | undefined {
  if (month < 1 || month > 12 || day < 1) return undefined;
  const { year } = dateParts(today);
  for (const candidate of [year, year + 1]) {
    if (day > daysInMonth(candidate, month)) continue;
    const date = formatDate(candidate, month, day);
    if (date >= today) return date;
  }
  return undefined;
}
function upcomingMonthDay(today: string, day: number): string | undefined {
  if (day < 1) return undefined;
  const { year, month } = dateParts(today);
  for (let step = 0; step < 12; step++) {
    const first = formatDate(year, month + step, 1);
    const { year: y, month: m } = dateParts(first);
    if (day > daysInMonth(y, m)) continue;
    const date = formatDate(y, m, day);
    if (date >= today) return date;
  }
  return undefined;
}
const time = (hour: number, minute: number) => hour >= 0 && hour < 24 && minute >= 0 && minute < 60 ? `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` : undefined;
const meridiem = (hour: number, half: string | undefined) => {
  if (!half || hour < 1 || hour > 12) return half ? -1 : hour;
  const pm = /^(오후|pm)$/i.test(half);
  return pm ? (hour === 12 ? 12 : hour + 12) : (hour === 12 ? 0 : hour);
};

type Read<T> = { length: number; value: T } | undefined;
type Matcher<T> = (rest: string, today: string) => Read<T>;

/** A pattern that must end where a word ends. */
function word<T>(pattern: string, read: (match: RegExpExecArray, today: string) => T | undefined): Matcher<T> {
  const regex = new RegExp(`^(?:${pattern})(?=\\s|$)`, 'i');
  return (rest, today) => {
    const match = regex.exec(rest);
    if (!match) return undefined;
    const value = read(match, today);
    return value === undefined ? undefined : { length: match[0].length, value };
  };
}
const first = <T>(...matchers: Matcher<T>[]): Matcher<T> => (rest, today) => {
  for (const matcher of matchers) { const found = matcher(rest, today); if (found) return found; }
  return undefined;
};

const dateMatchers: Matcher<string> = first<string>(
  word('오늘|today|tod', (_, today) => today),
  word('내일|tomorrow|tmrw?', (_, today) => addDays(today, 1)),
  word('모레', (_, today) => addDays(today, 2)),
  word('이번\\s?주말|this weekend', (_, today) => [0, 6].includes(weekday(today)) ? today : addDays(today, daysUntil(today, 6))),
  word('다음\\s?주말|next weekend', (_, today) => weekdayOfWeek(today, 6, 1)),
  word(`(이번|다음)\\s?주\\s?(${KO_DAY})`, (match, today) => weekdayOfWeek(today, koDay(match[2]), match[1] === '다음' ? 1 : 0)),
  word(`next (${EN_DAY})`, (match, today) => weekdayOfWeek(today, enDay(match[1]), 1)),
  word('다음\\s?주|next week', (_, today) => weekdayOfWeek(today, 1, 1)),
  word(KO_DAY, (match, today) => addDays(today, daysUntil(today, koDay(match[0])))),
  word(`on (${EN_DAY})|(${EN_DAY_FULL})`, (match, today) => addDays(today, daysUntil(today, enDay(match[1] ?? match[2])))),
  word('(\\d{4})-(\\d{2})-(\\d{2})', match => validDate(match[0]) ? match[0] : undefined),
  word('(\\d{1,2})/(\\d{1,2})', (match, today) => upcomingDate(today, Number(match[1]), Number(match[2]))),
  word('(\\d{1,2})월\\s?(\\d{1,2})일', (match, today) => upcomingDate(today, Number(match[1]), Number(match[2]))),
  word(`(${EN_MONTH})\\.? (\\d{1,2})(?:st|nd|rd|th)?`, (match, today) => upcomingDate(today, enMonth(match[1]), Number(match[2]))),
  word(`(\\d{1,2})(?:st|nd|rd|th)? (${EN_MONTH})`, (match, today) => upcomingDate(today, enMonth(match[2]), Number(match[1]))),
  word('(\\d{1,3})\\s?(일|주|개월|달)\\s?(?:후|뒤)', (match, today) => match[2] === '일' ? addDays(today, Number(match[1])) : match[2] === '주' ? addDays(today, 7 * Number(match[1])) : addMonths(today, Number(match[1]))),
  word('in (\\d{1,3}) (days?|weeks?|months?)', (match, today) => match[2].startsWith('day') ? addDays(today, Number(match[1])) : match[2].startsWith('week') ? addDays(today, 7 * Number(match[1])) : addMonths(today, Number(match[1]))),
  word('(\\d{1,2})일', (match, today) => upcomingMonthDay(today, Number(match[1]))),
);

const timeMatcher: Matcher<string> = first<string>(
  word('정오|noon', () => '12:00'),
  word('(오전|오후)\\s?(\\d{1,2})시(?:\\s?(\\d{1,2})분|\\s?(반))?', match => { const hour = meridiem(Number(match[2]), match[1]); return time(hour, match[4] ? 30 : Number(match[3] ?? 0)); }),
  word('(\\d{1,2})시(?:\\s?(\\d{1,2})분|\\s?(반))?', match => time(Number(match[1]), match[3] ? 30 : Number(match[2] ?? 0))),
  word('(?:at )?(\\d{1,2})(?::(\\d{2}))?\\s?(am|pm)', match => { const hour = meridiem(Number(match[1]), match[3]); return time(hour, Number(match[2] ?? 0)); }),
  word('(?:at )?(\\d{1,2}):(\\d{2})', match => time(Number(match[1]), Number(match[2]))),
);

const minutes = (value: number) => value >= 1 && value <= 1440 ? value : undefined;
const durationMatcher: Matcher<number> = first<number>(
  word('(\\d{1,2})\\s?시간(?:\\s?(\\d{1,2})\\s?분)?', match => minutes(Number(match[1]) * 60 + Number(match[2] ?? 0))),
  word('(\\d{1,4})\\s?분', match => minutes(Number(match[1]))),
  word('(?:for )?(\\d{1,2})\\s?h(?:\\s?(\\d{1,2})\\s?m(?:in)?)?', match => minutes(Number(match[1]) * 60 + Number(match[2] ?? 0))),
  word('(?:for )?(\\d{1,2}) ?(?:hours?|hrs?)', match => minutes(Number(match[1]) * 60)),
  word('(?:for )?(\\d{1,4}) ?(?:m|mins?|minutes?)', match => minutes(Number(match[1]))),
);

const UNIT: Record<string, TodoRecurrence['freq']> = { 일: 'day', 주: 'week', 개월: 'month', 달: 'month', 년: 'year', day: 'day', week: 'week', month: 'month', year: 'year' };
const unit = (text: string) => UNIT[text.toLowerCase().replace(/s$/, '')];
const repeatMatcher: Matcher<TodoRecurrence> = first<TodoRecurrence>(
  word('매일|every ?day|daily', () => ({ freq: 'day', interval: 1 })),
  word('평일마다|매\\s?평일|평일|every (?:weekday|workday)|weekdays', () => ({ freq: 'day', interval: 1, workdays: true })),
  word(`(매주|격주)\\s?(${KO_DAY_SHORT}(?:\\s*(?:,|·|/|와|과|및)?\\s*${KO_DAY_SHORT})*)`, match => ({ freq: 'week', interval: match[1] === '격주' ? 2 : 1, weekdays: koDays(match[2]) })),
  word('매주|weekly|every week', () => ({ freq: 'week', interval: 1 })),
  word('격주|every other week', () => ({ freq: 'week', interval: 2 })),
  word(`every ((?:${EN_DAY})(?:(?:\\s*,\\s*|\\s+and\\s+|\\s+)(?:${EN_DAY}))*)`, match => ({ freq: 'week', interval: 1, weekdays: enDays(match[1]) })),
  word(`(?:매월|매달)\\s?(첫째|첫번째|둘째|두번째|셋째|세번째|넷째|네번째|다섯째|마지막)\\s?(${KO_DAY})`, match => ({ freq: 'month', interval: 1, nth: { n: ORDINAL_KO[match[1]], weekday: koDay(match[2]) } })),
  word(`every (first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last) (${EN_DAY})`, match => ({ freq: 'month', interval: 1, nth: { n: ORDINAL_EN[match[1].toLowerCase()], weekday: enDay(match[2]) } })),
  word('(?:매월|매달)\\s?(말일|마지막\\s?날)', () => ({ freq: 'month', interval: 1, monthDays: [-1] })),
  word('every last day', () => ({ freq: 'month', interval: 1, monthDays: [-1] })),
  word('(?:매월|매달)\\s?(\\d{1,2})일', match => Number(match[1]) >= 1 && Number(match[1]) <= 31 ? { freq: 'month', interval: 1, monthDays: [Number(match[1])] } : undefined),
  word('every (\\d{1,2})(?:st|nd|rd|th)', match => Number(match[1]) >= 1 && Number(match[1]) <= 31 ? { freq: 'month', interval: 1, monthDays: [Number(match[1])] } : undefined),
  word('매월|매달|monthly|every month', () => ({ freq: 'month', interval: 1 })),
  word('매년\\s?(\\d{1,2})월\\s?(\\d{1,2})일', match => { const [month, day] = [Number(match[1]), Number(match[2])]; return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(2024, month) ? { freq: 'year', interval: 1, yearDate: [month, day] } : undefined; }),
  word('매년|yearly|annually|every year', () => ({ freq: 'year', interval: 1 })),
  word('완료\\s?(?:후|뒤)\\s?(\\d{1,3})\\s?(일|주|개월|달|년)\\s?마다', match => Number(match[1]) >= 1 ? { freq: unit(match[2]), interval: Number(match[1]), fromCompletion: true } : undefined),
  word('(\\d{1,3})\\s?(일|주|개월|달|년)\\s?마다', match => Number(match[1]) >= 1 ? { freq: unit(match[2]), interval: Number(match[1]) } : undefined),
  word('every! ?(\\d{1,3})? ?(days?|weeks?|months?|years?)', match => ({ freq: unit(match[2]), interval: Number(match[1] ?? 1) || 1, fromCompletion: true })),
  word('every (\\d{1,3}) (days?|weeks?|months?|years?)', match => Number(match[1]) >= 1 ? { freq: unit(match[2]), interval: Number(match[1]) } : undefined),
);

/**
 * When a repeat starts and ends, read right after it: `<date>부터`/`starting <date>`, then `<date>까지`/`until <date>`.
 * `untilAt` is where the end begins, so an end that cannot be kept is cut off and left as text.
 */
function repeatBounds(rest: string, today: string, startFree: boolean): { length: number; start?: string; until?: string; untilAt?: number } {
  const bounds: { length: number; start?: string; until?: string; untilAt?: number } = { length: 0 };
  for (const kind of ['start', 'until'] as const) {
    const at = bounds.length;
    const space = /^\s+/.exec(rest.slice(at));
    if (!space) break;
    const text = rest.slice(at + space[0].length);
    let date: string | undefined, length = 0;
    const korean = new RegExp(`^(\\S.{0,29}?)\\s?${kind === 'start' ? '부터' : '까지'}(?=\\s|$)`).exec(text);
    const found = korean && dateMatchers(korean[1], today);
    if (korean && found && found.length === korean[1].length) { date = found.value; length = korean[0].length; }
    const english = !date ? new RegExp(`^${kind === 'start' ? 'starting' : 'until'}\\s+`, 'i').exec(text) : null;
    const after = english && dateMatchers(text.slice(english[0].length), today);
    if (english && after) { date = after.value; length = english[0].length + after.length; }
    if (!date || (kind === 'start' && !startFree) || (kind === 'until' && bounds.start && date < bounds.start)) continue;
    if (kind === 'start') bounds.start = date; else { bounds.until = date; bounds.untilAt = at; }
    bounds.length = at + space[0].length + length;
  }
  return bounds;
}

/** The first date on or after `today` that a rule without a date of its own falls on. */
export function firstOccurrence(rule: TodoRecurrence, today: string): string {
  const fits = (date: string) => {
    const { year, month, day } = dateParts(date);
    switch (rule.freq) {
      case 'day': return !rule.workdays || isWorkday(date);
      case 'week': return !rule.weekdays?.length || rule.weekdays.includes(weekday(date));
      case 'month':
        if (rule.nth) return nthWeekday(year, month, rule.nth.n, rule.nth.weekday) === date;
        return !rule.monthDays?.length || rule.monthDays.some(wanted => wanted === -1 ? day === daysInMonth(year, month) : Math.min(wanted, daysInMonth(year, month)) === day);
      case 'year': return !rule.yearDate || (rule.yearDate[0] === month && Math.min(rule.yearDate[1], daysInMonth(year, month)) === day);
    }
  };
  for (let offset = 0; offset < 400; offset++) { const date = addDays(today, offset); if (fits(date)) return date; }
  return today;
}

const lower = (value: string) => value.toLocaleLowerCase();
/** The longest of `names` that `rest` starts with and that ends a word. */
function longestName<T extends { name: string }>(rest: string, items: readonly T[]): T | undefined {
  const text = lower(rest);
  let best: T | undefined;
  for (const item of items) {
    const name = lower(item.name);
    if (!name || !text.startsWith(name) || (text.length > name.length && !/\s/.test(text[name.length]))) continue;
    if (!best || item.name.length > best.name.length) best = item;
  }
  return best;
}

export function parseQuickAdd(input: string, context: QuickAddContext): QuickAddResult {
  const { today, ignored } = context;
  const tokens: QuickAddToken[] = [];
  const result: QuickAddResult = { content: '', tokens, labelIds: [], newLabels: [] };
  /** The repeat's own start and where its end begins in its token (see repeatBounds). */
  let repeatStart: string | undefined, repeatUntilAt: number | undefined;
  const starts = [...input.matchAll(/(?:^|\s)(?=\S)/g)].map(match => match.index + match[0].length);
  const taken = (kind: QuickAddKind) => tokens.some(token => token.kind === kind);
  const keyOf = (kind: QuickAddKind, text: string) => `${kind}:${lower(text)}`;
  const free = (kind: QuickAddKind, text: string) => !ignored?.has(keyOf(kind, text));

  // A `/section` belongs to the `#project` typed anywhere in the line.
  let projectId: string | undefined;
  for (const start of starts) {
    if (input[start] !== '#') continue;
    const project = longestName(input.slice(start + 1), context.projects);
    if (project && free('project', `#${input.slice(start + 1, start + 1 + project.name.length)}`)) { projectId = project.id; break; }
  }
  const sectionProject = projectId ?? context.defaultProjectId;

  let cursor = 0;
  /** Text read as words to keep: a repeat turned back into text keeps its start and end as text too. */
  let skip = 0;
  for (const start of starts) {
    if (start < cursor) continue;
    const rest = input.slice(start);
    const found = readToken(rest);
    if (!found) { if (skip) { cursor = start + skip; skip = 0; } continue; }
    const text = rest.slice(0, found.length);
    tokens.push({ kind: found.kind, start, end: start + found.length, text, key: found.key ?? keyOf(found.kind, text) });
    found.apply();
    cursor = start + found.length;
  }

  function readToken(rest: string): { kind: QuickAddKind; length: number; apply: () => void; key?: string } | undefined {
    const attempt = <T>(kind: QuickAddKind, read: Read<T> | undefined, apply: (value: T) => void) =>
      read && free(kind, rest.slice(0, read.length)) ? { kind, length: read.length, apply: () => apply(read.value) } : undefined;
    const head = rest[0];
    if (head === '#' && !taken('project')) {
      const project = longestName(rest.slice(1), context.projects);
      const found = attempt('project', project && { length: project.name.length + 1, value: project.id }, id => { result.projectId = id; });
      if (found) return found;
    }
    if (head === '/' && !taken('section') && sectionProject) {
      const section = longestName(rest.slice(1), context.sections.filter(item => item.projectId === sectionProject));
      const found = attempt('section', section && { length: section.name.length + 1, value: section.id }, id => { result.sectionId = id; });
      if (found) return found;
    }
    if (head === '@') {
      const label = longestName(rest.slice(1), context.labels);
      const fresh = !label ? /^@([^\s#@%/]{1,60})(?=\s|$)/.exec(rest) : null;
      const found = label
        ? attempt('label', { length: label.name.length + 1, value: label.id }, id => { if (!result.labelIds.includes(id)) result.labelIds.push(id); })
        : attempt('label', fresh ? { length: fresh[0].length, value: fresh[1] } : undefined, name => { if (!result.newLabels.some(item => lower(item) === lower(name))) result.newLabels.push(name); });
      if (found) return found;
    }
    if (head === '{' && !taken('deadline')) {
      const close = /^\{([^{}]{1,40})\}(?=\s|$)/.exec(rest);
      const date = close ? dateMatchers(close[1].trim(), today) : undefined;
      const found = attempt('deadline', close && date && date.length === close[1].trim().length ? { length: close[0].length, value: date.value } : undefined, value => { result.deadlineDate = value; });
      if (found) return found;
    }
    if (!taken('priority')) {
      const match = /^[pP]([1-4])(?=\s|$)/.exec(rest);
      const found = attempt('priority', match ? { length: 2, value: Number(match[1]) as TodoPriority } : undefined, value => { result.priority = value; });
      if (found) return found;
    }
    if (!taken('repeat')) {
      // Its start and end belong to it: turning the repeat back into text turns them too.
      const read = repeatMatcher(rest, today);
      const found = attempt('repeat', read, value => { result.recurrence = value; });
      if (read && !found) skip = read.length + repeatBounds(rest.slice(read.length), today, true).length;
      if (read && found) {
        const bounds = repeatBounds(rest.slice(read.length), today, !taken('date'));
        return { ...found, length: read.length + bounds.length, key: keyOf('repeat', rest.slice(0, read.length)), apply: () => {
          found.apply();
          if (bounds.until) { result.recurrence = { ...result.recurrence!, until: bounds.until }; repeatUntilAt = read.length + bounds.untilAt!; }
          repeatStart = bounds.start;
        } };
      }
    }
    // A repeat's start is its date.
    if (!taken('date') && !repeatStart) { const found = attempt('date', dateMatchers(rest, today), value => { result.dueDate = value; }); if (found) return found; }
    if (!taken('time')) { const found = attempt('time', timeMatcher(rest, today), value => { result.dueTime = value; }); if (found) return found; }
    if (!taken('duration')) { const found = attempt('duration', durationMatcher(rest, today), value => { result.durationMin = value; }); if (found) return found; }
    return undefined;
  }

  if (result.projectId === undefined && result.sectionId) result.projectId = sectionProject;
  // A time or a repeat needs a date: today, or the repeat's first date (from its start, when it has one).
  if (!result.dueDate && result.recurrence) result.dueDate = firstOccurrence(result.recurrence, repeatStart ?? today);
  // A repeat that would end before its first date keeps going, and its end stays text.
  if (result.recurrence?.until && result.dueDate && result.recurrence.until < result.dueDate) {
    const { until: _, ...rule } = result.recurrence;
    result.recurrence = rule;
    const token = tokens.find(item => item.kind === 'repeat')!;
    token.end = token.start + repeatUntilAt!;
    token.text = input.slice(token.start, token.end);
  }
  if (!result.dueDate && result.dueTime) result.dueDate = today;
  let content = '', last = 0;
  for (const token of tokens) { content += `${input.slice(last, token.start)} `; last = token.end; }
  result.content = (content + input.slice(last)).replace(/\s+/g, ' ').trim();
  return result;
}
