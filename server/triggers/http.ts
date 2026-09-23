import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { HttpCondition } from '../../shared/triggers.js';

export const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_REDIRECTS = 3;

/** Addresses no trigger may reach: link-local (cloud metadata), unspecified, multicast and broadcast. */
const NEVER = new BlockList();
NEVER.addSubnet('169.254.0.0', 16); NEVER.addSubnet('0.0.0.0', 8); NEVER.addSubnet('224.0.0.0', 4); NEVER.addSubnet('240.0.0.0', 4);
NEVER.addSubnet('fe80::', 10, 'ipv6'); NEVER.addSubnet('ff00::', 8, 'ipv6'); NEVER.addAddress('::', 'ipv6');
// IPv6 forms that carry an IPv4 address (compatible, NAT64, 6to4) could hide a forbidden one; mapped addresses are unwrapped instead.
NEVER.addSubnet('::', 96, 'ipv6'); NEVER.addSubnet('64:ff9b::', 96, 'ipv6'); NEVER.addSubnet('64:ff9b:1::', 48, 'ipv6'); NEVER.addSubnet('2002::', 16, 'ipv6');
/** Private networks and this computer: reachable only when the owner lists them. */
const PRIVATE = new BlockList();
PRIVATE.addSubnet('10.0.0.0', 8); PRIVATE.addSubnet('172.16.0.0', 12); PRIVATE.addSubnet('192.168.0.0', 16); PRIVATE.addSubnet('100.64.0.0', 10);
PRIVATE.addSubnet('127.0.0.0', 8); PRIVATE.addSubnet('198.18.0.0', 15); PRIVATE.addAddress('::1', 'ipv6'); PRIVATE.addSubnet('fc00::', 7, 'ipv6'); PRIVATE.addSubnet('fec0::', 10, 'ipv6');

export interface Destination {
  /** Owner-approved private hosts: exact host names or CIDR ranges. */
  privateHosts: readonly string[];
  /** Ports of this Tower on this computer; never reachable, even if the owner allows local addresses. */
  ownPorts: readonly number[];
}
export interface HttpCall {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  /** Headers from the secret store, sent only while the request stays on `secretOrigin`. */
  secretHeaders: Record<string, string>;
  secretOrigin?: string;
  body?: string;
  timeoutMs: number;
  /** Asked before each request goes out, redirects included; a message refuses it. */
  beforeSend?: () => string | undefined;
}
export type HttpOutcome =
  | { ok: true; status: number; contentType?: string; body: string; truncated: boolean; url: string }
  | { ok: false; error: string; /** A POST may have reached the server; it is never sent again. */ uncertain: boolean };

const family = (address: string): 'ipv4' | 'ipv6' => isIP(address) === 6 ? 'ipv6' : 'ipv4';

