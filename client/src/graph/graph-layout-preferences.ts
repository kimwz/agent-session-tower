import type { ProjectGroup, Session } from '../../../shared/types';
import { graphProjectId, graphProjectKey, graphSessionGroups } from './graph-layout';
import { includePinnedProjectGroups } from '../project-groups/project-groups';
import { sessionActivityAt } from '../../../shared/session-activity';

// Storage keys keep the project's first name so saved user state survives the rename (shared/app-identity.ts LEGACY_APP_NAME).
export const GRAPH_PREFERENCES_KEY = 'agent-monitor:graph-layout:v1';
export type GraphLayoutMode = 'auto' | 'manual';
export type GraphPosition = { x: number; y: number };
export type ManualProject = {
  position: GraphPosition;
  width: number;
  height: number;
  appliedHeaderWidth?: number;
  pendingHeaderRepairs?: Record<string, { width: number; shiftX: number }>;
};
export type ManualAgent = { projectId: string; position: GraphPosition };
export type ManualGraphLayout = {
  projects: Record<string, ManualProject>;
  agents: Record<string, ManualAgent>;
  host: GraphPosition;
  /** Joined computers placed by hand, by computer id. */
  hosts?: Record<string, GraphPosition>;
  /** Logical origins sit on the last visible frame; older saves are migrated once on load. */
  anchoredFrames?: true;
};
export type GraphPreferences = { version: 1; mode: GraphLayoutMode; layout: ManualGraphLayout };
export type ManualGraphOptions = {
  visibleProjectIds?: ReadonlySet<string>;
  minimumProjectWidths?: ReadonlyMap<string, number>;
  repairHeaderWidths?: boolean;
  /** Cards and folders of a computer this page has no state for yet keep their places. */
  retain?: (id: string) => boolean;
};

export const AGENT_WIDTH = 242;
export const AGENT_HEIGHT = 202;
const COLUMN_STEP = 268;
const ROW_STEP = 228;
const INSET = 20;
const FIRST_ROW = 106;
const PROJECT_GAP = 36;

function projectBounds(projectId: string, project: ManualProject, agents: Record<string, ManualAgent>, visibleIds?: ReadonlySet<string>, minimumWidth = 0): ManualProject {
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
  if (left === Infinity) return { position: project.position, width: Math.max(AGENT_WIDTH + INSET * 2, minimumWidth), height: FIRST_ROW + AGENT_HEIGHT + INSET };
  return {
    position: { x: project.position.x + left - INSET, y: project.position.y + top - FIRST_ROW },
    width: Math.max(right - left + INSET * 2, minimumWidth),
    height: bottom - top + FIRST_ROW + INSET,
  };
}

/** The displayed rectangle can move while saved logical origins remain stable. */
export function manualProjectBounds(layout: ManualGraphLayout, projectId: string, visibleIds?: ReadonlySet<string>, minimumProjectWidths?: ReadonlyMap<string, number>): ManualProject | undefined {
  if (!Object.hasOwn(layout.projects, projectId)) return undefined;
  return projectBounds(projectId, layout.projects[projectId], layout.agents, visibleIds, minimumProjectWidths?.get(projectId));
}

/**
 * Move each logical origin onto its visible frame without moving any card, so
 * a folder whose cards all leave the view stays where it was last seen.
 */
