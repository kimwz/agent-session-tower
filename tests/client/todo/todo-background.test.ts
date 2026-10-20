import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundClose, PAGE_CONTROLS } from '../../../client/src/todo/todo-background.js';

/** An element of the page's main area that sits within the given selectors (a real one answers `closest` the same way). */
const element = (...within: string[]) => ({ closest: (selector: string) => within.some(item => selector.split(', ').includes(item)) ? ({} as Element) : null });
const conversation = () => {};
const task = () => {};
const board = element();

test('a click on the empty space closes the conversation over the page, as the canvas pane does', () => {
  assert.equal(backgroundClose({ target: board, plain: true }, { conversation }), conversation);
  // An empty calendar day only closes it: the day's own click (adding a task) does not follow.
  assert.equal(backgroundClose({ target: element('.todo-cal-cell', '[role="gridcell"]'), plain: true }, { conversation }), conversation);
});

test('the conversation closes before the open task, as Esc closes it first; then the task', () => {
  assert.equal(backgroundClose({ target: board, plain: true }, { conversation, task }), conversation);
  assert.equal(backgroundClose({ target: board, plain: true }, { task }), task);
});

test('with nothing over the page a click is left alone', () => {
  assert.equal(backgroundClose({ target: board, plain: true }, {}), undefined);
});

test('cards, controls, fields and popovers keep their clicks', () => {
  for (const control of ['.todo-card', 'button', 'input', '.todo-popover']) {
    assert.ok(PAGE_CONTROLS.split(', ').includes(control), control);
    assert.equal(backgroundClose({ target: element(control), plain: true }, { conversation, task }), undefined, control);
  }
});

test('a click that closed a popover or ended a drag, or one outside the main area, is not on the empty space', () => {
  assert.equal(backgroundClose({ target: board, plain: false }, { conversation }), undefined);
  assert.equal(backgroundClose({ target: null, plain: true }, { conversation }), undefined);
});
