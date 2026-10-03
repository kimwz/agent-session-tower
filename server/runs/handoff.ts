import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { writePrivateJson } from '../stores/private-json.js';
import { TowerError } from '../../shared/errors.js';

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
    throw new TowerError('invalid', 'Invalid successor worker command.');
  }
  return { execPath: input.execPath, args: [...args] };
}

/** Flushed to disk before the successor is started; a stale temporary file is never written through. */
export async function writeHandoff(runtime: string, record: HandoffRecord): Promise<void> {
  await writePrivateJson(handoffPath(runtime), JSON.stringify(record));
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

/** Largest state a worker hands to its successor over stdin. */
const MAX_CARRY = 4096;

/**
 * The nonce lets the web tell this successor apart from any other worker that might start instead. `carry` is state that
 * must not touch disk, argv or the environment (the open vault key): only the successor can read its stdin pipe.
 */
export function spawnSuccessor(command: SuccessorCommand, nonce: string, carry?: Buffer): void {
  const child = spawn(command.execPath, command.args, { detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, TOWER_HANDOFF: nonce } });
  child.on('error', error => { console.error('Could not start the successor execution worker:', error); });
  child.stdin?.on('error', () => { console.error('The successor execution worker did not take the handed-over state; it starts without it.'); });
  if (carry?.length && carry.length <= MAX_CARRY) child.stdin?.end(carry, () => { carry.fill(0); });
  else { carry?.fill(0); child.stdin?.end(); }
  child.unref();
}

/** What the predecessor handed over on stdin; undefined when it sent nothing (an older build) or did not finish in time. */
export function readHandoffCarry(stream: NodeJS.ReadableStream & { destroy(): void }, timeoutMs = 10_000): Promise<Buffer | undefined> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []; let size = 0; let done = false;
    const finish = (value: Buffer | undefined, problem?: string) => {
      if (done) return; done = true; clearTimeout(timer);
      stream.removeAllListeners('data'); stream.removeAllListeners('end'); stream.removeAllListeners('error'); stream.destroy();
      if (problem) console.error(`The predecessor's handed-over state was not taken: ${problem}.`);
      if (!value) for (const chunk of chunks) chunk.fill(0);
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined, 'it did not arrive in time'), timeoutMs);
    stream.on('data', (chunk: Buffer) => { size += chunk.length; chunks.push(chunk); if (size > MAX_CARRY) finish(undefined, 'it is too large'); });
    stream.on('end', () => { const value = size ? Buffer.concat(chunks) : undefined; for (const chunk of chunks) chunk.fill(0); finish(value); });
    stream.on('error', () => finish(undefined, 'stdin could not be read'));
  });
}
