import { useSyncExternalStore } from 'react';
import type { GraphLayoutMode } from './graph-layout-preferences';

/** The canvas's own view settings, handed to the settings while a canvas is on the page. */
export interface CanvasControls {
  manual: boolean;
  motion: boolean;
  setLayout(mode: GraphLayoutMode): void;
  setMotion(motion: boolean): void;
}

let current: CanvasControls | null = null;
const listeners = new Set<() => void>();

/** The canvas publishes its controls while it is shown and withdraws them when it goes. */
export function publishCanvasControls(controls: CanvasControls | null): void {
  current = controls;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const read = () => current;

export function useCanvasControls(): CanvasControls | null {
  return useSyncExternalStore(subscribe, read, read);
}
