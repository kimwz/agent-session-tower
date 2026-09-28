import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Bot, LoaderCircle, Mic, Settings } from 'lucide-react';
import { APP_VERSION } from '../../../shared/app-identity';
import { DEFAULT_MASTER_VOICE, type MasterDirective } from '../../../shared/master';
import { splitScopedId } from '../remote/scope';
import { post } from './api';
import { followRoom, type RoomState } from './room-stream';
import { runScreenCommand, type MasterControls } from './screen';
import { useWords } from './strings';
import { VoiceSession, type VoiceView } from './voice-client';
import { VoiceBar, type VoiceControls } from './VoiceBar';
import './master.css';

const MasterPanel = lazy(() => import('./MasterPanel').then(module => ({ default: module.MasterPanel })));

export type { MasterControls } from './screen';

const TAB_KEY = 'tower.master.tab';
/** How often a tab showing the master says so, so the master's screen commands go there. */
const PRESENCE_MS = 30_000;
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
 * The master agent's floating button (bottom left). The master is a session: the button opens its conversation like
 * any other, or, before it has one, a panel to start it. While its conversation is open, a small bar beside the button
 * holds voice and the master's settings. Hidden when this Tower has no master. `sessionId` is the open conversation.
 */
export function MasterDock({ token, controls, sessionId }: { token: string; controls: MasterControls; sessionId: string | null }) {
  const words = useWords();
  const [open, setOpen] = useState(false);
  const [room, setRoom] = useState<RoomState>({});
  const [absent, setAbsent] = useState(false);
  const follow = useRef<ReturnType<typeof followRoom> | undefined>(undefined);
  const tab = useRef(tabId());
  const controlsRef = useRef(controls);
  controlsRef.current = controls;
  const button = useRef<HTMLButtonElement>(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  /** Commands already done here, until they expire, so one sent again after a reconnect is not done twice. */
  const done = useRef(new Map<string, number>());
  // Voice lives here: closing the conversation does not turn it off (news is then not read aloud).
  const voiceRef = useRef<VoiceSession | null>(null);
  const [voiceView, setVoiceView] = useState<VoiceView | null>(null);
  const [voiceEnded, setVoiceEnded] = useState<{ reason: string; error?: string } | null>(null);
  const voiceSettings = useRef(DEFAULT_MASTER_VOICE);

  const overview = room.overview;
  const masterId = overview?.session?.id;
  const { node: viewNode, id: viewSession } = sessionId ? splitScopedId(sessionId) : { node: undefined, id: undefined };
  const masterOpen = Boolean(masterId && !viewNode && viewSession === masterId);
  const masterOpenRef = useRef(masterOpen);
  masterOpenRef.current = masterOpen;

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
        status: voice => voiceRef.current?.status(voice),
        say: say => voiceRef.current?.say(say),
        connected: () => {},
      });
    }).catch(() => { if (!cancelled) retry = setTimeout(() => probe(Math.min(wait * 2, 30_000)), wait); });
    probe(2000);
    return () => { cancelled = true; if (retry) clearTimeout(retry); follow.current?.stop(); voiceRef.current?.stop(); };
  }, []);

  // A tab showing the master's conversation is where its screen commands go.
  useEffect(() => {
    if (!masterOpen) return;
    const tell = () => { void post('/api/master/presence', tokenRef.current, { tabId: tab.current }).catch(() => {}); };
    tell();
    const timer = setInterval(tell, PRESENCE_MS);
    return () => clearInterval(timer);
  }, [masterOpen]);

  voiceSettings.current = overview?.settings.voice ?? DEFAULT_MASTER_VOICE;
  // Called straight from the owner's click, so the browser lets what is read aloud play later.
  const startVoice = useCallback(() => {
    if (voiceRef.current) return;
    const current: VoiceSession = new VoiceSession({
      token: () => tokenRef.current, tabId: tab.current, settings: () => voiceSettings.current, panelOpen: () => masterOpenRef.current, viewContext: () => undefined,
      onView: view => { if (voiceRef.current === current) setVoiceView(view); },
      onEnded: (reason, error) => {
        if (voiceRef.current !== current) return;
        voiceRef.current = null;
        setVoiceView(null);
        setVoiceEnded({ reason, ...(error ? { error } : {}) });
      },
    });
    voiceRef.current = current;
    setVoiceEnded(null);
    setVoiceView({ listening: false, capturing: false });
    void current.start().catch(() => { /* Shown through onEnded. */ });
  }, []);
  // Whether the master is open here matters for reading news aloud: told at once.
  useEffect(() => { voiceRef.current?.touch(); }, [masterOpen]);
  const unavailable = !VoiceSession.supported() ? words('음성은 https 주소나 이 컴퓨터(localhost)에서 마이크를 쓸 수 있을 때만 됩니다.', 'Voice needs an https address or this computer (localhost), and a microphone.')
    : overview && overview.version !== APP_VERSION ? words('마스터가 업데이트를 기다리는 중입니다. 잠시 뒤 음성을 쓸 수 있습니다.', 'The master is waiting to update; voice is available shortly.')
    : overview && !overview.voiceConfigured ? words('마스터 설정에 ElevenLabs API 키를 넣으면 음성을 쓸 수 있습니다.', 'Add an ElevenLabs API key in the master settings to use voice.')
    : undefined;
  const voice: VoiceControls = {
    ...(unavailable ? { unavailable } : {}), view: voiceView, ended: voiceEnded, ...(room.voice ? { status: room.voice } : {}),
    start: startVoice, stop: () => voiceRef.current?.stop(), listen: () => { void voiceRef.current?.listen(); }, mute: () => voiceRef.current?.mute(),
    skip: () => voiceRef.current?.skip(), replay: () => voiceRef.current?.replay(), dismiss: () => setVoiceEnded(null),
    finish: () => voiceRef.current?.finish(), discard: () => voiceRef.current?.discard(),
  };

  // The button opens (or closes) the master's conversation; before the master has a session, its start panel.
  const press = useCallback(() => {
    if (!masterId) { setOpen(value => !value); return; }
    setOpen(false);
    controlsRef.current.selectSession(masterOpenRef.current ? null : masterId);
  }, [masterId]);
  const pressRef = useRef(press);
  pressRef.current = press;
  // Shift+M does the same, except while typing or in a terminal.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'M' || !event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || event.isComposing || event.keyCode === 229) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .xterm, .workspace-overlay')) return;
      event.preventDefault();
      pressRef.current();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const position = useDockPosition();
  const close = useCallback(() => { setOpen(false); requestAnimationFrame(() => button.current?.focus()); }, []);
  if (absent) return null;
  const thinking = overview?.session?.status === 'working';
  const tasks = overview?.activeTasks ?? 0;
  return <>
    <button ref={button} className={`master-fab ${thinking ? 'thinking' : ''} ${masterOpen || open ? 'open' : ''} ${voiceView ? 'voice' : ''}`} style={fabStyle(position)} onClick={press}
      aria-label={words('마스터 에이전트', 'Master agent')} title={`${words('마스터 에이전트', 'Master agent')} (Shift+M)`} aria-pressed={masterOpen || open} aria-keyshortcuts="Shift+M">
      {voiceView ? <Mic size={22} /> : thinking ? <LoaderCircle size={22} className="spin" /> : <Bot size={22} />}
      {tasks > 0 && <span className="master-fab-tasks" title={words('맡긴 일 중 아직 보고되지 않은 것', 'Handed-out work not reported yet')}>{tasks}</span>}
    </button>
    {(masterOpen || voiceView || voiceEnded) && !open && <div className="master-bar" style={barStyle(position)}>
      <VoiceBar voice={voice} />
      <div className="master-bar-buttons">
        {!voiceView && <button className="master-mic" onClick={voice.start} disabled={Boolean(voice.unavailable)} title={voice.unavailable ?? words('말로 시키기 (ElevenLabs 받아쓰기·읽어 주기)', 'Talk to the master (ElevenLabs speech to text and reading aloud)')} aria-label={words('음성 대화 시작', 'Start voice')}><Mic size={16} /></button>}
        <button className="master-mic" onClick={() => setOpen(true)} title={words('마스터 설정', 'Master settings')} aria-label={words('마스터 설정', 'Master settings')}><Settings size={16} /></button>
      </div>
    </div>}
    {open && <Suspense fallback={<div className="master-panel"><LoaderCircle className="spin" size={18} /></div>}>
      <MasterPanel token={token} overview={overview} voice={voice} top={position.panelTop} onClose={close} onStarted={id => { setOpen(false); controlsRef.current.selectSession(id); }} />
    </Suspense>}
  </>;
}

function fabStyle({ panelTop: _, ...style }: React.CSSProperties & { panelTop?: number }): React.CSSProperties { return style; }
/** The bar sits right of the button, on the same line. */
function barStyle({ panelTop: _, left, ...style }: React.CSSProperties & { panelTop?: number }): React.CSSProperties {
  return { ...style, ...(left !== undefined ? { left: `calc(${String(left).replace(/^calc/, '')} + 62px)` } : {}) };
}

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
