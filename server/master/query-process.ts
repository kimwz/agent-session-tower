import { createInterface } from 'node:readline';

/** The authorizer is newer than the Node.js type definitions this project builds with. */
interface Authorizing { setAuthorizer?(callback: ((action: number) => number) | null): void }

/**
 * The master's quick-lookup database, in its own process (`--master-query`): a runaway query inside SQLite cannot be
 * interrupted from JavaScript, but a process can always be killed. It reads one JSON request per line on stdin and
 * answers one JSON line on stdout; it ends when its host closes stdin.
 *
 * A query runs under SQLite's authorizer, which allows only reading (SELECT, reading columns, functions): no writes,
 * PRAGMA, ATTACH or recursive queries. Only the first statement is ever compiled, so any text after it is refused.
 */
export async function runMasterQuery(): Promise<void> {
  const { DatabaseSync, constants } = await import('node:sqlite');
  const codes = constants as unknown as Record<string, number>;
  const allowed = new Set([codes.SQLITE_SELECT, codes.SQLITE_READ, codes.SQLITE_FUNCTION]);
  const bare = (text: string) => text.trim().replace(/;\s*$/, '').trim();
  let db: InstanceType<typeof DatabaseSync> | undefined;
  const reply = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  // A host that vanished (killed, not closed) is noticed between requests: this process then belongs to no one.
  const parent = process.ppid;
  setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 2000).unref();
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    let message: { id?: number; type?: string; tables?: Array<{ name: string; columns: string[]; rows: unknown[][] }>; sql?: string; maxRows?: number; maxBytes?: number };
    try { message = JSON.parse(line); } catch { continue; }
    try {
      if (message.type === 'rebuild') {
        db?.close();
        db = new DatabaseSync(':memory:');
        for (const table of message.tables ?? []) {
          if (!/^[a-z_]+$/.test(table.name) || table.columns.some(column => !/^[a-z_]+$/.test(column))) throw new Error('Invalid table.');
          db.exec(`CREATE TABLE ${table.name} (${table.columns.map(column => `${column} ANY`).join(', ')})`);
          const insert = db.prepare(`INSERT INTO ${table.name} VALUES (${table.columns.map(() => '?').join(', ')})`);
          db.exec('BEGIN');
          for (const row of table.rows) insert.run(...(row as Array<string | number | null>));
          db.exec('COMMIT');
        }
        reply({ id: message.id, ok: true });
        continue;
      }
      if (!db) throw new Error('No data yet.');
      const authorizing = db as unknown as Authorizing;
      if (typeof authorizing.setAuthorizer !== 'function' || !allowed.size || allowed.has(undefined as unknown as number)) throw new Error('This Node.js has no SQLite authorizer; use the other tools.');
      authorizing.setAuthorizer(action => allowed.has(action) ? codes.SQLITE_OK : codes.SQLITE_DENY);
      try {
        const sql = String(message.sql ?? '');
        const statement = db.prepare(sql);
        if (bare(statement.sourceSQL) !== bare(sql)) throw new Error('Only one statement is allowed.');
        const rows: unknown[] = []; let bytes = 0; let truncated = false;
        const all = typeof statement.iterate === 'function' ? statement.iterate() : statement.all();
        for (const row of all) {
          const size = Buffer.byteLength(JSON.stringify(row));
          if (rows.length >= (message.maxRows ?? 500) || bytes + size > (message.maxBytes ?? 256 * 1024)) { truncated = true; break; }
          bytes += size; rows.push(row);
        }
        const columns = typeof statement.columns === 'function' ? statement.columns().map(column => column.name) : Object.keys(rows[0] ?? {});
        reply({ id: message.id, ok: true, columns, rows, truncated });
      } finally { authorizing.setAuthorizer(null); }
    } catch (error) { reply({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) }); }
  }
}
