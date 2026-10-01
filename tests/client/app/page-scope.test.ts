import test from 'node:test';
import assert from 'node:assert/strict';
import { archivedPending, pageScope } from '../../../client/src/app/page-scope.js';

test('the page asks for its time window, the archived list when open, and the opened conversation of this computer', () => {
  assert.deepEqual(pageScope('1', false, null), { days: 1, closed: false });
  assert.deepEqual(pageScope('30', true, 'claude:a'), { days: 30, closed: true, focus: 'claude:a' });
  assert.deepEqual(pageScope('all', false, undefined), { closed: false });
  // A joined computer's conversation comes with that computer's own feed.
  assert.deepEqual(pageScope('7', false, `@${'a'.repeat(32)}/claude:b`), { days: 7, closed: false });
});

test('the archived list waits for its sessions instead of saying there are none', () => {
  assert.equal(archivedPending(true, { days: 1, closed: false }), true);
  assert.equal(archivedPending(true, { days: 1, closed: true }), false);
  assert.equal(archivedPending(false, { days: 1, closed: false }), false);
  assert.equal(archivedPending(true, undefined), false, 'a view without a scope holds everything');
});
