import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Bot, LoaderCircle, Mic } from 'lucide-react';
import { DEFAULT_MASTER_VOICE, type MasterDirective, type MasterScreenCommand } from '../../../shared/master';
import { post } from './api';
import { followRoom, type RoomState } from './room-stream';
import { runScreenCommand, type MasterControls } from './screen';
import { useWords } from './strings';
import { VoiceCall, type CallView } from './voice-client';
import { digest, shouldWake } from './voice-sound';
import type { VoiceControls } from './VoiceBar';
import './master.css';

const MasterPanel = lazy(() => import('./MasterPanel').then(module => ({ default: module.MasterPanel })));

export type { MasterControls } from './screen';

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
  const tokenRef = useRef(token);
  tokenRef.current = token;
  /** Commands already done here, until they expire, so one sent again after a reconnect is not done twice. */
  const done = useRef(new Map<string, number>());
  // The voice call lives here, not in the panel: closing the panel does not end it.
  const call = useRef<VoiceCall | null>(null);
  const [callView, setCallView] = useState<CallView | null>(null);
  const [voiceEnd, setVoiceEnd] = useState<{ reason: string; error?: string } | null>(null);
  const [tabHash, setTabHash] = useState<string>();
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  /** A call news tried to start here failed: no more of that until the owner starts one. */
  const wakeFailed = useRef(false);
  const silence = useRef(DEFAULT_MASTER_VOICE.silenceSeconds);

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // A Tower without the master answers 404: no button at all. A first look that could not connect is tried again.
    const probe = (wait: number) => void fetch('/api/master', { cache: 'no-store' }).then(response => {
      if (cancelled) return;
      if (response.status === 404) { setAbsent(true); return; }
      follow.current = followRoom(setRoom, (directive: MasterDirective) => {
        for (const [id, expiresAt] of done.current) if (expiresAt < Date.now()) done.current.delete(id);
        if (directive.tabId !== tab.current || directive.expiresAt < Date.now() || done.current.has(directive.id)) return;
        done.current.set(directive.id, directive.expiresAt);
        let answer;
        try { answer = runScreenCommand(directive, controlsRef.current); }
        catch (error) { answer = { result: 'failed' as const, note: error instanceof Error ? error.message : String(error) }; }
        void post(`/api/master/directives/${directive.id}`, tokenRef.current, answer).catch(() => {});
      }, {
        status: voice => call.current?.lease(voice),
        notice: notice => call.current?.say(notice),
        connected: up => call.current?.stream(up),
      });
    }).catch(() => { if (!cancelled) retry = setTimeout(() => probe(Math.min(wait * 2, 30_000)), wait); });
    probe(2000);
    return () => { cancelled = true; if (retry) clearTimeout(retry); follow.current?.stop(); void call.current?.stop('owner'); };
  }, []);

  const voiceSupported = typeof window !== 'undefined' && window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia) && typeof RTCPeerConnection !== 'undefined';
  useEffect(() => { if (voiceSupported) void digest(tab.current).then(setTabHash).catch(() => {}); }, [voiceSupported]);
  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  const startVoice = useCallback((wake: boolean) => {
    if (call.current) return;
    if (!wake) wakeFailed.current = false;
    const current: VoiceCall = new VoiceCall({
      token: () => tokenRef.current, tabId: tab.current, wake, silenceSeconds: () => silence.current,
      onView: view => { if (call.current === current) setCallView(view); },
      onEnded: (reason, error) => {
        if (call.current !== current) return;
        call.current = null;
        setCallView(null);
        setVoiceEnd({ reason, ...(error ? { error } : {}) });
        if (wake && reason === 'failed') wakeFailed.current = true;
      },
    });
    call.current = current;
    setVoiceEnd(null);
    setCallView({ phase: 'starting', speaking: false, playing: false });
    void current.start().catch(() => { /* Shown by onEnded. */ });
  }, []);

  const voiceSettings = room.overview?.settings.voice ?? DEFAULT_MASTER_VOICE;
  silence.current = voiceSettings.silenceSeconds;
  // News the master has to tell wakes a call that ended on silence here, while the panel is open and in view.
  useEffect(() => {
    if (shouldWake({ status: room.voice, tabHash, panelOpen: open, autoWake: voiceSettings.autoWake, visible, busy: Boolean(call.current), failed: wakeFailed.current })) startVoice(true);
  }, [room.voice, tabHash, open, voiceSettings.autoWake, visible, startVoice]);
  const voice: VoiceControls = {
    supported: voiceSupported, view: callView, end: voiceEnd, ...(room.voice ? { status: room.voice } : {}),
    start: () => startVoice(false), stop: () => { void call.current?.stop('owner'); }, dismiss: () => setVoiceEnd(null),
  };

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
    <button ref={button} className={`master-fab ${thinking ? 'thinking' : ''} ${attention ? 'attention' : ''} ${open ? 'open' : ''} ${callView ? 'voice' : ''}`} style={fabStyle(position)} onClick={() => setOpen(value => !value)}
      aria-label={words('마스터 에이전트', 'Master agent')} title={`${words('마스터 에이전트', 'Master agent')} (Shift+M)`} aria-expanded={open} aria-keyshortcuts="Shift+M">
      {callView ? <Mic size={22} /> : thinking ? <LoaderCircle size={22} className="spin" /> : <Bot size={22} />}
      {unread > 0 && <span className="master-fab-badge">{unread > 9 ? '9+' : unread}</span>}
      {!unread && (overview?.activeTasks ?? 0) > 0 && <span className="master-fab-tasks">{overview!.activeTasks}</span>}
    </button>
    {open && <Suspense fallback={<div className="master-panel"><LoaderCircle className="spin" size={18} /></div>}>
      <MasterPanel token={token} room={room} tabId={tab.current} sessionId={sessionId} voice={voice} top={position.panelTop} onClose={close} onEarlier={() => follow.current?.earlier() ?? Promise.resolve()} onOpenSession={id => controlsRef.current.selectSession(id)}
        onCommand={(command: MasterScreenCommand) => runScreenCommand(command, controlsRef.current)} />
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
