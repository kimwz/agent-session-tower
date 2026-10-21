import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BoardView, collisionsFor } from '../../../client/src/todo/BoardView.js';
import { TaskCard } from '../../../client/src/todo/TaskCard.js';
import { worldFromOverview } from '../../../client/src/todo/todo-model.js';
import { forgetFoldedForTests, setTodayPanelShown, todayPanelShown } from '../../../client/src/todo/todo-prefs.js';
import { readShortcut } from '../../../client/src/todo/todo-shortcuts.js';
import { cardContext, defaultDisplay, dropOps, foldGroups, inTodayPanel, moveSelection, moveSelectionAt, overviewGroups, TODAY_PANEL, todayPanel, todayPanelDrop, type ViewContext } from '../../../client/src/todo/todo-views.js';
import { overview, project, task } from './fixtures.js';

const today = '2026-10-17';
const world = worldFromOverview(overview([
  task('late', { dueDate: '2026-10-15', priority: 1 }),
  task('now', { dueDate: today, content: 'Write the report' }),
  task('child', { parentId: 'parent', dueDate: today, content: 'Draft the summary' }),
  task('parent', { projectId: 'tower', content: 'Quarterly report' }),
  task('later', { projectId: 'tower', dueDate: '2026-10-30' }),
], { projects: [project('inbox', { inbox: true, name: 'Inbox' }), project('tower')] }));
const context: ViewContext = { world, today, start: today, query: '', searchResults: null };

function storage(initial: Record<string, string> = {}, refuse = false) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { if (refuse) throw new Error('quota'); values.set(key, value); }, values };
}

test('Today beside the overview is on until turned off, and the last choice is remembered after a reload', () => {
  const saved = storage();
  (globalThis as { window?: unknown }).window = { localStorage: saved };
  forgetFoldedForTests();
  assert.equal(todayPanelShown(), true, 'on by default');
  setTodayPanelShown(false);
  forgetFoldedForTests();
  assert.equal(todayPanelShown(), false, 'read again from storage');
  setTodayPanelShown(true);
  forgetFoldedForTests();
  assert.equal(todayPanelShown(), true);
  // Storage that refuses keeps the choice for the page.
  (globalThis as { window?: unknown }).window = { localStorage: storage({}, true) };
  forgetFoldedForTests();
  setTodayPanelShown(false);
  assert.equal(todayPanelShown(), false);
});

test('T turns Today beside the overview on and off; G then T still goes to Today', () => {
  const key = (value: string, patch: Partial<{ code: string; shiftKey: boolean; repeat: boolean }> = {}) => ({ key: value, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...patch });
  assert.deepEqual(readShortcut(key('t'), false), { shortcut: { action: 'today-panel' }, pending: false });
  // By where the key sits, so a Korean input mode keeps it.
  assert.deepEqual(readShortcut(key('ㅅ', { code: 'KeyT' }), false), { shortcut: { action: 'today-panel' }, pending: false });
  assert.deepEqual(readShortcut(key('t'), true), { shortcut: { action: 'today' }, pending: false });
  assert.deepEqual(readShortcut(key('t', { repeat: true }), false), { pending: false }, 'a held key does not flip it back and forth');
  assert.deepEqual(readShortcut(key('T', { shiftKey: true }), false), { pending: false });
});

test('the panel shows the Today list as its display lays it out, and dates today whatever comes from the overview', () => {
  const panel = todayPanel(defaultDisplay({ kind: 'today' }), context);
  assert.deepEqual(panel.columns.map(column => [column.id, column.tasks.map(item => item.id)]), [['today/date:overdue', ['late']], ['today/date:today', ['child', 'now']]]);
  assert.ok(panel.columns.every(inTodayPanel) && inTodayPanel(panel.target));
  assert.equal(inTodayPanel({ id: 'inbox/section:none' }), false);
  const byPriority = todayPanel({ ...defaultDisplay({ kind: 'today' }), group: 'priority' }, context);
  assert.deepEqual(byPriority.columns.map(column => column.id), ['today/priority:1', 'today/priority:2', 'today/priority:3', 'today/priority:4']);
  assert.deepEqual(byPriority.target, panel.target, 'whatever its columns, the panel dates today');
  assert.deepEqual(dropOps(world.tasks.later, panel.target.drop!), [{ op: 'task.update', id: 'later', patch: { dueDate: today } }]);
  assert.deepEqual(dropOps(world.tasks.now, panel.target.drop!), [], 'already today');
});

