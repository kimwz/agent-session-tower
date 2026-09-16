import { translate as t, useI18n } from './i18n';
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { applyNodeChanges, Background, BackgroundVariant, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type FitViewOptions, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import { ArrowUpRight, Check, GitBranch, Maximize, Minus, Monitor, Plus, Radio, Scan, Sparkles } from 'lucide-react';
import type { ProjectGroup, ProjectGroupPatch, ProviderHealth, Session } from '../../shared/types';
import { SessionContextIcon } from './SessionContextIcon';
import { cleanPreview, providerLabels, relativeTime, sessionActivityAt, sessionTitle, statusLabels } from './lib';
import { graphProjectId, graphSessionGroups, clearHostPosition, HOST_HEIGHT } from './graph-layout';
import { defaultGraphPreferences, GRAPH_PREFERENCES_KEY, manualProjectBounds, manualSessionGroups, moveManualGraphNodes, parseGraphPreferences, reconcileManualGraph, setGraphLayoutMode, type GraphLayoutMode, type GraphPreferences } from './graph-layout-preferences';
import { includePinnedProjectGroups, projectGroupLabel } from './project-groups';
import { ProjectGroupHeader, type ProjectGroupHeaderData } from './ProjectGroupHeader';
import './manual-graph.css';
import './auto-prompt.css';
import { ProviderUsage } from './ProviderUsage';
import { CanvasSettings } from './CanvasSettings';

type AgentData = { session: Session; selected: boolean; unread: boolean; onSelect: (id: string) => void };
type ProjectData = ProjectGroupHeaderData & { onAutoPrompt: (cwd?: string) => void };
type HostData = { name: string; active: number; providers: ProviderHealth[]; disabled: boolean; onAutoPrompt: (cwd?: string) => void };

const AgentNode = memo(function AgentNode({ data }: NodeProps<Node<AgentData>>) {
  useI18n();
  const contextDescriptionId = useId();
  const session = data.session;
  const activityAt = sessionActivityAt(session);
  return <>
    <button className={`agent-card ${session.provider} ${session.status} ${data.selected ? 'selected' : ''} ${data.unread ? 'has-unread' : ''}`} onClick={() => data.onSelect(session.id)} aria-describedby={contextDescriptionId} aria-label={t("{0}: {1}, {2}{3}. 대화 열기", { 0: providerLabels[session.provider], 1: sessionTitle(session), 2: statusLabels[session.status], 3: data.unread ? t(", 새 활동") : t(", 확인함") })}>
      {data.unread && <span className="agent-unread"><i />{t("새 활동")}</span>}
      <div className="agent-card-top"><SessionContextIcon provider={session.provider} usage={session.contextUsage} descriptionId={contextDescriptionId} />{session.isSubagent && <span className="subagent-mark" title={t("하위 에이전트")}><GitBranch size={12} /></span>}</div>
      <div className="agent-card-title" title={sessionTitle(session)}>{sessionTitle(session)}</div>
      <div className="agent-card-bottom"><span className="agent-provider">{providerLabels[session.provider]}</span><span className={`agent-state ${session.status}`}>{session.status === 'completed' ? <Check size={11} /> : session.status === 'working' ? <Radio size={11} /> : <i />}{statusLabels[session.status]}</span></div>
      <p className="agent-card-preview">{cleanPreview(session.lastMessage) || t("대화 기록을 확인하세요")}</p><time className="agent-updated" dateTime={activityAt}>{relativeTime(activityAt)}<ArrowUpRight size={11} /></time>
    </button>
  </>;
});

const ProjectGroupNode = memo(function ProjectGroupNode({ data }: NodeProps<Node<ProjectData>>) {
  useI18n();
  return <div className={`manual-project-lane ${data.hidden ? 'is-hidden' : ''}`}><div className="project-drag-handle"><Handle type="target" position={Position.Top} /><ProjectGroupHeader data={data} /></div><button type="button" className="auto-prompt-trigger nodrag nopan" aria-label={t("{0} 폴더에서 Auto Prompt 열기", { 0: data.name })} title="Auto Prompt" disabled={data.disabled || !data.path.startsWith('/')} onClick={() => data.onAutoPrompt(data.path)}><Sparkles size={32} aria-hidden="true" /></button>{!data.count && <p className="project-group-empty">{t("표시된 세션이 없습니다")}<span>{t("+ 버튼으로 이 폴더에서 시작하세요")}</span></p>}</div>;
});
const HostNode = memo(function HostNode({ data }: NodeProps<Node<HostData>>) {
  useI18n();
  return <div className="host-with-usage"><div className="host-node has-auto-prompt"><span className="host-icon"><Monitor size={20} /></span><div className="host-copy"><strong title={data.name}>{data.name || t("이 Mac")}</strong><span><i className={data.active ? 'live-pip' : ''} /><span>{data.active ? t("{0}개 에이전트 작업 중", { 0: data.active }) : t("다음 작업을 기다리는 중")}</span></span></div><button type="button" className="auto-prompt-trigger nodrag nopan" aria-label={t("이 기기에서 Auto Prompt 열기")} title="Auto Prompt" disabled={data.disabled} onClick={() => data.onAutoPrompt()}><Sparkles size={32} aria-hidden="true" /></button></div><ProviderUsage providers={data.providers} /><Handle type="source" position={Position.Bottom} /></div>;
});
const nodeTypes = { agent: AgentNode, projectGroup: ProjectGroupNode, host: HostNode };

type GraphProps = { providers: ProviderHealth[]; sessions: Session[]; allSessions?: Session[]; sessionsReady?: boolean; unreadIds?: ReadonlySet<string>; selectedId: string | null; hostname: string; onSelect: (id: string) => void; filterKey: string; groups: ProjectGroup[]; visiblePins: ProjectGroup[]; groupSaving: ReadonlySet<string>; groupErrors: Readonly<Record<string, string>>; groupActionsDisabled: boolean; onGroupUpdate: (patch: ProjectGroupPatch) => Promise<boolean>; onGroupCreate: (cwd: string) => void; onAutoPrompt: (cwd?: string) => void; showHidden: boolean; onShowHiddenChange: (showHidden: boolean) => void; settingsSuspended: boolean; emptyState?: ReactNode };

function readPreferences(): GraphPreferences {
  try { return parseGraphPreferences(window.localStorage.getItem(GRAPH_PREFERENCES_KEY)); }
  catch { return defaultGraphPreferences(); }
}

function Canvas({ providers, sessions, allSessions = sessions, sessionsReady = true, unreadIds, selectedId, hostname, onSelect, filterKey, groups, visiblePins, groupSaving, groupErrors, groupActionsDisabled, onGroupUpdate, onGroupCreate, onAutoPrompt, showHidden, onShowHiddenChange, settingsSuspended, emptyState }: GraphProps) {
  const { language } = useI18n();
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const canvas = useRef<HTMLDivElement>(null);
  const fitVisibleGraph = useCallback((options: FitViewOptions) => {
    const bounds = canvas.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return;
    // Mobile chat can hide the pane between frames; D3 zoom animation cannot use a zero-size extent.
    void fitView({ ...options, duration: 0 });
  }, [fitView]);
  const [motion, setMotion] = useState(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [zoom, setZoom] = useState(100);
  const [graphLimit, setGraphLimit] = useState(8);
  const [preferences, setPreferences] = useState(readPreferences);
  const [manualFitRequest, setManualFitRequest] = useState(0);
  const manual = preferences.mode === 'manual';
  const retainedGroups = useMemo(() => groups.filter(group => group.pinned || group.hidden), [groups]);
  const groupMetadata = useMemo(() => new Map(groups.map(group => [group.cwd, group])), [groups]);
  const visibleAgentIds = useMemo(() => new Set(sessions.map(session => session.id)), [sessions]);
  const seedSessions = useMemo(() => manual ? sessions : graphSessionGroups(sessions, graphLimit, selectedId).flatMap(([, members]) => members), [manual, sessions, graphLimit, selectedId]);
  const manualLayout = useMemo(() => reconcileManualGraph(preferences.layout, allSessions, sessionsReady, seedSessions, retainedGroups), [preferences.layout, allSessions, sessionsReady, seedSessions, retainedGroups]);

  useEffect(() => {
    setPreferences(current => {
      const layout = reconcileManualGraph(current.layout, allSessions, sessionsReady, seedSessions, retainedGroups);
      return layout === current.layout ? current : { ...current, layout };
    });
  }, [allSessions, sessionsReady, seedSessions, retainedGroups]);

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
      const width = columns * 268 + 14;
      const projectId = graphProjectId(path);
      const rows = Math.max(1, Math.ceil(members.length / columns));
      const metadata = groupMetadata.get(path);
      const projectData: ProjectData = { name: projectGroupLabel(path, metadata?.title, members[0]?.project), title: metadata?.title || '', pinned: metadata?.pinned || false, hidden: metadata?.hidden || false, path, count: members.length, active: members.filter(s => s.status === 'working').length, manual, disabled: groupActionsDisabled, saving: groupSaving.has(path), error: groupErrors[path], onUpdate: onGroupUpdate, onCreate: onGroupCreate, onAutoPrompt };
      const savedProject = manualLayout.projects[projectId];
      if (manual && savedProject) {
        const bounds = manualProjectBounds(manualLayout, projectId, visibleAgentIds)!;
        ns.push({ id: projectId, type: 'projectGroup', zIndex: 1, position: bounds.position, data: projectData, style: { width: bounds.width, height: bounds.height }, dragHandle: '.project-drag-handle', selectable: false, draggable: true, focusable: false });
      } else {
        ns.push({ id: projectId, type: 'projectGroup', zIndex: 1, position: { x, y: 185 }, data: projectData, style: { width, height: rows * 215 + 121 }, draggable: false, selectable: false, focusable: false });
      }
      es.push({ id: `host-${projectId}`, source: 'host', target: projectId, type: 'smoothstep', zIndex: 0, animated: motion && members.some(s => s.status === 'working'), style: { stroke: '#3b4d63', strokeWidth: 1.2 }, pathOptions: { borderRadius: 14 } } as Edge);
      members.forEach((session, index) => {
        const savedAgent = manualLayout.agents[session.id];
        const placedManually = manual && savedProject && savedAgent;
        // Flat world positions keep pointer and drag-stop coordinates independent
        // from the enclosing rectangle as its origin follows moving cards.
        ns.push({ id: session.id, type: 'agent', position: placedManually ? { x: savedProject.position.x + savedAgent.position.x, y: savedProject.position.y + savedAgent.position.y } : { x: x + 20 + (index % columns) * 268, y: 291 + Math.floor(index / columns) * 215 }, zIndex: 3, ...(placedManually ? { dragHandle: '.agent-card' } : {}), data: { session, selected: session.id === selectedId, unread: unreadIds?.has(session.id) || false, onSelect }, style: { pointerEvents: 'all' }, draggable: !!placedManually, selectable: false, focusable: false });
      });
      x += width + 36;
    });
    const hostPosition = manual ? clearHostPosition(manualLayout.host, ns.filter(node => node.type === 'projectGroup').map(node => ({ position: node.position, width: Number(node.style?.width) || 0, height: Number(node.style?.height) || 0 }))) : { x: Math.max(0, (x - 36) / 2 - 128), y: 0 };
    ns.push({ id: 'host', type: 'host', position: hostPosition, data: { name: hostname, active: sessions.filter(s => s.status === 'working').length, providers, disabled: groupActionsDisabled, onAutoPrompt }, style: { width: 256, height: HOST_HEIGHT, pointerEvents: 'all' }, zIndex: 20, draggable: manual, dragHandle: '.host-node', selectable: false, focusable: false });
    return { modelNodes: ns, edges: es, shown: grouped.reduce((total, [, members]) => total + members.length, 0) };
  }, [sessions, selectedId, onSelect, hostname, providers, language, motion, graphLimit, manual, manualLayout, unreadIds, visibleAgentIds, visiblePins, groupMetadata, groupActionsDisabled, groupSaving, groupErrors, onGroupUpdate, onGroupCreate, onAutoPrompt]);

  const [nodes, setNodes] = useState(modelNodes);
  const visibleProjectKey = modelNodes.filter(node => node.type === 'projectGroup').map(node => node.id).join('|');
  useLayoutEffect(() => {
    setNodes(current => {
      const prior = new Map(current.map(node => [node.id, node]));
      return modelNodes.map(node => ({ ...node, measured: prior.get(node.id)?.measured, dragging: prior.get(node.id)?.dragging }));
    });
  }, [modelNodes]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes(current => applyNodeChanges(changes, current));
    if (!manual) return;
    const moves = changes.flatMap(change => change.type === 'position' && change.position ? [{ id: change.id, position: change.position }] : []);
    if (!moves.length) return;
    setPreferences(current => {
      const reconciled = reconcileManualGraph(current.layout, allSessions, sessionsReady, seedSessions, retainedGroups);
      const layout = moveManualGraphNodes(reconciled, moves, visibleAgentIds);
      return layout === current.layout ? current : { ...current, layout };
    });
  }, [manual, allSessions, sessionsReady, seedSessions, visibleAgentIds, retainedGroups]);

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
  }, [filterKey, fitVisibleGraph, graphLimit, manual, visibleProjectKey]);

  useEffect(() => {
    if (!manual || !manualFitRequest) return;
    const timeout = window.setTimeout(() => fitVisibleGraph({ padding: 0.1, minZoom: 0.15, maxZoom: 0.95 }), 100);
    return () => window.clearTimeout(timeout);
  }, [manualFitRequest, manual, fitVisibleGraph]);

  const working = sessions.filter(session => session.status === 'working').length;
  return <div ref={canvas} className={`graph-canvas ${manual ? 'manual-layout' : 'auto-layout'} ${motion ? '' : 'motion-off'}`}>
    <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.1, minZoom: 0.15, maxZoom: 0.95, duration: 0 }} minZoom={0.15} maxZoom={1.75} nodesDraggable={manual} nodeDragThreshold={5} nodesConnectable={false} edgesFocusable={false} elementsSelectable={false} panActivationKeyCode={null} proOptions={{ hideAttribution: true }} onMove={(_, viewport) => setZoom(Math.round(viewport.zoom * 100))} aria-label={t("프로젝트별 에이전트 세션 그래프")} colorMode="dark">
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#283343" />
    </ReactFlow>
    {emptyState}
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
