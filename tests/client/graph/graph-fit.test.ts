import test from 'node:test';
import assert from 'node:assert/strict';
import { graphFitSignature } from '../../../client/src/graph/graph-fit.js';

const node = (x: number, y: number, width?: number, height?: number, extra: { hidden?: boolean; parentId?: string } = {}) =>
  ({ ...extra, measured: { width, height }, internals: { positionAbsolute: { x, y } } });

test('a canvas without a size or with unmeasured nodes is not ready to fit', () => {
  assert.equal(graphFitSignature([node(0, 0, 10, 10)], 0, 600), '');
  assert.equal(graphFitSignature([node(0, 0, 10, 10), node(50, 50)], 800, 600), '');
  assert.equal(graphFitSignature([], 800, 600), '');
});

test('the signature follows the graph extent and the canvas size', () => {
  const nodes = [node(-20.4, 10, 100, 50), node(300, 185, 200, 400)];
  assert.equal(graphFitSignature(nodes, 800, 600), '-20,10,500,585,800,600');
  assert.notEqual(graphFitSignature(nodes, 1200, 600), graphFitSignature(nodes, 800, 600));
  assert.notEqual(graphFitSignature([...nodes, node(900, 0, 100, 100)], 800, 600), graphFitSignature(nodes, 800, 600));
});

test('hidden nodes and nodes inside a parent do not widen the fit', () => {
  const base = [node(0, 0, 100, 100)];
  assert.equal(graphFitSignature([...base, node(5000, 0, 10, 10, { hidden: true }), node(9000, 0, 10, 10, { parentId: 'monitor' })], 800, 600), graphFitSignature(base, 800, 600));
  assert.equal(graphFitSignature([...base, node(20, 20, undefined, undefined, { hidden: true })], 800, 600), graphFitSignature(base, 800, 600));
});
