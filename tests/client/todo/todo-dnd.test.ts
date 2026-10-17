import test from 'node:test';
import assert from 'node:assert/strict';
import { pointerOrNearest } from '../../../client/src/todo/todo-dnd.js';
test('keyboard drag picks the column under the moved block, not a nearer small cell', () => {
  const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const containers = [{ id: 'allday', rect: { current: null }, data: { current: {} }, disabled: false, node: { current: null } }, { id: 'time', rect: { current: null }, data: { current: {} }, disabled: false, node: { current: null } }] as never[];
  const droppableRects = new Map<string, ReturnType<typeof rect>>([['allday', rect(100, 0, 100, 30)], ['time', rect(100, 40, 100, 1152)]]);
  const hit = pointerOrNearest({ active: { id: 'x' } as never, collisionRect: rect(100, 60, 100, 40), droppableRects: droppableRects as never, droppableContainers: containers, pointerCoordinates: null });
  assert.equal(hit[0]?.id, 'time');
});
