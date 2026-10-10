import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { permissionsDomain } from '../../../server/permissions/storage-commands.js';
import { permissionHash } from '../../../server/permissions/storage-codec.js';
import { PermissionsRepository } from '../../../server/permissions/storage-repository.js';
import type { DomainWriteContext } from '../../../server/storage/domain.js';
import { StorageCommandError, type DomainAuthority, type ReceiptRecord } from '../../../server/storage/contract.js';
import type { StorageClient } from '../../../server/storage/client.js';

/** Explicit noStorage fixture: isolated in-memory SQL only, no production state, native sessions, or runtime worker. */
export class PermissionSQLFixture {
  readonly db=new DatabaseSync(':memory:');
  readonly receipts=new Map<string,ReceiptRecord>();
  readonly sourceSha=permissionHash('fixture');
  held=false;
  lostAnswer=false;
  writes=0;
  onWrite?: (payload:unknown)=>void;
  readonly client:StorageClient;
  constructor() {
    this.db.exec('CREATE TABLE domain_imports(domain TEXT PRIMARY KEY,authority TEXT,generation INTEGER,manifest_sha256 TEXT,reader_contract INTEGER,writer_contract INTEGER,committed_at TEXT,app_version TEXT,source_hash TEXT,owner_epoch INTEGER) STRICT;');
    for (const migration of permissionsDomain.schema.migrations) this.db.exec(migration.sql);
    const c=this.context('fixture-import');
    this.command('commit', { mode:'import',revision:null,generation:null,manifestSha256:this.sourceSha,changes:[] },c);
    this.client={
      context:{ manifest:{ domains:[{ scope:'permissions',cutover:{ artifactVersion:'1.125.0',importContract:1 } }] } },
      status:()=>({ state:'ready',ownerEpoch:1,pending:0,recovery:this.held ? { state:'held',reconciled:[],unreconciled:['permissions'],reason:'fixture historical barrier' } : { state:'clear' } }),
      gate:async()=>({ open:!this.held,reasons:this.held ? ['fixture historical barrier'] : [] }),
      read:async(_scope:string,name:string,payload:unknown)=>permissionsDomain.commands[name].run(this.context('read'),payload),
      receipt:async(id:string)=>this.receipts.has(id) ? { found:true,receipt:this.receipts.get(id)! } : { found:false },
      write:async(_scope:string,name:string,payload:unknown,id:string)=>{
        this.writes++; this.onWrite?.(payload);
        const hash=permissionHash(JSON.stringify(payload)), prior=this.receipts.get(id);
        if (prior) { if (prior.payloadSha256!==hash) throw new Error('fixture command identity conflict'); return { disposition:'committed',result:prior.result.state==='included' ? prior.result.value : undefined,replayed:true,commandId:id }; }
        if (this.held) throw new Error('fixture held');
        const result=this.command(name,payload,this.context(id));
        this.receipts.set(id,{ commandId:id,scope:'permissions',command:name,payloadSha256:hash,ownerEpoch:1,committedAt:'2026-10-10T00:00:00.000Z',result:{ state:'included',value:result } });
        if (this.lostAnswer) { this.lostAnswer=false; throw new StorageCommandError({ phase:'deadline',code:'deadline-exceeded',message:'fixture commit acknowledgement lost',retryable:false,disposition:'unknown',commandId:id }); }
        return { disposition:'committed',result,replayed:false,commandId:id };
      },
    } as unknown as StorageClient;
  }
  context(commandId:string):DomainWriteContext {
    const current=():DomainAuthority | undefined => {
      const r=this.db.prepare('SELECT * FROM domain_imports').get() as Record<string,unknown> | undefined;
      return r ? { domain:'permissions',authority:'database',generation:r.generation as number,manifestSha256:r.manifest_sha256 as string,readerContract:1,writerContract:1,committedAt:'2026-10-10T00:00:00.000Z',appVersion:'1.125.0',sourceHash:this.sourceSha,ownerEpoch:1 } : undefined;
    };
    return { domain:'permissions',commandId,ownerEpoch:1,now:'2026-10-10T00:00:00.000Z',prepare:sql=>this.db.prepare(sql),authority:{ current,markImported:input=>{
      this.db.prepare('INSERT INTO domain_imports VALUES(?,?,?,?,?,?,?,?,?,?)').run('permissions','database',1,input.manifestSha256,1,1,'2026-10-10T00:00:00.000Z','1.125.0',this.sourceSha,1); return current()!;
    },markLegacyExported:()=>{ throw new Error('fixture unused'); } } };
  }
  command(name:string,payload:unknown,c=this.context(`fixture-${randomUUID()}`)):unknown {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result=permissionsDomain.commands[name].run(c,payload); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  repository():PermissionsRepository { return new PermissionsRepository(this.client); }
  close():void { this.db.close(); }
}
const fixtures=new Map<string,PermissionSQLFixture>();
export function noStorageFixture(stateDir:string):PermissionsRepository {
  const f=fixtures.get(stateDir) ?? new PermissionSQLFixture(); fixtures.set(stateDir,f); return f.repository();
}
export function permissionFixture(stateDir:string):PermissionSQLFixture { return fixtures.get(stateDir)!; }
export function closePermissionFixture(stateDir:string):void { fixtures.get(stateDir)?.close(); fixtures.delete(stateDir); }
