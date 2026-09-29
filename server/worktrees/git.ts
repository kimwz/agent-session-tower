import { realpath, stat } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import type { GitRunner } from '../repositories/git.js';

const TIMEOUT_MS = 20_000;
/** Removing a worktree deletes its installed dependencies too, which can take minutes. */
const REMOVE_TIMEOUT_MS = 15 * 60_000;

export interface LinkedWorktree {
  /** The worktree's folder, resolved. */
  path: string;
  /** Its main working tree (or bare repository), where it is removed from. */
  main: string;
  /** When `git worktree add` created it: its administrative `commondir` file is written then and never again. */
  createdAt: number;
  locked: boolean;
  /** Other worktrees of the repository inside this one (in an ignored folder): removing this one would delete them. */
  nested: boolean;
}

/**
 * The linked worktree at exactly `path`, or undefined when the folder is gone or is not one (a main working tree, a plain
 * folder, a subfolder of a worktree). Git failing for another reason throws, so the caller can try again later.
 */
export async function linkedWorktree(git: GitRunner, path: string): Promise<LinkedWorktree | undefined> {
  const real = await realpath(path).catch(() => undefined);
  if (!real || !(await stat(real)).isDirectory()) return undefined;
  let output: string;
  try { output = await git(real, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'], TIMEOUT_MS); }
  catch (error) { if (/not a git repository/i.test(String((error as Error).message))) return undefined; throw error; }
  const [gitDir, common, top] = output.trim().split('\n');
  if (!gitDir || !common || !top) return undefined;
  const [realGitDir, realCommon, realTop] = await Promise.all([gitDir, common, top].map(item => realpath(item).catch(() => item)));
  if (realTop !== real || realGitDir === realCommon || dirname(realGitDir!) !== join(realCommon!, 'worktrees')) return undefined;
  const created = await stat(join(realGitDir!, 'commondir'));
  const list = await git(real, ['worktree', 'list', '--porcelain'], TIMEOUT_MS);
  const entries = list.split('\n\n').map(block => block.split('\n').filter(Boolean));
  const main = entries[0]?.find(line => line.startsWith('worktree '))?.slice(9);
  if (!main) return undefined;
  const own = await (async () => {
    for (const entry of entries.slice(1)) {
      const listed = entry.find(line => line.startsWith('worktree '))?.slice(9);
      if (listed && await realpath(listed).catch(() => listed) === real) return entry;
    }
    return undefined;
  })();
  if (!own) return undefined;
  const listed = await Promise.all(entries.flatMap(entry => entry.filter(line => line.startsWith('worktree ')).map(line => realpath(line.slice(9)).catch(() => line.slice(9)))));
  return { path: real, main, createdAt: created.mtimeMs, locked: own.some(line => line === 'locked' || line.startsWith('locked ')),
    nested: listed.some(other => other !== real && other.startsWith(real + sep)) };
}

export interface Blocker { reason: 'locked' | 'nested' | 'changes' | 'unpushed' | 'unpublished'; detail?: string }

/** Why removing this worktree would lose something, or undefined when everything in it is committed and published. */
export async function removalBlocker(git: GitRunner, worktree: LinkedWorktree): Promise<Blocker | undefined> {
  if (worktree.locked) return { reason: 'locked' };
  if (worktree.nested) return { reason: 'nested' };
  const status = await git(worktree.path, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'], TIMEOUT_MS);
  let branch: string | undefined, upstream: string | undefined, ahead: number | undefined;
  let changes = 0;
  for (const line of status.split('\n')) {
    if (line.startsWith('# branch.head ')) { const head = line.slice(14); if (head !== '(detached)') branch = head; }
    else if (line.startsWith('# branch.upstream ')) upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) ahead = Number(/^\+(\d+)/.exec(line.slice(12))?.[1]);
    else if (/^[12u?] /.test(line)) changes++;
  }
  if (changes) return { reason: 'changes', detail: String(changes) };
  // Branches are never deleted, so their commits stay; commits not yet published mean the work is not over.
  // An upstream that is gone was published and then deleted on the remote, as merged pull requests are.
  if (branch && upstream) return ahead ? { reason: 'unpushed', detail: `${branch} (${ahead})` } : undefined;
  // Without an upstream, and on a detached HEAD, which only the worktree holds: commits no remote (or branch or tag) has.
  const unpublished = Number((await git(worktree.path, ['rev-list', '--count', 'HEAD', '--not', '--remotes', ...(branch ? [] : ['--branches', '--tags'])], TIMEOUT_MS)).trim());
  if (!Number.isFinite(unpublished)) throw new Error('git rev-list gave no count');
  if (unpublished) return branch ? { reason: 'unpushed', detail: `${branch} (${unpublished})` } : { reason: 'unpublished', detail: String(unpublished) };
  return undefined;
}

/** `git worktree remove` without force: git itself refuses when anything is modified or untracked. */
export async function removeWorktree(git: GitRunner, worktree: LinkedWorktree): Promise<void> {
  await git(worktree.main, ['worktree', 'remove', worktree.path], REMOVE_TIMEOUT_MS);
}
