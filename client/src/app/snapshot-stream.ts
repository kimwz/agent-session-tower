import type { Snapshot } from '../../../shared/types';
import { applySnapshotPatch, type SnapshotPatch } from '../../../shared/snapshot-patch';

/** How long a write from outside the event stream may stand without a confirming stream frame. */
export const RECONCILE_MS = 3000;
/** Minimum spacing between reconnects that recover a stream from a patch it could not apply. */
export const RESYNC_MS = 1000;

type Show = (update: Snapshot | ((current: Snapshot | null) => Snapshot | null)) => void;
interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}
const realTimers: Timers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};
export interface SnapshotRequest { readonly id: number; readonly frames: number }

/**
 * The event stream is the only authority for the displayed snapshot. The server broadcasts every
 * change, so the display always converges on the stream: HTTP responses and confirmed local edits
 * are provisional and give way to the next stream frame, or to the current stream snapshot when
 * no frame confirms them in time.
 */
export class SnapshotStore {
  private stream?: Snapshot;
  private sequence?: number;
  private frames = 0;
  private requests = 0;
  private connected = false;
  private reconcile?: unknown;

  constructor(private readonly show: Show, private readonly timers: Timers = realTimers) {}

  /** A complete snapshot starts or restarts the stream. */
  complete(sequence: number, snapshot: Snapshot): void {
    this.stream = snapshot;
    this.sequence = sequence;
    this.frame();
  }

  /** False when the patch does not continue the current stream; the caller must reconnect. */
  patch(sequence: number, patch: SnapshotPatch): boolean {
    if (!this.stream || patch.base !== this.sequence) return false;
    try { this.stream = applySnapshotPatch(this.stream, patch); }
    catch { return false; }
    this.sequence = sequence;
    this.frame();
    return true;
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    if (!connected) this.stopReconcile();
  }

  beginRequest(): SnapshotRequest { return { id: ++this.requests, frames: this.frames }; }

  /** Applies an HTTP snapshot only if it is the newest request and no stream frame arrived meanwhile. */
  response(request: SnapshotRequest, snapshot: Snapshot): void {
    if (request.id !== this.requests || request.frames !== this.frames) return;
    this.provisional(snapshot);
  }

  /** A server-confirmed local change, shown until the stream reports it. */
  provisional(update: Snapshot | ((current: Snapshot | null) => Snapshot | null)): void {
    this.show(update);
    if (!this.stream || !this.connected) return;
    this.stopReconcile();
    this.reconcile = this.timers.setTimeout(() => {
      this.reconcile = undefined;
      if (this.stream && this.connected) this.show(this.stream);
    }, RECONCILE_MS);
  }

  dispose(): void { this.stopReconcile(); }

  private frame(): void {
    this.frames++;
    this.stopReconcile();
    this.show(this.stream!);
  }

  private stopReconcile(): void {
    if (this.reconcile !== undefined) this.timers.clearTimeout(this.reconcile);
    this.reconcile = undefined;
  }
}

export interface SnapshotEventSource {
  addEventListener(type: 'snapshot' | 'patch', listener: (event: MessageEvent<string>) => void): void;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}
export interface SnapshotStreamHandlers {
  onFrame(): void;
  onOpen(): void;
  onError(): void;
  /** A complete snapshot could not be read. */
  onUnreadable(): void;
}

/** Connects `store` to the server's snapshot events and returns a disconnect function. */
export function connectSnapshotStream(store: SnapshotStore, handlers: SnapshotStreamHandlers,
  open: (url: string) => SnapshotEventSource = url => new EventSource(url), timers: Timers = realTimers): () => void {
  let source: SnapshotEventSource | undefined;
  let closed = false;
  let lastResync = -Infinity;
  let resyncTimer: unknown;
  const connect = () => {
    const current = source = open('/api/events?patch=1');
    current.addEventListener('snapshot', event => {
      if (current !== source) return;
      let snapshot: Snapshot;
      try { snapshot = JSON.parse(event.data) as Snapshot; } catch { handlers.onUnreadable(); return; }
      store.complete(Number(event.lastEventId), snapshot);
      handlers.onFrame();
    });
    current.addEventListener('patch', event => {
      if (current !== source) return;
      let applied = false;
      try { applied = store.patch(Number(event.lastEventId), JSON.parse(event.data) as SnapshotPatch); } catch { /* Unreadable patches resynchronize. */ }
      if (applied) handlers.onFrame();
      else resync();
    });
    current.onopen = () => { if (current === source) { store.setConnected(true); handlers.onOpen(); } };
    current.onerror = () => { if (current === source) { store.setConnected(false); handlers.onError(); } };
  };
  // A new connection always begins with a complete snapshot.
  const resync = () => {
    if (closed || resyncTimer !== undefined) return;
    source?.close();
    source = undefined;
    store.setConnected(false);
    const wait = Math.max(0, lastResync + RESYNC_MS - timers.now());
    resyncTimer = timers.setTimeout(() => {
      resyncTimer = undefined;
      lastResync = timers.now();
      if (!closed) connect();
    }, wait);
  };
  connect();
  return () => {
    closed = true;
    if (resyncTimer !== undefined) timers.clearTimeout(resyncTimer);
    source?.close();
    source = undefined;
    store.dispose();
  };
}
