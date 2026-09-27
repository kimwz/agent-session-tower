import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';
import type { Snapshot } from '../../shared/types.js';

export interface Table { name: string; columns: string[]; rows: Array<Array<string | number | null>> }
export interface QueryResult { columns: string[]; rows: Array<Record<string, unknown>>; truncated: boolean }
type Reply = { ok: boolean; error?: string } & Partial<QueryResult>;

const TIMEOUT_MS = 2000;
/** CPU seconds a lookup process may use in its whole life; after that it is replaced by the next query. */
const CPU_LIMIT_S = 120;
const MAX_ROWS = 500;
const MAX_BYTES = 256 * 1024;

/** Node options a child needs to run this build (a TypeScript loader in development), and nothing else. */
function loaderArgs(argv: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const joined = /^--(import|require|loader|experimental-loader)=(.+)$/.exec(arg);
    const split = /^--(import|require|loader|experimental-loader)$/.exec(arg);
    const flag = joined ? `--${joined[1]}=${joined[2]}` : split && argv[index + 1] ? `--${split[1]}=${argv[++index]}` : undefined;
    if (flag && !seen.has(flag)) { seen.add(flag); out.push(flag); }
  }
  return out;
}

/**
 * Whether this Node.js has SQLite's authorizer, which keeps lookups read-only. Node.js 22 has none; the master then
 * looks things up through its other tools.
 */
export function lookupsSupported(): boolean {
  try {
    const sqlite = process.getBuiltinModule('node:sqlite') as { DatabaseSync: { prototype: { setAuthorizer?: unknown } }; constants?: Record<string, number> };
    return typeof sqlite.DatabaseSync.prototype.setAuthorizer === 'function'
      && ['SQLITE_SELECT', 'SQLITE_READ', 'SQLITE_FUNCTION', 'SQLITE_OK', 'SQLITE_DENY'].every(name => typeof sqlite.constants?.[name] === 'number');
  } catch { return false; }
}

/**
 * A read-only SQL view of what the owner's pages see, for the master's quick questions. The database lives in a
 * `--master-query` process, killed when a query runs too long (SQLite cannot be interrupted from JavaScript). It is
 * rebuilt from the live snapshot whenever that changed since the last query, so deletions and sharing changes need no
 * bookkeeping.
 */
export class ReadDatabase {
  private child?: ChildProcessWithoutNullStreams;
  private builtFrom?: string;
  private sequence = 0;
  /** Requests waiting for an answer, each with the process it was sent to. */
  private readonly pending = new Map<number, { child: ChildProcessWithoutNullStreams; done: (reply: Reply) => void }>();

