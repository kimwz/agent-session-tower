import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { ServerResponse } from 'node:http';
import { loadWorkspacePty } from './workspace-pty-runtime.js';

interface Disposable { dispose(): void }
export interface WorkspacePty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: { exitCode: number }) => void): Disposable;
}
export interface TerminalSpawnOptions { cwd: string; cols: number; rows: number; name: string; env: Record<string, string> }
export type WorkspacePtyFactory = (shell: string, args: string[], options: TerminalSpawnOptions) => WorkspacePty | Promise<WorkspacePty>;
export interface WorkspaceTerminalOptions {
  spawnPty?: WorkspacePtyFactory;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  disconnectGraceMs?: number;
  maxTerminals?: number;
  /** A durable execution host keeps running shells until explicitly closed. */
  keepAliveOnDisconnect?: boolean;
}
/** Who opened a shell: this computer's own pages, or a controller over its link. */
export interface TerminalOwner {
  opener: string;
  /** A controller's request ID; sending the same request again answers with the same shell. */
  requestId?: string;
}
export interface TerminalSummary { id: string; cwd: string; opener: string; openedAt: string; exited: boolean }
export interface WorkspaceTerminalBackend {
  create(cwd: string, cols: unknown, rows: unknown, owner?: TerminalOwner): Promise<{ id: string }>;
  /** Shells with a known folder and opener; undefined when the shells' owner is too old to say. */
  list?(): Promise<TerminalSummary[] | undefined> | TerminalSummary[] | undefined;
  attach(id: string, response: ServerResponse, lastEventId?: string): void | Promise<void>;
  input(id: string, data: unknown): void | Promise<void>;
  resize(id: string, cols: unknown, rows: unknown): void | Promise<void>;
  close(id: string): void | Promise<void>;
  dispose(): void;
}
interface Output { id: number; data: string }
interface Stream { response: ServerResponse; blocked: boolean; queue: string[]; bytes: number }
interface Terminal {
  cwd: string; opener: string; openedAt: string; request?: string;
  pty: WorkspacePty; output: Output[]; bytes: number; sequence: number; exitCode?: number;
  streams: Set<Stream>; subscriptions: Disposable[]; expiry?: ReturnType<typeof setTimeout>;
  inputRate: { at: number; count: number; bytes: number };
}
const BUFFER_LIMIT = 256 * 1024;
/** Windows on this computer and on every controller can watch one shell together. */
const MAX_STREAMS = 6;
function failure(message: string, statusCode = 400): Error { return Object.assign(new Error(message), { statusCode }); }
function frame(event: string, data: unknown, id?: number): string { return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; }

export function terminalSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || Number(cols) < 2 || Number(cols) > 500 || Number(rows) < 1 || Number(rows) > 200) {
    throw failure('터미널 크기가 올바르지 않습니다.');
  }
  return { cols: Number(cols), rows: Number(rows) };
}

/** Only authenticated routes expose PTYs; a durable host may retain them across UI disconnects. */
export class WorkspaceTerminals {
  private readonly terminals = new Map<string, Terminal>();
  /** Creations in progress or done, by opener and request ID. */
  private readonly requests = new Map<string, Promise<{ id: string }>>();
  private pending = 0;
  private disposed = false;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  constructor(private readonly options: WorkspaceTerminalOptions = {}) {
    this.heartbeat = setInterval(() => {
      for (const terminal of this.terminals.values()) for (const stream of terminal.streams) this.send(stream, ': heartbeat\n\n');
    }, 15_000);
    this.heartbeat.unref();
  }

  create(cwd: string, cols: unknown, rows: unknown, owner: TerminalOwner = { opener: 'local' }): Promise<{ id: string }> {
    if (!owner.requestId) return this.start(cwd, cols, rows, owner);
    const key = `${owner.opener}\u0000${owner.requestId}`;
    const known = this.requests.get(key);
    if (known) return known;
    const started = this.start(cwd, cols, rows, owner);
    this.requests.set(key, started);
    started.catch(() => { if (this.requests.get(key) === started) this.requests.delete(key); });
    return started;
  }

