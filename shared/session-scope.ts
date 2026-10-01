import { finishedAutomationSessionIds } from './automation-sessions.js';
import { sessionActivityAt, sessionStaysShown } from './session-activity.js';
import { familyIndex } from './session-family.js';
import type { AutoPromptJob, Run, Session, Snapshot } from './types.js';

/**
 * Which sessions a page holds. A page is sent only what its list can show; it asks for more when its
 * filter widens or a session is opened, and the full set stays with machine consumers (tower tools, links).
 */
export interface SessionScope {
  /** The list's time window in days; absent for all time. */
  days?: number;
  /** The archived list is open: every closed main session, whatever its age. */
  closed: boolean;
  /** The opened session: its whole family is sent. */
  focus?: string;
}

/** What a page shows about all of this computer's sessions, including those it was not sent. */
export interface SessionSummary {
  counts: { open: number; closed: number; working: number; completed: number };
  /** Every folder a main session ran in, with its project label; `open` when an open one did. */
  projects: Array<{ cwd: string; project: string; open: boolean }>;
  /** Some open main session would be on the canvas with no time filter. */
  canvasHistory: boolean;
}

const MAX_DAYS = 36_500;
const MAX_FOCUS = 1024;

/** Temporary worktrees stay in session history but do not occupy the canvas. `cwd` is the folder on its own computer. */
export function temporaryFolder(cwd: string): boolean {
  return /^\/(?:private\/)?tmp(?:\/|$)/.test(cwd);
}

function scopeFrom(days: unknown, closed: unknown, focus: unknown): SessionScope {
  const count = typeof days === 'number' ? days : typeof days === 'string' && days !== '' ? Number(days) : NaN;
  return {
    ...(Number.isFinite(count) && count > 0 && count <= MAX_DAYS ? { days: count } : {}),
    closed: closed === true || closed === '1',
    ...(typeof focus === 'string' && focus && focus.length <= MAX_FOCUS ? { focus } : {}),
  };
}

/** The scope a request names with `scoped=1`; undefined for requests that want every session. */
export function scopeFromParams(params: URLSearchParams): SessionScope | undefined {
  return params.get('scoped') === '1' ? scopeFrom(params.get('days'), params.get('closed'), params.get('focus')) : undefined;
}

export function scopeFromBody(value: unknown): SessionScope {
  const body = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return scopeFrom(body.days, body.closed, body.focus);
}

export function scopeParams(scope: SessionScope): string {
  const params = new URLSearchParams({ scoped: '1' });
  if (scope.days !== undefined) params.set('days', String(scope.days));
  if (scope.closed) params.set('closed', '1');
  if (scope.focus) params.set('focus', scope.focus);
  return params.toString();
}

export function sameScope(a: SessionScope, b: SessionScope): boolean {
  return a.days === b.days && a.closed === b.closed && a.focus === b.focus;
}

const ACTIVE_RUN = new Set<Run['status']>(['running', 'queued']);
const SETTLED_JOB = new Set<AutoPromptJob['status']>(['completed', 'error', 'cancelled']);

/** Every session id a run or job may name it by: its own, and `provider:nativeId`. */
function aliasIndex(sessions: Session[]): Map<string, Session> {
  const index = new Map<string, Session>();
  for (const session of sessions) {
    index.set(session.id, session);
    const native = `${session.provider}:${session.nativeId}`;
    if (!index.has(native)) index.set(native, session);
  }
  return index;
}

/**
 * Chooses the sessions a page with a given scope holds, in snapshot order. The work that does not depend on the
 * scope is done once, so one snapshot serves every page:
 * - open main sessions inside the time window (the list's own rule), and with `closed` every closed main session;
 * - sessions a running or queued turn or an unsettled Auto Prompt job names, with their ancestors;
 * - the whole family of the focused session.
 * A family root whose unsent members are busy carries `familyActive`.
 */
export function sessionSelector(snapshot: Pick<Snapshot, 'sessions' | 'runs' | 'autoPrompts'>, now: number): (scope: SessionScope) => Session[] {
  const { sessions } = snapshot;
  const { byId, roots } = familyIndex(sessions);
  const aliases = aliasIndex(sessions);
  const mains = sessions.filter(session => roots.get(session.id) === session.id && !session.launchedByAgent && !session.master);
  const busy = new Set<string>();
  for (const run of snapshot.runs) if (ACTIVE_RUN.has(run.status)) { const session = aliases.get(run.sessionId); if (session) busy.add(session.id); }
  const named = new Set(busy);
  for (const job of snapshot.autoPrompts ?? []) {
    if (SETTLED_JOB.has(job.status)) continue;
    for (const id of [job.sessionId, job.targetSessionId]) { const session = id ? aliases.get(id) : undefined; if (session) named.add(session.id); }
  }
  const always = new Set<string>();
  for (const id of named) {
    // Ancestors keep a named session's place in its family.
    const visited = new Set<string>();
    for (let current = byId.get(id); current && !visited.has(current.id); current = current.isSubagent && current.parentId ? byId.get(current.parentId) : undefined) {
      visited.add(current.id);
      always.add(current.id);
    }
  }
  const activeRoots = new Set<string>();
  for (const session of sessions) {
    const root = roots.get(session.id)!;
    if (root !== session.id && (session.status === 'working' || session.activeProcess || busy.has(session.id))) activeRoots.add(root);
  }
  return scope => {
    const kept = new Set(always);
    const cutoff = scope.days === undefined ? -Infinity : now - scope.days * 86_400_000;
    for (const session of mains) {
      const shown = session.closed ? scope.closed
        : session.status === 'working' || session.activeProcess || session.creationPending || sessionStaysShown(session) || Date.parse(sessionActivityAt(session)) >= cutoff;
      if (shown) kept.add(session.id);
    }
    const focused = scope.focus ? aliases.get(scope.focus) : undefined;
    const focusRoot = focused ? roots.get(focused.id) : undefined;
    const result: Session[] = [];
    for (const session of sessions) {
      const root = roots.get(session.id);
      if (!kept.has(session.id) && (focusRoot === undefined || root !== focusRoot)) continue;
      result.push(root === session.id && activeRoots.has(session.id) ? { ...session, familyActive: true } : session);
    }
    return result;
  };
}

/** Counts, folders and canvas history over every main session, as the page would compute them from all of them. */
export function sessionSummary(sessions: Session[], runs: Run[]): SessionSummary {
  const { roots } = familyIndex(sessions);
  const counts = { open: 0, closed: 0, working: 0, completed: 0 };
  const projects = new Map<string, { project: string; open: boolean }>();
  const canvas: Session[] = [];
  for (const session of sessions) {
    if (roots.get(session.id) !== session.id || session.launchedByAgent || session.master) continue;
    if (session.cwd) projects.set(session.cwd, { project: session.project, open: !session.closed || projects.get(session.cwd)?.open === true });
    if (session.closed) { counts.closed++; continue; }
    counts.open++;
    if (session.status === 'working') counts.working++;
    if (session.status === 'completed') counts.completed++;
    if (!temporaryFolder(session.cwd)) canvas.push(session);
  }
  // Only a session a trigger started can leave the canvas when finished; Slack's delegated work is not known here.
  const canvasHistory = canvas.some(session => session.launchedBy?.kind !== 'trigger')
    || (canvas.length > 0 && (finished => canvas.some(session => !finished.has(session.id)))(finishedAutomationSessionIds([], sessions, runs)));
  return { counts, projects: [...projects].map(([cwd, folder]) => ({ cwd, ...folder })), canvasHistory };
}
