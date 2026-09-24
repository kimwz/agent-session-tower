import type { Snapshot } from '../../shared/types.js';
import { diffSnapshots, indexSnapshot, type SnapshotIndex, type SnapshotPatch } from '../../shared/snapshot-patch.js';
import type { SseClient } from './sse-client.js';

interface Published { sequence: number; snapshot: Snapshot; index: SnapshotIndex; frame?: string }
interface Subscriber { patches: boolean; sentAt: number }
/** How frames of one stream are written; another computer's stream names itself in every frame. */
export interface FrameFormat {
  /** Streams sharing one browser connection keep separate pending snapshots. */
  key: string;
  snapshot(sequence: number, snapshot: Snapshot): string;
  patch(sequence: number, patch: SnapshotPatch): string;
}
const OWN_FRAMES: FrameFormat = {
  key: '',
  snapshot: (sequence, snapshot) => `id: ${sequence}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
  patch: (sequence, patch) => `id: ${sequence}\nevent: patch\ndata: ${JSON.stringify(patch)}\n\n`,
};

/**
 * Numbers every published snapshot and sends each browser only real changes: nothing when the
 * content is unchanged, a patch to browsers that asked for patches, a complete snapshot otherwise.
 * Every connected browser has received the snapshot numbered `current.sequence`, so a patch
 * always applies to the base it names.
 */
export class SnapshotStream {
  private sequence = 0;
  private current?: Published;
  private readonly subscribers = new Map<SseClient, Subscriber>();

  constructor(private readonly read: () => Snapshot, private readonly now: () => number = Date.now, private readonly format: FrameFormat = OWN_FRAMES) {}

  get size(): number { return this.subscribers.size; }

  publish(): void {
    if (!this.subscribers.size) { this.current = undefined; return; }
    const snapshot = this.read();
    const index = indexSnapshot(snapshot);
    const previous = this.current;
    const changes = previous && diffSnapshots(previous.index, snapshot, index);
    if (previous && !changes) return;
    const current = this.current = { sequence: ++this.sequence, snapshot, index };
    const patch = changes && this.format.patch(current.sequence, { base: previous.sequence, ...changes } satisfies SnapshotPatch);
    const complete = () => this.completeFrame(current);
    const sentAt = this.now();
    for (const [client, subscriber] of this.subscribers) {
      client.update(subscriber.patches ? patch : undefined, complete, this.format.key);
      subscriber.sentAt = sentAt;
    }
  }

  /**
   * Pages that predate patches cannot correct an older HTTP snapshot that lands after a newer
   * event. They once relied on frequent identical snapshots for that; now they receive the
   * current snapshot again after `maxAgeMs` without any frame.
   */
  resendToCompletePages(maxAgeMs: number): void {
    const current = this.current;
    if (!current) return;
    const now = this.now();
    for (const [client, subscriber] of this.subscribers) {
      if (subscriber.patches || now - subscriber.sentAt < maxAgeMs) continue;
      client.update(undefined, () => this.completeFrame(current), this.format.key);
      subscriber.sentAt = now;
    }
  }

  /** Existing browsers receive pending changes first, so they share the new browser's base. */
  attach(client: SseClient, patches: boolean, prefix = ''): void {
    this.publish();
    if (!this.current) {
      const snapshot = this.read();
      this.current = { sequence: ++this.sequence, snapshot, index: indexSnapshot(snapshot) };
    }
    this.subscribers.set(client, { patches, sentAt: this.now() });
    client.snapshot(`${prefix}${this.completeFrame(this.current)}`, this.format.key);
  }

  has(client: SseClient): boolean { return this.subscribers.has(client); }

  detach(client: SseClient): void {
    this.subscribers.delete(client);
    if (!this.subscribers.size) this.current = undefined;
  }

  close(): void {
    const clients = [...this.subscribers.keys()];
    this.release();
    for (const client of clients) client.end();
  }

  /** Stops sending without ending the browsers' connections, which may carry other streams. */
  release(): void {
    this.subscribers.clear();
    this.current = undefined;
  }

  private completeFrame(published: Published): string {
    return published.frame ??= this.format.snapshot(published.sequence, published.snapshot);
  }
}
