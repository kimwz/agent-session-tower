import type { Snapshot } from '../../shared/types.js';
import type { SessionScope } from '../../shared/session-scope.js';
import { diffSnapshots, indexSnapshot, type SnapshotIndex, type SnapshotPatch } from '../../shared/snapshot-patch.js';
import type { SseClient } from './sse-client.js';

interface Published { sequence: number; snapshot: Snapshot; index: SnapshotIndex; frame?: string }
/** A scoped subscriber holds only its own view; the others share the complete one. */
interface Subscriber { patches: boolean; sentAt: number; scope?: SessionScope; published?: Published }
/** How frames of one stream are written; another computer's stream names itself in every frame. */
export interface FrameFormat {
  /** Streams sharing one browser connection keep separate pending snapshots. */
  key: string;
  snapshot(sequence: number, snapshot: Snapshot): string;
  patch(sequence: number, patch: SnapshotPatch): string;
}
/** Builds, from one complete snapshot, the view a scoped subscriber holds. */
export type ScopedView = (snapshot: Snapshot) => (scope: SessionScope) => Snapshot;
const OWN_FRAMES: FrameFormat = {
  key: '',
  snapshot: (sequence, snapshot) => `id: ${sequence}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
  patch: (sequence, patch) => `id: ${sequence}\nevent: patch\ndata: ${JSON.stringify(patch)}\n\n`,
};

/**
 * Numbers every published snapshot and sends each browser only real changes: nothing when the
 * content is unchanged, a patch to browsers that asked for patches, a complete snapshot otherwise.
 * Every unscoped subscriber has received the snapshot numbered `current.sequence`, and every scoped
 * one the snapshot numbered by its own `published`, so a patch always applies to the base it names.
 */
export class SnapshotStream {
  private sequence = 0;
  private current?: Published;
  private readonly subscribers = new Map<SseClient, Subscriber>();

  constructor(private readonly read: () => Snapshot, private readonly now: () => number = Date.now, private readonly format: FrameFormat = OWN_FRAMES,
    private readonly view?: ScopedView) {}

  get size(): number { return this.subscribers.size; }

  publish(): void {
    if (!this.subscribers.size) { this.current = undefined; return; }
    const snapshot = this.read();
    const subscribers = [...this.subscribers];
    // Items shared by the complete snapshot and its views are serialized once.
    const serialized = new WeakMap<object, string>();
    if (subscribers.some(([, subscriber]) => !subscriber.scope)) this.publishShared(snapshot, serialized, subscribers);
    else this.current = undefined;
    const views = this.view && subscribers.some(([, subscriber]) => subscriber.scope) ? this.view(snapshot) : undefined;
    const sentAt = this.now();
    for (const [client, subscriber] of subscribers) {
      if (subscriber.scope && views) this.sendView(client, subscriber, views(subscriber.scope), serialized, sentAt);
    }
  }

  /**
   * Pages that predate patches cannot correct an older HTTP snapshot that lands after a newer
   * event. They once relied on frequent identical snapshots for that; now they receive the
   * current snapshot again after `maxAgeMs` without any frame.
   */
  resendToCompletePages(maxAgeMs: number): void {
    const now = this.now();
    for (const [client, subscriber] of this.subscribers) {
      const published = subscriber.scope ? subscriber.published : this.current;
      if (!published || subscriber.patches || now - subscriber.sentAt < maxAgeMs) continue;
      client.update(undefined, () => this.completeFrame(published), this.format.key);
      subscriber.sentAt = now;
    }
  }

  /** Existing browsers receive pending changes first, so they share the new browser's base. A scoped browser starts its own view. */
  attach(client: SseClient, patches: boolean, prefix = '', scope?: SessionScope): void {
    if (scope && this.view) {
      const snapshot = this.view(this.read())(scope);
      const published = { sequence: ++this.sequence, snapshot, index: indexSnapshot(snapshot) };
      this.subscribers.set(client, { patches, sentAt: this.now(), scope, published });
      client.snapshot(`${prefix}${this.completeFrame(published)}`, this.format.key);
      return;
    }
    this.publish();
    if (!this.current) {
      const snapshot = this.read();
      this.current = { sequence: ++this.sequence, snapshot, index: indexSnapshot(snapshot) };
    }
    this.subscribers.set(client, { patches, sentAt: this.now() });
    client.snapshot(`${prefix}${this.completeFrame(this.current)}`, this.format.key);
  }

  /** A scoped browser now holds `scope` and receives the difference from what it held. False when it is not a scoped subscriber here. */
  setScope(client: SseClient, scope: SessionScope): boolean {
    const subscriber = this.subscribers.get(client);
    if (!subscriber?.scope || !this.view) return false;
    subscriber.scope = scope;
    this.sendView(client, subscriber, this.view(this.read())(scope), new WeakMap(), this.now());
    return true;
  }

  has(client: SseClient): boolean { return this.subscribers.has(client); }

  detach(client: SseClient): void {
    this.subscribers.delete(client);
    if (![...this.subscribers.values()].some(subscriber => !subscriber.scope)) this.current = undefined;
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

  private publishShared(snapshot: Snapshot, serialized: WeakMap<object, string>, subscribers: [SseClient, Subscriber][]): void {
    const index = indexSnapshot(snapshot, serialized);
    const previous = this.current;
    const changes = previous && diffSnapshots(previous.index, snapshot, index);
    if (previous && !changes) return;
    const current = this.current = { sequence: ++this.sequence, snapshot, index };
    const patch = changes && this.format.patch(current.sequence, { base: previous.sequence, ...changes } satisfies SnapshotPatch);
    const complete = () => this.completeFrame(current);
    const sentAt = this.now();
    for (const [client, subscriber] of subscribers) {
      if (subscriber.scope) continue;
      client.update(subscriber.patches ? patch : undefined, complete, this.format.key);
      subscriber.sentAt = sentAt;
    }
  }

  private sendView(client: SseClient, subscriber: Subscriber, snapshot: Snapshot, serialized: WeakMap<object, string>, sentAt: number): void {
    const index = indexSnapshot(snapshot, serialized);
    const previous = subscriber.published;
    const changes = previous && diffSnapshots(previous.index, snapshot, index);
    if (previous && !changes) return;
    const published = subscriber.published = { sequence: ++this.sequence, snapshot, index };
    const patch = changes && subscriber.patches ? this.format.patch(published.sequence, { base: previous.sequence, ...changes } satisfies SnapshotPatch) : undefined;
    client.update(patch, () => this.completeFrame(published), this.format.key);
    subscriber.sentAt = sentAt;
  }

  private completeFrame(published: Published): string {
    return published.frame ??= this.format.snapshot(published.sequence, published.snapshot);
  }
}
