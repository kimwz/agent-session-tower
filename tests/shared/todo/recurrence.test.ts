import test from 'node:test';
import assert from 'node:assert/strict';
import { addMonths, nthWeekday, validDate, weekday } from '../../../shared/todo/dates.js';
import { anchoredRecurrence, futureOccurrences, nextOccurrence } from '../../../shared/todo/recurrence.js';
import { keyBetween, spreadKeys, validSortKey } from '../../../shared/todo/sort-key.js';
import type { TodoRecurrence } from '../../../shared/todo/types.js';

const next = (rule: TodoRecurrence, due: string, today: string) => nextOccurrence(anchoredRecurrence(rule, due), due, today);

test('dates are checked and stepped as plain calendar days', () => {
  assert.equal(validDate('2028-02-29'), true);
  assert.equal(validDate('2027-02-29'), false);
  assert.equal(validDate('2026-13-01'), false);
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2027-12-15', 2), '2028-02-15');
  assert.equal(weekday('2026-10-17'), 6);
  assert.equal(nthWeekday(2026, 10, 2, 1), '2026-10-12');
  assert.equal(nthWeekday(2026, 10, -1, 5), '2026-10-30');
  assert.equal(nthWeekday(2026, 2, 5, 1), undefined);
});

test('a repeating date moves to the next occurrence after both its date and today, skipping missed ones', () => {
  const daily: TodoRecurrence = { freq: 'day', interval: 1 };
  assert.equal(next(daily, '2026-10-17', '2026-10-17'), '2026-10-18');
  // Done three days late: the missed days are skipped.
  assert.equal(next(daily, '2026-10-14', '2026-10-17'), '2026-10-18');
  // Done early: the date after the planned one.
  assert.equal(next(daily, '2026-10-20', '2026-10-17'), '2026-10-21');
  assert.equal(next({ freq: 'day', interval: 3 }, '2026-10-01', '2026-10-17'), '2026-10-19');
  // Friday → Monday, counting workdays.
  assert.equal(next({ freq: 'day', interval: 1, workdays: true }, '2026-10-16', '2026-10-16'), '2026-10-19');
  assert.equal(next({ freq: 'day', interval: 3, workdays: true }, '2026-10-16', '2026-10-16'), '2026-10-21');
});

test('weekly rules keep their weekdays and interval', () => {
  // Every Monday and Wednesday, from a Monday.
  const rule: TodoRecurrence = { freq: 'week', interval: 1, weekdays: [1, 3] };
  assert.equal(next(rule, '2026-10-12', '2026-10-12'), '2026-10-14');
  assert.equal(next(rule, '2026-10-14', '2026-10-14'), '2026-10-19');
  // Every other Friday, filled in from the date.
  const biweekly = anchoredRecurrence({ freq: 'week', interval: 2 }, '2026-10-16');
  assert.deepEqual(biweekly.weekdays, [5]);
  assert.equal(nextOccurrence(biweekly, '2026-10-16', '2026-10-16'), '2026-10-30');
  // Missed two cycles: still on the same fortnightly beat.
  assert.equal(nextOccurrence(biweekly, '2026-10-16', '2026-11-20'), '2026-11-27');
});

test('monthly and yearly rules keep their day instead of drifting', () => {
  const monthly = anchoredRecurrence({ freq: 'month', interval: 1 }, '2026-01-31');
  assert.deepEqual(monthly.monthDays, [31]);
  assert.equal(nextOccurrence(monthly, '2026-01-31', '2026-01-31'), '2026-02-28');
  // After the short month it goes back to the 31st.
  assert.equal(nextOccurrence(monthly, '2026-02-28', '2026-02-28'), '2026-03-31');
  assert.equal(next({ freq: 'month', interval: 1, monthDays: [-1] }, '2026-04-30', '2026-04-30'), '2026-05-31');
  assert.equal(next({ freq: 'month', interval: 1, monthDays: [1, 15] }, '2026-10-01', '2026-10-01'), '2026-10-15');
  // Second Monday of the month.
  assert.equal(next({ freq: 'month', interval: 1, nth: { n: 2, weekday: 1 } }, '2026-10-12', '2026-10-12'), '2026-11-09');
  const leap = anchoredRecurrence({ freq: 'year', interval: 1 }, '2028-02-29');
  assert.equal(nextOccurrence(leap, '2028-02-29', '2028-02-29'), '2029-02-28');
  assert.equal(nextOccurrence(leap, '2031-02-28', '2031-02-28'), '2032-02-29');
});

test('counting from completion and ending rules', () => {
  assert.equal(next({ freq: 'day', interval: 3, fromCompletion: true }, '2026-10-01', '2026-10-17'), '2026-10-20');
  assert.equal(next({ freq: 'month', interval: 1, fromCompletion: true }, '2026-10-01', '2026-10-31'), '2026-11-30');
  assert.equal(next({ freq: 'day', interval: 1, until: '2026-10-18' }, '2026-10-18', '2026-10-18'), null);
  assert.deepEqual(futureOccurrences(anchoredRecurrence({ freq: 'week', interval: 1 }, '2026-10-16'), '2026-10-16', '2026-11-06'), ['2026-10-23', '2026-10-30', '2026-11-06']);
  assert.deepEqual(futureOccurrences({ freq: 'day', interval: 1, until: '2026-10-19' }, '2026-10-17', '2026-12-31'), ['2026-10-18', '2026-10-19']);
  // A rule that finds no date before it ends stops instead of searching on.
  assert.equal(next({ freq: 'month', interval: 48, nth: { n: 5, weekday: 1 }, until: '2027-02-01' }, '2026-02-01', '2026-02-01'), null);
  assert.equal(next({ freq: 'month', interval: 48, nth: { n: 5, weekday: 1 } }, '2026-02-01', '2026-02-01') !== undefined, true);
  // Nothing goes past the last date a task can have.
  assert.equal(next({ freq: 'day', interval: 1 }, '9999-12-31', '9999-12-31'), null);
  assert.equal(next({ freq: 'day', interval: 1, workdays: true }, '9999-12-31', '9999-12-31'), null);
  assert.equal(next({ freq: 'year', interval: 1 }, '9999-06-01', '9999-06-01'), null);
  // Done before its date, a rule counting from completion still moves past that date.
  assert.equal(next({ freq: 'day', interval: 3, fromCompletion: true }, '2026-10-20', '2026-10-17'), '2026-10-23');
});

test('order keys always fit between two others and sort as strings', () => {
  const first = keyBetween(null, null);
  const keys = [first];
  // Inserting again and again at the same place keeps working.
  let low = first, high = keyBetween(first, null);
  keys.push(high);
  for (let index = 0; index < 200; index++) { const key = keyBetween(low, high); assert.ok(low < key && key < high); keys.push(key); high = key; }
  for (let index = 0; index < 50; index++) { const key = keyBetween(null, keys.sort()[0]); keys.push(key); }
  assert.ok(keys.every(validSortKey));
  // Adding at the end steps a digit: a thousand appends stay short.
  let last = keyBetween(null, null);
  for (let index = 0; index < 1000; index++) { const key = keyBetween(last, null); assert.ok(key > last); last = key; }
  assert.ok(last.length <= 20, last);
  const spread = spreadKeys(5000);
  assert.ok(spread.every((key, index) => validSortKey(key) && (index === 0 || spread[index - 1] < key)));
  assert.equal(new Set(keys).size, keys.length);
  assert.throws(() => keyBetween('b', 'a'));
});
