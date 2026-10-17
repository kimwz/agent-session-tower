import test from 'node:test';
import assert from 'node:assert/strict';
import { compareDay, dayBefore, dayKey, reorderDay, type DayTask } from '../../../shared/todo/day-order.js';

const D = '2026-10-17';
const task = (id: string, patch: Partial<DayTask> = {}): DayTask => ({ id, sortKey: id, dueDate: D, dueTime: null, priority: 4, dayOrder: null, ...patch });
const order = (tasks: DayTask[]) => [...tasks].sort(compareDay).map(item => item.id);
/** The tasks with the values `reorderDay` answered. */
const after = (tasks: DayTask[], id: string, afterId: string | null) => {
  const values = new Map(reorderDay(tasks, id, afterId).map(item => [item.id, item.dayOrder]));
  return tasks.map(item => ({ ...item, dayOrder: values.get(item.id) ?? item.dayOrder }));
};

test('a key counts only while its date is the task’s date and it is a valid order key', () => {
  assert.equal(dayKey(task('a', { dayOrder: `${D}|V` })), 'V');
  assert.equal(dayKey(task('a', { dayOrder: '2026-10-16|V' })), null);
  assert.equal(dayKey(task('a', { dayOrder: `${D}|` })), null);
  assert.equal(dayKey(task('a', { dayOrder: `${D}V` })), null);
  assert.equal(dayKey(task('a', { dayOrder: `${D}|V`, dueDate: null })), null);
});

test('tasks put in order come first in that order; the rest by time, priority and their own order', () => {
  const tasks = [task('a', { dueTime: '09:00' }), task('b', { priority: 1 }), task('c'), task('d', { dayOrder: `${D}|k` }), task('e', { dayOrder: `${D}|a` }), task('f', { dayOrder: '2026-10-01|0' })];
  assert.deepEqual(order(tasks), ['e', 'd', 'a', 'b', 'c', 'f']);
  // Across dates (an overdue column), keyed tasks go by date first.
  assert.deepEqual(order([task('x', { dueDate: '2026-10-18', dayOrder: '2026-10-18|1' }), task('y', { dayOrder: `${D}|z` })]), ['y', 'x']);
});

test('the first move keys the whole date in its new order; later moves key only the moved task', () => {
  const tasks = [task('a', { dueTime: '09:00' }), task('b', { priority: 1 }), task('c'), task('d')];
  const first = reorderDay(tasks, 'd', 'a');
  assert.deepEqual(first.map(item => item.id), ['a', 'd', 'b', 'c']);
  assert.ok(first.every(item => item.dayOrder.startsWith(`${D}|`)));
  const keyed = after(tasks, 'd', 'a');
  assert.deepEqual(order(keyed), ['a', 'd', 'b', 'c']);
  const second = after(keyed, 'c', null);
  assert.deepEqual(order(second), ['c', 'a', 'd', 'b']);
  assert.deepEqual(second.filter((item, index) => item.dayOrder !== keyed[index].dayOrder).map(item => item.id), ['c']);
  // An anchor not of the date puts it last; tasks of other dates are left alone.
  const other = [...second, task('z', { dueDate: '2026-10-18' })];
  assert.deepEqual(reorderDay(other, 'a', 'z').map(item => item.id).at(-1), 'a');
  assert.equal(reorderDay(other, 'a', 'z').some(item => item.id === 'z'), false);
  assert.deepEqual(reorderDay([task('n', { dueDate: null })], 'n', null), []);
  assert.equal(dayBefore(second, 'd'), 'a');
  assert.equal(dayBefore(second, 'c'), null);
});

test('equal keys and keys grown long key the date again', () => {
  const tied = [task('a', { dayOrder: `${D}|V` }), task('b', { dayOrder: `${D}|V` }), task('c', { dayOrder: `${D}|W` })];
  const moved = after(tied, 'c', 'a');
  assert.deepEqual(order(moved), ['a', 'c', 'b']);
  let tasks = [task('a'), task('b')];
  for (let index = 0; index < 60; index++) {
    tasks = [...after([...tasks, task(`n${index}`)], `n${index}`, 'a')];
    assert.ok(tasks.every(item => (item.dayOrder?.length ?? 0) <= D.length + 1 + 25), `${index}`);
  }
  assert.equal(order(tasks)[0], 'a');
  assert.equal(order(tasks)[1], 'n59');
  assert.equal(order(tasks).at(-1), 'b');
});