/** The eight 16-bit groups of an IPv6 address, including the dotted IPv4 tail form. */
function groups(address: string): number[] | undefined {
  let text = address.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const bytes = dotted[1].split('.').map(Number);
    text = `${text.slice(0, -dotted[1].length)}${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const [head, tail] = text.includes('::') ? text.split('::') : [text, undefined];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  const all = [...left, ...Array(Math.max(0, fill)).fill('0'), ...right].map(part => parseInt(part, 16));
  return all.length === 8 && all.every(value => Number.isInteger(value) && value >= 0 && value <= 0xffff) ? all : undefined;
}
/** One spelling per address: IPv4-mapped IPv6 in any form becomes IPv4, so every check sees the same thing. */
export function normalized(address: string): string {
  const plain = address.split('%')[0];
  if (isIP(plain) !== 6) return plain;
  const parts = groups(plain);
  if (parts && parts.slice(0, 5).every(value => value === 0) && parts[5] === 0xffff) return [parts[6] >> 8, parts[6] & 255, parts[7] >> 8, parts[7] & 255].join('.');
  return parts ? parts.map(value => value.toString(16)).join(':').replace(/(^|:)0(:0)+(:|$)/, '::') : plain.toLowerCase();
}

/** Addresses of this computer: loopback and every interface, where Tower's own ports must never be called. */
const ownAddresses = () => new Set(['::1', ...Object.values(networkInterfaces()).flatMap(list => list ?? []).map(item => normalized(item.address))]);

/** Checks every address a host resolves to; one forbidden address refuses the whole host. */
export async function allowedAddress(url: URL, destination: Destination, resolve = dnsLookup, deadline = Date.now() + 30_000): Promise<{ address: string; family: 4 | 6 }> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) as 4 | 6 }] : (await within(resolve(host, { all: true, verbatim: true }), deadline, `${host} did not resolve in time.`)) as Array<{ address: string; family: number }>;
  if (!addresses.length) throw new Error(`${host} did not resolve.`);
  const listed = new BlockList();
  const names = new Set<string>();
  for (const entry of destination.privateHosts) {
    const [network, bits] = entry.split('/');
    // An entry that is not a valid range is ignored rather than breaking every request.
    try {
      if (isIP(network) && bits !== undefined && /^\d+$/.test(bits)) listed.addSubnet(normalized(network), Number(bits), family(normalized(network)));
      else if (isIP(entry)) listed.addAddress(normalized(entry), family(normalized(entry)));
      else names.add(entry.toLowerCase());
    } catch { /* skipped */ }
  }
  for (const entry of addresses) {
    const address = normalized(entry.address);
    const kind = family(address);
    // ::1 sits inside the IPv4-compatible range but is plain loopback, handled below.
    if (address !== '::1' && NEVER.check(address, kind)) throw new Error(`${host} resolves to ${address}, which triggers may never reach.`);
    if (destination.ownPorts.includes(port) && (address.startsWith('127.') || ownAddresses().has(address))) throw new Error('Triggers cannot call Tower itself.');
    if (PRIVATE.check(address, kind) && !names.has(host.toLowerCase()) && !listed.check(address, kind)) {
      throw new Error(`${host} is on a private network or this computer. Add it to the allowed private hosts in trigger settings first.`);
    }
  }
  const chosen = normalized(addresses[0].address);
  return { address: chosen, family: isIP(chosen) === 6 ? 6 : 4 };
}

const within = <T>(work: Promise<T>, deadline: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), Math.max(0, deadline - Date.now())); })])
    .finally(() => clearTimeout(timer));
};

/**
 * One HTTP request, following at most three redirects, each checked again. The connection goes to the checked
 * address. The timeout covers the whole call, redirects and name lookups included.
 */
export async function performHttp(call: HttpCall, destination: Destination, resolve = dnsLookup): Promise<HttpOutcome> {
  const secrets = Object.values(call.secretHeaders);
  let outcome: HttpOutcome;
  try { outcome = await perform(call, destination, resolve); }
  catch (error) { outcome = { ok: false, error: error instanceof Error ? error.message : String(error), uncertain: false }; }
  return secrets.length ? redact(outcome, secrets) : outcome;
}

/**
 * Every spelling of a sent secret that a response could echo back is removed: as sent, its credential part,
 * JSON- and URL-escaped, and base64. A JSON body is also decoded and cleaned value by value, so escapes such
 * as \\u0041 cannot hide one.
 */
function redact(outcome: HttpOutcome, secrets: string[]): HttpOutcome {
  const forms = new Set<string>();
  for (const secret of secrets) {
    const plain = secret.trim().replace(/\s+/g, ' ');
    for (const value of [secret, plain, /^\S+ (\S.*)$/.exec(plain)?.[1]]) {
      if (!value || value.length < 4) continue;
      for (const form of [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), Buffer.from(value).toString('base64')]) forms.add(form);
    }
  }
  const ordered = [...forms].sort((a, b) => b.length - a.length);
  const clean = (text: string) => ordered.reduce((result, form) => result.split(form).join('[secret removed]'), text);
  if (!outcome.ok) return { ...outcome, error: clean(outcome.error) };
  let body = clean(outcome.body);
  try {
    const deep = (value: unknown): unknown => typeof value === 'string' ? clean(value) : Array.isArray(value) ? value.map(deep)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [clean(key), deep(item)])) : value;
    body = JSON.stringify(deep(JSON.parse(body)));
  } catch { /* not JSON: the text form is already cleaned */ }
  return { ...outcome, body, url: clean(outcome.url), ...(outcome.contentType ? { contentType: clean(outcome.contentType) } : {}) };
}

/** Requests never go through an environment proxy: each connects straight to the address that was checked. */
const agents = { http: new HttpAgent({ keepAlive: false }), https: new HttpsAgent({ keepAlive: false }) };

async function perform(call: HttpCall, destination: Destination, resolve: typeof dnsLookup): Promise<HttpOutcome> {
  const deadline = Date.now() + call.timeoutMs;
  let delivered = false;
  let url: URL;
  try { url = new URL(call.url); } catch { return { ok: false, error: 'Invalid URL.', uncertain: false }; }
  let method = call.method;
  let body = call.body;
  let sendSecrets = Object.keys(call.secretHeaders).length > 0;
  if (sendSecrets && url.origin !== call.secretOrigin) return { ok: false, error: `The secret headers belong to ${call.secretOrigin}, not ${url.origin}; nothing was sent.`, uncertain: false };
  for (let hop = 0; ; hop++) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return { ok: false, error: 'Only http and https URLs without credentials are allowed.', uncertain: delivered };
    let target: { address: string; family: 4 | 6 };
    try { target = await allowedAddress(url, destination, resolve, deadline); }
    catch (error) { return { ok: false, error: (error as Error).message, uncertain: delivered }; }
    const headers = { ...call.headers, ...(sendSecrets ? call.secretHeaders : {}), ...(body !== undefined && method === 'POST' ? { 'content-length': String(Buffer.byteLength(body)) } : {}) };
    const remaining = deadline - Date.now();
    // A POST answered with a redirect was delivered: whatever happens next, it must not be sent again.
    const stop = (error: string): HttpOutcome => ({ ok: false, error, uncertain: delivered });
    if (remaining <= 0) return stop(`No response within ${Math.round(call.timeoutMs / 1000)} seconds.`);
    const refused = call.beforeSend?.();
    if (refused) return stop(refused);
    const outcome = await once(url, method, headers, method === 'POST' ? body : undefined, target, remaining);
    if (!outcome.ok) return { ...outcome, uncertain: outcome.uncertain || delivered };
    if (!('redirect' in outcome)) return outcome;
    delivered ||= method === 'POST';
    if (hop >= MAX_REDIRECTS) return stop('Too many redirects.');
    let next: URL;
    try { next = new URL(outcome.redirect, url); } catch { return stop('The server redirected to an invalid address.'); }
    if (sendSecrets && next.origin !== url.origin) return stop(`Redirected to ${next.origin}; secret headers are never sent to another origin, so the request stopped.`);
    if (outcome.status === 303 || ((outcome.status === 301 || outcome.status === 302) && method === 'POST')) { method = 'GET'; body = undefined; }
    url = next;
    sendSecrets = sendSecrets && next.origin === call.secretOrigin;
  }
}

function once(url: URL, method: string, headers: Record<string, string>, body: string | undefined, target: { address: string; family: 4 | 6 }, timeoutMs: number)
  : Promise<HttpOutcome | { ok: true; redirect: string; status: number }> {
  return new Promise(resolve => {
    let sent = false;
    let settled = false;
    const finish = (value: HttpOutcome | { ok: true; redirect: string; status: number }) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const fail = (message: string) => finish({ ok: false, error: message, uncertain: method === 'POST' && sent });
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method, headers: { 'user-agent': 'Agent-Session-Tower-Trigger', ...headers }, agent: url.protocol === 'https:' ? agents.https : agents.http,
      // Connect to the address that was checked, not whatever the name resolves to a moment later.
      lookup: ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => options?.all
        ? callback(null, [{ address: target.address, family: target.family }]) : callback(null, target.address, target.family)) as unknown as LookupFunction,
    }, (response: IncomingMessage) => {
      // The checked address is the one actually connected to.
      const remote = response.socket.remoteAddress;
      if (remote && normalized(remote) !== normalized(target.address)) { response.destroy(); fail(`Connected to ${remote} instead of the checked address.`); return; }
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      // A redirect's body is never read; its connection closes now instead of lingering until the server ends it.
      if (status >= 300 && status < 400 && typeof location === 'string') { finish({ ok: true, redirect: location, status }); response.destroy(); req.destroy(); return; }
      const chunks: Buffer[] = []; let size = 0; let truncated = false;
      response.on('data', (chunk: Buffer) => {
        if (size >= MAX_RESPONSE_BYTES) { truncated = true; response.destroy(); return; }
        chunks.push(chunk.subarray(0, MAX_RESPONSE_BYTES - size)); size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) { truncated = true; response.destroy(); }
      });
      const done = () => finish({ ok: true, status, ...(response.headers['content-type'] ? { contentType: String(response.headers['content-type']) } : {}),
        body: Buffer.concat(chunks).toString('utf8'), truncated, url: url.toString() });
      response.on('end', done);
      response.on('close', done);
      response.on('error', () => (truncated ? done() : fail('The response was cut off.')));
    });
    const timer = setTimeout(() => { req.destroy(); fail(`No response within ${Math.round(timeoutMs / 1000)} seconds.`); }, timeoutMs);
    req.on('error', error => fail(error.message));
    req.end(body, () => { sent = true; });
  });
}

/** Reads a value by JSON Pointer (RFC 6901); an empty pointer is the whole document. */
export function pointerValue(document: unknown, pointer = ''): unknown {
  if (!pointer) return document;
  if (!pointer.startsWith('/')) return undefined;
  let value: unknown = document;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export interface ConditionState { hash?: string; matched?: boolean }
/**
 * Whether a response starts a run. `changed` and `match` take the first response they see as the starting
 * point, so creating a trigger never fires just because it saw the current state for the first time.
 */
export function evaluate(condition: HttpCondition, response: { status: number; body: string; contentType?: string }, previous: ConditionState | undefined)
  : { fire: boolean; state: ConditionState; selected?: unknown; error?: string } {
  const statuses = condition.type === 'match' ? condition.statuses ?? [] : [];
  if ((response.status < 200 || response.status > 299) && !statuses.includes(response.status)) return { fire: false, state: previous ?? {}, error: `HTTP ${response.status}` };
  if (condition.type === 'every-success') return { fire: true, state: previous ?? {} };
  let document: unknown;
  try { document = JSON.parse(response.body); } catch { document = undefined; }
  const pointer = condition.pointer ?? '';
  const selected = pointer ? pointerValue(document, pointer) : document ?? response.body;
  if (condition.type === 'changed') {
    const hash = createHash('sha256').update(JSON.stringify(selected ?? null)).digest('hex');
    return { fire: previous?.hash !== undefined && previous.hash !== hash, state: { ...previous, hash }, selected };
  }
  const text = typeof selected === 'string' ? selected : JSON.stringify(selected);
  const value = condition.value ?? '';
  const matched = condition.operator === 'exists' ? selected !== undefined
    : condition.operator === 'equals' ? text === value
    : condition.operator === 'not-equals' ? text !== value
    : condition.operator === 'contains' ? (text ?? '').includes(value)
    : condition.operator === 'gt' ? Number(selected) > Number(value)
    : Number(selected) < Number(value);
  return { fire: matched && previous?.matched === false, state: { ...previous, matched }, selected };
}
