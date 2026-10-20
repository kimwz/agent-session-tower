import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundClose, PAGE_CONTROLS, type PageClick } from '../../../client/src/todo/todo-background.js';

/** An element the page's main area holds: `controls` are the selectors it sits within. */
class FakeElement {
  constructor(readonly name: string, readonly controls: string[] = [], readonly inMain = true) {}
  closest(selector: string) { return this.controls.some(control => selector.split(', ').includes(control)) ? this : null; }
}
(globalThis as { Element?: unknown }).Element ??= FakeElement;

const click = (target: unknown, patch: Partial<PageClick> = {}): PageClick =>
  ({ target: target as EventTarget, pressedOn: target as EventTarget, popover: false, inside: element => (element as unknown as FakeElement).inMain, ...patch });
const conversation = () => {};
const task = () => {};
const board = new FakeElement('board');

test('a click on the empty space closes the conversation over the page, as the canvas pane does', () => {
  assert.equal(backgroundClose(click(board), { conversation }), conversation);
  assert.equal(backgroundClose(click(new FakeElement('empty day', ['.todo-cal-day'])), { conversation }), conversation);
});

test('the conversation closes before the open task, as Esc closes it first; then the task', () => {
  assert.equal(backgroundClose(click(board), { conversation, task }), conversation);
  assert.equal(backgroundClose(click(board), { task }), task);
});

test('with nothing over the page a click is left alone', () => {
  assert.equal(backgroundClose(click(board), {}), undefined);
});

test('cards, controls, fields and popovers keep their clicks', () => {
  for (const control of ['.todo-card', '.todo-cal-entry', '.todo-cal-block', 'button', 'a', 'input', 'textarea', 'select', 'label', 'summary', '[role="button"]', '[role="tab"]', '[role="radio"]', '.todo-popover']) {
    assert.ok(PAGE_CONTROLS.split(', ').includes(control), control);
    assert.equal(backgroundClose(click(new FakeElement(control, [control])), { conversation, task }), undefined, control);
  }
});

test('a click that closed a popover, a drop, or one outside the main area is not on the empty space', () => {
  assert.equal(backgroundClose(click(board, { popover: true }), { conversation }), undefined);
  assert.equal(backgroundClose(click(board, { pressedOn: new FakeElement('card', ['.todo-card']) as unknown as EventTarget }), { conversation }), undefined);
  assert.equal(backgroundClose(click(new FakeElement('chat panel', [], false)), { conversation }), undefined);
  assert.equal(backgroundClose(click(null), { conversation }), undefined);
});
