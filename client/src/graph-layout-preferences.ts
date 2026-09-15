import type { ProjectGroup, Session } from '../../shared/types';
import { graphProjectId, graphProjectKey, graphSessionGroups } from './graph-layout';
import { includePinnedProjectGroups } from './project-groups';

export const GRAPH_PREFERENCES_KEY = 'agent-monitor:graph-layout:v1';
export type GraphLayoutMode = 'auto' | 'manual';
export type GraphPosition = { x: number; y: number };
export type ManualProject = { position: GraphPosition; width: number; height: number };
export type ManualAgent = { projectId: string; position: GraphPosition };
export type ManualGraphLayout = {
  projects: Record<string, ManualProject>;
  agents: Record<string, ManualAgent>;
  host: GraphPosition;
};
export type GraphPreferences = { version: 1; mode: GraphLayoutMode; layout: ManualGraphLayout };

export const AGENT_WIDTH = 242;
export const AGENT_HEIGHT = 202;
const COLUMN_STEP = 268;
const ROW_STEP = 228;
const INSET = 20;
const FIRST_ROW = 106;
const PROJECT_GAP = 36;

function projectBounds(projectId: string, project: ManualProject, agents: Record<string, ManualAgent>, visibleIds?: ReadonlySet<string>): ManualProject {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const [id, agent] of Object.entries(agents)) {
    if (agent.projectId !== projectId || (visibleIds && !visibleIds.has(id))) continue;
    left = Math.min(left, agent.position.x);
    top = Math.min(top, agent.position.y);
    right = Math.max(right, agent.position.x + AGENT_WIDTH);
    bottom = Math.max(bottom, agent.position.y + AGENT_HEIGHT);
  }
  if (left === Infinity) return { position: visibleIds ? projectBounds(projectId, project, agents).position : project.position, width: AGENT_WIDTH + INSET * 2, height: FIRST_ROW + AGENT_HEIGHT + INSET };
  return {
    position: { x: project.position.x + left - INSET, y: project.position.y + top - FIRST_ROW },
    width: right - left + INSET * 2,
    height: bottom - top + FIRST_ROW + INSET,
  };
}

/** The displayed rectangle can move while saved logical origins remain stable. */
export function manualProjectBounds(layout: ManualGraphLayout, projectId: string, visibleIds?: ReadonlySet<string>): ManualProject | undefined {
  if (!Object.hasOwn(layout.projects, projectId)) return undefined;
  return projectBounds(projectId, layout.projects[projectId], layout.agents, visibleIds);
}

function normalizeProjectSizes(layout: ManualGraphLayout): ManualGraphLayout {
  let projects = layout.projects;
  for (const [id, project] of Object.entries(projects)) {
    const bounds = projectBounds(id, project, layout.agents);
    if (project.width !== bounds.width || project.height !== bounds.height) {
      projects = { ...projects, [id]: { ...project, width: bounds.width, height: bounds.height } };
    }
  }
  return projects === layout.projects ? layout : { ...layout, projects };
}

export function defaultGraphPreferences(): GraphPreferences {
  return { version: 1, mode: 'auto', layout: { projects: {}, agents: {}, host: { x: 128, y: 0 } } };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10_000_000;
}

function position(value: unknown): value is GraphPosition {
  return record(value) && finite(value.x) && finite(value.y);
}

export function parseGraphPreferences(value: string | null): GraphPreferences {
  const fallback = defaultGraphPreferences();
  if (!value) return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!record(parsed) || parsed.version !== 1 || !record(parsed.layout)) return fallback;
    const layout = parsed.layout;
    const projects: [string, ManualProject][] = [];
    for (const [id, item] of Object.entries(record(layout.projects) ? layout.projects : {})) {
      if (!id.startsWith('project:') || !record(item) || !position(item.position) || !finite(item.width) || !finite(item.height)) continue;
      projects.push([id, { position: { ...item.position }, width: item.width, height: item.height }]);
    }
    const projectMap = Object.fromEntries(projects);
    const agents: [string, ManualAgent][] = [];
    for (const [id, item] of Object.entries(record(layout.agents) ? layout.agents : {})) {
      if (!record(item) || typeof item.projectId !== 'string' || !Object.hasOwn(projectMap, item.projectId) || !position(item.position)) continue;
      agents.push([id, { projectId: item.projectId, position: { ...item.position } }]);
    }
    return { version: 1, mode: parsed.mode === 'manual' ? 'manual' : 'auto', layout: normalizeProjectSizes({ projects: projectMap, agents: Object.fromEntries(agents), host: position(layout.host) ? { ...layout.host } : fallback.layout.host }) };
  } catch { return fallback; }
}

export function setGraphLayoutMode(preferences: GraphPreferences, mode: GraphLayoutMode): GraphPreferences {
  return preferences.mode === mode ? preferences : { ...preferences, mode };
}

function overlaps(a: GraphPosition, b: GraphPosition, width = AGENT_WIDTH + 16, height = AGENT_HEIGHT + 16): boolean {
  return a.x < b.x + width && a.x + width > b.x && a.y < b.y + height && a.y + height > b.y;
}

function vacantAgentPosition(projectId: string, projects: Record<string, ManualProject>, agents: Record<string, ManualAgent>): GraphPosition {
  const project = projects[projectId];
  const bounds = projectBounds(projectId, project, agents);
  const origin = { x: bounds.position.x - project.position.x + INSET, y: bounds.position.y - project.position.y + FIRST_ROW };
  const columns = Math.max(1, Math.floor((project.width - 14) / COLUMN_STEP));
  const occupied = Object.values(agents).map(agent => ({
    x: projects[agent.projectId].position.x + agent.position.x,
    y: projects[agent.projectId].position.y + agent.position.y,
  }));
  // Search vacant cells without moving existing cards, including cards hidden by a filter.
  for (let index = 0; ; index++) {
    const candidate = { x: origin.x + index % columns * COLUMN_STEP, y: origin.y + Math.floor(index / columns) * ROW_STEP };
    const absolute = { x: project.position.x + candidate.x, y: project.position.y + candidate.y };
    if (!occupied.some(other => overlaps(absolute, other))) return candidate;
  }
}

