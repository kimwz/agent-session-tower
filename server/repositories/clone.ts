import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TowerError } from '../../shared/errors.js';
import { gitRunner, type GitRunner } from './git.js';
import { normalizeRemoteUrl, remoteUrlOf } from './remote-url.js';

/** A folder on this computer holding a clone of a repository. */
export interface ClonedFolder { cwd: string; remoteUrl: string; cloned: boolean }

const CLONE_MS = 10 * 60_000;
const MAX_FOLDERS = 100;
const INVALID = '저장소 주소가 올바르지 않습니다. https://github.com/owner/repo 또는 git@github.com:owner/repo 형식으로 입력하세요.';
let queue: Promise<unknown> = Promise.resolve();

/** The folder repositories are cloned into on this computer, `~/Workspace`, made when missing; by its real path. */
export async function workspaceFolder(home = homedir()): Promise<string> {
  const folder = join(home, 'Workspace');
  await mkdir(folder, { recursive: true });
  return realpath(folder);
}

/** A repository path: `owner/repo`, with groups between them, and nothing that encodes or hides anything. */
const REPOSITORY_PATH = /^[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)+\/?$/;

/**
 * Addresses this computer clones from: `https://host/owner/repo`, `ssh://[user@]host[:port]/owner/repo` or
 * `user@host:owner/repo`. Never a local path, an option, one of git's helper transports (`ext::`), or anything that
 * can carry a credential: no password, no https user, no query or fragment, no https port.
 */
function cloneable(url: string): boolean {
  if (url.includes('::') || /[\s?#%\\]/.test(url)) return false;
  const scp = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(.+)$/.exec(url);
  if (scp) return REPOSITORY_PATH.test(scp[1]!);
  let parsed: URL;
  // best-effort: what is no URL is no address to clone.
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.password || parsed.search || parsed.hash || !REPOSITORY_PATH.test(parsed.pathname.slice(1))) return false;
  if (parsed.protocol === 'https:') return !parsed.username && !parsed.port;
  return parsed.protocol === 'ssh:';
}

/**
 * What the owner can do about a failed clone, in fixed words: git's own output never goes back to the controller.
 * It is logged here for this computer's owner.
 */
function cloneFailure(error: unknown): TowerError {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`A repository was not cloned: ${detail}`);
  if (/timed out/.test(detail)) return new TowerError('upstream', '저장소를 받는 데 10분이 넘게 걸려 멈췄습니다. 다시 시도하세요.');
  if (/Host key verification failed/i.test(detail)) return new TowerError('upstream', '이 컴퓨터가 그 서버의 SSH 호스트 키를 아직 모릅니다. https 주소로 다시 시도하거나, 이 컴퓨터의 터미널에서 한 번 접속해 키를 확인하세요.');
  if (/could not read (Username|Password)|terminal prompts disabled|Authentication failed|Permission denied|Repository not found|not found|access denied|returned error: 40[134]/i.test(detail)) {
    return new TowerError('upstream', '저장소에 접근하지 못했습니다. 주소를 확인하고, 비공개 저장소라면 이 컴퓨터에서 gh auth login 후 다시 시도하세요.');
  }
  if (/Could not resolve host|Failed to connect|Connection (refused|timed out|reset)|Network is unreachable|SSL|TLS|certificate/i.test(detail)) {
    return new TowerError('upstream', '저장소 서버에 연결하지 못했습니다. 이 컴퓨터의 네트워크를 확인한 뒤 다시 시도하세요.');
  }
  return new TowerError('upstream', '저장소를 받지 못했습니다. 주소와 이 컴퓨터의 네트워크를 확인한 뒤 다시 시도하세요.');
}

/**
 * A folder for a repository under `~/Workspace`, named after it. A folder there that already is a clone of the same
 * repository is used as it is; a name taken by anything else moves on to `<name>-2`, `<name>-3` …. Git never prompts
 * here (gitRunner): a repository that needs a sign-in fails with what to do. One clone at a time.
 */
export function cloneRepository(url: unknown, options: { workspace?: string; git?: GitRunner; timeoutMs?: number } = {}): Promise<ClonedFolder> {
  const text = typeof url === 'string' ? url.trim() : '';
  const remoteUrl = text.length <= 2048 && cloneable(text) ? normalizeRemoteUrl(text) : undefined;
  if (!remoteUrl) return Promise.reject(new TowerError('invalid', INVALID));
  const git = options.git ?? gitRunner();
  // best-effort: a clone that failed was answered to its own caller; the next one starts regardless.
  const run = queue.catch(() => {}).then(async () => {
    const workspace = options.workspace ?? await workspaceFolder();
    await mkdir(workspace, { recursive: true });
    const name = remoteUrl.split('/').at(-1)!.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '') || 'repository';
    for (let index = 1; index <= MAX_FOLDERS; index++) {
      const target = join(workspace, index === 1 ? name : `${name}-${index}`);
      // The folder is taken for this clone in one step: one that exists, made by anyone at any moment, is never used.
      try { await mkdir(target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await lstat(target);
        // best-effort: a folder without a readable .git is no clone to use.
        const repository = existing.isDirectory() && !existing.isSymbolicLink() && (await lstat(join(target, '.git')).then(() => true, () => false));
        if (repository && await remoteUrlOf(target, git) === remoteUrl) return { cwd: await realpath(target), remoteUrl, cloned: false };
        continue;
      }
      try { await git(workspace, ['clone', '--', text, target], options.timeoutMs ?? CLONE_MS); }
      catch (error) {
        // This clone made the folder, empty, a moment ago: what it holds now is what the failed clone left.
        await rm(target, { recursive: true, force: true });
        throw cloneFailure(error);
      }
      return { cwd: await realpath(target), remoteUrl, cloned: true };
    }
    throw new TowerError('conflict', `${workspace}에 ${name} 이름의 폴더가 너무 많아 새 폴더를 만들지 못했습니다.`);
  });
  // best-effort: the failure is this caller's, answered through `run`.
  queue = run.catch(() => {});
  return run;
}

/**
 * What the followed Tower asks for with "저장소에서 새 폴더" (`{ url }`): the repository cloned here, its folder made a
 * project folder (`register`), and where it is, answered as `{ cwd, remoteUrl }`.
 */
export function cloneAction(options: { register(cwd: string): Promise<void>; workspace?: string; git?: GitRunner }) {
  return async (body: Record<string, unknown>): Promise<{ cwd: string; remoteUrl: string }> => {
    if (Object.keys(body).some(key => key !== 'url')) throw new TowerError('invalid', INVALID);
    const folder = await cloneRepository(body.url, options);
    await options.register(folder.cwd);
    return { cwd: folder.cwd, remoteUrl: folder.remoteUrl };
  };
}

/** The Workspace folder made a project folder (`register`), for a terminal there: `{ cwd }`. */
export function workspaceAction(options: { register(cwd: string): Promise<void>; home?: string }) {
  return async (body: Record<string, unknown>): Promise<{ cwd: string }> => {
    if (Object.keys(body).length) throw new TowerError('invalid', '요청 본문은 비워 두세요.');
    const cwd = await workspaceFolder(options.home);
    await options.register(cwd);
    return { cwd };
  };
}