test('a card from the overview let go anywhere in the panel is dated today; one moved within the panel follows the Today list', () => {
  const panel = { id: TODAY_PANEL }, today = { id: 'today/date:today' }, overdue = { id: 'today/date:overdue' }, section = { id: 'tower/section:none' };
  assert.equal(todayPanelDrop(section, panel), 'today', "the panel's empty space");
  assert.equal(todayPanelDrop(section, today), 'today');
  assert.equal(todayPanelDrop(section, overdue), 'today', 'even the overdue column: the task lands in Today');
  // The Today list has no empty space of its own to drop on: nothing changes, never first or a new date.
  assert.equal(todayPanelDrop(overdue, panel), 'stay');
  assert.equal(todayPanelDrop(today, panel), 'stay');
  assert.equal(todayPanelDrop(overdue, today), 'board', 'within the panel, as on the Today list');
  assert.equal(todayPanelDrop(today, section), 'board', 'out to the overview, by its rules');
  assert.equal(todayPanelDrop(section, section), 'board');
});

test('a card let go in the panel lands there, never on an overview card scrolled under it', () => {
  const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const droppableRects = new Map<string, ReturnType<typeof rect>>([
    [TODAY_PANEL, rect(0, 0, 320, 800)],
    ['column:today/date:today', rect(30, 40, 280, 200)],
    ['column:tower/section:none', rect(340, 40, 280, 200)],
    // An overview card scrolled out of sight sideways: it still measures under the panel.
    ['task:later', rect(100, 300, 280, 60)],
  ]);
  const droppableContainers = [...droppableRects.keys()].map(id => ({ id, rect: { current: droppableRects.get(id) }, data: { current: {} }, disabled: false, node: { current: null } })) as never[];
  const at = (x: number, y: number) => collisionsFor(true)({ active: { id: 'task:later' } as never, collisionRect: rect(x, y, 10, 10), droppableRects: droppableRects as never, droppableContainers, pointerCoordinates: { x, y } }).map(item => item.id);
  assert.deepEqual(at(150, 320), [TODAY_PANEL], "the panel's empty space, over the hidden card");
  assert.deepEqual(at(150, 100), ['column:today/date:today'], "a panel column wins over the panel");
  assert.deepEqual(at(400, 100), ['column:tower/section:none'], 'the overview as before');
});

test('the arrow keys go from the card chosen, when a task has one in Today and one on the overview', () => {
  const columns = [{ id: 'today/date:today', tasks: [world.tasks.now] }, { id: 'inbox/section:none', tasks: [world.tasks.now, world.tasks.late] }];
  assert.deepEqual(moveSelectionAt(columns, 'now', 'down', 'inbox/section:none'), { id: 'late', column: 'inbox/section:none' });
  assert.deepEqual(moveSelectionAt(columns, 'now', 'right', 'today/date:today'), { id: 'now', column: 'inbox/section:none' });
  assert.deepEqual(moveSelectionAt(columns, 'now', 'left', 'inbox/section:none'), { id: 'now', column: 'today/date:today' });
  // Without a column, the first card of the task, as before.
  assert.equal(moveSelection(columns, 'now', 'down'), 'now');
});

test('a sub-task with a card of its own names its parent above its title', () => {
  const html = (id: string) => renderToStaticMarkup(createElement(TaskCard, { task: world.tasks[id], context: cardContext(world, today, true), onOpen() {}, onComplete() {}, onCompleteNext() {} }));
  assert.match(html('child'), /<span class="todo-card-parent" title="Quarterly report">Quarterly report<\/span><span class="todo-card-title"[^>]*>Draft the summary/);
  assert.doesNotMatch(html('now'), /todo-card-parent/);
});

