import type { Snapshot } from '../../../shared/types';
import { applySnapshotPatch, type SnapshotPatch } from '../../../shared/snapshot-patch';

/** How long a write from outside the event stream may stand without a confirming stream frame. */
export const RECONCILE_MS = 3000;
/** Minimum spacing between reconnects that recover a stream from a patch it could not apply. */
export const RESYNC_MS = 1000;
/** The server sends a heartbeat every 15 seconds; this long without any frame means the connection died silently. */
export const STALE_MS = 40_000;
/** How often a live connection is checked for silence. */
const WATCHDOG_MS = 5000;
/** Returning to the page after this long without a frame reconnects at once instead of waiting for the watchdog. */
export const WAKE_STALE_MS = 20_000;
/** Reconnects the browser gave up on are retried with a growing wait, up to this. */
export const MAX_RETRY_MS = 15_000;
/** `EventSource.CLOSED`: the browser will not reconnect on its own. */
const CLOSED = 2;

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

  /**
   * The page stopped listening. Requests in flight and a late provisional write can no longer
   * start a timer; a new connection makes the store live again.
   */
  dispose(): void {
    this.connected = false;
    this.requests++;
    this.stopReconcile();
  }

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

/** One frame about a joined computer, carried on this Tower's event stream. */
interface NodeFrame { node: string; sequence?: number; snapshot?: Snapshot; patch?: SnapshotPatch; removed?: true }

/**
 * The shared snapshots of joined computers, each continued by its own frames. Unlike this computer's store, a
 * computer's state is only ever what its frames said; a computer the page stops hearing about is dropped by the
 * page once this Tower no longer lists it.
 */
export class NodeSnapshotStore {
  private readonly streams = new Map<string, { sequence: number; snapshot: Snapshot }>();
  private shown: ReadonlyMap<string, Snapshot> = new Map();

  constructor(private readonly show: (snapshots: ReadonlyMap<string, Snapshot>) => void) {}

  /** False when the frame cannot continue that computer's stream; the caller must reconnect. */
  frame(frame: NodeFrame): boolean {
    if (typeof frame.node !== 'string') return false;
    if (frame.removed) { this.streams.delete(frame.node); this.publish(); return true; }
    if (!Number.isSafeInteger(frame.sequence)) return false;
    if (frame.snapshot) this.streams.set(frame.node, { sequence: frame.sequence!, snapshot: frame.snapshot });
    else {
      const current = this.streams.get(frame.node);
      if (!current || !frame.patch || frame.patch.base !== current.sequence) return false;
      try { this.streams.set(frame.node, { sequence: frame.sequence!, snapshot: applySnapshotPatch(current.snapshot, frame.patch) }); }
      catch { return false; }
    }
    this.publish();
    return true;
  }

  private publish(): void {
    this.shown = new Map([...this.streams].map(([node, stream]) => [node, stream.snapshot]));
    this.show(this.shown);
  }
}

export interface SnapshotEventSource {
  addEventListener(type: 'snapshot' | 'patch' | 'node' | 'heartbeat', listener: (event: MessageEvent<string>) => void): void;
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}
export interface SnapshotStreamHandlers {
  onFrame(): void;
  onOpen(): void;
  /** `retrying` is true when the browser gave up on the connection and this stream reconnects it later. */
  onError(retrying: boolean): void;
  /** A complete snapshot could not be read. */
  onUnreadable(): void;
}

export interface SnapshotConnection {
  (): void;
  /**
   * The page became usable again (shown, restored or back online). A mobile browser suspends a hidden page and
   * often drops its connection without telling it, so a connection that has been quiet reconnects at once.
   */
  wake(): void;
}

/**
 * Connects `store` to the server's snapshot events and returns a disconnect function.
 * The browser reconnects a dropped stream by itself only while it keeps trying; this also reconnects one it gave up on
 * (a proxy answering in its place, or a server restart), one that went silent, and one a suspended page lost.
 */
export function connectSnapshotStream(store: SnapshotStore, handlers: SnapshotStreamHandlers,
  open: (url: string) => SnapshotEventSource = url => new EventSource(url), timers: Timers = realTimers, nodes?: NodeSnapshotStore): SnapshotConnection {
  let source: SnapshotEventSource | undefined;
  let closed = false;
  let lastResync = -Infinity;
  let lastFrame = timers.now();
  let failures = 0;
  let restartTimer: unknown;
  let watchdog: unknown;
  const heard = () => { lastFrame = timers.now(); };
  const connect = () => {
    heard();
    const current = source = open(nodes ? '/api/events?patch=1&nodes=1' : '/api/events?patch=1');
    current.addEventListener('snapshot', event => {
      if (current !== source) return;
      heard();
      let snapshot: Snapshot;
      try { snapshot = JSON.parse(event.data) as Snapshot; } catch { handlers.onUnreadable(); return; }
      failures = 0;
      store.complete(Number(event.lastEventId), snapshot);
      handlers.onFrame();
    });
    current.addEventListener('patch', event => {
      if (current !== source) return;
      heard();
      let applied = false;
      try { applied = store.patch(Number(event.lastEventId), JSON.parse(event.data) as SnapshotPatch); } catch { /* Unreadable patches resynchronize. */ }
      if (applied) handlers.onFrame();
      else resync();
    });
    current.addEventListener('node', event => {
      if (current !== source || !nodes) return;
      heard();
      let applied = false;
      try { applied = nodes.frame(JSON.parse(event.data) as NodeFrame); } catch { /* Unreadable frames resynchronize. */ }
      if (!applied) resync();
    });
    current.addEventListener('heartbeat', () => { if (current === source) heard(); });
    current.onopen = () => { if (current === source) { heard(); store.setConnected(true); handlers.onOpen(); } };
    current.onerror = () => {
      if (current !== source) return;
      store.setConnected(false);
      const retrying = current.readyState === CLOSED;
      handlers.onError(retrying);
      if (retrying) restart(Math.min(MAX_RETRY_MS, 1000 * 2 ** failures++));
    };
  };
  // A new connection always begins with a complete snapshot.
  const restart = (wait: number) => {
    if (closed) return;
    if (restartTimer !== undefined) timers.clearTimeout(restartTimer);
    source?.close();
    source = undefined;
    store.setConnected(false);
    restartTimer = timers.setTimeout(() => {
      restartTimer = undefined;
      if (!closed) connect();
    }, wait);
  };
  const resync = () => {
    if (closed || restartTimer !== undefined) return;
    const wait = Math.max(0, lastResync + RESYNC_MS - timers.now());
    lastResync = timers.now() + wait;
    restart(wait);
  };
  const watch = () => {
    watchdog = timers.setTimeout(() => {
      if (closed) return;
      if (source && timers.now() - lastFrame > STALE_MS) restart(0);
      watch();
    }, WATCHDOG_MS);
  };
  connect();
  watch();
  const disconnect = () => {
    closed = true;
    if (restartTimer !== undefined) timers.clearTimeout(restartTimer);
    if (watchdog !== undefined) timers.clearTimeout(watchdog);
    source?.close();
    source = undefined;
    store.dispose();
  };
  return Object.assign(disconnect, {
    wake: () => {
      if (closed) return;
      const quiet = timers.now() - lastFrame > WAKE_STALE_MS;
      if (!source || source.readyState === CLOSED || quiet) { failures = 0; restart(0); }
    },
  });
}
