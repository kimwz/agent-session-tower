import assert from 'node:assert/strict';
import test from 'node:test';
import { movesForegroundAside } from '../../../server/runs/steering.js';

test('a message someone sent moves the turn\'s foreground work aside; Tower\'s own notices wait for the step underway', () => {
  assert.equal(movesForegroundAside({}), true);
  assert.equal(movesForegroundAside({ updateWrapUp: true }), false);
  assert.equal(movesForegroundAside({ permissionNotice: { targetRunId: 'run-1' } }), false);
});
