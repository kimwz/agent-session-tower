import { mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RemoteChange } from '../../shared/link.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { linkDirectory } from '../link/identity.js';

/** How many changes are kept; the oldest go first. */
const MAX_CHANGES = 1000;
/** A change as saved: with the request that made it, so the same request sent again is recorded once. */
type Saved = RemoteChange & { request?: string };
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
    const value = saved as { changes?: unknown; joined?: unknown } | undefined;
    if (!value || !Array.isArray(value.changes)) {
      // Set aside rather than written over, so it can still be read.
      await rename(this.path, `${this.path}.unreadable`).then(() => console.error('The record of remote changes could not be read; it was kept as remote-changes.json.unreadable.'),
        error => console.error(`The record of remote changes could not be read: ${message(error)}`));
      return;
    }
    this.changes = value.changes.filter(valid).slice(-MAX_CHANGES);
    if (valid(value.joined)) this.joined = value.joined;
  }

  /** Records a change a controlling computer made. The same `request` sent again is recorded once. */
  record(change: Omit<RemoteChange, 'at' | 'controller' | 'name'>, request?: string): void {
    if (request && this.changes.some(item => item.request === request && item.controllerId === change.controllerId)) return;
    const controller = this.options.name?.(change.controllerId);
    const entry: Saved = { at: new Date((this.options.now ?? Date.now)()).toISOString(), ...change, ...(controller ? { controller } : {}) };
    this.changes = [...this.changes, { ...entry, ...(request ? { request } : {}) }].slice(-MAX_CHANGES);
    if (change.action === 'joined') this.joined = entry;
    if (this.unsaved) return;
    const data = JSON.stringify({ changes: this.changes, ...(this.joined ? { joined: this.joined } : {}) });
    this.writes = this.writes.then(() => writePrivateJson(this.path, data)).catch(error => console.error(`Remote changes were not saved: ${message(error)}`));
  }

  /** Newest first. */
  list(): RemoteChange[] { return this.changes.map(({ request: _, ...change }) => change).reverse(); }
  /** The latest computer that started controlling this one. */
  lastJoin(): RemoteChange | undefined { return this.joined; }

  flush(): Promise<void> { return this.writes.then(() => {}); }
}
