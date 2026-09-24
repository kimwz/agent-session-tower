import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

/** Owner-only JSON documents in the state directory: no symlink follow, no partial file after a crash. */
export async function readPrivateJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 12_000_000) throw new Error(`Saved state in ${path} is invalid or too large.`);
    await file.chmod(0o600);
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}

export async function writePrivateJson(path: string, data: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${createHash('sha256').update(randomUUID()).digest('hex').slice(0, 12)}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(data); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
