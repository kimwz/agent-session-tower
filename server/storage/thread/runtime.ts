import { createHash } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { parentPort } from 'node:worker_threads';
import { APP_VERSION } from '../../../shared/app-identity.js';
import {
  STORAGE_DATABASE_FORMAT, STORAGE_PROTOCOL,
  type AppliedMigration, type CommitDisposition, type OpenRequest, type OpenResult, type PrepareThreadResult, type ProbeResult, type ReceiptLookup, type SchemaState,
  type SnapshotThreadResult, type StorageBuildIdentity, type StorageErrorCode, type StorageInspection, type StoragePragmas, type ThreadError,
  type ThreadHello, type ThreadRequest, type ThreadResponse,
} from '../contract.js';
import type { DomainCommand, DomainReadContext, DomainWriteContext, StorageDomain } from '../domain.js';
import { CORE_SCOPE, migrationChecksum, migrationsOf, storageManifest } from '../schema.js';
import { authorityWriter, readAuthority } from './authority.js';

/**
 * The body of the storage thread. It runs only inside the captured bundle (`new Worker(source, { eval: true })`), owns
 * the single connection, and answers one request at a time. It says hello before it opens anything, opens only when
 * the worker asks after checking that hello, and changes the schema only on an explicit prepare.
 */

type Sqlite = typeof import('node:sqlite');
class ThreadFailure extends Error {
  constructor(readonly error: ThreadError) { super(error.message); }
}
const failure = (code: StorageErrorCode, message: string, disposition: CommitDisposition = 'not-committed', retryable = false) => new ThreadFailure({ code, message, disposition, retryable });

