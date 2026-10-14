import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { CONTROLLER_ID } from '../runs/origin.js';
import { linkDirectory } from './identity.js';

/**
 * The controlling Tower this computer follows: its settings are applied here and the work it starts here is treated
 * as the owner's own (see `followedHostOrigin`). At most one at a time. The web writes it when a controller asks;
 * the worker reads it again before each decision that depends on it.
 */
export class FollowedHostStore extends EventEmitter {
  private current?: string;
  private readonly path: string;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(stateDir: string) {
    super();
    this.path = join(linkDirectory(stateDir), 'followed-host.json');
  }

  async start(): Promise<void> { await this.reload(); }

  /** Reads the file again; anything unreadable follows nobody, so nothing is treated as the owner's by mistake. */
  async reload(): Promise<string | undefined> {
    let next: string | undefined;
    try {
      const saved = await readPrivateJson(this.path, 4096) as { hostId?: unknown } | null;
      next = typeof saved?.hostId === 'string' && CONTROLLER_ID.test(saved.hostId) ? saved.hostId : undefined;
    } catch { next = undefined; }
    if (next !== this.current) { this.current = next; this.emit('change', next); }
    return next;
  }

  hostId(): string | undefined { return this.current; }

  async set(hostId: string | undefined): Promise<void> {
    if (hostId !== undefined && !CONTROLLER_ID.test(hostId)) throw new Error('Invalid controller id.');
    const data = JSON.stringify(hostId ? { hostId, changedAt: new Date().toISOString() } : {});
    const write = this.writes.then(async () => { await mkdir(dirname(this.path), { recursive: true, mode: 0o700 }); await writePrivateJson(this.path, data); });
    this.writes = write.catch(() => {});
    await write;
    if (hostId !== this.current) { this.current = hostId; this.emit('change', hostId); }
  }
}
