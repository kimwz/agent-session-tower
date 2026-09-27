import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Bot, LoaderCircle } from 'lucide-react';
import type { MasterDirective } from '../../../shared/master';
import { scopedId } from '../remote/scope';
import { followRoom, type RoomState } from './room-stream';
import { useWords } from './strings';
import './master.css';

const MasterPanel = lazy(() => import('./MasterPanel').then(module => ({ default: module.MasterPanel })));

/** What the dock may do on the owner's screen: the page's own actions, handed down, never new state. */
export interface MasterControls {
  selectSession(id: string | null): void;
}

const SEEN_KEY = 'tower.master.seen-order';
const TAB_KEY = 'tower.master.tab';
/** One id per browser tab, so the master opens results only where the owner is talking. */
function tabId(): string {
  try {
    const known = window.sessionStorage.getItem(TAB_KEY);
    if (known) return known;
    const id = crypto.randomUUID();
    window.sessionStorage.setItem(TAB_KEY, id);
    return id;
  } catch { return 'tab'; }
}

/**
 * The master agent's floating button (bottom left) and its panel. Hidden when this Tower has no master.
 * `sessionId` is the conversation the owner has open, so "this session" means something.
 */
export function MasterDock({ token, controls, sessionId }: { token: string; controls: MasterControls; sessionId: string | null }) {
  const words = useWords();
  const [open, setOpen] = useState(false);
  const [room, setRoom] = useState<RoomState>({ entries: [], hasMore: false });
  const [absent, setAbsent] = useState(false);
  const [seen, setSeen] = useState(() => Number(window.localStorage.getItem(SEEN_KEY) ?? '-1'));
  const follow = useRef<ReturnType<typeof followRoom> | undefined>(undefined);
  const tab = useRef(tabId());
  const controlsRef = useRef(controls);
  controlsRef.current = controls;
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // A Tower without the master answers 404: no button at all. A first look that could not connect is tried again.
    const probe = (wait: number) => void fetch('/api/master', { cache: 'no-store' }).then(response => {
      if (cancelled) return;
      if (response.status === 404) { setAbsent(true); return; }
      follow.current = followRoom(setRoom, (directive: MasterDirective) => {
        if (directive.tabId !== tab.current || directive.expiresAt < Date.now()) return;
        if (directive.kind === 'openSession') controlsRef.current.selectSession(scopedId(directive.node, directive.sessionId));
      });
    }).catch(() => { if (!cancelled) retry = setTimeout(() => probe(Math.min(wait * 2, 30_000)), wait); });
    probe(2000);
    return () => { cancelled = true; if (retry) clearTimeout(retry); follow.current?.stop(); };
  }, []);

  const lastOrder = room.entries.at(-1)?.order ?? -1;
  const unread = open ? 0 : room.entries.filter(entry => entry.order > seen && (entry.data.kind === 'master' || entry.data.kind === 'error' || (entry.data.kind === 'task' && entry.data.state !== 'running'))).length;
  useEffect(() => {
    if (!open || lastOrder <= seen) return;
    setSeen(lastOrder);
    try { window.localStorage.setItem(SEEN_KEY, String(lastOrder)); } catch { /* ignore */ }
  }, [open, lastOrder, seen]);

  // Shift+M opens and closes the panel, except while typing or in a terminal.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'M' || !event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || event.isComposing || event.keyCode === 229) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .xterm, .workspace-overlay')) return;
      event.preventDefault();
      setOpen(value => !value);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const position = useDockPosition();
  const close = useCallback(() => { setOpen(false); requestAnimationFrame(() => button.current?.focus()); }, []);
  if (absent) return null;
  const overview = room.overview;
  const thinking = overview?.state === 'thinking' || Boolean(room.draft);
  const attention = overview && (overview.state === 'unconfigured');
  return <>
    <button ref={button} className={`master-fab ${thinking ? 'thinking' : ''} ${attention ? 'attention' : ''} ${open ? 'open' : ''}`} style={fabStyle(position)} onClick={() => setOpen(value => !value)}
      aria-label={words('마스터 에이전트', 'Master agent')} title={`${words('마스터 에이전트', 'Master agent')} (Shift+M)`} aria-expanded={open} aria-keyshortcuts="Shift+M">
      {thinking ? <LoaderCircle size={22} className="spin" /> : <Bot size={22} />}
      {unread > 0 && <span className="master-fab-badge">{unread > 9 ? '9+' : unread}</span>}
      {!unread && (overview?.activeTasks ?? 0) > 0 && <span className="master-fab-tasks">{overview!.activeTasks}</span>}
    </button>
    {open && <Suspense fallback={<div className="master-panel"><LoaderCircle className="spin" size={18} /></div>}>
      <MasterPanel token={token} room={room} tabId={tab.current} sessionId={sessionId} top={position.panelTop} onClose={close} onEarlier={() => follow.current?.earlier() ?? Promise.resolve()} onOpenSession={id => controlsRef.current.selectSession(id)} />
    </Suspense>}
  </>;
}

function fabStyle({ panelTop: _, ...style }: React.CSSProperties & { panelTop?: number }): React.CSSProperties { return style; }

/**
 * Keeps the button clear of what already sits at the bottom left: the expanded sidebar on wide screens and a
 * conversation's composer on phones. It measures them instead of changing their styles.
 */
function useDockPosition(): React.CSSProperties & { panelTop?: number } {
  const [style, setStyle] = useState<React.CSSProperties & { panelTop?: number }>({});
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const sidebar = document.getElementById('session-sidebar');
        const sidebarBox = sidebar && !sidebar.hidden ? sidebar.getBoundingClientRect() : undefined;
        const docked = sidebarBox && sidebarBox.width > 0 && getComputedStyle(sidebar!).position !== 'absolute';
        const composer = window.innerWidth <= 680 ? document.querySelector('.composer-section') : null;
        const composerBox = composer?.getBoundingClientRect();
        const keyboard = window.visualViewport ? window.innerHeight - window.visualViewport.height > 120 : false;
        const header = document.querySelector('.app-header')?.getBoundingClientRect();
        setStyle({
          // The panel starts right under the page header, whatever its height at this width.
          ...(header ? { panelTop: Math.max(0, Math.round(header.bottom)) } : {}),
          left: `calc(${docked ? Math.round(sidebarBox!.right) : 0}px + max(16px, env(safe-area-inset-left)))`,
          bottom: `calc(${composerBox && composerBox.height ? Math.round(window.innerHeight - composerBox.top) + 8 : 0}px + max(16px, env(safe-area-inset-bottom)))`,
          ...(keyboard ? { display: 'none' } : {}),
        });
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    // A conversation's composer grows as the owner types; the button follows it on phones.
    const composers = new ResizeObserver(measure);
    let watched: Element | null = null;
    const watchComposer = () => {
      const composer = document.querySelector('.composer-section');
      if (composer === watched) return;
      if (watched) composers.unobserve(watched);
      watched = composer;
      if (composer) composers.observe(composer);
    };
    watchComposer();
    const mutations = new MutationObserver(() => { watchComposer(); measure(); });
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] });
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); composers.disconnect(); mutations.disconnect(); window.removeEventListener('resize', measure); window.visualViewport?.removeEventListener('resize', measure); };
  }, []);
  return style;
}
