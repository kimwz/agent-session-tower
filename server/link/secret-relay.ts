import type { ClientHttp2Session } from 'node:http2';
import type { SecretPeer } from '../../shared/secrets.js';
import { linkRequest } from './transport.js';
import type { RemoteSecretRequest, RemoteSecretResponse } from '../secrets/remote.js';

export interface SecretRelayOptions {
  nodes: { list(): { id: string; status: string }[]; session(id: string): ClientHttp2Session | undefined };
  peers: () => SecretPeer[] | Promise<SecretPeer[]>;
  workerAnswer: (nodeRouteId: string, request: RemoteSecretRequest) => Promise<RemoteSecretResponse>;
  onError?: (nodeRouteId: string, code: 'SECRET_RELAY_UNAVAILABLE') => void;
}
/** The controller web process forwards envelopes; it never holds Vault keys or resolved values. */
export class SecretRelay {
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private readonly active = new Set<string>();
  constructor(private readonly options: SecretRelayOptions) {}
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.pump().catch(() => this.options.onError?.('', 'SECRET_RELAY_UNAVAILABLE')); }, 1000);
    this.timer.unref();
  }
  async pump(): Promise<void> {
    if (this.stopped) return;
    const peers = await this.options.peers();
    const trusted = new Set(peers.filter(p => p.enabled && p.direction === 'node').map(p => p.routeId));
    await Promise.all(this.options.nodes.list().filter(n => n.status === 'connected' && trusted.has(n.id) && !this.active.has(n.id)).map(n => this.pumpNode(n.id)));
  }
  private async pumpNode(id: string): Promise<void> {
    this.active.add(id);
    try {
      const session = this.options.nodes.session(id);
      if (!session || this.stopped) return;
      const answer = await linkRequest(session, 'GET', '/secret-relay', undefined, 5000, { maxBytes: 600 * 1024 });
      if (answer.status !== 200 || !answer.json || typeof answer.json !== 'object' || !('requests' in answer.json)
        || !Array.isArray(answer.json.requests) || answer.json.requests.length > 8) throw new Error('SECRET_RELAY_UNAVAILABLE');
      for (const request of answer.json.requests) {
        if (this.stopped) return;
        try {
          const response = await this.options.workerAnswer(id, request as RemoteSecretRequest);
          if (this.stopped) return;
          const delivered = await linkRequest(session, 'POST', '/secret-relay', { response }, 5000, { maxBytes: 1024 });
          if (delivered.status !== 200) throw new Error('SECRET_RELAY_UNAVAILABLE');
        } catch { this.options.onError?.(id, 'SECRET_RELAY_UNAVAILABLE'); }
      }
    } catch { this.options.onError?.(id, 'SECRET_RELAY_UNAVAILABLE'); }
    finally { this.active.delete(id); }
  }
  /** Stop polling only. Execution worker requests and provider tasks retain their own lifetime. */
  close(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  inFlight(): number { return this.active.size; }
}