  constructor(private readonly options: { entry?: string; cpuLimitSeconds?: number } = {}) {}
  private get entry() { return this.options.entry ?? fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../index.ts' : '../index.js', import.meta.url)); }

  /** `version` tells whether the tables changed since the last build. */
  async query(sql: string, version: string, tables: () => Table[]): Promise<QueryResult> {
    if (typeof sql !== 'string' || !sql.trim() || sql.length > 20_000) throw Object.assign(new Error('SQL을 한 문장으로 주세요.'), { statusCode: 400 });
    if (!this.child || this.builtFrom !== version) {
      const built = await this.send({ type: 'rebuild', tables: tables() }, 10_000);
      if (!built.ok) throw Object.assign(new Error(built.error ?? 'The lookup data could not be prepared.'), { statusCode: 503 });
      this.builtFrom = version;
    }
    const reply = await this.send({ type: 'query', sql, maxRows: MAX_ROWS, maxBytes: MAX_BYTES }, TIMEOUT_MS);
    if (!reply.ok) throw Object.assign(new Error(reply.error ?? 'The query failed.'), { statusCode: 400 });
    return { columns: reply.columns ?? [], rows: reply.rows ?? [], truncated: Boolean(reply.truncated) };
  }

  close(): void { this.stop(); }

  private stop(): void {
    const child = this.child;
    this.child = undefined;
    this.builtFrom = undefined;
    child?.kill('SIGKILL');
  }

  private send(message: Record<string, unknown>, timeoutMs: number): Promise<Reply> {
    const child = this.process();
    const id = ++this.sequence;
    return new Promise(resolve => {
      // A query that runs too long ends with its process; the next one starts a fresh process and rebuilds.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (this.child === child) this.stop(); else child.kill('SIGKILL');
        resolve({ ok: false, error: `The query took longer than ${timeoutMs / 1000} seconds and was stopped.` });
      }, timeoutMs);
      this.pending.set(id, { child, done: reply => { clearTimeout(timer); resolve(reply); } });
      child.stdin.write(`${JSON.stringify({ ...message, id })}\n`);
    });
  }

  private process(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const args = isSea() ? ['--master-query'] : [...loaderArgs(process.execArgv), this.entry, '--master-query'];
    // SQLite cannot be interrupted, and a process whose host died keeps running what it runs. The kernel's CPU limit
    // ends it whatever happens to its host; before that, it notices a vanished host between requests and exits.
    const limit = Math.max(1, Math.floor(this.options.cpuLimitSeconds ?? CPU_LIMIT_S));
    const child = spawn('/bin/sh', ['-c', `ulimit -t ${limit} 2>/dev/null; exec "$0" "$@"`, process.execPath, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume();
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr]) (stream as unknown as { unref?: () => void }).unref?.();
    createInterface({ input: child.stdout }).on('line', line => {
      let reply: { id?: number } & Reply;
      try { reply = JSON.parse(line); } catch { return; }
      const waiting = typeof reply.id === 'number' ? this.pending.get(reply.id) : undefined;
      if (waiting?.child === child) { this.pending.delete(reply.id!); waiting.done(reply); }
    });
    child.stdin.on('error', () => {});
    child.on('exit', () => {
      if (this.child === child) { this.child = undefined; this.builtFrom = undefined; }
      // Only what this process was asked; a replacement's requests carry on.
      for (const [id, waiting] of this.pending) if (waiting.child === child) { this.pending.delete(id); waiting.done({ ok: false, error: 'The lookup process stopped.' }); }
    });
    // The host's own exit takes the process with it.
    const kill = () => child.kill('SIGKILL');
    process.once('exit', kill);
    child.once('exit', () => process.off('exit', kill));
    this.child = child;
    return child;
  }
}

const cut = (value: unknown, length: number) => typeof value === 'string' ? value.slice(0, length) : null;
const flag = (value: unknown) => value ? 1 : 0;

/**
 * The tables and columns the master may read: only what the pages receive, texts shortened. Every string, names and
 * paths included, passes `hide` before it enters the database, so no query can take a secret apart.
 */
export function tablesFrom(local: Snapshot | undefined, nodes: ReadonlyMap<string, Snapshot>, hide: (text: string) => string, extra: Table[] = []): Table[] {
  // Long texts are hidden whole and only then shortened, so a key at the cut is never left half-recognised.
  const text = (value: unknown, length: number) => typeof value === 'string' ? cut(hide(value), length) : null;
  return rawTables(local, nodes, extra, text).map(table => ({ ...table, rows: table.rows.map(row => row.map(cell => typeof cell === 'string' ? hide(cell) : cell)) }));
}

