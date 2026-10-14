import type { LoginState, NodeSummary } from '../../../shared/link';
import type { ManagedSection } from '../../../shared/managed';

/**
 * Where a joined computer stands with "호스트 설정 따르기", as its card shows it: whether it follows this Tower, how
 * far this Tower's settings reached it, and whether new work can start there.
 */
export type FollowState = 'off' | 'following' | 'offline' | 'unsupported' | 'elsewhere';

export function followState(node: NodeSummary): FollowState {
  if (!node.followHost) return 'off';
  if (node.following) return 'following';
  if (node.status !== 'connected') return 'offline';
  // Connected and asked, but it says it follows another Tower (or never heard of following).
  return node.features.includes('followHost') ? 'elsewhere' : 'unsupported';
}

export interface SyncView {
  /** `delayed`: the last attempt or a section failed there; it keeps what it applied before. */
  state: 'waiting' | 'synced' | 'delayed';
  revision?: string;
  appliedAt?: string;
  error?: string;
  sections: Array<[ManagedSection, string]>;
  /** Its execution worker predates settings sync; it starts once the worker hands over. */
  workerPending: boolean;
}

export function syncView(node: NodeSummary): SyncView | undefined {
  if (followState(node) !== 'following') return undefined;
  const managed = node.managed;
  const sections = Object.entries(managed?.applied?.errors ?? {}) as Array<[ManagedSection, string]>;
  return { state: managed?.error || sections.length ? 'delayed' : managed?.applied ? 'synced' : 'waiting',
    ...(managed?.applied ? { revision: managed.applied.revision.slice(0, 8), appliedAt: managed.applied.appliedAt } : {}),
    ...(managed?.error ? { error: managed.error } : {}), sections, workerPending: !node.features.includes('managedSettings') };
}

export const LOGINS = ['claude', 'codex', 'gh'] as const;
export type LoginTool = typeof LOGINS[number];

/** Each CLI's sign-in there, as it last reported; none from a computer whose Tower predates the report. */
export function loginStates(node: NodeSummary): Array<[LoginTool, LoginState]> | undefined {
  const logins = node.report?.logins;
  return logins && LOGINS.map(tool => [tool, logins[tool]]);
}

/** How this Tower's secrets reach a computer that follows it, for its card; none while it does not follow or predates it. */
export function secretState(node: NodeSummary): NonNullable<NodeSummary['secrets']> | undefined {
  return followState(node) === 'following' ? node.secrets : undefined;
}

/** A terminal there can help: a sign-in is missing, and it follows this Tower (which may open its Workspace folder). */
export function needsSignIn(node: NodeSummary): boolean {
  return node.status === 'connected' && followState(node) === 'following' && Boolean(loginStates(node)?.some(([, state]) => state === 'missing'));
}
