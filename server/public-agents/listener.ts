import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { PUBLIC_SLUG, PublicListenerSettingsSchema, type PublicListenerSettings, type PublicListenerStatus, type PublicVisitorState } from '../../shared/public-agents.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { canonicalIp } from '../auth/store.js';
import { PAGE_CSS, PAGE_HTML, PAGE_JS } from './page.js';

export interface PublicVisitBackend {
  publicVisit(action: string, slug: string, input: { token?: string; ip: string; password?: unknown; text?: unknown }): Promise<{ state: PublicVisitorState; token?: string }>;
}

const COOKIE = 'pa_visitor';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
const MAX_BODY = 16 * 1024;
const REQUESTS_PER_MINUTE = 120;
const CODE = /^[a-z_]{3,40}$/;
const HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin', 'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/**
 * The public pages of public agents, on their own port. It binds to this computer only, serves nothing but visitor
 * pages and their four calls, and knows no owner session, token or route: a tunnel publishes it under its own name.
 */
export class PublicListener {
  private settings: PublicListenerSettings = { port: 0, publicUrl: '' };
  private server?: Server;
  private error?: string;
  private readonly rates = new Map<string, { count: number; at: number }>();
  constructor(private readonly options: { stateDir: string; backend: PublicVisitBackend; host?: string; reservedPorts?: () => number[] }) {}
  private get file() { return join(this.options.stateDir, 'public-agents-listener.json'); }

  status(): PublicListenerStatus {
    const address = this.server?.address();
    return { ...this.settings, listening: Boolean(address), ...(this.error ? { error: this.error } : {}) };
  }

  async start(): Promise<void> {
    try {
      const parsed = PublicListenerSettingsSchema.safeParse(await readPrivateJson(this.file));
      if (parsed.success) this.settings = parsed.data;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.error = 'The saved public page settings could not be read.'; }
    await this.bind();
  }

  async configure(value: unknown): Promise<PublicListenerStatus> {
    const parsed = PublicListenerSettingsSchema.safeParse(value);
    if (!parsed.success) throw Object.assign(new Error(`공개 페이지 설정이 올바르지 않습니다: ${parsed.error.issues.map(issue => issue.message).join('; ')}`), { statusCode: 400 });
    if (parsed.data.port && this.options.reservedPorts?.().includes(parsed.data.port)) throw Object.assign(new Error('Tower가 이미 쓰는 포트입니다. 다른 포트를 고르세요.'), { statusCode: 400 });
    await writePrivateJson(this.file, JSON.stringify(parsed.data));
    this.settings = parsed.data;
    await this.bind();
    return this.status();
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  private async bind(): Promise<void> {
    await this.close();
    this.error = undefined;
    if (!this.settings.port) return;
    const server = createServer((req, res) => { void this.handle(req, res); });
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.settings.port, this.options.host ?? '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      this.server = server;
    } catch (error) {
      this.error = (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `Port ${this.settings.port} is already in use.` : `The public pages could not listen: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** The visitor's address: the tunnel's header when the connection comes from this computer, else the socket's. */
  private clientIp(req: IncomingMessage): string {
    const socket = req.socket.remoteAddress ?? '';
    const forwarded = req.headers['cf-connecting-ip'];
    try {
      const own = canonicalIp(socket);
      if ((own === '::1' || own.startsWith('127.')) && typeof forwarded === 'string' && isIP(forwarded.trim())) return canonicalIp(forwarded.trim());
      return own;
    } catch { return 'unknown'; }
  }

  private allowedHosts(): Set<string> {
    const port = this.settings.port;
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (this.settings.publicUrl) hosts.add(new URL(this.settings.publicUrl).host);
    return hosts;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    for (const [name, value] of Object.entries(HEADERS)) res.setHeader(name, value);
    const send = (status: number, type: string, body: string) => { res.writeHead(status, { 'Content-Type': type }); res.end(req.method === 'HEAD' ? undefined : body); };
    const json = (status: number, body: unknown) => send(status, 'application/json; charset=utf-8', JSON.stringify(body));
    const host = req.headers.host ?? '';
    if (!this.allowedHosts().has(host)) return json(403, { error: 'not_found' });
    const ip = this.clientIp(req);
    const now = Date.now();
    const rate = this.rates.get(ip);
    if (!rate || now - rate.at > 60_000) this.rates.set(ip, { count: 1, at: now });
    else if (++rate.count > REQUESTS_PER_MINUTE) return json(429, { error: 'rate_limited' });
    if (this.rates.size > 10_000) for (const [key, value] of this.rates) if (now - value.at > 60_000) this.rates.delete(key);
    let path: string;
    try { path = new URL(req.url ?? '/', 'http://visitor').pathname; } catch { return json(400, { error: 'unavailable' }); }
    const get = req.method === 'GET' || req.method === 'HEAD';
    if (get && path === '/robots.txt') return send(200, 'text/plain; charset=utf-8', 'User-agent: *\nDisallow: /\n');
    if (get && path === '/_pa/app.js') return send(200, 'text/javascript; charset=utf-8', PAGE_JS);
    if (get && path === '/_pa/app.css') return send(200, 'text/css; charset=utf-8', PAGE_CSS);
    const page = path.match(/^\/a\/([A-Za-z0-9_-]{22})\/?$/);
    if (get && page) return send(200, 'text/html; charset=utf-8', PAGE_HTML);
    const call = path.match(/^\/a\/([A-Za-z0-9_-]{22})\/api\/(state|login|message|reset)$/);
    if (!call || !PUBLIC_SLUG.test(call[1]) || (call[2] === 'state' ? !get : req.method !== 'POST')) return json(404, { error: 'not_found' });
    const [, slug, action] = call;
    // Only this page's own script can make these calls: a custom header, JSON, and no other site.
    let body: Record<string, unknown> = {};
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      const secure = this.settings.publicUrl.startsWith('https:') && host === new URL(this.settings.publicUrl).host;
      if (req.headers['x-public-agent'] !== '1' || !req.headers['content-type']?.startsWith('application/json') || req.headers['sec-fetch-site'] === 'cross-site'
        || (origin && origin !== `${secure ? 'https' : 'http'}://${host}`)) return json(403, { error: 'unavailable' });
      try { body = await readBody(req); } catch { return json(400, { error: 'unavailable' }); }
    }
    const token = cookie(req, COOKIE);
    try {
      const result = await this.options.backend.publicVisit(action, slug, { ip, ...(token ? { token } : {}),
        ...(action === 'login' ? { password: body.password } : {}), ...(action === 'message' ? { text: body.text } : {}) });
      if (result.token) {
        const secure = this.settings.publicUrl.startsWith('https:') && host === new URL(this.settings.publicUrl).host;
        res.setHeader('Set-Cookie', `${COOKIE}=${result.token}; Path=/a/${slug}; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`);
      }
      return json(200, result.state);
    } catch (error) {
      // Only the service's own codes reach visitors; anything else is a plain "unavailable".
      const message = error instanceof Error ? error.message : '';
      const status = (error as { statusCode?: number }).statusCode;
      return json(CODE.test(message) && status && status >= 400 && status < 500 ? status : 503, { error: CODE.test(message) && status && status < 500 ? message : 'unavailable' });
    }
  }
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) { const text = value.join('='); return /^[a-f\d]{64}$/.test(text) ? text : undefined; }
  }
  return undefined;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += (chunk as Buffer).length; if (size > MAX_BODY) throw new Error('too large'); chunks.push(chunk as Buffer); }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
  return value as Record<string, unknown>;
}
