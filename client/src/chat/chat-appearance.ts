import { useEffect, useLayoutEffect, useState } from 'react';
import { readStoredNumber, storeNumber, usePanelWidth } from '../common/panel-resize';

const fontKey = 'agent-session-tower.chat-font-size';
const widthKey = 'agent-session-tower.chat-width';
const fontChangeEvent = 'tower:chat-font-size';
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function maximumWidth() {
  // Leave room for the canvas and the widest desktop sidebar.
  return Math.max(320, window.innerWidth - (window.innerWidth > 900 ? 304 : 0) - 200);
}

export function useChatFontSize() {
  const [fontSize, setFontSize] = useState(() => clamp(readStoredNumber(fontKey, 14), 11, 22));
  useEffect(() => {
    const changed = (event: Event) => setFontSize((event as CustomEvent<number>).detail);
    const stored = (event: StorageEvent) => {
      if (event.key === fontKey || event.key === null) setFontSize(clamp(readStoredNumber(fontKey, 14), 11, 22));
    };
    window.addEventListener(fontChangeEvent, changed);
    window.addEventListener('storage', stored);
    return () => {
      window.removeEventListener(fontChangeEvent, changed);
      window.removeEventListener('storage', stored);
    };
  }, []);
  return { fontSize, changeFontSize: setChatFontSize };
}

/** Changes the chat text size for every open conversation in this browser, as the text size control does. */
export function setChatFontSize(next: number): void {
  const value = clamp(next, 11, 22);
  storeNumber(fontKey, value);
  window.dispatchEvent(new CustomEvent(fontChangeEvent, { detail: value }));
}

export function useChatAppearance() {
  const { fontSize } = useChatFontSize();
  const panel = usePanelWidth({ storageKey: widthKey, fallback: window.innerWidth >= 1600 ? 510 : 440, min: 320, maximum: maximumWidth });
  const { width } = panel;
  // While a conversation covers the right of the page, the header's settings button moves to its left edge,
  // in the same frame as the panel, so the canvas tools measured against the button follow it.
  useLayoutEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--chat-panel-width', `${width}px`);
    return () => { root.removeProperty('--chat-panel-width'); };
  }, [width]);
  return { fontSize, panel, width };
}
