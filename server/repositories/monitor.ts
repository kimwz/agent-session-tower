import type { ProjectGroup, Session } from '../../shared/types.js';
import { pullBlocker, pushBlocker, type RepositoryAction, type RepositoryActionResult, type RepositoryStatus } from '../../shared/repositories.js';
import { gitRunner, parseStatus, type GitRunner } from './git.js';

const TICK_MS = 60_000;
const FETCH_EVERY_MS = 5 * 60_000;
const NOT_A_REPOSITORY_RECHECK_MS = 30 * 60_000;
const RECENT_SESSION_MS = 7 * 24 * 60 * 60_000;
const MAX_WATCHED = 40;
const CONCURRENCY = 3;
/** Before a run starts, a fetch older than this is repeated, but only briefly. */
const PREPARE_FETCH_AGE_MS = 2 * 60_000;
const PREPARE_FETCH_TIMEOUT_MS = 5_000;
const FETCH_TIMEOUT_MS = 30_000;
const PUSH_TIMEOUT_MS = 60_000;
const LOCAL_TIMEOUT_MS = 10_000;

const temporary = (cwd: string) => /^\/(?:private\/)?tmp(?:\/|$)/.test(cwd);

/** Folders worth keeping in sync: pinned groups and folders with a session from the last week. */
export function watchedRepositoryPaths(sessions: readonly Session[], groups: readonly ProjectGroup[], now = Date.now()): string[] {
  const hidden = new Set(groups.filter(group => group.hidden).map(group => group.cwd));
  const latest = new Map<string, number>();
  for (const group of groups) if (group.pinned && !group.hidden) latest.set(group.cwd, Infinity);
  for (const session of sessions) {
    if (!session.cwd.startsWith('/') || hidden.has(session.cwd) || session.launchedByAgent) continue;
    const at = Date.parse(session.updatedAt);
    if (!Number.isFinite(at) || now - at > RECENT_SESSION_MS) continue;
    latest.set(session.cwd, Math.max(latest.get(session.cwd) ?? 0, at));
  }
  return [...latest].filter(([cwd]) => !temporary(cwd)).sort((a, b) => b[1] - a[1]).slice(0, MAX_WATCHED).map(([cwd]) => cwd);
}

const repositoryError = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

interface Entry { status?: RepositoryStatus; notRepositoryAt?: number; fetchAttemptAt?: number }

export interface RepositoryMonitorOptions {
  watched: () => string[];
  /** Whether an agent is working in the folder, anywhere in its working tree, or above it. */
  busy: (status: RepositoryStatus) => boolean;
  onChange: () => void;
  git?: GitRunner;
  now?: () => number;
}

/**
 * Keeps ahead/behind counts for project folders. It only fetches on its own; branches move
 * when the owner asks, or by fast-forward before work starts when nothing can be lost.
 */
export class RepositoryMonitor {
  private readonly entries = new Map<string, Entry>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly git: GitRunner;
  private readonly now: () => number;
  private timer?: ReturnType<typeof setTimeout>;
  private ticking?: Promise<void>;
  private stopped = false;

  constructor(private readonly options: RepositoryMonitorOptions) {
    this.git = options.git ?? gitRunner();
    this.now = options.now ?? Date.now;
  }

