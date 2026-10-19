import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { english } from '../../../client/src/i18n/messages.js';
import { getLanguage, setLanguage } from '../../../client/src/i18n/i18n.js';
import { applyOps, inverseOps, worldFromOverview } from '../../../client/src/todo/todo-model.js';
import { layoutFor, readShortcut, readSwitchKey } from '../../../client/src/todo/todo-shortcuts.js';
import { moveSelection } from '../../../client/src/todo/todo-views.js';
import { isTodoPage, pageSearch, readTodoLocation, todoSearch } from '../../../client/src/todo/todo-url.js';
import { boardColumns, calendarDone, calendarTasks, cardContext, defaultDisplay, subtaskWindow, dropOps, dropPlace, foldGroups, groupingsFor, sectionDropAfter, shownTasks, manualOrder, overviewGroups, projectOrder, sectionMoveTarget, shapeSections, sidebarCounts, switchIndex, switchTargets, viewTitle, type ViewContext } from '../../../client/src/todo/todo-views.js';
import { nthOf } from '../../../client/src/todo/DatePicker.js';
import { TaskCard } from '../../../client/src/todo/TaskCard.js';
import { collisionsFor } from '../../../client/src/todo/BoardView.js';
import { PageSwitch } from '../../../client/src/todo/PageSwitch.js';
import { recurrenceLabel } from '../../../client/src/todo/todo-format.js';
import { label, overview, project, section, task } from './fixtures.js';

// Saturday.
const today = '2026-10-17';
const original = getLanguage();
test.afterEach(() => setLanguage(original));

const world = worldFromOverview(overview([
  task('a', { projectId: 'tower', sectionId: 'design', sortKey: 'b', dueDate: today, labelIds: ['call'] }),
  task('b', { projectId: 'tower', sectionId: 'design', sortKey: 'a', dueDate: '2026-10-15', priority: 1 }),
  task('c', { projectId: 'tower', sectionId: null, dueDate: '2026-10-20', dueTime: '09:00' }),
  task('c1', { projectId: 'tower', parentId: 'c', dueDate: today }),
  task('d', { projectId: 'tower', sectionId: 'gone' }),
  task('e', { projectId: 'old' }),
  task('i', { dueDate: '2026-11-30', labelIds: ['call'] }),
], {
  projects: [project('inbox', { inbox: true, name: 'Inbox' }), project('tower', { sortKey: 'b' }), project('home', { parentId: 'tower', sortKey: 'a' }), project('old', { archivedAt: 'x' })],
  sections: [section('design', 'tower', { name: '설계' })],
  labels: [label('call', { name: '전화' })],
  links: [{ id: 'l', fromTaskId: 'b', toTaskId: 'a', kind: 'next', createdAt: 'x' }],
  commentCounts: { a: 2 },
}));
const context = (patch: Partial<ViewContext> = {}): ViewContext => ({ world, today, start: today, query: '', searchResults: null, ...patch });
const ids = (columns: ReturnType<typeof boardColumns>) => columns.map(column => [column.id, column.tasks.map(item => item.id)]);

test('the address keeps the list, layout and open task, and the canvas keeps its own parameters', () => {
  assert.equal(isTodoPage('?view=todo'), true);
  assert.equal(isTodoPage('?session=x'), false);
  const location = readTodoLocation('?view=todo&todo=p:tower&task=a&layout=calendar');
  assert.deepEqual(location, { view: { kind: 'project', id: 'tower' }, layout: 'calendar', task: 'a', query: '' });
  // The page opens on everything unless the address names a list.
  assert.deepEqual(readTodoLocation('?view=todo').view, { kind: 'all' });
  assert.deepEqual(readTodoLocation('?view=todo&todo=p:../x').view, { kind: 'all' });
  assert.deepEqual(readTodoLocation('?view=todo&todo=today').view, { kind: 'today' });
  assert.deepEqual(readTodoLocation('?view=todo&todo=inbox').view, { kind: 'inbox' });
  assert.equal(todoSearch('?session=s1&todo=today', { view: { kind: 'search' }, layout: 'board', task: null, query: '보고서' }), '?session=s1&view=todo&todo=search&q=%EB%B3%B4%EA%B3%A0%EC%84%9C');
  const remembered = '?view=todo&todo=l:call&task=a';
  assert.equal(pageSearch(`${remembered}&session=s1`, 'canvas'), '?session=s1');
  assert.equal(pageSearch('?session=s1', 'todo', remembered), '?session=s1&view=todo&todo=l%3Acall&task=a');
});

