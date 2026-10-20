import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findExecutable } from '../../providers/discovery.js';
import { GitHubAccess, readGhToken } from '../../triggers/github-access.js';
import { GitHubError, refused, type GitHubFetch } from '../../triggers/github.js';
import { RequestBudget } from '../../triggers/outbound.js';
import type { SecretStore } from '../../triggers/secrets.js';

/**
 * GitHub as the todo sync uses it: the gh CLI's login on this computer, requests only to api.github.com (the triggers'
 * GitHubAccess), and files uploaded with gh's own `--attach`.
 */
export interface TodoGitHub {
  /** The account gh is signed in as. */
  login(): Promise<string>;
  /** One REST call; a refusal comes back as a GitHubCallError, a used-up rate limit as a GitHubError. */
  call<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T>;
  /** Uploads a file into the issue's body (`gh issue edit <n> --attach`). */
  attach(repo: string, issue: number, path: string): Promise<void>;
}

/** GitHub answered a call with an error status. */
export class GitHubCallError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** gh learned `--attach` in this version. */
const ATTACH_SINCE = [2, 99, 0];

export function ghSupportsAttach(version: string): boolean {
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!found) return false;
  const parts = found.slice(1).map(Number);
  for (let i = 0; i < 3; i++) if (parts[i] !== ATTACH_SINCE[i]) return parts[i] > ATTACH_SINCE[i];
  return true;
}

const run = (file: string, args: string[], timeout: number) => new Promise<string>((resolve, reject) =>
  execFile(file, args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(String(stderr).trim() || error.message)) : resolve(String(stdout))));

/** Sync never reads saved tokens: it only ever uses gh. */
const NO_SECRETS = { get: () => undefined } as unknown as SecretStore;

export function ghTodoGitHub(options: { fetch?: (authorization: string) => GitHubFetch } = {}): TodoGitHub {
  const access = new GitHubAccess({ secrets: NO_SECRETS, budget: new RequestBudget(Date.now, () => 120), grants: () => ({}), now: Date.now, ghToken: readGhToken, transport: () => options.fetch });
  let gh: Promise<string> | undefined;
  const ghWithAttach = () => gh ??= (async () => {
    const path = await findExecutable('gh');
    if (!path) throw new Error('gh CLI를 찾을 수 없습니다.');
    if (!ghSupportsAttach(await run(path, ['--version'], 10_000))) throw new Error('첨부를 올리려면 gh 2.99 이상이 필요합니다. gh를 업데이트하세요.');
    return path;
  })().catch(error => { gh = undefined; throw error; });
  return {
    async login() {
      const { fetch, identity } = await access.fetchFor({ type: 'gh' });
      return access.login(fetch, identity);
    },
    async call<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) {
      const { fetch } = await access.fetchFor({ type: 'gh' });
      const response = await fetch(path, undefined, method === 'GET' ? undefined : { method, body });
      refused(response);
      if (response.status >= 400) {
        const message = response.body && typeof response.body === 'object' ? String((response.body as { message?: unknown }).message ?? '') : '';
        // A secondary limit is a 403 or 429 with GitHub's words for it; the pass stops as for any used-up limit.
        if (response.status === 429 || /rate limit|too quickly/i.test(message)) throw new GitHubError(`GitHub 요청 한도에 걸렸습니다: ${message || response.status}`);
        throw new GitHubCallError(response.status, `GitHub ${method} ${path.split('?')[0]}: HTTP ${response.status}${message ? ` ${message}` : ''}`);
      }
      return response.body as T;
    },
    async attach(repo, issue, path) {
      const gh = await ghWithAttach();
      await run(gh, ['issue', 'edit', String(issue), '-R', repo, '--attach', path], 180_000);
    },
  };
}

/**
 * Copies an attachment to a name gh reads plainly (`<id>.<ext>`: `--attach` takes what follows `#` as alt text), runs
 * `upload` on it, and removes the copy.
 */
export async function withUploadCopy<T>(source: string, fileId: string, ext: string, upload: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'tower-gh-attach-'));
  try {
    const path = join(dir, `${fileId}.${ext}`);
    await copyFile(source, path);
    return await upload(path);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
