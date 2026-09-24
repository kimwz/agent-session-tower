import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { request, type ClientRequest, type ServerResponse } from 'node:http';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';
import { MAX_RPC_BYTES, RUNNER_PROTOCOL } from '../runs/runner-protocol.js';
import type { TerminalOwner, TerminalSummary, WorkspaceTerminalBackend } from '../workspace-terminals.js';
import { terminalHostPaths, type TerminalHostReply } from './host.js';

interface Options {
  stateDir: string;
  /** Shells an older execution worker still owns. They stay reachable until the owner closes them. */
  legacy?: WorkspaceTerminalBackend;
  hostEntry?: string;
  startupTimeoutMs?: number;
}
const failure = (message: string, statusCode: number, hostAbsent = false) => Object.assign(new Error(message), { statusCode, ...(hostAbsent ? { hostAbsent } : {}) });

/**
 * The web side of the terminal host. New shells always start in the host; IDs the host does not know
 * are passed to the legacy worker so shells opened before this release keep working.
 */
export class TerminalHostClient implements WorkspaceTerminalBackend {
  private paths?: Awaited<ReturnType<typeof terminalHostPaths>>;
  private starting?: Promise<void>;
  private readonly streams = new Set<ClientRequest>();
  private closed = false;
  constructor(private readonly options: Options) {}

  async create(cwd: string, cols: unknown, rows: unknown, owner?: TerminalOwner): Promise<{ id: string }> {
    await this.ensureHost();
    return await this.call('create', [cwd, cols, rows, ...(owner ? [owner] : [])]) as { id: string };
  }
  /** Shells of the terminal host; none when no host runs, and undefined for a host too old to list them. */
  async list(): Promise<TerminalSummary[] | undefined> {
    try { return await this.call('list') as TerminalSummary[]; }
    catch (error) {
      const value = error as { statusCode?: number; hostAbsent?: boolean };
      if (value.hostAbsent) return [];
      if (value.statusCode === 400) return undefined;
      throw error;
    }
  }
  async input(id: string, data: unknown): Promise<void> { await this.route(id, () => this.call('input', [id, data]), legacy => legacy.input(id, data)); }
  async resize(id: string, cols: unknown, rows: unknown): Promise<void> { await this.route(id, () => this.call('resize', [id, cols, rows]), legacy => legacy.resize(id, cols, rows)); }
  async close(id: string): Promise<void> { await this.route(id, () => this.call('close', [id]), legacy => legacy.close(id)); }
  async attach(id: string, response: ServerResponse, cursor?: string): Promise<void> {
    try { await this.pipe(id, response, cursor); }
    catch (error) {
      if (!this.options.legacy || (error as { statusCode?: number }).statusCode !== 404 || response.headersSent) throw error;
      await this.options.legacy.attach(id, response, cursor);
    }
  }
  dispose(): void {
    this.closed = true;
    for (const stream of this.streams) stream.destroy();
    this.streams.clear();
    this.options.legacy?.dispose();
  }

  private async route(id: string, host: () => Promise<unknown>, legacy: (backend: WorkspaceTerminalBackend) => unknown): Promise<void> {
    try { await host(); }
    catch (error) {
      // An unknown ID, or no running host at all, means the shell can only belong to the older worker.
      // A timeout is different: the host may have acted, so the request is not sent anywhere else.
      const value = error as { statusCode?: number; hostAbsent?: boolean };
      if (!this.options.legacy || (value.statusCode !== 404 && !value.hostAbsent)) throw error;
      await legacy(this.options.legacy);
    }
  }

