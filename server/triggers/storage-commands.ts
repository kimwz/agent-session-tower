import { offlineCompletionCommand, offlineAuthorityReceiptCommand } from '../storage/offline-completion.js';
import type { EngineState } from './state.js';
import { createHash } from 'node:crypto';
import { defineStorageDomain, type DomainReadContext, type DomainWriteContext, type StorageDomain } from '../storage/domain.js';
import type { DomainAuthority, StorageDomainSchema } from '../storage/contract.js';
import { triggersSchema, TRIGGER_STAGE_COUNT, TRIGGER_STAGE_BYTES } from './storage-schema.js';
import { canonical, object, triggerHash, TRIGGER_CHUNK_BYTES, TRIGGER_INTENT_BYTES, ROW_KINDS, WRAPPER_BYTES, ACCEPT_TRIGGER_BYTES, MAX_TRIGGER_BYTES, projectedJson, rowCost, validateRow, type TriggerRow } from './storage-codec.js';

export interface TriggersHead { storageId: string; authority: DomainAuthority | null; revision: number | null; logicalBytes: number | null }
/** Worker-private fence; never parsed from a public request. */
export interface TriggerAdmissionLink { storageId: string; generation: number; revision: number; eventId: string; requestId: string; eventSha256: string }
/** Fixed domain operation on the runs command's connection and transaction. */
export function linkTriggerAdmissions(context: DomainWriteContext, links: readonly TriggerAdmissionLink[], runs: readonly Record<string, unknown>[]): { revision: number; generation: number } {
  if (!links.length || links.length > 100) fail('Invalid trigger admission count.');
  const state = head(context), seen = new Set<string>();
  for (const link of links) {
    if (state.storageId !== link.storageId || state.authority?.authority !== 'database' || state.authority.generation !== link.generation || state.revision !== link.revision) fail('Trigger admission authority fence changed.');
    if (seen.has(link.eventId)) fail('Duplicate trigger admission event.'); seen.add(link.eventId);
    const row = context.prepare("SELECT kind,id,ordinal,json FROM triggers_rows WHERE kind = 'events' AND id = ?").get(link.eventId) as unknown as TriggerRow | undefined;
    if (!row || triggerHash(row.json) !== link.eventSha256) fail('Trigger admission event changed.');
    const otherEvents = context.prepare("SELECT json FROM triggers_rows WHERE kind = 'events' AND id != ?").all(link.eventId) as { json: string }[];
    if (otherEvents.some(item => object(JSON.parse(item.json)).requestId === link.requestId)) fail('Trigger request belongs to another event.');
    const event = object(JSON.parse(row.json)), input = object(event.input), target = object(input.target);
    const candidates = runs.filter(run => run.autoPromptId === link.requestId);
    if (candidates.length !== 1) fail('Trigger admission needs one fresh run.');
    const run = candidates[0], origin = object(run.origin);
    if (event.id !== link.eventId || event.requestId !== link.requestId || event.status !== 'claimed' || input.handler === 'coordinator' || input.remote !== undefined || input.untrustedInput === true || target.node !== 'local' || target.mode !== 'session'
      || run.status !== 'queued' || run.sessionId !== target.sessionId || origin.kind !== 'trigger' || origin.triggerId !== event.triggerId || origin.eventId !== event.id || origin.controllerId !== undefined) fail('Invalid local session trigger admission.');
    if (run.needsInstructions === true && !context.prepare("SELECT 1 FROM runs_rows WHERE kind = 'instruction' AND id = ?").get(String(run.id))) fail('Trigger admission instructions are incomplete.');
    const duplicates = context.prepare("SELECT id,json FROM runs_rows WHERE kind = 'run' AND id != ?").all(String(run.id)) as { id: string; json: string }[];
    if (duplicates.some(item => object(JSON.parse(item.json)).autoPromptId === link.requestId)) fail('Trigger request already admitted.');
    const json = canonical({ ...event,status: 'running',updatedAt: context.now,dispatch: { runId: run.id,sessionId: run.sessionId } });
    put(context,{ ...row,json }); recost(context,{ ...row,json },{});
  }
  const groups = context.prepare('SELECT kind,count(*) AS n,sum(logical_bytes) AS bytes FROM triggers_rows GROUP BY kind').all() as { kind: string; n: number; bytes: number }[];
  const size = WRAPPER_BYTES + groups.reduce((sum,row) => sum + row.bytes + (row.kind === 'settings' ? 0 : Math.max(0,row.n - 1)),0);
  const old = context.prepare('SELECT logical_bytes FROM triggers_state WHERE singleton = 1').get() as { logical_bytes: number };
  if (size > MAX_TRIGGER_BYTES && size > old.logical_bytes) fail('Trigger logical history is full.');
  const revision = state.revision! + 1;
  context.prepare('UPDATE triggers_state SET revision = ?,logical_bytes = ? WHERE singleton = 1').run(revision,size);
  return { revision,generation: state.authority!.generation };
}
export type TriggerWriteMode = 'grow' | 'settle' | 'import' | 'restore';
export interface TriggerIntentHeader { mode: TriggerWriteMode; revision: number | null; generation: number | null; manifestSha256?: string; documentsSha256?: string }
function fail(message: string): never { throw Object.assign(new Error(message), { storageCode: 'domain-failed' }); }
function integer(value: unknown, max: number): number { if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) fail('Invalid triggers bound.'); return Number(value); }
function head(context: DomainReadContext): TriggersHead {
  const marker = context.prepare('SELECT * FROM domain_imports WHERE domain = ?').get('triggers') as Record<string, unknown> | undefined;
  const state = context.prepare('SELECT revision,logical_bytes FROM triggers_state WHERE singleton = 1').get() as { revision: number; logical_bytes: number } | undefined;
  let authority: DomainAuthority | null = null;
  if (marker) {
    if (!['database','legacy-exported'].includes(String(marker.authority)) || marker.reader_contract !== 1 || marker.writer_contract !== 1 || !Number.isSafeInteger(marker.generation) || Number(marker.generation) < 1) fail('Unknown triggers authority contract.');
    authority = { domain: 'triggers', authority: marker.authority as DomainAuthority['authority'], generation: Number(marker.generation), manifestSha256: String(marker.manifest_sha256), readerContract: 1, writerContract: 1, committedAt: String(marker.committed_at), appVersion: String(marker.app_version), sourceHash: String(marker.source_hash), ownerEpoch: Number(marker.owner_epoch) };
    if (!state || !Number.isSafeInteger(state.revision) || state.revision < 1 || !Number.isSafeInteger(state.logical_bytes) || state.logical_bytes < 0) fail('Imported triggers state is missing or malformed.');
  } else if (state || context.prepare('SELECT 1 FROM triggers_rows LIMIT 1').get()) fail('Triggers rows exist without authority.');
  const storage = context.prepare("SELECT value FROM storage_meta WHERE key = 'storage_id'").get() as { value: string } | undefined;
  if (!storage || !/^[0-9a-f-]{36}$/.test(storage.value)) fail('Missing trigger storage identity.');
  return { storageId: storage.value,authority, revision: state?.revision ?? null, logicalBytes: state?.logical_bytes ?? null };
}
function current(context: DomainReadContext, input: Record<string, unknown>): TriggersHead {
  const value = head(context);
  if (value.authority?.authority !== 'database' || value.revision !== input.revision || value.authority.generation !== input.generation) fail('Triggers authority or current generation changed.');
  return value;
}
function put(context: DomainWriteContext, row: TriggerRow): void {
  validateRow(row);
  const value = JSON.parse(row.json);
  context.prepare(`INSERT INTO triggers_rows (kind,id,ordinal,json,logical_bytes,trigger_id,status) VALUES (?,?,?,?,0,?,?)
    ON CONFLICT(kind,id) DO UPDATE SET ordinal=excluded.ordinal,json=excluded.json,trigger_id=excluded.trigger_id,status=excluded.status`)
    .run(row.kind,row.id,row.ordinal,row.json,['triggers','tombstones'].includes(row.kind) ? row.id : row.kind === 'events' ? value.triggerId : row.kind === 'revisions' ? row.id : null,row.kind === 'events' ? value.status : null);
}
function recost(context: DomainWriteContext, row: TriggerRow, ledger: EngineState['onceConsumed']): void {
  if (!['triggers','tombstones','revisions'].includes(row.kind)) { context.prepare('UPDATE triggers_rows SET logical_bytes = ? WHERE kind = ? AND id = ?').run(rowCost(row,row.json),row.kind,row.id); return; }
  context.prepare('UPDATE triggers_rows SET logical_bytes = ? WHERE kind = ? AND id = ?').run(rowCost(row,projectedJson(row,ledger)),row.kind,row.id);
}
/** The same commands serve A current authority and B import; only the common manifest permits first import. */
export function triggersDomainFor(schema: StorageDomainSchema): StorageDomain {
  if (schema.domain !== triggersSchema.domain || canonical(schema.migrations) !== canonical(triggersSchema.migrations) || canonical(schema.preparation) !== canonical(triggersSchema.preparation)) throw new Error('Triggers schema/contract mismatch.');
  return defineStorageDomain({ schema, commands: {
    offlineAuthorityReceipt: offlineAuthorityReceiptCommand,
    offlineCompletion: offlineCompletionCommand('triggers_stages'),
    head: { kind: 'read', run: context => head(context) },
    bootstrapHistory: { kind: 'read', run: context => ({ stages: Number((context.prepare('SELECT count(*) AS n FROM triggers_stages').get() as { n: number }).n) }) },
    keys: { kind: 'read', run(context, payload) {
      const input = object(payload); current(context, input);
      return context.prepare('SELECT ordinal,length(CAST(id AS BLOB)) AS idBytes,length(CAST(json AS BLOB)) AS bytes FROM triggers_rows WHERE kind = ? AND ordinal >= ? ORDER BY ordinal LIMIT 32').all(String(input.kind), integer(input.after, Number.MAX_SAFE_INTEGER));
    } },
    chunk: { kind: 'read', run(context, payload) {
      const input = object(payload); current(context, input);
      if (!['id','json'].includes(String(input.field))) fail('Unknown triggers chunk field.');
      const sql = input.field === 'id'
        ? 'SELECT substr(CAST(id AS BLOB),?,?) AS data FROM triggers_rows WHERE kind = ? AND ordinal = ?'
        : 'SELECT substr(CAST(json AS BLOB),?,?) AS data FROM triggers_rows WHERE kind = ? AND ordinal = ?';
      const row = context.prepare(sql).get(integer(input.offset, TRIGGER_INTENT_BYTES) + 1, TRIGGER_CHUNK_BYTES, String(input.kind), integer(input.ordinal, Number.MAX_SAFE_INTEGER)) as { data: Uint8Array } | undefined;
      if (!row) fail('Missing current triggers row.');
      return Buffer.from(row.data).toString('base64');
    } },
    begin: { kind: 'write', run(context, payload) {
      const input = object(payload), intent = String(input.intent);
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(intent) || !/^[0-9a-f]{64}$/.test(String(input.sha256))) fail('Invalid triggers staging intent.');
      const bytes = integer(input.bytes, TRIGGER_INTENT_BYTES), chunks = integer(input.chunks, Math.ceil(TRIGGER_INTENT_BYTES / TRIGGER_CHUNK_BYTES));
      if (!bytes || chunks !== Math.ceil(bytes / TRIGGER_CHUNK_BYTES)) fail('Invalid triggers staging size.');
      const reserved = context.prepare('SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM triggers_stages').get() as { count: number; bytes: number };
      if (reserved.count >= TRIGGER_STAGE_COUNT || reserved.bytes + bytes > TRIGGER_STAGE_BYTES) fail('Triggers staging reservation limit exceeded.');
      context.prepare('INSERT INTO triggers_stages (intent,owner_epoch,bytes,sha256,chunks) VALUES (?,?,?,?,?)').run(intent, context.ownerEpoch, bytes, String(input.sha256), chunks);
      return { intent };
    } },
    stage: { kind: 'write', run(context, payload) {
      const input = object(payload), intent = String(input.intent);
      const stage = context.prepare('SELECT * FROM triggers_stages WHERE intent = ?').get(intent) as { owner_epoch: number; chunks: number; bytes: number } | undefined;
      if (!stage || stage.owner_epoch !== context.ownerEpoch) fail('Unknown triggers stage owner.');
      const part = integer(input.part, stage.chunks - 1), data = String(input.data), bytes = Buffer.from(data, 'base64');
      if (bytes.toString('base64') !== data || bytes.length !== Math.min(TRIGGER_CHUNK_BYTES, stage.bytes - part * TRIGGER_CHUNK_BYTES)) fail('Invalid triggers stage chunk.');
      context.prepare('INSERT INTO triggers_stage_chunks (intent,part,data) VALUES (?,?,?)').run(intent, part, data);
      return { intent, part };
    } },
    commit: { kind: 'write', run(context, payload) {
      const intent = String(object(payload).intent);
      const stage = context.prepare('SELECT * FROM triggers_stages WHERE intent = ?').get(intent) as { owner_epoch: number; chunks: number; bytes: number; sha256: string } | undefined;
      if (!stage || stage.owner_epoch !== context.ownerEpoch) fail('Unknown triggers stage owner.');
      const parts = context.prepare('SELECT part,data FROM triggers_stage_chunks WHERE intent = ? ORDER BY part').all(intent) as { part: number; data: string }[];
      if (parts.length !== stage.chunks || parts.some((row,index) => row.part !== index)) fail('Incomplete triggers stage.');
      const bytes = Buffer.concat(parts.map(row => Buffer.from(row.data, 'base64')));
      if (bytes.length !== stage.bytes || triggerHash(bytes) !== stage.sha256) fail('Triggers stage hash mismatch.');
      const separator = bytes.indexOf(10);
      if (separator < 0) fail('Missing triggers intent header.');
      const header = object(JSON.parse(bytes.subarray(0,separator).toString('utf8')));
      const state = head(context);
      if (header.mode === 'import') {
        if (state.authority || header.revision !== null || header.generation !== null) fail('Triggers authority exists; JSON reimport is forbidden.');
        context.authority.markImported({ manifestSha256: String(header.manifestSha256 ?? '') });
      } else current(context, header);
      if (!['grow','settle','import','restore'].includes(String(header.mode))) fail('Unknown triggers write mode.');
      const replacing = header.mode === 'import' || header.mode === 'restore';
      const evidence = header.mode === 'restore' ? context.prepare("SELECT kind,id,ordinal,json FROM triggers_rows WHERE kind IN ('onceConsumed','fired','events','cursors','recentFires')").all() as unknown as TriggerRow[] : [];
      const currentEventIds = new Set(evidence.filter(row => row.kind === 'events').map(row => row.id));
      if (replacing) context.prepare('DELETE FROM triggers_rows').run();
      const keys = new Set<string>();
      const changed: TriggerRow[] = []; const consumed = new Set<string>();
      const request = createHash('sha256').update(canonical({ mode: header.mode }) + '\n');
      let offset = separator + 1;
      while (offset < bytes.length) {
        const end = bytes.indexOf(10,offset);
        if (end < 0) fail('Incomplete triggers intent row.');
        const line = bytes.subarray(offset,end);
        if (!Buffer.from(line.toString('utf8')).equals(line)) fail('Triggers staging row is not lossless UTF-8.');
        request.update(bytes.subarray(offset,end + 1));
        const item = object(JSON.parse(bytes.subarray(offset,end).toString('utf8')));
        const kind = String(item.kind) as TriggerRow['kind'], id = String(item.id), key = canonical([kind,id]);
        if (keys.has(key)) fail('Duplicate triggers intent row.'); keys.add(key);
        const previous = context.prepare('SELECT json,ordinal FROM triggers_rows WHERE kind = ? AND id = ?').get(kind,id) as { json: string; ordinal: number } | undefined;
        if (!replacing && (item.previousSha256 === null ? !!previous : !previous || triggerHash(previous.json) !== item.previousSha256 || previous.ordinal !== item.previousOrdinal)) fail('Triggers row changed before guarded write.');
        const row: TriggerRow = { kind,id,ordinal: integer(item.ordinal,Number.MAX_SAFE_INTEGER),json: String(item.json) };
        validateRow(row);
        // Absence after pruning proves nothing about whether an event was already dispatched.
        if (header.mode === 'restore' && kind === 'events' && !currentEventIds.has(id) && ['queued','claimed','running'].includes(JSON.parse(row.json).status))
          fail('Restore would resurrect an absent unfinished trigger event.');
        if (kind === 'onceConsumed') consumed.add(id);
        if (item.remove === true) {
          if (replacing || !previous || kind === 'settings') fail('Invalid trigger deletion.');
          context.prepare('DELETE FROM triggers_rows WHERE kind = ? AND id = ?').run(kind,id);
        } else { put(context,row); changed.push(row); }
        offset = end + 1;
      }
      // The SDK owns this transaction: refusal rolls back the replacement and its receipt together.
      for (const previous of evidence) {
        const row = context.prepare('SELECT json FROM triggers_rows WHERE kind = ? AND id = ?').get(previous.kind,previous.id) as { json: string } | undefined;
        const old = JSON.parse(previous.json), next = row ? JSON.parse(row.json) : undefined;
        const same = (a: unknown, b: unknown) => canonical(a ?? null) === canonical(b ?? null);
        if (previous.kind === 'onceConsumed' || previous.kind === 'fired' || previous.kind === 'recentFires') {
          if (!row || !same(old,next)) fail('Restore would retreat trigger execution evidence.');
        } else if (previous.kind === 'events') {
          if (!next || ['requestId','dedupKey','triggerId','status','claimedAt','dispatch','issueActions'].some(key => !same(old[key],next[key])))
            fail('Restore would retreat trigger dispatch or cancellation evidence.');
        } else if (['polling','github','lastSlot','turnedOffAt'].some(key => old[key] !== undefined && !same(old[key],next?.[key])))
          fail('Restore would retreat trigger cursor execution evidence.');
      }
      const requestSha256 = request.digest('hex');
      if (requestSha256 !== header.requestSha256) fail('Triggers canonical request hash mismatch.');
      // Recompute only changed rows and definitions affected by changed independent consumption.
      const ledger = consumed.size || changed.some(row => ['triggers','tombstones','revisions'].includes(row.kind))
        ? Object.fromEntries((context.prepare("SELECT id,json FROM triggers_rows WHERE kind = 'onceConsumed'").all() as { id: string; json: string }[]).map(row => [row.id,JSON.parse(row.json)])) : {};
      for (const row of changed) recost(context,row,ledger);
      for (const id of consumed) for (const row of context.prepare("SELECT kind,id,ordinal,json FROM triggers_rows WHERE trigger_id = ? AND kind IN ('triggers','tombstones')").all(id) as unknown as TriggerRow[]) recost(context,row,ledger);
      const recosted = new Set<string>();
      for (const id of consumed) for (const row of context.prepare("SELECT kind,id,ordinal,json FROM triggers_rows WHERE kind = 'revisions' AND EXISTS (SELECT 1 FROM json_each(triggers_rows.json) WHERE json_extract(value,'$.id') = ?)").all(id) as unknown as TriggerRow[]) {
        if (recosted.has(row.id)) continue;
        recosted.add(row.id); recost(context,row,ledger);
      }
      const groups = context.prepare('SELECT kind,count(*) AS n,sum(logical_bytes) AS bytes,count(DISTINCT ordinal) AS distinct_n,min(ordinal) AS low,max(ordinal) AS high FROM triggers_rows GROUP BY kind').all() as { kind: string; n: number; bytes: number; distinct_n: number; low: number; high: number }[];
      if (groups.find(row => row.kind === 'settings')?.n !== 1 || groups.some(row => row.low !== 0 || row.high !== row.n - 1 || row.distinct_n !== row.n)) fail('Invalid trigger collection order or settings.');
      const size = WRAPPER_BYTES + groups.reduce((sum,row) => sum + row.bytes + (row.kind === 'settings' ? 0 : Math.max(0,row.n - 1)),0);
      const old = context.prepare('SELECT logical_bytes FROM triggers_state WHERE singleton = 1').get() as { logical_bytes: number } | undefined;
      const limit = header.mode === 'grow' ? ACCEPT_TRIGGER_BYTES : MAX_TRIGGER_BYTES;
      if (header.mode !== 'import' && size > limit && size > (old?.logical_bytes ?? 0)) fail('Trigger logical history is full.');
      if (replacing) {
        const hash = createHash('sha256');
        for (const kind of ROW_KINDS) for (const row of context.prepare('SELECT kind,id,ordinal,json FROM triggers_rows WHERE kind = ? ORDER BY ordinal').all(kind) as unknown as TriggerRow[]) {
          validateRow(row); hash.update(canonical([row.kind,row.id,row.ordinal])).update('\n').update(row.json).update('\n');
        }
        if (hash.digest('hex') !== header.documentsSha256) fail('Trigger restore/import row digest mismatch.');
      }
      const revision = (state.revision ?? 0) + 1;
      context.prepare('INSERT INTO triggers_state (singleton,revision,logical_bytes) VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,logical_bytes=excluded.logical_bytes').run(revision,size);
      context.prepare('DELETE FROM triggers_stages WHERE intent = ?').run(intent);
      return { revision, generation: context.authority.current()!.generation, mode: header.mode, requestSha256, intentSha256: stage.sha256, ...(typeof header.documentsSha256 === 'string' ? { documentsSha256: header.documentsSha256 } : {}) };
    } },
  } });
}
export const triggersDomain = triggersDomainFor(triggersSchema);
