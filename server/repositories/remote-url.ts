import { gitRunner, type GitRunner } from './git.js';

/**
 * One name for a repository wherever it is cloned: `host/owner/repo`, the host in lower case, without scheme, user,
 * default port or `.git`. `git@github.com:kimwz/x.git`, `https://github.com/kimwz/x` and `ssh://git@github.com/kimwz/x.git`
 * are the same. A port other than its scheme's default stays (`host:2222/owner/repo`): another port of the same host can
 * serve other repositories. Anything that does not look like a repository address gives undefined.
 */
export function normalizeRemoteUrl(url: string): string | undefined {
  const text = url.trim();
  if (!text || text.length > 2048) return undefined;
  let host: string, path: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(text);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      const parsed = new URL(text);
      if (parsed.protocol === 'file:') return undefined;
      // `URL` leaves out a scheme's default port already (https 443, http 80); ssh's is 22.
      host = parsed.port && !(parsed.protocol === 'ssh:' && parsed.port === '22') ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
      path = decodeURIComponent(parsed.pathname);
    } catch { return undefined; } // best-effort: an address that does not parse names no repository.
  } else if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else return undefined;
  const parts = path.replace(/\.git\/?$/i, '').split('/').filter(Boolean);
  if (!host || parts.length < 2 || parts.some(part => part === '.' || part === '..')) return undefined;
  return [host.toLowerCase(), ...parts].join('/');
}

/** The normalized address of a folder's `origin` remote, or undefined when it has none or git cannot tell. */
export async function remoteUrlOf(cwd: string, git: GitRunner = gitRunner()): Promise<string | undefined> {
  // best-effort: a folder that is not a repository, or has no origin, has no address.
  const url = await git(cwd, ['config', '--get', 'remote.origin.url'], 5000).catch(() => '');
  return normalizeRemoteUrl(url);
}
