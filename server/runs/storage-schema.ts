import type { StorageDomainSchema } from '../storage/contract.js';
import { RUN_CHUNK_BYTES, RUN_INTENT_BYTES } from './storage-codec.js';
export const RUN_STAGE_COUNT = 16;
export const RUN_STAGE_BYTES = 2 * RUN_INTENT_BYTES;
/** Released preparation and migration bytes remain stable across cutover. */
export const runsSchema: StorageDomainSchema = {
  domain: 'runs', preparation: { requiredArtifactVersion: '1.122.0', readerContract: 1, writerContract: 1 },
  migrations: [{ version: 1, sql: `
CREATE TABLE runs_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL CHECK (revision > 0)) STRICT;
CREATE TABLE runs_rows (
  kind TEXT NOT NULL CHECK (kind IN ('run','created','instruction')), id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0), json TEXT NOT NULL, status TEXT, session_id TEXT,
  PRIMARY KEY (kind,id), UNIQUE (kind,ordinal)
) STRICT;
CREATE INDEX runs_status ON runs_rows(status) WHERE kind = 'run';
CREATE INDEX runs_session ON runs_rows(session_id) WHERE kind = 'run';
CREATE TABLE runs_stages (
  intent TEXT PRIMARY KEY, owner_epoch INTEGER NOT NULL, bytes INTEGER NOT NULL CHECK (bytes > 0 AND bytes <= ${RUN_INTENT_BYTES}),
  sha256 TEXT NOT NULL, chunks INTEGER NOT NULL CHECK (chunks > 0 AND chunks <= ${Math.ceil(RUN_INTENT_BYTES / RUN_CHUNK_BYTES)})
) STRICT;
CREATE TABLE runs_stage_chunks (
  intent TEXT NOT NULL REFERENCES runs_stages(intent) ON DELETE CASCADE,
  part INTEGER NOT NULL CHECK (part >= 0), data TEXT NOT NULL, PRIMARY KEY (intent,part)
) STRICT;
CREATE TRIGGER runs_stage_bound_insert BEFORE INSERT ON runs_stages BEGIN
  SELECT CASE WHEN (SELECT count(*) FROM runs_stages) >= ${RUN_STAGE_COUNT} OR (SELECT coalesce(sum(bytes),0) FROM runs_stages) + NEW.bytes > ${RUN_STAGE_BYTES} THEN RAISE(ABORT, 'Runs staging reservation limit exceeded.') END;
END;
`.trim() }],
};
