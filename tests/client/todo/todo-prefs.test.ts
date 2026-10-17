import test from 'node:test';
import assert from 'node:assert/strict';
import { forgetFoldedForTests, setSubtasksFolded, subtasksFolded } from '../../../client/src/todo/todo-prefs.js';

function storage(initial: Record<string, string> = {}, refuse = false) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { if (refuse) throw new Error('quota'); values.set(key, value); }, values };
}

test('sub-tasks show unless folded, and a fold is remembered after a reload', () => {
  const saved = storage();
  (globalThis as { window?: unknown }).window = { localStorage: saved };
  forgetFoldedForTests();
  assert.equal(subtasksFolded('a'), false);
  setSubtasksFolded('a', true);
  forgetFoldedForTests();
  assert.equal(subtasksFolded('a'), true, 'read again from storage');
  setSubtasksFolded('a', false);
  forgetFoldedForTests();
  assert.equal(subtasksFolded('a'), false);
});

test('only the newest 500 folds are kept; damaged or refusing storage still works for the page', () => {
  const saved = storage({ 'tower.todo.collapsedSubtasks': '{oops' });
  (globalThis as { window?: unknown }).window = { localStorage: saved };
  forgetFoldedForTests();
  assert.equal(subtasksFolded('a'), false);
  for (let n = 0; n < 510; n++) setSubtasksFolded(`t${n}`, true);
  assert.equal(JSON.parse(saved.values.get('tower.todo.collapsedSubtasks')!).length, 500);
  assert.equal(subtasksFolded('t0'), false);
  assert.equal(subtasksFolded('t509'), true);
  (globalThis as { window?: unknown }).window = { localStorage: storage({}, true) };
  forgetFoldedForTests();
  setSubtasksFolded('b', true);
  assert.equal(subtasksFolded('b'), true, 'kept in memory when storage refuses');
});

test('when saving keeps failing, every fold of this page is still remembered', () => {
  (globalThis as { window?: unknown }).window = { localStorage: storage({}, true) };
  forgetFoldedForTests();
  setSubtasksFolded('a', true);
  setSubtasksFolded('b', true);
  assert.equal(subtasksFolded('a'), true);
  assert.equal(subtasksFolded('b'), true);
});
