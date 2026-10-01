import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionTasks } from '../../../client/src/chat/SessionTasks.js';
import { stageTone, taskTimeline } from '../../../client/src/chat/session-tasks.js';
import { getLanguage, setLanguage } from '../../../client/src/i18n/i18n.js';
import type { SessionTask } from '../../../shared/types.js';

const task = (id: string, title: string, stage: string, updatedAt: string): SessionTask => ({ id, title, stage, startedAt: updatedAt, updatedAt });
const tasks = [task('a', 'Voice playback fix', '배포됨', '2026-10-01T01:00:00Z'), task('b', 'Snapshot compression', 'PR 리뷰중', '2026-10-01T03:00:00Z'),
  task('c', 'Task strip design', '설계중', '2026-10-01T02:00:00Z')];

test('the current task is the one moved on last, and the list runs newest first', () => {
  const { current, items } = taskTimeline(tasks);
  assert.equal(current?.id, 'b');
  assert.deepEqual(items.map(item => [item.id, item.current]), [['b', true], ['c', false], ['a', false]]);
  assert.deepEqual(taskTimeline(undefined), { current: undefined, items: [] });
});

test('a stage is shown in the color of its kind of work, in Korean or English', () => {
  assert.deepEqual(['배포됨', 'PR 머지됨', 'Deployed', '답변함'].map(stageTone), ['done', 'done', 'done', 'done']);
  assert.deepEqual(['PR 리뷰중', 'PR 제출함', 'In review'].map(stageTone), ['review', 'review', 'review']);
  assert.deepEqual(['구현중', '수정중', 'Fixing'].map(stageTone), ['build', 'build', 'build']);
  assert.deepEqual(['원인 분석중', '설계중', '검증중', 'Investigating'].map(stageTone), ['think', 'think', 'think', 'think']);
  assert.deepEqual(['대기중', 'Blocked'].map(stageTone), ['wait', 'wait']);
  assert.equal(stageTone('뭔가'), 'neutral');
});

test('above the message box the current task shows, and opened every task with the current one marked', () => {
  const language = getLanguage();
  setLanguage('ko');
  try {
    assert.equal(renderToStaticMarkup(createElement(SessionTasks, { tasks: [] })), '', 'nothing before the first summary');
    const folded = renderToStaticMarkup(createElement(SessionTasks, { tasks }));
    assert.match(folded, /aria-expanded="false"/);
    assert.match(folded, /session-task-stage review">PR 리뷰중</);
    assert.match(folded, /session-tasks-title">Snapshot compression</);
    assert.match(folded, /session-tasks-count[^>]*>3</);
    assert.doesNotMatch(folded, /session-tasks-list/);
    const open = renderToStaticMarkup(createElement(SessionTasks, { tasks, initiallyOpen: true }));
    assert.match(open, /aria-expanded="true"/);
    const titles = [...open.matchAll(/session-task-title">([^<]+)</g)].map(match => match[1]);
    assert.deepEqual(titles, ['Snapshot compression', 'Task strip design', 'Voice playback fix']);
    assert.equal(open.match(/session-task [a-z]+ current/g)?.length, 1);
    assert.ok(open.indexOf('session-tasks-list') < open.indexOf('session-tasks-line'), 'the list opens above the current line, toward the conversation');
    assert.match(open, /지금 작업/);
    const single = renderToStaticMarkup(createElement(SessionTasks, { tasks: [tasks[0]] }));
    assert.doesNotMatch(single, /session-tasks-count/, 'no count for a single task');
  } finally { setLanguage(language); }
});

test('resting on a session in the canvas shows its three latest tasks, newest first, and how many more there are', async () => {
  const { SessionTasksCard, PEEK_TASKS } = await import('../../../client/src/sessions/SessionTasksPeek.js');
  const language = getLanguage();
  setLanguage('ko');
  try {
    const many = [...tasks, task('d', 'Older work', '완료', '2026-09-30T01:00:00Z')];
    const html = renderToStaticMarkup(createElement(SessionTasksCard, { tasks: many }));
    const titles = [...html.matchAll(/session-tasks-peek-title">([^<]+)</g)].map(match => match[1]);
    assert.equal(PEEK_TASKS, 3);
    assert.deepEqual(titles, ['Snapshot compression', 'Task strip design', 'Voice playback fix']);
    assert.match(html, /<li class="current">/);
    assert.match(html, /이전 작업 1개 더/);
    assert.doesNotMatch(renderToStaticMarkup(createElement(SessionTasksCard, { tasks })), /이전 작업/, 'nothing more to say for three tasks');
  } finally { setLanguage(language); }
});

test('the card sits right of its row inside the window, under it when there is no room, and nowhere for a hidden row', async () => {
  const { peekPlacement } = await import('../../../client/src/sessions/SessionTasksPeek.js');
  const row = (left: number, top: number, width = 260, height = 90) => ({ left, top, right: left + width, bottom: top + height, width, height });
  const viewport = { width: 1440, height: 900 };
  assert.deepEqual(peekPlacement(row(16, 400), 200, viewport), { left: 286, top: 400 });
  assert.deepEqual(peekPlacement(row(16, 820), 200, viewport), { left: 286, top: 692 }, 'kept inside the bottom of the window');
  assert.deepEqual(peekPlacement(row(16, 300, 360), 200, { width: 390, height: 844 }), { left: 16, top: 396 }, 'no room on the right: under the row');
  assert.equal(peekPlacement(row(0, 0, 0, 0), 200, viewport), undefined, 'a canvas hidden after a tap shows no card');
});


test('a canvas card outside the window or clipped canvas cannot leave a floating summary behind', async () => {
  const { peekPlacement } = await import('../../../client/src/sessions/SessionTasksPeek.js');
  const box = (left: number, top: number, width = 260, height = 90) => ({ left, top, right: left + width, bottom: top + height, width, height });
  const viewport = { width: 1440, height: 900 };
  for (const anchor of [box(-260, 100), box(1440, 100), box(400, -90), box(400, 900)]) {
    assert.equal(peekPlacement(anchor, 200, viewport), undefined);
  }
  const canvas = box(300, 100, 800, 700);
  assert.equal(peekPlacement(box(20, 200), 200, viewport, 300, canvas), undefined);
  assert.equal(peekPlacement(box(500, 10), 200, viewport, 300, canvas), undefined);
  assert.deepEqual(peekPlacement(box(250, 200), 200, viewport, 300, canvas), { left: 520, top: 200 }, 'partially visible zoomed nodes still show their summary');
});
