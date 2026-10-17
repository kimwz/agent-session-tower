import test from 'node:test';
import assert from 'node:assert/strict';
import { cellEntries, dayEntries, occurrencesIn, resizeCommit, gridDays, HOUR_HEIGHT, minutesToY, monthWeeks, overflow, placeBlocks, resizeMinutes, shiftAnchor, slotAt, spanOf, visibleRange, yToMinutes } from '../../../client/src/todo/calendar/calendar-layout.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CalendarView, dropPatch, periodTitle } from '../../../client/src/todo/calendar/CalendarView.js';
import { worldFromOverview } from '../../../client/src/todo/todo-model.js';
import { overview, task } from './fixtures.js';

test('a month shows whole Monday weeks around it', () => {
  const weeks = monthWeeks('2026-10-17');
  assert.equal(weeks.length, 5);
  assert.deepEqual([weeks[0][0], weeks[4][6]], ['2026-09-28', '2026-11-01']);
  // February 2027 starts on a Monday and fills four weeks exactly.
  assert.deepEqual(monthWeeks('2027-02-10').map(week => week[0]), ['2027-02-01', '2027-02-08', '2027-02-15', '2027-02-22']);
  assert.deepEqual(visibleRange('2026-10-17', 'month', 7), { from: '2026-09-28', to: '2026-11-01' });
});

