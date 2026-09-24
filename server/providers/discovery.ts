import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { Provider, ProviderHealth } from '../../shared/types.js';

export const PROVIDERS: Provider[] = ['claude', 'codex'];

/** Resolve executables without invoking a shell or evaluating shell startup files. */
export function providerDirectories(env: NodeJS.ProcessEnv): string[] {
  // Finder starts programs with a minimal PATH. Use the same safe lookup for the
  // CLI and its interpreters/tools; empty or relative entries would search its cwd.
  return [...new Set([...(env.PATH ?? '').split(delimiter), join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'])]
    .filter(directory => directory && isAbsolute(directory));
}

export async function findExecutable(name: Provider | 'gh' | 'git',env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  for (const directory of providerDirectories(env)) {
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { /* Try the next installed location. */ }
  }
  return undefined;
}

export async function getProviderHealth(counts: Partial<Record<Provider, number>> = {}): Promise<ProviderHealth[]> {
  return Promise.all(PROVIDERS.map(async (provider) => {
    const executable = await findExecutable(provider);
    return { provider, available: Boolean(executable), executable, sessionCount: counts[provider] ?? 0,
      ...(!executable ? { error: `${provider === 'claude' ? 'Claude Code' : 'Codex'} CLI was not found in PATH.` } : {}) };
  }));
}
