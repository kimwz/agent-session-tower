import type { Trigger } from '../../shared/triggers.js';
import type { GitHubCursor } from './github.js';
import type { Cursor } from './state.js';

/** Two records of one GitHub watch: what either took or noted stays taken; the rest is the current one's. */
export function mergeGitHub(current: GitHubCursor | undefined, value: GitHubCursor): GitHubCursor | undefined {
  // A backup's record is taken whole or not at all: a partial one (a list lost, a check time kept) would take old issues as new.
  const strings = (list: unknown) => list === undefined || (Array.isArray(list) && list.every(item => typeof item === 'string'));
  const baseline = value.baseline as unknown as Record<string, unknown> | undefined;
  const validBaseline = baseline === undefined || (!!baseline && typeof baseline === 'object' && (baseline.before === undefined || typeof baseline.before === 'string')
    && (baseline.watermarks === undefined || (!!baseline.watermarks && typeof baseline.watermarks === 'object' && Object.values(baseline.watermarks).every(item => Number.isInteger(item)))));
  const number = (item: unknown) => item === undefined || (typeof item === 'number' && Number.isFinite(item));
  if (!strings(value.handled) || !strings(value.skipped) || !strings(value.reviews) || !strings(value.matched) || !validBaseline || !number(value.checkedAt) || !number(value.verifiedAt)) return current;
  const saved: GitHubCursor = structuredClone(value);
  if (!current) return saved;
  const union = (a?: string[], b?: string[]) => a || b ? [...new Set([...(a ?? []), ...(b ?? [])])] : undefined;
  const handled = union(current.handled, saved.handled), skipped = union(current.skipped, saved.skipped), reviews = union(current.reviews, saved.reviews);
  const checkedAt = Math.max(current.checkedAt ?? -Infinity, saved.checkedAt ?? -Infinity);
  return { ...current, ...(handled ? { handled } : {}), ...(skipped ? { skipped } : {}), ...(reviews ? { reviews } : {}), ...(Number.isFinite(checkedAt) ? { checkedAt } : {}) };
}

/**
 * What a GitHub trigger keeps when its definition changes while on, with the same connection and kind of watch. An
 * issue watch keeps the issues it took; when what it watches changed and it starts from now, the issues that newly
 * match but were opened before the last check are noted instead of taken, while issues opened meanwhile, or waiting
 * for a place, still run.
 */
export function keptGitHub(before: Trigger, after: Trigger, cursor: Cursor | undefined): GitHubCursor | undefined {
  if (before.source.kind !== 'github' || after.source.kind !== 'github' || !cursor?.github) return undefined;
  const [a, b] = [before.source, after.source];
  if (JSON.stringify(a.auth) !== JSON.stringify(b.auth) || a.account.toLowerCase() !== b.account.toLowerCase() || a.watch.type !== b.watch.type) return undefined;
  if (a.watch.type === 'issues' && b.watch.type === 'issues') {
    const scope = ({ repos, assignee, labels, excludeLabels, authors, authorAssociation, includePullRequests, start }: typeof a.watch) =>
      JSON.stringify([repos, assignee, labels, excludeLabels, authors, authorAssociation, includePullRequests, start]);
    const kept = cursor.github;
    // A baseline not yet taken (after moving from an earlier kind, or an earlier edit) stays: it is already the earlier one.
    if (scope(a.watch) === scope(b.watch) || b.watch.start !== 'new' || kept.checkedAt === undefined || kept.baseline) return kept;
    // Switched to start from now: the backlog it was working through is left alone too.
    if (a.watch.start !== 'new') return { ...kept, baseline: {} };
    return { ...kept, baseline: { before: new Date(kept.checkedAt).toISOString() } };
  }
  // What a review may decide does not change which requests are seen.
  if (a.watch.type === 'review-requested' && b.watch.type === 'review-requested') return JSON.stringify([a.watch.repos, a.watch.includeTeams]) === JSON.stringify([b.watch.repos, b.watch.includeTeams]) ? cursor.github : undefined;
  return undefined;
}
