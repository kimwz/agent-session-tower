import type { Session } from '../../../shared/types.js';
import { retentionNodeMap } from './ancestry.js';
import type { RetentionNode } from '../../../shared/retention.js';

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
  /** Archive once the session settles, whatever its kind (a closed issue's family, masters included). */
  archiveWhenIdle?: boolean;
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
  /** Cold relationship nodes only; these are never native execution records. */
  ancestry?: readonly RetentionNode[];
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
  const nodes = retentionNodeMap(observation);
  const roots = new Map<string, string>();
  for (const session of sessions) {
    let node = nodes.get(session.id); const seen = new Set<string>();
    while (node?.isSubagent && node.parentId && !seen.has(node.id)) { seen.add(node.id); const parent=nodes.get(node.parentId); if (!parent) break; node=parent; }
    roots.set(session.id,node?.id || session.id);
  }
  const children = new Map<string, string[]>();
  const protectedIds = new Set(observation.protectedIds);
  for (const node of observation.ancestry || []) if (node.isSubagent===true && node.parentId) {
    const siblings=children.get(node.parentId)||[];siblings.push(node.id);children.set(node.parentId,siblings);
  }
  for (const { session } of observation.records) {
    if (session.status === 'working' || session.activeProcess || session.scheduledAt || session.creationPending) protectedIds.add(session.id);
    if (session.isSubagent && session.parentId) {
      const siblings = children.get(session.parentId) || [];
      siblings.push(session.id); children.set(session.parentId, siblings);
    }
  }
  // Claude's parent can resume a native child even after its previous task ended.
  for (const record of observation.records) if (record.session.provider === 'claude' && record.session.isSubagent) {
    const seen = new Set<string>(); let parent = record.session.parentId;
    while (parent && !seen.has(parent)) {
      seen.add(parent); if (protectedIds.has(parent)) { protectedIds.add(record.session.id); break; }
      parent = nodes.get(parent)?.parentId;
    }
  }
  const descendants = (id: string): string[] => {
    const found = new Set<string>(); const pending = [id];
    while (pending.length) {
      const next = pending.pop()!;
      if (found.has(next)) continue;
      found.add(next); pending.push(...children.get(next) || []);
    }
    return [...found].filter(member => records.has(member));
  };
  const validRelationship = (id: string): boolean => {
    const seen = new Set<string>(); let node = nodes.get(id);
    while (node) {
      if (seen.has(node.id) || observation.blockedIds?.has(node.id)) return false;
      seen.add(node.id);
      if (node.isSubagent === false) return true;
      if (node.isSubagent !== true || !node.parentId) return false;
      node = nodes.get(node.parentId);
    }
    return false;
  };
  const emit = (id: string, reason: RetentionCandidate['reason'], ids: string[]) => {
    if (reason === 'parent-limit' && ids.some(member => {
      const record = records.get(member)!; if (record.kind === 'parent') return false;
      const ended = Math.max(time(record.latestTaskEndedAt), time(record.restoredAt)) || time(record.inactiveSince);
      return !ended || observation.now < ended + RETENTION_DAYS * DAY;
    })) { result.deferred.push({ id, reason: 'young-descendant' }); return false; }
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
  for (const parent of sessions.filter(session => roots.get(session.id)===session.id && !session.launchedByAgent && !session.master)) {
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
  // A requested archive waits for its session to settle, not to age: a turn running at the request
  // finishes first, and activity after the request does not withdraw it (only reopening does).
  // Without a recorded end, a day of unchanged native state counts as settled.
  const depth = (id: string): number => { let count = 0; const seen = new Set<string>(); for (let node = nodes.get(id); node?.parentId && !seen.has(node.id); node = nodes.get(node.parentId)) { seen.add(node.id); count++; } return count; };
  // A subagent's request lapses while an ancestor it belongs to is kept, so reopening a parent
  // (which cancels only the parent's request) keeps its whole family.
  const ancestorKept = (id: string): boolean => {
    const seen = new Set<string>();
    for (let node = nodes.get(id); node?.isSubagent && node.parentId && !seen.has(node.id); node = nodes.get(node.parentId)) {
      seen.add(node.id); const parent = records.get(node.parentId);
      if (parent && !parent.archiveWhenIdle) return true;
    }
    return false;
  };
  const requested = observation.records.filter(record => record.archiveWhenIdle && !ancestorKept(record.session.id));
  const requestedIds = new Set(requested.map(record => record.session.id));
  // Ancestors first, so a requested family leaves as one operation rather than child by child.
  requested.sort((a, b) => depth(a.session.id) - depth(b.session.id));
  for (const record of requested) {
    const id = record.session.id;
    if (assigned.has(id)) continue;
    // An end before a restore is the one that was archived; a restored session needs a new end or a quiet day.
    const ended = time(record.latestTaskEndedAt), inactive = time(record.inactiveSince);
    if (!(ended && ended >= time(record.restoredAt)) && !(inactive && observation.now >= inactive + DAY)) { result.deferred.push({ id, reason: 'awaiting-idle' }); continue; }
    const ids = descendants(id).filter(member => !assigned.has(member));
    if (emit(id, 'explicit-archive', ids)) for (const member of ids) assigned.add(member);
  }
  for (const record of observation.records) {
    const { session } = record;
    if (record.kind === 'parent' || assigned.has(session.id) || requestedIds.has(session.id)) continue;
    const end = Math.max(time(record.latestTaskEndedAt), time(record.restoredAt));
    const observed = end || time(record.inactiveSince);
    if (!observed) { result.deferred.push({ id: session.id, reason: 'unproven-inactivity' }); continue; }
    const explicit = Boolean(record.archivedAt);
    if (!explicit && observation.now < observed + RETENTION_DAYS * DAY) continue;
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
