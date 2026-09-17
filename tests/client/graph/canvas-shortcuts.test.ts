import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAutoPromptShortcut, isNewSessionShortcut, isShowAllShortcut } from '../../../client/src/graph/canvas-shortcuts.js';

// Real keyboard events carry more than the fields the shortcuts read, e.g. while an IME is composing.
const composing = <T extends object>(base: T, key: string) => ({ ...base, key, isComposing: true });
const event = () => ({ code: 'KeyP', key: 'P', shiftKey: true, ctrlKey: false, metaKey: false, altKey: false, repeat: false, defaultPrevented: false, isComposing: false });

test('canvas Shift+P follows the physical key under English and Korean IME layouts', () => {
  assert.equal(isAutoPromptShortcut(event()), true);
  assert.equal(isAutoPromptShortcut(composing(event(), 'ㅖ')), true);
  assert.equal(isAutoPromptShortcut(composing(event(), 'Process')), true);
  assert.equal(isAutoPromptShortcut({ ...event(), code: 'KeyQ' }), false, 'a translated P must not override a different physical key');
});

test('the shortcut does not intercept modifier combinations, held keys, or handled events', () => {
  assert.equal(isAutoPromptShortcut({ ...event(), shiftKey: false }), false);
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'repeat', 'defaultPrevented'] as const) {
    assert.equal(isAutoPromptShortcut({ ...event(), [modifier]: true }), false, modifier);
  }
});

test('Show all uses Shift+A under either keyboard layout and keeps other shortcuts untouched', () => {
  const showAll = { ...event(), code: 'KeyA', key: 'A' };
  assert.equal(isShowAllShortcut(showAll), true);
  assert.equal(isShowAllShortcut(composing(showAll, 'ㅁ')), true);
  assert.equal(isShowAllShortcut(event()), false);
  assert.equal(isAutoPromptShortcut(showAll), false);
  assert.equal(isShowAllShortcut({ ...showAll, shiftKey: false }), false);
  for (const guard of ['ctrlKey', 'metaKey', 'altKey', 'repeat', 'defaultPrevented'] as const) {
    assert.equal(isShowAllShortcut({ ...showAll, [guard]: true }), false, guard);
  }
});

test('New session uses Shift+N under either keyboard layout without intercepting other shortcuts', () => {
  const newSession = { ...event(), code: 'KeyN', key: 'N' };
  assert.equal(isNewSessionShortcut(newSession), true);
  assert.equal(isNewSessionShortcut(composing(newSession, 'ㅜ')), true);
  assert.equal(isNewSessionShortcut(event()), false);
  assert.equal(isNewSessionShortcut({ ...event(), code: 'KeyA' }), false);
  assert.equal(isAutoPromptShortcut(newSession), false);
  assert.equal(isShowAllShortcut(newSession), false);
  assert.equal(isNewSessionShortcut({ ...newSession, shiftKey: false }), false);
  for (const guard of ['ctrlKey', 'metaKey', 'altKey', 'repeat', 'defaultPrevented'] as const) {
    assert.equal(isNewSessionShortcut({ ...newSession, [guard]: true }), false, guard);
  }
});
