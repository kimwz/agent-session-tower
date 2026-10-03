import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

/** An owner-only file in the state directory, as it is on disk: no symlink follow, at most `maxBytes`. */
export async function readPrivateBytes(path: string, maxBytes = 12_000_000): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error(`Saved state in ${path} is invalid or too large.`);
    await file.chmod(0o600);
    return await file.readFile();
  } finally { await file.close(); }
}

/** Owner-only JSON documents in the state directory: no symlink follow, no partial file after a crash. */
export async function readPrivateJson(path: string, maxBytes = 12_000_000): Promise<unknown> {
  return JSON.parse((await readPrivateBytes(path, maxBytes)).toString('utf8'));
}

/**
 * Sets a state file this build cannot read aside for inspection instead of replacing it, and answers where it went.
 * A failed move (ENOENT included) is thrown; each caller logs in its own words.
 */
export async function quarantineFile(path: string): Promise<string> {
  const aside = `${path}.unreadable-${Date.now()}`;
  await rename(path, aside);
  return aside;
}

/**
 * Replaces an owner-only file whole: a new 0600 temporary file (never an existing one or a symlink), synced, then
 * renamed over `path` (a symlink there is replaced, not followed). With `syncDirectory` the folder is synced as well
 * before this returns, so the new name survives a crash too. On failure the temporary file is removed and the
 * original error is thrown.
 */
export async function writePrivateJson(path: string, data: string | Uint8Array, options: { syncDirectory?: boolean } = {}): Promise<void> {
  const temporary = `${path}.${process.pid}.${createHash('sha256').update(randomUUID()).digest('hex').slice(0, 12)}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(data); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    if (options.syncDirectory) {
      const directory = await open(dirname(path), constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

/** Any owner-only text file in the state directory, written the same safe way. */
export const writePrivateFile = writePrivateJson;
