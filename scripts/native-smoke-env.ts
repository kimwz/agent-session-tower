import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const inside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};
const exists = async (path: string) => lstat(path).catch(error => {
  if (error.code === 'ENOENT') return undefined;
  throw error;
});
async function rejectStorageLinks(path: string): Promise<void> {
  const entry = await exists(path);
  if (!entry) return;
  if (entry.isSymbolicLink()) throw new Error(`Smoke-test session storage must not contain symbolic links: ${path}`);
  if (entry.isDirectory()) for (const name of await readdir(path)) await rejectStorageLinks(join(path, name));
}

/** Live smoke tests require a separately authenticated profile; never borrow normal session storage. */
export async function isolatedSmokeEnv(provider: 'codex' | 'claude', env: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const selector = provider === 'codex' ? 'TOWER_SMOKE_CODEX_HOME' : 'TOWER_SMOKE_CLAUDE_HOME';
  const variable = provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
  const configured = env[selector];
  if (!configured?.trim()) throw new Error(`Set ${selector} to a separately authenticated test home. Smoke tests must not use your normal ${provider} profile.`);
  const testHome = await realpath(resolve(configured));
  if (!(await stat(testHome)).isDirectory()) throw new Error(`${selector} must be a directory.`);
  const normalHomes = [join(homedir(), '.codex'), join(homedir(), '.claude'), env.CODEX_HOME, env.CLAUDE_CONFIG_DIR].filter((path): path is string => !!path);
  for (const path of normalHomes) {
    const normalHome = await realpath(path).catch(error => {
      if (error.code === 'ENOENT') return resolve(path);
      throw error;
    });
    if (inside(normalHome, testHome) || inside(testHome, normalHome)) throw new Error(`${selector} must be separate from your normal agent homes: ${normalHome}`);
  }
  const storage = provider === 'codex' ? ['sessions', 'archived_sessions', 'thread-writer-locks', 'app-server-control'] : ['projects', 'sessions'];
  for (const directory of storage) await rejectStorageLinks(join(testHome, directory));
  return { ...env, [variable]: testHome };
}
