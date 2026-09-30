import { createHash, createHmac } from 'node:crypto';
import type { RemoteBackup } from '../../shared/backup.js';
import { BackupError } from './crypto.js';

/** An S3-compatible bucket (Cloudflare R2, AWS S3, MinIO…), reached with path-style URLs. */
export interface S3Target { endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string }

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const hmac = (key: string | Buffer, value: string) => createHmac('sha256', key).update(value).digest();
/** A key or prefix whose path would change on the way (`.` or `..` segments, empty segments inside). */
export function unsafeKey(value: string): boolean { return value.split('/').some((segment, index, all) => segment === '.' || segment === '..' || (segment === '' && index > 0 && index < all.length - 1)); }

/** RFC 3986 encoding, as SigV4 requires: everything but unreserved characters. */
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * AWS Signature Version 4 for one request. `headers` are signed as given (plus the host, date and payload hash this
 * adds); answers the headers to send.
 */
export function signV4(input: { method: string; url: URL; headers?: Record<string, string>; payloadHash: string; region: string; service?: string; accessKeyId: string; secretAccessKey: string; now: Date }): Record<string, string> {
  const amzDate = input.now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const service = input.service ?? 's3';
  const headers: Record<string, string> = { ...Object.fromEntries(Object.entries(input.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value.trim()])),
    host: input.url.host, 'x-amz-content-sha256': input.payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(headers).sort();
  const query = [...input.url.searchParams.entries()].map(([name, value]) => [encode(name), encode(value)]).sort(([a, x], [b, y]) => a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0)
    .map(([name, value]) => `${name}=${value}`).join('&');
  const canonical = [input.method, input.url.pathname, query, ...names.map(name => `${name}:${headers[name]}`), '', names.join(';'), input.payloadHash].join('\n');
  const scope = `${day}/${input.region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

/** The endpoint as a URL: HTTPS, or plain HTTP only to this computer (a local test server). */
export function endpointUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new BackupError('엔드포인트 주소가 올바르지 않습니다.'); }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new BackupError('엔드포인트는 https:// 주소여야 합니다.');
  if (url.username || url.password || url.search || url.hash) throw new BackupError('엔드포인트에는 주소만 쓰세요.');
  return url;
}

const xmlText = (value: string) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/&amp;/g, '&');
const tag = (xml: string, name: string) => { const found = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml); return found ? xmlText(found[1]!) : undefined; };

export class S3Client {
  private readonly base: URL;
  /** `signal` stops every request under way (Tower shutting down). */
  constructor(private readonly target: S3Target, private readonly fetcher: typeof fetch = fetch, private readonly now: () => Date = () => new Date(), private readonly signal?: AbortSignal) {
    this.base = endpointUrl(target.endpoint);
    if (!target.bucket || !/^[a-z0-9][a-z0-9.-]{1,62}$/.test(target.bucket)) throw new BackupError('버킷 이름이 올바르지 않습니다.');
    if (!target.accessKeyId || !target.secretAccessKey) throw new BackupError('액세스 키를 입력하세요.');
  }

  private url(key?: string, query: Record<string, string> = {}): URL {
    const url = new URL(this.base.href);
    const base = url.pathname.replace(/\/+$/, '');
    url.pathname = `${base}/${encode(this.target.bucket)}${key !== undefined ? `/${key.split('/').map(encode).join('/')}` : ''}`;
    // Sent exactly as signed (RFC 3986), not as URLSearchParams would write it ("+" for a space).
    url.search = Object.entries(query).map(([name, value]) => `${encode(name)}=${encode(value)}`).join('&');
    return url;
  }

  private async request(method: string, url: URL, body?: Buffer, headers: Record<string, string> = {}, timeoutMs = 30_000): Promise<Response> {
    const signed = signV4({ method, url, headers, payloadHash: sha256(body ?? ''), region: this.target.region || 'auto', accessKeyId: this.target.accessKeyId, secretAccessKey: this.target.secretAccessKey, now: this.now() });
    const { host: _host, ...sent } = signed;
    let response: Response;
    try { response = await this.fetcher(url, { method, headers: sent, ...(body ? { body: new Uint8Array(body) } : {}), signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs), redirect: 'error' }); }
    catch (error) { throw new BackupError(`저장소에 연결하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, 502); }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const code = tag(text, 'Code'), message = tag(text, 'Message');
      throw new BackupError(`저장소가 요청을 거절했습니다 (${response.status}${code ? ` ${code}` : ''}${message ? `: ${message.slice(0, 200)}` : ''}).`, 502);
    }
    return response;
  }

  async put(key: string, body: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    await (await this.request('PUT', this.url(key), body, { 'content-type': contentType }, 120_000)).arrayBuffer();
  }

  async get(key: string, maxBytes: number): Promise<Buffer> {
    const response = await this.request('GET', this.url(key), undefined, {}, 120_000);
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) { await response.body?.cancel(); throw new BackupError('백업 파일이 너무 큽니다.', 413); }
    // Read piece by piece, so a body larger than it says is stopped as soon as it passes the limit.
    const parts: Buffer[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    for (;;) {
      const next = await reader?.read();
      if (!next || next.done) break;
      size += next.value.length;
      if (size > maxBytes) { await reader!.cancel().catch(() => {}); throw new BackupError('백업 파일이 너무 큽니다.', 413); }
      parts.push(Buffer.from(next.value));
    }
    return Buffer.concat(parts);
  }

  async delete(key: string): Promise<void> {
    await (await this.request('DELETE', this.url(key))).arrayBuffer();
  }

  /** Every object under `prefix`, following continuation up to `limit` objects. */
  async list(prefix: string, limit = 5000): Promise<RemoteBackup[]> {
    const found: RemoteBackup[] = [];
    let token: string | undefined;
    // A store that keeps saying there is more without giving any is not followed forever.
    for (let page = 0; page < 100; page++) {
      const response = await this.request('GET', this.url(undefined, { 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : {}) }));
      const xml = await response.text();
      for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = tag(match[1]!, 'Key');
        if (key !== undefined) found.push({ key, size: Number(tag(match[1]!, 'Size') ?? 0), modifiedAt: tag(match[1]!, 'LastModified') ?? '' });
      }
      token = tag(xml, 'IsTruncated') === 'true' ? tag(xml, 'NextContinuationToken') : undefined;
      if (!token || found.length >= limit) break;
    }
    return found;
  }
}