function anchorVisibleFrames(layout: ManualGraphLayout, visibleIds?: ReadonlySet<string>): ManualGraphLayout {
  const corners = new Map<string, GraphPosition>();
  for (const [id, agent] of Object.entries(layout.agents)) {
    if (visibleIds && !visibleIds.has(id)) continue;
    const corner = corners.get(agent.projectId);
    corners.set(agent.projectId, corner ? { x: Math.min(corner.x, agent.position.x), y: Math.min(corner.y, agent.position.y) } : agent.position);
  }
  const shifts = new Map<string, GraphPosition>();
  let projects = layout.projects;
  for (const [id, corner] of corners) {
    const shift = { x: corner.x - INSET, y: corner.y - FIRST_ROW };
    // Sub-pixel remainders from float drags are invisible; ignoring them keeps reconciliation idempotent.
    if (Math.abs(shift.x) < 0.01 && Math.abs(shift.y) < 0.01) continue;
    shifts.set(id, shift);
    const project = projects[id];
    projects = { ...projects, [id]: { ...project, position: { x: project.position.x + shift.x, y: project.position.y + shift.y } } };
  }
  if (!shifts.size) return layout;
  const agents = Object.fromEntries(Object.entries(layout.agents).map(([id, agent]) => {
    const shift = shifts.get(agent.projectId);
    return [id, shift ? { ...agent, position: { x: agent.position.x - shift.x, y: agent.position.y - shift.y } } : agent];
  }));
  return { ...layout, projects, agents };
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
  return { version: 1, mode: 'auto', layout: { projects: {}, agents: {}, host: { x: 128, y: 0 }, anchoredFrames: true } };
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
      projects.push([id, { position: { ...item.position }, width: item.width, height: item.height,
        ...(finite(item.appliedHeaderWidth) && item.appliedHeaderWidth > 0 ? { appliedHeaderWidth: item.appliedHeaderWidth } : {}),
      }]);
    }
    const projectMap = Object.fromEntries(projects);
    for (const [id, item] of Object.entries(record(layout.projects) ? layout.projects : {})) {
      if (!Object.hasOwn(projectMap, id) || !record(item) || !record(item.pendingHeaderRepairs)) continue;
      const pending = Object.fromEntries(Object.entries(item.pendingHeaderRepairs).flatMap(([source, repair]) =>
        source !== id && Object.hasOwn(projectMap, source) && record(repair) && finite(repair.width) && repair.width >= 0 && finite(repair.shiftX) && repair.shiftX >= 0
          ? [[source, { width: repair.width, shiftX: repair.shiftX }]] : []));
      if (Object.keys(pending).length) projectMap[id].pendingHeaderRepairs = pending;
    }
    const agents: [string, ManualAgent][] = [];
    for (const [id, item] of Object.entries(record(layout.agents) ? layout.agents : {})) {
      if (!record(item) || typeof item.projectId !== 'string' || !Object.hasOwn(projectMap, item.projectId) || !position(item.position)) continue;
      agents.push([id, { projectId: item.projectId, position: { ...item.position } }]);
    }
    const hosts = Object.entries(record(layout.hosts) ? layout.hosts : {}).flatMap(([id, item]) => /^[a-f0-9]{32}$/.test(id) && position(item) ? [[id, { x: item.x, y: item.y }] as const] : []);
    let restored: ManualGraphLayout = { projects: projectMap, agents: Object.fromEntries(agents), host: position(layout.host) ? { ...layout.host } : fallback.layout.host,
      ...(hosts.length ? { hosts: Object.fromEntries(hosts) } : {}), anchoredFrames: true };
    // Older saves drew a folder without visible cards around all of its stored
    // cards. Anchor those origins there once so the upgrade moves nothing.
    if (layout.anchoredFrames !== true) restored = anchorVisibleFrames(restored);
    return { version: 1, mode: parsed.mode === 'manual' ? 'manual' : 'auto', layout: normalizeProjectSizes(restored) };
  } catch { return fallback; }
}

export function setGraphLayoutMode(preferences: GraphPreferences, mode: GraphLayoutMode): GraphPreferences {
  return preferences.mode === mode ? preferences : { ...preferences, mode };
}

function overlaps(a: GraphPosition, b: GraphPosition, width = AGENT_WIDTH + 16, height = AGENT_HEIGHT + 16): boolean {
  return a.x < b.x + width && a.x + width > b.x && a.y < b.y + height && a.y + height > b.y;
}

