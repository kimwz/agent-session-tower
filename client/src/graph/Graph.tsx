import { translate as t, useI18n } from '../i18n/i18n';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { applyNodeChanges, Background, BackgroundVariant, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type FitViewOptions, type Node, type NodeChange } from '@xyflow/react';
import { Maximize, Minus, Plus, Scan } from 'lucide-react';
import type { ProjectGroup, ProjectGroupPatch, ProviderHealth, Session } from '../../../shared/types';
import { nodeTypes, type ProjectData } from './GraphNodes';
import type { SlackPublicStatus } from '../../../shared/slack';
import { SlackMonitorNode, SlackMentionNode } from './SlackGraphNodes';
import { SLACK_MONITOR_ID, SLACK_POSITION_KEY, SLACK_PAGE_SIZE, parseSlackPosition, visibleSlackMentions, slackMentionLayout } from './slack-graph';
import { slackWorkflowWorking } from '../slack/slack-monitor';
const canvasNodeTypes = { ...nodeTypes, slackMonitor: SlackMonitorNode, slackMention: SlackMentionNode };
import { graphProjectId, graphProjectKey, graphSessionGroups, clearHostPosition, HOST_HEIGHT } from './graph-layout';
import { defaultGraphPreferences, GRAPH_PREFERENCES_KEY, manualProjectBounds, manualSessionGroups, moveManualGraphNodes, parseGraphPreferences, reconcileManualGraph, setGraphLayoutMode, type GraphLayoutMode, type GraphPreferences } from './graph-layout-preferences';
import { includePinnedProjectGroups, projectGroupLabel } from '../project-groups/project-groups';
import { CanvasSettings } from './CanvasSettings';
import { projectGroupMinimumWidth, projectGroupTitleMeasurer } from '../project-groups/project-group-title';

type GraphProps = { slack?: SlackPublicStatus | null; selectedSlackId?: string | null; onSelectSlack?: (id: string | null) => void; token?: string; providers: ProviderHealth[]; sessions: Session[]; allSessions?: Session[]; sessionsReady?: boolean; unreadIds?: ReadonlySet<string>; selectedId: string | null; hostname: string; onSelect: (id: string) => void; onCanvasClick?: () => void; filterKey: string; groups: ProjectGroup[]; visiblePins: ProjectGroup[]; groupSaving: ReadonlySet<string>; groupErrors: Readonly<Record<string, string>>; groupActionsDisabled: boolean; onGroupUpdate: (patch: ProjectGroupPatch) => Promise<boolean>; onGroupCreate: (cwd: string) => void; onAutoPrompt: (cwd?: string) => void; showHidden: boolean; onShowHiddenChange: (showHidden: boolean) => void; settingsSuspended: boolean; emptyState?: ReactNode };

function readPreferences(): GraphPreferences {
  try { return parseGraphPreferences(window.localStorage.getItem(GRAPH_PREFERENCES_KEY)); }
  catch { return defaultGraphPreferences(); }
}

function viewportTransitionDuration() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 280;
}

