import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TodoOp } from '../../../shared/todo/ops.js';
import { importOutcome, saveWithFiles } from '../../../client/src/todo/QuickAdd.js';
import { activityText, shareItems } from '../../../client/src/todo/TaskDetail.js';
import { subtaskToggleText } from '../../../client/src/todo/TaskCard.js';
import { CalendarView } from '../../../client/src/todo/calendar/CalendarView.js';
import { archivedColumns, dayAfterOf, shapeSections, taskLocked } from '../../../client/src/todo/todo-views.js';
import { compareDay } from '../../../shared/todo/day-order.js';
import { createActions, taskLink } from '../../../client/src/todo/todo-actions.js';
import { emptyWorld, worldFromOverview, type TodoWorld } from '../../../client/src/todo/todo-model.js';
import { labelStepOp, moveUnderCandidates, outOfParentOp, parentCandidates, projectStepOp, subtaskReorderOp } from '../../../client/src/todo/todo-moves.js';
import { boardColumns, defaultDisplay } from '../../../client/src/todo/todo-views.js';
import { label, overview, project, section, task } from './fixtures.js';

const world = (tasks: ReturnType<typeof task>[], patch: Parameters<typeof overview>[1] = {}) => worldFromOverview(overview(tasks, patch), emptyWorld());

test('Quick Add with files saves the task first, then uploads the files to it; a refused save uploads nothing', async () => {
  const ops: TodoOp[] = [{ op: 'task.create', id: 't1', content: 'Plan' }];
  const files = [new File(['x'], 'a.png')];
  const steps: string[] = [];
  const attach = (id: string, picked: File[]) => steps.push(`attach ${id} ${picked.map(file => file.name).join()}`);
  const saving = (ok: boolean) => ({ applyAndWait: async (sent: TodoOp[]) => { steps.push(`save ${sent.length}`); return ok; } });
  assert.equal(await saveWithFiles(saving(true), attach, ops, 't1', files), true);
  assert.deepEqual(steps, ['save 1', 'attach t1 a.png'], 'saved, then uploaded to the saved task');
  steps.length = 0;
  assert.equal(await saveWithFiles(saving(false), attach, ops, 't1', files), false, 'the dialog keeps the task and its files');
  assert.deepEqual(steps, ['save 1']);
});

test('a sub-task is put in order among its siblings, moved out next to its top task, and under no task of its own', () => {
  const parent = task('p'), a = task('a', { parentId: 'p', sortKey: 'a' }), b = task('b', { parentId: 'p', sortKey: 'b' }), c = task('c', { parentId: 'p', sortKey: 'c' });
  assert.deepEqual(subtaskReorderOp([a, b, c], 'c', 'a'), { op: 'task.move', id: 'c', parentId: 'p', afterId: null });
  assert.deepEqual(subtaskReorderOp([a, b, c], 'a', 'c'), { op: 'task.move', id: 'a', parentId: 'p', afterId: 'c' });
  assert.deepEqual(subtaskReorderOp([a, b, c], 'a', 'b'), { op: 'task.move', id: 'a', parentId: 'p', afterId: 'b' });
  assert.equal(subtaskReorderOp([a, b, c], 'b', 'b'), null);
  const deep = task('d', { parentId: 'a' });
  const tasks = Object.fromEntries([parent, a, b, c, deep].map(item => [item.id, item]));
  assert.deepEqual(outOfParentOp(tasks, deep), { op: 'task.move', id: 'd', parentId: null, afterId: 'p' }, 'after the task at the top');
  assert.equal(outOfParentOp(tasks, parent), null);
  const done = task('x', { completedAt: '2026-10-14T01:00:00.000Z' }), other = task('o');
  assert.deepEqual(moveUnderCandidates(tasks, a, [parent, a, deep, b, done, other]).map(item => item.id), ['b', 'o'], 'not its parent, itself, one below it, or a completed one');
});

