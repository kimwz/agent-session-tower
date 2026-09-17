import { randomUUID } from 'node:crypto';
import { chmod, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Provider } from '../../shared/types.js';

type RecordValue = Record<string, unknown>;

async function replace(path: string, content: string): Promise<void> {
  const mode = await stat(path).then(info => info.mode & 0o777, () => 0o600);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode, flag: 'wx' });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

async function trustClaude(paths: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const file = join(env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json');
  let config: RecordValue = {};
  try {
    // An unreadable or malformed file is left to the CLI; it is never replaced.
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    config = parsed as RecordValue;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return; }
  if (config.projects !== undefined && (!config.projects || typeof config.projects !== 'object' || Array.isArray(config.projects))) return;
  const projects = (config.projects ??= {}) as RecordValue;
  let changed = false;
  for (const path of paths) {
    const project = projects[path];
    if (project !== undefined && (!project || typeof project !== 'object' || Array.isArray(project))) continue;
    if ((project as RecordValue | undefined)?.hasTrustDialogAccepted === true) continue;
    projects[path] = { ...(project as RecordValue | undefined), hasTrustDialogAccepted: true };
    changed = true;
  }
  if (changed) await replace(file, `${JSON.stringify(config, null, 2)}\n`);
}

async function trustCodex(paths: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const file = join(env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
  let config = '';
  try { config = await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return; }
  // A table header cannot be appended to an inline `projects = { … }` table.
  if (/^\s*projects\s*=/m.test(config)) return;
  // An existing entry, including an explicit "untrusted", is the user's choice.
  const headers = paths.map(path => `[projects.${JSON.stringify(path)}]`).filter(header => !config.includes(header));
  if (!headers.length) return;
  const separator = !config ? '' : config.endsWith('\n') ? '\n' : '\n\n';
  await replace(file, `${config}${separator}${headers.map(header => `${header}\ntrust_level = "trusted"\n`).join('\n')}`);
}

/** Pre-accepts the native CLI's folder trust prompt for a folder the user chose in Tower. */
export async function trustWorkspace(provider: Provider, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // The CLIs key trust by the resolved path (/tmp → /private/tmp on macOS).
  const paths = [...new Set([cwd, await realpath(cwd).catch(() => cwd)])];
  await (provider === 'claude' ? trustClaude(paths, env) : trustCodex(paths, env));
}
