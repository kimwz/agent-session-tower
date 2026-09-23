import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { APP_VERSION } from '../../shared/app-identity.js';
import { acquireStateLock, MonitorAlreadyRunning } from '../instance/state-lock.js';
import { MAX_RPC_BYTES, RUNNER_PROTOCOL, runnerPaths } from '../runs/runner-protocol.js';
import { WorkspaceTerminals } from '../workspace-terminals.js';

/** The terminal host shares the worker's owner-only socket directory but has its own lock, socket and credential. */
export async function terminalHostPaths(stateDir: string) {
  const runner = await runnerPaths(stateDir);
  return { stateDir: runner.stateDir, socket: join(runner.directory, 'terminals.sock'), token: join(runner.directory, 'terminals-token'), runtime: join(runner.stateDir, 'terminal-runtime') };
}

export interface TerminalHostReply {
  protocol: number;
  stateDir: string;
  instance: string;
  version: string;
  result?: unknown;
  error?: { message: string; statusCode: number };
}

export interface TerminalHostOptions {
  stateDir: string;
  terminals: WorkspaceTerminals;
  idleMs?: number;
  onIdle?: () => void | Promise<void>;
  releaseStateLock?: () => Promise<void>;
}

/**
 * Owns interactive shells so the execution worker can be replaced without closing them.
 * Only the authenticated web process talks to it; it exits once no shell is left and no web has called for a while.
 */
export async function startTerminalHost(options: TerminalHostOptions) {
  const paths = await terminalHostPaths(options.stateDir);
  const release = options.releaseStateLock ?? await acquireStateLock(paths.runtime, 0);
  const instance = randomUUID();
  const token = randomBytes(32).toString('hex');
  let lastRequest = Date.now();
  let pending = 0;
  let closing = false;
  const dispatch = async (method: string, args: unknown[]) => {
    switch (method) {
      case 'ping': return { active: options.terminals.hasActive() };
      case 'create': return options.terminals.create(args[0] as string, args[1], args[2]);
      case 'input': return options.terminals.input(args[0] as string, args[1]);
      case 'resize': return options.terminals.resize(args[0] as string, args[1], args[2]);
      case 'close': return options.terminals.close(args[0] as string);
    }
    throw Object.assign(new Error('Unknown terminal operation.'), { statusCode: 400 });
  };
  const server = createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (closing || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(403); res.end(); return; }
    lastRequest = Date.now();
    const events = req.url?.match(/^\/terminals\/([0-9a-f-]{36})\/events$/);
    if (req.method === 'GET' && events) {
      const cursor = req.headers['last-event-id'];
      try {
        if (Array.isArray(cursor)) throw Object.assign(new Error('Invalid terminal cursor.'), { statusCode: 400 });
        options.terminals.attach(events[1], res, cursor);
      } catch (error) { res.writeHead((error as { statusCode?: number }).statusCode || 500); res.end(); }
      return;
    }
    if (req.method !== 'POST' || req.url !== '/rpc') { res.writeHead(404); res.end(); return; }
    pending++;
    const reply: TerminalHostReply = { protocol: RUNNER_PROTOCOL, stateDir: paths.stateDir, instance, version: APP_VERSION };
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_RPC_BYTES) throw Object.assign(new Error('Terminal request too large.'), { statusCode: 413 });
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { protocol?: number; method?: string; args?: unknown[] };
      if (input.protocol !== RUNNER_PROTOCOL || typeof input.method !== 'string' || !Array.isArray(input.args)) throw Object.assign(new Error('Incompatible terminal request.'), { statusCode: 409 });
      reply.result = await dispatch(input.method, input.args) ?? null;
    } catch (error) {
      const value = error as { message?: string; statusCode?: number };
      reply.error = { message: value.message ?? 'Terminal operation failed.', statusCode: value.statusCode ?? 500 };
    } finally { pending--; lastRequest = Date.now(); }
    if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply)); }
  });
  server.requestTimeout = 0;
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  const close = async (idle = false) => {
    if (closing) return;
    closing = true;
    if (idleTimer) clearInterval(idleTimer);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await unlink(paths.socket).catch(() => {});
    await unlink(paths.token).catch(() => {});
    try { if (idle) await options.onIdle?.(); } finally { await release(); }
  };
  try {
    await unlink(paths.socket).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    await unlink(paths.token).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    await writeFile(paths.token, token, { flag: 'wx', mode: 0o600 });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(paths.socket, () => { server.off('error', reject); resolve(); }); });
    await chmod(paths.socket, 0o600);
    if (options.onIdle) {
      idleTimer = setInterval(() => {
        if (closing || pending || options.terminals.hasActive() || Date.now() - lastRequest < (options.idleMs ?? 30_000)) return;
        void close(true).catch(error => { console.error('Terminal host idle cleanup failed:', error); });
      }, 1000);
      idleTimer.unref();
    }
    return { instance, socketPath: paths.socket, close };
  } catch (error) { await close(); throw error; }
}

export async function runTerminalHost(stateDir: string): Promise<void> {
  const paths = await terminalHostPaths(stateDir);
  let release: () => Promise<void>;
  try { release = await acquireStateLock(paths.runtime, 0); }
  catch (error) { if (error instanceof MonitorAlreadyRunning) return; throw error; }
  const terminals = new WorkspaceTerminals({ keepAliveOnDisconnect: true });
  try {
    await startTerminalHost({ stateDir, terminals, releaseStateLock: release, onIdle: () => { terminals.dispose(); } });
    // Shells belong to the owner's explicit close, never to a parent terminal or a web shutdown.
    process.on('SIGINT', () => {});
    process.on('SIGTERM', () => {});
  } catch (error) { terminals.dispose(); await release(); throw error; }
}