test('a project shows a no-section column, its sections, and top-level tasks in their own order', () => {
  const columns = boardColumns({ kind: 'project', id: 'tower' }, defaultDisplay({ kind: 'project', id: 'tower' }), context());
  // A task of a removed section shows without one; the sub-task stays inside its card.
  assert.deepEqual(ids(columns), [['section:none', ['c', 'd']], ['section:design', ['b', 'a']]]);
  assert.equal(columns[1].sectionId, 'design');
  assert.deepEqual(columns[1].drop, { kind: 'section', projectId: 'tower', sectionId: 'design' });
  assert.equal(manualOrder(defaultDisplay({ kind: 'project', id: 'tower' })), true);
});

test('today shows overdue and today, every dated task included; archived projects never show', () => {
  const columns = boardColumns({ kind: 'today' }, defaultDisplay({ kind: 'today' }), context());
  assert.deepEqual(ids(columns), [['date:overdue', ['b']], ['date:today', ['a', 'c1']]]);
  assert.equal(columns[0].drop, null);
  const byPriority = boardColumns({ kind: 'today' }, { ...defaultDisplay({ kind: 'today' }), group: 'priority' }, context());
  assert.deepEqual(ids(byPriority).filter(([, list]) => list.length), [['priority:1', ['b']], ['priority:4', ['a', 'c1']]]);
});

test('upcoming lays out fourteen days from its start, with overdue only from today', () => {
  const columns = boardColumns({ kind: 'upcoming' }, defaultDisplay({ kind: 'upcoming' }), context());
  assert.equal(columns.length, 15);
  assert.deepEqual(ids(columns).slice(0, 2), [['date:overdue', ['b']], ['date:2026-10-17', ['a', 'c1']]]);
  assert.deepEqual(columns.find(column => column.id === 'date:2026-10-20')?.tasks.map(item => item.id), ['c']);
  const later = boardColumns({ kind: 'upcoming' }, defaultDisplay({ kind: 'upcoming' }), context({ start: '2026-10-24' }));
  assert.equal(later[0].id, 'date:2026-10-24');
  assert.equal(later.length, 14);
});

test('a label lists its tasks by project in the sidebar order', () => {
  assert.deepEqual(projectOrder(world).map(item => item.id), ['inbox', 'tower', 'home']);
  assert.deepEqual(ids(boardColumns({ kind: 'label', id: 'call' }, defaultDisplay({ kind: 'label', id: 'call' }), context())), [['project:inbox', ['i']], ['project:tower', ['a']]]);
});

test('dropping a card changes what its column stands for, and nothing when it is already there', () => {
  const a = world.tasks.a;
  assert.deepEqual(dropOps(a, { kind: 'section', projectId: 'tower', sectionId: null }, 'c'), [{ op: 'task.move', id: 'a', projectId: 'tower', sectionId: null, parentId: null, afterId: 'c' }]);
  assert.deepEqual(dropOps(a, { kind: 'section', projectId: 'tower', sectionId: 'design' }), []);
  assert.deepEqual(dropOps(a, { kind: 'date', date: '2026-10-18' }), [{ op: 'task.update', id: 'a', patch: { dueDate: '2026-10-18' } }]);
  assert.deepEqual(dropOps(a, { kind: 'priority', priority: 2 }), [{ op: 'task.update', id: 'a', patch: { priority: 2 } }]);
  assert.deepEqual(dropOps(a, { kind: 'project', projectId: 'tower' }), []);
});

test('the sidebar counts open top-level tasks per project and every task due by today', () => {
  const counts = sidebarCounts(world, today);
  assert.equal(counts.inbox, 1);
  assert.equal(counts.projects.tower, 4);
  assert.equal(counts.projects.old, undefined);
  assert.equal(counts.today, 3);
  assert.equal(counts.overdue, 1);
  assert.equal(counts.labels.call, 2);
});

test('a card shows only the properties it has, with the next-task count and its comments', () => {
  const render = (id: string, showProject = false) => renderToStaticMarkup(createElement(TaskCard, { task: world.tasks[id], context: cardContext(world, today, showProject), onOpen() {}, onComplete() {}, onCompleteNext() {} }));
  const b = render('b');
  assert.match(b, /todo-check p1/);
  assert.match(b, /class="todo-chip date overdue"/);
  assert.match(b, /다음 1/);
  assert.doesNotMatch(b, /todo-chip deadline|todo-chip label|todo-chip project/);
  const a = render('a', true);
  assert.match(a, /오늘/);
  assert.match(a, /@전화/);
  assert.match(a, /title="댓글"[^>]*>.*2/);
  assert.match(a, /todo-chip project/);
  assert.match(render('c'), /하위 작업 1/);
});

