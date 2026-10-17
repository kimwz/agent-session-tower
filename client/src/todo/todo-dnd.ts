import { closestCenter, KeyboardSensor, MouseSensor, pointerWithin, TouchSensor, useSensor, useSensors, type CollisionDetection } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';

/**
 * How every Todo drag starts: a mouse moved a little, a touch held (a moving one scrolls), or Space on the keyboard
 * (Enter stays the key that opens). A board's cards step through their lists; the calendar's move by arrow steps.
 */
export function useTodoSensors(keyboard: 'sortable' | 'free' = 'sortable') {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }),
    useSensor(KeyboardSensor, { keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] }, ...(keyboard === 'sortable' ? { coordinateGetter: sortableKeyboardCoordinates } : {}) }),
  );
}

/**
 * What is under the pointer. A keyboard drag has no pointer: the target under the moved item's center, else the
 * nearest (a tall time column is never passed over for a nearer small all-day cell).
 */
export const pointerOrNearest: CollisionDetection = args => {
  if (args.pointerCoordinates) return pointerWithin(args);
  const { left, top, width, height } = args.collisionRect;
  const under = pointerWithin({ ...args, pointerCoordinates: { x: left + width / 2, y: top + height / 2 } });
  return under.length ? under : closestCenter(args);
};