test('a project moves under one that keeps three levels, never under itself or below; projects and labels step among siblings', () => {
  const shape = world([], { projects: [
    project('inbox', { inbox: true }), project('a', { sortKey: 'a' }), project('a1', { parentId: 'a', sortKey: 'a1' }), project('a11', { parentId: 'a1' }),
    project('b', { sortKey: 'b' }), project('b1', { parentId: 'b' }), project('c', { sortKey: 'c' }), project('z', { sortKey: 'z', archivedAt: '2026-10-14T00:00:00.000Z' }),
  ] });
  const names = (id: string) => parentCandidates(shape, id).map(item => item?.id ?? 'top');
  assert.deepEqual(names('c'), ['a', 'a1', 'b', 'b1'], 'a top project with no children goes under a first or second level one');
  assert.deepEqual(names('b'), ['a', 'c'], 'one with a child goes under a top project only');
  assert.deepEqual(names('a'), [], 'a three-level tree stays at the top');
  assert.deepEqual(names('a11'), ['top', 'a', 'b', 'b1', 'c'], 'not its present parent; the top level is offered');
  assert.deepEqual(projectStepOp(shape.projects, shape.projects.find(item => item.id === 'b')!, 'up'), { op: 'project.move', id: 'b', afterId: null });
  assert.deepEqual(projectStepOp(shape.projects, shape.projects.find(item => item.id === 'b')!, 'down'), { op: 'project.move', id: 'b', afterId: 'c' });
  assert.equal(projectStepOp(shape.projects, shape.projects.find(item => item.id === 'c')!, 'down'), null, 'an archived project is not a place to pass');
  const labels = [label('x', { sortKey: 'x' }), label('y', { sortKey: 'y' })];
  assert.deepEqual(labelStepOp(labels, 'y', 'up'), { op: 'label.move', id: 'y', afterId: null });
  assert.equal(labelStepOp(labels, 'x', 'up'), null);
});

test('the sub-task toggle counts done of all from the server, else the open ones listed', () => {
  const plain = world([task('p')]);
  assert.equal(subtaskToggleText(plain, 'p', 2), '하위 작업 2');
  const counted = { ...plain, subtaskCounts: { p: { done: 2, total: 5 } } } as TodoWorld;
  assert.equal(subtaskToggleText(counted, 'p', 3), '하위 작업 2/5');
});

test('the activity names the fields a change touched, when the server named them', () => {
  assert.equal(activityText({ kind: 'updated', detail: { fields: ['dueDate', 'priority'] } }), '날짜·우선순위를 고쳤습니다');
  assert.equal(activityText({ kind: 'updated', detail: { fields: ['content'] } }), '제목을 고쳤습니다');
  assert.equal(activityText({ kind: 'updated', detail: { fields: ['slackThread'] } }), 'Slack 스레드를 고쳤습니다');
  assert.equal(activityText({ kind: 'moved', detail: { projectId: 'p', sectionId: null, parentId: null } }), '옮겼습니다');
  assert.equal(activityText({ kind: 'moved', detail: { day: '2026-10-17' } }), '순서를 바꿨습니다');
  assert.equal(activityText({ kind: 'updated', detail: {} }), '고쳤습니다');
  assert.equal(activityText({ kind: 'completed', detail: { fields: ['x'] } }), '완료했습니다');
});

