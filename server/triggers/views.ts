import type { Trigger, TriggerAuditEntry, TriggerEvent, TriggerOverview, TriggerSummary } from '../../shared/triggers.js';
import { failure } from './errors.js';
import { MAX_AUDIT, MAX_ONCE_RESERVATIONS } from './limits.js';
import { onceCount } from './once.js';
import { UNFINISHED, type EngineState } from './state.js';

/** A read-only view of the Slack connection or a public agent, so it appears among triggers without moving its data. */
export interface SlackProjection { id: string; name: string; enabled: boolean; updatedAt: string; error?: string }

/** What the triggers' readers see. Every answer is a copy; nothing here changes the state. */

/** Definitions, without archived ones unless asked for. */
export function listTriggers(state: EngineState, query: { includeArchived?: boolean } = {}): Trigger[] { return structuredClone(state.triggers.filter(item => query.includeArchived || !item.archivedAt)); }

/** One definition with its kept revisions and its last 50 runs, newest first. */
export function getTrigger(state: EngineState, id: string) {
  const trigger = state.triggers.find(item => item.id === id);
  if (!trigger) throw failure('Trigger not found.', 'not-found');
  return structuredClone({ trigger, revisions: state.revisions[id] ?? [], events: state.events.filter(event => event.triggerId === id).slice(-50).reverse() });
}

/**
 * Runs newest first. `beforeId` pages by position in history, so runs recorded at the same moment are never
 * skipped; `before` is a time and applies when that run is no longer kept.
 */
export function eventsPage(state: EngineState, query: { triggerId?: string; before?: string; beforeId?: string; limit?: number } = {}): TriggerEvent[] {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const position = query.beforeId ? state.events.findIndex(event => event.id === query.beforeId) : -1;
  // A cursor run no longer kept falls back to its time, including runs recorded at that same moment.
  const older = position >= 0 ? state.events.slice(0, position)
    : state.events.filter(event => !query.before || (query.beforeId ? event.receivedAt <= query.before : event.receivedAt < query.before));
  return structuredClone(older.filter(event => !query.triggerId || event.triggerId === query.triggerId).slice(-limit).reverse());
}

/** One run, whether or not its trigger still exists. */
export function oneEvent(state: EngineState, id: string): TriggerEvent {
  const event = state.events.find(item => item.id === id);
  if (!event) throw failure('This run is no longer in trigger history.', 'not-found');
  return structuredClone(event);
}

export function auditPage(state: EngineState, query: { before?: string; limit?: number } = {}): TriggerAuditEntry[] {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), MAX_AUDIT);
  return structuredClone(state.audit.filter(entry => !query.before || entry.at < query.before).slice(-limit).reverse());
}

export function deletedTriggers(state: EngineState): Trigger[] { return structuredClone([...state.tombstones].reverse()); }

/** Every copy kept, read at once: current triggers, deleted ones (newest first), and earlier revisions of both. */
export function keptCopies(state: EngineState): { triggers: Trigger[]; deleted: Trigger[]; revisions: Record<string, Trigger[]> } {
  return structuredClone({ triggers: state.triggers, deleted: [...state.tombstones].reverse(), revisions: state.revisions });
}

/** The live snapshot: Slack and public agents, every definition's summary, and recent and still-running runs. */
export function overviewOf(state: EngineState, sources: { slack?: SlackProjection; publicAgents: SlackProjection[]; problem: string | undefined }): TriggerOverview {
  const slack = sources.slack;
  const summaries: TriggerSummary[] = [];
  if (slack) summaries.push({ id: slack.id, name: slack.name, enabled: slack.enabled, kind: 'slack', revision: 0, updatedAt: slack.updatedAt, updatedBy: { kind: 'owner', via: 'ui' }, ...(slack.error ? { error: slack.error } : {}) });
  for (const agent of sources.publicAgents) summaries.push({ id: agent.id, name: agent.name, enabled: agent.enabled, kind: 'public', revision: 0, updatedAt: agent.updatedAt, updatedBy: { kind: 'owner', via: 'ui' } });
  for (const trigger of state.triggers) {
    const cursor = state.cursors[trigger.id];
    const last = [...state.events].reverse().find(event => event.triggerId === trigger.id);
    summaries.push({ id: trigger.id, name: trigger.name, enabled: trigger.enabled, kind: trigger.source.kind, revision: trigger.revision, updatedAt: trigger.updatedAt, updatedBy: trigger.updatedBy,
      ...(trigger.archivedAt ? { archivedAt: trigger.archivedAt } : {}), ...(trigger.consumed ? { consumed: trigger.consumed } : {}),
      ...(trigger.enabled && cursor?.nextAt && !cursor.paused ? { nextRunAt: new Date(cursor.nextAt).toISOString() } : {}),
      ...(cursor?.paused ? { paused: cursor.paused } : {}), ...(cursor?.lastError ? { error: cursor.lastError } : {}),
      ...(last ? { lastEvent: { id: last.id, status: last.status, occurredAt: last.occurredAt, ...(last.error ? { error: last.error } : {}), ...(last.reason ? { reason: last.reason } : {}) } } : {}) });
  }
  // The live snapshot carries what the header and monitor show; instructions stay in the history API.
  const brief = ({ payload: _payload, ...event }: TriggerEvent) => ({ ...event, input: { ...event.input, instructions: '' } });
  const latest = state.events.slice(-20);
  const shown = new Set(latest.map(event => event.id));
  // Older runs still working, or just finished, keep the monitor current after newer runs push them out.
  const lately = [...state.events].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 20);
  const updated: ReturnType<typeof brief>[] = [];
  for (const event of [...state.events.filter(item => UNFINISHED.has(item.status)), ...lately]) {
    if (!shown.has(event.id)) { shown.add(event.id); updated.push(brief(event)); }
  }
  const recent = latest.reverse().map(brief);
  const problem = sources.problem;
  return structuredClone({ onceReservations: { used: onceCount(state), limit: MAX_ONCE_RESERVATIONS }, triggers: summaries, recent, ...(updated.length ? { updated } : {}), ...(problem ? { storageError: problem } : {}) });
}

/**
 * Asked right before a trigger's run starts. A trigger deleted or turned off since the run fired starts
 * nothing, even if it was turned on again in between.
 */
export function launchAllowed(state: EngineState, triggerId: string, eventId: string | undefined): boolean {
  const trigger = state.triggers.find(item => item.id === triggerId);
  const event = state.events.find(item => item.id === eventId);
  if (!trigger || !event || (!trigger.enabled && state.onceConsumed[triggerId]?.eventId !== eventId)) return false;
  const turnedOffAt = state.cursors[triggerId]?.turnedOffAt;
  return turnedOffAt === undefined || Date.parse(event.receivedAt) > turnedOffAt;
}
