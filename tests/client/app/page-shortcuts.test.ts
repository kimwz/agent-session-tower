import test from 'node:test';
import assert from 'node:assert/strict';
import { pageShortcut } from '../../../client/src/app/page-shortcuts.js';

const key = (code: string, mods: Partial<KeyboardEvent> = {}) => ({ code, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, repeat: false, defaultPrevented: false, isComposing: false, ...mods }) as KeyboardEvent;

test('1 goes to the canvas and 2 to the todos, by the key itself, without modifiers', () => {
  assert.equal(pageShortcut(key('Digit1')), 'canvas');
  assert.equal(pageShortcut(key('Digit2')), 'todo');
  assert.equal(pageShortcut(key('Numpad2')), 'todo');
  assert.equal(pageShortcut(key('Digit3')), undefined);
  for (const mods of [{ shiftKey: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true }, { repeat: true }, { defaultPrevented: true }, { isComposing: true }]) {
    assert.equal(pageShortcut(key('Digit1', mods)), undefined, JSON.stringify(mods));
  }
});
