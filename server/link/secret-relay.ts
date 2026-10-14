import type { ClientHttp2Session } from 'node:http2';
import type { SecretPeer } from '../../shared/secrets.js';
import { linkRequest } from './transport.js';
import type { RemoteSecretRequest, RemoteSecretResponse } from '../secrets/remote.js';
import { SECRET_FEATURES_HEADER } from './secret-routes.js';

export interface SecretRelayOptions {
  nodes: { list(): { id: string; status: string }[]; session(id: string): ClientHttp2Session | undefined };
  peers: () => SecretPeer[] | Promise<SecretPeer[]>;
  workerAnswer: (nodeRouteId: string, request: RemoteSecretRequest) => Promise<RemoteSecretResponse>;
  /** Remote operations the attached worker serves beyond the first protocol (`available`), told to each node on every poll. */
  features?: () => string[];
  /** `SECRET_RELAY_UNSUPPORTED`: a node asked for an operation the attached worker no longer serves; it was not passed on. */
  onError?: (nodeRouteId: string, code: 'SECRET_RELAY_UNAVAILABLE' | 'SECRET_RELAY_UNSUPPORTED') => void;
  /**
   * Computers that follow this Tower to tell, while its vault is locked and so trusts nobody, that it cannot answer
   * (`locked`): they refuse their waiting requests at once instead of after their deadline. Empty while it is open.
   */
  lockedNodes?: () => Promise<string[]>;
  /** A following computer refused `count` requests because this Tower's vault is locked; for the owner's notice. */
  onLocked?: (nodeRouteId: string, count: number) => void;
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
    // A locked vault lists no peers: only then is it worth asking whether following computers wait on it.
    const locked = new Set(!trusted.size && this.options.lockedNodes ? await this.options.lockedNodes() : []);
    await Promise.all(this.options.nodes.list().filter(n => n.status === 'connected' && (trusted.has(n.id) || locked.has(n.id)) && !this.active.has(n.id))
      .map(n => locked.has(n.id) ? this.tellLocked(n.id) : this.pumpNode(n.id)));
  }
  private async tellLocked(id: string): Promise<void> {
    this.active.add(id);
    try {
      const session = this.options.nodes.session(id);
      if (!session || this.stopped) return;
      const answer = await linkRequest(session, 'GET', '/secret-relay', undefined, 5000, { maxBytes: 600 * 1024, headers: { [SECRET_FEATURES_HEADER]: 'locked' } });
      const refused = (answer.json as { refused?: unknown } | undefined)?.refused;
      if (answer.status === 200 && Number.isSafeInteger(refused) && (refused as number) > 0) this.options.onLocked?.(id, refused as number);
    } catch { this.options.onError?.(id, 'SECRET_RELAY_UNAVAILABLE'); }
    finally { this.active.delete(id); }
  }
  private async pumpNode(id: string): Promise<void> {
    this.active.add(id);
    try {
      const session = this.options.nodes.session(id);
      if (!session || this.stopped) return;
      const features = this.options.features?.() ?? [];
      const answer = await linkRequest(session, 'GET', '/secret-relay', undefined, 5000, { maxBytes: 600 * 1024, ...(features.length ? { headers: { [SECRET_FEATURES_HEADER]: features.join(',') } } : {}) });
      if (answer.status !== 200 || !answer.json || typeof answer.json !== 'object' || !('requests' in answer.json)
        || !Array.isArray(answer.json.requests) || answer.json.requests.length > 8) throw new Error('SECRET_RELAY_UNAVAILABLE');
      for (const request of answer.json.requests) {
        if (this.stopped) return;
        // The worker may have been replaced since this poll said what it serves; an older one is never handed a read.
        const operation = (request as Partial<RemoteSecretRequest> | null)?.operation;
        if ((operation === 'available' || operation === 'catalog') && !(this.options.features?.() ?? []).includes(operation)) { this.options.onError?.(id, 'SECRET_RELAY_UNSUPPORTED'); continue; }
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