  /** A host that exited while idle is started again only when a new shell is requested. */
  private ensureHost(): Promise<void> {
    return this.starting ??= this.startHost().finally(() => { this.starting = undefined; });
  }
  private async startHost(): Promise<void> {
    try { await this.call('ping'); return; }
    catch (error) { if ((error as { statusCode?: number }).statusCode !== 503) throw error; }
    const entry = this.options.hostEntry ?? fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../index.ts' : '../index.js', import.meta.url));
    const stateDir = (await this.hostPaths()).stateDir;
    const args = isSea() ? ['--terminal-host', stateDir] : [...process.execArgv.filter(arg => !/^--inspect(?:-brk|-port|-publish-uid)?(?:=|$)/.test(arg)), entry, '--terminal-host', stateDir];
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env: process.env });
    let spawnError: Error | undefined;
    child.on('error', error => { spawnError = error; });
    child.unref();
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 30_000);
    for (;;) {
      if (spawnError) throw spawnError;
      try { await this.call('ping'); return; }
      catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 503 || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  private async hostPaths() { return this.paths ??= await terminalHostPaths(this.options.stateDir); }

  private async credential(): Promise<string> {
    if (this.closed) throw failure('Terminal connection is closed.', 503);
    const paths = await this.hostPaths();
    let file;
    try { file = await open(paths.token, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw failure('The terminal host is not running.', 503, true); throw error; }
    try {
      const info = await file.stat();
      if (!info.isFile() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid()) || info.size !== 64) throw new Error('Invalid terminal host credentials.');
      return await file.readFile('utf8');
    } finally { await file.close(); }
  }

  /** The running host's version, without starting one; undefined when none runs. */
  async hostVersion(): Promise<string | undefined> {
    try { return (await this.exchange('ping')).version; } catch { return undefined; }
  }

  private async call(method: string, args: unknown[] = []): Promise<unknown> { return (await this.exchange(method, args)).result; }

  private async exchange(method: string, args: unknown[] = []): Promise<TerminalHostReply> {
    const token = await this.credential();
    const paths = await this.hostPaths();
    const body = JSON.stringify({ protocol: RUNNER_PROTOCOL, method, args });
    const reply = await new Promise<TerminalHostReply>((resolve, reject) => {
      const req = request({ socketPath: paths.socket, method: 'POST', path: '/rpc', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_RPC_BYTES) res.destroy(new Error('Terminal reply is too large.')); else chunks.push(chunk); });
        res.on('error', reject);
        res.on('end', () => {
          if (res.statusCode !== 200) { reject(failure('The terminal host refused the request.', res.statusCode === 403 ? 503 : res.statusCode || 502)); return; }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as TerminalHostReply); } catch { reject(new Error('Invalid terminal host response.')); }
        });
      });
      req.setTimeout(60_000, () => req.destroy(new Error('Terminal host response timed out.')));
      req.on('error', error => reject(Object.assign(error, { statusCode: 503, ...(['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '') ? { hostAbsent: true } : {}) })));
      req.end(body);
    });
    if (reply.protocol !== RUNNER_PROTOCOL || reply.stateDir !== paths.stateDir) throw failure('The terminal host is incompatible.', 503);
    if (reply.error) throw failure(reply.error.message, reply.error.statusCode);
    return reply;
  }

  private async pipe(id: string, response: ServerResponse, cursor?: string): Promise<void> {
    const token = await this.credential().catch(error => { throw (error as { statusCode?: number }).statusCode === 503 ? failure('터미널을 찾을 수 없습니다. 새 터미널을 여세요.', 404) : error; });
    const paths = await this.hostPaths();
    if (response.destroyed || response.writableEnded) return;
    await new Promise<void>((resolve, reject) => {
      const req = request({ socketPath: paths.socket, path: `/terminals/${encodeURIComponent(id)}/events`, headers: { authorization: `Bearer ${token}`, ...(cursor ? { 'last-event-id': cursor } : {}) } }, upstream => {
        if (upstream.statusCode !== 200) { upstream.resume(); reject(failure('터미널에 연결하지 못했습니다.', upstream.statusCode || 502)); return; }
        if (response.destroyed || response.writableEnded) { upstream.destroy(); resolve(); return; }
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        upstream.on('error', () => response.destroy());
        upstream.pipe(response);
        resolve();
      });
      this.streams.add(req);
      req.once('close', () => this.streams.delete(req));
      response.once('close', () => req.destroy());
      // A host that is not running cannot own this terminal.
      req.once('error', error => { if (!response.headersSent) reject((error as NodeJS.ErrnoException).code === 'ECONNREFUSED' || (error as NodeJS.ErrnoException).code === 'ENOENT' ? failure('터미널을 찾을 수 없습니다. 새 터미널을 여세요.', 404) : error); else response.destroy(); });
      req.end();
    });
  }
}
