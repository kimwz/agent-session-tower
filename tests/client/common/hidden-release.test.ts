import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseWhileHidden } from '../../../client/src/common/hidden-release.js';

class FakeDocument {
  hidden = false;
  listeners = new Set<() => void>();
  addEventListener(_type: string, listener: () => void) { this.listeners.add(listener); }
  removeEventListener(_type: string, listener: () => void) { this.listeners.delete(listener); }
  set(hidden: boolean) { this.hidden = hidden; for (const listener of this.listeners) listener(); }
}

test('a page hidden for a while lets its streams go, and takes them up again when shown', async () => {
  const doc = new FakeDocument();
  const calls: string[] = [];
  const stop = releaseWhileHidden(() => calls.push('sleep'), () => calls.push('wake'), 20, doc as unknown as Document);
  doc.set(true); doc.set(false);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(calls, [], 'a quick look at another tab changes nothing');
  doc.set(true);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(calls, ['sleep']);
  doc.set(false);
  assert.deepEqual(calls, ['sleep', 'wake']);
  stop();
  doc.set(true);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(calls, ['sleep', 'wake'], 'stopped: no more changes');
  assert.equal(doc.listeners.size, 0);
});
