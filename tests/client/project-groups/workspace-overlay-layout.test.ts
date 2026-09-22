import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceOverlayLayout } from '../../../client/src/workspace/overlay-layout.js';

test('workspace occupies right edge alone and remains left of chat when resized', () => {
  assert.equal(workspaceOverlayLayout(1440, 0, 640).right, 0);
  for (const chat of [320, 440, 600]) {
    const layout = workspaceOverlayLayout(1440, chat, 2000);
    assert.equal(layout.stacked, false);
    assert.equal(layout.right, chat);
    assert.equal(layout.width + chat, 1440);
    assert.equal(workspaceOverlayLayout(1440, chat, 100).width, 420);
  }
});

test('panels stack only when minimum workspace width cannot fit beside chat', () => {
  assert.equal(workspaceOverlayLayout(860, 440, 640).stacked, false);
  const stacked = workspaceOverlayLayout(859, 440, 640);
  assert.equal(stacked.stacked, true);
  assert.equal(stacked.width, 859);
  assert.equal(stacked.right, 0);
  assert.equal(workspaceOverlayLayout(390, 390, 640).stacked, true);
  assert.equal(workspaceOverlayLayout(390, 0, 640).width, 390);
  assert.equal(workspaceOverlayLayout(1200, 440, 640).width, 640);
});
