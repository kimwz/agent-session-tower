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

/** Checks a domain's declaration once, when the thread starts. */
export function defineStorageDomain(domain: StorageDomain): StorageDomain {
  for (const name of Object.keys(domain.commands)) if (!COMMAND_NAME.test(name)) throw new Error(`Storage command ${domain.schema.domain}.${name} has an invalid name.`);
  return domain;
}
