import test from 'node:test';
import assert from 'node:assert/strict';
import { firstOccurrence, parseQuickAdd, type QuickAddContext } from '../../../shared/todo/quick-add.js';

// Wednesday.
const today = '2026-10-14';
const context: QuickAddContext = {
  today,
  projects: [{ id: 'inbox', name: 'Inbox' }, { id: 'tower', name: '타워' }, { id: 'home', name: 'Home Repair' }],
  sections: [{ id: 'design', projectId: 'tower', name: '디자인' }, { id: 'ops', projectId: 'tower', name: '운영 작업' }, { id: 'garden', projectId: 'home', name: 'Garden' }],
  labels: [{ id: 'urgent', name: '급함' }, { id: 'call', name: 'call' }],
};
const parse = (text: string, extra: Partial<QuickAddContext> = {}) => parseQuickAdd(text, { ...context, ...extra });

test('project, section, labels, priority and deadline words set their properties and leave the title', () => {
  const result = parse('견적 회신 #타워 /운영 작업 @급함 @call p1 {10/20}');
  assert.equal(result.content, '견적 회신');
  assert.equal(result.projectId, 'tower');
  assert.equal(result.sectionId, 'ops');
  assert.deepEqual(result.labelIds, ['urgent', 'call']);
  assert.equal(result.priority, 1);
  assert.equal(result.deadlineDate, '2026-10-20');
  assert.deepEqual(result.tokens.map(token => token.kind), ['project', 'section', 'label', 'label', 'priority', 'deadline']);
});

test('names with spaces match the longest known name, a section follows the project typed anywhere, and unknown labels are new', () => {
  const result = parse('/Garden 물주기 #Home Repair @새라벨');
  assert.equal(result.projectId, 'home');
  assert.equal(result.sectionId, 'garden');
  assert.deepEqual(result.newLabels, ['새라벨']);
  assert.equal(result.content, '물주기');
  // An unknown project or a section of another project stays text.
  const plain = parse('#없음 /디자인 확인', { defaultProjectId: 'inbox' });
  assert.equal(plain.projectId, undefined);
  assert.equal(plain.sectionId, undefined);
  assert.equal(plain.content, '#없음 /디자인 확인');
  assert.equal(parse('/디자인 확인', { defaultProjectId: 'tower' }).sectionId, 'design');
});

test('Korean dates', () => {
  const due = (text: string) => parse(`일 ${text}`).dueDate;
  assert.equal(due('오늘'), '2026-10-14');
  assert.equal(due('내일'), '2026-10-15');
  assert.equal(due('모레'), '2026-10-16');
  assert.equal(due('이번 주말'), '2026-10-17');
  assert.equal(due('다음 주'), '2026-10-19');
  assert.equal(due('다음주 금요일'), '2026-10-23');
  assert.equal(due('이번 주 금요일'), '2026-10-16');
  assert.equal(due('월요일'), '2026-10-19');
  // The same weekday as today means next week's.
  assert.equal(due('수요일'), '2026-10-21');
  assert.equal(due('10/20'), '2026-10-20');
  assert.equal(due('10월 20일'), '2026-10-20');
  // A date already passed this year is next year's.
  assert.equal(due('3/1'), '2027-03-01');
  assert.equal(due('20일'), '2026-10-20');
  assert.equal(due('5일'), '2026-11-05');
  assert.equal(due('3일 후'), '2026-10-17');
  assert.equal(due('2027-01-02'), '2027-01-02');
  assert.equal(due('2/30'), undefined);
});