function framesOverlap(a: ManualProject, b: ManualProject): boolean {
  return a.position.x < b.position.x + b.width && a.position.x + a.width > b.position.x
    && a.position.y < b.position.y + b.height && a.position.y + a.height > b.position.y;
}

/** Apply title expansion once; manual drags and ordinary card growth never trigger a reflow. */
function reconcileHeaderWidths(projects: Record<string, ManualProject>, agents: Record<string, ManualAgent>, visibleIds: ReadonlySet<string>, visibleProjectIds: ReadonlySet<string>, minimumWidths: ReadonlyMap<string, number>): Record<string, ManualProject> {
  const visible = Object.keys(projects).filter(id => visibleProjectIds.has(id));
  const before = new Map(visible.map(id => [id, projectBounds(id, projects[id], agents, visibleIds, projects[id].appliedHeaderWidth)]));
  const widths = new Map(visible.flatMap(id => {
    const width = minimumWidths.get(id);
    return finite(width) && width > 0 ? [[id, width] as const] : [];
  }));
  const frames = new Map(visible.map(id => [id, projectBounds(id, projects[id], agents, visibleIds, widths.get(id) ?? projects[id].appliedHeaderWidth)]));
  const expanded = new Set(visible.filter(id => frames.get(id)!.width > before.get(id)!.width));
  const queue = new Set(visible.filter(id => expanded.has(id) || visible.some(target => projects[target].pendingHeaderRepairs?.[id])));
  const ancestors = new Map(visible.map(id => [id, new Set([id])]));
  while (queue.size) {
    const source = [...queue].sort((a, b) => frames.get(a)!.position.x - frames.get(b)!.position.x || a.localeCompare(b))[0];
    queue.delete(source);
    const frame = frames.get(source)!;
    const shifted = frame.position.x !== before.get(source)!.position.x;
    for (const target of visible) {
      if (ancestors.get(source)!.has(target)) continue;
      const pending = projects[target].pendingHeaderRepairs?.[source];
      const previous = pending === undefined ? before.get(source)!
        : projectBounds(source, projects[source], agents, visibleIds, pending.width);
      if (pending) previous.position = { ...previous.position, x: previous.position.x - pending.shiftX };
      if (!shifted && !expanded.has(source) && frame.width <= previous.width && frame.position.x === previous.position.x) continue;
      if (previous.position.x + previous.width > before.get(target)!.position.x || !framesOverlap(frame, frames.get(target)!)) continue;
      const neighbor = frames.get(target)!;
      frames.set(target, { ...neighbor, position: { ...neighbor.position, x: frame.position.x + frame.width + PROJECT_GAP } });
      ancestors.set(target, new Set([...ancestors.get(target)!, ...ancestors.get(source)!]));
      queue.add(target);
    }
  }
  let next = projects;
  for (const [id, project] of Object.entries(projects)) {
    let updated = project;
    const width = widths.get(id);
    if (width !== undefined && width >= projectBounds(id, project, agents, visibleIds).width && width !== project.appliedHeaderWidth) {
      updated = { ...updated, appliedHeaderWidth: width };
    }
    const pending = Object.fromEntries(Object.entries(project.pendingHeaderRepairs || {})
      .filter(([source]) => source !== id && Object.hasOwn(projects, source) && !(visibleProjectIds.has(id) && visibleProjectIds.has(source))));
    if (!visibleProjectIds.has(id)) for (const source of visible) {
      const shiftX = frames.get(source)!.position.x - before.get(source)!.position.x;
      if (!expanded.has(source) && !shiftX) continue;
      pending[source] = { width: pending[source]?.width ?? projects[source].appliedHeaderWidth ?? 0, shiftX: (pending[source]?.shiftX || 0) + shiftX };
    }
    if (Object.keys(pending).length !== Object.keys(project.pendingHeaderRepairs || {}).length
      || Object.entries(pending).some(([source, value]) => project.pendingHeaderRepairs?.[source]?.width !== value.width || project.pendingHeaderRepairs?.[source]?.shiftX !== value.shiftX)) {
      updated = { ...updated };
      if (Object.keys(pending).length) updated.pendingHeaderRepairs = pending;
      else delete updated.pendingHeaderRepairs;
    }
    const frame = frames.get(id);
    if (frame && frame.position.x !== before.get(id)!.position.x) {
      updated = { ...updated, position: { ...project.position, x: project.position.x + frame.position.x - before.get(id)!.position.x } };
    }
    if (updated !== project) next = { ...next, [id]: updated };
  }
  return next;
}

