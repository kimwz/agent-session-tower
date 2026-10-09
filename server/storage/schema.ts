import { createHash } from 'node:crypto';
import { retentionSchema } from '../sessions/retention/storage-schema.js';
import { APP_VERSION } from '../../shared/app-identity.js';
import { STORAGE_PROTOCOL, type DomainManifest, type ScopeManifest, type StorageBuildManifest, type StorageDomainSchema, type StorageMigration } from './contract.js';

export const CORE_SCOPE = 'core';

/**
 * The storage's own tables. Every later change is a new entry; a released entry is never edited, because its
 * checksum in schema_migrations is how a build recognises a database it may write.
 */
export const CORE_MIGRATIONS: readonly StorageMigration[] = [{
  version: 1,
  sql: `
CREATE TABLE storage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE schema_migrations (
  scope TEXT NOT NULL, version INTEGER NOT NULL CHECK (version > 0), checksum TEXT NOT NULL, applied_at TEXT NOT NULL,
  app_version TEXT NOT NULL, source_hash TEXT NOT NULL, owner_epoch INTEGER NOT NULL, PRIMARY KEY (scope, version)
) STRICT;
CREATE TABLE domain_imports (
  domain TEXT PRIMARY KEY, authority TEXT NOT NULL CHECK (authority IN ('database', 'legacy-exported')),
  generation INTEGER NOT NULL CHECK (generation > 0), manifest_sha256 TEXT NOT NULL,
  reader_contract INTEGER NOT NULL, writer_contract INTEGER NOT NULL, committed_at TEXT NOT NULL,
  app_version TEXT NOT NULL, source_hash TEXT NOT NULL, owner_epoch INTEGER NOT NULL
) STRICT;
CREATE TABLE operation_receipts (
  command_id TEXT PRIMARY KEY, scope TEXT NOT NULL, command TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
  owner_epoch INTEGER NOT NULL, committed_at TEXT NOT NULL, result TEXT NOT NULL
) STRICT;
`.trim(),
}];

/**
 * The domains this build stores in SQLite. Empty until a domain's preparation release (A) adds its schema owner here;
 * listing a domain is the claim that this build reads and writes its tables.
 */
export const STORAGE_DOMAIN_SCHEMAS: readonly StorageDomainSchema[] = [retentionSchema];

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
export const migrationChecksum = (scope: string, migration: StorageMigration) => sha256(`${scope}\n${migration.version}\n${migration.sql}`);

const DOMAIN_NAME = /^[a-z][a-z0-9-]{0,47}$/;

function scopeManifest(scope: string, migrations: readonly StorageMigration[]): ScopeManifest {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1 || !migration.sql.trim()) throw new Error(`Storage scope ${scope} must list migrations 1..n with SQL.`);
  });
  return { scope, schemaVersion: migrations.length, schemaDigest: sha256(migrations.map(migration => migrationChecksum(scope, migration)).join('\n')) };
}

/** The manifest a build's worker expects and its thread reports. Both compute it from the same declarations. */
export function storageManifest(domains: readonly StorageDomainSchema[] = STORAGE_DOMAIN_SCHEMAS, appVersion = APP_VERSION): StorageBuildManifest {
  const seen = new Set<string>([CORE_SCOPE]);
  const domainManifests: DomainManifest[] = domains.map(schema => {
    if (!DOMAIN_NAME.test(schema.domain) || seen.has(schema.domain)) throw new Error(`Storage domain name ${schema.domain} is invalid or repeated.`);
    seen.add(schema.domain);
    return { ...scopeManifest(schema.domain, schema.migrations), preparation: { ...schema.preparation }, ...(schema.cutover ? { cutover: { ...schema.cutover } } : {}) };
  });
  const body = { protocol: STORAGE_PROTOCOL, appVersion, core: scopeManifest(CORE_SCOPE, CORE_MIGRATIONS), domains: domainManifests };
  return { ...body, digest: manifestDigest(body) };
}

/** The digest of a manifest's body (everything but `digest`), recomputed: a stated digest alone vouches for nothing. */
export function manifestDigest(manifest: Omit<StorageBuildManifest, 'digest'>): string {
  const { protocol, appVersion, core, domains } = manifest;
  return sha256(JSON.stringify({ protocol, appVersion, core, domains }));
}

/** Every scope's migrations, core first, in the order they are applied. */
export function migrationsOf(domains: readonly StorageDomainSchema[]): { scope: string; migrations: readonly StorageMigration[] }[] {
  return [{ scope: CORE_SCOPE, migrations: CORE_MIGRATIONS }, ...domains.map(schema => ({ scope: schema.domain, migrations: schema.migrations }))];
}
