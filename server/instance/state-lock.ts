import { mkdir, readdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

interface Owner { pid: number; port: number; createdAt: string }

export class MonitorAlreadyRunning extends Error {
  constructor(public readonly owner: Owner, stateDir: string) {
    super(`Agent Session Tower is already using ${stateDir} (PID ${owner.pid}). Open http://localhost:${owner.port || 8000}, or stop that process first.`);
  }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Publish a nonempty directory atomically. Every owner has a unique marker name:
 * stale cleanup can only unlink that old marker, never a replacement owner's marker.
 * Plain mkdir + owner.json has an empty-directory race while a new owner writes.
 */
export async function acquireStateLock(stateDir: string, port: number): Promise<() => Promise<void>> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lock = join(stateDir, '.instance-lock');
  const nonce = randomUUID();
  const marker = `owner-${nonce}.json`;
  const prepared = join(stateDir, `.instance-lock-${process.pid}-${nonce}`);
  await mkdir(prepared, { mode: 0o700 });
  await writeFile(join(prepared, marker), JSON.stringify({ pid: process.pid, port, createdAt: new Date().toISOString() } satisfies Owner), { mode: 0o600, flag: 'wx' });
  let acquired = false;
  try {
    for (let attempts = 0; attempts < 8; attempts++) {
      try {
        await rename(prepared, lock);
        acquired = true;
        break;
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
      }
      let names: string[];
      try { names = await readdir(lock); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const ownerFiles = names.filter((name) => /^owner-[\da-f-]{36}\.json$/.test(name));
      if (names.length !== ownerFiles.length) throw new Error(`Cannot verify the Agent Session Tower lock at ${lock}. Inspect it before removing it.`);
      for (const ownerFile of ownerFiles) {
        let owner: Owner;
        try { owner = JSON.parse(await readFile(join(lock, ownerFile), 'utf8')); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw new Error(`Cannot read the Agent Session Tower lock at ${lock}. Inspect it before removing it.`);
        }
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error(`Invalid Agent Session Tower owner at ${lock}. Inspect it before removing it.`);
        if (isAlive(owner.pid)) {
          throw new MonitorAlreadyRunning(owner, stateDir);
        }
        // Another process may already have removed this exact stale marker.
        await unlink(join(lock, ownerFile)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
      }
      await rmdir(lock).catch((error: NodeJS.ErrnoException) => {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code || '')) throw error;
      });
    }
    if (!acquired) throw new Error(`Another Agent Session Tower is starting with ${stateDir}. Retry in a moment.`);
  } finally {
    if (!acquired) {
      await unlink(join(prepared, marker)).catch(() => {});
      await rmdir(prepared).catch(() => {});
    }
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await unlink(join(lock, marker)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(lock).catch((error: NodeJS.ErrnoException) => {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code || '')) throw error;
    });
  };
}

/** Ports of the Tower web servers that hold this state directory right now. */
export async function lockedPorts(stateDir: string): Promise<number[]> {
  const lock = join(stateDir, '.instance-lock');
  const names = await readdir(lock).catch(() => [] as string[]);
  const ports: number[] = [];
  for (const name of names.filter(item => /^owner-[\da-f-]{36}\.json$/.test(item))) {
    const owner = await readFile(join(lock, name), 'utf8').then(text => JSON.parse(text) as Owner).catch(() => undefined);
    if (owner && Number.isInteger(owner.port) && owner.port > 0) ports.push(owner.port);
  }
  return ports;
}
