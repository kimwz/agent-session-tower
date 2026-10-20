import test from 'node:test';
import assert from 'node:assert/strict';
import { clampView, fitScale, fitView, MAX_SCALE, panBy, pinchView, swipeStep, toggleZoom, zoomAt, zoomedIn } from '../../../client/src/common/image-zoom.js';

const stage = { width: 400, height: 800 };
const shot = { width: 1200, height: 2400 };
// Where the image pixel under a stage point is, for a view: it must not move when zooming around that point.
const under = (view: { scale: number; x: number; y: number }, point: { x: number; y: number }) => ({ x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale });

test('a picture fits the stage whole, and a small one keeps its own size', () => {
  assert.equal(fitScale(stage, shot), 1 / 3);
  assert.equal(fitScale(stage, { width: 2000, height: 100 }), 0.2);
  assert.equal(fitScale(stage, { width: 100, height: 50 }), 1);
  assert.equal(fitScale(stage, { width: 0, height: 0 }), 1);
  assert.deepEqual(fitView(stage, shot), { scale: 1 / 3, x: 0, y: 0 });
  assert.equal(MAX_SCALE, 4);
});

test('the view stays between the fit and the most, and never pulls the picture past its edge', () => {
  assert.deepEqual(clampView({ scale: 0.1, x: 50, y: -50 }, stage, shot), { scale: 1 / 3, x: 0, y: 0 });
  assert.equal(clampView({ scale: 99, x: 0, y: 0 }, stage, shot).scale, 4);
  // At its own size the picture is 1200×2400 on a 400×800 stage: 400 and 800 pixels of room each way.
  assert.deepEqual(clampView({ scale: 1, x: 900, y: -900 }, stage, shot), { scale: 1, x: 400, y: -800 });
  assert.deepEqual(clampView({ scale: 1, x: 120, y: 30 }, stage, shot), { scale: 1, x: 120, y: 30 });
  // A side smaller than the stage stays centred.
  assert.deepEqual(clampView({ scale: 0.2, x: 40, y: 0 }, stage, { width: 2000, height: 100 }), { scale: 0.2, x: 0, y: 0 });
});

test('zooming keeps the part of the picture under the pointer or pinch under it', () => {
  const start = fitView(stage, shot), point = { x: 100, y: -200 };
  const zoomed = zoomAt(start, 3, point, stage, shot);
  assert.equal(zoomed.scale, 1);
  const before = under(start, point), after = under(zoomed, point);
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
  assert.deepEqual(zoomAt(zoomed, 0.01, point, stage, shot), fitView(stage, shot));
  assert.equal(zoomAt(zoomed, 100, point, stage, shot).scale, 4);
  assert.ok(zoomedIn(zoomed, fitScale(stage, shot)));
  assert.equal(zoomedIn(start, fitScale(stage, shot)), false);
});

test('a pinch that zooms and moves at once keeps the picture under the fingers', () => {
  // At its own size, pulled to the right edge; the fingers close to half while their middle moves 100 px left.
  const start = { scale: 1, x: 400, y: 0 }, from = { x: 0, y: 0 }, to = { x: -100, y: 0 };
  const view = pinchView(start, 0.5, from, to, stage, shot);
  assert.deepEqual(view, { scale: 0.5, x: 100, y: 0 });
  const before = under(start, from), after = under(view, to);
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
  // Past the bounds it stops at the edge rather than drifting.
  assert.deepEqual(pinchView(start, 1, from, { x: 500, y: 0 }, stage, shot), { scale: 1, x: 400, y: 0 });
});

test('a double click goes to the picture’s own size there, and back to the fit', () => {
  const start = fitView(stage, shot);
  const own = toggleZoom(start, { x: 0, y: 0 }, stage, shot);
  assert.deepEqual(own, { scale: 1, x: 0, y: 0 });
  assert.deepEqual(toggleZoom(own, { x: 50, y: 50 }, stage, shot), start);
  // A small picture, already at its own size, doubles.
  const icon = { width: 100, height: 50 };
  assert.equal(toggleZoom(fitView(stage, icon), { x: 0, y: 0 }, stage, icon).scale, 2);
});

test('dragging moves a zoomed picture within its edges', () => {
  const own = { scale: 1, x: 0, y: 0 };
  assert.deepEqual(panBy(own, 30, -40, stage, shot), { scale: 1, x: 30, y: -40 });
  assert.deepEqual(panBy(own, 1000, 1000, stage, shot), { scale: 1, x: 400, y: 800 });
  assert.deepEqual(panBy(fitView(stage, shot), 30, 30, stage, shot), fitView(stage, shot));
});

test('a sideways swipe goes to the next or previous picture; a short or upright one does not', () => {
  assert.equal(swipeStep(-80, 10), 1);
  assert.equal(swipeStep(80, -10), -1);
  assert.equal(swipeStep(-30, 0), 0);
  assert.equal(swipeStep(-80, 70), 0);
});
