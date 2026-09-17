/** A write(false) already accepted the frame. Wait for drain and retain only the newest update. */
export interface SseResponse {
  write(data: string): boolean;
  on(event: 'drain' | 'close', listener: () => void): unknown;
  off(event: 'drain' | 'close', listener: () => void): unknown;
  end(): unknown;
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
}

export class SseClient {
  private blocked = false;
  private closed = false;
  private pending?: string;

  constructor(private readonly response: SseResponse, private readonly onClose: () => void) {
    response.on('drain', this.drain);
    response.on('close', this.close);
  }

  snapshot(frame: string): void {
    if (this.closed) return;
    if (this.blocked) this.pending = frame;
    else this.write(frame);
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
    const frame = this.pending;
    this.pending = undefined;
    if (frame !== undefined) this.write(frame);
  };

  private readonly close = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.pending = undefined;
    this.response.off('drain', this.drain);
    this.response.off('close', this.close);
    this.onClose();
  };
}