  start(): void {
    this.stopped = false;
    const run = () => {
      this.ticking = this.tick().catch(() => {}).finally(() => {
        this.ticking = undefined;
        if (!this.stopped) this.timer = setTimeout(run, TICK_MS);
      });
    };
    this.timer = setTimeout(run, 0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.ticking;
  }

  list(): RepositoryStatus[] {
    const watched = new Set(this.options.watched());
    return [...this.entries.values()].flatMap(entry => entry.status && watched.has(entry.status.cwd) ? [{ ...entry.status }] : []);
  }

  /** One pass over the watched folders: local status every time, a fetch when it is due. */
  async tick(): Promise<void> {
    const queue = this.options.watched();
    const worker = async () => {
      for (let cwd = queue.shift(); cwd !== undefined && !this.stopped; cwd = queue.shift()) {
        const entry = this.entries.get(cwd);
        if (entry?.notRepositoryAt !== undefined && this.now() - entry.notRepositoryAt < NOT_A_REPOSITORY_RECHECK_MS) continue;
        const due = !entry?.fetchAttemptAt || this.now() - entry.fetchAttemptAt >= FETCH_EVERY_MS;
        await this.refresh(cwd, due ? FETCH_TIMEOUT_MS : undefined).catch(() => {});
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  async act(cwd: string, action: RepositoryAction): Promise<RepositoryStatus> {
    if (!this.options.watched().includes(cwd) && !this.entries.get(cwd)?.status) throw repositoryError('Tower가 추적하는 프로젝트 폴더가 아닙니다.', 404);
    if (action === 'refresh') {
      const status = await this.refresh(cwd, FETCH_TIMEOUT_MS);
      if (!status) throw repositoryError('Git 저장소가 아닙니다.', 404);
      return status;
    }
    return action === 'pull' ? this.pull(cwd, 'pull') : this.push(cwd);
  }

  /**
   * Before Tower starts work in a folder, bring its branch up to date when that cannot lose
   * anything. Never throws and never delays the run by more than a short fetch.
   */
  async prepareRun(cwd: string): Promise<void> {
    try {
      const entry = this.entries.get(cwd);
      if (entry?.notRepositoryAt !== undefined && this.now() - entry.notRepositoryAt < NOT_A_REPOSITORY_RECHECK_MS) return;
      const stale = !entry?.fetchAttemptAt || this.now() - entry.fetchAttemptAt >= PREPARE_FETCH_AGE_MS;
      const status = await this.refresh(cwd, stale ? PREPARE_FETCH_TIMEOUT_MS : undefined);
      if (status && !pullBlocker(status, this.options.busy(status))) await this.pull(cwd, 'auto-pull');
    } catch { /* The run starts regardless; the badge shows what was left behind. */ }
  }

  private async pull(cwd: string, kind: 'pull' | 'auto-pull'): Promise<RepositoryStatus> {
    return this.exclusive(cwd, async () => {
      const before = await this.readStatus(cwd);
      if (!before) throw repositoryError('Git 저장소가 아닙니다.', 404);
      const blocker = pullBlocker(before, this.options.busy(before));
      if (blocker) throw repositoryError(PULL_BLOCKERS[blocker], 409);
      const result = await this.git(cwd, ['merge', '--ff-only', '--quiet', '@{upstream}'], LOCAL_TIMEOUT_MS)
        .then(() => ({ kind, ok: true, commits: before.behind }), (error: Error) => ({ kind, ok: false, error: error.message }));
      return this.record(cwd, { ...result, at: new Date(this.now()).toISOString() });
    });
  }

  private async push(cwd: string): Promise<RepositoryStatus> {
    return this.exclusive(cwd, async () => {
      const before = await this.readStatus(cwd);
      if (!before) throw repositoryError('Git 저장소가 아닙니다.', 404);
      const blocker = pushBlocker(before);
      if (blocker) throw repositoryError(PUSH_BLOCKERS[blocker], 409);
      const branch = before.branch!;
      // The upstream is named in full, so a branch tracking a differently named one still pushes there.
      const remote = (await this.git(cwd, ['config', '--get', `branch.${branch}.remote`], LOCAL_TIMEOUT_MS)).trim();
      const merge = (await this.git(cwd, ['config', '--get', `branch.${branch}.merge`], LOCAL_TIMEOUT_MS)).trim();
      const result = await this.git(cwd, ['push', '--quiet', remote, `HEAD:${merge}`], PUSH_TIMEOUT_MS)
        .then(() => ({ kind: 'push' as const, ok: true, commits: before.ahead }), (error: Error) => ({ kind: 'push' as const, ok: false, error: error.message }));
      return this.record(cwd, { ...result, at: new Date(this.now()).toISOString() });
    });
  }

  private async record(cwd: string, action: RepositoryActionResult): Promise<RepositoryStatus> {
    const status = await this.readStatus(cwd) ?? this.entries.get(cwd)?.status;
    if (!status) throw repositoryError('Git 저장소가 아닙니다.', 404);
    status.lastAction = action;
    this.options.onChange();
    return { ...status };
  }

  /** Fetches first when `fetchTimeoutMs` is given; a failed fetch still reports local state. */
  private refresh(cwd: string, fetchTimeoutMs?: number): Promise<RepositoryStatus | undefined> {
    return this.exclusive(cwd, async () => {
      const previous = this.entries.get(cwd)?.status;
      let fetched: { at?: string; error?: string } | undefined;
      if (fetchTimeoutMs !== undefined && (previous?.upstream || !previous)) {
        const entry = this.entries.get(cwd) ?? {};
        entry.fetchAttemptAt = this.now();
        this.entries.set(cwd, entry);
        // FETCH_HEAD stays untouched so an agent's own `git pull` in the same folder is not disturbed.
        fetched = await this.git(cwd, ['fetch', '--quiet', '--no-write-fetch-head'], fetchTimeoutMs)
          .then(() => ({ at: new Date(this.now()).toISOString() }), (error: Error) => ({ error: error.message }));
      }
      const status = await this.readStatus(cwd);
      if (status && fetched) {
        if (fetched.at) { status.fetchedAt = fetched.at; delete status.fetchError; }
        else status.fetchError = fetched.error;
      }
      const shown = (value?: RepositoryStatus) => value && JSON.stringify({ ...value, checkedAt: undefined });
      if (shown(status) !== shown(previous)) this.options.onChange();
      return status && { ...status };
    });
  }

  /** Reads local state and stores it, keeping the last fetch and action. Undefined outside git. */
  private async readStatus(cwd: string): Promise<RepositoryStatus | undefined> {
    const entry = this.entries.get(cwd) ?? {};
    this.entries.set(cwd, entry);
    let root: string;
    try { root = (await this.git(cwd, ['rev-parse', '--show-toplevel'], LOCAL_TIMEOUT_MS)).trim(); }
    catch {
      entry.notRepositoryAt = this.now();
      delete entry.status;
      return undefined;
    }
    delete entry.notRepositoryAt;
    const local = parseStatus(await this.git(cwd, ['status', '--porcelain=v2', '--branch', '--untracked-files=no'], LOCAL_TIMEOUT_MS));
    const previous = entry.status;
    const status: RepositoryStatus = { cwd, root, ...local, checkedAt: new Date(this.now()).toISOString(),
      ...(previous?.fetchedAt ? { fetchedAt: previous.fetchedAt } : {}), ...(previous?.fetchError ? { fetchError: previous.fetchError } : {}),
      ...(previous?.lastAction ? { lastAction: previous.lastAction } : {}) };
    entry.status = status;
    return status;
  }

  /** Tower's own git commands never overlap within one folder. */
  private exclusive<T>(cwd: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(cwd) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    const settled = next.catch(() => {});
    this.locks.set(cwd, settled);
    void settled.then(() => { if (this.locks.get(cwd) === settled) this.locks.delete(cwd); });
    return next;
  }
}

const PULL_BLOCKERS: Record<string, string> = {
  detached: '브랜치가 체크아웃되어 있지 않습니다.',
  'no-upstream': '이 브랜치가 추적하는 원격 브랜치가 없습니다.',
  'up-to-date': '이미 최신 상태입니다.',
  diverged: '로컬에만 있는 커밋이 있어 fast-forward할 수 없습니다. 에이전트에게 병합이나 리베이스를 요청하세요.',
  changes: '커밋하지 않은 변경 사항이 있어 받지 않았습니다.',
  busy: '이 폴더에서 에이전트가 작업 중이라 받지 않았습니다.',
};
const PUSH_BLOCKERS: Record<string, string> = {
  detached: '브랜치가 체크아웃되어 있지 않습니다.',
  'no-upstream': '이 브랜치가 추적하는 원격 브랜치가 없습니다.',
  nothing: '푸시할 커밋이 없습니다.',
  behind: '원격에 새 커밋이 있어 푸시할 수 없습니다. 먼저 받은 뒤 푸시하세요.',
};