test('English dates', () => {
  const due = (text: string) => parse(`task ${text}`).dueDate;
  assert.equal(due('today'), '2026-10-14');
  assert.equal(due('tomorrow'), '2026-10-15');
  assert.equal(due('this weekend'), '2026-10-17');
  assert.equal(due('next week'), '2026-10-19');
  assert.equal(due('next fri'), '2026-10-23');
  assert.equal(due('friday'), '2026-10-16');
  assert.equal(due('on mon'), '2026-10-19');
  assert.equal(due('oct 20'), '2026-10-20');
  assert.equal(due('20 October'), '2026-10-20');
  assert.equal(due('in 3 days'), '2026-10-17');
  // Short weekday names alone stay words.
  assert.equal(parse('buy sun cream').dueDate, undefined);
  assert.equal(parse('buy sun cream').content, 'buy sun cream');
});

test('times, durations and a time alone meaning today', () => {
  assert.deepEqual(pick(parse('회의 내일 오후 3시 1시간')), { content: '회의', dueDate: '2026-10-15', dueTime: '15:00', durationMin: 60 });
  assert.deepEqual(pick(parse('회의 오전 9시 30분 30분')), { content: '회의', dueDate: today, dueTime: '09:30', durationMin: 30 });
  assert.equal(parse('회의 오후 12시').dueTime, '12:00');
  assert.equal(parse('회의 오전 12시').dueTime, '00:00');
  assert.equal(parse('회의 15:00').dueTime, '15:00');
  assert.equal(parse('회의 9시 반').dueTime, '09:30');
  assert.equal(parse('call at 3pm for 90 min').dueTime, '15:00');
  assert.equal(parse('call at 3pm for 90 min').durationMin, 90);
  assert.equal(parse('call 3:30 pm 1h30m').dueTime, '15:30');
  assert.equal(parse('call 3:30 pm 1h30m').durationMin, 90);
  assert.equal(parse('call 1시간 30분').durationMin, 90);
  assert.equal(parse('회의 25시').dueTime, undefined);
  // `2 a` is not a time.
  assert.equal(parse('buy 2 a day').dueTime, undefined);
});

test('repeats, with the first date found when none is typed', () => {
  const rule = (text: string) => { const result = parse(`일 ${text}`); return { recurrence: result.recurrence, dueDate: result.dueDate }; };
  assert.deepEqual(rule('매일'), { recurrence: { freq: 'day', interval: 1 }, dueDate: today });
  assert.deepEqual(rule('평일'), { recurrence: { freq: 'day', interval: 1, workdays: true }, dueDate: today });
  assert.deepEqual(rule('매주 월,수'), { recurrence: { freq: 'week', interval: 1, weekdays: [1, 3] }, dueDate: today });
  assert.deepEqual(rule('매주 월요일과 금요일'), { recurrence: { freq: 'week', interval: 1, weekdays: [1, 5] }, dueDate: '2026-10-16' });
  assert.deepEqual(rule('매주 월수'), { recurrence: { freq: 'week', interval: 1, weekdays: [1, 3] }, dueDate: today });
  assert.deepEqual(rule('격주 금'), { recurrence: { freq: 'week', interval: 2, weekdays: [5] }, dueDate: '2026-10-16' });
  assert.deepEqual(rule('매월 15일'), { recurrence: { freq: 'month', interval: 1, monthDays: [15] }, dueDate: '2026-10-15' });
  assert.deepEqual(rule('매월 말일'), { recurrence: { freq: 'month', interval: 1, monthDays: [-1] }, dueDate: '2026-10-31' });
  assert.deepEqual(rule('매월 첫째 월요일'), { recurrence: { freq: 'month', interval: 1, nth: { n: 1, weekday: 1 } }, dueDate: '2026-11-02' });
  assert.deepEqual(rule('매년 1월 2일'), { recurrence: { freq: 'year', interval: 1, yearDate: [1, 2] }, dueDate: '2027-01-02' });
  assert.deepEqual(rule('3일마다'), { recurrence: { freq: 'day', interval: 3 }, dueDate: today });
  assert.deepEqual(rule('2주마다 내일'), { recurrence: { freq: 'week', interval: 2 }, dueDate: '2026-10-15' });
  assert.deepEqual(rule('완료 후 3일마다'), { recurrence: { freq: 'day', interval: 3, fromCompletion: true }, dueDate: today });
  assert.deepEqual(rule('every mon, wed'), { recurrence: { freq: 'week', interval: 1, weekdays: [1, 3] }, dueDate: today });
  assert.deepEqual(rule('every weekday'), { recurrence: { freq: 'day', interval: 1, workdays: true }, dueDate: today });
  assert.deepEqual(rule('every 15th'), { recurrence: { freq: 'month', interval: 1, monthDays: [15] }, dueDate: '2026-10-15' });
  assert.deepEqual(rule('every last fri'), { recurrence: { freq: 'month', interval: 1, nth: { n: -1, weekday: 5 } }, dueDate: '2026-10-30' });
  assert.deepEqual(rule('every 3 weeks'), { recurrence: { freq: 'week', interval: 3 }, dueDate: today });
  assert.deepEqual(rule('every! 2 days'), { recurrence: { freq: 'day', interval: 2, fromCompletion: true }, dueDate: today });
  assert.deepEqual(rule('yearly'), { recurrence: { freq: 'year', interval: 1 }, dueDate: today });
  assert.equal(parse('일 매주 월 수업').content, '일 수업');
});

