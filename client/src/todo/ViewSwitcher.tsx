import { useEffect, useRef, useState, type RefObject } from 'react';
import { CalendarDays, CalendarRange, Inbox } from 'lucide-react';
import { translate as t } from '../i18n/i18n';
import { Popover } from './Popover';
import { colorOf } from './todo-format';
import type { TodoWorld } from './todo-model';
import { readSwitchKey, typingIn } from './todo-shortcuts';
import { viewKey, type TodoView } from './todo-url';
import { projectOf, switchIndex, switchTargets, viewTitle } from './todo-views';

/**
 * The list of lists `V` opens under the page's title: a number goes to its list, the arrows and `Enter` choose one, and
 * `Esc`, `V` or a press outside close it. While it is open its keys are its own, so `1` and `2` never switch pages.
 */
export function ViewSwitcher({ anchor, world, current, onChoose, onClose }: {
  anchor: RefObject<HTMLElement | null>;
  world: TodoWorld;
  current: TodoView;
  onChoose: (view: TodoView) => void;
  onClose: () => void;
}) {
  const targets = switchTargets(world);
  const shown = switchIndex(world, current);
  const [marked, setMarked] = useState(() => Math.max(0, shown));
  const state = useRef({ targets, marked, onChoose, onClose });
  state.current = { targets, marked, onChoose, onClose };
  const list = useRef<HTMLDivElement>(null);
  // The marked entry stays in sight when the list scrolls (a short window, a phone's sheet); a frame later, once the
  // popover has its place and height.
  useEffect(() => {
    const frame = requestAnimationFrame(() => list.current?.children[marked]?.scrollIntoView({ block: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [marked]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const { targets: list, marked: index, onChoose: choose, onClose: close } = state.current;
      // A field reached with Tab while the list is open keeps its keys.
      if (typingIn(event.target instanceof Element ? event.target : null)) return;
      const read = readSwitchKey(event, list.length, index);
      if (!read) return;
      event.preventDefault();
      event.stopPropagation();
      if (read.action === 'mark') setMarked(read.index);
      else if (read.action === 'choose') choose(list[read.index]);
      else close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const icon = (view: TodoView) => {
    switch (view.kind) {
      case 'inbox': return <Inbox size={14} />;
      case 'today': return <CalendarDays size={14} />;
      case 'upcoming': return <CalendarRange size={14} />;
      default: return <i className="todo-dot" style={{ background: colorOf(projectOf(world, view)?.color ?? '') }} />;
    }
  };
  return <Popover anchor={anchor} onClose={onClose} label={t('목록 이동')} className="todo-menu todo-switcher">
    <div ref={list} role="listbox" aria-label={t('목록 이동')} aria-activedescendant={`todo-switch-${marked}`}>
      {targets.map((view, index) => <button key={viewKey(view)} id={`todo-switch-${index}`} type="button" role="option" aria-selected={index === marked}
        className={`${index === marked ? 'marked' : ''} ${index === shown ? 'current' : ''}`}
        onMouseEnter={() => setMarked(index)} onClick={() => onChoose(view)}>
        <kbd>{index + 1}</kbd>{icon(view)}<span>{viewTitle(view, world, '')}</span>
      </button>)}
    </div>
  </Popover>;
}
