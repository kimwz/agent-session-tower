import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskDetail } from '../../../client/src/todo/TaskDetail.js';
import { worldFromOverview, emptyWorld, withDetail } from '../../../client/src/todo/todo-model.js';
import { TaskCard } from '../../../client/src/todo/TaskCard.js';
import { cardContext } from '../../../client/src/todo/todo-views.js';
import { forgetFoldedForTests } from '../../../client/src/todo/todo-prefs.js';
import { movePreset, presetsDirty, presetsToSave, shownChatPresets } from '../../../client/src/todo/chat-presets.js';
import { setLanguage } from '../../../client/src/i18n/i18n.js';
import { overview, task } from './fixtures.js';

// Each test brings its own browser stub (storage, window size) and leaves none behind.
afterEach(() => { delete (globalThis as { window?: unknown }).window; });

const render = (item: ReturnType<typeof task>, options: { tab?: 'detail' | 'chat'; chatPresets?: string[]; readOnly?: boolean } = {}) => {
  const world = withDetail(worldFromOverview({ ...overview([item]), ...(options.chatPresets ? { chatPresets: options.chatPresets } : {}) }, emptyWorld()), { task: item, subtasks: [], comments: [], files: [], completions: [], events: [], previous: [], next: [] });
  const uploads = { subscribe: () => () => undefined, getJobs: () => [], add() {}, cancel() {}, retry() {} };
  return renderToStaticMarkup(createElement(TaskDetail, { taskId: item.id, world, error: '', today: '2026-10-14', client: { today: () => '2026-10-14' } as never, actions: {} as never,
    readOnly: options.readOnly ?? false, uploads: uploads as never, onClose() {}, onOpen() {}, onProject() {}, onFollowUp() {}, tab: options.tab ?? 'detail', onTab() {} }));
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

test('an empty issue chat offers the presets as buttons: the saved ones in order, else the defaults, none for an empty list', t => {
  t.after(() => setLanguage('ko'));
  const presets = (markup: string) => [...markup.matchAll(/class="todo-agent-preset"( disabled="")? title="([^"]*)"/g)].map(match => `${match[1] ? '-' : ''}${match[2]}`);
  setLanguage('ko');
  assert.deepEqual(presets(render(task('a'), { tab: 'chat' })), ['작업 시작 해줘', '설계 해줘', '조사 해줘']);
  assert.deepEqual(presets(render(task('a'), { tab: 'chat', chatPresets: ['조사 해줘', '리뷰 해줘'] })), ['조사 해줘', '리뷰 해줘']);
  assert.doesNotMatch(render(task('a'), { tab: 'chat', chatPresets: [] }), /todo-agent-presets/);
  // They are disabled wherever sending is: a read-only page, a completed todo.
  assert.deepEqual(presets(render(task('a'), { tab: 'chat', chatPresets: ['go'], readOnly: true })), ['-go']);
  assert.deepEqual(presets(render(task('a', { completedAt: '2026-10-14T01:00:00.000Z' }), { tab: 'chat', chatPresets: ['go'] })), ['-go']);
  // The defaults follow the page's language; a saved list shows as written.
  setLanguage('en');
  assert.deepEqual(presets(render(task('a'), { tab: 'chat' })), ['Start the work', 'Design it', 'Research it']);
  assert.deepEqual(presets(render(task('a'), { tab: 'chat', chatPresets: ['조사 해줘'] })), ['조사 해줘']);
});

test('both tabs of the detail have a left edge to drag; it starts at 640px and comes back at the saved width', t => {
  setLanguage('ko');
  const handle = (markup: string) => /<div class="chat-resize-handle todo-detail-resize" role="separator" tabindex="0" aria-label="상세 패널 너비 조절" aria-orientation="vertical" aria-valuemin="480" aria-valuemax="[^"]+" aria-valuenow="(\d+)"/.exec(markup)?.[1];
  const values = new Map<string, string>();
  (globalThis as { window?: unknown }).window = { innerWidth: 1440, localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem() {} } };
  for (const tab of ['detail', 'chat'] as const) {
    const markup = render(task('a'), { tab });
    assert.equal(handle(markup), '640', tab);
    assert.match(markup, /class="todo-detail[^"]*" aria-label="[^"]*" tabindex="-1" style="--todo-detail-width:640px"/, tab);
  }
  values.set('agent-session-tower.todo-detail-width', '900');
  assert.equal(handle(render(task('a'))), '900');
  values.set('agent-session-tower.todo-detail-width', '5000');
  assert.equal(handle(render(task('a'))), '1020', "no wider than leaves the header's controls beside it");
  values.set('agent-session-tower.todo-detail-width', '100');
  assert.equal(handle(render(task('a'))), '480', 'no narrower than the property card needs');
});

test('the presets editor saves trimmed rows without blanks, and a drag moves one row', () => {
  assert.deepEqual(presetsToSave([' a ', '', '  ', 'b']), ['a', 'b']);
  assert.deepEqual(movePreset(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(movePreset(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
  assert.deepEqual(movePreset(['a', 'b'], 0, -1), ['a', 'b'], 'a drop outside the list changes nothing');
  assert.deepEqual(shownChatPresets([]), []);
  // An edit is what would be saved differing from where the rows started.
  const start = ['작업 시작 해줘', '설계 해줘'];
  assert.equal(presetsDirty([...start], start), false);
  assert.equal(presetsDirty([...start, '  '], start), false, 'a blank row added is not saved, so no edit');
  assert.equal(presetsDirty(['설계 해줘', '작업 시작 해줘'], start), true, 'a new order is an edit');
  assert.equal(presetsDirty(['작업 시작 해줘 ', '설계 해줘'], start), false, 'spaces around are trimmed on saving');
  assert.equal(presetsDirty(['작업 시작 해줘'], start), true);
});
