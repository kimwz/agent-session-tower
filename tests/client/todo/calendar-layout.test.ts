import test from 'node:test';
import assert from 'node:assert/strict';
import { cellEntries, dotRows, dotsPerLine, moreSlots, dayEntries, dayStart, doneDays, doneRange, occurrencesIn, resizeCommit, gridDays, HOUR_HEIGHT, minutesToY, monthWeeks, overflow, placeBlocks, resizeMinutes, shiftAnchor, slotAt, spanOf, visibleRange, WEEK_DAYS, weekStartOf, yToMinutes } from '../../../client/src/todo/calendar/calendar-layout.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CalendarView, doneDotColor, dropPatch, periodTitle } from '../../../client/src/todo/calendar/CalendarView.js';
import { worldFromOverview } from '../../../client/src/todo/todo-model.js';
import { overview, project, task } from './fixtures.js';
import { colorOf, weekdayName } from '../../../client/src/todo/todo-format.js';
import { MonthGrid } from '../../../client/src/todo/DatePicker.js';

test('weeks start on Sunday: 일 월 화 수 목 금 토', () => {
  assert.deepEqual(WEEK_DAYS, [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(WEEK_DAYS.map(weekdayName).join(''), '일월화수목금토');
  assert.equal(weekStartOf('2026-10-11'), '2026-10-11');
  assert.equal(weekStartOf('2026-10-17'), '2026-10-11');
  assert.equal(weekStartOf('2026-11-01'), '2026-11-01');
});

test('a month shows whole Sunday weeks around it', () => {
  const weeks = monthWeeks('2026-10-17');
  assert.equal(weeks.length, 5);
  assert.deepEqual([weeks[0][0], weeks[4][6]], ['2026-09-27', '2026-10-31']);
  // February 2026 starts on a Sunday and fills four weeks exactly.
  assert.deepEqual(monthWeeks('2026-02-10').map(week => week[0]), ['2026-02-01', '2026-02-08', '2026-02-15', '2026-02-22']);
  // November 2026 starts on a Sunday too, and runs a day into a fifth week.
  assert.deepEqual(monthWeeks('2026-11-30').map(week => week[0]), ['2026-11-01', '2026-11-08', '2026-11-15', '2026-11-22', '2026-11-29']);
  assert.deepEqual(visibleRange('2026-10-17', 'month', 7), { from: '2026-09-27', to: '2026-10-31' });
});

test('a week starts on Sunday, a phone grid on the day itself, and paging moves by its size', () => {
  assert.deepEqual(gridDays('2026-10-17', 7), ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17']);
  assert.deepEqual(gridDays('2026-10-18', 7)[0], '2026-10-18');
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

test('a dragged deadline takes the day it is dropped on and nothing else, wherever on that day it lands', () => {
  const timed = task('t', { dueDate: '2026-10-14', dueTime: '09:00', durationMin: 90, deadlineDate: '2026-10-16' });
  for (const kind of ['day', 'allday', 'time'] as const) {
    assert.deepEqual(dropPatch(timed, { kind, date: '2026-10-20' }, 600, 'deadline'), { deadlineDate: '2026-10-20' }, kind);
    assert.equal(dropPatch(timed, { kind, date: '2026-10-16' }, 600, 'deadline'), null, `${kind}: its own day`);
  }
  // The task's own date, time and length are the due drag's, which is unchanged.
  assert.deepEqual(dropPatch(timed, { kind: 'day', date: '2026-10-20' }), { dueDate: '2026-10-20' });
});

test('deadlines can be dragged wherever dated tasks can, and nothing can when read-only', () => {
  const world = worldFromOverview(overview([]));
  const tasks = [task('a', { dueDate: '2026-10-14', deadlineDate: '2026-10-16', content: '보고서' })];
  const base = { tasks, world, today: '2026-10-14', future: false, colorBy: 'priority' as const, mobile: false, onMode() {}, onOpen() {}, onAdd() {}, onChange() {} };
  // A disabled draggable says so.
  const deadline = (markup: string) => /<button[^>]*class="todo-cal-entry deadline[^"]*"[^>]*>/.exec(markup)?.[0] ?? '';
  for (const mode of ['month', 'week'] as const) {
    const markup = renderToStaticMarkup(createElement(CalendarView, { ...base, mode, readOnly: false }));
    assert.match(deadline(markup), /aria-disabled="false"/, mode);
    assert.match(deadline(renderToStaticMarkup(createElement(CalendarView, { ...base, mode, readOnly: true }))), /aria-disabled="true"/, `${mode}, read-only`);
  }
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
  assert.deepEqual([...month.matchAll(/role="columnheader">([^<]+)</g)].map(match => match[1]).join(''), '일월화수목금토');
  assert.match(month, />\+2개</);
  assert.equal((month.match(/todo-cal-entry future/g) ?? []).length, 2);
  const week = renderToStaticMarkup(createElement(CalendarView, { ...base, mode: 'week' }));
  assert.match(week, /10월 11일 – 17일/);
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

test('repeats counted from completion keep their beat from the task’s date in every range', () => {
  const rule = { freq: 'day' as const, interval: 2, fromCompletion: true };
  assert.deepEqual(occurrencesIn(rule, '2026-01-01', '2026-10-12', '2026-10-18'), ['2026-10-12', '2026-10-14', '2026-10-16', '2026-10-18']);
  assert.deepEqual(occurrencesIn(rule, '2026-01-01', '2026-10-13', '2026-10-19'), ['2026-10-14', '2026-10-16', '2026-10-18']);
  const monthly = { freq: 'month' as const, interval: 1, fromCompletion: true };
  const wide = occurrencesIn(monthly, '2026-01-31', '2026-05-01', '2026-08-31');
  assert.deepEqual(occurrencesIn(monthly, '2026-01-31', '2026-06-01', '2026-07-31'), wide.filter(date => date >= '2026-06-01' && date <= '2026-07-31'));
});

/** Runs `run` with the process in time zone `zone`, then puts the zone back. */
function inZone(zone: string, run: () => void) {
  const saved = process.env.TZ;
  process.env.TZ = zone;
  try { run(); } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
}

test('completions fall on the local day and minute they were made, and a period runs from local midnight to the next', () => {
  inZone('Asia/Seoul', () => {
    assert.deepEqual(doneRange('2026-09-28', '2026-11-01'), { since: '2026-09-27T15:00:00.000Z', until: '2026-11-01T15:00:00.000Z' });
    const item = (id: string, completedAt: string) => ({ completion: { id, taskId: id, occurrenceDate: '2026-10-01', completedAt }, task: task(id) });
    // 23:59 in Seoul is still that day; a minute later is the next one. The occurrence date plays no part.
    const days = doneDays([item('late', '2026-10-14T14:59:00.000Z'), item('next', '2026-10-14T15:00:00.000Z'), item('early', '2026-10-14T00:30:00.000Z'), item('out', '2026-11-01T15:00:00.000Z')], '2026-10-12', '2026-11-01');
    assert.deepEqual(days.get('2026-10-14')?.map(entry => [entry.completion.id, entry.minutes]), [['early', 570], ['late', 1439]]);
    assert.deepEqual(days.get('2026-10-15')?.map(entry => [entry.completion.id, entry.minutes]), [['next', 0]]);
    assert.equal([...days.values()].flat().some(entry => entry.completion.id === 'out'), false);
    // Sub-tasks closed with their parent leave the mark to it, while it shows; one completed on its own, even at the
    // same moment, keeps its own.
    const at = '2026-10-16T01:00:00.000Z';
    const parent = item('p', at);
    const closed = { completion: { ...item('s1', at).completion, causeId: 'p' }, task: task('s1', { parentId: 'p' }) };
    const alone = { ...item('s2', at), task: task('s2', { parentId: 'p' }) };
    assert.deepEqual(doneDays([parent, closed, alone], '2026-10-12', '2026-10-18').get('2026-10-16')?.map(entry => entry.completion.id).sort(), ['p', 's2']);
    assert.deepEqual(doneDays([closed, alone], '2026-10-12', '2026-10-18').get('2026-10-16')?.map(entry => entry.completion.id).sort(), ['s1', 's2']);
  });
  // The day summer time ends has 25 hours: the period still ends at the next local midnight.
  inZone('America/New_York', () => {
    assert.equal(dayStart('2026-11-01'), '2026-11-01T04:00:00.000Z');
    assert.deepEqual(doneRange('2026-11-01', '2026-11-01'), { since: '2026-11-01T04:00:00.000Z', until: '2026-11-02T05:00:00.000Z' });
  });
});

test('completions show as dots beside a month day’s number that open their task, and at their time in the week', () => {
  const world = worldFromOverview(overview([]));
  const at = (hours: number, minutes: number) => new Date(2026, 9, 14, hours, minutes).toISOString();
  const done = [
    ...Array.from({ length: 14 }, (_, index) => ({ completion: { id: `c${index}`, taskId: `d${index}`, occurrenceDate: null, completedAt: at(9, index) }, task: task(`d${index}`, { content: `끝낸 일 ${index}`, completedAt: at(9, index) }) })),
    { completion: { id: 'w', taskId: 'r', occurrenceDate: '2026-10-13', completedAt: at(14, 5) }, task: task('r', { content: '반복', dueDate: '2026-10-15', recurrence: { freq: 'day', interval: 1 } }) },
  ];
  const base = { tasks: [], world, today: '2026-10-14', future: true, colorBy: 'priority' as const, mobile: false, readOnly: false, onMode() {}, onOpen() {}, onAdd() {}, onChange() {}, done };
  const month = renderToStaticMarkup(createElement(CalendarView, { ...base, mode: 'month' }));
  // Two lines of six (before the cell is measured) hold twelve; past that, ten dots and +5 in the last two places.
  assert.equal((month.match(/class="todo-cal-done-dot"/g) ?? []).length, 10);
  assert.match(month, /class="todo-cal-done-more"[^>]*>\+5</);
  assert.match(month, /title="09:00 완료 · 끝낸 일 0"/);
  // Beside the day's number, in the Inbox's grey.
  assert.match(month, /<div class="todo-cal-day-row"><span class="todo-cal-day">14<\/span><span class="todo-cal-done-dots"><button type="button" class="todo-cal-done-dot" style="--entry-color:#7d8aa0"/);
  const week = renderToStaticMarkup(createElement(CalendarView, { ...base, mode: 'week' }));
  assert.equal((week.match(/class="todo-cal-block done short"/g) ?? []).length, 15);
  assert.match(week, new RegExp(`class="todo-cal-block done short" style="[^"]*top:${minutesToY(14 * 60 + 5)}px`));
  // One made just before midnight stays inside the day's grid.
  const late = renderToStaticMarkup(createElement(CalendarView, { ...base, mode: 'week', done: [{ completion: { id: 'late', taskId: 'l', occurrenceDate: null, completedAt: at(23, 50) }, task: task('l') }] }));
  const style = /class="todo-cal-block done short" style="[^"]*top:([\d.]+)px;height:([\d.]+)px/.exec(late);
  assert.ok(style && Number(style[1]) + Number(style[2]) <= minutesToY(24 * 60));
  const none = renderToStaticMarkup(createElement(CalendarView, { ...base, mode: 'month', done: undefined }));
  assert.doesNotMatch(none, /todo-cal-done/);
  const phone = renderToStaticMarkup(createElement(CalendarView, { ...base, mode: 'month', mobile: true }));
  // A phone's two lines of three: three dots and +12 (whose two digits take three places), none of them buttons.
  assert.match(phone, /<span class="todo-cal-done-dots" aria-hidden="true">(<i[^>]*><\/i>){3}<b class="todo-cal-done-more">\+12<\/b><\/span>/);
  assert.match(phone, /todo-cal-entry done/);
});

test('completion dots fill two lines, and the rest give way to +n in the last places', () => {
  assert.deepEqual(dotRows(12, 6, 'desktop'), { shown: 12, more: 0 });
  assert.deepEqual(dotRows(13, 6, 'desktop'), { shown: 10, more: 3 });
  // The +n keeps as many places as its longest label needs: two on a desktop, three for a phone's +10 and up.
  assert.equal(moreSlots(25, 'desktop'), 2);
  assert.equal(moreSlots(150, 'desktop'), 3);
  assert.equal(moreSlots(8, 'mobile'), 2);
  assert.equal(moreSlots(25, 'mobile'), 3);
  assert.deepEqual(dotRows(25, 3, 'mobile'), { shown: 3, more: 22 });
  // A line shorter than the label: the +n takes the whole last line, never a third.
  assert.deepEqual(dotRows(3, 1, 'desktop'), { shown: 1, more: 2 });
  assert.deepEqual(dotRows(30, 2, 'mobile'), { shown: 2, more: 28 });
  // A line holds a dot only when it fits whole: a fraction of a pixel short is one fewer (11px dots, 1px apart).
  assert.equal(dotsPerLine(46.6, 'desktop'), 3);
  assert.equal(dotsPerLine(47, 'desktop'), 4);
  assert.equal(dotsPerLine(94.6, 'desktop'), 7);
  assert.equal(dotsPerLine(5, 'desktop'), 1);
  assert.equal(dotsPerLine(19, 'mobile'), 3);
  assert.equal(dotsPerLine(18.9, 'mobile'), 2);
});

test('a completion dot takes its project’s color, and an Inbox task’s is grey', () => {
  const world = worldFromOverview(overview([], { projects: [project('inbox', { inbox: true, color: 'red' }), project('web', { color: 'blue' }), project('ops', { color: 'green' })] }));
  assert.equal(doneDotColor(world, task('a')), '#7d8aa0');
  assert.equal(doneDotColor(world, task('b', { projectId: 'web' })), colorOf('blue'));
  assert.equal(doneDotColor(world, task('c', { projectId: 'ops' })), colorOf('green'));
  assert.notEqual(colorOf('blue'), colorOf('green'));
  assert.equal(doneDotColor(world, task('d', { projectId: 'gone' })), '#7d8aa0');
});

test('the date picker month starts its weeks on Sunday too', () => {
  const markup = renderToStaticMarkup(createElement(MonthGrid, { month: '2026-10-01', selected: null, today: '2026-10-14', onPick() {} }));
  assert.deepEqual([...markup.matchAll(/role="columnheader">([^<]+)</g)].map(match => match[1]).join(''), '일월화수목금토');
  const cells = [...markup.matchAll(/aria-label="([^"]+)"[^>]*>(\d+)<\/button>/g)].map(match => match[2]);
  // October 2026 starts on a Thursday: four days of September lead, and October 31 (a Saturday) closes the last row.
  assert.deepEqual(cells.slice(0, 5), ['27', '28', '29', '30', '1']);
  assert.equal(cells.length, 35);
  assert.equal(cells[34], '31');
});