/** Prune against authoritative membership; allocate only sessions currently shown. */
export function reconcileManualGraph(layout: ManualGraphLayout, allSessions: Session[], prune = true, seedSessions: Session[] = allSessions, pinnedGroups: ProjectGroup[] = []): ManualGraphLayout {
  let projects = layout.projects;
  let agents = layout.agents;
  const liveAgents = new Set(allSessions.map(session => session.id));
  const liveProjects = new Set([...allSessions.map(session => graphProjectId(graphProjectKey(session))), ...pinnedGroups.map(group => graphProjectId(group.cwd))]);
  if (prune && Object.keys(agents).some(id => !liveAgents.has(id))) agents = Object.fromEntries(Object.entries(agents).filter(([id]) => liveAgents.has(id)));
  if (prune && Object.keys(projects).some(id => !liveProjects.has(id))) projects = Object.fromEntries(Object.entries(projects).filter(([id]) => liveProjects.has(id)));

  // Stale cwd memberships need a new place, but never affect other sessions.
  for (const session of allSessions) {
    const prior = Object.hasOwn(agents, session.id) ? agents[session.id] : undefined;
    if (prior && prior.projectId !== graphProjectId(graphProjectKey(session))) {
      agents = Object.fromEntries(Object.entries(agents).filter(([id]) => id !== session.id));
    }
  }
  // When the last card disappears, carry its former frame origin into the
  // empty pin. No surviving relative positions need to be reanchored.
  if (prune) for (const group of pinnedGroups) {
    const id = graphProjectId(group.cwd);
    if (!Object.hasOwn(projects, id) || Object.values(agents).some(agent => agent.projectId === id)) continue;
    const previous = projectBounds(id, projects[id], layout.agents).position;
    if (previous.x !== projects[id].position.x || previous.y !== projects[id].position.y) {
      projects = { ...projects, [id]: { ...projects[id], position: previous } };
    }
  }
  const groups = includePinnedProjectGroups(graphSessionGroups(seedSessions.filter(session => liveAgents.has(session.id)), Infinity, null), pinnedGroups);
  for (const [path, members] of groups) {
    const projectId = graphProjectId(path);
    if (!Object.hasOwn(projects, projectId)) {
      const columns = groups.length === 1 && members.length > 6 ? 4 : members.length > 2 ? 2 : 1;
      const width = columns * COLUMN_STEP + 14;
      const rightmost = Math.max(-PROJECT_GAP, ...Object.entries(projects).map(([id, project]) => {
        const bounds = projectBounds(id, project, agents);
        return bounds.position.x + bounds.width;
      }));
      projects = { ...projects, [projectId]: { position: { x: rightmost + PROJECT_GAP, y: 145 }, width, height: Math.ceil(members.length / columns) * ROW_STEP + 121 } };
    }
    for (const session of members) {
      if (Object.hasOwn(agents, session.id)) continue;
      const agentPosition = vacantAgentPosition(projectId, projects, agents);
      agents = { ...agents, [session.id]: { projectId, position: agentPosition } };
    }
  }
  return normalizeProjectSizes(projects === layout.projects && agents === layout.agents ? layout : { ...layout, projects, agents });
}

/** React Flow moves use world coordinates, including the visible folder origin. */
export function moveManualGraphNodes(layout: ManualGraphLayout, changes: { id: string; position: GraphPosition }[], visibleIds?: ReadonlySet<string>): ManualGraphLayout {
  let projects = layout.projects;
  let agents = layout.agents;
  let host = layout.host;
  for (const change of changes) {
    if (!position(change.position)) continue;
    if (change.id === 'host') {
      if (host.x !== change.position.x || host.y !== change.position.y) host = { ...change.position };
    } else if (Object.hasOwn(projects, change.id)) {
      const project = projects[change.id];
      const bounds = projectBounds(change.id, project, agents, visibleIds);
      if (bounds.position.x !== change.position.x || bounds.position.y !== change.position.y) {
        projects = { ...projects, [change.id]: { ...project, position: { x: project.position.x + change.position.x - bounds.position.x, y: project.position.y + change.position.y - bounds.position.y } } };
      }
    }
  }
  // Apply all explicit card targets after folder translations. This makes a
  // batch independent of ordering while untouched members travel with folders.
  for (const change of changes) {
    if (position(change.position) && Object.hasOwn(agents, change.id)) {
      const agent = agents[change.id];
      const project = projects[agent.projectId];
      if (project.position.x + agent.position.x === change.position.x && project.position.y + agent.position.y === change.position.y) continue;
      agents = { ...agents, [change.id]: { ...agent, position: { x: change.position.x - project.position.x, y: change.position.y - project.position.y } } };
    }
  }
  return normalizeProjectSizes(projects === layout.projects && agents === layout.agents && host === layout.host ? layout : { ...layout, projects, agents, host });
}

export function manualSessionGroups(sessions: Session[]): [string, Session[]][] {
  const groups = new Map<string, Session[]>();
  for (const session of [...sessions].sort((a, b) => a.id.localeCompare(b.id))) {
    const path = graphProjectKey(session);
    const group = groups.get(path) || [];
    group.push(session);
    groups.set(path, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}
