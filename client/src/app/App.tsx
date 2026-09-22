import { WorkspaceOverlayProvider } from '../workspace/WorkspaceOverlay';
import { AuthGate } from '../auth/AuthGate';
import { AccountButton } from '../auth/AccountPanel';
import { SlackMonitorPanel } from '../slack/SlackMonitorPanel';
import { SlackReplyProposals } from '../slack/SlackReplyProposals';
import { SlackConversationAlert } from '../slack/SlackConversationAlert';
import { useSlackMonitor } from '../slack/use-slack-monitor';
import { slackChatSelection, slackCoordinatorSessionIds } from '../slack/slack-chat-selection';
import { SlackButton } from '../slack/SlackPanel';
import { translate as t, translateMessage, useI18n } from '../i18n/i18n';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, Check, ChevronDown, CircleHelp, Folder, LoaderCircle, Monitor, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, Search, ShieldCheck, Terminal, TriangleAlert, WifiOff, X } from 'lucide-react';
import type { ProjectGroup, ProjectGroupPatch, Provider, Run, Session, SessionStatus, Snapshot } from '../../../shared/types';
import { Graph } from '../graph/Graph';
import { BrandMark, ProviderIcon } from '../common/Icons';
import { useMediaQuery } from '../common/use-media-query';
import { api, providerLabels, sessionActivityAt, sessionTitle, sortSessions } from '../common/lib';
import { getMainSessionId, getMainSessions } from '../sessions/session-family';
import { acknowledgeSession, conversationRevision, parseReadState, pruneReadState, readStateKey } from '../sessions/session-read-state';
import { NewSessionDialog } from '../sessions/NewSessionDialog';
import { AutoPromptDialog } from '../auto-prompt/AutoPromptDialog';
import { canvasVisibleSessions, projectGroupChoices, visiblePinnedProjectGroups } from '../project-groups/project-groups';
import { isAutoPromptShortcut, isNewSessionShortcut, isShowAllShortcut } from '../graph/canvas-shortcuts';
import { SidebarFilters } from '../sessions/SidebarFilters';
import { SessionRow } from '../sessions/SessionRow';
import { reconcileApprovalDecisions } from '../chat/chat-approvals';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';

type StatusFilter = 'all' | SessionStatus;
const readSelection = () => new URLSearchParams(window.location.search).get('session');
const ChatPanel = lazy(() => import('../chat/ChatPanel').then(module => ({ default: module.ChatPanel })));
// Storage keys keep the project's first name so saved user state survives the rename (shared/app-identity.ts LEGACY_APP_NAME).
const sidebarPreferenceKey = 'agent-monitor.sidebar-collapsed';
const emptyProjectGroups: ProjectGroup[] = [];
const editingControls = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]';
const shortcutEditingControls = 'input:not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]';

const WorkspacePage = lazy(() => import('../workspace/WorkspacePage').then(module => ({ default: module.WorkspacePage })));
export function App() {
  const params = new URLSearchParams(window.location.search);
  const cwd = params.get('workspace');
  return <AuthGate>{cwd ? <Suspense fallback={<div className="chat-loading"><LoaderCircle className="spin" size={20} /></div>}><WorkspacePage cwd={cwd} initialTool={params.get('tool') || 'editor'} /></Suspense> : <WorkspaceOverlayProvider><TowerApp /></WorkspaceOverlayProvider>}</AuthGate>;
}