/** SQLite's primary result codes, as node:sqlite reports them on `errcode`. */
function sqliteFailure(error: unknown, disposition: CommitDisposition): ThreadFailure {
  if (error instanceof ThreadFailure) return disposition === 'unknown' ? new ThreadFailure({ ...error.error, disposition }) : error;
  const { errcode, errstr, message, storageCode } = (error ?? {}) as { errcode?: number; errstr?: string; message?: string; storageCode?: StorageErrorCode };
  if (storageCode) return failure(storageCode, String(message), disposition);
  const text = String(message ?? error);
  if (typeof errcode !== 'number') return failure('domain-failed', text, disposition);
  const [code, retryable]: [StorageErrorCode, boolean] = (() => {
    switch (errcode & 0xff) {
      case 5: case 6: return ['busy', true];
      case 8: return ['read-only', false];
      case 10: case 14: case 15: return ['io-error', true];
      case 13: return ['no-space', true];
      case 11: return ['corrupt', false];
      case 26: return ['not-a-database', false];
      default: return ['sqlite-error', false];
    }
  })();
  return new ThreadFailure({ code, message: text, disposition, retryable, sqlite: { errcode, errstr } });
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const COMMAND_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const pragmaValue = (db: DatabaseSync, pragma: string) => Object.values(db.prepare(`PRAGMA ${pragma}`).get() ?? {})[0];

interface Connection {
  db: DatabaseSync;
  identity: StorageBuildIdentity;
  maxResultBytes: number;
  /** The epoch this connection claimed with prepare. Writes are refused until then. */
  claimedEpoch?: number;
  statements: Map<string, StatementSync>;
}

export function runStorageThread(domains: readonly StorageDomain[]): void {
  const port = parentPort;
  if (!port) throw new Error('The storage thread runs only as a worker thread.');
  const schemas = domains.map(domain => domain.schema);
  const manifest = storageManifest(schemas);
  const registry = new Map(domains.map(domain => [domain.schema.domain, domain]));
  const scopes = migrationsOf(schemas);

  let sqlite: Sqlite | undefined;
  let runtimeError: string | undefined;
  let sqliteVersion: string | undefined;
  try {
    sqlite = typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') as Sqlite | undefined : undefined;
    if (!sqlite) throw new Error('node:sqlite is not available in this runtime.');
    const memory = new sqlite.DatabaseSync(':memory:');
    try { sqliteVersion = String((memory.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version); } finally { memory.close(); }
  } catch (error) { runtimeError = error instanceof Error ? error.message : String(error); }

  const hello: ThreadHello = {
    type: 'hello', protocol: STORAGE_PROTOCOL, appVersion: APP_VERSION, manifest,
    runtime: {
      node: process.versions.node, ...(sqliteVersion ? { sqlite: sqliteVersion } : {}), platform: process.platform, arch: process.arch, execPath: process.execPath,
      apis: { DatabaseSync: typeof sqlite?.DatabaseSync === 'function', StatementSync: typeof sqlite?.StatementSync === 'function' },
    },
    ...(runtimeError ? { runtimeError } : {}),
  };
  port.postMessage(hello);

  let connection: Connection | undefined;

  const open = (): Connection => {
    if (!connection) throw failure('not-ready', 'The storage database is not open.');
    return connection;
  };

  /** What the file holds. Throws for anything this build may not write: another program's database, an unknown schema. */
  function readSchema(db: DatabaseSync): SchemaState {
    const names = new Set((db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(row => row.name));
    if (!names.size) return { kind: 'empty' };
    if (!names.has('storage_meta') || !names.has('schema_migrations')) throw failure('foreign-database', 'The storage file holds tables this project did not create.');
    const meta = readMeta(db);
    if (meta.format !== STORAGE_DATABASE_FORMAT || !meta.storage_id) throw failure('foreign-database', 'The storage file is not an Agent Session Tower database.');
    const applied = (db.prepare('SELECT scope, version, checksum, applied_at, app_version, source_hash, owner_epoch FROM schema_migrations ORDER BY scope, version').all() as Record<string, string | number>[])
      .map((row): AppliedMigration => ({ scope: String(row.scope), version: Number(row.version), checksum: String(row.checksum), appliedAt: String(row.applied_at), appVersion: String(row.app_version), sourceHash: String(row.source_hash), ownerEpoch: Number(row.owner_epoch) }));
    const pending: { scope: string; version: number }[] = [];
    for (const { scope, migrations } of scopes) {
      const rows = applied.filter(row => row.scope === scope);
      rows.forEach((row, index) => {
        const known = migrations[row.version - 1];
        if (row.version !== index + 1 || !known || migrationChecksum(scope, known) !== row.checksum) {
          throw failure('unknown-schema', `The storage schema of ${scope} (version ${row.version}) is not one this build knows.`);
        }
      });
      for (let version = rows.length + 1; version <= migrations.length; version++) pending.push({ scope, version });
    }
    const unknown = applied.find(row => !scopes.some(scope => scope.scope === row.scope));
    if (unknown) throw failure('unknown-schema', `The storage holds the ${unknown.scope} schema, which this build does not know.`);
    if (!applied.some(row => row.scope === CORE_SCOPE)) throw failure('unknown-schema', 'The storage has no core schema.');
    return pending.length ? { kind: 'behind', storageId: meta.storage_id, applied, pending } : { kind: 'current', storageId: meta.storage_id, applied };
  }

  function readMeta(db: DatabaseSync): Record<string, string> {
    return Object.fromEntries((db.prepare('SELECT key, value FROM storage_meta').all() as { key: string; value: string }[]).map(row => [row.key, row.value]));
  }
  const ownerEpochOf = (db: DatabaseSync, schema: SchemaState) => schema.kind === 'empty' ? 0 : Number(readMeta(db).owner_epoch ?? 0);

  function pragmas(db: DatabaseSync): StoragePragmas {
    return {
      journalMode: String(pragmaValue(db, 'journal_mode')), synchronous: Number(pragmaValue(db, 'synchronous')),
      foreignKeys: Number(pragmaValue(db, 'foreign_keys')), trustedSchema: Number(pragmaValue(db, 'trusted_schema')), busyTimeout: Number(pragmaValue(db, 'busy_timeout')),
    };
  }

  /** Short write transaction. Before COMMIT nothing is written; a failed COMMIT may or may not have reached the file. */
  function writing<T>(db: DatabaseSync, work: () => T): T {
    try { db.exec('BEGIN IMMEDIATE'); } catch (error) { throw sqliteFailure(error, 'not-committed'); }
    let value: T;
    try { value = work(); } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* best-effort: the transaction may already be gone; the error below is the one that matters. */ }
      throw sqliteFailure(error, 'not-committed');
    }
    try { db.exec('COMMIT'); } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* best-effort: as above. */ }
      throw sqliteFailure(error, 'unknown');
    }
    return value;
  }
  function reading<T>(db: DatabaseSync, work: () => T): T {
    db.exec('BEGIN');
    try { return work(); } finally { db.exec('COMMIT'); }
  }

  function receiptOf(db: DatabaseSync, commandId: string): ReceiptLookup {
    const row = db.prepare('SELECT * FROM operation_receipts WHERE command_id = ?').get(commandId) as Record<string, string | number> | undefined;
    if (!row) return { found: false };
    return { found: true, receipt: { commandId: String(row.command_id), scope: String(row.scope), command: String(row.command), payloadSha256: String(row.payload_sha256), ownerEpoch: Number(row.owner_epoch), committedAt: String(row.committed_at), result: JSON.parse(String(row.result)) } };
  }
  /** A command ID already committed: the same command again answers its stored result; anything else is refused. */
  function replay(db: DatabaseSync, commandId: string, scope: string, command: string, payloadSha256: string): { result: unknown } | undefined {
    const found = receiptOf(db, commandId);
    if (!found.found) return undefined;
    const { receipt } = found;
    if (receipt.scope !== scope || receipt.command !== command || receipt.payloadSha256 !== payloadSha256) throw failure('command-id-conflict', `Command ${commandId} was already committed with another command or payload.`);
    return { result: receipt.result };
  }
  function insertReceipt(db: DatabaseSync, row: { commandId: string; scope: string; command: string; payloadSha256: string; ownerEpoch: number; now: string; result: string }) {
    db.prepare('INSERT INTO operation_receipts (command_id, scope, command, payload_sha256, owner_epoch, committed_at, result) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(row.commandId, row.scope, row.command, row.payloadSha256, row.ownerEpoch, row.now, row.result);
  }
  function bounded(value: unknown, limit: number): string {
    const text = JSON.stringify(value === undefined ? null : value);
    if (Buffer.byteLength(text) > limit) throw failure('result-too-large', `The answer is larger than ${limit} bytes.`);
    return text;
  }

  function doOpen(request: OpenRequest): OpenResult {
    if (connection) throw failure('invalid-command', 'The storage database is already open.');
    if (!sqlite) throw failure('unsupported-runtime', runtimeError ?? 'node:sqlite is not available.');
    if (!Number.isInteger(request.busyTimeoutMs) || request.busyTimeoutMs < 0) throw failure('invalid-command', 'busy timeout must be a whole number of milliseconds.');
    let db: DatabaseSync;
    try { db = new sqlite.DatabaseSync(request.path); } catch (error) { throw sqliteFailure(error, 'not-committed'); }
    try {
      // Connection settings only: none of these writes to the file.
      db.exec(`PRAGMA busy_timeout = ${request.busyTimeoutMs}`);
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('PRAGMA trusted_schema = OFF');
      const schema = readSchema(db);
      if (request.expectedStorageId !== undefined) {
        if (schema.kind === 'empty') throw failure('database-missing', 'The storage recorded here is gone; this empty file is not used in its place.');
        if (schema.storageId !== request.expectedStorageId) throw failure('storage-replaced', 'The database is not the storage recorded here.');
      }
      // The first write to the file, made only to an empty file or a database whose schema this build knows.
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = FULL');
      const actual = pragmas(db);
      if (actual.journalMode !== 'wal' || actual.synchronous !== 2 || actual.foreignKeys !== 1 || actual.trustedSchema !== 0 || actual.busyTimeout !== request.busyTimeoutMs) {
        throw failure('pragma-mismatch', `SQLite did not keep the storage settings: ${JSON.stringify(actual)}.`);
      }
      connection = { db, identity: request.identity, maxResultBytes: request.maxResultBytes, statements: new Map() };
      return { schema, pragmas: actual, ownerEpoch: ownerEpochOf(db, schema) };
    } catch (error) {
      try { db.close(); } catch { /* best-effort: closing a connection that failed to open; the first error explains it. */ }
      throw sqliteFailure(error, 'not-committed');
    }
  }

  function doInspect(): StorageInspection {
    const { db } = open();
    return reading(db, () => {
      const schema = readSchema(db);
      return {
        schema, pragmas: pragmas(db), ownerEpoch: ownerEpochOf(db, schema), authority: schema.kind === 'empty' ? [] : readAuthority(db), sqlite: sqliteVersion ?? '',
        pageSize: Number(pragmaValue(db, 'page_size')), pageCount: Number(pragmaValue(db, 'page_count')), freelistCount: Number(pragmaValue(db, 'freelist_count')),
      };
    });
  }

  function doPrepare(commandId: string, allowMigration: boolean, storageId: string) {
    const current = open();
    const { db, identity } = current;
    if (!COMMAND_ID.test(commandId)) throw failure('invalid-command', 'The command ID is invalid.');
    const payloadSha256 = sha256(JSON.stringify({ allowMigration, storageId }));
    const now = new Date().toISOString();
    const outcome = writing(db, () => {
      const before = readSchema(db);
      if (before.kind !== 'empty') {
        const replayed = replay(db, commandId, CORE_SCOPE, 'prepare', payloadSha256);
        if (replayed) return { ...(replayed.result as { ownerEpoch: number; applied: { scope: string; version: number }[]; created: boolean }), replayed: true };
      }
      const pending = before.kind === 'empty'
        ? scopes.flatMap(({ scope, migrations }) => migrations.map(migration => ({ scope, version: migration.version })))
        : before.kind === 'behind' ? before.pending : [];
      if (pending.length && !allowMigration) throw failure('migration-required', `The storage needs ${pending.length} schema change(s), which this start may not make.`);
      const ownerEpoch = ownerEpochOf(db, before) + 1;
      for (const { scope, version } of pending) {
        const migration = scopes.find(entry => entry.scope === scope)!.migrations[version - 1];
        db.exec(migration.sql);
        db.prepare('INSERT INTO schema_migrations (scope, version, checksum, applied_at, app_version, source_hash, owner_epoch) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(scope, version, migrationChecksum(scope, migration), now, identity.appVersion, identity.sourceHash, ownerEpoch);
      }
      const meta = db.prepare('INSERT INTO storage_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
      if (before.kind === 'empty') {
        if (!/^[0-9a-f-]{36}$/.test(storageId)) throw failure('invalid-command', 'A new storage needs a storage ID.');
        for (const [key, value] of [['format', STORAGE_DATABASE_FORMAT], ['storage_id', storageId], ['created_at', now], ['created_app_version', identity.appVersion], ['created_source_hash', identity.sourceHash]]) meta.run(key, value);
      }
      for (const [key, value] of [['owner_epoch', String(ownerEpoch)], ['owner_app_version', identity.appVersion], ['owner_source_hash', identity.sourceHash], ['owner_claimed_at', now]]) meta.run(key, value);
      const result = { ownerEpoch, applied: pending, created: before.kind === 'empty' };
      insertReceipt(db, { commandId, scope: CORE_SCOPE, command: 'prepare', payloadSha256, ownerEpoch, now, result: JSON.stringify(result) });
      return { ...result, replayed: false };
    });
    // A replayed prepare answers the epoch it claimed then; the connection claims it only if nobody has claimed since.
    const schema = readSchema(db);
    const claimed = ownerEpochOf(db, schema) === outcome.ownerEpoch;
    if (claimed) current.claimedEpoch = outcome.ownerEpoch;
    const result: PrepareThreadResult = { ownerEpoch: outcome.ownerEpoch, applied: outcome.applied, created: outcome.created, schema, replayed: outcome.replayed, claimed };
    return result;
  }

  function contextFor(current: Connection, domain: string): DomainReadContext {
    return {
      domain,
      prepare(sql: string) {
        let statement = current.statements.get(sql);
        if (!statement) { statement = current.db.prepare(sql); current.statements.set(sql, statement); }
        return statement;
      },
    };
  }
  function commandOf<K extends DomainCommand['kind']>(domain: string, name: string, kind: K): { owner: StorageDomain; command: Extract<DomainCommand, { kind: K }> } {
    const owner = registry.get(domain);
    if (!owner) throw failure('unknown-domain', `This build stores no domain named ${domain}.`);
    const command = Object.hasOwn(owner.commands, name) ? owner.commands[name] : undefined;
    if (!command || command.kind !== kind) throw failure('unknown-command', `${domain} has no ${kind} command ${name}.`);
    return { owner, command: command as Extract<DomainCommand, { kind: K }> };
  }
  function parsePayload(payload: string): unknown {
    try { return JSON.parse(payload); } catch { throw failure('invalid-command', 'The command payload is not JSON.'); }
  }
  const synchronous = (value: unknown) => {
    if (value && typeof (value as { then?: unknown }).then === 'function') throw failure('domain-failed', 'A storage command must not be asynchronous.');
    return value;
  };

  function doRead(domain: string, name: string, payload: string) {
    const current = open();
    const { command } = commandOf(domain, name, 'read');
    const input = parsePayload(payload);
    try {
      return reading(current.db, () => ({ result: JSON.parse(bounded(synchronous(command.run(contextFor(current, domain), input)), current.maxResultBytes)) }));
    } catch (error) { throw sqliteFailure(error, 'not-committed'); }
  }

  function doWrite(domain: string, name: string, payload: string, commandId: string, ownerEpoch: number) {
    const current = open();
    const { owner, command } = commandOf(domain, name, 'write');
    if (!COMMAND_ID.test(commandId)) throw failure('invalid-command', 'The command ID is invalid.');
    if (current.claimedEpoch === undefined) throw failure('not-prepared', 'The storage was not prepared by this worker.');
    if (ownerEpoch !== current.claimedEpoch) throw failure('stale-owner', 'The command carries another owner epoch.');
    const input = parsePayload(payload);
    const payloadSha256 = sha256(payload);
    const now = new Date().toISOString();
    return writing(current.db, () => {
      if (Number(readMeta(current.db).owner_epoch) !== ownerEpoch) throw failure('stale-owner', 'Another worker has claimed the storage since this one prepared it.');
      const replayed = replay(current.db, commandId, domain, name, payloadSha256);
      if (replayed) return { result: replayed.result, replayed: true };
      const context: DomainWriteContext = { ...contextFor(current, domain), commandId, ownerEpoch, now, authority: authorityWriter(current.db, owner.schema, { ownerEpoch, now, identity: current.identity }) };
      const result = bounded(synchronous(command.run(context, input)), current.maxResultBytes);
      insertReceipt(current.db, { commandId, scope: domain, command: name, payloadSha256, ownerEpoch, now, result });
      return { result: JSON.parse(result), replayed: false };
    });
  }

  function doSnapshot(target: string): SnapshotThreadResult {
    const { db } = open();
    if (readSchema(db).kind === 'empty') throw failure('not-prepared', 'An empty storage has nothing to snapshot.');
    // VACUUM INTO reads through this connection, so committed rows still in the WAL are part of the copy.
    try { db.prepare('VACUUM INTO ?').run(target); } catch (error) { throw sqliteFailure(error, 'not-committed'); }
    const copy = new sqlite!.DatabaseSync(target, { readOnly: true });
    try {
      const schema = readSchema(copy);
      return {
        schema, ownerEpoch: ownerEpochOf(copy, schema), authority: readAuthority(copy),
        quickCheck: (copy.prepare('PRAGMA quick_check').all() as Record<string, string>[]).map(row => Object.values(row)[0]).join('; '),
        foreignKeyViolations: copy.prepare('PRAGMA foreign_key_check').all().length, journalMode: String(pragmaValue(copy, 'journal_mode')),
      };
    } finally { copy.close(); }
  }

  /** Runs on the same in-memory database type the storage uses, never on a file. */
  function doProbe(): ProbeResult {
    if (!sqlite) throw failure('unsupported-runtime', runtimeError ?? 'node:sqlite is not available.');
    const db = new sqlite.DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA busy_timeout = 250; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF');
      db.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY) STRICT; CREATE TABLE child (id INTEGER PRIMARY KEY, parent INTEGER NOT NULL REFERENCES parent (id)) STRICT');
      let foreignKeysEnforced = false;
      try { db.prepare('INSERT INTO child (id, parent) VALUES (1, 99)').run(); } catch (error) { foreignKeysEnforced = ((error as { errcode?: number }).errcode ?? 0) === 787; }
      const insert = db.prepare('INSERT INTO parent (id) VALUES (?)');
      db.exec('BEGIN IMMEDIATE'); for (let id = 1; id <= 50; id++) insert.run(id); db.exec('ROLLBACK');
      const transactionRollback = (db.prepare('SELECT count(*) AS n FROM parent').get() as { n: number }).n === 0;
      db.exec('BEGIN IMMEDIATE'); for (let id = 1; id <= 50; id++) insert.run(id); db.exec('COMMIT');
      return {
        foreignKeysEnforced, trustedSchema: Number(pragmaValue(db, 'trusted_schema')), busyTimeout: Number(pragmaValue(db, 'busy_timeout')), transactionRollback,
        preparedRows: Number((db.prepare('SELECT count(*) AS n FROM parent').get() as { n: number }).n),
      };
    } finally { db.close(); }
  }

  function doClose(): { closed: true } {
    if (connection) {
      const { db } = connection;
      connection = undefined;
      try { db.close(); } catch (error) { throw sqliteFailure(error, 'not-committed'); }
    }
    return { closed: true };
  }

  function handle(request: ThreadRequest): unknown {
    switch (request.op) {
      case 'open': return doOpen(request.open);
      case 'inspect': return doInspect();
      case 'prepare': return doPrepare(request.commandId, request.allowMigration, request.storageId);
      case 'receipt': {
        const { db } = open();
        return readSchema(db).kind === 'empty' ? { found: false } : receiptOf(db, request.commandId);
      }
      case 'read': return doRead(request.domain, request.command, request.payload);
      case 'write': return doWrite(request.domain, request.command, request.payload, request.commandId, request.ownerEpoch);
      case 'snapshot': return doSnapshot(request.target);
      case 'probe': return doProbe();
      case 'flush': return { flushed: true };
      case 'close': return doClose();
      default: throw failure('invalid-command', 'Unknown storage request.');
    }
  }

  port.on('message', (request: ThreadRequest) => {
    let response: ThreadResponse;
    try { response = { type: 'result', id: request.id, ok: true, value: handle(request) }; } catch (error) {
      response = { type: 'result', id: request.id, ok: false, error: sqliteFailure(error, 'not-committed').error };
    }
    port.postMessage(response);
    // After the close answer the thread has nothing left: closing the port lets it end with exit code 0.
    if (request.op === 'close' && response.ok) port.close();
  });
}
