import { defineStorageDomain, type DomainReadContext, type DomainWriteContext } from '../storage/domain.js';
import type { DomainAuthority, StorageDomainSchema } from '../storage/contract.js';
import { canonical, object, hash, EXTERNAL_INTENT_BYTES, EXTERNAL_CHUNK_BYTES, type ExternalCodec, type ExternalRow } from './storage-rows.js';
export interface ExternalHead { storageId: string; authority: DomainAuthority | null; revision: number | null }
const fail = (message: string): never => { throw Object.assign(new Error(message),{ storageCode: 'domain-failed' }); };
const integer = (v: unknown, max = Number.MAX_SAFE_INTEGER): number => { if (!Number.isSafeInteger(v) || Number(v)<0 || Number(v)>max) fail('Invalid external storage bound.'); return Number(v); };
/** Fixed code/SQL in the one DB thread; codecs are imported by owners, never accepted from RPC payloads. */
export function externalDomain(schema: StorageDomainSchema, codec: ExternalCodec) {
  const t = codec.table;
  function head(c: DomainReadContext): ExternalHead {
    const marker = c.prepare('SELECT * FROM domain_imports WHERE domain=?').get(codec.scope) as Record<string,unknown> | undefined;
    const state = c.prepare(`SELECT revision FROM ${t}_state WHERE singleton=1`).get() as { revision: number } | undefined;
    let authority: DomainAuthority | null = null;
    if (marker) {
      if (!['database','legacy-exported'].includes(String(marker.authority)) || marker.reader_contract!==1 || marker.writer_contract!==1 || !Number.isSafeInteger(marker.generation) || Number(marker.generation)<1 || !state || state.revision<1) fail('Malformed external authority.');
      authority = { domain: codec.scope,authority: marker.authority as DomainAuthority['authority'],generation: Number(marker.generation),manifestSha256: String(marker.manifest_sha256),readerContract: 1,writerContract: 1,committedAt: String(marker.committed_at),appVersion: String(marker.app_version),sourceHash: String(marker.source_hash),ownerEpoch: Number(marker.owner_epoch) };
    } else if (state || c.prepare(`SELECT 1 FROM ${t}_rows LIMIT 1`).get()) fail('External rows exist without authority.');
    const storage = c.prepare("SELECT value FROM storage_meta WHERE key='storage_id'").get() as { value: string } | undefined;
    if (!storage) fail('Missing external storage identity.');
    return { storageId: storage.value,authority,revision: state?.revision ?? null };
  }
  function current(c: DomainReadContext, p: Record<string,unknown>) {
    const h = head(c);
    if (h.authority?.authority!=='database' || h.revision!==p.revision || h.authority.generation!==p.generation) fail('External authority/revision/generation changed.');
    return h;
  }
  function put(c: DomainWriteContext, row: ExternalRow) {
    const p = codec.validate(row);
    c.prepare(`INSERT INTO ${t}_rows(channel,kind,id,ordinal,json,bytes,status,created,scheduled,controller,operation,request,fingerprint,issued,received,account) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(channel,kind,id) DO UPDATE SET ordinal=excluded.ordinal,json=excluded.json,bytes=excluded.bytes,status=excluded.status,created=excluded.created,scheduled=excluded.scheduled,controller=excluded.controller,operation=excluded.operation,request=excluded.request,fingerprint=excluded.fingerprint,issued=excluded.issued,received=excluded.received,account=excluded.account`)
      .run(row.channel,row.kind,row.id,row.ordinal,row.json,Buffer.byteLength(row.json),p.status??null,p.created??null,p.scheduled??null,p.controller??null,p.operation??null,p.request??null,p.fingerprint??null,p.issued??null,p.received??null,p.account??null);
    c.prepare(`DELETE FROM ${t}_links WHERE channel=? AND kind=? AND id=?`).run(row.channel,row.kind,row.id);
    for (const link of p.links??[]) c.prepare(`INSERT OR REPLACE INTO ${t}_links(channel,kind,id,relation,target,status) VALUES (?,?,?,?,?,?)`).run(row.channel,row.kind,row.id,link.kind,link.id,link.status??null);
  }
  function channelBytes(c: DomainReadContext, channel: string): number {
    const groups = c.prepare(`SELECT kind,count(*) AS n,coalesce(sum(bytes),0) AS bytes FROM ${t}_rows WHERE channel=? GROUP BY kind`).all(channel) as { kind: string; n: number; bytes: number }[];
    const wrapper = groups.find(g=>g.kind==='settings')?.bytes ?? 2;
    return groups.reduce((sum,g)=>sum+g.bytes+(g.kind==='settings'?0:Math.max(0,g.n-1)),0)-2+Buffer.byteLength('{"rules":[],"workflows":[]}')+(wrapper>2?1:0);
  }
  function apply(c: DomainWriteContext, header: Record<string,unknown>, changes: Record<string,unknown>[], intentSha256: string) {
    const h = head(c);
    const oldChannelBytes = codec.scope === 'automation-workflows' ? new Map(['slack','github'].map(channel=>[channel,channelBytes(c,channel)])) : new Map<string,number>();
    if (header.mode === 'import') { if (h.authority || header.revision !== null || header.generation !== null) fail('Authority exists; reimport forbidden.'); }
    else current(c,header);
    if (!['import','update'].includes(String(header.mode))) fail('Unknown external mode.');
      const seen=new Map<string, boolean>();
      if(hash(canonical(changes))!==header.requestSha256) fail('External request hash mismatch.');
      for(const change of changes) {
        const row=change as unknown as ExternalRow;codec.validate(row);const key=canonical([row.channel,row.kind,row.id]);if(seen.has(key) && !(seen.get(key) === true && change.remove !== true && row.kind === 'rule')) fail('Duplicate external row.');seen.set(key,change.remove === true);
        const previous=c.prepare(`SELECT json FROM ${t}_rows WHERE channel=? AND kind=? AND id=?`).get(row.channel,row.kind,row.id) as {json:string}|undefined;
        if(change.previous===null ? !!previous : !previous||hash(previous.json)!==change.previous) fail('External row changed before guarded write.');
        if(change.remove===true) { if(header.mode==='import'||!previous) fail('Invalid external deletion.');c.prepare(`DELETE FROM ${t}_rows WHERE channel=? AND kind=? AND id=?`).run(row.channel,row.kind,row.id); }
        else put(c,row);
      }
      if(header.mode==='import') {
        const rows=c.prepare(`SELECT channel,kind,id,ordinal,json FROM ${t}_rows ORDER BY channel,kind,ordinal`).all() as unknown as ExternalRow[];codec.validateCollection(rows);
        if (codec.scope === 'automation-workflows' && !['slack','github'].every(channel=>rows.some(row=>row.channel===channel&&row.kind==='settings'))) fail('Missing workflow channel wrapper.');
        c.authority.markImported({manifestSha256:String(header.manifestSha256)});
      }
      const groups = c.prepare(`SELECT channel,kind,count(*) AS n,count(DISTINCT ordinal) AS ordinals FROM ${t}_rows GROUP BY channel,kind`).all() as {channel:string;kind:string;n:number;ordinals:number}[];
      if(groups.some(g=>g.n!==g.ordinals || g.n>(g.kind==='request'?20_000:g.kind==='job'?100:g.kind==='workflow'?10_000:g.kind==='rule'?100:1))) fail('External row capacity/order exceeded.');
      if (header.mode !== 'import') for (const [channel,oldBytes] of oldChannelBytes) {const bytes=channelBytes(c,channel);if(bytes>10_000_000&&bytes>oldBytes) fail('Slack 저장 용량이 가득 찼습니다.');}
      const size=(c.prepare(`SELECT coalesce(sum(bytes),0) AS n FROM ${t}_rows`).get() as {n:number}).n;
      const old=(c.prepare(`SELECT bytes FROM ${t}_state WHERE singleton=1`).get() as {bytes:number}|undefined)?.bytes??0;
      if(size>codec.maxBytes&&size>old&&header.mode!=='import') fail('External domain capacity exceeded.');
      const revision=(h.revision??0)+1;c.prepare(`INSERT INTO ${t}_state VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,bytes=excluded.bytes`).run(revision,size);
    return {revision,generation:c.authority.current()!.generation,requestSha256:header.requestSha256,intentSha256};
  }
  return defineStorageDomain({ schema,commands: {
    head: { kind:'read',run: c=>head(c) },
    bootstrapHistory: { kind:'read',run: c=>({ stages: (c.prepare(`SELECT count(*) AS n FROM ${t}_stages`).get() as { n: number }).n }) },
    keys: { kind:'read',run(c,payload) { const p=object(payload);current(c,p);
      return c.prepare(`SELECT ordinal,length(CAST(id AS BLOB)) AS idBytes,length(CAST(json AS BLOB)) AS bytes FROM ${t}_rows WHERE channel=? AND kind=? AND ordinal>=? ORDER BY ordinal LIMIT 32`).all(String(p.channel),String(p.kind),integer(p.after)); } },
    chunk: { kind:'read',run(c,payload) { const p=object(payload);current(c,p);if (p.field!=='id'&&p.field!=='json') fail('Invalid external chunk field.');
      const r=c.prepare(`SELECT substr(CAST(${p.field} AS BLOB),?,?) AS data FROM ${t}_rows WHERE channel=? AND kind=? AND ordinal=?`).get(integer(p.offset,EXTERNAL_INTENT_BYTES)+1,EXTERNAL_CHUNK_BYTES,String(p.channel),String(p.kind),integer(p.ordinal)) as { data: Uint8Array } | undefined;
      if(!r) fail('Missing external row.');return Buffer.from(r.data).toString('base64'); } },
    capacity: { kind:'read',run(c,payload) { const p=object(payload);current(c,p);return {bytes:channelBytes(c,String(p.channel))}; } },
    unfinished: { kind:'read',run(c,payload) { const p=object(payload);current(c,p);
      return !!c.prepare(`SELECT 1 FROM ${t}_rows WHERE channel=? AND (status IN ('received','matching','dispatching','running','composing','sending','reply-uncertain','admission-uncertain') OR EXISTS (SELECT 1 FROM ${t}_links l WHERE l.channel=${t}_rows.channel AND l.kind=${t}_rows.kind AND l.id=${t}_rows.id AND l.status IN ('sending','uncertain','pending','delivering'))) LIMIT 1`).get(String(p.channel)); } },
    foreignUnfinished: { kind:'read',run(c,payload) {const p=object(payload); current(c,p);
      return !!c.prepare(`SELECT 1 FROM ${t}_rows WHERE channel=? AND kind='workflow' AND account<>? AND (status IN ('received','matching','dispatching','running','composing','sending','reply-uncertain','admission-uncertain') OR EXISTS (SELECT 1 FROM ${t}_links l WHERE l.channel=${t}_rows.channel AND l.kind=${t}_rows.kind AND l.id=${t}_rows.id AND l.status IN ('sending','uncertain','pending','delivering'))) LIMIT 1`).get(String(p.channel),String(p.account)); } },
    mutate: { kind:'write',run(c,payload) {
      const p=object(payload);if(Buffer.byteLength(canonical(p))>EXTERNAL_CHUNK_BYTES||!Array.isArray(p.changes)) fail('External mutation requires bounded row transfer.');
      const header=object(p.header);if(header.mode!=='update') fail('Direct mutation cannot import authority.');
      const changes=p.changes.map(object);return apply(c,header,changes,hash(canonical(changes)));
    } },
    begin: { kind:'write',run(c,payload) { const p=object(payload),intent=String(p.intent),bytes=integer(p.bytes,EXTERNAL_INTENT_BYTES),chunks=integer(p.chunks,Math.ceil(EXTERNAL_INTENT_BYTES/EXTERNAL_CHUNK_BYTES));
      if(!/^[a-zA-Z0-9_-]{1,100}$/.test(intent)||!/^[a-f0-9]{64}$/.test(String(p.sha256))||!bytes||chunks!==Math.ceil(bytes/EXTERNAL_CHUNK_BYTES)) fail('Invalid external intent.');
      c.prepare(`INSERT INTO ${t}_stages VALUES (?,?,?,?,?)`).run(intent,c.ownerEpoch,bytes,String(p.sha256),chunks);return { intent }; } },
    stage: { kind:'write',run(c,payload) { const p=object(payload),s=c.prepare(`SELECT * FROM ${t}_stages WHERE intent=?`).get(String(p.intent)) as { owner_epoch:number;bytes:number;chunks:number } | undefined;
      if(!s||s.owner_epoch!==c.ownerEpoch) fail('Unknown external stage owner.'); const part=integer(p.part,s.chunks-1),bytes=Buffer.from(String(p.data),'base64');
      if(bytes.toString('base64')!==p.data||bytes.length!==Math.min(EXTERNAL_CHUNK_BYTES,s.bytes-part*EXTERNAL_CHUNK_BYTES)) fail('Invalid external stage chunk.');
      c.prepare(`INSERT INTO ${t}_stage_chunks VALUES (?,?,?)`).run(String(p.intent),part,String(p.data));return { intent:p.intent,part }; } },
    commit: { kind:'write',run(c,payload) { const intent=String(object(payload).intent),s=c.prepare(`SELECT * FROM ${t}_stages WHERE intent=?`).get(intent) as { owner_epoch:number;bytes:number;chunks:number;sha256:string } | undefined;
      if(!s||s.owner_epoch!==c.ownerEpoch) fail('Unknown external stage owner.');
      const parts=c.prepare(`SELECT part,data FROM ${t}_stage_chunks WHERE intent=? ORDER BY part`).all(intent) as {part:number;data:string}[];
      if(parts.length!==s.chunks||parts.some((p,i)=>p.part!==i)) fail('Incomplete external intent.');
      const bytes=Buffer.concat(parts.map(p=>Buffer.from(p.data,'base64')));if(bytes.length!==s.bytes||hash(bytes)!==s.sha256||!Buffer.from(bytes.toString('utf8')).equals(bytes)) fail('External intent hash/UTF-8 mismatch.');
      const lines=bytes.toString('utf8').split('\n');if(lines.pop()!=='') fail('Incomplete external intent row.');const header=object(JSON.parse(lines.shift()!)),h=head(c);
      if(header.mode==='import') { if(h.authority||header.revision!==null||header.generation!==null) fail('Authority exists; reimport forbidden.'); }
      else current(c,header);
      if(!['import','update'].includes(String(header.mode))) fail('Unknown external mode.');
      const changes=lines.map(line=>object(JSON.parse(line)));
      const result = apply(c,header,changes,s.sha256);
      c.prepare(`DELETE FROM ${t}_stages WHERE intent=?`).run(intent);
      return result; } },
  } });
}
