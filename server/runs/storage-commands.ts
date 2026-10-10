import { offlineCompletionCommand, offlineAuthorityReceiptCommand } from '../storage/offline-completion.js';
import { createHash } from 'node:crypto';
import { linkTriggerAdmissions, type TriggerAdmissionLink } from '../triggers/storage-commands.js';
import { defineStorageDomain, type DomainReadContext, type DomainWriteContext, type StorageDomain } from '../storage/domain.js';
import type { DomainAuthority, StorageDomainSchema } from '../storage/contract.js';
import { runsSchema, RUN_STAGE_COUNT, RUN_STAGE_BYTES } from './storage-schema.js';
import { canonical, object, runHash, RUN_CHUNK_BYTES, RUN_INTENT_BYTES, RUN_SOURCE_BYTES, RUN_DEPENDENCY_BYTES, validateRow, type RunRow } from './storage-codec.js';

export interface RunsHead { authority: DomainAuthority | null; revision: number | null }
export type RunWriteMode = 'admission' | 'transition' | 'output' | 'delete' | 'markers' | 'update' | 'import' | 'restore';
export interface RunIntentHeader { mode: RunWriteMode; revision: number | null; generation: number | null; manifestSha256?: string; documentsSha256?: string; triggerLinks?: readonly TriggerAdmissionLink[] }
function fail(message: string): never { throw Object.assign(new Error(message), { storageCode: 'domain-failed' }); }
function integer(value: unknown, max: number): number { if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) fail('Invalid runs bound.'); return Number(value); }
function head(context: DomainReadContext): RunsHead {
  const marker = context.prepare('SELECT * FROM domain_imports WHERE domain = ?').get('runs') as Record<string, unknown> | undefined;
  const state = context.prepare('SELECT revision FROM runs_state WHERE singleton = 1').get() as { revision: number } | undefined;
  let authority: DomainAuthority | null = null;
  if (marker) {
    if (!['database','legacy-exported'].includes(String(marker.authority)) || marker.reader_contract !== 1 || marker.writer_contract !== 1 || !Number.isSafeInteger(marker.generation) || Number(marker.generation) < 1) fail('Unknown runs authority contract.');
    authority = { domain: 'runs', authority: marker.authority as DomainAuthority['authority'], generation: Number(marker.generation), manifestSha256: String(marker.manifest_sha256), readerContract: 1, writerContract: 1, committedAt: String(marker.committed_at), appVersion: String(marker.app_version), sourceHash: String(marker.source_hash), ownerEpoch: Number(marker.owner_epoch) };
    if (!state || !Number.isSafeInteger(state.revision) || state.revision < 1) fail('Imported runs state is missing or malformed.');
  } else if (state || context.prepare('SELECT 1 FROM runs_rows LIMIT 1').get()) fail('Runs rows exist without authority.');
  return { authority, revision: state?.revision ?? null };
}
function current(context: DomainReadContext, input: Record<string, unknown>): RunsHead {
  const value = head(context);
  if (value.authority?.authority !== 'database' || value.revision !== input.revision || value.authority.generation !== input.generation) fail('Runs authority or current generation changed.');
  return value;
}
function put(context: DomainWriteContext, row: RunRow): void {
  validateRow(row);
  const value = object(JSON.parse(row.json));
  const next = context.prepare('SELECT coalesce(max(ordinal),-1)+1 AS n FROM runs_rows WHERE kind = ?').get(row.kind) as { n: number };
  context.prepare(`INSERT INTO runs_rows (kind,id,ordinal,json,status,session_id) VALUES (?,?,?,?,?,?)
    ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json,status=excluded.status,session_id=excluded.session_id`)
    .run(row.kind, row.id, next.n, row.json, row.kind === 'run' ? String(value.status) : null, row.kind === 'run' ? String(value.sessionId) : null);
}
/** The same commands serve A current authority and B import; only the common manifest permits first import. */
export function runsDomainFor(schema: StorageDomainSchema): StorageDomain {
  if (schema.domain !== runsSchema.domain || canonical(schema.migrations) !== canonical(runsSchema.migrations) || canonical(schema.preparation) !== canonical(runsSchema.preparation)) throw new Error('Runs schema/contract mismatch.');
  return defineStorageDomain({ schema, commands: {
    offlineAuthorityReceipt: offlineAuthorityReceiptCommand,
    offlineCompletion: offlineCompletionCommand('runs_stages'),
    head: { kind: 'read', run: context => head(context) },
    bootstrapHistory: { kind: 'read', run: context => ({ stages: Number((context.prepare('SELECT count(*) AS n FROM runs_stages').get() as { n: number }).n) }) },
    keys: { kind: 'read', run(context, payload) {
      const input = object(payload); current(context, input);
      return context.prepare('SELECT ordinal,length(CAST(id AS BLOB)) AS idBytes,length(CAST(json AS BLOB)) AS bytes FROM runs_rows WHERE kind = ? AND ordinal >= ? ORDER BY ordinal LIMIT 32').all(String(input.kind), integer(input.after, Number.MAX_SAFE_INTEGER));
    } },
    chunk: { kind: 'read', run(context, payload) {
      const input = object(payload); current(context, input);
      if (!['id','json'].includes(String(input.field))) fail('Unknown runs chunk field.');
      const sql = input.field === 'id'
        ? 'SELECT substr(CAST(id AS BLOB),?,?) AS data FROM runs_rows WHERE kind = ? AND ordinal = ?'
        : 'SELECT substr(CAST(json AS BLOB),?,?) AS data FROM runs_rows WHERE kind = ? AND ordinal = ?';
      const row = context.prepare(sql).get(integer(input.offset, RUN_INTENT_BYTES) + 1, RUN_CHUNK_BYTES, String(input.kind), integer(input.ordinal, Number.MAX_SAFE_INTEGER)) as { data: Uint8Array } | undefined;
      if (!row) fail('Missing current runs row.');
      return Buffer.from(row.data).toString('base64');
    } },
    begin: { kind: 'write', run(context, payload) {
      const input = object(payload), intent = String(input.intent);
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(intent) || !/^[0-9a-f]{64}$/.test(String(input.sha256))) fail('Invalid runs staging intent.');
      const bytes = integer(input.bytes, RUN_INTENT_BYTES), chunks = integer(input.chunks, Math.ceil(RUN_INTENT_BYTES / RUN_CHUNK_BYTES));
      if (!bytes || chunks !== Math.ceil(bytes / RUN_CHUNK_BYTES)) fail('Invalid runs staging size.');
      const reserved = context.prepare('SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM runs_stages').get() as { count: number; bytes: number };
      if (reserved.count >= RUN_STAGE_COUNT || reserved.bytes + bytes > RUN_STAGE_BYTES) fail('Runs staging reservation limit exceeded.');
      context.prepare('INSERT INTO runs_stages (intent,owner_epoch,bytes,sha256,chunks) VALUES (?,?,?,?,?)').run(intent, context.ownerEpoch, bytes, String(input.sha256), chunks);
      return { intent };
    } },
    stage: { kind: 'write', run(context, payload) {
      const input = object(payload), intent = String(input.intent);
      const stage = context.prepare('SELECT * FROM runs_stages WHERE intent = ?').get(intent) as { owner_epoch: number; chunks: number; bytes: number } | undefined;
      if (!stage || stage.owner_epoch !== context.ownerEpoch) fail('Unknown runs stage owner.');
      const part = integer(input.part, stage.chunks - 1), data = String(input.data), bytes = Buffer.from(data, 'base64');
      if (bytes.toString('base64') !== data || bytes.length !== Math.min(RUN_CHUNK_BYTES, stage.bytes - part * RUN_CHUNK_BYTES)) fail('Invalid runs stage chunk.');
      context.prepare('INSERT INTO runs_stage_chunks (intent,part,data) VALUES (?,?,?)').run(intent, part, data);
      return { intent, part };
    } },
    commit: { kind: 'write', run(context, payload) {
      const intent = String(object(payload).intent);
      const stage = context.prepare('SELECT * FROM runs_stages WHERE intent = ?').get(intent) as { owner_epoch: number; chunks: number; bytes: number; sha256: string } | undefined;
      if (!stage || stage.owner_epoch !== context.ownerEpoch) fail('Unknown runs stage owner.');
      const parts = context.prepare('SELECT part,data FROM runs_stage_chunks WHERE intent = ? ORDER BY part').all(intent) as { part: number; data: string }[];
      if (parts.length !== stage.chunks || parts.some((row,index) => row.part !== index)) fail('Incomplete runs stage.');
      const bytes = Buffer.concat(parts.map(row => Buffer.from(row.data, 'base64')));
      if (bytes.length !== stage.bytes || runHash(bytes) !== stage.sha256) fail('Runs stage hash mismatch.');
      const separator = bytes.indexOf(10);
      if (separator < 0) fail('Missing runs intent header.');
      const header = object(JSON.parse(bytes.subarray(0,separator).toString('utf8')));
      const state = head(context);
      if (header.mode === 'import') {
        if (state.authority || header.revision !== null || header.generation !== null) fail('Runs authority exists; JSON reimport is forbidden.');
        context.authority.markImported({ manifestSha256: String(header.manifestSha256 ?? '') });
      } else current(context, header);
      if (!['admission','transition','output','delete','markers','update','import','restore'].includes(String(header.mode))) fail('Unknown runs write mode.');
      if (header.triggerLinks !== undefined) {
        if (!['admission','update'].includes(String(header.mode)) || !Array.isArray(header.triggerLinks) || !header.triggerLinks.length || header.triggerLinks.length > 100) fail('Invalid trigger link write mode.');
        const requests = new Set(header.triggerLinks.map(link => String(object(link).requestId)));
        // Inspect before row changes: removing an old run in this same intent cannot authorize replay.
        for (const row of context.prepare("SELECT json FROM runs_rows WHERE kind = 'run'").all() as { json: string }[])
          if (requests.has(String(object(JSON.parse(row.json)).autoPromptId))) fail('Trigger request already admitted.');
      }
      const replacing = header.mode === 'import' || header.mode === 'restore';
      if (replacing) context.prepare('DELETE FROM runs_rows').run();
      const keys = new Set<string>();
      const admission: RunRow[] = [];
      const freshRuns: Record<string, unknown>[] = [];
      const request = createHash('sha256').update(canonical({ mode: header.mode,...(header.triggerLinks !== undefined ? { triggerLinks: header.triggerLinks } : {}) }) + '\n');
      let offset = separator + 1;
      while (offset < bytes.length) {
        const end = bytes.indexOf(10,offset);
        if (end < 0) fail('Incomplete runs intent row.');
        const line = bytes.subarray(offset,end);
        if (!Buffer.from(line.toString('utf8')).equals(line)) fail('Runs staging row is not lossless UTF-8.');
        request.update(bytes.subarray(offset,end + 1));
        const item = object(JSON.parse(bytes.subarray(offset,end).toString('utf8')));
        const kind = String(item.kind) as RunRow['kind'], id = String(item.id), key = canonical([kind,id]);
        if (keys.has(key)) fail('Duplicate runs intent row.'); keys.add(key);
        const previous = context.prepare('SELECT json FROM runs_rows WHERE kind = ? AND id = ?').get(kind,id) as { json: string } | undefined;
        if (!replacing && (item.previousSha256 === null ? !!previous : !previous || runHash(previous.json) !== item.previousSha256)) fail('Runs row changed before guarded write.');
        const row = { kind, id, json: canonical(item.value) };
        if (kind === 'run' && !previous && !item.remove) freshRuns.push(object(item.value));
        if (header.mode === 'admission') {
          if (previous || item.remove) fail('Admission must insert fresh identities.');
          admission.push(row);
        }
        if (header.mode === 'delete' && item.remove !== true) fail('Delete command cannot write a row.');
        if (header.mode === 'output' || header.mode === 'markers') {
          if (item.remove && kind === 'run' || (header.mode === 'output' && kind !== 'run') || !previous && kind === 'run' || kind === 'created') fail('Invalid scoped run change.');
          if (kind === 'run') {
            const before = object(JSON.parse(previous!.json)), after = object(item.value);
            for (const key of header.mode === 'output' ? ['output'] : ['needsInstructions','keepQueued','retain']) { delete before[key]; delete after[key]; }
            if (canonical(before) !== canonical(after)) fail('Scoped run change alters other fields.');
          }
        }
        if (item.remove === true) {
          if (replacing || !previous) fail('Invalid runs deletion.');
          validateRow({ kind, id, json: previous.json });
          context.prepare('DELETE FROM runs_rows WHERE kind = ? AND id = ?').run(kind,id);
        } else put(context,row);
        offset = end + 1;
      }
      const requestSha256 = request.digest('hex');
      if (requestSha256 !== header.requestSha256) fail('Runs canonical request hash mismatch.');
      let triggerAdmission: { revision: number; generation: number } | undefined;
      if (header.triggerLinks !== undefined) {
        if (!['admission','update'].includes(String(header.mode)) || !Array.isArray(header.triggerLinks)) fail('Invalid trigger link write mode.');
        triggerAdmission = linkTriggerAdmissions(context,header.triggerLinks as TriggerAdmissionLink[],freshRuns);
      }
      if (header.mode === 'admission') {
        const runs = admission.filter(row => row.kind === 'run');
        if (runs.length !== 1) fail('Admission needs exactly one run.');
        const run = object(JSON.parse(runs[0].json));
        if (run.status !== 'queued' || run.needsInstructions === true && !admission.some(row => row.kind === 'instruction' && row.id === runs[0].id)) fail('Admission instructions are incomplete.');
        for (const row of admission) {
          if (row.kind === 'created' && object(JSON.parse(row.json)).runId !== runs[0].id || row.kind === 'instruction' && row.id !== runs[0].id) fail('Admission dependency identity mismatch.');
        }
      }
      for (const [kind,limit] of [['run',RUN_SOURCE_BYTES],['created',RUN_DEPENDENCY_BYTES],['instruction',RUN_DEPENDENCY_BYTES]] as const) {
        const count = context.prepare("SELECT count(*) AS n,coalesce(sum(length(CAST(json AS BLOB))),0) AS bytes,coalesce(sum(length(CAST(id AS BLOB))),0) AS ids FROM runs_rows WHERE kind = ?").get(kind) as { n: number; bytes: number; ids: number };
        const size = count.bytes + Math.max(0,count.n - 1) + 2 + (kind === 'instruction' ? count.ids + 3 * count.n : 0);
        if (size > 6 * limit) fail('Runs current state exceeds its lossless canonical allowance.');
      }
      if (replacing) {
        const hash = createHash('sha256');
        for (const kind of ['created','run','instruction']) {
          const rows = context.prepare(`SELECT kind,id,json FROM runs_rows WHERE kind = ? ORDER BY ${kind === 'instruction' ? 'id' : 'ordinal'}`).all(kind) as unknown as RunRow[];
          for (const row of rows) { validateRow(row); hash.update(canonical([row.kind,row.id])).update('\n').update(row.json).update('\n'); }
        }
        if (hash.digest('hex') !== header.documentsSha256) fail('Runs restore/import canonical row digest mismatch.');
      }
      const revision = (state.revision ?? 0) + 1;
      context.prepare('INSERT INTO runs_state (singleton,revision) VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision').run(revision);
      context.prepare('DELETE FROM runs_stages WHERE intent = ?').run(intent);
      return { revision, generation: context.authority.current()!.generation, mode: header.mode, requestSha256, intentSha256: stage.sha256, ...(triggerAdmission ? { triggerAdmission } : {}), ...(typeof header.documentsSha256 === 'string' ? { documentsSha256: header.documentsSha256 } : {}) };
    } },
  } });
}
export const runsDomain = runsDomainFor(runsSchema);
