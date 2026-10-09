import type { StorageDomainSchema } from '../../storage/contract.js';
import { RETENTION_INTENT_BYTES, RETENTION_CHUNK_BYTES } from './storage-codec.js';

/** Tentative A artifact; the parent fixes the release version before publishing. No production cutover. */
export const retentionSchema: StorageDomainSchema = {
  domain: 'retention',
  preparation: { requiredArtifactVersion: '1.120.0', readerContract: 1, writerContract: 1 },
  migrations: [{ version: 1, sql: `
CREATE TABLE retention_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL CHECK (revision > 0)) STRICT;
CREATE TABLE retention_metadata (
  kind TEXT NOT NULL CHECK (kind IN ('entry','policy','observation','journal','observations')), id TEXT NOT NULL,
  ordinal INTEGER NOT NULL, json TEXT NOT NULL, phase TEXT, archive_revision INTEGER, inactive_since TEXT,
  PRIMARY KEY (kind, id)
) STRICT;
CREATE INDEX retention_phase ON retention_metadata (phase) WHERE kind = 'entry';
CREATE INDEX retention_order ON retention_metadata (kind, ordinal);
CREATE TABLE retention_stages (
  intent TEXT PRIMARY KEY, owner_epoch INTEGER NOT NULL, bytes INTEGER NOT NULL CHECK (bytes > 0 AND bytes <= ${RETENTION_INTENT_BYTES}),
  sha256 TEXT NOT NULL, chunks INTEGER NOT NULL CHECK (chunks > 0 AND chunks <= ${Math.ceil(RETENTION_INTENT_BYTES / RETENTION_CHUNK_BYTES)})
) STRICT;
CREATE TABLE retention_stage_chunks (
  intent TEXT NOT NULL REFERENCES retention_stages(intent) ON DELETE CASCADE,
  part INTEGER NOT NULL CHECK (part >= 0), data TEXT NOT NULL, PRIMARY KEY (intent, part)
) STRICT;
`.trim() }],
};
