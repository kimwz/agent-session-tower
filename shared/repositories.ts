/** Where a project folder's checked-out branch stands against its upstream. */
export interface RepositoryStatus {
  /** The project folder as sessions report it. */
  cwd: string;
  /** Top of the working tree that contains `cwd`. */
  root: string;
  /** Absent while HEAD is detached. */
  branch?: string;
  /** For example `origin/main`; absent when the branch tracks nothing. */
  upstream?: string;
  ahead: number;
  behind: number;
  /** Tracked files with uncommitted changes. Untracked files do not count. */
  changes: number;
  checkedAt: string;
  /** Last successful fetch; ahead/behind are only as fresh as this. */
  fetchedAt?: string;
  fetchError?: string;
  lastAction?: RepositoryActionResult;
}
export type RepositoryAction = 'pull' | 'push' | 'refresh';
export interface RepositoryActionResult {
  /** `auto-pull` is the fast-forward Tower makes before starting work in the folder. */
  kind: 'pull' | 'push' | 'auto-pull';
  ok: boolean;
  /** Commits moved, when it succeeded. */
  commits?: number;
  error?: string;
  at: string;
}
export type PullBlocker = 'detached' | 'no-upstream' | 'up-to-date' | 'diverged' | 'changes' | 'busy';
export type PushBlocker = 'detached' | 'no-upstream' | 'nothing' | 'behind';

/**
 * A fast-forward is safe only when it cannot lose or rewrite anything: the branch has no commits
 * of its own, no tracked file has edits, and no agent is working in the folder.
 */
export function pullBlocker(status: RepositoryStatus, busy: boolean): PullBlocker | undefined {
  if (!status.branch) return 'detached';
  if (!status.upstream) return 'no-upstream';
  if (!status.behind) return 'up-to-date';
  if (status.ahead) return 'diverged';
  if (status.changes) return 'changes';
  if (busy) return 'busy';
  return undefined;
}

/** Pushing never forces: a branch that is behind must be brought up to date first. */
export function pushBlocker(status: RepositoryStatus): PushBlocker | undefined {
  if (!status.branch) return 'detached';
  if (!status.upstream) return 'no-upstream';
  if (!status.ahead) return 'nothing';
  if (status.behind) return 'behind';
  return undefined;
}

/** True when the folder `cwd` lies inside the working tree `root`. */
export function insideRepository(root: string, cwd: string): boolean {
  return cwd === root || cwd.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/** Whether work in the folder `cwd` can touch the files of this repository. */
export function overlapsRepository(status: Pick<RepositoryStatus, 'cwd' | 'root'>, cwd: string): boolean {
  return insideRepository(status.root, cwd) || insideRepository(status.cwd, cwd) || insideRepository(cwd, status.cwd);
}
