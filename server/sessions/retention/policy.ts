import type { Session } from '../../../shared/types.js';
import { familyIndex, getMainSessions } from '../../../shared/session-family.js';

export const RETENTION_DAYS = 7;
export const RETAINED_PARENT_COUNT = 20;
const DAY = 86_400_000;
export interface RetentionRecord {
  session: Session;
  kind: 'parent' | 'subagent' | 'helper' | 'guardian';
  /** Verified logical project identity; absent identities never participate in parent limits. */
  projectKey?: string;
  lastActivityAt?: string;
  /** Latest event ordinal is terminal; supplied by the observer, not inferred from file mtime. */
  latestTaskEndedAt?: string;
  inactiveSince?: string;
  archivedAt?: string;
  archiveRevision?: number;
  restoredAt?: string;
}
export interface RetentionObservation {
  now: number;
  migratedAt: number;
  complete: boolean;
  issues?: string[];
  records: RetentionRecord[];
  protectedIds: ReadonlySet<string>;
  blockedIds?: ReadonlySet<string>;
}
export type { RetentionCandidate } from '../../../shared/retention.js';
import type { RetentionCandidate } from '../../../shared/retention.js';
export interface RetentionSelection {
  candidates: RetentionCandidate[];
  deferred: { id: string; reason: string }[];
}
function time(value?: string): number { return value ? Date.parse(value) || 0 : 0; }

export function selectRetention(observation: RetentionObservation): RetentionSelection {
  const result: RetentionSelection = { candidates: [], deferred: [] };
  if (!observation.complete) {
    result.deferred = observation.records.map(record => ({ id: record.session.id, reason: 'incomplete-observation' }));
    return result;
  }
  const records = new Map(observation.records.map(record => [record.session.id, record]));
  const sessions = observation.records.map(record => record.session);
  const { roots } = familyIndex(sessions);
  const children = new Map<string, string[]>();
  const protectedIds = new Set(observation.protectedIds);
  for (const { session } of observation.records) {
    if (session.status === 'working' || session.activeProcess || session.scheduledAt || session.creationPending) protectedIds.add(session.id);
    if (session.isSubagent && session.parentId) {
      const siblings = children.get(session.parentId) || [];
      siblings.push(session.id); children.set(session.parentId, siblings);
    }
  }
  const descendants = (id: string): string[] => {
    const found = new Set<string>(); const pending = [id];
    while (pending.length) {
      const next = pending.pop()!;
      if (found.has(next)) continue;
      found.add(next); pending.push(...children.get(next) || []);
    }
    return [...found];
  };
  const validRelationship = (id: string): boolean => {
    const seen = new Set<string>(); let record = records.get(id);
    while (record) {
      if (seen.has(record.session.id)) return false;
      seen.add(record.session.id);
      if (!record.session.isSubagent) return true;
      if (!record.session.parentId) return false;
      record = records.get(record.session.parentId);
    }
    return false;
  };
  const emit = (id: string, reason: RetentionCandidate['reason'], ids: string[]) => {
    const unsafe = ids.find(member => protectedIds.has(member) || observation.blockedIds?.has(member) || !validRelationship(member));
    if (unsafe) { result.deferred.push({ id, reason: !validRelationship(unsafe) ? 'unknown-relationship' : 'protected' }); return false; }
    result.candidates.push({ rootId: id, ids, reason, revisions: Object.fromEntries(ids.map(member => [member, records.get(member)?.archiveRevision || 0])) });
    return true;
  };
  const migrationReady = observation.now >= observation.migratedAt + RETENTION_DAYS * DAY;
  // Parent limits are per logical project and use genuine family activity, excluding metadata writes.
  const projects = new Map<string, { id: string; activity: number }[]>();
  const activityByRoot = new Map<string, number>();
  for (const member of observation.records) { const root = roots.get(member.session.id)!; activityByRoot.set(root, Math.max(activityByRoot.get(root) || 0, time(member.lastActivityAt))); }
  for (const parent of getMainSessions(sessions)) {
    const record = records.get(parent.id)!;
    if (record.kind !== 'parent' || !record.projectKey) continue;
    const activity = activityByRoot.get(parent.id) || 0;
    const project = projects.get(record.projectKey) || [];
    project.push({ id: parent.id, activity }); projects.set(record.projectKey, project);
  }
  for (const parents of projects.values()) {
    parents.sort((a, b) => b.activity - a.activity || a.id.localeCompare(b.id));
    for (const parent of parents.slice(RETAINED_PARENT_COUNT)) {
      if (!migrationReady) { result.deferred.push({ id: parent.id, reason: 'migration-grace' }); continue; }
      emit(parent.id, 'parent-limit', observation.records.filter(member => roots.get(member.session.id) === parent.id).map(member => member.session.id));
    }
  }
  const assigned = new Set(result.candidates.flatMap(candidate => candidate.ids));
  for (const record of observation.records) {
    const { session } = record;
    if (record.kind === 'parent' || assigned.has(session.id)) continue;
    const end = Math.max(time(record.latestTaskEndedAt), time(record.restoredAt));
    const observed = end || time(record.inactiveSince);
    if (!observed) { result.deferred.push({ id: session.id, reason: 'unproven-inactivity' }); continue; }
    const explicit = Boolean(record.archivedAt);
    if (!explicit && observation.now < Math.max(observed, observation.migratedAt) + RETENTION_DAYS * DAY) continue;
    // A newer activity invalidates an old completion, restore grace or archive request.
    if (time(record.lastActivityAt) > observed || (explicit && time(record.lastActivityAt) > time(record.archivedAt))) {
      result.deferred.push({ id: session.id, reason: 'newer-activity' }); continue;
    }
    // Explicit archive expands to descendants; age expiry is independently evaluated per child.
    const ids = explicit ? descendants(session.id) : [session.id];
    if (!explicit && (children.get(session.id) || []).some(id => protectedIds.has(id) || descendants(id).some(child => protectedIds.has(child)))) {
      result.deferred.push({ id: session.id, reason: 'active-descendant' }); continue;
    }
    if (emit(session.id, explicit ? 'explicit-archive' : 'child-expired', ids)) for (const id of ids) assigned.add(id);
  }
  return result;
}
