import type { DatabaseSync } from 'node:sqlite';
import type { DomainAuthority, StorageBuildIdentity, StorageDomainSchema } from '../contract.js';
import type { DomainAuthorityWriter } from '../domain.js';

/**
 * The one owner of domain_imports: which domains the database holds, by which generation. Rows change only inside a
 * domain's own write command, in that command's transaction, so an authority change and the data it describes commit
 * together. Nothing else (a flag, a file, a recovery) moves a domain's authority.
 *
 * Release A of a domain (its preparation: schema, reader/writer, exporter; no cutover) never imports. It can still
 * export back a database that release B imported, which is how B rolls back to A: the marker must say the database
 * holds the domain, under the reader/writer contracts this build has.
 */

interface Row { domain: string; authority: string; generation: number; manifest_sha256: string; reader_contract: number; writer_contract: number; committed_at: string; app_version: string; source_hash: string; owner_epoch: number }
const SHA256 = /^[0-9a-f]{64}$/;

function authorityOf(row: Row): DomainAuthority {
  return {
    domain: row.domain, authority: row.authority as DomainAuthority['authority'], generation: Number(row.generation), manifestSha256: row.manifest_sha256,
    readerContract: Number(row.reader_contract), writerContract: Number(row.writer_contract), committedAt: row.committed_at,
    appVersion: row.app_version, sourceHash: row.source_hash, ownerEpoch: Number(row.owner_epoch),
  };
}

export function readAuthority(db: DatabaseSync): DomainAuthority[] {
  return (db.prepare('SELECT * FROM domain_imports ORDER BY domain').all() as unknown as Row[]).map(authorityOf);
}

/** The writer one domain's write command receives. It may only change that domain's row. */
export function authorityWriter(db: DatabaseSync, schema: StorageDomainSchema, context: { ownerEpoch: number; now: string; identity: StorageBuildIdentity }): DomainAuthorityWriter {
  const current = () => {
    const row = db.prepare('SELECT * FROM domain_imports WHERE domain = ?').get(schema.domain) as unknown as Row | undefined;
    return row ? authorityOf(row) : undefined;
  };
  const refuse = (storageCode: 'no-cutover-contract' | 'authority-missing' | 'contract-mismatch', message: string) => Object.assign(new Error(message), { storageCode });
  const record = (authority: DomainAuthority['authority'], manifestSha256: string): DomainAuthority => {
    if (!SHA256.test(manifestSha256)) throw new Error(`${schema.domain}: an authority change needs the sha256 of its manifest.`);
    const previous = current();
    if (authority === 'database') {
      // A domain without a cutover contract in this build's manifest has no import; marking one would be a made-up claim.
      if (!schema.cutover) throw refuse('no-cutover-contract', `${schema.domain} has no cutover contract in this build.`);
    } else {
      if (previous?.authority !== 'database') throw refuse('authority-missing', `${schema.domain}: only a domain the database holds can be exported back.`);
      if (previous.readerContract !== schema.preparation.readerContract || previous.writerContract !== schema.preparation.writerContract) {
        throw refuse('contract-mismatch', `${schema.domain} was imported under reader/writer contract ${previous.readerContract}/${previous.writerContract}; this build has ${schema.preparation.readerContract}/${schema.preparation.writerContract}.`);
      }
    }
    const generation = (previous?.generation ?? 0) + 1;
    db.prepare(`INSERT INTO domain_imports (domain, authority, generation, manifest_sha256, reader_contract, writer_contract, committed_at, app_version, source_hash, owner_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (domain) DO UPDATE SET authority = excluded.authority, generation = excluded.generation, manifest_sha256 = excluded.manifest_sha256,
        reader_contract = excluded.reader_contract, writer_contract = excluded.writer_contract, committed_at = excluded.committed_at,
        app_version = excluded.app_version, source_hash = excluded.source_hash, owner_epoch = excluded.owner_epoch`)
      .run(schema.domain, authority, generation, manifestSha256, schema.preparation.readerContract, schema.preparation.writerContract, context.now, context.identity.appVersion, context.identity.sourceHash, context.ownerEpoch);
    return current()!;
  };
  return {
    current,
    markImported: ({ manifestSha256 }) => record('database', manifestSha256),
    markLegacyExported: ({ manifestSha256 }) => record('legacy-exported', manifestSha256),
  };
}
