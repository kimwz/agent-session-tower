import type { StorageDomainSchema } from '../storage/contract.js';
import { TRIGGER_CHUNK_BYTES, TRIGGER_INTENT_BYTES, ROW_KINDS } from './storage-codec.js';
export const TRIGGER_STAGE_COUNT = 16;
export const TRIGGER_STAGE_BYTES = 2 * TRIGGER_INTENT_BYTES;
/** Released preparation and migration bytes remain stable across cutover. */
export const triggersSchema: StorageDomainSchema = {
  domain: 'triggers', preparation: { requiredArtifactVersion: '1.124.0', readerContract: 1, writerContract: 1 },
  migrations: [{ version: 1, sql: `
CREATE TABLE triggers_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL CHECK (revision > 0), logical_bytes INTEGER NOT NULL CHECK (logical_bytes >= 0)) STRICT;
CREATE TABLE triggers_rows (
  kind TEXT NOT NULL CHECK (kind IN (${ROW_KINDS.map(kind => "'" + kind + "'").join(',')})), id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0), json TEXT NOT NULL, logical_bytes INTEGER NOT NULL CHECK (logical_bytes >= 0),
  trigger_id TEXT, status TEXT, PRIMARY KEY (kind,id)
) STRICT;
CREATE INDEX triggers_order ON triggers_rows(kind,ordinal);
CREATE INDEX triggers_event_status ON triggers_rows(status,ordinal) WHERE kind = 'events';
CREATE INDEX triggers_definition ON triggers_rows(trigger_id,kind) WHERE kind IN ('triggers','tombstones','revisions','events');
CREATE TABLE triggers_stages (
  intent TEXT PRIMARY KEY, owner_epoch INTEGER NOT NULL, bytes INTEGER NOT NULL CHECK (bytes > 0 AND bytes <= ${TRIGGER_INTENT_BYTES}),
  sha256 TEXT NOT NULL, chunks INTEGER NOT NULL CHECK (chunks > 0 AND chunks <= ${Math.ceil(TRIGGER_INTENT_BYTES / TRIGGER_CHUNK_BYTES)})
) STRICT;
CREATE TABLE triggers_stage_chunks (
  intent TEXT NOT NULL REFERENCES triggers_stages(intent) ON DELETE CASCADE,
  part INTEGER NOT NULL CHECK (part >= 0), data TEXT NOT NULL, PRIMARY KEY (intent,part)
) STRICT;
CREATE TRIGGER triggers_stage_bound_insert BEFORE INSERT ON triggers_stages BEGIN
  SELECT CASE WHEN (SELECT count(*) FROM triggers_stages) >= ${TRIGGER_STAGE_COUNT} OR (SELECT coalesce(sum(bytes),0) FROM triggers_stages) + NEW.bytes > ${TRIGGER_STAGE_BYTES} THEN RAISE(ABORT, 'Triggers staging reservation limit exceeded.') END;
END;
`.trim() }],
};
