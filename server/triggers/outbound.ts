import type { HttpCondition, HttpRequest, HttpTestResult } from '../../shared/triggers.js';
import { evaluate, performHttp, type HttpOutcome } from './http.js';
import type { SecretStore, StoredSecret } from './secrets.js';
import { cutBytes, small } from './text.js';

const MAX_REQUESTS_PER_MINUTE = 60;

/** The requests every HTTP and GitHub trigger sends together, at most so many a minute. */
export class RequestBudget {
  private requestTimes: number[] = [];
  constructor(private readonly now: () => number, private readonly limit: () => number | undefined) {}
  get requestLimit(): number { return this.limit() ?? MAX_REQUESTS_PER_MINUTE; }

  /** Every request counts, redirects, tests and manual runs included. */
  spend(): string | undefined {
    const now = this.now();
    this.requestTimes = this.requestTimes.filter(at => at > now - 60_000);
    if (this.requestTimes.length >= this.requestLimit) return `HTTP triggers already sent ${this.requestLimit} requests in the last minute; this one was not sent.`;
    this.requestTimes.push(now);
    return undefined;
  }

  /** Requests sent since `since`. */
  sentSince(since: number): number { return this.requestTimes.filter(at => at > since).length; }
}

export interface OutboundContext {
  secrets: SecretStore;
  budget: RequestBudget;
  /** The private hosts the owner allows, read as the request goes. */
  privateHosts(): string[];
  ownPorts?: () => Promise<number[]>;
  resolve?: Parameters<typeof performHttp>[2];
}

/** Sends a request. Secret headers go only to the one origin their secret was saved for. */
export async function sendRequest(request: HttpRequest, usable: (secret: StoredSecret) => boolean, context: OutboundContext): Promise<HttpOutcome> {
  const headers: Record<string, string> = {};
  const secretHeaders: Record<string, string> = {};
  const origins = new Set<string>();
  for (const header of request.headers) {
    if ('value' in header) { headers[header.name] = header.value; continue; }
    const secret = context.secrets.get(header.secretId);
    if (!secret || !usable(secret)) return { ok: false, error: `The secret for the ${header.name} header is missing or was not given to this trigger by the owner; nothing was sent.`, uncertain: false };
    secretHeaders[header.name] = secret.value; origins.add(secret.origin);
  }
  if (origins.size > 1) return { ok: false, error: 'Secrets for different origins cannot be sent in one request; nothing was sent.', uncertain: false };
  const ownPorts = await context.ownPorts?.().catch(() => []) ?? [];
  return performHttp({ method: request.method, url: request.url, headers, secretHeaders, ...(origins.size ? { secretOrigin: [...origins][0] } : {}),
    ...(request.body !== undefined ? { body: request.body } : {}), timeoutMs: request.timeoutSeconds * 1000, beforeSend: () => context.budget.spend() },
  { privateHosts: context.privateHosts(), ownPorts }, context.resolve);
}

/** What the owner sees of a test request. */
export function testResult(outcome: HttpOutcome, condition: HttpCondition | undefined): HttpTestResult {
  if (!outcome.ok) return { ok: false, error: outcome.uncertain ? `${outcome.error} The POST may have reached the server.` : outcome.error };
  const shown = { ok: true, status: outcome.status, ...(outcome.contentType ? { contentType: outcome.contentType } : {}), body: cutBytes(outcome.body, 4000),
    ...(outcome.truncated || Buffer.byteLength(outcome.body) > 4000 ? { truncated: true } : {}) };
  if (!condition) return shown;
  const result = evaluate(condition, outcome, undefined);
  return { ...shown, ...(result.error ? { error: result.error } : {}), ...(result.selected !== undefined ? { selected: small(result.selected) } : {}),
    ...(result.state.matched !== undefined ? { matched: result.state.matched } : {}) };
}
