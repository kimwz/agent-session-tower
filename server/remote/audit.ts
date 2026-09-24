import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RemoteChange } from '../../shared/link.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { linkDirectory } from '../link/identity.js';

/** How many changes are kept; the oldest go first. */
const MAX_CHANGES = 1000;

/**
 * What controlling computers changed on this computer, for its owner to read here: which computer, what kind of
 * change, and what it touched. Never the content of a file, a message or a secret.
 */
export class RemoteAudit {
  private changes: RemoteChange[] = [];
  private readonly path: string;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(stateDir: string, private readonly now: () => number = Date.now) {
    this.path = join(linkDirectory(stateDir), 'remote-changes.json');
  }

  async start(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const saved = await readPrivateJson(this.path).catch(() => undefined);
    // A list that cannot be read starts over; it is a record for reading, not state anything depends on.
    this.changes = Array.isArray(saved) ? (saved as RemoteChange[]).filter(item => item && typeof item.at === 'string' && typeof item.controllerId === 'string' && typeof item.action === 'string').slice(-MAX_CHANGES) : [];
  }

  record(change: Omit<RemoteChange, 'at'>): void {
    this.changes = [...this.changes, { at: new Date(this.now()).toISOString(), ...change }].slice(-MAX_CHANGES);
    const data = JSON.stringify(this.changes);
    this.writes = this.writes.then(() => writePrivateJson(this.path, data)).catch(error => console.error(`Remote changes were not saved: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** Newest first. */
  list(limit = 200): RemoteChange[] { return this.changes.slice(-limit).reverse(); }
  /** The latest computer that started controlling this one. */
  lastJoin(): RemoteChange | undefined { return [...this.changes].reverse().find(change => change.action === 'joined'); }

  flush(): Promise<void> { return this.writes.then(() => {}); }
}
