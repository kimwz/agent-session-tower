import type { StatementSync } from 'node:sqlite';
import type { DomainAuthority, StorageDomainSchema } from './contract.js';

/**
 * How a domain's schema owner joins the storage thread. Its commands are fixed code inside the thread bundle: the
 * worker names a command and sends a JSON payload; it never sends SQL. A command runs synchronously inside one short
 * transaction (writes: BEGIN IMMEDIATE, with the receipt of its command ID in the same commit) and must not await.
 */
export interface DomainReadContext {
  readonly domain: string;
  /** A statement on this thread's connection. Statements are cached per SQL text. */
  prepare(sql: string): StatementSync;
}
export interface DomainWriteContext extends DomainReadContext {
  readonly commandId: string;
  readonly ownerEpoch: number;
  /** One timestamp for the whole command. */
  readonly now: string;
  /** This domain's authority record, the only way to change it. */
  readonly authority: DomainAuthorityWriter;
}
export interface DomainAuthorityWriter {
  current(): DomainAuthority | undefined;
  /** The domain's state now lives in the database: a new generation, recorded with the import source manifest. */
  markImported(input: { manifestSha256: string }): DomainAuthority;
  /** The database exported the domain back to its legacy files, which are authoritative again from this commit on. */
  markLegacyExported(input: { manifestSha256: string }): DomainAuthority;
}

export type DomainCommand =
  | { kind: 'read'; run(context: DomainReadContext, payload: unknown): unknown }
  | { kind: 'write'; run(context: DomainWriteContext, payload: unknown): unknown };

export interface StorageDomain {
  schema: StorageDomainSchema;
  commands: Readonly<Record<string, DomainCommand>>;
}

const COMMAND_NAME = /^[a-z][a-zA-Z0-9.-]{0,63}$/;
const CREATED_TABLE = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi;

/**
 * The read every defined domain answers (payload ignored): which of the tables its own migrations create, and the
 * database still has, hold at least one row, in migration order. It looks at every table, state and stages included,
 * whatever the domain's head() checks, so "this domain has nothing stored" never depends on one domain's own reads.
 */
export const OCCUPIED_TABLES_COMMAND = 'occupiedTables';
const generated = new WeakSet<DomainCommand>();

/** Checks a domain's declaration once, when the thread starts, and adds its occupiedTables read. */
export function defineStorageDomain(domain: StorageDomain): StorageDomain {
  for (const name of Object.keys(domain.commands)) if (!COMMAND_NAME.test(name)) throw new Error(`Storage command ${domain.schema.domain}.${name} has an invalid name.`);
  // Commands taken over from another defined domain bring its occupiedTables along: replaced by this schema's own.
  const own = Object.hasOwn(domain.commands, OCCUPIED_TABLES_COMMAND) ? domain.commands[OCCUPIED_TABLES_COMMAND] : undefined;
  if (own && !generated.has(own)) throw new Error(`Storage command ${domain.schema.domain}.${OCCUPIED_TABLES_COMMAND} is defined by the storage itself.`);
  const tables = [...new Set(domain.schema.migrations.flatMap(migration => [...migration.sql.matchAll(CREATED_TABLE)].map(match => match[1])))];
  const occupied: DomainCommand = { kind: 'read', run: context => tables.filter(name =>
    context.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) !== undefined
    && context.prepare(`SELECT 1 FROM "${name}" LIMIT 1`).get() !== undefined) };
  generated.add(occupied);
  return { ...domain, commands: { ...domain.commands, [OCCUPIED_TABLES_COMMAND]: occupied } };
}
