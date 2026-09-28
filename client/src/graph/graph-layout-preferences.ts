import type { Session } from '../../../shared/types';
import { graphSessionGroups } from './graph-layout';

// Storage keys keep the project's first name so saved user state survives the rename (shared/app-identity.ts LEGACY_APP_NAME).
export const GRAPH_PREFERENCES_KEY = 'agent-monitor:graph-layout:v1';
export type GraphLayoutMode = 'auto' | 'manual';
export type GraphPosition = { x: number; y: number };
/** A folder frame placed by hand: its top-left corner and the size it last had on screen. */
export type ManualProject = { position: GraphPosition; width: number; height: number };
export type ManualGraphLayout = {
  projects: Record<string, ManualProject>;
  host: GraphPosition;
  /** Joined computers placed by hand, by computer id. */
  hosts?: Record<string, GraphPosition>;
};
export type GraphPreferences = {
  version: 1;
  mode: GraphLayoutMode;
  layout: ManualGraphLayout;
  /** How many cards sit side by side in a folder, by project id; a folder not listed uses one. */
  columns?: Record<string, number>;
};
/** A folder shown on the canvas and the size its grid of cards needs. */
export type ProjectFrame = { id: string; width: number; height: number };

export const AGENT_WIDTH = 242;
export const AGENT_HEIGHT = 202;
export const MAX_PROJECT_COLUMNS = 4;
const COLUMN_STEP = 268;
const ROW_STEP = 215;
const INSET = 20;
const FIRST_ROW = 106;
const BOTTOM = 28;
export const PROJECT_GAP = 36;

/** Cards fill a folder left to right, then continue on the next row. */
export function projectGrid(count: number, columns: number, minimumWidth = 0): { width: number; height: number; cards: GraphPosition[] } {
  const perRow = Math.max(1, Math.min(MAX_PROJECT_COLUMNS, Math.floor(columns) || 1));
  const rows = Math.max(1, Math.ceil(count / perRow));
  return {
    width: Math.max(perRow * COLUMN_STEP - (COLUMN_STEP - AGENT_WIDTH) + INSET * 2, minimumWidth),
    height: FIRST_ROW + rows * ROW_STEP - (ROW_STEP - AGENT_HEIGHT) + BOTTOM,
    cards: Array.from({ length: count }, (_, index) => ({ x: INSET + index % perRow * COLUMN_STEP, y: FIRST_ROW + Math.floor(index / perRow) * ROW_STEP })),
  };
}

export function projectColumns(columns: GraphPreferences['columns'], projectId: string): number {
  return columns?.[projectId] ?? 1;
}

export function setProjectColumns(preferences: GraphPreferences, projectId: string, columns: number): GraphPreferences {
  const value = Math.max(1, Math.min(MAX_PROJECT_COLUMNS, Math.floor(columns) || 1));
  if (projectColumns(preferences.columns, projectId) === value) return preferences;
  const next = { ...preferences.columns };
  if (value === 1) delete next[projectId];
  else next[projectId] = value;
  return { ...preferences, columns: next };
}

export function defaultGraphPreferences(): GraphPreferences {
  return { version: 1, mode: 'auto', layout: { projects: {}, host: { x: 128, y: 0 } } };
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
    const saved = record(layout.projects) ? layout.projects : {};
    // Saves from before folders laid out their cards kept an origin and card
    // offsets. The folder corner is where its top-left card sat, less the
    // header; saves that already anchored frames drew the corner at the origin.
    const corners = new Map<string, GraphPosition>();
    if (layout.anchoredFrames !== true) for (const agent of Object.values(record(layout.agents) ? layout.agents : {})) {
      if (!record(agent) || typeof agent.projectId !== 'string' || !position(agent.position)) continue;
      const corner = corners.get(agent.projectId);
      corners.set(agent.projectId, corner ? { x: Math.min(corner.x, agent.position.x), y: Math.min(corner.y, agent.position.y) } : agent.position);
    }
    const projects: Record<string, ManualProject> = {};
    for (const [id, item] of Object.entries(saved)) {
      if (!id.startsWith('project:') || !record(item) || !position(item.position) || !finite(item.width) || !finite(item.height)) continue;
      const corner = corners.get(id);
      projects[id] = { position: corner ? { x: item.position.x + corner.x - INSET, y: item.position.y + corner.y - FIRST_ROW } : { x: item.position.x, y: item.position.y }, width: item.width, height: item.height };
    }
    const hosts = Object.entries(record(layout.hosts) ? layout.hosts : {}).flatMap(([id, item]) => /^[a-f0-9]{32}$/.test(id) && position(item) ? [[id, { x: item.x, y: item.y }] as const] : []);
    const columns = Object.entries(record(parsed.columns) ? parsed.columns : {}).flatMap(([id, count]) =>
      id.startsWith('project:') && Number.isInteger(count) && (count as number) > 1 && (count as number) <= MAX_PROJECT_COLUMNS ? [[id, count as number] as const] : []);
    return { version: 1, mode: parsed.mode === 'manual' ? 'manual' : 'auto',
      layout: { projects, host: position(layout.host) ? { x: layout.host.x, y: layout.host.y } : fallback.layout.host, ...(hosts.length ? { hosts: Object.fromEntries(hosts) } : {}) },
      ...(columns.length ? { columns: Object.fromEntries(columns) } : {}) };
  } catch { return fallback; }
}