test('a task menu duplicates the task and copies a link that opens it in the list shown', async () => {
  const sent: TodoOp[][] = [];
  const toasts: string[] = [];
  const client = { apply: (ops: TodoOp[]) => { sent.push(ops); return true; }, toast: (text: string) => { toasts.push(text); return 1; }, undoActions: () => [], getState: () => ({ world: emptyWorld() }), today: () => '2026-10-14' };
  const actions = createActions(client as never, { openTask() {} });
  const item = task('t1', { content: 'Plan' });
  const items = shareItems(item, actions);
  assert.deepEqual(items.map(entry => entry.key), ['duplicate', 'copy-link']);
  items[0].run();
  const op = sent[0][0] as unknown as { op: string; id: string; copyId: string };
  assert.equal(op.op, 'task.duplicate');
  assert.equal(op.id, 't1');
  assert.ok(op.copyId && op.copyId !== 't1', 'the copy gets a new id from the page');
  const place = { origin: 'http://localhost:8123', pathname: '/', search: '?view=todo&todo=l%3Ax&q=ignored' };
  assert.equal(taskLink(place, 't1'), 'http://localhost:8123/?view=todo&todo=l%3Ax&task=t1');
  const written: string[] = [];
  await actions.copyLink(item, place, { writeText: async (text: string) => { written.push(text); } });
  assert.deepEqual(written, ['http://localhost:8123/?view=todo&todo=l%3Ax&task=t1']);
  await actions.copyLink(item, place, { writeText: async () => { throw new Error('denied'); } });
  assert.deepEqual(toasts.slice(-2), ['링크를 복사했습니다.', '링크를 복사하지 못했습니다.']);
});

test('a calendar entry\'s check circle sits beside the button that opens it, never inside it', () => {
  const item = task('t1', { content: 'Plan', dueDate: '2026-10-14' });
  const shape = world([item]);
  const render = (readOnly: boolean) => renderToStaticMarkup(createElement(CalendarView, { tasks: [item], world: shape, today: '2026-10-14', mode: 'month', future: false, colorBy: 'priority', mobile: false, readOnly,
    onMode() {}, onOpen() {}, onAdd() {}, onChange() {}, onComplete() {} }));
  const markup = render(false);
  const entry = /<button[^>]*class="todo-cal-entry[^"]*"[^>]*>(.*?)<\/button>/s.exec(markup);
  assert.ok(entry, 'the entry shows');
  assert.doesNotMatch(entry[1], /todo-cal-check/, 'no button inside the entry button');
  assert.match(markup, /<span class="todo-cal-item compact"><button type="button" class="todo-cal-check p4"[^>]*aria-label="“Plan” 완료"/);
  assert.doesNotMatch(render(true), /todo-cal-check/, 'a calendar that only shows has none');
});

test('a collapsed section keeps its header and count, an archived one leaves the board until asked; an archived project reads only', () => {
  const sections = [section('s1', 'p', { collapsed: true }), section('s2', 'p', { archivedAt: '2026-10-14T00:00:00.000Z' })];
  const tasks = [task('a', { projectId: 'p', sectionId: 's1' }), task('b', { projectId: 'p', sectionId: 's2' }), task('c', { projectId: 'p' })];
  const shape = world(tasks, { projects: [project('inbox', { inbox: true }), project('p')], sections });
  const view = { kind: 'project', id: 'p' } as const;
  const context = { world: shape, today: '2026-10-14', start: '2026-10-14', query: '', searchResults: null };
  const base = boardColumns(view, defaultDisplay(view), context);
  const hidden = shapeSections(base, sections, { collapse: true, showArchived: false, tasks });
  assert.equal(hidden.archived, 1);
  assert.deepEqual(hidden.columns.map(column => [column.id, column.tasks.map(item => item.id), column.note ?? '']), [['section:none', ['c'], ''], ['section:s1', [], '접힘 · 1']]);
  assert.ok(hidden.columns[1].drop, 'a collapsed column still takes cards');
  const shown = shapeSections(base, sections, { collapse: true, showArchived: true, tasks });
  assert.deepEqual(shown.columns.at(-1)?.tasks.map(item => item.id), ['b']);
  assert.equal(shown.columns.at(-1)?.drop, null, 'read only');
  const archived = world(tasks, { projects: [project('inbox', { inbox: true }), project('p', { archivedAt: '2026-10-14T00:00:00.000Z' })], sections });
  const locked = archivedColumns(view, defaultDisplay(view), { ...context, world: archived }, 'p');
  assert.deepEqual(locked.flatMap(column => column.tasks.map(item => item.id)).sort(), ['a', 'c'], 'its tasks show though the lists leave archived projects out');
  const lockedShown = shapeSections(locked, sections, { collapse: true, showArchived: true, tasks });
  assert.deepEqual(lockedShown.columns.flatMap(column => column.tasks.map(item => item.id)).sort(), ['a', 'b', 'c'], 'an archived section’s task with its section, not without one');
  assert.ok(locked.every(column => column.drop === null && !column.sectionId), 'nothing drops, no section menu');
});