test('a repeat may say when it starts and ends, both part of its word', () => {
  const read = (text: string) => { const result = parse(text); return { content: result.content, dueDate: result.dueDate, recurrence: result.recurrence, repeat: result.tokens.find(token => token.kind === 'repeat')?.text }; };
  // The first date is the first occurrence on or after the start (Tuesday the 20th: the Monday after).
  assert.deepEqual(read('회의 매주 월 10월 20일부터'), { content: '회의', dueDate: '2026-10-26', recurrence: { freq: 'week', interval: 1, weekdays: [1] }, repeat: '매주 월 10월 20일부터' });
  assert.deepEqual(read('standup every mon starting oct 20 until dec 31'),
    { content: 'standup', dueDate: '2026-10-26', recurrence: { freq: 'week', interval: 1, weekdays: [1], until: '2026-12-31' }, repeat: 'every mon starting oct 20 until dec 31' });
  assert.deepEqual(read('물 매일 12월 31일까지'), { content: '물', dueDate: today, recurrence: { freq: 'day', interval: 1, until: '2026-12-31' }, repeat: '매일 12월 31일까지' });
  // Starting and ending on one day.
  assert.deepEqual(read('행사 매일 10월 20일부터 10월 20일까지'), { content: '행사', dueDate: '2026-10-20', recurrence: { freq: 'day', interval: 1, until: '2026-10-20' }, repeat: '매일 10월 20일부터 10월 20일까지' });
  // The first Monday after the start is after the end: the repeat keeps going and its end stays text.
  assert.deepEqual(read('회의 매주 월 10월 20일부터 10월 25일까지'),
    { content: '회의 10월 25일까지', dueDate: '2026-10-26', recurrence: { freq: 'week', interval: 1, weekdays: [1] }, repeat: '매주 월 10월 20일부터' });
  // A month's last day, and every other week.
  assert.deepEqual(read('정산 매월 말일 11월 1일부터').dueDate, '2026-11-30');
  assert.deepEqual(read('정산 every 31st starting nov 1').dueDate, '2026-11-30');
  assert.deepEqual(read('청소 격주 금 10월 20일부터 12월 1일까지'),
    { content: '청소', dueDate: '2026-10-23', recurrence: { freq: 'week', interval: 2, weekdays: [5], until: '2026-12-01' }, repeat: '격주 금 10월 20일부터 12월 1일까지' });
  assert.equal(read('운동 every 2 weeks starting oct 20').dueDate, '2026-10-20');
  // An end before the start, or a start with a date of its own typed, stays text.
  assert.equal(read('회의 매일 10월 20일부터 10월 18일까지').content, '회의 10월 18일까지');
  assert.deepEqual(read('내일 회의 매주 월 10월 20일부터'), { content: '회의 10월 20일부터', dueDate: '2026-10-15', recurrence: { freq: 'week', interval: 1, weekdays: [1] }, repeat: '매주 월' });
  // Turning the repeat back into text turns its start and end with it.
  const first = parse('회의 매주 월 10월 20일부터 12월 31일까지');
  const repeat = first.tokens.find(token => token.kind === 'repeat')!;
  assert.equal(repeat.key, 'repeat:매주 월');
  const kept = parse('회의 매주 월 10월 20일부터 12월 31일까지', { ignored: new Set([repeat.key]) });
  assert.equal(kept.recurrence, undefined);
  assert.equal(kept.content, '회의 매주 월 10월 20일부터 12월 31일까지');
  // In English too: the start's date is not read again as the task's date.
  const english = parse('standup every mon starting oct 20 until dec 31');
  const keptEnglish = parse('standup every mon starting oct 20 until dec 31', { ignored: new Set([english.tokens.find(token => token.kind === 'repeat')!.key]) });
  assert.deepEqual([keptEnglish.recurrence, keptEnglish.dueDate, keptEnglish.content], [undefined, undefined, 'standup every mon starting oct 20 until dec 31']);
  // What follows it is still read.
  const chores = parse('청소 3일마다 p1');
  const keptChores = parse('청소 3일마다 p1', { ignored: new Set([chores.tokens.find(token => token.kind === 'repeat')!.key]) });
  assert.deepEqual([keptChores.recurrence, keptChores.priority, keptChores.content], [undefined, 1, '청소 3일마다']);
});