test('the overview shows Today beside it in an area of its own, its cards apart from the overview’s', () => {
  const display = defaultDisplay({ kind: 'all' });
  const groups = foldGroups(overviewGroups(display, context), new Set());
  const panel = todayPanel(defaultDisplay({ kind: 'today' }), context);
  const shown = new Set(panel.columns.flatMap(column => column.tasks.map(item => item.id)));
  const props = {
    columns: groups.flatMap(group => group.columns), groups, context: cardContext(world, today, false), manual: true, sections: true, mobile: false, selectedId: null,
    card: { onOpen() {}, onComplete() {}, onCompleteNext() {} }, onAdd() {}, onDrop() {}, onSectionMove() {}, onAddSection() {}, onSectionMenu() {},
  };
  const html = renderToStaticMarkup(createElement(BoardView, { ...props, today: { ...panel, context: cardContext(world, today, true, shown), manual: true, note: 'Oct 17' } }));
  assert.match(html, /class="todo-board-split"><section[^>]*class="todo-board todo-today-panel/);
  assert.match(html, /data-column="today\/date:today"[\s\S]*data-task="now"[\s\S]*class="todo-board todo-overview/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(BoardView, props)), /todo-today-panel|todo-board-split/, 'off: the overview alone, as before');
});

test('the panel names Today once: its lone Today column shows no header of its own, beside overdue both keep theirs', () => {
  const display = defaultDisplay({ kind: 'today' });
  const calm = worldFromOverview(overview([task('now', { dueDate: today, content: 'Write the report' }), task('more', { dueDate: today })],
    { projects: [project('inbox', { inbox: true, name: 'Inbox' })] }));
  const alone = todayPanel(display, { ...context, world: calm });
  assert.deepEqual(alone.columns.map(column => [column.id, !!column.headless]), [['today/date:today', true]]);
  assert.deepEqual(todayPanel(display, context).columns.map(column => [column.id, !!column.headless]), [['today/date:overdue', false], ['today/date:today', false]]);
  assert.ok(todayPanel({ ...display, group: 'priority' }, { ...context, world: calm }).columns.every(column => !column.headless), 'other groupings keep their headers');
  assert.ok(todayPanel({ ...display, group: 'project' }, { ...context, world: calm }).columns.every(column => !column.headless));

  const board = (world: typeof calm, panel: ReturnType<typeof todayPanel>) => {
    const groups = foldGroups(overviewGroups(defaultDisplay({ kind: 'all' }), { ...context, world }), new Set());
    return renderToStaticMarkup(createElement(BoardView, {
      columns: groups.flatMap(group => group.columns), groups, context: cardContext(world, today, false), manual: true, sections: true, mobile: false, selectedId: null,
      card: { onOpen() {}, onComplete() {}, onCompleteNext() {} }, onAdd() {}, onDrop() {}, onSectionMove() {}, onAddSection() {}, onSectionMenu() {},
      today: { ...panel, context: cardContext(world, today, true), manual: true, note: 'Oct 17' },
    }));
  };
  const panelOf = (html: string) => html.slice(html.indexOf('todo-today-panel'), html.indexOf('todo-overview'));
  const once = panelOf(board(calm, alone));
  assert.equal(once.match(/<h3>오늘<\/h3>/g)?.length, 1, 'the panel header only');
  // The column stays: named for screen readers, its cards and its add button there.
  assert.match(once, /<section[^>]*data-column="today\/date:today" aria-label="오늘"><div class="todo-column-cards">[\s\S]*data-task="now"[\s\S]*todo-add-card/);
  const both = panelOf(board(world, todayPanel(display, context)));
  assert.match(both, /<h3>오늘<\/h3>[\s\S]*<h3>기한 지남<\/h3>[\s\S]*<h3>오늘<\/h3>/, 'the panel header, then overdue and Today told apart');
});