  list(): TerminalSummary[] {
    return [...this.terminals].map(([id, terminal]) => ({ id, cwd: terminal.cwd, opener: terminal.opener, openedAt: terminal.openedAt, exited: terminal.exitCode !== undefined }));
  }

  private async start(cwd: string, cols: unknown, rows: unknown, owner: TerminalOwner): Promise<{ id: string }> {
    const size = terminalSize(cols, rows);
    if (this.disposed) throw failure('터미널 서버가 종료되었습니다.', 503);
    if (this.terminals.size + this.pending >= (this.options.maxTerminals ?? 8)) throw failure('열려 있는 터미널이 너무 많습니다. 사용하지 않는 터미널을 닫거나, 폴더의 ‘열린 터미널’에서 남아 있는 터미널을 끝내세요.', 429);
    this.pending++;
    try {
      const env = Object.fromEntries(Object.entries(this.options.env ?? process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      const windows = (this.options.platform ?? process.platform) === 'win32';
      const shell = windows ? 'powershell.exe' : env.SHELL && isAbsolute(env.SHELL) ? env.SHELL : '/bin/sh';
      const factory = this.options.spawnPty ?? (async (command, args, options) => (await loadWorkspacePty()).spawn(command, args, options));
      const pty = await factory(shell, windows ? [] : ['-l'], { ...size, cwd, name: 'xterm-256color', env: { ...env, TERM: 'xterm-256color' } });
      if (this.disposed) { pty.kill(); throw failure('터미널 서버가 종료되었습니다.', 503); }
      const id = randomUUID();
      const terminal: Terminal = { cwd, opener: owner.opener, openedAt: new Date().toISOString(), ...(owner.requestId ? { request: `${owner.opener}\u0000${owner.requestId}` } : {}),
        pty, output: [], bytes: 0, sequence: 0, streams: new Set(), subscriptions: [], inputRate: { at: Date.now(), count: 0, bytes: 0 } };
      this.terminals.set(id, terminal);
      terminal.subscriptions.push(pty.onData(data => this.output(terminal, data)), pty.onExit(({ exitCode }) => {
        terminal.exitCode = exitCode;
        for (const stream of terminal.streams) this.send(stream, frame('exit', { exitCode }));
        this.expire(id, terminal);
      }));
      this.expire(id, terminal);
      return { id };
    } catch (error) {
      if (error && typeof error === 'object' && 'statusCode' in error) throw error;
      throw failure('터미널을 시작하지 못했습니다. 서버의 셸 설정을 확인하세요.', 502);
    } finally { this.pending--; }
  }

  input(id: string, data: unknown): void {
    const terminal = this.active(id);
    if (typeof data !== 'string' || !data.length || Buffer.byteLength(data) > 16 * 1024) throw failure('터미널 입력은 16KB 이하여야 합니다.');
    this.rate(terminal, Buffer.byteLength(data));
    terminal.pty.write(data);
  }

  resize(id: string, cols: unknown, rows: unknown): void {
    const terminal = this.active(id);
    const size = terminalSize(cols, rows);
    this.rate(terminal, 0);
    terminal.pty.resize(size.cols, size.rows);
  }

  attach(id: string, response: ServerResponse, lastEventId?: string): void {
    const terminal = this.get(id);
    if (lastEventId !== undefined && (!/^\d{1,12}$/.test(lastEventId) || Number(lastEventId) > terminal.sequence)) throw failure('터미널 출력 위치가 올바르지 않습니다.');
    if (terminal.streams.size >= MAX_STREAMS) throw failure('터미널에 연결된 창이 너무 많습니다.', 429);
    if (terminal.expiry) clearTimeout(terminal.expiry);
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const stream: Stream = { response, blocked: false, queue: [], bytes: 0 };
    terminal.streams.add(stream);
    const close = () => {
      response.off('drain', drain);
      response.off('close', close);
      terminal.streams.delete(stream);
      stream.queue = []; stream.bytes = 0;
      if (!terminal.streams.size) this.expire(id, terminal);
    };
    const drain = () => {
      stream.blocked = false;
      while (stream.queue.length && !stream.blocked) {
        const next = stream.queue.shift()!;
        stream.bytes -= Buffer.byteLength(next);
        stream.blocked = !response.write(next);
      }
    };
    response.on('close', close);
    response.on('drain', drain);
    this.send(stream, ': connected\n\n');
    const cursor = lastEventId ? Number(lastEventId) : 0;
    if (terminal.output.length && cursor < terminal.output[0].id - 1) this.send(stream, frame('output', { data: '\r\n[Earlier terminal output was truncated]\r\n' }));
    for (const output of terminal.output) if (output.id > cursor) this.send(stream, frame('output', { data: output.data }, output.id));
    if (terminal.exitCode !== undefined) {
      this.send(stream, frame('exit', { exitCode: terminal.exitCode }));
      this.expire(id, terminal);
    }
  }

  close(id: string): void {
    const terminal = this.get(id);
    this.terminals.delete(id);
    if (terminal.request) this.requests.delete(terminal.request);
    if (terminal.expiry) clearTimeout(terminal.expiry);
    for (const subscription of terminal.subscriptions) subscription.dispose();
    if (terminal.exitCode === undefined) { try { terminal.pty.kill(); } catch { /* Already gone. */ } }
    for (const stream of terminal.streams) {
      this.send(stream, frame('exit', { exitCode: terminal.exitCode ?? 0 }));
      stream.response.end();
    }
    terminal.streams.clear();
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.heartbeat);
    for (const id of this.terminals.keys()) this.close(id);
  }

  hasActive(): boolean { return [...this.terminals.values()].some(terminal => terminal.exitCode === undefined); }

  keepAlive(): void {
    this.options.keepAliveOnDisconnect = true;
    for (const terminal of this.terminals.values()) {
      if (terminal.exitCode === undefined && terminal.expiry) { clearTimeout(terminal.expiry); terminal.expiry = undefined; }
    }
  }

  private get(id: string): Terminal {
    const terminal = this.terminals.get(id);
    if (!terminal) throw failure('터미널을 찾을 수 없습니다. 새 터미널을 여세요.', 404);
    return terminal;
  }
  private active(id: string): Terminal {
    const terminal = this.get(id);
    if (terminal.exitCode !== undefined) throw failure('종료된 터미널입니다. 새 터미널을 여세요.', 409);
    return terminal;
  }
  private rate(terminal: Terminal, bytes: number): void {
    const now = Date.now();
    if (now - terminal.inputRate.at >= 60_000) terminal.inputRate = { at: now, count: 0, bytes: 0 };
    terminal.inputRate.count++; terminal.inputRate.bytes += bytes;
    if (terminal.inputRate.count > 12_000 || terminal.inputRate.bytes > 2 * 1024 * 1024) throw failure('터미널 입력이 너무 많습니다. 잠시 후 다시 시도하세요.', 429);
  }
  private expire(id: string, terminal: Terminal): void {
    if (terminal.expiry) clearTimeout(terminal.expiry);
    if (!this.terminals.has(id)) return;
    if (this.options.keepAliveOnDisconnect && terminal.exitCode === undefined) return;
    terminal.expiry = setTimeout(() => { if (this.terminals.has(id)) this.close(id); }, this.options.disconnectGraceMs ?? 30_000);
    terminal.expiry.unref();
  }
  private output(terminal: Terminal, data: string): void {
    // Split large native chunks so both replay storage and slow-client queues stay bounded.
    for (let offset = 0; offset < data.length; offset += 8192) {
      const output = { id: ++terminal.sequence, data: data.slice(offset, offset + 8192) };
      terminal.output.push(output); terminal.bytes += Buffer.byteLength(frame('output', { data: output.data }, output.id));
      while (terminal.bytes > BUFFER_LIMIT && terminal.output.length) {
        const removed = terminal.output.shift()!;
        terminal.bytes -= Buffer.byteLength(frame('output', { data: removed.data }, removed.id));
      }
      for (const stream of terminal.streams) this.send(stream, frame('output', { data: output.data }, output.id));
    }
  }
  private send(stream: Stream, data: string): void {
    if (stream.response.destroyed || stream.response.writableEnded) return;
    if (!stream.blocked) { stream.blocked = !stream.response.write(data); return; }
    stream.bytes += Buffer.byteLength(data);
    if (stream.bytes > BUFFER_LIMIT * 2) { stream.response.destroy(); return; }
    stream.queue.push(data);
  }
}
