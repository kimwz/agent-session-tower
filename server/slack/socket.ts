import WebSocket, { type RawData } from 'ws';
import { SlackClient } from './client.js';

export interface SlackSocketOptions {
  appToken: string;
  onEvent: (payload: Record<string, unknown>) => Promise<void>;
  onStatus?: (status: 'connecting' | 'connected' | 'disconnected' | 'error', error?: string) => void;
  openSocketUrl?: (token: string) => Promise<string>;
  createSocket?: (url: string) => WebSocket;
  reconnectMs?: number;
  heartbeatMs?: number;
}

/** Own this in the execution worker, never in the disposable web process. */
export class SlackSocket {
  private generation = 0;
  private running = false;
  private socket?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private failures = 0;
  private readonly options: SlackSocketOptions;

  constructor(options: SlackSocketOptions) { this.options = options; }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.connect(++this.generation);
  }

  stop(): void {
    this.running = false;
    this.generation++;
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    this.socket?.terminate();
    this.socket = undefined;
  }

  private current(generation: number): boolean { return this.running && this.generation === generation; }

  private reconnect(generation: number): void {
    if (!this.current(generation)) return;
    const next = ++this.generation;
    clearInterval(this.heartbeat);
    this.socket?.terminate();
    this.socket = undefined;
    this.options.onStatus?.('disconnected');
    const delay = Math.min(30_000, (this.options.reconnectMs ?? 1000) * 2 ** Math.min(this.failures++, 5));
    this.retry = setTimeout(() => { void this.connect(next); }, delay);
    this.retry.unref?.();
  }

  private async connect(generation: number): Promise<void> {
    if (!this.current(generation)) return;
    this.options.onStatus?.('connecting');
    try {
      const open = this.options.openSocketUrl ?? ((token: string) => new SlackClient('').openSocketUrl(token));
      const url = await open(this.options.appToken);
      if (!this.current(generation)) return;
      const socket = this.options.createSocket?.(url) ?? new WebSocket(url, { maxPayload: 1_000_000, handshakeTimeout: 20_000 });
      this.socket = socket;
      let alive = true;
      let pending = 0;
      socket.on('open', () => {
        if (!this.current(generation)) return;
        this.failures = 0;
        this.options.onStatus?.('connected');
        this.heartbeat = setInterval(() => {
          if (!this.current(generation)) return;
          if (!alive) { this.reconnect(generation); return; }
          alive = false;
          try { socket.ping(); } catch { this.reconnect(generation); }
        }, this.options.heartbeatMs ?? 30_000);
        this.heartbeat.unref?.();
      });
      socket.on('pong', () => { alive = true; });
      socket.on('message', (raw: RawData) => {
        if (!this.current(generation)) return;
        const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
        if (bytes.byteLength > 1_000_000) { this.reconnect(generation); return; }
        let envelope: Record<string, any>;
        try { envelope = JSON.parse(bytes.toString('utf8')); } catch { this.reconnect(generation); return; }
        if (!envelope || typeof envelope !== 'object') { this.reconnect(generation); return; }
        if (envelope.type === 'disconnect') { this.reconnect(generation); return; }
        if (typeof envelope.envelope_id !== 'string') return;
        if (++pending > 100) { this.reconnect(generation); return; }
        void (async () => {
          try {
            if (envelope.type === 'events_api') {
              if (!envelope.payload || typeof envelope.payload !== 'object') throw new Error();
              // The callback must durably enqueue, not wait for the agent turn.
              await this.options.onEvent(envelope.payload);
            }
            if (this.current(generation) && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
          } catch {
            this.options.onStatus?.('error', 'Slack event could not be saved');
            this.reconnect(generation);
          } finally { pending--; }
        })();
      });
      socket.on('error', () => {
        if (!this.current(generation)) return;
        this.options.onStatus?.('error', 'Slack connection failed');
        this.reconnect(generation);
      });
      socket.on('close', () => { this.reconnect(generation); });
    } catch {
      if (!this.current(generation)) return;
      this.options.onStatus?.('error', 'Slack connection failed');
      this.reconnect(generation);
    }
  }
}
