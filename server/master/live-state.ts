import type { IncomingMessage } from 'node:http';
import { applySnapshotPatch, type SnapshotPatch } from '../../shared/snapshot-patch.js';
import type { Snapshot } from '../../shared/types.js';

interface Stream { sequence: number; snapshot: Snapshot }
/** Opens the page's live event stream; the TowerClient provides it with the web's credentials. */
export type OpenStream = (path: string, signal: AbortSignal) => Promise<IncomingMessage>;

const PATH = '/api/events?patch=1&nodes=1';
const IDLE_MS = 5 * 60_000;
const RETRY_MS = 1000;
/** How long, after connecting, joined computers' first states are waited for. */
const JOINED_WAIT_MS = 1500;

/**
 * What the owner's page sees, kept live in the master host: this computer's snapshot and each joined computer's,
 * from the same event stream the page uses, patches applied the same way. It connects when the master needs it and
 * lets go after a while unused, so an idle master costs the web nothing.
 */
export class LiveState {
  private local?: Stream;
  private readonly nodes = new Map<string, Stream>();
  private controller?: AbortController;
  private lastUse = 0;
  private receivedAt = 0;
  private waiters: Array<() => void> = [];
  private retry?: ReturnType<typeof setTimeout>;
  private readonly idleTimer: ReturnType<typeof setInterval>;
  private closed = false;
  private revision = 0;
  private connectedAt = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly open: OpenStream, private readonly idleMs = IDLE_MS) {
    this.idleTimer = setInterval(() => { if (this.controller && Date.now() - this.lastUse > this.idleMs) this.disconnect(); }, 30_000);
    this.idleTimer.unref();
  }

  /**
   * The current state, connecting first if needed; undefined when no snapshot arrived within `timeoutMs`. Right after
   * connecting it also gives joined computers a moment to arrive, so a first answer does not leave them out unnoticed;
   * any still missing are listed by `missing()`.
   */
  async fresh(timeoutMs = 3000): Promise<Snapshot | undefined> {
    this.lastUse = Date.now();
    if (!this.controller) this.connect();
    const deadline = Date.now() + timeoutMs;
    const wait = (until: () => boolean, by: number) => until() ? Promise.resolve() : new Promise<void>(resolve => {
      const timer = setTimeout(done, Math.max(0, by - Date.now()));
      const check = () => { if (until()) done(); else this.waiters.push(check); };
      function done() { clearTimeout(timer); resolve(); }
      this.waiters.push(check);
    });
    await wait(() => Boolean(this.local), deadline);
    if (this.local && this.missing().length) await wait(() => !this.missing().length, Math.min(deadline, this.connectedAt + JOINED_WAIT_MS));
    return this.local?.snapshot;
  }

  /** Joined computers this Tower lists whose state has not arrived on the stream. */
  missing(): string[] {
    return (this.local?.snapshot.nodes ?? []).map(node => node.id).filter(id => !this.nodes.has(id));
  }

  /** This computer's snapshot as last received, without connecting. */
  snapshot(): Snapshot | undefined { return this.local?.snapshot; }
  node(id: string): Snapshot | undefined { return this.nodes.get(id)?.snapshot; }
  nodeSnapshots(): ReadonlyMap<string, Snapshot> { return new Map([...this.nodes].map(([id, stream]) => [id, stream.snapshot])); }
  /** Changes whenever anything received changes, so derived views can be rebuilt only then. */
  version(): number { return this.revision; }
  /** Connected and heard from within `ms`. */
  live(ms = 30_000): boolean { return Boolean(this.controller && this.local && Date.now() - this.receivedAt < ms); }

  /** Called after every change received (a snapshot or a patch, of this computer or a joined one). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
    clearInterval(this.idleTimer);
    this.disconnect();
  }

  private disconnect(): void {
    clearTimeout(this.retry);
    this.controller?.abort();
    this.controller = undefined;
    // A stream that is not followed goes stale; nothing old is served as current.
    this.local = undefined;
    this.nodes.clear();
    this.revision++;
  }

  private connect(): void {
    if (this.closed) return;
    const controller = this.controller = new AbortController();
    this.connectedAt = Date.now();
    void this.follow(controller).catch(() => {}).finally(() => {
      if (this.controller !== controller) return;
      this.controller = undefined;
      this.local = undefined;
      this.nodes.clear();
      this.revision++;
      // Still wanted (for example across a web restart): connect again shortly.
      if (!this.closed && Date.now() - this.lastUse < this.idleMs) this.retry = setTimeout(() => { if (!this.controller) this.connect(); }, RETRY_MS);
    });
  }

  private async follow(controller: AbortController): Promise<void> {
    const response = await this.open(PATH, controller.signal);
    let buffer = '';
    response.setEncoding('utf8');
    for await (const chunk of response) {
      buffer += chunk as string;
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (!this.frame(block)) { controller.abort(); return; }
      }
    }
  }

  /** Applies one frame; false when the stream cannot be continued and must start again. */
  private frame(block: string): boolean {
    let event = 'message'; let id: string | undefined; const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('id:')) id = line.slice(3).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (event === 'heartbeat' || !data.length) return true;
    let value: unknown;
    try { value = JSON.parse(data.join('\n')); } catch { return false; }
    this.receivedAt = Date.now();
    if (event === 'snapshot') {
      const sequence = Number(id);
      if (!Number.isSafeInteger(sequence)) return false;
      this.local = { sequence, snapshot: value as Snapshot };
    } else if (event === 'patch') {
      const patch = value as SnapshotPatch;
      if (!this.local || patch.base !== this.local.sequence) return false;
      try { this.local = { sequence: Number(id), snapshot: applySnapshotPatch(this.local.snapshot, patch) }; } catch { return false; }
    } else if (event === 'node') {
      const frame = value as { node?: string; sequence?: number; snapshot?: Snapshot; patch?: SnapshotPatch; removed?: boolean };
      if (typeof frame.node !== 'string') return false;
      if (frame.removed) this.nodes.delete(frame.node);
      else {
        if (!Number.isSafeInteger(frame.sequence)) return false;
        if (frame.snapshot) this.nodes.set(frame.node, { sequence: frame.sequence!, snapshot: frame.snapshot });
        else {
          const current = this.nodes.get(frame.node);
          if (!current || !frame.patch || frame.patch.base !== current.sequence) return false;
          try { this.nodes.set(frame.node, { sequence: frame.sequence!, snapshot: applySnapshotPatch(current.snapshot, frame.patch) }); } catch { return false; }
        }
      }
    } else return true;
    this.revision++;
    for (const wake of this.waiters.splice(0)) wake();
    for (const listener of [...this.listeners]) {
      try { listener(); } catch (error) { console.error(`Master live state listener failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return true;
  }
}