test('an archived section’s tasks read only wherever they show, and leave the date lists', () => {
  const sections = [section('s1', 'p'), section('s2', 'p', { archivedAt: '2026-10-14T00:00:00.000Z' })];
  const tasks = [task('a', { projectId: 'p', sectionId: 's1', dueDate: '2026-10-14' }), task('b', { projectId: 'p', sectionId: 's2', dueDate: '2026-10-14' })];
  const shape = world(tasks, { projects: [project('inbox', { inbox: true }), project('p'), project('old', { archivedAt: '2026-10-14T00:00:00.000Z' })], sections });
  assert.deepEqual([taskLocked(shape, tasks[0]), taskLocked(shape, tasks[1]), taskLocked(shape, task('c', { projectId: 'old' })), taskLocked(shape, undefined)], [false, true, true, false]);
  const view = { kind: 'today' } as const;
  const columns = boardColumns(view, defaultDisplay(view), { world: shape, today: '2026-10-14', start: '2026-10-14', query: '', searchResults: null });
  assert.deepEqual(columns.flatMap(column => column.tasks.map(item => item.id)), ['a']);
});

test('in a column of several dates the dates stay together, and a drop finds the task it goes after within its date', () => {
  const order = [
    task('x', { dueDate: '2026-10-01', priority: 1 }), task('y', { dueDate: '2026-10-01' }),
    task('c', { dueDate: '2026-10-10', dayOrder: '2026-10-10|b' }), task('d', { dueDate: '2026-10-10', dayOrder: '2026-10-10|a' }),
  ].sort(compareDay);
  assert.deepEqual(order.map(item => item.id), ['x', 'y', 'd', 'c'], 'an earlier date first, though its tasks have no order of their own');
  assert.equal(dayAfterOf(order, 'c', 'd'), null, 'first of its date');
  assert.equal(dayAfterOf(order, 'd', 'c'), 'c');
  assert.equal(dayAfterOf(order, 'y', 'x'), null);
  assert.equal(dayAfterOf(order, 'c', 'y'), undefined, 'another date is a change of date, not of order');
});

test('after bringing an issue in, only a todo it made takes the picked files; one already synced says what was not done', () => {
  assert.deepEqual(importOutcome({ taskId: 'a', moved: true }, { title: 'Crash', place: 'Work' }), { attach: true, open: false, messages: ['GitHub 이슈를 “Work”에 가져왔습니다: Crash'] });
  assert.deepEqual(importOutcome({ taskId: 'a' }, { title: 'Crash', notCompleted: 'Step one' }), { attach: true, open: false, messages: ['GitHub 이슈를 가져왔습니다: Crash'] });
  assert.deepEqual(importOutcome({ taskId: 'b', existing: { content: 'Crash', state: 'open' } }, {}), { attach: false, open: true, messages: ['이 이슈와 연결된 할 일이 이미 있습니다: Crash'] });
  assert.deepEqual(importOutcome({ taskId: 'b', existing: { content: 'Crash', state: 'deleted' } }, { notCompleted: 'Step one' }),
    { attach: false, open: false, messages: ['이 이슈는 삭제한 할 일 “Crash”과 연결되어 있습니다.', '“Step one”은(는) 완료하지 않았습니다.'] });
});
