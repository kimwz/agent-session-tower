import { mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RemoteChange } from '../../shared/link.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { linkDirectory } from '../link/identity.js';
import { REMOTE_REQUEST_RETENTION_MS } from './request-ledger.js';

/** How many changes are kept; the oldest go first. */
const MAX_CHANGES = 1000;
/** Requests are remembered as long as, and as many as, the request ledger answers them again. */
const MAX_REQUESTS = 20_000;
type Saved = RemoteChange;
const valid = (item: unknown): item is Saved => {
  const change = item as Partial<Saved> | null;
  return Boolean(change) && typeof change!.at === 'string' && typeof change!.controllerId === 'string' && typeof change!.action === 'string';
};
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * What controlling computers changed on this computer, for its owner to read here: which computer, what kind of
 * change, and where. Never the content of a file, a message or a secret, nor a conversation's title (a first message).
 * It is a record for reading, not state anything depends on: when it cannot be saved or read, Tower goes on.
 */
export class RemoteAudit {
  private changes: Saved[] = [];
  /** Requests already recorded (controller and request) → when, so one sent again is recorded once. */
  private requests = new Map<string, number>();
  /** The latest computer that started controlling this one; kept apart so newer changes never push it out. */
  private joined?: RemoteChange;
  private unsaved = false;
  private readonly path: string;
  private writes: Promise<unknown> = Promise.resolve();

  /** `name` tells a controlling computer's name, kept with each change it makes. */
  constructor(stateDir: string, private readonly options: { now?: () => number; name?: (controllerId: string) => string | undefined } = {}) {
    this.path = join(linkDirectory(stateDir), 'remote-changes.json');
  }

  async start(): Promise<void> {
    try { await mkdir(dirname(this.path), { recursive: true, mode: 0o700 }); }
    catch (error) { this.unsaved = true; console.error(`Remote changes will not be saved: ${message(error)}`); return; }
    let saved: unknown;
    try { saved = await readPrivateJson(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      saved = undefined;
    }
    const value = saved as { changes?: unknown; joined?: unknown; requests?: unknown } | undefined;
    if (!value || !Array.isArray(value.changes)) {
      // Set aside rather than written over, so it can still be read.
      await rename(this.path, `${this.path}.unreadable`).then(() => console.error('The record of remote changes could not be read; it was kept as remote-changes.json.unreadable.'),
        error => console.error(`The record of remote changes could not be read: ${message(error)}`));
      return;
    }
    this.changes = value.changes.filter(valid).slice(-MAX_CHANGES);
    if (valid(value.joined)) this.joined = value.joined;
    if (Array.isArray(value.requests)) for (const entry of value.requests) if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'number') this.requests.set(entry[0], entry[1]);
  }

  /** Records a change a controlling computer made. The same `request` sent again is recorded once. */
  record(change: Omit<RemoteChange, 'at' | 'controller' | 'name'>, request?: string): void {
    const now = (this.options.now ?? Date.now)();
    for (const [key, at] of this.requests) { if (at >= now - REMOTE_REQUEST_RETENTION_MS && this.requests.size < MAX_REQUESTS) break; this.requests.delete(key); }
    const key = request && `${change.controllerId}\n${request}`;
    if (key && this.requests.has(key)) return;
    if (key) this.requests.set(key, now);
    const controller = this.options.name?.(change.controllerId);
    const entry: Saved = { at: new Date(now).toISOString(), ...change, ...(controller ? { controller } : {}) };
    this.changes = [...this.changes, entry].slice(-MAX_CHANGES);
    if (change.action === 'joined') this.joined = entry;
    if (this.unsaved) return;
    const data = JSON.stringify({ changes: this.changes, ...(this.joined ? { joined: this.joined } : {}), requests: [...this.requests] });
    this.writes = this.writes.then(() => writePrivateJson(this.path, data)).catch(error => console.error(`Remote changes were not saved: ${message(error)}`));
  }

  /** Newest first. */
  list(): RemoteChange[] { return [...this.changes].reverse(); }
  /** The latest computer that started controlling this one. */
  lastJoin(): RemoteChange | undefined { return this.joined; }

  flush(): Promise<void> { return this.writes.then(() => {}); }
}
