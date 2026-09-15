import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { applyNodeChanges, Background, BackgroundVariant, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type FitViewOptions, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import { ArrowUpRight, Check, ChevronRight, GitBranch, Maximize, Minus, Monitor, Move, Plus, Radio, Scan, Waypoints } from 'lucide-react';
import type { ProjectGroup, ProjectGroupPatch, Session } from '../../shared/types';
import { ProviderIcon } from './Icons';
import { cleanPreview, providerLabels, relativeTime, sessionActivityAt, sessionTitle, statusLabels } from './lib';
import { graphProjectId, graphSessionGroups } from './graph-layout';
import { defaultGraphPreferences, GRAPH_PREFERENCES_KEY, manualProjectBounds, manualSessionGroups, moveManualGraphNodes, parseGraphPreferences, reconcileManualGraph, setGraphLayoutMode, type GraphLayoutMode, type GraphPreferences } from './graph-layout-preferences';
import { includePinnedProjectGroups, projectGroupLabel } from './project-groups';
import { ProjectGroupHeader, type ProjectGroupHeaderData } from './ProjectGroupHeader';
import './manual-graph.css';

type AgentData = { session: Session; selected: boolean; unread: boolean; onSelect: (id: string) => void };
type ProjectData = ProjectGroupHeaderData;
type HostData = { name: string; active: number };

const AgentNode = memo(function AgentNode({ data }: NodeProps<Node<AgentData>>) {
  const session = data.session;
  const activityAt = sessionActivityAt(session);
  return <>
    <Handle type="target" position={Position.Top} />
    <button className={`agent-card ${session.provider} ${session.status} ${data.selected ? 'selected' : ''} ${data.unread ? 'has-unread' : ''}`} onClick={() => data.onSelect(session.id)} aria-label={`${providerLabels[session.provider]}: ${sessionTitle(session)}, ${statusLabels[session.status]}${data.unread ? ', 새 활동' : ', 확인함'}. 대화 열기`}>
      {data.unread && <span className="agent-unread"><i />새 활동</span>}
      <div className="agent-card-top"><span className={`agent-orb ${session.provider}`}><ProviderIcon provider={session.provider} size={28} /></span>{session.isSubagent && <span className="subagent-mark" title="하위 에이전트"><GitBranch size={12} /></span>}</div>
      <div className="agent-card-title" title={sessionTitle(session)}>{sessionTitle(session)}</div>
      <div className="agent-card-bottom"><span className="agent-provider">{providerLabels[session.provider]}</span><span className={`agent-state ${session.status}`}>{session.status === 'completed' ? <Check size={11} /> : session.status === 'working' ? <Radio size={11} /> : <i />}{statusLabels[session.status]}</span></div>
      <p className="agent-card-preview">{cleanPreview(session.lastMessage) || '대화 기록을 확인하세요'}</p><time className="agent-updated" dateTime={activityAt}>{relativeTime(activityAt)}<ArrowUpRight size={11} /></time>
    </button>
    <Handle type="source" position={Position.Bottom} />
  </>;
});

const ProjectGroupNode = memo(function ProjectGroupNode({ data }: NodeProps<Node<ProjectData>>) {
  return <div className="manual-project-lane"><div className="project-drag-handle"><Handle type="target" position={Position.Top} /><ProjectGroupHeader data={data} /><Handle type="source" position={Position.Bottom} /></div>{!data.count && <p className="project-group-empty">표시된 세션이 없습니다<span>+ 버튼으로 이 폴더에서 시작하세요</span></p>}</div>;
});
const HostNode = memo(function HostNode({ data }: NodeProps<Node<HostData>>) {
  return <div className="host-node"><span className="host-icon"><Monitor size={20} /></span><div><strong>{data.name || '이 Mac'}</strong><span><i className={data.active ? 'live-pip' : ''} />{data.active ? `${data.active}개 에이전트 작업 중` : '다음 작업을 기다리는 중'}</span></div><Handle type="source" position={Position.Bottom} /></div>;
});
const nodeTypes = { agent: AgentNode, projectGroup: ProjectGroupNode, host: HostNode };

type GraphProps = { sessions: Session[]; allSessions?: Session[]; sessionsReady?: boolean; unreadIds?: ReadonlySet<string>; selectedId: string | null; hostname: string; onSelect: (id: string) => void; filterKey: string; groups: ProjectGroup[]; visiblePins: ProjectGroup[]; groupSaving: ReadonlySet<string>; groupErrors: Readonly<Record<string, string>>; groupActionsDisabled: boolean; onGroupUpdate: (patch: ProjectGroupPatch) => Promise<boolean>; onGroupCreate: (cwd: string) => void };

function readPreferences(): GraphPreferences {
  try { return parseGraphPreferences(window.localStorage.getItem(GRAPH_PREFERENCES_KEY)); }
  catch { return defaultGraphPreferences(); }
}

function Canvas({ sessions, allSessions = sessions, sessionsReady = true, unreadIds, selectedId, hostname, onSelect, filterKey, groups, visiblePins, groupSaving, groupErrors, groupActionsDisabled, onGroupUpdate, onGroupCreate }: GraphProps) {
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
  const pinnedGroups = useMemo(() => groups.filter(group => group.pinned), [groups]);
  const groupMetadata = useMemo(() => new Map(groups.map(group => [group.cwd, group])), [groups]);
  const visibleAgentIds = useMemo(() => new Set(sessions.map(session => session.id)), [sessions]);
  const seedSessions = useMemo(() => manual ? sessions : graphSessionGroups(sessions, graphLimit, selectedId).flatMap(([, members]) => members), [manual, sessions, graphLimit, selectedId]);
  const manualLayout = useMemo(() => reconcileManualGraph(preferences.layout, allSessions, sessionsReady, seedSessions, pinnedGroups), [preferences.layout, allSessions, sessionsReady, seedSessions, pinnedGroups]);

  useEffect(() => {
    setPreferences(current => {
      const layout = reconcileManualGraph(current.layout, allSessions, sessionsReady, seedSessions, pinnedGroups);
      return layout === current.layout ? current : { ...current, layout };
    });
  }, [allSessions, sessionsReady, seedSessions, pinnedGroups]);

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
      const projectData: ProjectData = { name: projectGroupLabel(path, metadata?.title, members[0]?.project), title: metadata?.title || '', pinned: metadata?.pinned || false, path, count: members.length, active: members.filter(s => s.status === 'working').length, manual, disabled: groupActionsDisabled, saving: groupSaving.has(path), error: groupErrors[path], onUpdate: onGroupUpdate, onCreate: onGroupCreate };
      const savedProject = manualLayout.projects[projectId];
      if (manual && savedProject) {
        const bounds = manualProjectBounds(manualLayout, projectId, visibleAgentIds)!;
        ns.push({ id: projectId, type: 'projectGroup', position: bounds.position, data: projectData, style: { width: bounds.width, height: bounds.height }, dragHandle: '.project-drag-handle', selectable: false, draggable: true, focusable: false });
      } else {
        ns.push({ id: projectId, type: 'projectGroup', position: { x, y: 145 }, data: projectData, style: { width, height: rows * 215 + 121 }, draggable: false, selectable: false, focusable: false });
      }
      es.push({ id: `host-${projectId}`, source: 'host', target: projectId, type: 'smoothstep', animated: motion && members.some(s => s.status === 'working'), style: { stroke: '#3b4d63', strokeWidth: 1.2 }, pathOptions: { borderRadius: 14 } } as Edge);
      members.forEach((session, index) => {
        const savedAgent = manualLayout.agents[session.id];
        const placedManually = manual && savedProject && savedAgent;
        // Flat world positions keep pointer and drag-stop coordinates independent
        // from the enclosing rectangle as its origin follows moving cards.
        ns.push({ id: session.id, type: 'agent', position: placedManually ? { x: savedProject.position.x + savedAgent.position.x, y: savedProject.position.y + savedAgent.position.y } : { x: x + 20 + (index % columns) * 268, y: 251 + Math.floor(index / columns) * 215 }, zIndex: 1, ...(placedManually ? { dragHandle: '.agent-card' } : {}), data: { session, selected: session.id === selectedId, unread: unreadIds?.has(session.id) || false, onSelect }, style: { pointerEvents: 'all' }, draggable: !!placedManually, selectable: false, focusable: false });
        es.push({ id: `edge-${session.id}`, source: projectId, target: session.id, type: 'smoothstep', animated: motion && session.status === 'working', zIndex: 0, style: { stroke: session.status === 'working' ? (session.provider === 'claude' ? '#ba9060' : '#4b998b') : '#2b3b4e', strokeWidth: 1.1, opacity: session.status === 'completed' ? 0.55 : 0.95 }, pathOptions: { borderRadius: 10 } } as Edge);
      });
      x += width + 36;
    });
    ns.push({ id: 'host', type: 'host', position: manual ? manualLayout.host : { x: Math.max(0, (x - 36) / 2 - 128), y: 0 }, data: { name: hostname, active: sessions.filter(s => s.status === 'working').length }, draggable: manual, selectable: false, focusable: false });
    return { modelNodes: ns, edges: es, shown: grouped.reduce((total, [, members]) => total + members.length, 0) };
  }, [sessions, selectedId, onSelect, hostname, motion, graphLimit, manual, manualLayout, unreadIds, visibleAgentIds, visiblePins, groupMetadata, groupActionsDisabled, groupSaving, groupErrors, onGroupUpdate, onGroupCreate]);

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
      const reconciled = reconcileManualGraph(current.layout, allSessions, sessionsReady, seedSessions, pinnedGroups);
      const layout = moveManualGraphNodes(reconciled, moves, visibleAgentIds);
      return layout === current.layout ? current : { ...current, layout };
    });
  }, [manual, allSessions, sessionsReady, seedSessions, visibleAgentIds, pinnedGroups]);

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

  return <div ref={canvas} className={`graph-canvas ${manual ? 'manual-layout' : 'auto-layout'} ${motion ? '' : 'motion-off'}`}>
    <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.1, minZoom: 0.15, maxZoom: 0.95, duration: 0 }} minZoom={0.15} maxZoom={1.75} nodesDraggable={manual} nodeDragThreshold={5} nodesConnectable={false} edgesFocusable={false} elementsSelectable={false} panActivationKeyCode={null} proOptions={{ hideAttribution: true }} onMove={(_, viewport) => setZoom(Math.round(viewport.zoom * 100))} aria-label="프로젝트별 에이전트 세션 그래프" colorMode="dark">
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#283343" />
    </ReactFlow>
    <div className="canvas-caption"><span className="canvas-caption-symbol"><Waypoints size={14} /></span><span>이 Mac<ChevronRight size={12} />프로젝트<ChevronRight size={12} />세션</span></div>
    <div className="graph-layout-switch" role="group" aria-label="그래프 정렬 방식"><button aria-pressed={!manual} onClick={() => changeMode('auto')} title="최근 활동 순서로 자동 정렬"><Waypoints size={12} />자동 정렬</button><button aria-pressed={manual} onClick={() => changeMode('manual')} title="폴더와 세션을 드래그해 위치 지정"><Move size={12} />수동 배치</button>{manual && <span>폴더·카드를 드래그해 이동</span>}</div>
    <div className="graph-controls" aria-label="그래프 보기 조절"><button onClick={() => { void zoomOut({ duration: 0 }); }} aria-label="그래프 축소" title="축소"><Minus size={16} /></button><span>{zoom}%</span><button onClick={() => { void zoomIn({ duration: 0 }); }} aria-label="그래프 확대" title="확대"><Plus size={16} /></button><i /><button onClick={() => fitVisibleGraph({ padding: 0.13, maxZoom: 0.95 })} aria-label="전체 그래프 맞춤" title="전체 맞춤"><Maximize size={16} /></button>{selectedId && nodes.some(n => n.id === selectedId) && <button onClick={() => fitVisibleGraph({ nodes: [{ id: selectedId }], maxZoom: 1.1, padding: 0.7 })} aria-label="선택한 세션 위치로 이동" title="선택한 세션 찾기"><Scan size={16} /></button>}</div>
    <div className="graph-footer"><div className="graph-legend"><span><i className="legend-dot working" />작업 중</span><span><i className="legend-dot idle" />대기 중</span><span><i className="legend-dot completed" />완료</span></div><label className="motion-toggle"><input type="checkbox" checked={motion} onChange={event => setMotion(event.target.checked)} />흐름 표시</label></div>
    {manual ? <div className="graph-limit manual-session-count">{shown.toLocaleString()}개 세션 · 위치 자동 저장</div> : (shown < sessions.length || graphLimit > 8) && <div className="graph-limit"><span>최근 활동 {shown}개 표시 · 전체 {sessions.length.toLocaleString()}개</span>{shown < sessions.length && graphLimit < 72 && <button onClick={() => setGraphLimit(value => Math.min(72, value + 8))}><Plus size={10} />더 표시</button>}{graphLimit > 8 && <button onClick={() => setGraphLimit(8)}>접기</button>}</div>}
  </div>;
}

export function Graph(props: Parameters<typeof Canvas>[0]) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>;
}