test('a week starts on Monday, a phone grid on the day itself, and paging moves by its size', () => {
  assert.deepEqual(gridDays('2026-10-17', 7), ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']);
  assert.deepEqual(gridDays('2026-10-17', 3), ['2026-10-17', '2026-10-18', '2026-10-19']);
  assert.equal(shiftAnchor('2026-10-17', 'week', 7, 1), '2026-10-24');
  assert.equal(shiftAnchor('2026-10-17', 'week', 3, -1), '2026-10-14');
  assert.equal(shiftAnchor('2026-10-31', 'month', 7, 1), '2026-11-01');
  assert.deepEqual(visibleRange('2026-10-17', 'week', 3), { from: '2026-10-17', to: '2026-10-19' });
});

test('times and grid positions convert both ways, snapped and kept inside the day', () => {
  assert.equal(minutesToY(8 * 60), 8 * HOUR_HEIGHT);
  assert.equal(yToMinutes(minutesToY(9 * 60 + 20)), 9 * 60 + 15);
  assert.equal(yToMinutes(-40), 0);
  // An hour-long block cannot start after 23:00.
  assert.equal(yToMinutes(minutesToY(23 * 60 + 50), 60), 23 * 60);
  assert.equal(slotAt(minutesToY(10 * 60 + 29)), 10 * 60);
  assert.equal(slotAt(minutesToY(24 * 60)), 23 * 60 + 30);
  assert.equal(resizeMinutes(600, minutesToY(11 * 60 + 40)), 105);
  assert.equal(resizeMinutes(600, minutesToY(9 * 60)), 15);
  assert.equal(resizeMinutes(23 * 60, minutesToY(26 * 60)), 60);
  // The latest start near midnight stays on the quarter hour.
  assert.equal(yToMinutes(minutesToY(23 * 60 + 45), 37), 23 * 60 + 15);
  assert.equal(yToMinutes(minutesToY(23 * 60 + 45), 0), 23 * 60 + 45);
});

test('overlapping blocks share the width; separate clusters each use the full width', () => {
  const placed = placeBlocks([
    { id: 'a', start: 540, end: 600 }, { id: 'b', start: 570, end: 630 }, { id: 'c', start: 600, end: 660 },
    { id: 'd', start: 720, end: 750 },
  ]);
  const by = Object.fromEntries(placed.map(item => [item.id, [item.column, item.columns]]));
  assert.deepEqual(by, { a: [0, 2], b: [1, 2], c: [0, 2], d: [0, 1] });
});

test('days hold all-day and timed tasks by time, deadlines apart, and future repeats when asked', () => {
  const tasks = [
    task('late', { dueDate: '2026-10-14', dueTime: '15:00', durationMin: 90 }),
    task('early', { dueDate: '2026-10-14', dueTime: '09:00' }),
    task('allday', { dueDate: '2026-10-14', deadlineDate: '2026-10-16' }),
    task('weekly', { dueDate: '2026-10-12', recurrence: { freq: 'week', interval: 1, weekdays: [1] } }),
  ];
  const days = dayEntries(tasks, '2026-10-12', '2026-10-31', { future: true });
  assert.deepEqual(cellEntries(days.get('2026-10-14')).map(entry => entry.task.id), ['allday', 'early', 'late']);
  assert.deepEqual(days.get('2026-10-16')?.deadlines.map(entry => [entry.kind, entry.task.id]), [['deadline', 'allday']]);
  assert.deepEqual(['2026-10-12', '2026-10-19', '2026-10-26'].map(date => days.get(date)?.allDay.map(entry => entry.kind)), [['task'], ['future'], ['future']]);
  assert.equal(dayEntries(tasks, '2026-10-12', '2026-10-31', { future: false }).get('2026-10-19'), undefined);
  assert.deepEqual(spanOf(tasks[0]), { start: 900, end: 990 });
  assert.deepEqual(spanOf(tasks[1]), { start: 540, end: 570 });
});

test('a full cell keeps a line for +n', () => {
  assert.deepEqual(overflow(3, 3), { shown: 3, more: 0 });
  assert.deepEqual(overflow(5, 3), { shown: 2, more: 3 });
});

test('a drop sets the day, clears the time in the all-day row, and gives a slot its time and half an hour', () => {
  const allDay = task('a', { dueDate: '2026-10-14' });
  const timed = task('t', { dueDate: '2026-10-14', dueTime: '09:00', durationMin: 90 });
  assert.deepEqual(dropPatch(allDay, { kind: 'day', date: '2026-10-15' }), { dueDate: '2026-10-15' });
  assert.equal(dropPatch(allDay, { kind: 'day', date: '2026-10-14' }), null);
  assert.deepEqual(dropPatch(timed, { kind: 'allday', date: '2026-10-14' }), { dueDate: '2026-10-14', dueTime: null });
  assert.deepEqual(dropPatch(allDay, { kind: 'time', date: '2026-10-16' }, 600), { dueDate: '2026-10-16', dueTime: '10:00', durationMin: 30 });
  assert.deepEqual(dropPatch(timed, { kind: 'time', date: '2026-10-14' }, 615), { dueDate: '2026-10-14', dueTime: '10:15' });
  // An all-day task with a duration still takes half an hour in a slot.
  assert.deepEqual(dropPatch({ ...allDay, durationMin: 90 }, { kind: 'time', date: '2026-10-14' }, 600), { dueDate: '2026-10-14', dueTime: '10:00', durationMin: 30 });
  assert.equal(dropPatch(timed, { kind: 'time', date: '2026-10-14' }, 540), null);
});

test('the calendar draws a month with +n and faded repeats, and a week with blocks sized by duration', () => {
  const world = worldFromOverview(overview([]));
  const tasks = [
    ...['a', 'b', 'c', 'd', 'e'].map(id => task(id, { dueDate: '2026-10-14', content: `일 ${id}` })),
    task('w', { dueDate: '2026-10-13', dueTime: '09:30', durationMin: 90, content: '회의', recurrence: { freq: 'week', interval: 1, weekdays: [2] } }),
  ];
  const base = { tasks, world, today: '2026-10-14', future: true, colorBy: 'priority' as const, mobile: false, readOnly: false, onMode() {}, onOpen() {}, onAdd() {}, onChange() {} };
  const month = renderToStaticMarkup(createElement(CalendarView, { ...base, mode: 'month' }));
  assert.match(month, /2026년 10월/);
  assert.match(month, />\+2개</);
  assert.equal((month.match(/todo-cal-entry future/g) ?? []).length, 2);
  const week = renderToStaticMarkup(createElement(CalendarView, { ...base, mode: 'week' }));
  assert.match(week, /10월 12일 – 18일/);
  assert.equal(periodTitle('2026-10-29', '2026-10-31'), '10월 29일 – 31일');
  assert.equal(periodTitle('2026-10-30', '2026-11-01'), '10월 30일 – 11월 1일');
  assert.match(week, new RegExp(`class="todo-cal-block task[^"]*" style="[^"]*top:${minutesToY(570)}px;height:${minutesToY(90) - 2}px`));
  assert.match(week, /09:30–11:00/);
});

test('a resize saves only after the edge moved, never on cancel, and not when it comes back', () => {
  // 23:30 with 90 minutes shows clipped to 30; a press alone must not save that.
  assert.equal(resizeCommit(90, null, false), null);
  assert.equal(resizeCommit(90, 45, true), null);
  assert.equal(resizeCommit(90, 90, false), null);
  assert.equal(resizeCommit(90, 45, false), 45);
});

test('repeats long before the range still show in it', () => {
  assert.deepEqual(occurrencesIn({ freq: 'day', interval: 1 }, '2026-01-01', '2026-10-12', '2026-10-14'), ['2026-10-12', '2026-10-13', '2026-10-14']);
  assert.deepEqual(occurrencesIn({ freq: 'week', interval: 1, weekdays: [3] }, '2026-10-14', '2026-10-12', '2026-10-28'), ['2026-10-21', '2026-10-28']);
  assert.deepEqual(occurrencesIn({ freq: 'day', interval: 1, until: '2026-03-01' }, '2026-01-01', '2026-10-12', '2026-10-14'), []);
  const days = dayEntries([task('d', { dueDate: '2026-01-01', recurrence: { freq: 'day', interval: 1 } })], '2026-10-12', '2026-10-18', { future: true });
  assert.equal([...days.values()].flatMap(day => day.allDay).filter(entry => entry.kind === 'future').length, 7);
});

test('a later occurrence is drawn without a way to open or move it', () => {
  const world = worldFromOverview(overview([]));
  const tasks = [task('w', { dueDate: '2026-10-13', dueTime: '09:30', content: '회의', recurrence: { freq: 'day', interval: 1 } })];
  const base = { tasks, world, today: '2026-10-14', future: true, colorBy: 'priority' as const, mobile: false, readOnly: false, onMode() {}, onOpen() {}, onAdd() {}, onChange() {} };
  for (const mode of ['month', 'week'] as const) {
    const markup = renderToStaticMarkup(createElement(CalendarView, { ...base, mode }));
    const future = markup.match(/<(\w+)[^>]*class="todo-cal-(?:entry|block) future[^"]*"[^>]*>/g) ?? [];
    assert.ok(future.length > 0);
    for (const tag of future) assert.doesNotMatch(tag, /^<button|role="button"|tabindex|aria-roledescription/);
  }
});