test('a card lists three sub-tasks in their order, from the done one before the first open one', () => {
  // `d` done, `o` open, in sibling order; the ids shown.
  const shown = (marks: string) => {
    const list = [...marks].map((mark, index) => ({ id: index + 1, completedAt: mark === 'd' ? 'x' : null }));
    const { shown, more } = subtaskWindow(list);
    return `${shown.map(item => item.id).join(',')} +${more}`;
  };
  assert.equal(shown('ddoooo'), '2,3,4 +3', 'the owner’s example: 1–6 with 1 and 2 done');
  assert.equal(shown('oooooo'), '1,2,3 +3', 'nothing done: the first three');
  assert.equal(shown('dddddo'), '4,5,6 +3', 'one open left: the last three');
  assert.equal(shown('dddddd'), '4,5,6 +3', 'all done: the last three');
  assert.equal(shown('dodoo'), '1,2,3 +2', 'done ones among the open: a run in order from the first open one');
  assert.equal(shown('odd'), '1,2,3 +0', 'three or fewer: all of them');
  assert.equal(shown(''), ' +0');
});

test('a card shows its sub-task window, done ones struck through, and how many more the detail has', () => {
  const parent = task('p', { content: 'Parent' });
  const subtasks = [1, 2, 3, 4, 5, 6].map(n => task(`p${n}`, { parentId: 'p', content: `Step ${n}`, sortKey: `${n}`, ...(n <= 2 ? { completedAt: 'x' } : {}) }));
  const many = worldFromOverview(overview([parent, ...subtasks.filter(item => !item.completedAt)], { doneSubtasks: subtasks.filter(item => item.completedAt), subtaskCounts: { p: { done: 2, total: 6 } } }));
  const html = renderToStaticMarkup(createElement(TaskCard, { task: many.tasks.p, context: cardContext(many, today, false), onOpen() {}, onComplete() {}, onCompleteNext() {} }));
  assert.deepEqual([...html.matchAll(/todo-subtask-title"[^>]*>([^<]+)</g)].map(match => match[1]), ['Step 2', 'Step 3', 'Step 4']);
  assert.match(html, /<li class="done">[^]*?Step 2/);
  assert.match(html, /하위 작업 2\/6/);
  assert.match(html, /class="todo-subtask-more"[^>]*>3건 더 있음</);
  // Three or fewer: all of them, the done one too, and nothing more.
  const few = worldFromOverview(overview([parent, subtasks[2]], { doneSubtasks: [subtasks[0]], subtaskCounts: { p: { done: 1, total: 2 } } }));
  const small = renderToStaticMarkup(createElement(TaskCard, { task: few.tasks.p, context: cardContext(few, today, false), onOpen() {}, onComplete() {}, onCompleteNext() {} }));
  assert.deepEqual([...small.matchAll(/todo-subtask-title"[^>]*>([^<]+)</g)].map(match => match[1]), ['Step 1', 'Step 3']);
  assert.doesNotMatch(small, /todo-subtask-more/);
});

test('the header switch marks the page shown and labels it in either language', () => {
  assert.match(renderToStaticMarkup(createElement(PageSwitch, { page: 'todo', onChange() {} })), /aria-pressed="true"[^>]*><svg[^]*<span>할 일<\/span>/);
  setLanguage('en');
  const markup = renderToStaticMarkup(createElement(PageSwitch, { page: 'canvas', onChange() {} }));
  assert.match(markup, /<span>Canvas<\/span>/);
  assert.match(markup, /<span>Todo<\/span>/);
  assert.equal(recurrenceLabel({ freq: 'week', interval: 2, weekdays: [1, 3] }), 'Every 2 weeks Mon, Wed');
  setLanguage('ko');
  assert.equal(recurrenceLabel({ freq: 'day', interval: 3, fromCompletion: true }), '완료 후 3일마다');
  assert.equal(recurrenceLabel({ freq: 'month', interval: 1, nth: { n: -1, weekday: 5 } }), '매월 마지막 금요일');
});

test('keys: a G chord, task keys, and undo', () => {
  const key = (value: string, mods: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({ key: value, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...mods });
  assert.deepEqual(readShortcut(key('g'), false), { pending: true });
  assert.deepEqual(readShortcut(key('u'), true), { shortcut: { action: 'upcoming' }, pending: false });
  assert.deepEqual(readShortcut(key('u'), false), { pending: false });
  assert.deepEqual(readShortcut(key('E', { shiftKey: true }), false), { shortcut: { action: 'complete-next' }, pending: false });
  assert.deepEqual(readShortcut(key('3'), false), { pending: false }, 'numbers switch pages now (app/page-shortcuts.ts), never priorities');
  for (const [letter, action] of [['b', 'board'], ['c', 'calendar'], ['w', 'week'], ['m', 'month']] as const) {
    assert.deepEqual(readShortcut(key(letter), false), { shortcut: { action }, pending: false });
    // A Korean input mode gives another letter for the same key: the key's place decides.
    assert.deepEqual(readShortcut({ ...key('ㅠ'), code: `Key${letter.toUpperCase()}` }, false), { shortcut: { action }, pending: false });
  }
  assert.deepEqual(readShortcut(key('b'), true), { pending: false }, 'after G only A, T, U and I count');
  // A held layout key does not flip the page back and forth; a held arrow still moves.
  for (const held of [key('b'), key('c'), key('V', { shiftKey: true })]) assert.deepEqual(readShortcut({ ...held, repeat: true }, false), { pending: false });
  assert.deepEqual(readShortcut({ ...key('ArrowDown'), repeat: true }, false), { shortcut: { action: 'move', direction: 'down' }, pending: false });
  assert.deepEqual(readShortcut(key('M', { shiftKey: true }), false), { pending: false }, 'Shift+M stays the master\'s');
  assert.deepEqual(readShortcut(key('ArrowDown'), false), { shortcut: { action: 'move', direction: 'down' }, pending: false });
  assert.deepEqual(readShortcut(key('ArrowLeft'), false), { shortcut: { action: 'move', direction: 'left' }, pending: false });
  assert.deepEqual(readShortcut(key('z', { metaKey: true }), false), { shortcut: { action: 'undo' }, pending: false });
  assert.deepEqual(readShortcut(key('q', { metaKey: true }), false), { pending: false });
});

test('B and C go to their layout, and pressed there go back to the other', () => {
  assert.equal(layoutFor('board', 'calendar'), 'calendar');
  assert.equal(layoutFor('calendar', 'calendar'), 'board');
  assert.equal(layoutFor('calendar', 'board'), 'board');
  assert.equal(layoutFor('board', 'board'), 'calendar');
});

test('every message the Todo page shows has an English version', () => {
  const dir = join(import.meta.dirname, '../../../client/src/todo');
  const keys = new Set<string>();
  for (const name of readdirSync(dir, { recursive: true }).map(String).filter(file => /\.tsx?$/.test(file))) {
    const text = readFileSync(join(dir, name), 'utf8');
    for (const match of text.matchAll(/\bt\((['"])((?:(?!\1).)+)\1/g)) keys.add(match[2]);
    // Label tables translated where they are shown.
    for (const table of text.matchAll(/const [A-Z_]+_LABELS[^=]*=\s*\{([^}]*)\}/g)) for (const match of table[1].matchAll(/:\s*'([^']+)'/g)) keys.add(match[1]);
    for (const match of text.matchAll(/\blabel: '([^']+)'/g)) keys.add(match[1]);
  }
  assert.ok(keys.size > 100);
  assert.deepEqual([...keys].filter(key => !(key in english)), []);
});

test('moving a section one place names the section it goes after, and nothing past either end', () => {
  const sections = [section('a', 'p', { sortKey: 'a' }), section('b', 'p', { sortKey: 'b' }), section('c', 'p', { sortKey: 'c' })];
  assert.equal(sectionMoveTarget(sections, 'a', 'left'), undefined);
  assert.equal(sectionMoveTarget(sections, 'b', 'left'), null);
  assert.equal(sectionMoveTarget(sections, 'c', 'left'), 'a');
  assert.equal(sectionMoveTarget(sections, 'a', 'right'), 'b');
  assert.equal(sectionMoveTarget(sections, 'c', 'right'), undefined);
});

test('a custom monthly repeat starts from the weekday its date is', () => {
  assert.deepEqual(nthOf('2026-10-12'), { n: 2, weekday: 1 });
  assert.deepEqual(nthOf('2026-10-30'), { n: -1, weekday: 5 });
});

test('arrow keys move the chosen card through columns that have cards, from the first card when none is chosen', () => {
  const columns = [{ tasks: [] }, { tasks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }, { tasks: [] }, { tasks: [{ id: 'x' }] }, { tasks: [{ id: 'p' }, { id: 'q' }] }] as never[];
  assert.equal(moveSelection(columns, null, 'down'), 'a');
  assert.equal(moveSelection(columns, 'gone', 'right'), 'a', 'a card no longer shown starts over');
  assert.equal(moveSelection(columns, 'a', 'down'), 'b');
  assert.equal(moveSelection(columns, 'c', 'down'), 'c', 'the last card stays');
  assert.equal(moveSelection(columns, 'a', 'up'), 'a');
  assert.equal(moveSelection(columns, 'c', 'right'), 'x', 'an empty column is passed over, the last card taken when shorter');
  assert.equal(moveSelection(columns, 'x', 'right'), 'p');
  assert.equal(moveSelection(columns, 'b', 'left'), 'b', 'nothing further left');
  assert.equal(moveSelection([{ tasks: [] }] as never[], null, 'down'), null);
});

test('V offers everything, the Inbox, Today, Upcoming and the first six projects as the sidebar lists them, from 0', () => {
  assert.deepEqual(switchTargets(world), [{ kind: 'all' }, { kind: 'inbox' }, { kind: 'today' }, { kind: 'upcoming' }, { kind: 'project', id: 'tower' }, { kind: 'project', id: 'home' }],
    'a sub-project follows its parent; an archived one is left out');
  const many = worldFromOverview(overview([], { projects: [project('inbox', { inbox: true }), ...['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'].map(id => project(id, { sortKey: id }))] }));
  assert.deepEqual(switchTargets(many).map(view => view.kind === 'project' ? view.id : view.kind), ['all', 'inbox', 'today', 'upcoming', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
  // The list opens marking the list shown: the Inbox opened as its project too; none for a list it does not hold.
  assert.equal(switchIndex(world, { kind: 'project', id: 'inbox' }), 1);
  assert.equal(switchIndex(world, { kind: 'project', id: 'home' }), 5);
  assert.equal(switchIndex(world, { kind: 'all' }), 0);
  assert.equal(switchIndex(world, { kind: 'label', id: 'call' }), -1);
  assert.equal(switchIndex(many, { kind: 'project', id: 'p7' }), -1);
  const key = (value: string, code?: string, mods: Partial<{ shiftKey: boolean; metaKey: boolean; repeat: boolean }> = {}) => ({ key: value, code, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...mods });
  assert.deepEqual(readShortcut(key('v'), false), { shortcut: { action: 'views' }, pending: false });
  assert.deepEqual(readShortcut(key('ㅍ', 'KeyV'), false), { shortcut: { action: 'views' }, pending: false }, 'a Korean input mode keeps V');
  assert.deepEqual(readShortcut(key('V', 'KeyV', { shiftKey: true }), false), { shortcut: { action: 'layout' }, pending: false }, 'Shift+V still switches board and calendar');
  assert.deepEqual(readShortcut(key('v'), true), { pending: false }, 'after G only A, T, U and I count');
  assert.deepEqual(readShortcut(key('ㅁ', 'KeyA'), true), { shortcut: { action: 'all' }, pending: false }, 'G A goes to everything');
  // In the list: numbers choose the entry they number (0 is everything), one past the list is swallowed, arrows go around, Enter chooses, V closes.
  assert.deepEqual(readSwitchKey(key('1', 'Digit1'), 5, 2), { action: 'choose', index: 1 });
  assert.deepEqual(readSwitchKey(key('4', 'Numpad4'), 5, 0), { action: 'choose', index: 4 });
  assert.deepEqual(readSwitchKey(key('9', 'Digit9'), 10, 0), { action: 'choose', index: 9 }, 'the sixth project keeps 9');
  assert.equal(readSwitchKey(key('ArrowLeft', 'Numpad4'), 5, 0), undefined, 'a number pad without Num Lock is not a number');
  assert.deepEqual(readSwitchKey(key('!', 'Digit1', { shiftKey: true }), 5, 0), undefined);
  assert.equal(readSwitchKey(key('7', 'Digit7'), 5, 2), undefined, 'a number past the list does nothing');
  assert.equal(readSwitchKey(key('5', 'Digit5'), 5, 2), undefined);
  assert.deepEqual(readSwitchKey(key('0', 'Digit0'), 5, 2), { action: 'choose', index: 0 });
  assert.deepEqual(readSwitchKey(key('ArrowDown', 'ArrowDown'), 5, 4), { action: 'mark', index: 0 });
  assert.deepEqual(readSwitchKey(key('ArrowUp', 'ArrowUp'), 5, 0), { action: 'mark', index: 4 });
  assert.deepEqual(readSwitchKey(key('Enter', 'Enter'), 5, 3), { action: 'choose', index: 3 });
  assert.deepEqual(readSwitchKey(key('ㅍ', 'KeyV'), 5, 3), { action: 'close' });
  assert.equal(readSwitchKey(key('v', 'KeyV', { repeat: true }), 5, 3), undefined, 'V held down does not close the list it opened');
  assert.deepEqual(readSwitchKey(key('Enter', 'Enter'), 4, 6), { action: 'choose', index: 3 }, 'the list shrank while open');
  assert.equal(readSwitchKey(key('1', 'Digit1', { metaKey: true }), 5, 0), undefined);
  assert.equal(readSwitchKey(key('q', 'KeyQ'), 5, 0), undefined);
});

test('the overview lists the Inbox, then each shown project in the sidebar order with the columns of its own board', () => {
  const all = worldFromOverview(overview([
    task('i1', { sortKey: 'a' }), task('i2', { sortKey: 'b' }), task('i3', { sortKey: 'c' }), task('i4', { sortKey: 'd' }),
    task('done', { completedAt: 'x' }), task('removed', { deletedAt: 'x' }),
    task('t1', { projectId: 'tower', sectionId: 'design' }), task('t1a', { projectId: 'tower', sectionId: 'design', parentId: 't1' }),
    task('t2', { projectId: 'tower', sectionId: 'folded' }), task('kept', { projectId: 'tower', sectionId: 'shelved' }),
    task('h1', { projectId: 'home' }), task('o1', { projectId: 'old' }), task('u1', { projectId: 'under-old' }),
  ], {
    projects: [project('inbox', { inbox: true, name: 'Inbox' }), project('tower', { name: 'Tower', sortKey: 'b' }), project('home', { name: 'Home', parentId: 'tower' }),
      project('empty', { sortKey: 'c' }), project('old', { archivedAt: 'x', sortKey: 'a' }), project('under-old', { parentId: 'old' })],
    sections: [section('design', 'tower', { sortKey: 'a' }), section('folded', 'tower', { sortKey: 'b', collapsed: true }), section('shelved', 'tower', { sortKey: 'c', archivedAt: 'x' })],
  }));
  const at = context({ world: all });
  const display = defaultDisplay({ kind: 'all' });
  const groups = overviewGroups(display, at);
  assert.deepEqual(groups.map(group => [group.project.id, group.depth, group.parents, group.count]), [['inbox', 0, [], 4], ['tower', 0, [], 2], ['home', 1, ['Tower'], 1], ['empty', 0, [], 0]],
    'a sub-project on its own after its parent, an empty project kept to drop on; archived projects (and those under them) left out');
  assert.deepEqual(groups.map(group => group.columns.map(column => [column.id, column.tasks.map(item => item.id)])), [
    [['inbox/section:none', ['i1', 'i2', 'i3', 'i4']]],
    [['tower/section:design', ['t1']], ['tower/section:folded', []]],
    [['home/section:none', ['h1']]],
    [['empty/section:none', []]],
  ], 'completed, deleted and archived-section tasks left out; a sub-task stays in its parent card; a folded section keeps only its count; an empty "섹션 없음" shows only in a project without sections');
  const tower = (groups: ReturnType<typeof overviewGroups>) => groups.find(group => group.project.id === 'tower')!.columns;
  const folded = tower(groups).find(column => column.sectionId === 'folded')!, design = tower(groups).find(column => column.sectionId === 'design')!;
  assert.equal(folded.collapsed, true);
  assert.equal(folded.count, 1);
  // The same columns as the project's own board, but for the ids that name their project; the board keeps its empty
  // "섹션 없음", to add to and drop on.
  const own = shapeSections(boardColumns({ kind: 'project', id: 'tower' }, defaultDisplay({ kind: 'project', id: 'tower' }), at), all.sections.filter(item => item.projectId === 'tower'), { collapse: true, showArchived: false }).columns;
  assert.deepEqual(own.map(column => [column.id, column.tasks.length]).slice(0, 1), [['section:none', 0]]);
  assert.deepEqual(tower(groups).map(column => ({ ...column, id: '' })), own.slice(1).map(column => ({ ...column, id: '' })));
  assert.deepEqual(design.drop, { kind: 'section', projectId: 'tower', sectionId: 'design' });
  assert.deepEqual(design.preset, { projectId: 'tower', sectionId: 'design' });
  // A task added without a section (a quick add) shows the project's "섹션 없음" first.
  const loose = { ...all, tasks: { ...all.tasks, t3: task('t3', { projectId: 'tower' }) } };
  assert.deepEqual(tower(overviewGroups(display, context({ world: loose }))).map(column => [column.id, column.tasks.map(item => item.id)]),
    [['tower/section:none', ['t3']], ['tower/section:design', ['t1']], ['tower/section:folded', []]]);
  // The overview is grouped by sections only, without a completed list; its calendar shows every open task.
  assert.deepEqual(groupingsFor({ kind: 'all' }), ['section']);
  assert.deepEqual(calendarTasks({ kind: 'all' }, at).map(item => item.id).sort(), ['h1', 'i1', 'i2', 'i3', 'i4', 't1', 't1a', 't2']);
  assert.equal(viewTitle({ kind: 'all' }, all, ''), '전체');
  assert.deepEqual(readTodoLocation('?view=todo&todo=all').view, { kind: 'all' });
  assert.equal(todoSearch('', { view: { kind: 'all' }, layout: 'calendar', task: null, query: '' }), '?view=todo&todo=all&layout=calendar');
});

test('a card let go on a card takes its place; on a folded column, or the empty space of an overview column, it goes first', () => {
  const column = (id: string, tasks: string[], patch: { collapsed?: boolean } = {}) => ({ id, tasks: tasks.map(item => task(item)), ...patch });
  const inbox = column('inbox', ['a', 'b']), target = column('target', ['x', 'y', 'z', 'w', 'v']);
  const manual = { manual: true, emptyFirst: false }, overviewDrop = { manual: true, emptyFirst: true };
  assert.deepEqual(dropPlace('a', inbox, target, 'y', manual), { afterId: 'x' }, 'before the card it is let go on');
  assert.deepEqual(dropPlace('a', inbox, target, 'x', manual), { afterId: null });
  assert.deepEqual(dropPlace('a', inbox, target, 'z', overviewDrop), { afterId: 'y' }, 'the third card of a column that shows three');
  assert.deepEqual(dropPlace('a', inbox, target, undefined, manual), { afterId: 'v' }, 'a project board: the empty space is the end');
  assert.deepEqual(dropPlace('a', inbox, target, undefined, overviewDrop), { afterId: null }, 'the overview: the empty space is the top');
  assert.deepEqual(dropPlace('a', inbox, column('folded', [], { collapsed: true }), undefined, manual), { afterId: null }, 'a folded section: the top, on a project board too');
  assert.deepEqual(dropPlace('a', inbox, column('empty', []), undefined, manual), { afterId: null });
  // Within its own column.
  assert.equal(dropPlace('x', target, target, 'x', manual), null, 'let go where it was');
  assert.deepEqual(dropPlace('x', target, target, 'z', manual), { afterId: 'z' }, 'down: after the card it is let go on');
  assert.deepEqual(dropPlace('w', target, target, 'y', manual), { afterId: 'x' }, 'up: before it');
  assert.equal(dropPlace('v', target, target, undefined, manual), null, 'the last card let go on the empty space stays');
  assert.equal(dropPlace('x', target, target, undefined, overviewDrop), null, 'the first card let go on the empty space of the overview stays');
  assert.deepEqual(dropPlace('z', target, target, undefined, overviewDrop), { afterId: null });
  // Without an order kept by hand, only another column changes anything: where the server puts it, but first on a
  // folded section or the overview.
  assert.deepEqual(dropPlace('a', inbox, target, 'y', { manual: false, emptyFirst: false }), { afterId: undefined });
  assert.deepEqual(dropPlace('a', inbox, column('folded', [], { collapsed: true }), undefined, { manual: false, emptyFirst: false }), { afterId: null });
  assert.deepEqual(dropPlace('a', inbox, target, 'y', { manual: false, emptyFirst: true }), { afterId: null });
  assert.equal(dropPlace('a', inbox, inbox, 'b', { manual: false, emptyFirst: true }), null);
});

test('a task moved to another project section takes its sub-tasks along, and undoing brings them all back', () => {
  const start = worldFromOverview(overview([
    task('p', { sortKey: 'a' }), task('p1', { parentId: 'p' }), task('p2', { parentId: 'p1' }), task('q', { sortKey: 'b' }),
    task('s1', { projectId: 'tower', sectionId: 'design', sortKey: 'a' }),
  ], { projects: [project('inbox', { inbox: true }), project('tower')], sections: [section('design', 'tower')] }));
  const target = overviewGroups(defaultDisplay({ kind: 'all' }), context({ world: start }))[1].columns.find(column => column.sectionId === 'design')!;
  const ops = dropOps(start.tasks.p, target.drop!, null);
  assert.deepEqual(ops, [{ op: 'task.move', id: 'p', projectId: 'tower', sectionId: 'design', parentId: null, afterId: null }]);
  const moved = applyOps(start, ops, { now: 'later', today });
  assert.deepEqual(['p', 'p1', 'p2'].map(id => [moved.tasks[id].projectId, moved.tasks[id].sectionId]), Array(3).fill(['tower', 'design']));
  assert.equal(moved.tasks.p.sortKey < moved.tasks.s1.sortKey, true, 'first in the section');
  assert.deepEqual([moved.tasks.p1.parentId, moved.tasks.p2.parentId], ['p', 'p1']);
  const back = applyOps(moved, inverseOps(start, ops, () => 'new')!, { now: 'later', today });
  assert.deepEqual(['p', 'p1', 'p2'].map(id => [back.tasks[id].projectId, back.tasks[id].sectionId]), Array(3).fill(['inbox', null]));
  assert.equal(back.tasks.p.sortKey < back.tasks.q.sortKey, true, 'back in its place');
});

test('a section moves only among its own project sections', () => {
  const lists = [['a1', 'a2', 'a3'], ['b1', 'b2']];
  assert.equal(sectionDropAfter(lists, 'a3', 'a1'), null, 'first');
  assert.equal(sectionDropAfter(lists, 'a1', 'a3'), 'a3', 'last');
  assert.equal(sectionDropAfter(lists, 'b2', 'b1'), null, "the next project's first, never after the last of the one before");
  assert.equal(sectionDropAfter(lists, 'a2', 'a2'), undefined);
  assert.equal(sectionDropAfter(lists, 'a2', 'b1'), undefined, "another project's section");
  assert.equal(sectionDropAfter(lists, 'b1', 'task:x'), undefined);
});

test('the overview shows the first three cards of a column until it is opened, and the arrow keys only those', () => {
  const many = worldFromOverview(overview(['a', 'b', 'c', 'd', 'e'].map(id => task(id)).concat(task('t', { projectId: 'tower' })), { projects: [project('inbox', { inbox: true }), project('tower')] }));
  const groups = overviewGroups(defaultDisplay({ kind: 'all' }), context({ world: many }));
  const folded = foldGroups(groups, new Set());
  assert.deepEqual(folded.flatMap(group => group.columns).map(column => [column.id, column.shown, shownTasks(column).map(item => item.id)]), [['inbox/section:none', 3, ['a', 'b', 'c']], ['tower/section:none', 3, ['t']]]);
  const opened = foldGroups(groups, new Set(['inbox/section:none']));
  assert.deepEqual(shownTasks(opened[0].columns[0]).map(item => item.id), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(opened[1].columns[0].shown, 3, 'only the column opened');
  // What the arrow keys go through: the cards shown.
  const visible = folded.flatMap(group => group.columns).map(column => ({ tasks: shownTasks(column) }));
  assert.equal(moveSelection(visible, 'c', 'down'), 'c', 'never down to a folded card');
  assert.equal(moveSelection(visible, 'c', 'right'), 't');
});

test('on the overview a card let go off every column lands nowhere, not in the nearest project', () => {
  const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const droppableRects = new Map<string, ReturnType<typeof rect>>([['column:inbox/section:none', rect(0, 0, 280, 200)], ['column:tower/section:none', rect(0, 300, 280, 200)]]);
  const droppableContainers = [...droppableRects.keys()].map(id => ({ id, rect: { current: droppableRects.get(id) }, data: { current: {} }, disabled: false, node: { current: null } })) as never[];
  const args = (pointer: { x: number; y: number } | null) => ({ active: { id: 'task:a' } as never, collisionRect: rect(0, 250, 100, 30), droppableRects: droppableRects as never, droppableContainers, pointerCoordinates: pointer });
  assert.deepEqual(collisionsFor(true)(args({ x: 50, y: 260 })), [], 'between two projects');
  assert.equal(collisionsFor(true)(args({ x: 50, y: 320 }))[0]?.id, 'column:tower/section:none');
  assert.ok(collisionsFor(false)(args({ x: 50, y: 260 })).length > 0, 'a project board takes the nearest column');
  assert.ok(collisionsFor(true)(args(null)).length > 0, 'a keyboard drag has no pointer and goes to the nearest');
});

test('the calendar shows completions by default, and leaves out those of archived projects and sections like its open tasks', () => {
  assert.equal(defaultDisplay({ kind: 'inbox' }).done, true);
  const world = worldFromOverview(overview([], {
    projects: [project('inbox', { inbox: true }), project('old', { archivedAt: '2026-10-01T00:00:00.000Z' }), project('p')],
    sections: [section('shelf', 'p', { archivedAt: '2026-10-01T00:00:00.000Z' })],
  }));
  const item = (id: string, patch: Parameters<typeof task>[1] = {}) => ({ completion: { id, taskId: id, occurrenceDate: null, completedAt: '2026-10-14T01:00:00.000Z' }, task: task(id, patch) });
  const items = [item('a'), item('b', { projectId: 'old' }), item('c', { projectId: 'p', sectionId: 'shelf' }), item('d', { projectId: 'p' })];
  assert.deepEqual(calendarDone(items, world).map(entry => entry.task.id), ['a', 'd']);
  // An archived project opened to be read shows its own.
  assert.deepEqual(calendarDone(items, world, true).map(entry => entry.task.id), ['a', 'b', 'c', 'd']);
});
