import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { english } from '../../../client/src/i18n/messages.js';
import { getLanguage, setLanguage } from '../../../client/src/i18n/i18n.js';
import { worldFromOverview } from '../../../client/src/todo/todo-model.js';
import { readShortcut, readSwitchKey } from '../../../client/src/todo/todo-shortcuts.js';
import { moveSelection } from '../../../client/src/todo/todo-views.js';
import { isTodoPage, pageSearch, readTodoLocation, todoSearch } from '../../../client/src/todo/todo-url.js';
import { boardColumns, cardContext, defaultDisplay, dropOps, manualOrder, projectOrder, sectionMoveTarget, sidebarCounts, switchTargets, type ViewContext } from '../../../client/src/todo/todo-views.js';
import { nthOf } from '../../../client/src/todo/DatePicker.js';
import { TaskCard } from '../../../client/src/todo/TaskCard.js';
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
  // The page opens on the Inbox unless the address names a list.
  assert.deepEqual(readTodoLocation('?view=todo').view, { kind: 'inbox' });
  assert.deepEqual(readTodoLocation('?view=todo&todo=p:../x').view, { kind: 'inbox' });
  assert.deepEqual(readTodoLocation('?view=todo&todo=today').view, { kind: 'today' });
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
  assert.deepEqual(readShortcut(key('b'), true), { pending: false }, 'after G only T, U and I count');
  assert.deepEqual(readShortcut(key('M', { shiftKey: true }), false), { pending: false }, 'Shift+M stays the master\'s');
  assert.deepEqual(readShortcut(key('ArrowDown'), false), { shortcut: { action: 'move', direction: 'down' }, pending: false });
  assert.deepEqual(readShortcut(key('ArrowLeft'), false), { shortcut: { action: 'move', direction: 'left' }, pending: false });
  assert.deepEqual(readShortcut(key('z', { metaKey: true }), false), { shortcut: { action: 'undo' }, pending: false });
  assert.deepEqual(readShortcut(key('q', { metaKey: true }), false), { pending: false });
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

test('V offers the Inbox, Today, Upcoming and the first six projects as the sidebar lists them', () => {
  assert.deepEqual(switchTargets(world), [{ kind: 'inbox' }, { kind: 'today' }, { kind: 'upcoming' }, { kind: 'project', id: 'tower' }, { kind: 'project', id: 'home' }],
    'a sub-project follows its parent; an archived one is left out');
  const many = worldFromOverview(overview([], { projects: [project('inbox', { inbox: true }), ...['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'].map(id => project(id, { sortKey: id }))] }));
  assert.deepEqual(switchTargets(many).map(view => view.kind === 'project' ? view.id : view.kind), ['inbox', 'today', 'upcoming', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
  const key = (value: string, code?: string, mods: Partial<{ shiftKey: boolean; metaKey: boolean; repeat: boolean }> = {}) => ({ key: value, code, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...mods });
  assert.deepEqual(readShortcut(key('v'), false), { shortcut: { action: 'views' }, pending: false });
  assert.deepEqual(readShortcut(key('ㅍ', 'KeyV'), false), { shortcut: { action: 'views' }, pending: false }, 'a Korean input mode keeps V');
  assert.deepEqual(readShortcut(key('V', 'KeyV', { shiftKey: true }), false), { shortcut: { action: 'layout' }, pending: false }, 'Shift+V still switches board and calendar');
  assert.deepEqual(readShortcut(key('v'), true), { pending: false }, 'after G only T, U and I count');
  // In the list: numbers choose, one past the list is swallowed, arrows go around, Enter chooses, V closes.
  assert.deepEqual(readSwitchKey(key('1', 'Digit1'), 5, 2), { action: 'choose', index: 0 });
  assert.deepEqual(readSwitchKey(key('4', 'Numpad4'), 5, 0), { action: 'choose', index: 3 });
  assert.equal(readSwitchKey(key('ArrowLeft', 'Numpad4'), 5, 0), undefined, 'a number pad without Num Lock is not a number');
  assert.deepEqual(readSwitchKey(key('!', 'Digit1', { shiftKey: true }), 5, 0), undefined);
  assert.deepEqual(readSwitchKey(key('7', 'Digit7'), 5, 2), { mark: 2 });
  assert.deepEqual(readSwitchKey(key('ArrowDown', 'ArrowDown'), 5, 4), { mark: 0 });
  assert.deepEqual(readSwitchKey(key('ArrowUp', 'ArrowUp'), 5, 0), { mark: 4 });
  assert.deepEqual(readSwitchKey(key('Enter', 'Enter'), 5, 3), { action: 'choose', index: 3 });
  assert.deepEqual(readSwitchKey(key('ㅍ', 'KeyV'), 5, 3), { action: 'close' });
  assert.equal(readSwitchKey(key('1', 'Digit1', { metaKey: true }), 5, 0), undefined);
  assert.equal(readSwitchKey(key('q', 'KeyQ'), 5, 0), undefined);
});
