import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAutoPromptShortcut, isNewSessionShortcut, isShowAllShortcut } from '../client/src/graph/canvas-shortcuts.js';

const event = () => ({ code: 'KeyP', key: 'P', shiftKey: true, ctrlKey: false, metaKey: false, altKey: false, repeat: false, defaultPrevented: false, isComposing: false });

test('canvas Shift+P follows the physical key under English and Korean IME layouts', () => {
  assert.equal(isAutoPromptShortcut(event()), true);
  assert.equal(isAutoPromptShortcut({ ...event(), key: 'ㅖ', isComposing: true }), true);
  assert.equal(isAutoPromptShortcut({ ...event(), key: 'Process', isComposing: true }), true);
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
  assert.equal(isShowAllShortcut({ ...showAll, key: 'ㅁ', isComposing: true }), true);
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
  assert.equal(isNewSessionShortcut({ ...newSession, key: 'ㅜ', isComposing: true }), true);
  assert.equal(isNewSessionShortcut(event()), false);
  assert.equal(isNewSessionShortcut({ ...event(), code: 'KeyA' }), false);
  assert.equal(isAutoPromptShortcut(newSession), false);
  assert.equal(isShowAllShortcut(newSession), false);
  assert.equal(isNewSessionShortcut({ ...newSession, shiftKey: false }), false);
  for (const guard of ['ctrlKey', 'metaKey', 'altKey', 'repeat', 'defaultPrevented'] as const) {
    assert.equal(isNewSessionShortcut({ ...newSession, [guard]: true }), false, guard);
  }
});