function absoluteAgent(projects: Record<string, ManualProject>, agent: ManualAgent): GraphPosition {
  return { x: projects[agent.projectId].position.x + agent.position.x, y: projects[agent.projectId].position.y + agent.position.y };
}

function vacantAgentPosition(projectId: string, projects: Record<string, ManualProject>, agents: Record<string, ManualAgent>, preferred: GraphPosition, yields: (id: string) => boolean): GraphPosition {
  const project = projects[projectId];
  const occupied = Object.entries(agents).filter(([id]) => !yields(id)).map(([, agent]) => absoluteAgent(projects, agent));
  // Expand around the visible insertion point instead of walking through old rows.
  for (let distance = 0; ; distance++) {
    for (let row = distance; row >= 0; row--) {
      const column = distance - row;
      for (const offset of column ? [column, -column] : [0]) {
        const candidate = { x: preferred.x + offset * COLUMN_STEP, y: preferred.y + row * ROW_STEP };
        const absolute = { x: project.position.x + candidate.x, y: project.position.y + candidate.y };
        if (!occupied.some(other => overlaps(absolute, other))) return candidate;
      }
    }
  }
}

/** Prune against authoritative membership; allocate only sessions currently shown. */
export function reconcileManualGraph(layout: ManualGraphLayout, allSessions: Session[], prune = true, seedSessions: Session[] = allSessions, pinnedGroups: ProjectGroup[] = [], options: ManualGraphOptions = {}): ManualGraphLayout {
  let projects = layout.projects;
  let agents = layout.agents;
  const liveAgents = new Set(allSessions.map(session => session.id));
  const activity = new Map(allSessions.map(session => [session.id, sessionActivityAt(session)]));
  const liveProjects = new Set([...allSessions.map(session => graphProjectId(graphProjectKey(session))), ...pinnedGroups.map(group => graphProjectId(group.cwd))]);
  const retain = options.retain ?? (() => false);
  if (prune && Object.keys(agents).some(id => !liveAgents.has(id) && !retain(id))) agents = Object.fromEntries(Object.entries(agents).filter(([id]) => liveAgents.has(id) || retain(id)));
  if (prune && Object.keys(projects).some(id => !liveProjects.has(id) && !retain(id))) {
    projects = Object.fromEntries(Object.entries(projects).filter(([id]) => liveProjects.has(id) || retain(id)));
    for (const [id, project] of Object.entries(projects)) {
      if (!project.pendingHeaderRepairs || Object.keys(project.pendingHeaderRepairs).every(source => Object.hasOwn(projects, source))) continue;
      const pending = Object.fromEntries(Object.entries(project.pendingHeaderRepairs).filter(([source]) => Object.hasOwn(projects, source)));
      const updated = { ...project };
      if (Object.keys(pending).length) updated.pendingHeaderRepairs = pending;
      else delete updated.pendingHeaderRepairs;
      projects = { ...projects, [id]: updated };
    }
  }

  // Stale cwd memberships need a new place, but never affect other sessions.
  for (const session of allSessions) {
    const prior = Object.hasOwn(agents, session.id) ? agents[session.id] : undefined;
    if (prior && prior.projectId !== graphProjectId(graphProjectKey(session))) {
      agents = Object.fromEntries(Object.entries(agents).filter(([id]) => id !== session.id));
    }
  }
  const groups = includePinnedProjectGroups(graphSessionGroups(seedSessions.filter(session => liveAgents.has(session.id)), Infinity, null), pinnedGroups);
  const visibleIds = new Set(seedSessions.map(session => session.id));
  const visibleProjectIds = options.visibleProjectIds ?? new Set(groups.map(([path]) => graphProjectId(path)));
  if (options.repairHeaderWidths !== false && options.minimumProjectWidths) {
    projects = reconcileHeaderWidths(projects, agents, visibleIds, visibleProjectIds, options.minimumProjectWidths);
  }
  for (const [path, members] of groups) {
    const projectId = graphProjectId(path);
    const isNewProject = !Object.hasOwn(projects, projectId);
    if (isNewProject && !visibleProjectIds.has(projectId)) continue;
    const initialColumns = groups.length === 1 && members.length > 6 ? 4 : members.length > 2 ? 2 : 1;
    if (isNewProject) {
      const width = initialColumns * COLUMN_STEP + 14;
      const height = FIRST_ROW + (Math.max(1, Math.ceil(members.length / initialColumns)) - 1) * ROW_STEP + AGENT_HEIGHT + INSET;
      const visibleBounds = Object.entries(projects).filter(([id]) => visibleProjectIds.has(id))
        .map(([id, project]) => projectBounds(id, project, agents, visibleIds, options.minimumProjectWidths?.get(id)));
      let position = visibleBounds.length ? {
        x: Math.max(...visibleBounds.map(bounds => bounds.position.x + bounds.width)) + PROJECT_GAP,
        y: Math.min(...visibleBounds.map(bounds => bounds.position.y)),
      } : { x: 0, y: 145 };
      const occupiedProjects = new Set(Object.values(agents).map(agent => agent.projectId));
      const emptyBounds = Object.entries(projects).filter(([id]) => !occupiedProjects.has(id))
        .map(([id, project]) => projectBounds(id, project, agents, undefined, options.minimumProjectWidths?.get(id)));
      // Empty saved frames have no cards to block placement. Move just below
      // overlapping frames so revealing a hidden folder keeps its header usable.
      for (;;) {
        const blockers = emptyBounds.filter(bounds => position.x < bounds.position.x + bounds.width + PROJECT_GAP
          && position.x + Math.max(width, options.minimumProjectWidths?.get(projectId) || 0) + PROJECT_GAP > bounds.position.x
          && position.y < bounds.position.y + bounds.height + PROJECT_GAP && position.y + height + PROJECT_GAP > bounds.position.y);
        if (!blockers.length) break;
        position = { ...position, y: Math.max(...blockers.map(bounds => bounds.position.y + bounds.height)) + PROJECT_GAP };
      }
      projects = { ...projects, [projectId]: { position, width, height } };
    }
    const project = projects[projectId];
    const bounds = projectBounds(projectId, project, agents, visibleIds);
    const visibleCards = Object.entries(agents).filter(([id, agent]) => agent.projectId === projectId && visibleIds.has(id)).map(([, agent]) => agent.position);
    const bottom = Math.max(...visibleCards.map(card => card.y));
    const bottomRow = visibleCards.filter(card => card.y + AGENT_HEIGHT > bottom);
    const rowLeft = Math.min(...bottomRow.map(card => card.x));
    const rowWidth = Math.max(...bottomRow.map(card => card.x + AGENT_WIDTH)) - rowLeft + INSET * 2;
    const origin = {
      x: visibleCards.length ? rowLeft : bounds.position.x - project.position.x + INSET,
      y: visibleCards.length ? bottom + ROW_STEP : bounds.position.y - project.position.y + FIRST_ROW,
    };
    const columns = isNewProject ? initialColumns : Math.max(1, Math.floor(((visibleCards.length ? rowWidth : bounds.width) - 14) / COLUMN_STEP));
    let added = 0;
    for (const session of members) {
      if (Object.hasOwn(agents, session.id)) continue;
      // Cards that left the view for being older than the new session, such as
      // those past the recent-activity cutoff, give up their slot instead of
      // pushing it away from the folder. They are placed again below their
      // folder when they return. Newer hidden cards keep blocking.
      const since = Date.parse(sessionActivityAt(session));
      const yields = (id: string) => !visibleIds.has(id) && Date.parse(activity.get(id) || '') < since;
      const preferred = { x: origin.x + added % columns * COLUMN_STEP, y: origin.y + Math.floor(added / columns) * ROW_STEP };
      const agentPosition = vacantAgentPosition(projectId, projects, agents, preferred, yields);
      const placed = { x: project.position.x + agentPosition.x, y: project.position.y + agentPosition.y };
      if (Object.entries(agents).some(([id, agent]) => yields(id) && overlaps(placed, absoluteAgent(projects, agent)))) {
        agents = Object.fromEntries(Object.entries(agents).filter(([id, agent]) => !yields(id) || !overlaps(placed, absoluteAgent(projects, agent))));
      }
      agents = { ...agents, [session.id]: { projectId, position: agentPosition } };
      added++;
    }
    const appliedHeaderWidth = options.minimumProjectWidths?.get(projectId);
    if (isNewProject && finite(appliedHeaderWidth) && appliedHeaderWidth > 0 && appliedHeaderWidth >= projectBounds(projectId, projects[projectId], agents, visibleIds).width) {
      projects = { ...projects, [projectId]: { ...projects[projectId], appliedHeaderWidth } };
    }
  }
  return normalizeProjectSizes(anchorVisibleFrames(projects === layout.projects && agents === layout.agents ? layout : { ...layout, projects, agents }, visibleIds));
}

