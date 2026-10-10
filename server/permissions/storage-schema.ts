import type { StorageDomainSchema } from '../storage/contract.js';
import { PERMISSION_BYTES } from './storage-codec.js';

/** Finite integration placeholder: the integration owner seals activation/evidence. */
export const permissionsSchema: StorageDomainSchema = {
  domain: 'permissions',
  preparation: { requiredArtifactVersion:'1.125.0',readerContract:1,writerContract:1 },
  cutover: { artifactVersion:'1.125.0',importContract:1 },
  migrations:[{ version:1,sql:`
CREATE TABLE permission_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL CHECK(revision>0)) STRICT;
CREATE TABLE permission_rules (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL CHECK(ordinal>=0), json TEXT NOT NULL CHECK(length(CAST(json AS BLOB))<=${PERMISSION_BYTES}), scope TEXT NOT NULL, session_id TEXT, source TEXT NOT NULL, expires_at TEXT) STRICT;
CREATE UNIQUE INDEX permission_rule_order ON permission_rules(ordinal);
CREATE INDEX permission_rule_session ON permission_rules(session_id,expires_at);
CREATE TABLE permission_requests (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL CHECK(ordinal>=0), json TEXT NOT NULL CHECK(length(CAST(json AS BLOB))<=${PERMISSION_BYTES}), status TEXT NOT NULL, session_id TEXT NOT NULL, provider TEXT, type TEXT NOT NULL, review TEXT, created_at TEXT NOT NULL, decided_at TEXT, notification TEXT, run_status TEXT) STRICT;
CREATE UNIQUE INDEX permission_request_order ON permission_requests(ordinal);
CREATE INDEX permission_request_session ON permission_requests(session_id,status,created_at);
CREATE INDEX permission_request_review ON permission_requests(status,review,created_at);
CREATE INDEX permission_request_run ON permission_requests(type,run_status);
CREATE INDEX permission_request_notice ON permission_requests(notification);
CREATE TABLE permission_codex_files (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL CHECK(ordinal>=0), json TEXT NOT NULL CHECK(length(CAST(json AS BLOB))<=${PERMISSION_BYTES})) STRICT;
CREATE UNIQUE INDEX permission_codex_order ON permission_codex_files(ordinal);
CREATE TABLE permission_metadata (id TEXT PRIMARY KEY CHECK(id IN ('autoReview','lost','extensions')), ordinal INTEGER NOT NULL CHECK(ordinal=0), json TEXT NOT NULL CHECK(length(CAST(json AS BLOB))<=${PERMISSION_BYTES})) STRICT;
`.trim() }],
};
