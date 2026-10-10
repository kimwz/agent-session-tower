import { createHash } from 'node:crypto';
import type { StorageDomainSchema } from '../storage/contract.js';
/** Shared bounded row transfer for the three external-effect owners, never a public KV API. */
export const EXTERNAL_INTENT_BYTES = 481048576;
export const EXTERNAL_CHUNK_BYTES = 196608;
export const EXTERNAL_STAGE_COUNT = 16;
export const EXTERNAL_STAGE_BYTES = 962097152;
export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export { canonical, object } from '../runs/storage-codec.js';
export type ExternalScope = 'remote' | 'auto-prompt' | 'automation-workflows';
export interface ExternalRow { channel: string; kind: string; id: string; ordinal: number; json: string }
export interface ExternalChange extends ExternalRow { previous: string | null; remove?: true }
export interface ExternalProjection {
  status?: string; created?: string; scheduled?: string; controller?: string; operation?: string;
  request?: string; fingerprint?: string; issued?: number; received?: number; account?: string;
  links?: { kind: string; id: string; status?: string }[];
}
export interface ExternalCodec {
  scope: ExternalScope;
  table: 'remote' | 'auto_prompt' | 'automation_workflows';
  validate(row: ExternalRow): ExternalProjection;
  validateCollection(rows: readonly ExternalRow[]): void;
  maxBytes: number;
  /** An effect claim uses durable staging so a lost final answer cannot reopen the old row on restart. */
  needsIntent?(row: ExternalRow, previous: string | null): boolean;
}
export function externalSchema(codec: Pick<ExternalCodec,'scope' | 'table'>): StorageDomainSchema {
  const t = codec.table;
  return { domain: codec.scope, preparation: { requiredArtifactVersion: '1.125.0', readerContract: 1, writerContract: 1 },
    cutover: { artifactVersion: '1.125.0', importContract: 1 }, migrations: [{ version: 1, sql: `
CREATE TABLE ${t}_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL CHECK(revision>0), bytes INTEGER NOT NULL CHECK(bytes>=0)) STRICT;
CREATE TABLE ${t}_rows (
 channel TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>=0),
 json TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes>=0), status TEXT, created TEXT, scheduled TEXT,
 controller TEXT, operation TEXT, request TEXT, fingerprint TEXT, issued REAL, received REAL, account TEXT,
 PRIMARY KEY(channel,kind,id), UNIQUE(channel,kind,ordinal)
) STRICT;
CREATE INDEX ${t}_status ON ${t}_rows(channel,status);
CREATE INDEX ${t}_schedule ON ${t}_rows(channel,scheduled);
CREATE INDEX ${t}_owner_request ON ${t}_rows(controller,operation,request);
CREATE INDEX ${t}_expiry ON ${t}_rows(received,issued);
CREATE TABLE ${t}_links (
 channel TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, relation TEXT NOT NULL, target TEXT NOT NULL, status TEXT,
 PRIMARY KEY(channel,kind,id,relation,target), FOREIGN KEY(channel,kind,id) REFERENCES ${t}_rows(channel,kind,id) ON DELETE CASCADE
) STRICT;
CREATE INDEX ${t}_references ON ${t}_links(relation,target);
CREATE TABLE ${t}_stages (intent TEXT PRIMARY KEY,owner_epoch INTEGER NOT NULL,bytes INTEGER NOT NULL CHECK(bytes>0 AND bytes<=${EXTERNAL_INTENT_BYTES}),sha256 TEXT NOT NULL,chunks INTEGER NOT NULL CHECK(chunks>0)) STRICT;
CREATE TABLE ${t}_stage_chunks (intent TEXT NOT NULL REFERENCES ${t}_stages(intent) ON DELETE CASCADE,part INTEGER NOT NULL CHECK(part>=0),data TEXT NOT NULL,PRIMARY KEY(intent,part)) STRICT;
CREATE TRIGGER ${t}_stage_bound BEFORE INSERT ON ${t}_stages BEGIN
 SELECT CASE WHEN (SELECT count(*) FROM ${t}_stages)>=${EXTERNAL_STAGE_COUNT} OR (SELECT coalesce(sum(bytes),0) FROM ${t}_stages)+NEW.bytes>${EXTERNAL_STAGE_BYTES} THEN RAISE(ABORT,'External staging reservation limit exceeded.') END;
END;
`.trim() }] };
}