function TowerApp() {
  const { language } = useI18n();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'offline'>('connecting');
  const { slack, error: slackError } = useSlackMonitor(connection === 'connected');
  const [requestedSlackId, setSelectedSlackId] = useState<string | null | undefined>(undefined);
  const [loadError, setLoadError] = useState('');
  const [token, setToken] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(readSelection);
  const { mentionId: selectedSlackId, chatId: activeChatId } = slackChatSelection(slack?.events || [], requestedSlackId, selectedId);
  const [provider, setProvider] = useState<'all' | Provider>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [project, setProject] = useState('all');
  const [period, setPeriod] = useState('1');
  const [showHidden, setShowHidden] = useState(false);
  const [query, setQuery] = useState('');
  const [listLimit, setListLimit] = useState(80);
  const [showSidebar, setShowSidebar] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return window.localStorage.getItem(sidebarPreferenceKey) === 'true'; } catch { return false; }
  });
  const [showHelp, setShowHelp] = useState(false);
  const [showNewSession, setShowNewSession] = useState(false);
  const [showAutoPrompt, setShowAutoPrompt] = useState(false);
  const [autoPromptCwd, setAutoPromptCwd] = useState<string>();
  const [newSessionCwd, setNewSessionCwd] = useState<string>();
  const [groupSaving, setGroupSaving] = useState<ReadonlySet<string>>(() => new Set());
  const [groupErrors, setGroupErrors] = useState<Record<string, string>>({});
  const groupInFlight = useRef(new Set<string>());
  const [showClosed, setShowClosed] = useState(false);
  const [changingClosed, setChangingClosed] = useState(false);
  const [readState, setReadState] = useState(() => {
    try { return parseReadState(window.localStorage.getItem(readStateKey)); } catch { return {}; }
  });
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const searchRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLElement>(null);
  const canvasPointerScope = useRef(true);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const mobileViewport = useMediaQuery('(max-width: 680px)');
  const narrowViewport = useMediaQuery('(max-width: 900px)');
  const sidebarIsDrawer = mobileViewport || (narrowViewport && (!!selectedId || selectedSlackId !== undefined));
  const sidebarOpen = sidebarIsDrawer ? showSidebar : !sidebarCollapsed;

  useEffect(() => { document.documentElement.lang = language; }, [language]);
  useEffect(() => { if (snapshot) reconcileApprovalDecisions(snapshot.runs); }, [snapshot?.runs]);

  useEffect(() => {
    try { window.localStorage.setItem(sidebarPreferenceKey, String(sidebarCollapsed)); } catch { /* Keep the current preference when storage is unavailable. */ }
  }, [sidebarCollapsed]);
  useEffect(() => { setShowSidebar(false); }, [sidebarIsDrawer]);
  useEffect(() => { if (!sidebarOpen) setShowHelp(false); }, [sidebarOpen]);
  useEffect(() => {
    try { window.localStorage.setItem(readStateKey, JSON.stringify(readState)); } catch { /* Reading remains usable when browser storage is unavailable. */ }
  }, [readState]);
  const onRead = useCallback((id: string, revision: string) => setReadState(previous => acknowledgeSession(previous, id, revision)), []);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void api<Snapshot>('/api/snapshot').then(value => { setSnapshot(value); setLoadError(''); }).catch(error => setLoadError(error instanceof Error ? error.message : t("서버에 연결하지 못했습니다."))).finally(() => setRefreshing(false));
    void api<{ token: string }>('/api/bootstrap').then(value => setToken(value.token)).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const events = new EventSource('/api/events');
    events.addEventListener('snapshot', event => {
      try { setSnapshot(JSON.parse((event as MessageEvent<string>).data) as Snapshot); setConnection('connected'); setLoadError(''); } catch { setLoadError(t("세션 업데이트를 읽지 못했습니다. 새로고침해 주세요.")); }
    });
    events.onopen = () => { setConnection('connected'); void api<{ token: string }>('/api/bootstrap').then(value => setToken(value.token)).catch(() => {}); };
    events.onerror = () => setConnection('offline');
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    const onPop = () => { setSelectedId(readSelection()); setSelectedSlackId(undefined); };
    window.addEventListener('popstate', onPop);
    return () => { events.close(); window.clearInterval(timer); window.removeEventListener('popstate', onPop); };
  }, [refresh]);

  const selectSession = useCallback((id: string | null) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('session', id); else url.searchParams.delete('session');
    window.history.pushState({}, '', `${url.pathname}${url.search}`);
    setSelectedId(id); setSelectedSlackId(undefined); setShowSidebar(false);
  }, []);
  const selectSlack = useCallback((id: string | null) => { selectSession(null); setSelectedSlackId(id); }, [selectSession]);
  const onSelect = useCallback((id: string) => selectSession(id), [selectSession]);
  const closeChat = useCallback(() => selectSession(null), [selectSession]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('.workspace-overlay')) return;
      if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) && !target.isContentEditable) { event.preventDefault(); if (sidebarIsDrawer) setShowSidebar(true); else setSidebarCollapsed(false); requestAnimationFrame(() => searchRef.current?.focus()); }
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (showNewSession || showAutoPrompt || document.querySelector('dialog[open], [aria-modal="true"]')) return;
      if (showHelp) { event.preventDefault(); setShowHelp(false); return; }
      if (sidebarIsDrawer && showSidebar) { event.preventDefault(); setShowSidebar(false); sidebarToggleRef.current?.focus(); return; }
      if (selectedId || selectedSlackId !== undefined) {
        event.preventDefault();
        closeChat();
        requestAnimationFrame(() => canvasRef.current?.focus({ preventScroll: true }));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [closeChat, selectedId, selectedSlackId, showHelp, showNewSession, showAutoPrompt, sidebarIsDrawer, showSidebar]);
  const onSessionUpdate = useCallback((updated: Session) => {
    setSnapshot(previous => previous ? { ...previous, sessions: previous.sessions.map(session => session.id === updated.id ? { ...session, customTitle: updated.customTitle } : session) } : previous);
  }, []);
  const openNewSession = useCallback((cwd?: string) => { setNewSessionCwd(cwd); setShowNewSession(true); }, []);
  const closeNewSession = useCallback(() => { setShowNewSession(false); setNewSessionCwd(undefined); }, []);
  const openAutoPrompt = useCallback((cwd?: string) => { setAutoPromptCwd(cwd); setShowAutoPrompt(true); }, []);
  useEffect(() => {
    const inCanvasContext = (element: Element | null) => {
      if (!element || element.closest(`${shortcutEditingControls}, .sidebar, .chat-panel, .workspace-overlay, .help-popover, dialog, [role="dialog"]`)) return false;
      return !!canvasRef.current?.contains(element) || (canvasPointerScope.current && (element === document.body || element === document.documentElement
        || element.id === 'root' || element.matches('.app, .workspace')));
    };
    const handler = (event: KeyboardEvent) => {
      const showAllShortcut = isShowAllShortcut(event);
      const newSessionShortcut = isNewSessionShortcut(event);
      if ((!isAutoPromptShortcut(event) && !showAllShortcut && !newSessionShortcut) || showHelp || showNewSession || showAutoPrompt || (sidebarIsDrawer && showSidebar)
        || !canvasRef.current?.getClientRects().length
        || document.querySelector('dialog[open], [aria-modal="true"]')) return;
      const inShortcutContext = (element: Element | null) => inCanvasContext(element) || (newSessionShortcut && !!element?.closest('.sidebar-toggle'));
      if (!inShortcutContext(event.target instanceof Element ? event.target : document.activeElement) || !inShortcutContext(document.activeElement)) return;
      if (newSessionShortcut && (!token || connection !== 'connected')) return;
      event.preventDefault();
      if (showAllShortcut) setShowHidden(value => !value);
      else { canvasRef.current?.focus({ preventScroll: true }); if (newSessionShortcut) openNewSession(); else openAutoPrompt(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [openAutoPrompt, openNewSession, showHelp, showNewSession, showAutoPrompt, sidebarIsDrawer, showSidebar, token, connection]);
  const closeAutoPrompt = useCallback(() => setShowAutoPrompt(false), []);
  const openAutoPromptSession = useCallback((id: string) => {
    selectSession(id);
    refresh();
  }, [refresh, selectSession]);
  const updateGroup = useCallback(async (patch: ProjectGroupPatch): Promise<boolean> => {
    if (groupInFlight.current.has(patch.cwd) || !token || connection !== 'connected') return false;
    groupInFlight.current.add(patch.cwd);
    setGroupSaving(new Set(groupInFlight.current));
    setGroupErrors(previous => ({ ...previous, [patch.cwd]: '' }));
    try {
      const { group } = await api<{ group: ProjectGroup }>('/api/groups', { method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token }, body: JSON.stringify(patch) });
      setSnapshot(previous => previous ? { ...previous, groups: [...(previous.groups || []).filter(item => item.cwd !== group.cwd), group] } : previous);
      return true;
    } catch (error) {
      setGroupErrors(previous => ({ ...previous, [patch.cwd]: error instanceof Error ? error.message : t("그룹을 저장하지 못했습니다. 다시 시도해 주세요.") }));
      return false;
    } finally {
      groupInFlight.current.delete(patch.cwd);
      setGroupSaving(new Set(groupInFlight.current));
    }
  }, [connection, token]);
  const sessions = snapshot?.sessions || [];
  const groups = snapshot?.groups || emptyProjectGroups;
  const groupTitles = useMemo(() => new Map(groups.map(group => [group.cwd, group.title])), [groups]);
  const coordinatorIds = useMemo(() => slackCoordinatorSessionIds(slack?.events || []), [slack?.events]);
  const allMainSessions = useMemo(() => getMainSessions(sessions).filter(session => !coordinatorIds.has(session.id)), [sessions, coordinatorIds]);
  const mainSessions = useMemo(() => allMainSessions.filter(session => !session.closed), [allMainSessions]);
  const closedSessions = useMemo(() => allMainSessions.filter(session => session.closed).sort(sortSessions), [allMainSessions]);
  const selectedMainId = useMemo(() => getMainSessionId(sessions, activeChatId), [sessions, activeChatId]);
  const selectedSession = sessions.find(session => session.id === activeChatId);
  const selectedMainSession = sessions.find(session => session.id === selectedMainId);
  const revisions = useMemo(() => new Map(sessions.map(session => [session.id, conversationRevision(session, snapshot?.runs)])), [sessions, snapshot?.runs]);
  const unreadIds = useMemo(() => new Set(mainSessions.filter(session => readState[session.id] !== revisions.get(session.id)).map(session => session.id)), [mainSessions, readState, revisions]);
  useEffect(() => { if (snapshot && !snapshot.scanning) setReadState(previous => pruneReadState(previous, snapshot.sessions)); }, [snapshot]);
  const filterKey = `${provider}:${status}:${project}:${period}:${query}`;
  useEffect(() => { setListLimit(80); }, [filterKey]);
  const projects = useMemo(() => projectGroupChoices(allMainSessions, groups), [allMainSessions, groups, language]);
  const filtered = useMemo(() => {
    const term = query.toLocaleLowerCase().trim();
    const cutoff = period === 'all' ? 0 : now - Number(period) * 86_400_000;
    return mainSessions.filter(session => (provider === 'all' || session.provider === provider) && (status === 'all' || session.status === status) && (project === 'all' || session.cwd === project) && (session.status === 'working' || session.activeProcess || +new Date(sessionActivityAt(session)) >= cutoff) && (!term || `${groupTitles.get(session.cwd) || ''} ${session.customTitle || ''} ${session.title} ${session.agentName || ''} ${session.project} ${session.cwd} ${session.nativeId} ${session.lastMessage}`.toLocaleLowerCase().includes(term))).sort(sortSessions);
  }, [mainSessions, provider, status, project, period, query, now, groupTitles]);
  const canvasSessions = useMemo(() => canvasVisibleSessions(filtered, groups, showHidden), [filtered, groups, showHidden]);
  const revealableGroups = useMemo(() => visiblePinnedProjectGroups(groups, allMainSessions, project, query, true, filtered), [groups, allMainSessions, project, query, filtered]);
  const visiblePins = useMemo(() => showHidden ? revealableGroups : revealableGroups.filter(group => !group.hidden), [showHidden, revealableGroups]);
  const hasHiddenMatches = !showHidden && (canvasSessions.length < canvasVisibleSessions(filtered, groups, true).length || revealableGroups.some(group => group.hidden));
  const working = mainSessions.filter(session => session.status === 'working').length;
  const completed = mainSessions.filter(session => session.status === 'completed').length;
  const currentRuns = useMemo(() => (snapshot?.runs || []).filter(run => run.sessionId === activeChatId).sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)), [snapshot?.runs, activeChatId]);
  const clearFilters = () => { setProvider('all'); setStatus('all'); setProject('all'); setPeriod('all'); setQuery(''); };
  const hasFilters = provider !== 'all' || status !== 'all' || project !== 'all' || !!query;
  const listedSessions = showClosed ? closedSessions.filter(session => (provider === 'all' || session.provider === provider) && (project === 'all' || session.cwd === project) && (!query.trim() || `${groupTitles.get(session.cwd) || ''} ${sessionTitle(session)} ${session.cwd} ${session.lastMessage}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))) : filtered;
  const changeSessionClosed = useCallback(async () => {
    if (!selectedMainSession || changingClosed || !token || connection !== 'connected') return;
    const closing = !selectedMainSession.closed;
    setChangingClosed(true);
    try {
      await api(`/api/sessions/${encodeURIComponent(selectedMainSession.id)}/${closing ? 'close' : 'reopen'}`, { method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token }, body: '{}' });
      setSnapshot(previous => previous ? { ...previous, sessions: previous.sessions.map(session => session.id === selectedMainSession.id ? { ...session, closed: closing } : session) } : previous);
      if (closing) closeChat();
      else setShowClosed(false);
      refresh();
    } finally { setChangingClosed(false); }
  }, [changingClosed, closeChat, connection, refresh, selectedMainSession, token]);
  const sessionCreated = useCallback((session: Session, run: Run) => {
    setSnapshot(previous => previous ? { ...previous, sessions: previous.sessions.some(item => item.id === session.id) ? previous.sessions : [...previous.sessions, session], runs: previous.runs.some(item => item.id === run.id) ? previous.runs : [...previous.runs, run] } : previous);
    setShowClosed(false); setProvider('all'); setStatus('all'); setProject('all'); setQuery(''); setPeriod('1');
    selectSession(session.id);
    refresh();
  }, [refresh, selectSession]);

  const hasCanvasHistory = canvasVisibleSessions(mainSessions, [], true).length > 0;
  const canvasEmptyState = !canvasSessions.length && !visiblePins.length && <div className="graph-empty canvas-empty">
    <h3>{hasHiddenMatches ? t("폴더가 숨겨져 있습니다") : hasCanvasHistory ? t("표시할 세션이 없습니다") : t("새 세션을 시작해 보세요")}</h3>
    <p>{hasHiddenMatches ? t("전체보기를 켜면 현재 필터에 맞는 숨긴 폴더와 세션을 볼 수 있습니다.") : hasCanvasHistory ? t("검색어나 필터를 바꾸면 다른 세션을 볼 수 있습니다.") : t("Claude Code 또는 Codex를 선택해 이곳에서 작업을 시작할 수 있습니다.")}</p>
    {hasHiddenMatches ? <button className="secondary-button" onClick={() => setShowHidden(true)}>{t("전체보기 켜기")}</button> : hasCanvasHistory ? <button className="secondary-button" onClick={clearFilters}><RefreshCw size={13} />{t("전체 기록 보기")}</button> : <button className="secondary-button" onClick={() => openNewSession()} disabled={!token || connection !== 'connected'}><Plus size={13} />{t("새 세션")}</button>}
  </div>;

  return <div className={`app ${selectedId || selectedSlackId !== undefined ? 'has-chat' : ''} ${sidebarOpen ? '' : 'canvas-only'}`} onPointerDownCapture={event => {
    // Clicking ordinary sidebar/chat text can leave body focused. Preserve the
    // interaction scope so that fallback does not turn a canvas key into a global one.
    // Portalled dialogs bubble through React; keep their opener's scope intact.
    if (!(event.target instanceof Element) || event.target.closest('dialog, [role="dialog"], [aria-modal="true"]')) return;
    canvasPointerScope.current = !!canvasRef.current?.contains(event.target) || event.target === event.currentTarget || event.target.matches('.workspace');
  }}>
    <header className="app-header"><div className="brand"><button ref={sidebarToggleRef} className="icon-button sidebar-toggle" onClick={() => sidebarIsDrawer ? setShowSidebar(value => !value) : setSidebarCollapsed(value => !value)} aria-label={sidebarOpen ? t("세션 목록 접기") : t("세션 목록 열기")} title={sidebarOpen ? t("세션 목록 접기") : t("세션 목록 열기")} aria-controls="session-sidebar" aria-expanded={sidebarOpen}>{sidebarOpen ? <PanelLeftClose size={19} /> : <PanelLeftOpen size={19} />}</button><span className="brand-mark"><BrandMark /></span><h1>Agent Session Tower</h1><span className="brand-local">local</span></div><div className="header-center"><Monitor size={13} /><span>{snapshot?.hostname || t("이 Mac")}</span><span className="header-divider" /><span className="localhost">{window.location.host}</span></div><div className="header-actions"><span className={`connection-state ${connection}`} role="status">{connection === 'offline' ? <WifiOff size={12} /> : <i />}{connection === 'connected' ? t("실시간 연결") : connection === 'offline' ? t("재연결 중") : t("연결 중")}</span><button className={`icon-button ${showHelp ? 'active' : ''}`} title={t("사용 안내")} aria-label={t("사용 안내")} aria-expanded={showHelp} onClick={() => setShowHelp(!showHelp)}><CircleHelp size={18} /></button><SlackButton token={token} /><AccountButton /></div></header>
    {connection === 'offline' && <div className="connection-banner" role="alert"><WifiOff size={14} /><span>{t("Monitor와의 연결이 끊겼습니다. 저장된 화면을 표시하며 자동으로 다시 연결합니다.")}</span><button onClick={refresh}>{t("다시 확인")}</button></div>}
    {showHelp && <div className="help-popover"><div className="help-heading"><h2>{t("내 컴퓨터의 에이전트를 한눈에")}</h2><button className="icon-button" onClick={() => setShowHelp(false)} aria-label={t("안내 닫기")}><X size={15} /></button></div><p>{t("Claude Code와 Codex의 로컬 세션 기록을 자동으로 읽습니다. 그래프의 에이전트를 선택하면 실제 대화를 보고 작업을 이어갈 수 있습니다.")}</p><div className="help-statuses"><span><i className="legend-dot working" /><b>{t("작업 중")}</b>{t("현재 실행 중인 작업")}</span><span><i className="legend-dot idle" /><b>{t("대기 중")}</b>{t("입력이나 다음 작업 대기")}</span><span><i className="legend-dot completed" /><b>{t("완료")}</b>{t("작업 종료가 기록된 세션")}</span></div><p>{t("상태는 프로세스와 세션 기록을 함께 확인합니다. 대화 상단의 프로젝트 이름을 누르면 상태 판단 근거를 볼 수 있습니다.")}</p><div className="help-privacy"><ShieldCheck size={16} /><span>{t("로컬에서 실행됩니다. 새 요청은 해당 CLI와 기존 로그인 계정을 사용합니다.")}</span></div><div className="help-shortcuts"><span><kbd>/</kbd> {' '}{t("세션 검색")}</span><span><kbd>Shift N</kbd> {t("새 세션")}</span><span><kbd>Shift P</kbd> Auto Prompt</span><span><kbd>Shift A</kbd> {t("숨긴 폴더 표시 전환")}</span><span><kbd>Esc</kbd> {' '}{t("대화 닫기")}</span><span><kbd>⌘ Enter</kbd> {' '}{t("요청 보내기")}</span></div></div>}
    <div className="workspace">
      {sidebarIsDrawer && sidebarOpen && <button className="sidebar-scrim" aria-label={t("세션 목록 닫기")} onClick={() => setShowSidebar(false)} />}
      <aside id="session-sidebar" className={`sidebar ${sidebarOpen ? 'open' : ''}`} hidden={!sidebarOpen} aria-label={t("세션 탐색")}><div className="sidebar-heading"><h2>{t("세션")}</h2><span>{mainSessions.length.toLocaleString()}</span><button className="icon-button refresh-button" onClick={refresh} title={t("세션 새로고침")} aria-label={t("세션 새로고침")} disabled={refreshing}><RefreshCw size={14} className={refreshing ? 'spin' : ''} /></button></div><div className="search-wrap"><Search size={15} /><input ref={searchRef} type="search" placeholder={t("세션, 프로젝트 검색")} aria-label={t("세션 검색")} value={query} onChange={event => setQuery(event.target.value)} /><kbd>/</kbd></div><div className="provider-filters" aria-label={t("에이전트 종류")}><button className={provider === 'all' ? 'selected' : ''} onClick={() => setProvider('all')} aria-pressed={provider === 'all'}>{t("전체")}</button><button className={provider === 'claude' ? 'selected claude' : ''} onClick={() => setProvider('claude')} aria-pressed={provider === 'claude'}><ProviderIcon provider="claude" size={13} />Claude</button><button className={provider === 'codex' ? 'selected codex' : ''} onClick={() => setProvider('codex')} aria-pressed={provider === 'codex'}><ProviderIcon provider="codex" size={13} />Codex</button></div><div className="sidebar-selects"><label><Folder size={13} /><select aria-label={t("프로젝트 필터")} value={project} onChange={event => setProject(event.target.value)}><option value="all">{t("모든 프로젝트")}</option>{projects.map(([path, name]) => <option key={path} value={path}>{name}</option>)}</select><ChevronDown size={11} /></label></div><SidebarFilters status={status} onStatusChange={setStatus} period={period} onPeriodChange={setPeriod} total={mainSessions.length} working={working} completed={completed} /><button className={`closed-sessions-toggle ${showClosed ? 'selected' : ''}`} onClick={() => { setShowClosed(value => !value); setListLimit(80); }} aria-pressed={showClosed}><Archive size={12} /><span>{showClosed ? t("열린 세션 보기") : t("종료한 세션")}</span><b>{closedSessions.length}</b></button><div className="session-list-label"><span>{showClosed ? t("종료한 세션") : hasFilters ? t("검색 결과") : t("최근 활동")}</span><span>{listedSessions.length.toLocaleString()}{t("개")}{hasFilters && <button onClick={() => { setQuery(''); setProvider('all'); setProject('all'); setStatus('all'); }} aria-label={t("검색 및 필터 초기화")}><X size={12} /></button>}</span></div><div className="session-list">
        {!snapshot ? <div className="sidebar-loading"><LoaderCircle className="spin" size={17} /><span>{t("세션을 찾고 있습니다")}</span></div> : listedSessions.length ? <>{listedSessions.slice(0, listLimit).map(session => <SessionRow key={session.id} session={session} selected={selectedMainId === session.id} unread={unreadIds.has(session.id)} onSelect={onSelect} />)}{listedSessions.length > listLimit && <button className="load-more-sessions" onClick={() => setListLimit(value => value + 80)}>{t("세션 더 보기")}{' '}<ChevronDown size={13} /><span>{Math.min(listLimit, listedSessions.length)} / {listedSessions.length.toLocaleString()}</span></button>}</> : <div className="sidebar-empty"><Search size={22} /><span>{showClosed ? t("종료한 세션이 없습니다") : sessions.length ? t("조건에 맞는 세션이 없습니다") : t("아직 발견된 세션이 없습니다")}</span>{sessions.length > 0 && <button onClick={clearFilters}>{t("전체 기록 보기")}</button>}</div>}
      </div><div className="providers-health"><div className="providers-health-label"><Terminal size={12} /><span>{t("로컬 에이전트")}</span>{snapshot?.scanning && <LoaderCircle size={11} className="spin" />}</div>{(['claude', 'codex'] as const).map(name => { const health = snapshot?.providers.find(item => item.provider === name); return <div className="provider-health" key={name} title={(health?.error ? translateMessage(health.error) : undefined) || health?.executable || t("{0} 상태 확인 중", { 0: providerLabels[name] })}><ProviderIcon provider={name} size={13} /><span>{providerLabels[name]}</span><span className={health?.available ? 'available' : 'unavailable'}>{health ? health.available ? <><Check size={10} />{t("사용 가능")}</> : t("CLI 없음") : t("확인 중")}</span></div>; })}<p><ShieldCheck size={10} />{t("이 Mac의 에이전트와 연결됩니다")}</p></div></aside>
      <main ref={canvasRef} className="main-area" tabIndex={-1} onPointerDownCapture={event => {
        // React Flow may prevent the browser's usual blur during a canvas drag.
        // Focus the canvas explicitly while preserving its interactive controls.
        if (event.button === 0 && event.target instanceof Element && !event.target.closest(`${editingControls}, button, a, summary, [role="button"], .canvas-settings-popover`)) {
          event.currentTarget.focus({ preventScroll: true });
        }
      }}>
        <button className="new-session-button canvas-new-session" onClick={() => openNewSession()} disabled={!token || connection !== 'connected'} aria-label={t("새 세션")} title={`${t("새 세션")} (Shift+N)`} aria-keyshortcuts="Shift+N"><Plus size={15} /><span>{t("새 세션")}</span></button>
        {loadError && <div className="main-error canvas-error" role="alert"><TriangleAlert size={15} /><span>{translateMessage(loadError)}</span><button onClick={refresh}>{t("다시 시도")}</button></div>}
        {!snapshot || (snapshot.scanning && sessions.length === 0 && !visiblePins.length && !slack?.connected) ? <>
          <div className="graph-loading"><div className="loading-constellation"><span /><span /><span /><Monitor size={25} /></div><h3>{t("이 Mac의 에이전트를 찾고 있습니다")}</h3><p>{t("Claude Code와 Codex의 실제 세션 기록을 연결합니다.")}</p></div>
        </> : <Graph slack={slack || undefined} selectedSlackId={selectedSlackId} onSelectSlack={selectSlack} token={token} providers={snapshot.providers} sessions={canvasSessions} allSessions={mainSessions} sessionsReady={!snapshot.scanning} unreadIds={unreadIds} selectedId={selectedMainId} hostname={snapshot.hostname} onSelect={onSelect} onCanvasClick={closeChat} filterKey={`${filterKey}:${showHidden}`} groups={groups} visiblePins={visiblePins} groupSaving={groupSaving} groupErrors={groupErrors} groupActionsDisabled={!token || connection !== 'connected'} onGroupUpdate={updateGroup} onGroupCreate={openNewSession} onAutoPrompt={openAutoPrompt} showHidden={showHidden} onShowHiddenChange={setShowHidden} settingsSuspended={showHelp || showNewSession || showAutoPrompt || (sidebarIsDrawer && showSidebar) || (mobileViewport && (!!selectedId || selectedSlackId !== undefined))} emptyState={canvasEmptyState} />}
      </main>
      {selectedSlackId !== undefined && !activeChatId && <SlackMonitorPanel token={token} slack={slack} error={slackError} mentionId={selectedSlackId} jobs={snapshot?.autoPrompts || []} onClose={closeChat} onSelectMention={selectSlack} onNavigate={onSelect} />}
      {activeChatId && <Suspense fallback={<aside className="chat-panel"><div className="chat-loading"><LoaderCircle className="spin" size={20} /><span>{t("대화를 여는 중")}</span></div></aside>}><ChatPanel contextBanner={<><SlackConversationAlert workflow={slack?.events.find(event => event.id === selectedSlackId)} /><SlackReplyProposals token={token} key={selectedSlackId} workflow={slack?.events.find(event => event.id === selectedSlackId)} /></>} key={activeChatId} sessionId={activeChatId} session={selectedSession} allSessions={sessions} provider={snapshot?.providers.find(item => item.provider === (selectedSession?.provider || (activeChatId.startsWith('claude') ? 'claude' : 'codex')))} runs={currentRuns} token={token} connected={connection === 'connected'} onClose={closeChat} onNavigate={onSelect} onSnapshotRefresh={refresh} onSessionUpdate={onSessionUpdate} onSessionClose={changeSessionClosed} sessionClosed={!!selectedMainSession?.closed} changingClosed={changingClosed} readRevision={showNewSession || showAutoPrompt || (sidebarIsDrawer && sidebarOpen) ? '' : revisions.get(activeChatId)} onRead={onRead} /></Suspense>}
    </div>
    <AutoPromptDialog visible={showAutoPrompt} initialCwd={autoPromptCwd} providers={snapshot?.providers || []} projects={projects} sessions={sessions} jobs={snapshot?.autoPrompts || []} token={token} connected={connection === 'connected'} onClose={closeAutoPrompt} onNavigate={openAutoPromptSession} onRefresh={refresh} />
    {showNewSession && <NewSessionDialog providers={snapshot?.providers || []} projects={projects} initialCwd={newSessionCwd || selectedSession?.cwd || (project !== 'all' ? project : undefined)} token={token} connected={connection === 'connected'} onClose={closeNewSession} onCreated={sessionCreated} />}
  </div>;
}
