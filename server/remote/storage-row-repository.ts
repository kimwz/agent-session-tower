import { randomUUID } from 'node:crypto';
import type { StorageClient } from '../storage/client.js';
import { StorageCommandError } from '../storage/contract.js';
import type { ExternalHead } from './storage-row-commands.js';
import { canonical, hash, EXTERNAL_INTENT_BYTES, EXTERNAL_CHUNK_BYTES, type ExternalCodec, type ExternalRow, type ExternalChange } from './storage-rows.js';
export interface ExternalPending { commandId: string; command: string; payloadSha256: string; intent: string; intentSha256: string; requestSha256: string; finalSent: boolean; error: unknown }
/** One domain owner; uncertain writes fence later mutations, including after SDK reopen. */
export class ExternalRowRepository {
  private uncertain?: ExternalPending;
  private failure?: unknown;
  private operations: Promise<void> = Promise.resolve();
  constructor(readonly storage: StorageClient, readonly codec: ExternalCodec, readonly collections: readonly { channel: string; kind: string }[]) {}
  pending(): Readonly<ExternalPending> | undefined { return this.uncertain; }
  async gate(): Promise<void> {
    if(this.uncertain) throw this.uncertain.error;if(this.failure) throw this.failure;
    for(const scope of ['core',this.codec.scope]) { const gate=await this.storage.gate(scope);if(!gate.open) throw new StorageCommandError({phase:'command',code:'not-ready',message:`${scope} storage held: ${gate.reasons.join('; ')}`,disposition:'not-committed',retryable:false}); }
  }
  async head(): Promise<ExternalHead> { await this.gate();const h=await this.storage.read<ExternalHead>(this.codec.scope,'head',{});
    if(h.authority&&h.authority.authority!=='database') throw new Error('Legacy-exported authority requires explicit owner recovery.');return h; }
  async loadRows(): Promise<ExternalRow[]> {
    const h=await this.head();if(!h.authority||h.revision===null) throw new Error(`${this.codec.scope} has no imported SQL authority.`);
    const fence={revision:h.revision,generation:h.authority.generation},rows:ExternalRow[]=[];let total=0;
    for(const collection of this.collections) {
      let after=0;
      for(;;) {
        const page=await this.storage.read<{ordinal:number;idBytes:number;bytes:number}[]>(this.codec.scope,'keys',{...fence,...collection,after});if(!page.length) break;
        for(const key of page) {
          const read=async (field:'id'|'json',size:number) => {
            total+=size;if(!Number.isSafeInteger(size)||size<0||total>EXTERNAL_INTENT_BYTES) throw new Error('External export exceeds bounded allowance.');
            const parts:Buffer[]=[];for(let offset=0;offset<size;offset+=EXTERNAL_CHUNK_BYTES) parts.push(Buffer.from(await this.storage.read<string>(this.codec.scope,'chunk',{...fence,...collection,ordinal:key.ordinal,field,offset}),'base64'));
            const data=Buffer.concat(parts);if(data.length!==size||!Buffer.from(data.toString('utf8')).equals(data)) throw new Error('Incomplete external row export.');return data.toString('utf8');
          };
          const row={...collection,ordinal:key.ordinal,id:await read('id',key.idBytes),json:await read('json',key.bytes)};this.codec.validate(row);rows.push(row);
        }
        after=page[page.length-1].ordinal+1;
      }
    }
    const last=await this.head();if(last.revision!==h.revision||last.authority?.generation!==h.authority.generation) throw new Error('External rows changed during export.');
    this.codec.validateCollection(rows);return rows;
  }
  update(changes: readonly ExternalChange[], id=`external-${randomUUID()}`): Promise<void> {
    const copied = changes.map(row => ({ ...row }));
    const work = this.operations.then(async () => {
      if (!copied.length) { await this.gate(); return; }
      const h = await this.head(); if (!h.authority) throw new Error('External write requires SQL authority.');
      await this.write(copied, { mode: 'update', revision: h.revision, generation: h.authority.generation }, id);
    });
    // best-effort: only the queue tail is normalized; the returned work still rejects to its caller.
    this.operations = work.catch(() => {}); return work;
  }
  async importPrepared(rows:readonly ExternalRow[],manifestSha256:string,id:string,beforeCommit:()=>Promise<void>): Promise<void> {
    await this.gate();const h=await this.head();if(h.authority) throw new Error('External authority exists; JSON reimport forbidden.');
    if(!this.storage.context?.manifest.domains.find(d=>d.scope===this.codec.scope)?.cutover) throw new Error('External preparation has no cutover contract.');
    this.codec.validateCollection(rows);
    await this.write(rows.map(row=>({...row,previous:null})),{mode:'import',revision:null,generation:null,manifestSha256},id,beforeCommit);
  }
  private async write(changes:readonly ExternalChange[],header:Record<string,unknown>,intent:string,beforeCommit?:()=>Promise<void>) {
    await this.gate();for(const row of changes) this.codec.validate(row);
    const transfer=changes.map(({previous,...row})=>({...row,previous:previous===null?null:hash(previous)}));const requestSha256=hash(canonical(transfer));
    const directPayload={header:{...header,requestSha256},changes:transfer};
    const direct=header.mode==='update' && !changes.some(row=>!row.remove && this.codec.needsIntent?.(row,row.previous)) && Buffer.byteLength(canonical(directPayload))<=EXTERNAL_CHUNK_BYTES;
    const finalCommand=direct?'mutate':'commit', finalId=`${intent}-commit`;
    const receipt=await this.storage.receipt(finalId);
    if(receipt.found) {const r=receipt.receipt,v=r.result.state==='included'?r.result.value as {requestSha256?:string;generation?:number}:undefined;
      if(r.scope!==this.codec.scope||r.command!==finalCommand||v?.requestSha256!==requestSha256 || header.mode !== 'import' && v?.generation !== header.generation) throw new Error('External command ID conflicts with canonical payload.');return; }
    const bytes=Buffer.from(canonical({...header,requestSha256})+'\n'+transfer.map(c=>canonical(c)+'\n').join(''));
    if(bytes.length>EXTERNAL_INTENT_BYTES) throw new Error('External intent exceeds bounded allowance.');
    const intentSha256=hash(bytes);let attempted={command:'begin',payload:{intent,bytes:bytes.length,sha256:intentSha256,chunks:Math.ceil(bytes.length/EXTERNAL_CHUNK_BYTES)} as unknown,commandId:`${intent}-begin`};let finalSent=false;
    const send=async (command:string,payload:unknown,commandId:string) => {await this.gate();attempted={command,payload,commandId};return this.storage.write(this.codec.scope,command,payload,commandId);};
    try {
      if (direct) { finalSent=true; await send('mutate',directPayload,finalId); return; }
      await send(attempted.command,attempted.payload,attempted.commandId);
      for(let offset=0,part=0;offset<bytes.length;offset+=EXTERNAL_CHUNK_BYTES,part++) await send('stage',{intent,part,data:bytes.subarray(offset,offset+EXTERNAL_CHUNK_BYTES).toString('base64')},`${intent}-part-${part}`);
      await beforeCommit?.();finalSent=true;await send('commit',{intent},`${intent}-commit`);
    } catch(error) {
      if((error as {disposition?:string})?.disposition!=='not-committed') {
        const uncertain=Object.assign(new Error('저장 결과가 불확실합니다. 새 요청이나 자동 재시도 없이 소유자 복구가 필요합니다.',{cause:error}),{disposition:'uncertain'});
        this.uncertain={commandId:attempted.commandId,command:attempted.command,payloadSha256:hash(JSON.stringify(attempted.payload)),intent,intentSha256: direct ? hash(canonical(transfer)) : intentSha256,requestSha256,finalSent,error:uncertain};throw uncertain;
      }
      // A partially staged definite refusal also holds: never silently allocate another intent.
      if (!direct) this.failure=error; throw error;
    }
  }
  async unfinished(channel:string):Promise<boolean> {const h=await this.head();if(!h.authority) throw new Error('No SQL authority for unfinished view.');return this.storage.read<boolean>(this.codec.scope,'unfinished',{channel,revision:h.revision,generation:h.authority.generation});}
  /** Read-only resolution; neither stages nor external effects are replayed. */
  async resolveUnknown():Promise<'committed'|'not-committed'|'unknown'> {
    const p=this.uncertain;if(!p) return 'not-committed';
    const r=await this.storage.receipt(p.commandId);
    if(!r.found) return p.finalSent?'not-committed':'unknown';
    const receipt=r.receipt;if(receipt.scope!==this.codec.scope||receipt.payloadSha256!==p.payloadSha256||receipt.command!==p.command) throw new Error('External unknown receipt mismatch.');
    if(!p.finalSent||receipt.result.state!=='included') return 'unknown';
    const value=receipt.result.value as {intentSha256?:string;requestSha256?:string;generation?:number;revision?:number};if(value.intentSha256!==p.intentSha256||value.requestSha256!==p.requestSha256) throw new Error('External final receipt mismatch.');
    const h=await this.storage.read<ExternalHead>(this.codec.scope,'head',{});if(h.authority?.authority!=='database' || h.authority.generation !== value.generation || h.revision === null || typeof value.revision !== 'number' || h.revision < value.revision) throw new Error('External receipt lacks current SQL authority/generation.');
    this.uncertain=undefined;return 'committed';
  }
}
