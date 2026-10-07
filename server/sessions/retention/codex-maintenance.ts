import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { delimiter } from 'node:path';
import { providerDirectories } from '../../providers/discovery.js';

export interface NativeThreadMetadata { id: string; path: string | null }
export interface CodexMaintenance {
  metadata(id: string): Promise<NativeThreadMetadata>;
  archive(id: string): Promise<void>;
  unarchive(id: string): Promise<void>;
  close(): Promise<void>;
}

/** This server never loads a thread. Archive cannot terminate somebody else's turn. */
export class CodexMaintenanceClient implements CodexMaintenance {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private buffer = '';
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private stopped = false;
  private closed: Promise<void>;
  private ready: Promise<void>;
  constructor(executable: string, home: string, private timeoutMs = 15_000, environment: NodeJS.ProcessEnv = process.env) {
    this.child = spawn(executable, ['app-server', '--stdio'], { env: { ...environment, PATH: providerDirectories(environment).join(delimiter), CODEX_HOME: home }, stdio: 'pipe', shell: false });
    // Native diagnostics can contain account details. They are never forwarded.
    this.child.stderr.resume();
    this.closed = new Promise(resolve => this.child.once('close', () => { this.fail(new Error('Native maintenance server closed.')); resolve(); }));
    this.child.once('error', () => this.fail(new Error('Native maintenance server failed to start.')));
    this.child.stdin.on('error', () => this.fail(new Error('Native maintenance transport failed.')));
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 4_000_000) { this.fail(new Error('Native maintenance response exceeded budget.')); return; }
      let end: number;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const value = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
          const waiter = typeof value.id === 'number' ? this.pending.get(value.id) : undefined;
          if (!waiter) continue;
          this.pending.delete(value.id!); clearTimeout(waiter.timer);
          if (value.error) waiter.reject(new Error(value.error.message || 'Native maintenance request failed.'));
          else waiter.resolve(value.result);
        } catch { this.fail(new Error('Invalid native maintenance response.')); }
      }
    });
    this.ready = this.request('initialize', { clientInfo: { name: 'tower_retention', version: '1' }, capabilities: { experimentalApi: true } }).then(async () => {
      this.child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
      const result = await this.request('thread/loaded/list', { limit: 1 }) as { data?: unknown[] };
      if (!Array.isArray(result.data) || result.data.length) throw new Error('Maintenance server must have no loaded threads.');
    });
    // best-effort: this observer only prevents an unhandled startup rejection; every operation awaits the original ready promise and propagates its error, and lease release closes this owned server.
    void this.ready.catch(() => undefined);
  }
  private fail(error: Error): void {
    this.stopped = true;
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
  }
  private request(method: string, params: object): Promise<unknown> {
    if (this.stopped) return Promise.reject(new Error('Native maintenance transport unavailable.'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Native maintenance ${method} timed out.`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => { if (error) this.fail(new Error('Native maintenance transport unavailable.')); });
    });
  }
  async metadata(id: string): Promise<NativeThreadMetadata> {
    await this.ready;
    const result = await this.request('thread/read', { threadId: id, includeTurns: false }) as { thread?: { id?: string; path?: string | null } };
    if (result.thread?.id !== id || (result.thread.path !== null && typeof result.thread.path !== 'string')) throw new Error('Invalid native thread metadata.');
    return { id, path: result.thread.path };
  }
  async archive(id: string): Promise<void> { await this.ready; await this.request('thread/archive', { threadId: id }); }
  async unarchive(id: string): Promise<void> { await this.ready; await this.request('thread/unarchive', { threadId: id }); }
  async close(): Promise<void> {
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    const terminate = setTimeout(() => this.child.kill('SIGTERM'), 1000);
    const kill = setTimeout(() => this.child.kill('SIGKILL'), 3000);
    try { await this.closed; } finally { clearTimeout(terminate); clearTimeout(kill); }
  }
}
