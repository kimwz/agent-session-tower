import { useLayoutEffect, useRef, useState, type PointerEvent } from 'react';

/**
 * A side panel whose width the owner drags from its left edge (or moves with ← and →), kept in this browser's
 * storage. The conversation panels and the todo detail share it, so they resize the same way.
 */
export interface PanelWidth {
  width: number;
  min: number;
  max: number;
  changeWidth(next: number): void;
  startResize(event: PointerEvent<HTMLDivElement>): void;
  resize(event: PointerEvent<HTMLDivElement>): void;
  stopResize(event: PointerEvent<HTMLDivElement>): void;
}

export const clampWidth = (value: number, min: number, max: number) => Math.min(Math.max(min, max), Math.max(min, value));

/** A number saved in this browser, or `fallback` when there is none, it is damaged, or storage cannot be read. */
export function readStoredNumber(storageKey: string, fallback: number): number {
  try {
    const saved = window.localStorage.getItem(storageKey);
    const value = saved === null ? NaN : Number(saved);
    return Number.isFinite(value) ? value : fallback;
  } catch { return fallback; }
}

export function storeNumber(storageKey: string, value: number): void {
  try { window.localStorage.setItem(storageKey, String(value)); } catch { /* Preferences remain usable for this page without storage. */ }
}

/** The width after dragging a left-edge handle from `startX` to `x`: moving left widens the panel. */
export const draggedWidth = (start: { x: number; width: number }, x: number, min: number, max: number) => clampWidth(start.width + start.x - x, min, max);

export function usePanelWidth({ storageKey, fallback, min, maximum, rootProperty }: {
  storageKey: string;
  fallback: number;
  min: number;
  /** The widest it may be now; measured on mount and when the window resizes. */
  maximum: () => number;
  /** A property of the document root that holds the width while the panel is shown, for what makes room beside it. */
  rootProperty?: string;
}): PanelWidth {
  const [preferred, setPreferred] = useState(() => Math.max(min, readStoredNumber(storageKey, fallback)));
  const [max, setMax] = useState(() => Math.max(min, maximum()));
  const measure = useRef(maximum);
  measure.current = maximum;
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const width = clampWidth(preferred, min, max);
  useLayoutEffect(() => {
    const update = () => setMax(Math.max(min, measure.current()));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [min]);
  // Set in the same frame as the panel, so what is measured against the room left follows it.
  useLayoutEffect(() => {
    if (!rootProperty) return;
    const root = document.documentElement.style;
    root.setProperty(rootProperty, `${width}px`);
    return () => { root.removeProperty(rootProperty); };
  }, [rootProperty, width]);
  const change = (next: number) => {
    const value = clampWidth(next, min, max);
    setPreferred(value); storeNumber(storageKey, value);
  };
  return {
    width, min, max,
    changeWidth: change,
    startResize(event) {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointerId: event.pointerId, x: event.clientX, width };
    },
    resize(event) {
      const start = drag.current;
      if (start?.pointerId === event.pointerId) change(draggedWidth(start, event.clientX, min, max));
    },
    stopResize(event) {
      if (drag.current?.pointerId !== event.pointerId) return;
      drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    },
  };
}

/** The panel's left edge, shown on wide screens (workspace-controls.css). */
export function PanelResizeHandle({ panel, label, className }: { panel: PanelWidth; label: string; className?: string }) {
  return <div className={className ? `chat-resize-handle ${className}` : 'chat-resize-handle'} role="separator" tabIndex={0} aria-label={label} aria-orientation="vertical"
    aria-valuemin={panel.min} aria-valuemax={panel.max} aria-valuenow={panel.width}
    onPointerDown={panel.startResize} onPointerMove={panel.resize} onPointerUp={panel.stopResize} onPointerCancel={panel.stopResize} onLostPointerCapture={panel.stopResize}
    onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); panel.changeWidth(panel.width + (event.key === 'ArrowLeft' ? 20 : -20)); } }} />;
}
