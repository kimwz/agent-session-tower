/** A write(false) already accepted the frame. Wait for drain and retain only the newest update. */
export interface SseResponse {
  write(data: string): boolean;
  on(event: 'drain' | 'close', listener: () => void): unknown;
  off(event: 'drain' | 'close', listener: () => void): unknown;
  end(): unknown;
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
}

/**
 * One browser's event stream. It can carry several independent snapshot streams (this Tower's and each
 * joined computer's), each keyed, so a blocked socket keeps the newest complete snapshot of every stream.
 */
export class SseClient {
  private blocked = false;
  private closed = false;
  /** Complete snapshots by stream, rendered when the socket drains. */
  private readonly pending = new Map<string, () => string>();

  constructor(private readonly response: SseResponse, private readonly onClose: () => void) {
    response.on('drain', this.drain);
    response.on('close', this.close);
  }

  snapshot(frame: string, key = ''): void {
    this.update(undefined, () => frame, key);
  }

  /**
   * A patch only continues a stream that received every earlier frame. While the socket is
   * blocked, the newest complete snapshot replaces anything pending for that stream, so a skipped
   * patch never leaves the browser on a stale base.
   */
  update(patch: string | undefined, snapshot: () => string, key = ''): void {
    if (this.closed) return;
    if (this.blocked) { this.pending.delete(key); this.pending.set(key, snapshot); }
    else this.write(patch ?? snapshot());
  }

  heartbeat(): void {
    if (!this.closed && !this.blocked) this.write(': heartbeat\n\n');
  }

  end(): void {
    this.close();
    if (!this.response.destroyed && !this.response.writableEnded) this.response.end();
  }

  private write(frame: string): void {
    if (this.response.destroyed || this.response.writableEnded) { this.close(); return; }
    this.blocked = !this.response.write(frame);
  }

  private readonly drain = (): void => {
    if (this.closed) return;
    this.blocked = false;
    for (const [key, frame] of this.pending) {
      if (this.blocked || this.closed) break;
      this.pending.delete(key);
      this.write(frame());
    }
  };

  private readonly close = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.pending.clear();
    this.response.off('drain', this.drain);
    this.response.off('close', this.close);
    this.onClose();
  };
}
