import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { basename, dirname, join } from 'node:path';
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
  return { path: real, main, createdAt: created.mtimeMs, locked: own.some(line => line === 'locked' || line.startsWith('locked ')) };
}

export interface Blocker { reason: 'locked' | 'nested' | 'changes' | 'unpushed' | 'unpublished'; detail?: string }

/** Why removing this worktree would lose something, or undefined when everything in it is committed and published. */
export async function removalBlocker(git: GitRunner, worktree: LinkedWorktree): Promise<Blocker | undefined> {
  if (worktree.locked) return { reason: 'locked' };
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
  // Files git was told not to look at (`update-index --assume-unchanged` / `--skip-worktree`) may hold edits status hides.
  const hidden = (await git(worktree.path, ['ls-files', '-v'], TIMEOUT_MS)).split('\n').filter(line => /^(?:[a-z]|S) /.test(line)).length;
  if (hidden) return { reason: 'changes', detail: String(hidden) };
  // Branches are never deleted, so their commits stay; commits not yet published mean the work is not over.
  // An upstream that is gone was published and then deleted on the remote, as merged pull requests are.
  if (branch && upstream) return ahead ? { reason: 'unpushed', detail: `${branch} (${ahead})` } : nestedBlocker(git, worktree.path);
  // Without an upstream, and on a detached HEAD, which only the worktree holds: commits no remote (or branch or tag) has.
  const unpublished = Number((await git(worktree.path, ['rev-list', '--count', 'HEAD', '--not', '--remotes', ...(branch ? [] : ['--branches', '--tags'])], TIMEOUT_MS)).trim());
  if (!Number.isFinite(unpublished)) throw new Error('git rev-list gave no count');
  if (unpublished) return branch ? { reason: 'unpushed', detail: `${branch} (${unpublished})` } : { reason: 'unpublished', detail: String(unpublished) };
  return nestedBlocker(git, worktree.path);
}

const execute = promisify(execFile);

const MOST_NESTED = 100;

/**
 * A repository inside the worktree, in a folder git ignores there, goes with it. That only loses nothing when it is a plain
 * repository with nothing uncommitted and nothing it was meant to publish unpublished: test fixtures and fetched copies go,
 * another repository's worktree or submodule (a `.git` file), or work in progress, keeps the worktree.
 */
async function nestedBlocker(git: GitRunner, path: string): Promise<Blocker | undefined> {
  // `.git` folders and files, and the HEAD of any bare repository (one without a working tree, such as a backup).
  const { stdout } = await execute('find', [path, '-mindepth', '2', '(', '-name', '.git', '-prune', '-print', ')', '-o', '(', '-name', 'HEAD', '-type', 'f', '-print', ')'],
    { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  const lines = stdout.split('\n').filter(Boolean);
  for (const head of lines.filter(line => basename(line) === 'HEAD')) {
    const folder = dirname(head);
    const [objects, refs] = await Promise.all(['objects', 'refs'].map(name => stat(join(folder, name)).then(info => info.isDirectory(), () => false)));
    if (objects && refs) return { reason: 'nested', detail: folder };
  }
  const found = lines.filter(line => basename(line) === '.git');
  if (found.length > MOST_NESTED) return { reason: 'nested', detail: `${found.length} repositories` };
  for (const dotGit of found) {
    const folder = dirname(dotGit);
    if (!(await stat(dotGit)).isDirectory()) return { reason: 'nested', detail: folder };
    const status = await git(folder, ['status', '--porcelain', '--untracked-files=normal'], TIMEOUT_MS);
    if (status.trim()) return { reason: 'nested', detail: folder };
    if ((await git(folder, ['remote'], TIMEOUT_MS)).trim()) {
      const unpublished = Number((await git(folder, ['rev-list', '--count', '--all', '--not', '--remotes'], TIMEOUT_MS)).trim());
      if (!Number.isFinite(unpublished) || unpublished) return { reason: 'nested', detail: folder };
    }
  }
  return undefined;
}

/** `git worktree remove` without force: git itself refuses when anything is modified or untracked. */
export async function removeWorktree(git: GitRunner, worktree: LinkedWorktree): Promise<void> {
  await git(worktree.main, ['worktree', 'remove', worktree.path], REMOVE_TIMEOUT_MS);
}