function rawTables(local: Snapshot | undefined, nodes: ReadonlyMap<string, Snapshot>, extra: Table[], text: (value: unknown, length: number) => string | null): Table[] {
  const all: Array<[string, Snapshot]> = [...(local ? [['', local] as [string, Snapshot]] : []), ...nodes];
  const names = new Map((local?.nodes ?? []).map(node => [node.id, node.label || node.name]));
  return [
    { name: 'computers', columns: ['node', 'name', 'status', 'version', 'last_seen_at', 'streaming'], rows: [
      ['', local?.hostname ?? 'this computer', 'this computer', local?.version ?? null, null, 1],
      ...(local?.nodes ?? []).map(node => [node.id, node.label || node.name, node.status, node.version ?? null, node.lastSeenAt ?? null, flag(node.streaming)]),
    ] },
    { name: 'sessions', columns: ['node', 'computer', 'id', 'provider', 'project', 'cwd', 'title', 'status', 'outcome', 'closed', 'is_subagent', 'launched_by', 'created_at', 'updated_at', 'last_request_at', 'last_completed_at', 'message_count', 'last_message'],
      rows: all.flatMap(([node, snapshot]) => snapshot.sessions.map(session => [node, node ? names.get(node) ?? node : snapshot.hostname, session.id, session.provider, session.project, session.cwd,
        text(session.customTitle || session.title, 200), session.status, session.outcome ?? null, flag(session.closed), flag(session.isSubagent),
        session.launchedByAgent ? 'agent' : session.launchedBy?.kind ?? null, session.createdAt, session.updatedAt, session.lastRequestAt ?? null, session.lastCompletedAt ?? null,
        session.messageCount, text(session.lastMessage, 300)])) },
    { name: 'runs', columns: ['node', 'id', 'session_id', 'status', 'origin', 'model', 'prompt', 'created_at', 'started_at', 'finished_at', 'error'],
      rows: all.flatMap(([node, snapshot]) => snapshot.runs.map(run => [node, run.id, run.sessionId, run.status, run.origin?.kind ?? null, run.model ?? null,
        text(run.prompt, 300), run.createdAt, run.startedAt ?? null, run.finishedAt ?? null, text(run.error, 300)])) },
    { name: 'auto_prompts', columns: ['node', 'id', 'status', 'cwd', 'session_id', 'run_id', 'created_at', 'updated_at', 'prompt', 'error'],
      rows: all.flatMap(([node, snapshot]) => (snapshot.autoPrompts ?? []).map(job => [node, job.id, job.status, job.cwd ?? null, job.sessionId ?? null, job.runId ?? null,
        job.createdAt, job.updatedAt, text(job.prompt, 300), text(job.error, 300)])) },
    { name: 'folders', columns: ['node', 'cwd', 'title', 'pinned', 'hidden'],
      rows: all.flatMap(([node, snapshot]) => (snapshot.groups ?? []).map(group => [node, group.cwd, text(group.title, 200), flag(group.pinned), flag(group.hidden)])) },
    { name: 'triggers', columns: ['node', 'id', 'name', 'kind', 'enabled', 'next_run_at', 'last_status', 'last_at', 'updated_at', 'error'],
      rows: all.flatMap(([node, snapshot]) => (snapshot.triggers?.triggers ?? []).map(trigger => [node, trigger.id, text(trigger.name, 200), trigger.kind, flag(trigger.enabled),
        trigger.nextRunAt ?? null, trigger.lastEvent?.status ?? null, trigger.lastEvent?.occurredAt ?? null, trigger.updatedAt, text(trigger.error, 300)])) },
    { name: 'trigger_runs', columns: ['node', 'id', 'trigger_id', 'trigger_name', 'status', 'occurred_at', 'summary', 'session_id', 'error'],
      rows: all.flatMap(([node, snapshot]) => [...(snapshot.triggers?.recent ?? []), ...(snapshot.triggers?.updated ?? [])]
        .filter((event, index, list) => list.findIndex(item => item.id === event.id) === index)
        .map(event => [node, event.id, event.triggerId, text(event.triggerName, 200), event.status, event.occurredAt, text(event.summary, 300),
          event.dispatch?.sessionId ?? event.dispatch?.createdSessionId ?? null, text(event.error, 300)])) },
    ...extra,
  ];
}

/** Described to the model once, so it can write queries without looking. */
export const READ_SCHEMA = `Tables (read-only SQLite; node '' is this computer, otherwise a joined computer's id):
- computers(node, name, status, version, last_seen_at, streaming)
- sessions(node, computer, id, provider, project, cwd, title, status['working'|'idle'|'completed'|'error'], outcome['done'|'needsOwner'|'blocked'|'progress'|null], closed, is_subagent, launched_by['agent'|'trigger'|null], created_at, updated_at, last_request_at, last_completed_at, message_count, last_message)
- runs(node, id, session_id, status['queued'|'running'|'completed'|'error'|'cancelled'], origin, model, prompt, created_at, started_at, finished_at, error)
- auto_prompts(node, id, status, cwd, session_id, run_id, created_at, updated_at, prompt, error)
- folders(node, cwd, title, pinned, hidden)
- triggers(node, id, name, kind, enabled, next_run_at, last_status, last_at, updated_at, error)
- trigger_runs(node, id, trigger_id, trigger_name, status, occurred_at, summary, session_id, error)
- conversation(order_no, at, kind, text) — this conversation with the owner
- delegated(id, title, state, session_id, node, created_at) — work you handed out
Times are ISO-8601 UTC text. Texts are shortened. One SELECT per call; at most ${MAX_ROWS} rows.`;