test('only standalone words count, only the first of a kind counts, and the rest stays text', () => {
  assert.equal(parse('내일까지 보고서').dueDate, undefined);
  assert.equal(parse('p5 검토').priority, undefined);
  const twice = parse('오늘 아니면 내일 p2 p3');
  assert.equal(twice.dueDate, today);
  assert.equal(twice.priority, 2);
  assert.equal(twice.content, '아니면 내일 p3');
});

test('a recognized word turned back into text is kept in the title and leaves the property unset', () => {
  const first = parse('오늘 회고 p1');
  const date = first.tokens.find(token => token.kind === 'date')!;
  assert.equal(date.key, 'date:오늘');
  const kept = parse('오늘 회고 p1', { ignored: new Set([date.key]) });
  assert.equal(kept.dueDate, undefined);
  assert.equal(kept.priority, 1);
  assert.equal(kept.content, '오늘 회고');
  assert.deepEqual(kept.tokens.map(token => [token.kind, token.start, token.end]), [['priority', 6, 8]]);
});

test('token offsets point at the typed words', () => {
  const text = '리뷰 내일 오후 3시 #타워';
  const result = parse(text);
  assert.deepEqual(result.tokens.map(token => text.slice(token.start, token.end)), ['내일', '오후 3시', '#타워']);
});

test('the first date of a rule is on or after today', () => {
  assert.equal(firstOccurrence({ freq: 'day', interval: 1, workdays: true }, '2026-10-17'), '2026-10-19');
  assert.equal(firstOccurrence({ freq: 'month', interval: 1, monthDays: [31] }, '2026-11-02'), '2026-11-30');
  assert.equal(firstOccurrence({ freq: 'year', interval: 1, yearDate: [2, 29] }, '2026-10-14'), '2027-02-28');
});

function pick(result: ReturnType<typeof parse>) {
  return { content: result.content, dueDate: result.dueDate, dueTime: result.dueTime, durationMin: result.durationMin };
}

test('a date that does not exist stays text instead of becoming another day', () => {
  for (const text of ['회의 13/1', '회의 10월 0일', '회의 0일', '회의 2/30']) {
    const result = parse(text);
    assert.equal(result.dueDate, undefined, text);
    assert.equal(result.content, text, text);
  }
});
