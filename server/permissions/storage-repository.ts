import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { privateFile, storageFs, writePrivateDocument } from '../storage/paths.js';
import { randomUUID } from 'node:crypto';
import type { StorageClient } from '../storage/client.js';
import { StorageCommandError, type CommitDisposition } from '../storage/contract.js';
import { TowerError } from '../../shared/errors.js';
import type { PermissionState } from './service.js';
import type { PermissionsHead } from './storage-commands.js';
import { permissionRows, permissionState, permissionHash, PERMISSION_BYTES, PERMISSION_CHUNK_BYTES, type PermissionChange, type PermissionRow, type PermissionRowKind } from './storage-codec.js';

export interface PermissionPendingWrite { commandId:string; payloadSha256:string; error:unknown }
/** Worker-owned SQL authority. A lost answer holds all writes/effects until explicit receipt reconciliation. */
export class PermissionsRepository {
  private uncertain?: PermissionPendingWrite;
  private loaded?: PermissionsHead;
  private loadedEpoch?: number;
  private resolved?: CommitDisposition;
  private reconciliationRequired=false;
  private rows = new Map<string,PermissionRow>();
  private pendingLoaded = false;
  constructor(readonly storage: StorageClient, private readonly stateDir?: string, private readonly onHeld?: (error: unknown) => void) {}
  private pendingPath(): string { if (!this.stateDir) throw new Error('Durable permission owner directory missing.'); return join(this.stateDir,'storage-permissions-pending.json'); }
  private async loadPending(): Promise<void> {
    if (this.pendingLoaded || !this.stateDir) return;
    const path=this.pendingPath(), info=await privateFile(path);
    if (info) {
      if (info.size>4096) throw new TowerStoragePermissionHold('Durable pending record too large.');
      const file=await open(path,constants.O_RDONLY | constants.O_NOFOLLOW);
      let value:{ commandId?:unknown;payloadSha256?:unknown;phase?:unknown };
      try { value=JSON.parse(await file.readFile('utf8')); } finally { await file.close(); }
      if (typeof value.commandId!=='string' || typeof value.payloadSha256!=='string' || !/^[a-f0-9]{64}$/.test(value.payloadSha256) || !['pending','resolved'].includes(String(value.phase))) throw new TowerStoragePermissionHold('Invalid durable pending record.');
      this.reconciliationRequired=true;
      if (value.phase==='pending') this.uncertain={ commandId:value.commandId,payloadSha256:value.payloadSha256,error:new StorageCommandError({ phase:'command',code:'not-ready',message:'Durable permission receipt unresolved.',disposition:'unknown',retryable:false,commandId:value.commandId }) };
    }
    this.pendingLoaded=true;
  }
  private async durablePending(commandId:string,payloadSha256:string,phase:'pending'|'resolved'):Promise<void> {
    if (this.stateDir) await writePrivateDocument(this.pendingPath(),JSON.stringify({ commandId,payloadSha256,phase }));
  }
  private async clearPending():Promise<void> {
    if (!this.stateDir) return;
    // Prove the existing hold durable before removing its name. A crash may resurrect
    // this marker (requiring reconciliation), but no failing sync can erase the hold.
    await storageFs.syncDirectory(this.stateDir);
    await unlink(this.pendingPath()).catch((error:NodeJS.ErrnoException)=>{ if(error.code!=='ENOENT') throw error; });
  }
  pending(): Readonly<PermissionPendingWrite> | undefined { return this.uncertain; }
  effectsAvailable(): boolean {
    const s=this.storage.status(), recovery=s.recovery;
    return !this.uncertain && !this.reconciliationRequired && this.loaded?.authority?.authority==='database' && s.state==='ready' && s.ownerEpoch!==undefined && this.loadedEpoch===s.ownerEpoch
      && !!recovery && (recovery.state==='clear' || recovery.reconciled.includes('permissions') && recovery.reconciled.includes('core'));
  }
  private async storageGate(): Promise<void> {
    const core=await this.storage.gate('core'), domain=await this.storage.gate('permissions');
    if (!core.open || !domain.open) throw new TowerStoragePermissionHold([...core.reasons,...domain.reasons].join('; '));
  }
  private async readGate():Promise<void> { await this.loadPending(); if (this.uncertain) throw this.uncertain.error; await this.storageGate(); }
  async gate(): Promise<void> {
    await this.readGate();
    if (this.reconciliationRequired) throw new TowerStoragePermissionHold('Explicit permission effect reconciliation is required after an unknown write.');
  }
  async head(): Promise<PermissionsHead> {
    await this.readGate(); const h=await this.storage.read<PermissionsHead>('permissions','head',{});
    if (h.authority && h.authority.authority!=='database') throw new Error('Permission legacy authority requires explicit owner recovery; never reimport JSON.');
    return h;
  }
  async load(): Promise<PermissionState> {
    const head=await this.head(); if (!head.authority || head.revision===null) throw new Error('Permissions SQL authority is not imported.');
    const fence={ revision:head.revision,generation:head.authority.generation }, rows:PermissionRow[]=[];
    let total=0;
    for (const kind of ['rule','request','codex','meta'] as PermissionRowKind[]) {
      let after=0;
      while (true) {
        const page=await this.storage.read<{ id:string; ordinal:number; bytes:number }[]>('permissions','keys',{ ...fence,kind,after });
        if (!page.length) break;
        for (const row of page) {
          total+=row.bytes;
          if (!Number.isSafeInteger(row.bytes) || row.bytes<0 || total>PERMISSION_BYTES || rows.length>=PERMISSION_BYTES) throw new Error('Permission export exceeds domain bounds.');
          const chunks:Buffer[]=[];
          for (let offset=0; offset<row.bytes; offset+=PERMISSION_CHUNK_BYTES) chunks.push(Buffer.from(await this.storage.read<string>('permissions','chunk',{ ...fence,kind,id:row.id,offset }),'base64'));
          const bytes=Buffer.concat(chunks), json=bytes.toString('utf8');
          if (bytes.length!==row.bytes || !Buffer.from(json).equals(bytes)) throw new Error('Permission export is incomplete or malformed.');
          rows.push({ kind,id:row.id,ordinal:row.ordinal,json });
        }
        after+=page.length;
      }
    }
    const last=await this.head(); if (last.revision!==head.revision || last.authority?.generation!==head.authority.generation) throw new Error('Permissions changed during bounded export.');
    const state=permissionState(rows); this.rows=new Map(rows.map(r=>[JSON.stringify([r.kind,r.id]),r])); this.loaded=head; this.loadedEpoch=this.storage.status().ownerEpoch; return state;
  }
  /** Bounded owner export DTO; the common backup/export owner performs any file effects afterward. */
  async exportCurrent():Promise<{ state:PermissionState; head:PermissionsHead; sha256:string }> {
    const state=await this.load(),head=this.loaded!;
    return { state,head:structuredClone(head),sha256:permissionHash(JSON.stringify(state)) };
  }
  change(kind:PermissionRowKind,id:string,value:unknown | undefined, reserved:readonly PermissionChange[]): PermissionChange | undefined {
    const previous=this.rows.get(JSON.stringify([kind,id]));
    if (!previous && value===undefined) return undefined;
    const ordinal=previous?.ordinal ?? [...this.rows.values(),...reserved].reduce((max,r)=>r.kind===kind ? Math.max(max,r.ordinal) : max,-1)+1;
    const row={ kind,id,ordinal:kind==='meta' ? 0 : ordinal,json:value===undefined ? previous!.json : JSON.stringify(value) };
    return { ...row,previous:previous?.json ?? null,...(value===undefined ? { remove:true as const } : {}) };
  }
  async update(changes: PermissionChange[]): Promise<void> {
    await this.gate();
    if (!changes.length) { await this.gate(); return; }
    if (!this.loaded?.authority || this.loaded.revision===null) throw new Error('Load permission authority before updating rows.');
    await this.commit({ mode:'update',revision:this.loaded.revision,generation:this.loaded.authority.generation,changes });
    for (const r of changes) { const key=JSON.stringify([r.kind,r.id]); if (r.remove) this.rows.delete(key); else this.rows.set(key,{ kind:r.kind,id:r.id,ordinal:r.ordinal,json:r.json }); }
  }
  /** The parent supplies verified offline source evidence; no provider/native rule content is accepted here. */
  async importPrepared(state:unknown, manifestSha256:string, commandId:string, verifyBeforeCommit:()=>Promise<void>): Promise<void> {
    if (!this.storage.context?.manifest.domains.find(d=>d.scope==='permissions')?.cutover) throw new Error('Permission preparation has no cutover declaration.');
    const h=await this.head(); if (h.authority || h.revision!==null) throw new Error('Permission authority exists; JSON reimport forbidden.');
    const changes=permissionRows(state).map(r=>({ ...r,previous:null }));
    await verifyBeforeCommit(); await this.commit({ mode:'import',revision:null,generation:null,manifestSha256,changes },commandId);
  }
  /** Explicit settings restore: requests/notices/codex/lost are preserved by the service, never read from backup. */
  async restore(state:PermissionState, expectedGeneration:number, commandId:string): Promise<void> {
    const h=await this.head(); if (h.authority?.generation!==expectedGeneration || h.revision!==this.loaded?.revision) throw new Error('Permission restore is stale.');
    await this.commit({ mode:'restore',revision:h.revision,generation:expectedGeneration,changes:permissionRows(state).map(r=>({ ...r,previous:null })) },commandId);
  }
  async resolvePending(): Promise<CommitDisposition> {
    await this.loadPending();
    if (!this.uncertain) { if (this.resolved) return this.resolved; throw new Error('No uncertain permission write.'); }
    await this.storageGate(); const pending=this.uncertain, lookup=await this.storage.receipt(pending.commandId);
    if (lookup.found) {
      const r=lookup.receipt;
      if (r.scope!=='permissions' || r.command!=='commit' || r.payloadSha256!==pending.payloadSha256 || r.result.state!=='included' || (r.result.value as { payloadSha256?:string })?.payloadSha256!==pending.payloadSha256) throw new Error('Permission receipt identity mismatch.');
    }
    await this.durablePending(pending.commandId,pending.payloadSha256,'resolved');
    this.uncertain=undefined; this.loaded=undefined; this.loadedEpoch=undefined;
    this.resolved=lookup.found ? 'committed' : 'not-committed';
    // Caller must reload and reconcile effects explicitly. Resolving a receipt does not retry any effect.
    return this.resolved;
  }
  /** Explicit owner/domain reconciliation only; reopening, resolving a receipt, and loading never replay effects. */
  async releaseReconciledEffects():Promise<void> {
    await this.readGate();
    if (!this.loaded?.authority) throw new Error('Load resolved permission authority before releasing effects.');
    const head=await this.head();
    if (head.revision!==this.loaded.revision || head.authority?.generation!==this.loaded.authority.generation) throw new Error('Permission authority changed during effect reconciliation.');
    await this.clearPending();
    this.reconciliationRequired=false;
  }
  private async commit(payload:unknown, commandId?:string): Promise<void> {
    await this.gate(); commandId ??= `permissions-${randomUUID()}`; const payloadSha256=permissionHash(JSON.stringify(payload)); this.resolved=undefined;
    try { await this.durablePending(commandId,payloadSha256,'pending'); }
    catch(error) { this.uncertain={commandId,payloadSha256,error}; this.reconciliationRequired=true; this.onHeld?.(error); throw error; }
    try {
      const answer=await this.storage.write<{ revision:number; generation:number }>('permissions','commit',payload,commandId);
      await this.clearPending();
      if (this.loaded) this.loaded={ ...this.loaded,revision:answer.result.revision };
    } catch (error) {
      if (error instanceof StorageCommandError && (error.disposition==='unknown' || error.disposition==='committed')) { this.uncertain={ commandId,payloadSha256,error }; this.reconciliationRequired=true; }
      else if (error instanceof StorageCommandError && error.disposition==='not-committed') {
        try { await this.clearPending(); }
        catch (clearError) {
          this.uncertain={commandId,payloadSha256,error:clearError}; this.reconciliationRequired=true;
          this.onHeld?.(clearError); throw clearError;
        }
      }
      else { this.uncertain={commandId,payloadSha256,error}; this.reconciliationRequired=true; }
      if(this.uncertain) this.onHeld?.(error);
      throw error;
    }
  }
}
/** The parent effect gate translates this hold to its existing not-admitted protocol where necessary. */
export class TowerStoragePermissionHold extends TowerError {
  constructor(reason:string) { super('unavailable',`Permission storage held: ${reason}`,{ disposition:'not-admitted' }); }
}
