import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskDetail } from '../../../client/src/todo/TaskDetail.js';
import { worldFromOverview, emptyWorld, withDetail } from '../../../client/src/todo/todo-model.js';
import { TaskCard } from '../../../client/src/todo/TaskCard.js';
import { cardContext } from '../../../client/src/todo/todo-views.js';
import { forgetFoldedForTests } from '../../../client/src/todo/todo-prefs.js';
import { overview, task } from './fixtures.js';

const render = (item: ReturnType<typeof task>) => {
  const world = withDetail(worldFromOverview(overview([item]), emptyWorld()), { task: item, subtasks: [], comments: [], files: [], completions: [], events: [], previous: [], next: [] });
  const uploads = { subscribe: () => () => undefined, getJobs: () => [], add() {}, cancel() {}, retry() {} };
  return renderToStaticMarkup(createElement(TaskDetail, { taskId: item.id, world, error: '', today: '2026-10-14', client: { today: () => '2026-10-14' } as never, actions: {} as never,
    readOnly: false, uploads: uploads as never, onClose() {}, onOpen() {}, onProject() {}, onFollowUp() {}, tab: 'detail', onTab() {} }));
};

test('the detail puts the most used properties first; rare ones without a value become one row of additions', () => {
  const markup = render(task('a', { content: 'Plan', dueDate: '2026-10-14' }));
  const rows = [...markup.matchAll(/class="todo-property (\w+) ?(adding)?"/g)].map(match => match[2] ? `+${match[1]}` : match[1]);
  assert.deepEqual(rows, ['date', 'priority', 'labels', 'project', '+deadline', '+duration'], 'the most used first; the rare ones as additions after them');
  assert.match(markup, /＋ 마감일.*＋ 소요 시간/s);
  // The properties come before the description (a phone shows them as chips under the title), then the sections in order.
  const at = (text: string) => markup.indexOf(text);
  assert.ok(at('todo-properties') < at('todo-description-area') && at('todo-description-area') < at('>하위 작업<') && at('>하위 작업<') < at('>댓글<'));
  assert.doesNotMatch(markup, />없음</, 'no row of "none"');
  // One way to attach to the description, as a paperclip; no wordy button.
  assert.equal((markup.match(/aria-label="파일 첨부"/g) ?? []).length, 2, 'the description and the comment box');
  assert.doesNotMatch(markup, />파일 첨부</);
});

test('a rare property with a value takes its row, and the additions row is gone when none is left', () => {
  const markup = render(task('a', { deadlineDate: '2026-10-20', durationMin: 90 }));
  const rows = [...markup.matchAll(/class="todo-property (\w+) ?(adding)?"/g)].map(match => match[2] ? `+${match[1]}` : match[1]);
  assert.deepEqual(rows, ['date', 'priority', 'labels', 'project', 'deadline', 'duration']);
});

test('a card shows its open sub-tasks unless they were folded', () => {
  (globalThis as { window?: unknown }).window = { localStorage: { getItem: () => null, setItem() {} } };
  const parent = task('p'), open = task('c1', { parentId: 'p' }), done = task('c2', { parentId: 'p', completedAt: '2026-10-14T01:00:00.000Z' });
  const world = worldFromOverview(overview([parent, open, done]), emptyWorld());
  const markup = renderToStaticMarkup(createElement(TaskCard, { task: parent, context: cardContext(world, '2026-10-14', false), onOpen() {}, onComplete() {}, onCompleteNext() {} }));
  assert.match(markup, /aria-expanded="true"/);
  assert.match(markup, />c1</);
  assert.doesNotMatch(markup, />c2</, 'completed ones are in the detail');
});

test('a folded card lists no sub-tasks, and says so', () => {
  const values = new Map([['tower.todo.collapsedSubtasks', '["p"]']]);
  (globalThis as { window?: unknown }).window = { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem() {} } };
  forgetFoldedForTests();
  const parent = task('p'), open = task('c1', { parentId: 'p' });
  const world = worldFromOverview(overview([parent, open]), emptyWorld());
  const markup = renderToStaticMarkup(createElement(TaskCard, { task: parent, context: cardContext(world, '2026-10-14', false), onOpen() {}, onComplete() {}, onCompleteNext() {} }));
  assert.match(markup, /aria-expanded="false"/);
  assert.doesNotMatch(markup, />c1</);
  forgetFoldedForTests();
});

test('a sub-task with a card of its own on the board is not listed again under its parent', () => {
  (globalThis as { window?: unknown }).window = { localStorage: { getItem: () => null, setItem() {} } };
  forgetFoldedForTests();
  const parent = task('p'), dated = task('c1', { parentId: 'p', dueDate: '2026-10-14' }), other = task('c2', { parentId: 'p' });
  const world = worldFromOverview(overview([parent, dated, other]), emptyWorld());
  const markup = renderToStaticMarkup(createElement(TaskCard, { task: parent, context: cardContext(world, '2026-10-14', false, new Set(['p', 'c1'])), onOpen() {}, onComplete() {}, onCompleteNext() {} }));
  assert.doesNotMatch(markup, />c1</);
  assert.match(markup, />c2</);
});