export function setGraphLayoutMode(preferences: GraphPreferences, mode: GraphLayoutMode): GraphPreferences {
  return preferences.mode === mode ? preferences : { ...preferences, mode };
}

function near(a: ManualProject, b: ManualProject, gap = PROJECT_GAP): boolean {
  return a.position.x < b.position.x + b.width + gap && a.position.x + a.width + gap > b.position.x
    && a.position.y < b.position.y + b.height + gap && a.position.y + a.height + gap > b.position.y;
}

/**
 * A folder that grew (more sessions, more per row, a longer title) moves the
 * folders it now covers out of its way: those that were below it further
 * down, the others to its right, and so on for whatever those then cover.
 * Frames that already overlapped stay as they were placed.
 */
function clearGrowth(projects: Record<string, ManualProject>, before: Map<string, ManualProject>): Record<string, ManualProject> {
  const queue = [...before.keys()];
  for (let steps = 0; queue.length && steps < 500; steps++) {
    const id = queue.shift()!;
    const frame = projects[id];
    const prior = before.get(id)!;
    for (const [other, placed] of Object.entries(projects)) {
      if (other === id || !near(frame, placed, 0) || near(prior, placed, 0)) continue;
      const below = placed.position.y >= prior.position.y + prior.height;
      projects = { ...projects, [other]: { ...placed, position: below
        ? { x: placed.position.x, y: frame.position.y + frame.height + PROJECT_GAP }
        : { x: frame.position.x + frame.width + PROJECT_GAP, y: placed.position.y } } };
      if (!before.has(other)) before.set(other, placed);
      queue.push(other);
    }
  }
  return projects;
}

/**
 * Keep hand-placed folder corners and give each newly shown folder a place
 * right of the visible ones, below any saved frame it would cover. `live` is
 * the authoritative set of folders; without it nothing is forgotten.
 */
export function reconcileManualGraph(layout: ManualGraphLayout, frames: ProjectFrame[], live?: ReadonlySet<string>, retain: (id: string) => boolean = () => false): ManualGraphLayout {
  let projects = layout.projects;
  const shown = new Set(frames.map(frame => frame.id));
  if (live && Object.keys(projects).some(id => !live.has(id) && !shown.has(id) && !retain(id))) {
    projects = Object.fromEntries(Object.entries(projects).filter(([id]) => live.has(id) || shown.has(id) || retain(id)));
  }
  const grown = new Map<string, ManualProject>();
  for (const frame of frames) {
    const saved = Object.hasOwn(projects, frame.id) ? projects[frame.id] : undefined;
    if (!saved || (saved.width === frame.width && saved.height === frame.height)) continue;
    if (frame.width > saved.width || frame.height > saved.height) grown.set(frame.id, saved);
    projects = { ...projects, [frame.id]: { ...saved, width: frame.width, height: frame.height } };
  }
  if (grown.size) projects = clearGrowth(projects, grown);
  for (const frame of frames) {
    if (Object.hasOwn(projects, frame.id)) continue;
    const visible = frames.flatMap(other => other.id !== frame.id && Object.hasOwn(projects, other.id) ? [projects[other.id]] : []);
    const placed: ManualProject = { width: frame.width, height: frame.height, position: visible.length ? {
      x: Math.max(...visible.map(other => other.position.x + other.width)) + PROJECT_GAP,
      y: Math.min(...visible.map(other => other.position.y)),
    } : { x: 0, y: 145 } };
    for (;;) {
      const blockers = Object.values(projects).filter(other => near(placed, other));
      if (!blockers.length) break;
      placed.position = { ...placed.position, y: Math.max(...blockers.map(other => other.position.y + other.height)) + PROJECT_GAP };
    }
    projects = { ...projects, [frame.id]: placed };
  }
  return projects === layout.projects ? layout : { ...layout, projects };
}

/** React Flow moves use world coordinates of a folder's top-left corner or a host node. */
export function moveManualGraphNodes(layout: ManualGraphLayout, changes: { id: string; position: GraphPosition }[]): ManualGraphLayout {
  let projects = layout.projects;
  let host = layout.host;
  let hosts = layout.hosts;
  for (const change of changes) {
    if (!position(change.position)) continue;
    const target = { x: change.position.x, y: change.position.y };
    const remote = /^host:([a-f0-9]{32})$/.exec(change.id)?.[1];
    if (change.id === 'host') {
      if (host.x !== target.x || host.y !== target.y) host = target;
    } else if (remote) {
      const saved = hosts?.[remote];
      if (!saved || saved.x !== target.x || saved.y !== target.y) hosts = { ...hosts, [remote]: target };
    } else if (Object.hasOwn(projects, change.id)) {
      const project = projects[change.id];
      if (project.position.x !== target.x || project.position.y !== target.y) projects = { ...projects, [change.id]: { ...project, position: target } };
    }
  }
  return projects === layout.projects && host === layout.host && hosts === layout.hosts ? layout : { ...layout, projects, host, ...(hosts ? { hosts } : {}) };
}

/** Every shown session by folder, most recent first, as the automatic layout orders them. */
export function manualSessionGroups(sessions: Session[]): [string, Session[]][] {
  return graphSessionGroups(sessions, Infinity, null);
}
