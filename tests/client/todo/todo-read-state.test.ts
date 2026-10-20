import test from 'node:test';
import assert from 'node:assert/strict';
import { acknowledgeTodos, parseTodoReadState, TODO_READ_LIMIT, unreadTodos } from '../../../client/src/todo/todo-read-state';

test('no saved marks is told apart from empty or broken ones', () => {
  assert.equal(parseTodoReadState(null), null);
  assert.deepEqual(parseTodoReadState('{"a":"c1","b":3,"":"x"}'), { a: 'c1' });
  assert.deepEqual(parseTodoReadState('[1]'), {});
  assert.deepEqual(parseTodoReadState('{'), {});
});

test('a todo is unread until its newest outside comment is the one read', () => {
  const outside = { a: 'c2', b: 'c5', c: 'c9' };
  let state = acknowledgeTodos({}, { a: 'c1', b: 'c5' });
  assert.deepEqual([...unreadTodos(outside, state)].sort(), ['a', 'c']);
  state = acknowledgeTodos(state, { a: 'c2' });
  assert.deepEqual([...unreadTodos(outside, state)], ['c']);
  assert.equal(acknowledgeTodos(state, { a: 'c2' }), state);
});

test('the marks are bounded, the oldest written going first', () => {
  let state = acknowledgeTodos({}, Object.fromEntries(Array.from({ length: TODO_READ_LIMIT }, (_, i) => [`t${i}`, 'c'])));
  state = acknowledgeTodos(state, { t0: 'new', extra: 'c' });
  assert.equal(Object.keys(state).length, TODO_READ_LIMIT);
  assert.equal(state.t1, undefined);
  assert.equal(state.t2, 'c');
  assert.equal(state.t0, 'new');
  assert.equal(state.extra, 'c');
});