function Canvas({ slack, selectedSlackId, onSelectSlack, token = '', providers, sessions, allSessions = sessions, sessionsReady = true, unreadIds, selectedId, hostname, onSelect, onCanvasClick, filterKey, groups, visiblePins, groupSaving, groupErrors, groupActionsDisabled, onGroupUpdate, onGroupCreate, onAutoPrompt, showHidden, onShowHiddenChange, settingsSuspended, emptyState }: GraphProps) {
  const { language } = useI18n();
  const { fitView, zoomIn, zoomOut, getViewport, setViewport } = useReactFlow();
  const canvas = useRef<HTMLDivElement>(null);
  const doubleClickZoomed = useRef(false);
  const fitVisibleGraph = useCallback((options: FitViewOptions) => {
    const bounds = canvas.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return;
    if (!options.nodes) doubleClickZoomed.current = false;
    void fitView({ ...options, duration: options.duration ?? 0 });
  }, [fitView]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    // Cancel a pending D3 transition before a hidden mobile pane gives it a zero-size extent.
    const observer = new ResizeObserver(() => {
      const bounds = element.getBoundingClientRect();
      if (!bounds.width || !bounds.height) void setViewport(getViewport(), { duration: 0 });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [getViewport, setViewport]);
  const onCanvasDoubleClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element) || !event.target.matches('.react-flow__pane')) return;
    event.preventDefault();
    if (doubleClickZoomed.current) {
      fitVisibleGraph({ padding: 0.13, maxZoom: 0.95, duration: viewportTransitionDuration() });
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const viewport = getViewport();
    const nextZoom = Math.min(viewport.zoom * 2, 1.75);
    const ratio = nextZoom / viewport.zoom;
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    doubleClickZoomed.current = true;
    void setViewport({ x: x - (x - viewport.x) * ratio, y: y - (y - viewport.y) * ratio, zoom: nextZoom }, { duration: viewportTransitionDuration() });
  }, [fitVisibleGraph, getViewport, setViewport]);
  const [motion, setMotion] = useState(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [zoom, setZoom] = useState(100);
  const [graphLimit, setGraphLimit] = useState(8);
  const [slackLimit, setSlackLimit] = useState(SLACK_PAGE_SIZE);
  const [slackPosition, setSlackPosition] = useState(() => { try { return parseSlackPosition(window.localStorage.getItem(SLACK_POSITION_KEY)); } catch { return null; } });
  const showMoreSlack = useCallback(() => setSlackLimit(value => value + SLACK_PAGE_SIZE), []);
  const [preferences, setPreferences] = useState(readPreferences);
  const [manualFitRequest, setManualFitRequest] = useState(0);
  const manual = preferences.mode === 'manual';
  const retainedGroups = useMemo(() => groups.filter(group => group.pinned || group.hidden), [groups]);
  const groupMetadata = useMemo(() => new Map(groups.map(group => [group.cwd, group])), [groups]);
  const visibleAgentIds = useMemo(() => new Set(sessions.map(session => session.id)), [sessions]);
  const seedSessions = useMemo(() => manual ? sessions : graphSessionGroups(sessions, graphLimit, selectedId).flatMap(([, members]) => members), [manual, sessions, graphLimit, selectedId]);
  const minimumProjectWidths = useMemo(() => {
    const measure = projectGroupTitleMeasurer();
    const widths = new Map<string, number>();
    for (const session of seedSessions) {
      const path = graphProjectKey(session);
      const projectId = graphProjectId(path);
      const width = projectGroupMinimumWidth(projectGroupLabel(path, groupMetadata.get(path)?.title, session.project), measure);
      widths.set(projectId, Math.max(widths.get(projectId) || 0, width));
    }
    for (const group of visiblePins) {
      const projectId = graphProjectId(group.cwd);
      if (!widths.has(projectId)) widths.set(projectId, projectGroupMinimumWidth(projectGroupLabel(group.cwd, group.title), measure));
    }
    return widths;
  }, [seedSessions, groupMetadata, visiblePins, language]);
  const manualOptions = useMemo(() => ({ minimumProjectWidths, visibleProjectIds: new Set(minimumProjectWidths.keys()), repairHeaderWidths: manual }), [minimumProjectWidths, manual]);
  const manualLayout = useMemo(() => reconcileManualGraph(preferences.layout, allSessions, sessionsReady, seedSessions, retainedGroups, manualOptions), [preferences.layout, allSessions, sessionsReady, seedSessions, retainedGroups, manualOptions]);

  useEffect(() => {
    setPreferences(current => {
      const layout = reconcileManualGraph(current.layout, allSessions, sessionsReady, seedSessions, retainedGroups, manualOptions);
      return layout === current.layout ? current : { ...current, layout };
    });
  }, [allSessions, sessionsReady, seedSessions, retainedGroups, manualOptions]);

  useEffect(() => {
    try { window.localStorage.setItem(GRAPH_PREFERENCES_KEY, JSON.stringify(preferences)); }
    catch { /* Layout still works for this visit if storage is unavailable. */ }
  }, [preferences]);

  const { modelNodes, edges, shown } = useMemo(() => {
    const grouped = includePinnedProjectGroups(manual ? manualSessionGroups(sessions) : graphSessionGroups(sessions, graphLimit, selectedId), visiblePins);
    const ns: Node[] = [];
    const es: Edge[] = [];
    let x = 0;
    grouped.forEach(([path, members]) => {
      const columns = grouped.length === 1 && members.length > 6 ? 4 : members.length > 2 ? 2 : 1;
      const projectId = graphProjectId(path);
      const width = Math.max(columns * 268 + 14, minimumProjectWidths.get(projectId) || 0);
      const rows = Math.max(1, Math.ceil(members.length / columns));
      const metadata = groupMetadata.get(path);
      const projectData: ProjectData = { token, name: projectGroupLabel(path, metadata?.title, members[0]?.project), title: metadata?.title || '', pinned: metadata?.pinned || false, hidden: metadata?.hidden || false, path, count: members.length, active: members.filter(s => s.status === 'working').length, manual, disabled: groupActionsDisabled, saving: groupSaving.has(path), error: groupErrors[path], onUpdate: onGroupUpdate, onCreate: onGroupCreate, onAutoPrompt };
      const savedProject = manualLayout.projects[projectId];
      if (manual && savedProject) {
        const bounds = manualProjectBounds(manualLayout, projectId, visibleAgentIds, minimumProjectWidths)!;
        ns.push({ id: projectId, type: 'projectGroup', zIndex: 1, position: bounds.position, data: projectData, style: { width: bounds.width, height: bounds.height }, dragHandle: '.project-drag-handle', selectable: false, draggable: true, focusable: false });
      } else {
        ns.push({ id: projectId, type: 'projectGroup', zIndex: 1, position: { x, y: 185 }, data: projectData, style: { width, height: rows * 215 + 121 }, draggable: false, selectable: false, focusable: false });
      }
      es.push({ id: `host-${projectId}`, source: 'host', target: projectId, type: 'smoothstep', zIndex: 0, animated: motion && members.some(s => s.status === 'working'), style: { stroke: '#2e3e52', strokeWidth: 1.2 }, pathOptions: { borderRadius: 14 } } as Edge);
      members.forEach((session, index) => {
        const savedAgent = manualLayout.agents[session.id];
        const placedManually = manual && savedProject && savedAgent;
        // Flat world positions keep pointer and drag-stop coordinates independent
        // from the enclosing rectangle as its origin follows moving cards.
        ns.push({ id: session.id, type: 'agent', position: placedManually ? { x: savedProject.position.x + savedAgent.position.x, y: savedProject.position.y + savedAgent.position.y } : { x: x + 20 + (index % columns) * 268, y: 291 + Math.floor(index / columns) * 215 }, zIndex: 3, ...(placedManually ? { dragHandle: '.agent-card' } : {}), data: { session, selected: session.id === selectedId, unread: unreadIds?.has(session.id) || false, onSelect }, style: { pointerEvents: 'all' }, draggable: !!placedManually, selectable: false, focusable: false });
      });
      x += width + 36;
    });
    if (slack?.connected) {
      const mentions = visibleSlackMentions(slack.events, slackLimit, selectedSlackId);
      const right = ns.filter(node => node.type === 'projectGroup').reduce((max, node) => Math.max(max, node.position.x + Number(node.style?.width || 0) + 36), 0);
      const remaining = slack.events.length - mentions.length;
      const layout = slackMentionLayout(mentions.length, remaining > 0);
      ns.push({ id: SLACK_MONITOR_ID, type: 'slackMonitor', position: slackPosition || { x: right, y: 185 }, style: { width: layout.width, height: layout.height }, zIndex: 1, draggable: true, dragHandle: '.slack-monitor-drag-handle', selectable: false, focusable: false, data: { name: slack.account?.teamName || 'Slack', enabled: slack.enabled, status: slack.status, error: slack.error, count: slack.events.length, active: slack.events.filter(slackWorkflowWorking).length, remaining, onMore: showMoreSlack, onSelect: onSelectSlack } });
      mentions.forEach((event, index) => ns.push({ id: `slack:mention:${event.id}`, type: 'slackMention', parentId: SLACK_MONITOR_ID, extent: 'parent', style: { pointerEvents: 'all' }, position: layout.positions[index], zIndex: 3, draggable: false, selectable: false, focusable: false, data: { event, selected: event.id === selectedSlackId, onSelect: onSelectSlack } }));
      es.push({ id: 'host-slack', source: 'host', target: SLACK_MONITOR_ID, type: 'smoothstep', animated: motion && slack.events.some(slackWorkflowWorking), style: { stroke: '#675077', strokeWidth: 1.2 } });
    }
    const hostPosition = manual ? clearHostPosition(manualLayout.host, ns.filter(node => node.type === 'projectGroup').map(node => ({ position: node.position, width: Number(node.style?.width) || 0, height: Number(node.style?.height) || 0 }))) : { x: Math.max(0, (x - 36) / 2 - 128), y: 0 };
    ns.push({ id: 'host', type: 'host', position: hostPosition, data: { name: hostname, active: sessions.filter(s => s.status === 'working').length, providers, disabled: groupActionsDisabled, onAutoPrompt }, style: { width: 256, height: HOST_HEIGHT, pointerEvents: 'all' }, zIndex: 20, draggable: manual, dragHandle: '.host-node', selectable: false, focusable: false });
    return { modelNodes: ns, edges: es, shown: grouped.reduce((total, [, members]) => total + members.length, 0) };
  }, [slack, slackLimit, slackPosition, selectedSlackId, onSelectSlack, showMoreSlack, token, sessions, selectedId, onSelect, hostname, providers, language, motion, graphLimit, manual, manualLayout, unreadIds, visibleAgentIds, visiblePins, groupMetadata, minimumProjectWidths, groupActionsDisabled, groupSaving, groupErrors, onGroupUpdate, onGroupCreate, onAutoPrompt]);

  const [nodes, setNodes] = useState(modelNodes);
  const visibleProjectKey = modelNodes.filter(node => node.type === 'projectGroup' || node.type === 'slackMonitor').map(node => node.id).join('|');
  useLayoutEffect(() => {
    setNodes(current => {
      const prior = new Map(current.map(node => [node.id, node]));
      return modelNodes.map(node => ({ ...node, measured: prior.get(node.id)?.measured, dragging: prior.get(node.id)?.dragging }));
    });
  }, [modelNodes]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes(current => applyNodeChanges(changes, current));
    for (const change of changes) {
      if (change.type === 'position' && change.id === SLACK_MONITOR_ID && change.position) {
        const position = { ...change.position };
        setSlackPosition(position);
        try { window.localStorage.setItem(SLACK_POSITION_KEY, JSON.stringify(position)); } catch { /* Dragging remains usable without storage. */ }
      }
    }
    if (!manual) return;
    const moves = changes.flatMap(change => change.type === 'position' && change.id !== SLACK_MONITOR_ID && !change.id.startsWith('slack:mention:') && change.position ? [{ id: change.id, position: change.position }] : []);
    if (!moves.length) return;
    setPreferences(current => {
      const reconciled = reconcileManualGraph(current.layout, allSessions, sessionsReady, seedSessions, retainedGroups, manualOptions);
      const layout = moveManualGraphNodes(reconciled, moves, visibleAgentIds, minimumProjectWidths);
      return layout === current.layout ? current : { ...current, layout };
    });
  }, [manual, allSessions, sessionsReady, seedSessions, visibleAgentIds, retainedGroups, manualOptions, minimumProjectWidths]);

  const changeMode = (mode: GraphLayoutMode) => {
    if (mode === preferences.mode) return;
    setPreferences(current => setGraphLayoutMode(current, mode));
    if (mode === 'manual') setManualFitRequest(value => value + 1);
  };

  useEffect(() => { setGraphLimit(8); }, [filterKey]);

  useEffect(() => {
    if (manual) return;
    const timeout = window.setTimeout(() => fitVisibleGraph({ padding: 0.1, minZoom: 0.15, maxZoom: 0.95 }), 100);
    return () => window.clearTimeout(timeout);
  }, [filterKey, fitVisibleGraph, graphLimit, manual, visibleProjectKey, slackLimit]);

  useEffect(() => {
    if (!manual || !manualFitRequest) return;
    const timeout = window.setTimeout(() => fitVisibleGraph({ padding: 0.1, minZoom: 0.15, maxZoom: 0.95 }), 100);
    return () => window.clearTimeout(timeout);
  }, [manualFitRequest, manual, fitVisibleGraph]);

  const working = sessions.filter(session => session.status === 'working').length;
  return <div ref={canvas} className={`graph-canvas ${manual ? 'manual-layout' : 'auto-layout'} ${motion ? '' : 'motion-off'}`}>
    <ReactFlow onPaneClick={onCanvasClick} onDoubleClick={onCanvasDoubleClick} zoomOnDoubleClick={false} nodes={nodes} edges={edges} onNodesChange={onNodesChange} nodeTypes={canvasNodeTypes} fitView fitViewOptions={{ padding: 0.1, minZoom: 0.15, maxZoom: 0.95, duration: 0 }} minZoom={0.15} maxZoom={1.75} nodesDraggable={manual} nodeDragThreshold={5} nodesConnectable={false} edgesFocusable={false} elementsSelectable={false} panActivationKeyCode={null} proOptions={{ hideAttribution: true }} onMove={(_, viewport) => setZoom(Math.round(viewport.zoom * 100))} aria-label={t("프로젝트별 에이전트 세션 그래프")} colorMode="dark">
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#283343" />
    </ReactFlow>
    {!slack?.connected && emptyState}
    <div className="canvas-quick-controls" aria-label={t("캔버스 보기 도구")}>
      <div className="canvas-zoom-controls" role="group" aria-label={t("그래프 보기 조절")}><button onClick={() => { void zoomOut({ duration: 0 }); }} aria-label={t("그래프 축소")} title={t("축소")}><Minus size={15} /></button><span>{zoom}%</span><button onClick={() => { void zoomIn({ duration: 0 }); }} aria-label={t("그래프 확대")} title={t("확대")}><Plus size={15} /></button><i /><button onClick={() => fitVisibleGraph({ padding: 0.13, maxZoom: 0.95 })} aria-label={t("전체 그래프 맞춤")} title={t("전체 맞춤")}><Maximize size={15} /></button>{selectedId && nodes.some(n => n.id === selectedId) && <button className="canvas-find-session" onClick={() => fitVisibleGraph({ nodes: [{ id: selectedId }], maxZoom: 1.1, padding: 0.7 })} aria-label={t("선택한 세션 위치로 이동")} title={t("선택한 세션 찾기")}><Scan size={15} /></button>}</div>
      <CanvasSettings manual={manual} onLayoutChange={changeMode} motion={motion} onMotionChange={setMotion} showHidden={showHidden} onShowHiddenChange={onShowHiddenChange} suspended={settingsSuspended} />
    </div>
    <div className="canvas-session-summary"><span>{t("{0} / {1}개 세션 표시 · {2}개 작업 중", { 0: shown.toLocaleString(), 1: sessions.length.toLocaleString(), 2: working.toLocaleString() })}</span>{!manual && shown < sessions.length && graphLimit < 72 && <button onClick={() => setGraphLimit(value => Math.min(72, value + 8))}>{t("더 표시")}</button>}{!manual && graphLimit > 8 && <button onClick={() => setGraphLimit(8)}>{t("접기")}</button>}</div>
  </div>;
}

export function Graph(props: Parameters<typeof Canvas>[0]) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>;
}
