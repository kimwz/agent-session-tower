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
    // lsof exits 1 when some processes could not be inspected yet still lists the rest.
    const stdout = (error as { stdout?: unknown }).stdout;
    return typeof stdout === 'string' && stdout.includes('\nn/') ? parseCwdList(stdout) : undefined;
  }
}
