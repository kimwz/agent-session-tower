import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

/** How to start the next execution worker. The web process names its own, newer build. */
export interface SuccessorCommand { execPath: string; args: string[] }

/** Written by a worker that stopped on its own after handing off; a web reattaches only with this proof. */
export interface HandoffRecord { previous: string; successor: string; version: string; clean: true; at: string }

export function handoffPath(runtime: string): string { return join(runtime, 'handoff.json'); }

export function parseSuccessor(value: unknown, stateDir: string): SuccessorCommand {
  const input = value && typeof value === 'object' ? value as Partial<SuccessorCommand> : {};
  const args = Array.isArray(input.args) ? input.args : [];
  const worker = args.indexOf('--runner-worker');
  if (typeof input.execPath !== 'string' || !isAbsolute(input.execPath) || input.execPath.includes('\0')
    || args.length > 64 || args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))
    || worker === -1 || args[worker + 1] !== stateDir || worker + 2 !== args.length) {
    throw Object.assign(new Error('Invalid successor worker command.'), { statusCode: 400 });
  }
  return { execPath: input.execPath, args: [...args] };
}

export async function writeHandoff(runtime: string, record: HandoffRecord): Promise<void> {
  const path = handoffPath(runtime);
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

export async function readHandoff(runtime: string): Promise<HandoffRecord | undefined> {
  let file;
  try { file = await open(handoffPath(runtime), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { return undefined; }
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid()) || info.size > 4096) return undefined;
    const value = JSON.parse(await file.readFile('utf8')) as Partial<HandoffRecord>;
    return typeof value.previous === 'string' && typeof value.successor === 'string' && value.clean === true && typeof value.version === 'string' && typeof value.at === 'string' ? value as HandoffRecord : undefined;
  } catch { return undefined; } finally { await file.close(); }
}

/** The nonce lets the web tell this successor apart from any other worker that might start instead. */
export function spawnSuccessor(command: SuccessorCommand, nonce: string): void {
  const child = spawn(command.execPath, command.args, { detached: true, stdio: 'ignore', env: { ...process.env, TOWER_HANDOFF: nonce } });
  child.on('error', error => { console.error('Could not start the successor execution worker:', error); });
  child.unref();
}
