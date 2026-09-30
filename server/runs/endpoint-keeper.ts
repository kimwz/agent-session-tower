import { lstat, utimes, writeFile } from 'node:fs/promises';

/** Older than this, a socket or credential is touched so age-based /tmp cleaners never take it for stale. */
const FRESH_MS = 60 * 60 * 1000;

/**
 * Keeps a local host's socket and credential usable for as long as it runs. Its files live in /tmp, where cleaners
 * delete old regular files: a host whose credential vanished still holds its lock, so no replacement can start and
 * its clients are locked out. A missing credential is written again (never over an existing one); a missing socket
 * is not recreated.
 */
export function keepEndpoint(files: { socket: string; token: string; value: string }, intervalMs = 5000): () => void {
  let stopped = false;
  let checking = false;
  const refresh = async (path: string) => {
    const info = await lstat(path);
    if (Date.now() - Math.min(info.atimeMs, info.mtimeMs) < FRESH_MS) return;
    const now = new Date();
    await utimes(path, now, now);
  };
  const check = async () => {
    if (stopped || checking) return;
    checking = true;
    try {
      await refresh(files.token).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT' || stopped) return;
        await writeFile(files.token, files.value, { flag: 'wx', mode: 0o600 }).catch(() => {});
      });
      await refresh(files.socket).catch(() => {});
    } finally { checking = false; }
  };
  const timer = setInterval(() => { void check(); }, intervalMs);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
