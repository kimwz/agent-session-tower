import { defineStorageDomain, type DomainReadContext, type DomainWriteContext, type StorageDomain } from '../../storage/domain.js';
import type { DomainAuthority, StorageDomainSchema } from '../../storage/contract.js';
import { retentionSchema } from './storage-schema.js';
import { object, retentionHash, RETENTION_CHUNK_BYTES, rowsOf, validateRow, type RetentionChange, type RetentionDocuments, type RetentionRow } from './storage-codec.js';

export interface RetentionHead { authority: DomainAuthority | null; revision: number | null }
export interface RetentionWriteIntent {
  mode: 'update' | 'import' | 'restore'; revision: number | null; generation: number | null;
  changes?: RetentionChange[]; documents?: RetentionDocuments; manifestSha256?: string;
}
const fail = (message: string): never => { throw Object.assign(new Error(message), { storageCode: 'domain-failed' }); };
function integer(value: unknown, max: number): number { if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) fail('Invalid retention bound.'); return Number(value); }
function authority(context: DomainReadContext): DomainAuthority | null {
  const row = context.prepare('SELECT * FROM domain_imports WHERE domain = ?').get('retention') as Record<string, unknown> | undefined;
  if (!row) return null;
  if (row.authority !== 'database' && row.authority !== 'legacy-exported' || row.reader_contract !== 1 || row.writer_contract !== 1 || !Number.isSafeInteger(row.generation) || Number(row.generation) < 1) fail('Unknown retention authority contract.');
  return { domain: 'retention', authority: row.authority as DomainAuthority['authority'], generation: Number(row.generation), manifestSha256: String(row.manifest_sha256), readerContract: 1, writerContract: 1, committedAt: String(row.committed_at), appVersion: String(row.app_version), sourceHash: String(row.source_hash), ownerEpoch: Number(row.owner_epoch) };
}
function head(context: DomainReadContext): RetentionHead {
  const marker = authority(context);
  const state = context.prepare('SELECT revision FROM retention_state WHERE singleton = 1').get() as { revision: number } | undefined;
  if (marker?.authority === 'database') {
    const wrappers = context.prepare("SELECT count(*) AS n FROM retention_metadata WHERE kind IN ('journal','observations') AND id = ''").get() as { n: number };
    if (!state || wrappers.n !== 2) fail('Imported retention metadata is missing.');
  }
  return { authority: marker, revision: state?.revision ?? null };
}
function current(context: DomainReadContext, input: Record<string, unknown>): RetentionHead {
  const state = head(context);
  if (state.authority?.authority !== 'database' || state.revision !== input.revision || state.authority.generation !== input.generation) fail('Retention authority or current generation changed.');
  return state;
}
function put(context: DomainWriteContext, row: RetentionRow): void {
  validateRow(row);
  const parsed = JSON.parse(row.json);
  const value = object(row.kind === 'observation' ? parsed[1] : parsed);
  const phase = row.kind === 'entry' && typeof value.phase === 'string' ? value.phase : null;
  const archiveRevision = row.kind === 'policy' ? Number(value.archiveRevision) : null;
  const inactiveSince = row.kind === 'observation' ? String(value.since) : null;
  const next = context.prepare('SELECT coalesce(max(ordinal), -1) + 1 AS n FROM retention_metadata WHERE kind = ?').get(row.kind) as { n: number };
  context.prepare(`INSERT INTO retention_metadata (kind,id,ordinal,json,phase,archive_revision,inactive_since) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json,phase=excluded.phase,archive_revision=excluded.archive_revision,inactive_since=excluded.inactive_since`)
    .run(row.kind, row.id, next.n, row.json, phase, archiveRevision, inactiveSince);
}
/** B fixtures use this same handler and schema with only their actual cutover declaration added. */
export function retentionDomainFor(schema: StorageDomainSchema): StorageDomain {
  if (schema.domain !== retentionSchema.domain || JSON.stringify(schema.migrations) !== JSON.stringify(retentionSchema.migrations) || JSON.stringify(schema.preparation) !== JSON.stringify(retentionSchema.preparation)) throw new Error('Retention schema/contract mismatch.');
  return defineStorageDomain({ schema, commands: {
    head: { kind: 'read', run: context => head(context) },
    keys: { kind: 'read', run(context, payload) {
      const input = object(payload); current(context, input);
      const after = integer(input.after, Number.MAX_SAFE_INTEGER), kind = String(input.kind);
      return context.prepare('SELECT ordinal,length(CAST(id AS BLOB)) AS idBytes,length(CAST(json AS BLOB)) AS bytes FROM retention_metadata WHERE kind = ? AND ordinal >= ? ORDER BY ordinal LIMIT 32').all(kind, after);
    } },
    chunk: { kind: 'read', run(context, payload) {
      const input = object(payload); current(context, input);
      const offset = integer(input.offset, 200_000_000);
      const ordinal = integer(input.ordinal, Number.MAX_SAFE_INTEGER);
      const sql = input.field === 'id'
        ? 'SELECT substr(CAST(id AS BLOB), ?, ?) AS data FROM retention_metadata WHERE kind = ? AND ordinal = ?'
        : 'SELECT substr(CAST(json AS BLOB), ?, ?) AS data FROM retention_metadata WHERE kind = ? AND ordinal = ?';
      const row = context.prepare(sql).get(offset + 1, RETENTION_CHUNK_BYTES, String(input.kind), ordinal) as { data: Uint8Array } | undefined;
      if (!row) fail('Missing current retention row.');
      return Buffer.from(row!.data).toString('base64');
    } },
    begin: { kind: 'write', run(context, payload) {
      const input = object(payload), intent = String(input.intent);
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(intent) || !/^[0-9a-f]{64}$/.test(String(input.sha256))) fail('Invalid retention staging intent.');
      const bytes = integer(input.bytes, 200_000_000), chunks = integer(input.chunks, 1024);
      if (!bytes || chunks !== Math.ceil(bytes / RETENTION_CHUNK_BYTES)) fail('Invalid retention staging size.');
      context.prepare('INSERT INTO retention_stages (intent,owner_epoch,bytes,sha256,chunks) VALUES (?,?,?,?,?)').run(intent, context.ownerEpoch, bytes, String(input.sha256), chunks);
      return { intent };
    } },
    stage: { kind: 'write', run(context, payload) {
      const input = object(payload), intent = String(input.intent);
      const stage = context.prepare('SELECT * FROM retention_stages WHERE intent = ?').get(intent) as { owner_epoch: number; chunks: number; bytes: number } | undefined;
      if (!stage || stage.owner_epoch !== context.ownerEpoch) fail('Unknown retention stage owner.');
      const part = integer(input.part, stage!.chunks - 1), data = String(input.data), bytes = Buffer.from(data, 'base64');
      if (bytes.toString('base64') !== data || bytes.length !== Math.min(RETENTION_CHUNK_BYTES, stage!.bytes - part * RETENTION_CHUNK_BYTES)) fail('Invalid retention stage chunk.');
      context.prepare('INSERT INTO retention_stage_chunks (intent,part,data) VALUES (?,?,?)').run(intent, part, data);
      return { intent, part };
    } },
    commit: { kind: 'write', run(context, payload) {
      const intent = String(object(payload).intent);
      const stage = context.prepare('SELECT * FROM retention_stages WHERE intent = ?').get(intent) as { owner_epoch: number; chunks: number; bytes: number; sha256: string } | undefined;
      if (!stage || stage.owner_epoch !== context.ownerEpoch) fail('Unknown retention stage owner.');
      const parts = context.prepare('SELECT part,data FROM retention_stage_chunks WHERE intent = ? ORDER BY part').all(intent) as { part: number; data: string }[];
      if (parts.length !== stage!.chunks || parts.some((row, index) => row.part !== index)) fail('Incomplete retention stage.');
      const bytes = Buffer.concat(parts.map(row => Buffer.from(row.data, 'base64')));
      if (bytes.length !== stage!.bytes || retentionHash(bytes) !== stage!.sha256) fail('Retention stage hash mismatch.');
      const input = object(JSON.parse(bytes.toString('utf8'))) as unknown as RetentionWriteIntent;
      const state = head(context);
      if (input.mode === 'import') {
        // The common authority writer checks the actual A/B manifest, not a callback or fixture grant.
        if (state.authority) fail('Retention has already had an authority marker; never reimport JSON.');
        if (input.revision !== null || input.generation !== null || !input.documents) fail('Invalid retention first import.');
        rowsOf(input.documents); // Validate before any live replacement.
        context.authority.markImported({ manifestSha256: input.manifestSha256 ?? '' });
      } else if (input.mode === 'update' || input.mode === 'restore') current(context, input as unknown as Record<string, unknown>);
      else fail('Invalid retention write mode.');
      if (input.mode === 'import' || input.mode === 'restore') {
        if (!input.documents) fail('Missing retention restore documents.');
        const rows = rowsOf(input.documents!);
        context.prepare('DELETE FROM retention_metadata').run();
        for (const row of rows) put(context, row);
        const persisted = context.prepare('SELECT kind,id,json FROM retention_metadata').all() as unknown as RetentionRow[];
        const byKey = new Map(persisted.map(row => [JSON.stringify([row.kind, row.id]), row.json]));
        if (persisted.length !== rows.length || rows.some(row => byKey.get(JSON.stringify([row.kind, row.id])) !== row.json)) fail('Retention import/restore count or canonical row digest mismatch.');
      } else {
        if (!Array.isArray(input.changes)) fail('Missing retention changes.');
        for (const change of input.changes!) {
          validateRow(change);
          const previous = context.prepare('SELECT json FROM retention_metadata WHERE kind = ? AND id = ?').get(change.kind, change.id) as { json: string } | undefined;
          if ((previous?.json ?? null) !== change.previous) fail('Retention row changed before guarded write.');
          if (change.remove) {
            if (change.kind === 'entry' && previous && !['planned','blocked-provider'].includes(String(object(JSON.parse(previous.json)).phase))) fail('Retention metadata removal phase is protected.');
            if (change.kind === 'journal' || change.kind === 'observations') fail('Cannot remove retention document metadata.');
            context.prepare('DELETE FROM retention_metadata WHERE kind = ? AND id = ?').run(change.kind, change.id);
          } else put(context, change);
        }
      }
      const revision = (state.revision ?? 0) + 1;
      context.prepare('INSERT INTO retention_state (singleton,revision) VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision').run(revision);
      context.prepare('DELETE FROM retention_stages WHERE intent = ?').run(intent);
      return { revision, generation: context.authority.current()!.generation, mode: input.mode, intentSha256: stage!.sha256, ...(input.documents ? { documentsSha256: retentionHash(JSON.stringify(input.documents)) } : {}) };
    } },
  } });
}
export const retentionDomain = retentionDomainFor(retentionSchema);
