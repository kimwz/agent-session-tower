import { defineStorageDomain, type DomainReadContext, type DomainWriteContext, type StorageDomain } from '../storage/domain.js';
import { StorageCommandError, type DomainAuthority, type StorageDomainSchema } from '../storage/contract.js';
import { permissionHash, checkPermissionBounds, validatePermissionRow, PERMISSION_CHUNK_BYTES, PERMISSION_BYTES, type PermissionRow, type PermissionRowKind, type PermissionChange } from './storage-codec.js';
import { permissionsSchema } from './storage-schema.js';

export interface PermissionsHead { revision: number | null; authority?: DomainAuthority }
export interface PermissionsFence { revision: number; generation: number }
const fail = (message: string): never => { throw new StorageCommandError({ phase:'command',code:'domain-failed',message,disposition:'not-committed',retryable:false }); };
const obj = (v: unknown): Record<string,unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v)) fail('Malformed permission command.'); return v as Record<string,unknown>; };
const tables = { rule:'permission_rules',request:'permission_requests',codex:'permission_codex_files',meta:'permission_metadata' } as const;
function table(kind: unknown): string { if (typeof kind !== 'string' || !Object.hasOwn(tables,kind)) fail('Unknown permission row kind.'); return tables[kind as PermissionRowKind]; }
export function permissionsHead(c: DomainReadContext): PermissionsHead {
  const row = c.prepare('SELECT revision FROM permission_state WHERE singleton=1').get() as { revision:number } | undefined;
  const authority = c.prepare('SELECT * FROM domain_imports WHERE domain=?').get('permissions') as Record<string,unknown> | undefined;
  // Authority projection follows the common authority schema, never trusts the caller.
  return { revision:row?.revision ?? null,...(authority ? { authority:{ domain:'permissions',authority:authority.authority as DomainAuthority['authority'],generation:authority.generation as number,manifestSha256:authority.manifest_sha256 as string,readerContract:authority.reader_contract as number,writerContract:authority.writer_contract as number,committedAt:authority.committed_at as string,appVersion:authority.app_version as string,sourceHash:authority.source_hash as string,ownerEpoch:authority.owner_epoch as number } } : {}) };
}
function current(c: DomainReadContext, p: Record<string,unknown>): PermissionsHead {
  const h = permissionsHead(c);
  if (h.authority?.authority !== 'database' || h.revision !== p.revision || h.authority.generation !== p.generation) fail('Permission current generation/revision mismatch.');
  return h;
}
function bounded(c:DomainReadContext):void {
  let bytes=0,count=0;
  for (const kind of Object.keys(tables)) {
    const r=c.prepare(`SELECT coalesce(sum(length(CAST(json AS BLOB))),0) AS bytes,count(*) AS count FROM ${table(kind)}`).get() as { bytes:number;count:number };
    bytes+=r.bytes; count+=r.count;
  }
  if (bytes>PERMISSION_BYTES || count>PERMISSION_BYTES) fail('Permission current rows exceed bounded allowance.');
}
function rows(c: DomainReadContext): PermissionRow[] {
  bounded(c);
  return (Object.keys(tables) as PermissionRowKind[]).flatMap(kind => (c.prepare(`SELECT id,ordinal,json FROM ${table(kind)} ORDER BY ordinal,id`).all() as unknown as Omit<PermissionRow,'kind'>[]).map(row => ({ ...row,kind })));
}
function put(c: DomainWriteContext,r: PermissionRow): void {
  validatePermissionRow(r);
  const v = JSON.parse(r.json);
  if (r.kind === 'rule') c.prepare('INSERT INTO permission_rules(id,ordinal,json,scope,session_id,source,expires_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ordinal=excluded.ordinal,json=excluded.json,scope=excluded.scope,session_id=excluded.session_id,source=excluded.source,expires_at=excluded.expires_at').run(r.id,r.ordinal,r.json,v.scope,v.sessionId ?? null,v.source,v.expiresAt ?? null);
  else if (r.kind === 'request') c.prepare('INSERT INTO permission_requests(id,ordinal,json,status,session_id,provider,type,review,created_at,decided_at,notification,run_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ordinal=excluded.ordinal,json=excluded.json,status=excluded.status,session_id=excluded.session_id,provider=excluded.provider,type=excluded.type,review=excluded.review,created_at=excluded.created_at,decided_at=excluded.decided_at,notification=excluded.notification,run_status=excluded.run_status').run(r.id,r.ordinal,r.json,v.status,v.sessionId,v.provider ?? null,v.rule.kind,v.review?.status ?? null,v.createdAt,v.decidedAt ?? null,v.notification?.state ?? null,v.run?.status ?? null);
  else c.prepare(`INSERT INTO ${table(r.kind)}(id,ordinal,json) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET ordinal=excluded.ordinal,json=excluded.json`).run(r.id,r.ordinal,r.json);
}
export function permissionsDomainFor(schema: StorageDomainSchema): StorageDomain {
  return defineStorageDomain({ schema,commands:{
    head:{ kind:'read',run(c) { return permissionsHead(c); } },
    keys:{ kind:'read',run(c,value) { const p=obj(value); current(c,p); bounded(c); const t=table(p.kind); if (!Number.isSafeInteger(p.after) || (p.after as number)<0) fail('Invalid permission page.'); const page=c.prepare(`SELECT * FROM ${t} ORDER BY ordinal,id LIMIT 32 OFFSET ?`).all(p.after as number) as Record<string,unknown>[];
      return page.map(r=>{
        const row={ kind:p.kind as PermissionRowKind,id:r.id as string,ordinal:r.ordinal as number,json:r.json as string }; validatePermissionRow(row); const v=JSON.parse(row.json);
        const matches = row.kind==='rule' ? r.scope===v.scope && r.session_id===(v.sessionId ?? null) && r.source===v.source && r.expires_at===(v.expiresAt ?? null)
          : row.kind==='request' ? r.status===v.status && r.session_id===v.sessionId && r.provider===(v.provider ?? null) && r.type===v.rule.kind && r.review===(v.review?.status ?? null) && r.created_at===v.createdAt && r.decided_at===(v.decidedAt ?? null) && r.notification===(v.notification?.state ?? null) && r.run_status===(v.run?.status ?? null) : true;
        if (!matches) fail('Permission search projection disagrees with its validated payload.');
        return { id:row.id,ordinal:row.ordinal,bytes:Buffer.byteLength(row.json) };
      }); } },
    chunk:{ kind:'read',run(c,value) { const p=obj(value); current(c,p); const t=table(p.kind); if (typeof p.id !== 'string' || !Number.isSafeInteger(p.offset) || (p.offset as number)<0 || (p.offset as number)>=PERMISSION_BYTES) fail('Invalid permission chunk.'); const id=p.id; if (typeof id !== 'string') throw new Error('Invalid permission chunk identity.'); const row=c.prepare(`SELECT substr(CAST(json AS BLOB),?,?) AS data FROM ${t} WHERE id=?`).get((p.offset as number)+1,PERMISSION_CHUNK_BYTES,id) as { data:Uint8Array } | undefined; if (!row) fail('Permission row missing.'); return Buffer.from(row!.data).toString('base64'); } },
    commit:{ kind:'write',run(c,value) {
      const p=obj(value), h=permissionsHead(c);
      if (!['import','update','restore'].includes(String(p.mode))) fail('Unknown permission write mode.');
      if (p.mode === 'import') {
        if (h.authority || h.revision !== null || p.revision !== null || p.generation !== null || typeof p.manifestSha256 !== 'string' || !/^[a-f\d]{64}$/.test(p.manifestSha256)) fail('Permission import requires sealed first-generation source.');
      } else current(c,p);
      if (!Array.isArray(p.changes) || p.changes.length>PERMISSION_BYTES) fail('Invalid permission changes.');
      const seen=new Set<string>();
      for (const raw of p.changes as PermissionChange[]) {
        validatePermissionRow(raw); const key=JSON.stringify([raw.kind,raw.id]); if (seen.has(key)) fail('Duplicate permission change.'); seen.add(key);
        const prior=c.prepare(`SELECT json FROM ${table(raw.kind)} WHERE id=?`).get(raw.id) as { json:string } | undefined;
        if (p.mode==='update') { if ((prior?.json ?? null)!==raw.previous) fail('Permission row changed before guarded write.'); }
        else if (raw.previous !== null || raw.remove) fail('Import/restore must carry full validated rows.');
        if (p.mode==='restore' && raw.kind!=='rule' && !(raw.kind==='meta' && raw.id==='autoReview') && (prior?.json ?? null)!==raw.json) fail('Settings restore cannot alter local requests/notices/files/lost metadata.');
        if (raw.remove !== undefined && raw.remove !== true) fail('Malformed permission deletion.');
      }
      if (p.mode==='restore') for (const r of rows(c)) if (r.kind!=='rule' && !(r.kind==='meta' && r.id==='autoReview') && !seen.has(JSON.stringify([r.kind,r.id]))) fail('Settings restore cannot remove local permission records.');
      if (p.mode==='import' || p.mode==='restore') for (const kind of Object.keys(tables)) c.prepare(`DELETE FROM ${table(kind)}`).run();
      for (const r of p.changes as PermissionChange[]) {
        if (r.remove) c.prepare(`DELETE FROM ${table(r.kind)} WHERE id=?`).run(r.id); else put(c,r);
      }
      // Bound the persisted projection before parsing it; the 4MB domain does not need a large-intent framework.
      let bytes=0; for (const kind of Object.keys(tables)) bytes += (c.prepare(`SELECT coalesce(sum(length(CAST(json AS BLOB))),0) AS bytes FROM ${table(kind)}`).get() as { bytes:number }).bytes;
      if (bytes>PERMISSION_BYTES) fail('Permission rows exceed domain allowance.');
      checkPermissionBounds(rows(c));
      if (p.mode==='import') c.authority.markImported({ manifestSha256:p.manifestSha256 as string });
      const revision=(h.revision ?? 0)+1;
      c.prepare('INSERT INTO permission_state(singleton,revision) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision').run(revision);
      return { revision,generation:c.authority.current()!.generation,payloadSha256:permissionHash(JSON.stringify(value)) };
    } },
  } });
}
export const permissionsDomain=permissionsDomainFor(permissionsSchema);
