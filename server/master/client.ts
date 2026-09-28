import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { request, type ClientRequest, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';
import { APP_VERSION } from '../../shared/app-identity.js';
import { readPrivateJson } from '../stores/private-json.js';
import type { AttachmentStore } from '../stores/attachments.js';
import { masterAttachments } from './attachments.js';
import { MASTER_PROTOCOL, type MasterHostReply } from './host.js';
import { masterPaths, type MasterPaths } from './paths.js';
import type { WebCredentials } from './tower-client.js';

const MAX_REPLY = 16 * 1024 * 1024;
const failure = (message: string, statusCode: number, hostAbsent = false) => Object.assign(new Error(message), { statusCode, ...(hostAbsent ? { hostAbsent } : {}) });

export interface MasterClientOptions {
  stateDir: string;
  /** This web's own address and page credentials, handed to the host so it can call Tower like a page. */
  credentials: () => WebCredentials | undefined;
  hostEntry?: string;
  startupTimeoutMs?: number;
}

/**
 * The web side of the master host: starts it on first use, hands it this web's credentials, and relays its answers
 * and live stream. The web never stops the host; it only lets go of it.
 */
export class MasterClient {
  private paths?: MasterPaths;
  private starting?: Promise<void>;
  private readonly streams = new Set<ClientRequest>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private closed = false;
  private pictures?: Promise<AttachmentStore>;

  constructor(private readonly options: MasterClientOptions) {}

  /** Where pictures sent to the master are kept; the host reads the same folder. */
  attachments(): Promise<AttachmentStore> {
    return this.pictures ??= this.hostPaths().then(paths => masterAttachments(paths.data)).catch(error => { this.pictures = undefined; throw error; });
  }

  /**
   * Keeps a running host told who this web is, so work it continues after a web restart can reach Tower. When no host
   * runs but work was left waiting (the host or the computer stopped), it starts one, so the work goes on and its
   * report comes without waiting for someone to open a page.
   */
  start(): void {
    const tell = () => { void this.exchange('hello').catch(() => {}); };
    tell();
    void this.pendingWork().then(pending => pending && !this.closed ? this.ensureHost() : undefined).catch(error => {
      console.error(`Master could not resume waiting work: ${(error as NodeJS.ErrnoException)?.code ?? (error as { statusCode?: number })?.statusCode ?? 'error'}`);
    });
    this.heartbeat = setInterval(tell, 15_000);
    this.heartbeat.unref();
  }

  /** Whether the master's records hold a message not yet answered or delegated work not yet reported. */
  private async pendingWork(): Promise<boolean> {
    const { data } = await this.hostPaths();
    const waiting = async (name: string, states: string[]) => {
      const saved = await readPrivateJson(join(data, name)).catch(() => undefined) as { items?: Array<{ state?: unknown }> } | undefined;
      return Array.isArray(saved?.items) && saved.items.some(item => typeof item?.state === 'string' && states.includes(item.state));
    };
    return await waiting('inbox.json', ['queued', 'processing']) || await waiting('tasks.json', ['running']);
  }

  async call(method: string, args: Record<string, unknown> = {}): Promise<unknown> {
    await this.ensureHost();
    return (await this.exchange(method, args)).result;
  }

  /** Whether the host (started if none runs) is this build's: an older one, still busy, would drop what it does not know. */
  async sameBuild(): Promise<boolean> {
    await this.ensureHost();
    return (await this.exchange('ping')).version === APP_VERSION;
  }

  /** The running host's version, without starting one: null when none runs; a failure to ask is an error. */
  async hostVersion(): Promise<string | null> {
    try { return (await this.exchange('ping')).version; }
    catch (error) { if ((error as { hostAbsent?: boolean }).hostAbsent) return null; throw error; }
  }

  /** Relays the host's live stream for one page. */
  async pipe(response: ServerResponse, epoch: string, after: number): Promise<void> {
    await this.ensureHost();
    const token = await this.credential();
    const paths = await this.hostPaths();
    await new Promise<void>((resolve, reject) => {
      const query = new URLSearchParams({ epoch, after: String(after) });
      const req = request({ socketPath: paths.socket, path: `/events?${query}`, headers: { authorization: `Bearer ${token}` } }, upstream => {
        if (upstream.statusCode !== 200) { upstream.resume(); reject(failure('마스터에 연결하지 못했습니다.', 502)); return; }
        if (response.destroyed || response.writableEnded) { upstream.destroy(); resolve(); return; }
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.flushHeaders();
        upstream.on('error', () => response.destroy());
        upstream.pipe(response);
        resolve();
      });
      this.streams.add(req);
      req.once('close', () => this.streams.delete(req));
      response.once('close', () => req.destroy());
      req.once('error', error => { if (!response.headersSent) reject(error); else response.destroy(); });
      req.end();
    });
  }

  /**
   * Relays audio the master is reading aloud, as it is made. Audio whose making failed is cut off here too, so the
   * page never takes part of it for the whole.
   */
  async pipeAudio(response: ServerResponse, id: string): Promise<void> {
    await this.ensureHost();
    const token = await this.credential();
    const paths = await this.hostPaths();
    await new Promise<void>((resolve, reject) => {
      const req = request({ socketPath: paths.socket, path: `/audio/${encodeURIComponent(id)}`, headers: { authorization: `Bearer ${token}` } }, upstream => {
        if (response.destroyed || response.writableEnded) { upstream.destroy(); resolve(); return; }
        if (upstream.statusCode !== 200) { upstream.resume(); response.writeHead(upstream.statusCode === 404 ? 404 : 502).end(); resolve(); return; }
        response.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', ...(upstream.headers['content-length'] ? { 'Content-Length': upstream.headers['content-length'] } : {}) });
        upstream.on('error', () => response.destroy());
        upstream.on('aborted', () => response.destroy());
        upstream.on('close', () => { if (!upstream.complete) response.destroy(); });
        upstream.pipe(response);
        resolve();
      });
      this.streams.add(req);
      req.once('close', () => this.streams.delete(req));
      response.once('close', () => req.destroy());
      req.once('error', error => { if (!response.headersSent) reject(error); else response.destroy(); });
      req.end();
    });
  }

  dispose(): void {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const stream of this.streams) stream.destroy();
    this.streams.clear();
  }

  /** Starts the host if none runs; replaces one of another version when it has nothing to do. */
  private ensureHost(): Promise<void> {
    return this.starting ??= this.startHost().finally(() => { this.starting = undefined; });
  }
  private async startHost(): Promise<void> {
    try {
      const reply = await this.exchange('ping');
      const state = reply.result as { busy?: boolean } | undefined;
      if (reply.version === APP_VERSION || state?.busy) return;
      // An idle host of another build steps aside so this build's master answers.
      if (!(await this.exchange('shutdown')).result) return;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try { await this.exchange('ping'); await new Promise(resolve => setTimeout(resolve, 100)); }
        catch (error) { if ((error as { statusCode?: number }).statusCode === 503) break; throw error; }
      }
    } catch (error) { if ((error as { statusCode?: number }).statusCode !== 503) throw error; }
    const entry = this.options.hostEntry ?? fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../index.ts' : '../index.js', import.meta.url));
    const stateDir = (await this.hostPaths()).stateDir;
    const args = isSea() ? ['--master-host', stateDir] : [...process.execArgv.filter(arg => !/^--inspect(?:-brk|-port|-publish-uid)?(?:=|$)/.test(arg)), entry, '--master-host', stateDir];
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env: process.env });
    let spawnError: Error | undefined;
    child.on('error', error => { spawnError = error; });
    child.unref();
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 30_000);
    for (;;) {
      if (spawnError) throw spawnError;
      try { await this.exchange('ping'); return; }
      catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 503 || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  private async hostPaths() { return this.paths ??= await masterPaths(this.options.stateDir); }

  private async credential(): Promise<string> {
    if (this.closed) throw failure('Master connection is closed.', 503);
    const paths = await this.hostPaths();
    let file;
    try { file = await open(paths.token, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw failure('The master host is not running.', 503, true); throw error; }
    try {
      const info = await file.stat();
      if (!info.isFile() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid()) || info.size !== 64) throw new Error('Invalid master host credentials.');
      return await file.readFile('utf8');
    } finally { await file.close(); }
  }

  private async exchange(method: string, args: Record<string, unknown> = {}): Promise<MasterHostReply> {
    const token = await this.credential();
    const paths = await this.hostPaths();
    const web = this.options.credentials();
    const body = JSON.stringify({ protocol: MASTER_PROTOCOL, method, args, ...(web ? { web } : {}) });
    const reply = await new Promise<MasterHostReply>((resolve, reject) => {
      const req = request({ socketPath: paths.socket, method: 'POST', path: '/rpc', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_REPLY) res.destroy(new Error('Master reply is too large.')); else chunks.push(chunk); });
        res.on('error', reject);
        res.on('end', () => {
          if (res.statusCode !== 200) { reject(failure('The master host refused the request.', res.statusCode === 403 ? 503 : res.statusCode || 502)); return; }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as MasterHostReply); } catch { reject(new Error('Invalid master host response.')); }
        });
      });
      req.setTimeout(60_000, () => req.destroy(new Error('Master host response timed out.')));
      req.on('error', error => reject(Object.assign(error, { statusCode: 503, ...(['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '') ? { hostAbsent: true } : {}) })));
      req.end(body);
    });
    if (reply.stateDir !== paths.stateDir) throw failure('The master host is incompatible.', 503);
    if (reply.protocol !== MASTER_PROTOCOL) throw failure('마스터가 업데이트를 기다리는 중입니다. 진행 중인 일이 끝나면 새 버전으로 바뀝니다.', 503);
    if (reply.error) throw failure(reply.error.message, reply.error.statusCode);
    return reply;
  }
}
