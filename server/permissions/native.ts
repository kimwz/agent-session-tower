import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, chmod, lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { PermissionScope } from '../../shared/permissions.js';

const run = promisify(execFile);
const failure = (message: string) => new Error(message);
export const CODEX_HEADER = '# Managed by Agent Session Tower. Edit these rules in Tower; changes made here are replaced.';

/** The Codex rules file Tower writes, for every project or for one project folder. */
export function codexRulesPath(scope: PermissionScope, cwd: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return scope === 'global' ? join(env.CODEX_HOME || join(homedir(), '.codex'), 'rules', 'tower.rules') : join(cwd!, '.codex', 'rules', 'tower.rules');
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * A project file is reached only through real folders: a `.codex` that links elsewhere (even to `~/.codex`) would send
 * the change outside the project. With `make`, missing folders are made; without it, a missing folder means there is
 * nothing to change (false). The file itself must not be a link either.
 */
async function projectFolders(cwd: string, file: string, make: boolean): Promise<boolean> {
  const root = resolve(cwd);
  const rest = relative(root, dirname(file));
  if (!rest || rest.startsWith('..') || isAbsolute(rest)) throw failure('규칙 파일 경로가 프로젝트 밖을 가리킵니다.');
  let current = root;
  for (const part of rest.split('/')) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw failure(`${current}가 심볼릭 링크라서 규칙 파일을 바꾸지 않았습니다.`);
    } catch (error) {
      if (!missing(error)) throw error;
      if (!make) return false;
      await mkdir(current, { mode: 0o755 });
    }
  }
  try { if ((await lstat(file)).isSymbolicLink()) throw failure(`${file}가 심볼릭 링크라서 규칙 파일을 바꾸지 않았습니다.`); }
  catch (error) { if (!missing(error)) throw error; }
  return true;
}

/** Replaces the file only if it still holds what was read; false when someone changed it meanwhile. */
async function replaceIfUnchanged(path: string, before: string | undefined, content: string): Promise<boolean> {
  const mode = await stat(path).then(info => info.mode & 0o777, () => 0o644);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode, flag: 'wx' });
    await chmod(temporary, mode);
    const now = await readFile(path, 'utf8').catch(error => { if (missing(error)) return undefined; throw error; });
    if (now !== before) { await unlink(temporary).catch(() => {}); return false; }
    await rename(temporary, path);
    return true;
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

/**
 * Writes Tower's own Codex rules file whole, or removes it when no rule is left. Only Tower writes this file, and a file
 * without Tower's header is left alone. A project file goes through the same link and git checks to be written or removed.
 */
export async function syncCodex(file: string, lines: readonly string[], project?: string): Promise<void> {
  // A home rules folder kept elsewhere (dotfiles) is used where it really is.
  const path = project ? file : join(await realpath(dirname(file)).catch(() => dirname(file)), basename(file));
  if (project) {
    if (!(await projectFolders(project, path, lines.length > 0))) return;
    await keepUntracked(project, path, lines.length > 0);
  }
  const text = await readFile(path, 'utf8').catch(error => { if (missing(error)) return undefined; throw error; });
  if (text !== undefined && !text.startsWith(CODEX_HEADER)) throw failure(`${path}는 Tower가 만든 파일이 아니라서 바꾸지 않았습니다.`);
  if (!lines.length) { if (text !== undefined) await unlink(path); return; }
  const content = `${CODEX_HEADER}\n${lines.join('\n')}\n`;
  if (content === text) return;
  if (!project) await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (!(await replaceIfUnchanged(path, text, content))) throw failure(`${path}가 쓰는 동안 바뀌어 규칙을 쓰지 않았습니다. 잠시 뒤 다시 저장하세요.`);
}

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try { const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 10_000, maxBuffer: 1_000_000 }); return { ok: true, out: stdout.trim() }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, out: '' };
    return { ok: false, out: String((error as { stdout?: string }).stdout ?? '').trim() };
  }
}

/**
 * Keeps a project rules file out of the repository, where it would be shared with everyone: a tracked file is never
 * changed or removed. With `exclude`, an untracked file that is not ignored yet goes into the repository's own
 * exclude list. Folders outside git need nothing.
 */
export async function keepUntracked(cwd: string, file: string, exclude = true): Promise<void> {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.out !== 'true') return;
  if ((await git(cwd, ['ls-files', '--error-unmatch', '--', file])).ok) throw failure(`${file}가 git에 커밋되어 있어 Tower가 바꾸지 않았습니다. 이 파일을 저장소에서 빼거나 규칙을 직접 관리하세요.`);
  if (!exclude || (await git(cwd, ['check-ignore', '-q', '--', file])).ok) return;
  const excludeFile = await git(cwd, ['rev-parse', '--git-path', 'info/exclude']);
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (!excludeFile.ok || !excludeFile.out || !top.ok) throw failure('git 제외 목록을 찾지 못해 규칙 파일을 쓰지 않았습니다.');
  const excludePath = resolve(cwd, excludeFile.out);
  // git reports real paths (/private/tmp on macOS); the file is compared the same way.
  const folder = await realpath(dirname(file)).catch(() => resolve(dirname(file)));
  const pattern = `/${join(relative(await realpath(top.out).catch(() => top.out), folder), basename(file)).split('\\').join('/')}`;
  const existing = await readFile(excludePath, 'utf8').catch(error => { if (missing(error)) return ''; throw error; });
  if (existing.split('\n').some(line => line.trim() === pattern)) return;
  await mkdir(dirname(excludePath), { recursive: true });
  await appendFile(excludePath, `${existing && !existing.endsWith('\n') ? '\n' : ''}${pattern}\n`);
}
