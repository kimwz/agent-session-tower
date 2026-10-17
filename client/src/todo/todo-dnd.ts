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

/** What is under the pointer; a keyboard drag has no pointer, so the target nearest the moved item. */
export const pointerOrNearest: CollisionDetection = args => args.pointerCoordinates ? pointerWithin(args) : closestCenter(args);
