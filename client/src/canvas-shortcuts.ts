type ShortcutKey = Pick<KeyboardEvent, 'code' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'repeat' | 'defaultPrevented'>;

/** Use the physical key so Korean IME and English layouts share the shortcut. */
export function isAutoPromptShortcut(event: ShortcutKey): boolean {
  return event.code === 'KeyP' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
    && !event.repeat && !event.defaultPrevented;
}

export function isShowAllShortcut(event: ShortcutKey): boolean {
  return event.code === 'KeyA' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
    && !event.repeat && !event.defaultPrevented;
}
