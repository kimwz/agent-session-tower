import { canonical, object, type ExternalRow, type ExternalCodec } from './storage-rows.js';
export interface RemoteEntry { key: string; fingerprint: string; at: number; issued: number; result?: import('./request-ledger.js').RemoteResult }
const UUID_V7=/^[a-f\d]{8}-[a-f\d]{4}-7[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
export const remoteCodec: ExternalCodec = {
 scope:'remote',table:'remote',maxBytes:120_000_000,
 needsIntent(_row,previous) { return previous === null; },
 validate(row) {
  if(row.channel!==''||row.kind!=='request'||!Number.isSafeInteger(row.ordinal)||row.ordinal<0||Buffer.byteLength(row.json)>6_000_000) throw new Error('Invalid remote row.');
  const v=object(JSON.parse(row.json)),parts=String(v.key).split('\n');
  if(row.id!==v.key||parts.length!==3||!parts[0]||!parts[1]||!UUID_V7.test(parts[2])||typeof v.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(v.fingerprint)||!Number.isFinite(v.at)||!Number.isFinite(v.issued)) throw new Error('Invalid remote request source.');
  if(v.result!==undefined) {const r=object(v.result);if(!['session','run','autoPrompt','compaction'].includes(String(r.kind))||r.kind==='run'&&typeof r.runId!=='string'||r.kind==='session'&&(typeof r.sessionId!=='string'||typeof r.runId!=='string')||r.kind==='autoPrompt'&&typeof r.jobId!=='string'||r.kind==='compaction'&&(typeof r.sessionId!=='string'||typeof r.jobId!=='string')) throw new Error('Invalid remote result.');}
  const r=v.result as Record<string,string>|undefined;
  return {controller:parts[0],operation:parts[1],request:parts[2],fingerprint:v.fingerprint,status:r?'completed':'uncertain',issued:Number(v.issued),received:Number(v.at),links:r?Object.entries(r).filter(([k])=>k.endsWith('Id')).map(([kind,id])=>({kind,id})):[]};
 },
 validateCollection(rows) {if(rows.length>20_000) throw new Error('Remote ledger capacity exceeded.');for(const row of rows) this.validate(row);},
};
export function remoteRows(source:unknown):ExternalRow[] {
 if(!Array.isArray(source)) throw new Error('Saved remote request records are invalid.');
 const rows=source.map((value,ordinal)=>{const v=object(value),key=String(v.key),id=key.split('\n').at(-1)??'';
   const issued=Number.isFinite(v.issued)?Number(v.issued):UUID_V7.test(id)?parseInt(id.replace(/-/g,'').slice(0,12),16):Number(v.at);
   return {channel:'',kind:'request',id:key,ordinal,json:canonical({...v,issued})};});
 remoteCodec.validateCollection(rows);if(new Set(rows.map(r=>r.id)).size!==rows.length) throw new Error('Duplicate remote request source.');return rows;
}
