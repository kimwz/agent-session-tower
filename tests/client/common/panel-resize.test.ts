import test from 'node:test';
import assert from 'node:assert/strict';
import { clampWidth, draggedWidth, readStoredNumber, storeNumber } from '../../../client/src/common/panel-resize.js';

function storage(initial: Record<string, string> = {}, refuse = false) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key: string) => { if (refuse) throw new Error('denied'); return values.get(key) ?? null; }, setItem: (key: string, value: string) => { if (refuse) throw new Error('quota'); values.set(key, value); }, values };
}

test('a panel width is kept within its bounds, and the lower bound wins when the room is smaller', () => {
  assert.equal(clampWidth(700, 480, 1000), 700);
  assert.equal(clampWidth(300, 480, 1000), 480);
  assert.equal(clampWidth(1200, 480, 1000), 1000);
  assert.equal(clampWidth(700, 480, 400), 480, 'a page narrower than the minimum still gets the minimum');
});

test('dragging the left edge left widens the panel, right narrows it, within its bounds', () => {
  const start = { x: 800, width: 640 };
  assert.equal(draggedWidth(start, 700, 480, 1100), 740);
  assert.equal(draggedWidth(start, 900, 480, 1100), 540);
  assert.equal(draggedWidth(start, 100, 480, 1100), 1100);
  assert.equal(draggedWidth(start, 1300, 480, 1100), 480);
});

test('the width is read back after a reload; none, damaged or unreadable storage gives the default', t => {
  t.after(() => { delete (globalThis as { window?: unknown }).window; });
  const saved = storage();
  (globalThis as { window?: unknown }).window = { localStorage: saved };
  assert.equal(readStoredNumber('w', 640), 640);
  storeNumber('w', 812);
  assert.equal(saved.values.get('w'), '812');
  assert.equal(readStoredNumber('w', 640), 812);
  (globalThis as { window?: unknown }).window = { localStorage: storage({ w: 'wide' }) };
  assert.equal(readStoredNumber('w', 640), 640);
  (globalThis as { window?: unknown }).window = { localStorage: storage({}, true) };
  assert.equal(readStoredNumber('w', 640), 640);
  assert.doesNotThrow(() => storeNumber('w', 700), 'a refusing storage leaves the page working');
  delete (globalThis as { window?: unknown }).window;
  assert.equal(readStoredNumber('w', 640), 640, 'no browser at all');
});
