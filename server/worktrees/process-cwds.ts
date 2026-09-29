import { execFile } from 'node:child_process';
import { readdir, readlink } from 'node:fs/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** `lsof -F n` output: every `n` line is a process's current folder. */
export function parseCwdList(output: string): string[] {
  return output.split('\n').filter(line => line.startsWith('n/')).map(line => line.slice(1));
}

/**
 * The current folder of every process this account can see. Undefined when they cannot be read at all: a worktree is then
 * never removed, because a shell or server may be working in it.
 */
export async function processCwds(): Promise<string[] | undefined> {
  if (process.platform === 'linux') {
    try {
      const pids = (await readdir('/proc')).filter(name => /^\d+$/.test(name));
      const cwds = await Promise.all(pids.map(pid => readlink(`/proc/${pid}/cwd`).catch(() => undefined)));
      return cwds.filter((cwd): cwd is string => Boolean(cwd));
    } catch { /* Fall back to lsof. */ }
  }
  try {
    const { stdout } = await execute(process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof', ['-nP', '-a', '-d', 'cwd', '-F', 'n'], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
    return parseCwdList(stdout);
  } catch (error) {
    // lsof exits 1 when some processes could not be inspected yet lists the rest. Stopped by the timeout or the output
    // limit, what it printed is only part of the list: then nothing is known.
    const failed = error as { stdout?: unknown; code?: unknown; killed?: boolean; signal?: unknown };
    return failed.code === 1 && !failed.killed && !failed.signal && typeof failed.stdout === 'string' && failed.stdout.includes('\nn/') ? parseCwdList(failed.stdout) : undefined;
  }
}

export interface ProgramLine { args: string; cwd?: string }

/** The command line of every process this account can see, with its current folder when known; undefined when not listed. */
export async function processCommands(): Promise<ProgramLine[] | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await execute(process.platform === 'darwin' ? '/bin/ps' : 'ps', ['-axww', '-o', 'pid=,args='], { timeout: 10_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }));
  } catch { return undefined; }
  const cwds = await processCwdsByPid();
  return stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match ? [{ args: match[2]!, ...(cwds.get(Number(match[1])) ? { cwd: cwds.get(Number(match[1]))! } : {}) }] : [];
  });
}

async function processCwdsByPid(): Promise<Map<number, string>> {
  const cwds = new Map<number, string>();
  try {
    const { stdout } = await execute(process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof', ['-nP', '-a', '-d', 'cwd', '-F', 'pn'], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 })
      .catch(error => ({ stdout: typeof (error as { stdout?: unknown }).stdout === 'string' ? (error as { stdout: string }).stdout : '' }));
    let pid = 0;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1)) || 0;
      else if (line.startsWith('n/') && pid) cwds.set(pid, line.slice(1));
    }
  } catch { /* Without folders, relative arguments are only matched by name. */ }
  return cwds;
}

/** Whether a command line names this folder as a path segment (`--directory ../preview`, `/w/preview/server.js`). */
export function namesFolder(command: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s/="'])${escaped}(?:$|[\\s/"'])`).test(command);
}

/** Arguments of a command line that may be paths (`/abs`, `../x`, `current`, `--opt=/abs`), resolved against the program's folder. */
export function pathArguments(line: ProgramLine): string[] {
  const paths: string[] = [];
  for (const token of line.args.split(/\s+/)) {
    const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : token;
    const bare = value.replace(/^['"]|['"]$/g, '');
    if (bare.startsWith('/')) paths.push(bare);
    // Any other word may name a folder (or a symlink to one) in the program's folder: `--directory current`.
    else if (line.cwd && bare && !bare.startsWith('-') && !bare.includes('://')) paths.push(`${line.cwd}/${bare}`);
  }
  return paths;
}