/** React Flow moves use world coordinates, including the visible folder origin. */
export function moveManualGraphNodes(layout: ManualGraphLayout, changes: { id: string; position: GraphPosition }[], visibleIds?: ReadonlySet<string>, minimumProjectWidths?: ReadonlyMap<string, number>): ManualGraphLayout {
  let projects = layout.projects;
  let agents = layout.agents;
  let host = layout.host;
  let hosts = layout.hosts;
  const movedProjects = new Set<string>();
  for (const change of changes) {
    if (!position(change.position)) continue;
    const remote = /^host:([a-f0-9]{32})$/.exec(change.id)?.[1];
    if (change.id === 'host') {
      if (host.x !== change.position.x || host.y !== change.position.y) host = { ...change.position };
    } else if (remote) {
      const saved = hosts?.[remote];
      if (!saved || saved.x !== change.position.x || saved.y !== change.position.y) hosts = { ...hosts, [remote]: { x: change.position.x, y: change.position.y } };
    } else if (Object.hasOwn(projects, change.id)) {
      const project = projects[change.id];
      const bounds = projectBounds(change.id, project, agents, visibleIds);
      if (bounds.position.x !== change.position.x || bounds.position.y !== change.position.y) {
        projects = { ...projects, [change.id]: { ...project, position: { x: project.position.x + change.position.x - bounds.position.x, y: project.position.y + change.position.y - bounds.position.y } } };
        movedProjects.add(change.id);
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
      movedProjects.add(agent.projectId);
    }
  }
  for (const id of movedProjects) {
    const width = minimumProjectWidths?.get(id);
    if (finite(width) && width > 0 && width >= projectBounds(id, projects[id], agents, visibleIds).width && width !== projects[id].appliedHeaderWidth) {
      projects = { ...projects, [id]: { ...projects[id], appliedHeaderWidth: width } };
    }
  }
  return normalizeProjectSizes(anchorVisibleFrames(projects === layout.projects && agents === layout.agents && host === layout.host && hosts === layout.hosts ? layout
    : { ...layout, projects, agents, host, ...(hosts ? { hosts } : {}) }, visibleIds));
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
