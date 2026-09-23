import type { Snapshot } from '../../shared/types.js';
import { diffSnapshots, indexSnapshot, type SnapshotIndex, type SnapshotPatch } from '../../shared/snapshot-patch.js';
import type { SseClient } from './sse-client.js';

interface Published { sequence: number; snapshot: Snapshot; index: SnapshotIndex; frame?: string }

/**
 * Numbers every published snapshot and sends each browser only real changes: nothing when the
 * content is unchanged, a patch to browsers that asked for patches, a complete snapshot otherwise.
 * Every connected browser has received the snapshot numbered `current.sequence`, so a patch
 * always applies to the base it names.
 */
export class SnapshotStream {
  private sequence = 0;
  private current?: Published;
  private readonly subscribers = new Map<SseClient, { patches: boolean }>();

  constructor(private readonly read: () => Snapshot) {}

  get size(): number { return this.subscribers.size; }

  publish(): void {
    if (!this.subscribers.size) { this.current = undefined; return; }
    const snapshot = this.read();
    const index = indexSnapshot(snapshot);
    const previous = this.current;
    const changes = previous && diffSnapshots(previous.index, snapshot, index);
    if (previous && !changes) return;
    const current = this.current = { sequence: ++this.sequence, snapshot, index };
    const patch = changes && `id: ${current.sequence}\nevent: patch\ndata: ${JSON.stringify({ base: previous.sequence, ...changes } satisfies SnapshotPatch)}\n\n`;
    const complete = () => completeFrame(current);
    for (const [client, subscriber] of this.subscribers) client.update(subscriber.patches ? patch : undefined, complete);
  }

  /** Existing browsers receive pending changes first, so they share the new browser's base. */
  attach(client: SseClient, patches: boolean, prefix = ''): void {
    this.publish();
    if (!this.current) {
      const snapshot = this.read();
      this.current = { sequence: ++this.sequence, snapshot, index: indexSnapshot(snapshot) };
    }
    this.subscribers.set(client, { patches });
    client.snapshot(`${prefix}${completeFrame(this.current)}`);
  }

  detach(client: SseClient): void {
    this.subscribers.delete(client);
    if (!this.subscribers.size) this.current = undefined;
  }

  close(): void {
    const clients = [...this.subscribers.keys()];
    this.subscribers.clear();
    this.current = undefined;
    for (const client of clients) client.end();
  }
}

function completeFrame(published: Published): string {
  return published.frame ??= `id: ${published.sequence}\nevent: snapshot\ndata: ${JSON.stringify(published.snapshot)}\n\n`;
}
