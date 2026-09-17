import { useEffect, useRef, useState, type PointerEvent } from 'react';

const fontKey = 'agent-session-tower.chat-font-size';
const widthKey = 'agent-session-tower.chat-width';
const fontChangeEvent = 'tower:chat-font-size';
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function readPreference(key: string, fallback: number): number {
  try {
    const saved = window.localStorage.getItem(key);
    const value = saved === null ? NaN : Number(saved);
    return Number.isFinite(value) ? value : fallback;
  } catch { return fallback; }
}
function savePreference(key: string, value: number) {
  try { window.localStorage.setItem(key, String(value)); } catch { /* Preferences remain usable without storage. */ }
}
function maximumWidth() {
  // Leave room for the canvas and the widest desktop sidebar.
  return Math.max(320, window.innerWidth - (window.innerWidth > 900 ? 304 : 0) - 200);
}

export function useChatFontSize() {
  const [fontSize, setFontSize] = useState(() => clamp(readPreference(fontKey, 14), 11, 22));
  useEffect(() => {
    const changed = (event: Event) => setFontSize((event as CustomEvent<number>).detail);
    const stored = (event: StorageEvent) => {
      if (event.key === fontKey || event.key === null) setFontSize(clamp(readPreference(fontKey, 14), 11, 22));
    };
    window.addEventListener(fontChangeEvent, changed);
    window.addEventListener('storage', stored);
    return () => {
      window.removeEventListener(fontChangeEvent, changed);
      window.removeEventListener('storage', stored);
    };
  }, []);
  const changeFontSize = (next: number) => {
    const value = clamp(next, 11, 22);
    setFontSize(value); savePreference(fontKey, value);
    window.dispatchEvent(new CustomEvent(fontChangeEvent, { detail: value }));
  };
  return { fontSize, changeFontSize };
}

export function useChatAppearance() {
  const { fontSize } = useChatFontSize();
  const [preferredWidth, setPreferredWidth] = useState(() => Math.max(320, readPreference(widthKey, window.innerWidth >= 1600 ? 510 : 440)));
  const [maxWidth, setMaxWidth] = useState(maximumWidth);
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const width = clamp(preferredWidth, 320, maxWidth);
  useEffect(() => {
    const update = () => setMaxWidth(maximumWidth());
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  const changeWidth = (next: number) => {
    const value = clamp(next, 320, maxWidth);
    setPreferredWidth(value); savePreference(widthKey, value);
  };
  return {
    fontSize, width, maxWidth, changeWidth,
    startResize(event: PointerEvent<HTMLDivElement>) {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointerId: event.pointerId, x: event.clientX, width };
    },
    resize(event: PointerEvent<HTMLDivElement>) {
      if (drag.current?.pointerId === event.pointerId) changeWidth(drag.current.width + drag.current.x - event.clientX);
    },
    stopResize(event: PointerEvent<HTMLDivElement>) {
      if (drag.current?.pointerId !== event.pointerId) return;
      drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    },
  };
}
