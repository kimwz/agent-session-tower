import * as fs from 'node:fs/promises';

/** Older than this, a socket or credential is touched so age-based /tmp cleaners never take it for stale. */
const FRESH_MS = 60 * 60 * 1000;

/**
 * Keeps a local host's socket and credential usable for as long as it runs. Its files live in /tmp, where cleaners
 * delete old regular files: a host whose credential vanished still holds its lock, so no replacement can start and
 * its clients are locked out. A missing credential is written whole to a private file and linked into place, so a
 * client never reads it half-written and an existing one is never replaced; a missing socket is not recreated. Stopping waits for a check underway, so no late write lands after the host removed its files.
 */
export function keepEndpoint(files: { socket: string; token: string; value: string }, intervalMs = 5000, io: Pick<typeof fs, 'lstat' | 'utimes' | 'writeFile' | 'link' | 'unlink'> = fs): () => Promise<void> {
  let stopped = false;
  let checking: Promise<void> | undefined;
  const refresh = async (path: string) => {
    const info = await io.lstat(path);
    if (Date.now() - Math.min(info.atimeMs, info.mtimeMs) < FRESH_MS) return;
    const now = new Date();
    await io.utimes(path, now, now);
  };
  const check = async () => {
    await refresh(files.token).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' || stopped) return;
      const draft = `${files.token}.${process.pid}.draft`;
      try {
        await io.writeFile(draft, files.value, { flag: 'w', mode: 0o600 });
        await io.link(draft, files.token).catch(() => {});
      } catch { /* the next check tries again */ } finally { await io.unlink(draft).catch(() => {}); }
    });
    await refresh(files.socket).catch(() => {});
  };
  const timer = setInterval(() => {
    if (stopped || checking) return;
    checking = check().finally(() => { checking = undefined; });
  }, intervalMs);
  timer.unref();
  return async () => { stopped = true; clearInterval(timer); await checking; };
}
