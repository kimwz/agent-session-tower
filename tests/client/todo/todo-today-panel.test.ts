import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BoardView, collisionsFor } from '../../../client/src/todo/BoardView.js';
import { TaskCard } from '../../../client/src/todo/TaskCard.js';
import { worldFromOverview } from '../../../client/src/todo/todo-model.js';
import type { TodoCompletion, TodoTask } from '../../../shared/todo/types.js';
import { forgetFoldedForTests, setTodayPanelShown, todayPanelShown } from '../../../client/src/todo/todo-prefs.js';
import { readShortcut } from '../../../client/src/todo/todo-shortcuts.js';
import { cardContext, defaultDisplay, doneToday, dropOps, foldGroups, inTodayPanel, moveSelection, moveSelectionAt, overviewGroups, TODAY_PANEL, TODAY_SUBTASK, todayPanel, todayPanelDrop, type BoardColumn, type ViewContext } from '../../../client/src/todo/todo-views.js';
import { overview, project, section, task } from './fixtures.js';

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

test('a card let go in the panel lands there (or on its sub-task zone), never on an overview card scrolled under it', () => {
  const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const droppableRects = new Map<string, ReturnType<typeof rect>>([
    [TODAY_PANEL, rect(0, 0, 320, 800)],
    [TODAY_SUBTASK, rect(30, 4, 280, 30)],
    ['column:today/date:today', rect(30, 40, 280, 200)],
    ['column:tower/section:none', rect(340, 40, 280, 200)],
    // An overview card scrolled out of sight sideways: it still measures under the panel.
    ['task:later', rect(100, 300, 280, 60)],
  ]);
  const droppableContainers = [...droppableRects.keys()].map(id => ({ id, rect: { current: droppableRects.get(id) }, data: { current: {} }, disabled: false, node: { current: null } })) as never[];
  const at = (x: number, y: number) => collisionsFor(true)({ active: { id: 'task:later' } as never, collisionRect: rect(x, y, 10, 10), droppableRects: droppableRects as never, droppableContainers, pointerCoordinates: { x, y } }).map(item => item.id);
  assert.deepEqual(at(150, 320), [TODAY_PANEL], "the panel's empty space, over the hidden card");
  assert.deepEqual(at(150, 100), ['column:today/date:today'], "a panel column wins over the panel");
  assert.deepEqual(at(150, 20), [TODAY_SUBTASK], 'the sub-task zone, likewise');
  assert.deepEqual(at(400, 100), ['column:tower/section:none'], 'the overview as before');
  // A column's done cards sit in its section (sorted by its header) but outside its cards: let go there, nothing moves.
  const sections = new Map([...droppableRects, ['section:doing', rect(640, 0, 280, 600)], ['column:tower/section:doing', rect(640, 40, 280, 200)], ['done:tower/section:doing', rect(640, 260, 280, 200)]]);
  const containers = [...sections.keys()].map(id => ({ id, rect: { current: sections.get(id) }, data: { current: {} }, disabled: false, node: { current: null } })) as never[];
  const over = (x: number, y: number, pointer = true) => collisionsFor(true)({ active: { id: 'task:later' } as never, collisionRect: rect(x, y, 10, 10), droppableRects: sections as never, droppableContainers: containers, pointerCoordinates: pointer ? { x, y } : null }).map(item => item.id);
  assert.deepEqual(over(700, 300), ['done:tower/section:doing']);
  assert.ok(!over(700, 300, false).some(id => String(id).startsWith('done:')), 'never the nearest for the keyboard');
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

test("the panel's sub-task zone shows under its header with the handler, and nowhere without it", () => {
  const groups = foldGroups(overviewGroups(defaultDisplay({ kind: 'all' }), context), new Set());
  const panel = todayPanel(defaultDisplay({ kind: 'today' }), context);
  const props = {
    columns: groups.flatMap(group => group.columns), groups, context: cardContext(world, today, false), manual: true, sections: true, mobile: false, selectedId: null,
    card: { onOpen() {}, onComplete() {}, onCompleteNext() {} }, onAdd() {}, onDrop() {}, onSectionMove() {}, onAddSection() {}, onSectionMenu() {},
  };
  const withPanel = { ...props, today: { ...panel, context: cardContext(world, today, true), manual: true, note: 'Oct 17' } };
  const html = renderToStaticMarkup(createElement(BoardView, { ...withPanel, onSubtask() {} }));
  assert.match(html, /<header class="todo-today-head">[\s\S]*?<\/header><div class="todo-subtask-zone[^"]*">[\s\S]*?<b>하위 작업 만들기<\/b><span>놓으면 오늘 할 일로<\/span><\/div>[\s\S]*data-column="today\/date:overdue"/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(BoardView, withPanel)), /todo-subtask-zone/, 'read-only: no handler, no zone');
  assert.doesNotMatch(renderToStaticMarkup(createElement(BoardView, { ...props, onSubtask() {} })), /todo-subtask-zone/, 'without the panel');
});

/** What a component returns for these props, rendered once so its hooks run: its handlers can then be called directly. */
function rendered<P extends object>(component: (props: P) => ReactElement, props: P): ReactElement {
  let tree: ReactElement | undefined;
  renderToStaticMarkup(createElement(() => { tree = component(props); return tree; }));
  return tree!;
}

test('a card let go on the sub-task zone asks for its sub-task, from the overview or the panel, and keeps its date', () => {
  const groups = foldGroups(overviewGroups(defaultDisplay({ kind: 'all' }), context), new Set());
  const panel = todayPanel(defaultDisplay({ kind: 'today' }), context);
  const subtasks: string[] = [], drops: [string, string][] = [];
  const board = rendered(BoardView, {
    columns: groups.flatMap(group => group.columns), groups, context: cardContext(world, today, false), manual: true, sections: true, mobile: false, selectedId: null,
    card: { onOpen() {}, onComplete() {}, onCompleteNext() {} }, onAdd() {}, onSectionMove() {}, onAddSection() {}, onSectionMenu() {},
    onDrop: (task: TodoTask, column: BoardColumn) => drops.push([task.id, column.id]), onSubtask: (task: TodoTask) => subtasks.push(task.id),
    today: { ...panel, context: cardContext(world, today, true), manual: true, note: 'Oct 17' },
  });
  const end = (board.props as { onDragEnd: (event: unknown) => void }).onDragEnd;
  const card = (task: TodoTask, column: Pick<BoardColumn, 'id'>) => ({ id: `task:${task.id}`, data: { current: { type: 'task', task, column } } });
  end({ active: card(world.tasks.later, { id: 'tower/section:none' }), over: { id: TODAY_SUBTASK, data: { current: { type: 'subtask' } } } });
  end({ active: card(world.tasks.now, panel.columns[1]), over: { id: TODAY_SUBTASK, data: { current: { type: 'subtask' } } } });
  assert.deepEqual(subtasks, ['later', 'now']);
  assert.deepEqual(drops, [], 'neither is moved or dated');
  // The rest of the panel dates a card from the overview today, as before.
  end({ active: card(world.tasks.later, { id: 'tower/section:none' }), over: { id: TODAY_PANEL, data: { current: { type: 'column', column: panel.target } } } });
  assert.deepEqual(drops, [['later', TODAY_PANEL]]);
  assert.deepEqual(subtasks, ['later', 'now']);
});

test("a mouse's right-click on a card opens its menu at the pointer; a touch, a sub-task's row and a read-only card keep the browser's", () => {
  (globalThis as { Element?: unknown }).Element ??= class {};
  const Element = (globalThis as unknown as { Element: new () => object }).Element;
  const menus: [string, unknown, unknown][] = [];
  const button = { name: 'more' };
  const contextMenu = (readOnly: boolean) => (rendered(TaskCard, { task: world.tasks.now, context: cardContext(world, today, true), onOpen() {}, onComplete() {}, onCompleteNext() {}, readOnly,
    onMenu: (task: TodoTask, anchor: HTMLElement, at?: { x: number; y: number }) => menus.push([task.id, anchor, at]) }).props as { onContextMenu: (event: unknown) => void }).onContextMenu;
  const press = (readOnly: boolean, patch: { pointerType?: string; on?: string } = {}) => {
    let prevented = false;
    const target = Object.assign(new Element(), { closest: (selector: string) => patch.on && selector.includes(patch.on) ? {} : null });
    contextMenu(readOnly)({ currentTarget: { querySelector: () => button }, target, nativeEvent: { pointerType: patch.pointerType ?? 'mouse' }, clientX: 120, clientY: 340, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  assert.equal(press(false), true);
  assert.deepEqual(menus, [['now', button, { x: 120, y: 340 }]], "anchored to the card's … button, placed at the pointer");
  assert.equal(press(false, { pointerType: 'touch' }), false, "a held touch is the board's drag");
  assert.equal(press(false, { on: '.todo-card-subtasks' }), false, "a sub-task's row is another task");
  assert.equal(press(false, { on: 'a' }), false, 'a link keeps its own menu');
  assert.equal(press(true), false, 'read-only');
  assert.equal(menus.length, 1);
});

test('a card nothing chooses (done today) takes neither the choice nor the keyboard when the mouse moves over it', () => {
  const focused: string[] = [], chosen: string[] = [];
  const move = (onSelect?: (id: string) => void) => (rendered(TaskCard, { task: world.tasks.now, context: cardContext(world, today, true), onOpen() {}, onComplete() {}, onCompleteNext() {}, onSelect })
    .props as { onPointerMove: (event: unknown) => void }).onPointerMove({ pointerType: 'mouse', currentTarget: { focus: () => focused.push('now'), contains: () => false } });
  move();
  assert.deepEqual([focused, chosen], [[], []]);
  const globals = globalThis as { document?: unknown; HTMLElement?: unknown };
  globals.document = { activeElement: null };
  globals.HTMLElement = class {};
  try { move(id => chosen.push(id)); } finally { delete globals.document; delete globals.HTMLElement; }
  assert.deepEqual(chosen, ['now'], 'any other card, as before');
});

test('what was done today stays on the overview and in Today beside it, struck through under the open cards and the add button', () => {
  const range = { since: '2026-10-17T00:00:00.000Z', until: '2026-10-18T00:00:00.000Z' };
  const done = (at: string) => ({ completedAt: at });
  const completion = (id: string, taskId: string, completedAt: string, patch: Partial<TodoCompletion> = {}): TodoCompletion => ({ id, taskId, occurrenceDate: null, completedAt, ...patch });
  const seen = worldFromOverview(overview([
    task('open', { projectId: 'tower', sectionId: 'doing', dueDate: today }),
    task('daily', { projectId: 'tower', dueDate: '2026-10-18', recurrence: { kind: 'daily', interval: 1 } as never }),
  ], { projects: [project('inbox', { inbox: true, name: 'Inbox' }), project('tower')], sections: [section('doing', 'tower'), section('shelf', 'tower', { archivedAt: '2026-10-01T00:00:00.000Z' })] }));
  // Read for today: a section's task, a loose one, the repeating task's occurrence, a sub-task done with its parent, one
  // reopened here before the list is read again, one deleted, one in an archived section, and the same task twice.
  const tasks = {
    report: task('report', { projectId: 'tower', sectionId: 'doing', dueDate: today, ...done('2026-10-17T09:00:00.000Z') }),
    loose: task('loose', { projectId: 'tower', ...done('2026-10-17T08:00:00.000Z') }),
    child: task('child', { projectId: 'tower', parentId: 'report', dueDate: today, ...done('2026-10-17T09:00:00.000Z') }),
    reopened: task('reopened', { projectId: 'tower', dueDate: today, ...done('2026-10-17T07:00:00.000Z') }),
    gone: task('gone', { projectId: 'tower', ...done('2026-10-17T06:00:00.000Z'), deletedAt: '2026-10-17T06:30:00.000Z' }),
    shelved: task('shelved', { projectId: 'tower', sectionId: 'shelf', ...done('2026-10-17T05:00:00.000Z') }),
  };
  seen.tasks.reopened = { ...tasks.reopened, completedAt: null };
  // As the page last saw them: one moved elsewhere since (the list has it where it is now), one deleted elsewhere since
  // (the list no longer has it), and a sub-task completed here with its parent (no completion of its own).
  seen.tasks.moved = task('moved', { projectId: 'tower', sectionId: 'doing', ...done('2026-10-17T08:45:00.000Z') });
  seen.tasks.ghost = task('ghost', { projectId: 'inbox', ...done('2026-10-17T08:50:00.000Z') });
  seen.tasks.boss = task('boss', { projectId: 'inbox', ...done('2026-10-17T09:30:00.000Z') });
  seen.tasks.minion = task('minion', { projectId: 'inbox', parentId: 'boss', dueDate: today, ...done('2026-10-17T09:30:00.000Z') });
  seen.tasks.helper = task('helper', { projectId: 'inbox', parentId: 'boss', dueDate: today, ...done('2026-10-17T09:10:00.000Z') });
  seen.tasks.fresh = task('fresh', { projectId: 'inbox', dueDate: '2026-10-16', ...done('2026-10-17T10:00:00.000Z') });
  seen.tasks.again = task('again', { projectId: 'inbox', ...done('2026-10-17T09:45:00.000Z') });
  // This page's own completions (`TodoState.completing`), the list not read since: the latest first.
  const mine = [
    { completion: completion('c-fresh', 'fresh', '2026-10-17T10:00:00.000Z'), task: seen.tasks.fresh },
    { completion: completion('c-again-2', 'again', '2026-10-17T09:45:00.000Z'), task: seen.tasks.again },
    { completion: completion('c-boss', 'boss', '2026-10-17T09:30:00.000Z'), task: seen.tasks.boss },
  ];
  const read = [
    { completion: completion('c-report', 'report', '2026-10-17T09:00:00.000Z'), task: tasks.report },
    { completion: completion('c-child', 'child', '2026-10-17T09:00:00.000Z', { causeId: 'c-report' }), task: tasks.child },
    { completion: completion('c-helper', 'helper', '2026-10-17T09:10:00.000Z'), task: seen.tasks.helper },
    { completion: completion('c-moved', 'moved', '2026-10-17T08:45:00.000Z'), task: { ...seen.tasks.moved, sectionId: null } },
    { completion: completion('c-again-1', 'again', '2026-10-17T08:30:00.000Z'), task: seen.tasks.again },
    { completion: completion('c-loose', 'loose', '2026-10-17T08:00:00.000Z'), task: tasks.loose },
    { completion: completion('c-daily', 'daily', '2026-10-17T07:30:00.000Z', { occurrenceDate: today }), task: seen.tasks.daily },
    { completion: completion('c-reopened', 'reopened', '2026-10-17T07:00:00.000Z'), task: tasks.reopened },
    { completion: completion('c-gone', 'gone', '2026-10-17T06:00:00.000Z'), task: tasks.gone },
    { completion: completion('c-shelved', 'shelved', '2026-10-17T05:00:00.000Z'), task: tasks.shelved },
    { completion: completion('c-loose-0', 'loose', '2026-10-17T04:00:00.000Z'), task: tasks.loose },
    // Outside today: yesterday's, and one at the very start of tomorrow.
    { completion: completion('c-old', 'old', '2026-10-16T23:59:59.000Z'), task: task('old', { projectId: 'inbox', ...done('2026-10-16T23:59:59.000Z') }) },
    { completion: completion('c-next', 'next', range.until), task: task('next', { projectId: 'inbox', ...done(range.until) }) },
  ];
  const cards = doneToday({ mine, read, undoing: [] }, seen, range);
  assert.deepEqual(cards.map(card => [card.task.id, card.completionId, card.date, !!card.task.completedAt]), [
    ['fresh', 'c-fresh', '2026-10-16', true],
    ['again', 'c-again-2', null, true],
    ['boss', 'c-boss', null, true],
    ['helper', 'c-helper', today, true],
    ['report', 'c-report', today, true],
    ['moved', 'c-moved', null, true],
    ['loose', 'c-loose', null, true],
    ['daily', 'c-daily', today, true],
  ], 'newest first, each task once by its latest completion, this page’s first; nothing the page only remembers (ghost, minion)');
  // Being taken back: gone at once, this page's and the list's alike (a repeating task's too, which stays open anyway).
  assert.deepEqual(doneToday({ mine, read, undoing: ['c-boss', 'c-report', 'c-daily'] }, seen, range).map(card => card.completionId),
    ['c-fresh', 'c-again-2', 'c-helper', 'c-moved', 'c-loose']);

  const at = { ...context, world: seen };
  const groups = overviewGroups(defaultDisplay({ kind: 'all' }), at, cards);
  const columns = (id: string) => groups.find(group => group.project.id === id)!.columns.map(column => [column.id, column.tasks.map(item => item.id), (column.done ?? []).map(card => card.task.id)]);
  assert.deepEqual(columns('tower'), [['tower/section:none', ['daily', 'reopened'], ['moved', 'loose']], ['tower/section:doing', ['open'], ['report']]],
    'where the list says it is now; the repeating task is open on its own card already');
  assert.deepEqual(columns('inbox'), [['inbox/section:none', [], ['fresh', 'again', 'boss']]], 'sub-tasks show on their parent’s card');

  // A collapsed section shows no cards, done ones neither; a task of a section unknown here is without one.
  const folded = { ...seen, sections: seen.sections.map(item => item.id === 'doing' ? { ...item, collapsed: true } : item) };
  const lost = { ...cards[0], task: { ...cards[0].task, projectId: 'tower', sectionId: 'nowhere' } };
  const tower = overviewGroups(defaultDisplay({ kind: 'all' }), { ...at, world: folded }, [...cards, lost]).find(group => group.project.id === 'tower')!.columns;
  assert.deepEqual(tower.map(column => [column.id, (column.done ?? []).map(card => card.task.id)]), [['tower/section:none', ['moved', 'loose', 'fresh']], ['tower/section:doing', []]]);
  const panel = todayPanel(defaultDisplay({ kind: 'today' }), at, cards);
  assert.deepEqual(panel.done.map(card => card.task.id), ['fresh', 'helper', 'report', 'daily'], 'of a date up to today: the overdue one done today, and the repeating task’s occurrence');
  assert.deepEqual(todayPanel(defaultDisplay({ kind: 'today' }), { ...at, world: { ...seen, tasks: { ...seen.tasks, daily: { ...seen.tasks.daily, dueDate: today } } } }, cards).done.map(card => card.task.id), ['fresh', 'helper', 'report'],
    'not when the task is on a card of its own there');

  const board = (world: typeof seen, panel: ReturnType<typeof todayPanel>, groups: ReturnType<typeof overviewGroups>) => renderToStaticMarkup(createElement(BoardView, {
    columns: groups.flatMap(group => group.columns), groups, context: cardContext(world, today, false), manual: true, sections: true, mobile: false, selectedId: null,
    card: { onOpen() {}, onComplete() {}, onCompleteNext() {} }, onAdd() {}, onDrop() {}, onSectionMove() {}, onAddSection() {}, onSectionMenu() {}, onReopen() {},
    today: { ...panel, context: cardContext(world, today, true), manual: true, note: 'Oct 17' },
  }));
  const html = board(seen, panel, foldGroups(groups, new Set()));
  const doing = html.slice(html.indexOf('data-column="tower/section:doing"'));
  assert.match(doing, /data-task="open"[\s\S]*todo-add-card[^<]*<svg[\s\S]*?<\/button><\/div><div class="todo-done-cards"><div class="todo-card\s+done[^"]*" data-task="report"/,
    'open card, add button, then the done one, outside the drop area');
  assert.match(doing, /aria-label="“report” 완료 취소" aria-pressed="true"/, 'its check reopens it');
  assert.doesNotMatch(doing.slice(0, doing.indexOf('</section>')), /todo-sortable[^>]*>\s*<div class="todo-card\s+done/, 'never picked up');

  // Nothing left today: the message first, then the add button, then what was done.
  const calm = { ...seen, tasks: Object.fromEntries(Object.entries(seen.tasks).filter(([id]) => !['open', 'daily', 'reopened'].includes(id))) };
  const calmCards = cards.filter(card => card.task.id !== 'daily' && card.task.id !== 'moved');
  const towerColumns = (list: typeof cards) => overviewGroups(defaultDisplay({ kind: 'all' }), { ...at, world: calm }, list).find(group => group.project.id === 'tower')!.columns.map(column => column.id);
  assert.deepEqual(towerColumns(calmCards), ['tower/section:none', 'tower/section:doing'], 'a "섹션 없음" with only done cards still shows');
  assert.deepEqual(towerColumns(calmCards.filter(card => card.task.id !== 'loose')), ['tower/section:doing'], 'one with nothing, open or done, does not');
  const empty = todayPanel(defaultDisplay({ kind: 'today' }), { ...at, world: calm }, cards);
  const panelOf = (markup: string) => markup.slice(markup.indexOf('todo-today-panel'), markup.indexOf('todo-overview'));
  const emptyHtml = panelOf(board(calm, empty, foldGroups(overviewGroups(defaultDisplay({ kind: 'all' }), { ...at, world: calm }, cards), new Set())));
  assert.match(emptyHtml, /^todo-today-panel\s+empty[\s\S]*오늘 할 일을 모두 끝냈습니다\.[\s\S]*todo-add-card[\s\S]*class="todo-done-cards"[\s\S]*data-task="fresh"[\s\S]*data-task="report"/);
  // Grouped by project, an empty panel has no column to add in: it offers its own button, still above what was done.
  const byProject = todayPanel({ ...defaultDisplay({ kind: 'today' }), group: 'project' }, { ...at, world: calm }, cards);
  assert.equal(byProject.columns.length, 0);
  const projectHtml = panelOf(board(calm, byProject, foldGroups(overviewGroups(defaultDisplay({ kind: 'all' }), { ...at, world: calm }, cards), new Set())));
  assert.match(projectHtml, /오늘 할 일을 모두 끝냈습니다\.[\s\S]*todo-add-card[\s\S]*class="todo-done-cards"/);
  assert.doesNotMatch(panelOf(board(seen, panel, foldGroups(groups, new Set()))), /todo-today-panel\s+empty|모두 끝냈습니다/, 'with something left, as before');
});
