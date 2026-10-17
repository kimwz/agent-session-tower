import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useMediaQuery } from '../common/use-media-query';

/**
 * A panel opened from a control: placed under it on a wide page, a sheet from the bottom on a phone. It closes on
 * Escape or a press outside it (but not on its opener, which toggles it itself).
 */
export function Popover({ anchor, onClose, children, label, className = '', align = 'start' }: {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  label: string;
  className?: string;
  align?: 'start' | 'end';
}) {
  const sheet = useMediaQuery('(max-width: 680px)');
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    if (sheet) return;
    const measure = () => {
      const box = anchor.current?.getBoundingClientRect();
      const panel = ref.current;
      if (!box || !panel) return;
      const width = panel.offsetWidth, height = panel.offsetHeight;
      const below = window.innerHeight - box.bottom - 12, above = box.top - 12;
      const top = below >= Math.min(height, 320) || below >= above ? box.bottom + 6 : Math.max(8, box.top - 6 - Math.min(height, above));
      const left = Math.min(Math.max(8, align === 'end' ? box.right - width : box.left), window.innerWidth - width - 8);
      setPlace({ top, left, maxHeight: Math.max(160, top > box.top ? below : above) });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [anchor, sheet, align]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); close.current(); } };
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchor.current?.contains(target)) return;
      // A panel opened from this one (a date picker in a menu) lies outside it but belongs to it.
      if (target instanceof Element && target.closest('.todo-popover') && target.closest('.todo-popover') !== ref.current) return;
      close.current();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', onDown, true); };
  }, [anchor]);

  const panel = <div ref={ref} role="dialog" aria-label={label} className={`todo-popover ${sheet ? 'sheet' : ''} ${className}`}
    style={sheet ? undefined : place ? { top: place.top, left: place.left, maxHeight: place.maxHeight } : { visibility: 'hidden', top: 0, left: 0 }}>{children}</div>;
  return createPortal(sheet ? <><div className="todo-sheet-scrim" onClick={onClose} />{panel}</> : panel, document.body);
}

export interface MenuItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  hint?: string;
  danger?: boolean;
  checked?: boolean;
  disabled?: boolean;
  run: () => void;
}

/** A list of actions in a popover; choosing one closes it unless the item keeps it open (`checked` toggles). */
export function Menu({ anchor, items, onClose, label, header, align }: { anchor: RefObject<HTMLElement | null>; items: (MenuItem | 'separator')[]; onClose: () => void; label: string; header?: ReactNode; align?: 'start' | 'end' }) {
  return <Popover anchor={anchor} onClose={onClose} label={label} className="todo-menu" align={align}>
    {header}
    <div role="menu" aria-label={label}>
      {items.map((item, index) => item === 'separator' ? <hr key={`separator-${index}`} /> : <button key={item.key} type="button" role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
        aria-checked={item.checked} className={`${item.danger ? 'danger' : ''} ${item.checked ? 'checked' : ''}`} disabled={item.disabled}
        onClick={() => { item.run(); if (item.checked === undefined) onClose(); }}>
        {item.icon}<span>{item.label}</span>{item.hint && <kbd>{item.hint}</kbd>}
      </button>)}
    </div>
  </Popover>;
}

/** Open state for a popover and the ref of its opener. */
export function usePopover<T extends HTMLElement = HTMLButtonElement>() {
  const anchor = useRef<T>(null);
  const [open, setOpen] = useState(false);
  return { anchor, open, setOpen, toggle: () => setOpen(value => !value), close: () => setOpen(false) };
}
