import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * When a process started, as the system tells it. A pid taken by another process later, as happens after a restart,
 * starts at another time; undefined when the system cannot say.
 */
export async function processStart(pid: number): Promise<string | undefined> {
  if (process.platform === 'linux') {
    // Clock ticks since boot, after the command name (which may hold spaces or parentheses), within this boot.
    const [stat, boot] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8').catch(() => ''), readFile('/proc/sys/kernel/random/boot_id', 'utf8').catch(() => '')]);
    const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    // Both parts or nothing: a value missing one would not match the same process read again.
    return ticks && boot.trim() ? `${boot.trim()}:${ticks}` : undefined;
  }
  // Read the same way whatever language and time zone the reader runs with.
  try { return (await run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 5000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } })).stdout.trim() || undefined; } catch { return undefined; }
}
