import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ExternalRowRepository } from './storage-row-repository.js';
import { remoteRows } from './storage-codec.js';
import { canonical, hash, EXTERNAL_INTENT_BYTES, type ExternalRow } from './storage-rows.js';
export interface ExternalSource { name:string; maxBytes:number; missing:unknown; rows(value:unknown):ExternalRow[] }
/** I supplies its captured normal/offline activation checker. This is an SDK/storage gate, not the effect gate. */
export interface ExternalImportInput {
 repository:ExternalRowRepository; stateDir:string; evidenceParent:string; commandId:string;
 checkActivation():Promise<void>; sources:readonly ExternalSource[];
}
async function privateFolder(path:string):Promise<void> {
 let current='/';for(const part of resolve(path).split('/').filter(Boolean)) {current=join(current,part);const info=await lstat(current);if(!info.isDirectory()||info.isSymbolicLink()) throw new Error('Unsafe external evidence parent.');}
 const info=await lstat(path);if(info.uid!==process.getuid?.()||info.mode&0o077) throw new Error('External evidence must be owner-only.');
}
async function raw(path:string):Promise<Buffer|null> {
 await privateFolder(dirname(path));let file;
 try {file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);} catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT') return null;throw error;}
 try {const info=await file.stat();if(!info.isFile()||info.nlink!==1||info.uid!==process.getuid?.()||info.mode&0o077||info.size>EXTERNAL_INTENT_BYTES) throw new Error('Unsafe external source.');
 const data=await file.readFile();if(data.length>EXTERNAL_INTENT_BYTES||!Buffer.from(data.toString('utf8')).equals(data)) throw new Error('Invalid external UTF-8 source.');return data;
 } finally {await file.close();}
}
export async function bootstrapExternal(repository:ExternalRowRepository,stateDir:string):Promise<void> {
 const h=await repository.head();
 if(h.authority?.authority==='database') {
  if((await repository.storage.read<{stages:number}>(repository.codec.scope,'bootstrapHistory',{})).stages) throw new Error('Unresolved external stages require owner recovery before runtime effects.');
  return;
 }
 const parent=join(stateDir,`${repository.codec.scope}-storage-migrations`);
 try {await lstat(parent);await privateFolder(parent);const dir=await opendir(parent);try {if(await dir.read()) throw new Error('External seal without authority requires owner recovery.');} finally {await dir.close();}}
 catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}
 if((await repository.storage.read<{stages:number}>(repository.codec.scope,'bootstrapHistory',{})).stages) throw new Error('External stages without authority require owner recovery.');
 throw new Error(`${repository.codec.scope} has no SQL authority; explicit verified offline import is required.`);
}
/** Raw capture -> sealed readback/fsync -> source compare -> one authority+receipt transaction. No effects. */
export async function importExternal(input:ExternalImportInput):Promise<{directory:string;manifestSha256:string}> {
 const {repository}=input,context=repository.storage.context;
 if(!context||!context.manifest.domains.find(d=>d.scope===repository.codec.scope)?.cutover) throw new Error('Missing captured external cutover contract.');
 if((await repository.head()).authority) throw new Error('External SQL authority exists; reimport forbidden.');
 await input.checkActivation();await repository.gate();
 if(!/^[a-zA-Z0-9_-]{1,100}$/.test(input.commandId)) throw new Error('Invalid external evidence ID.');
 // Any earlier raw seal or stage holds, including a crash before begin/commit.
 const existing=join(input.stateDir,`${repository.codec.scope}-storage-migrations`);
 if(resolve(existing)!==resolve(input.evidenceParent)) throw new Error('External evidence parent is not the captured domain path.');
 try {await bootstrapExternal(repository,input.stateDir);} catch(error) {if((error as Error).message!==`${repository.codec.scope} has no SQL authority; explicit verified offline import is required.`) throw error;}
 const captured: {source:ExternalSource;data:Buffer|null}[]=[];const rows:ExternalRow[]=[];
 for(const source of input.sources) {if(!/^[a-z][a-z0-9-]*\.json$/.test(source.name)) throw new Error('Invalid external source name.');const data=await raw(join(input.stateDir,source.name));if(data && data.length>source.maxBytes) throw new Error('External legacy source exceeds its original bound.');captured.push({source,data});rows.push(...source.rows(data===null?source.missing:JSON.parse(data.toString('utf8'))));}
 repository.codec.validateCollection(rows);
 await mkdir(input.evidenceParent,{mode:0o700,recursive:true});await privateFolder(input.evidenceParent);
 const directory=join(input.evidenceParent,input.commandId);await mkdir(directory,{mode:0o700});
 const save=async(name:string,data:Buffer)=> {const path=join(directory,name),file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try {await file.writeFile(data);await file.sync();} finally {await file.close();}if(!(await raw(path))?.equals(data)) throw new Error('External seal readback mismatch.');};
 const files:Record<string,unknown>={};
 for(const {source,data} of captured) {files[source.name]=data===null?{absent:true}:{bytes:data.length,sha256:hash(data)};if(data!==null) await save(source.name,data);}
 const manifest=Buffer.from(canonical({version:1,domain:repository.codec.scope,kind:'raw-import',storageId:(await repository.head()).storageId,build:context.identity,files,rowsSha256:hash(canonical(rows))}));await save('manifest.json',manifest);
 for(const path of [directory,input.evidenceParent,input.stateDir]) {const folder=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try {await folder.sync();} finally {await folder.close();}}
 const manifestSha256=hash(manifest);
 await repository.importPrepared(rows,manifestSha256,input.commandId,async()=> {
   await input.checkActivation();await repository.gate();
   for(const {source,data} of captured) {const current=await raw(join(input.stateDir,source.name));if(data===null?current!==null:current===null||!current.equals(data)) throw new Error('External source changed after sealing.');}
 });
 return {directory,manifestSha256};
}
export async function importRemote(input:Omit<ExternalImportInput,'sources'>) {
 return importExternal({...input,sources:[{name:'remote-requests.json',maxBytes:120_000_000,missing:[],rows:remoteRows}]});
}

/** Lossless owner export for offline backup/rollback; never changes SQL authority or reads stale source JSON. */
export async function exportExternal(repository:ExternalRowRepository,parent:string,id:string,sources:readonly {name:string;value(rows:readonly ExternalRow[]):unknown}[]):Promise<{directory:string;manifestSha256:string}> {
 const before=await repository.head(),rows=await repository.loadRows(),after=await repository.head();
 if(!before.authority||before.revision!==after.revision||before.authority.generation!==after.authority?.generation) throw new Error('External authority changed during export.');
 if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid external export identity.');
 await privateFolder(parent);const directory=join(parent,id);await mkdir(directory,{mode:0o700});
 const files:Record<string,unknown>={};
 const save=async(name:string,data:Buffer)=> {const path=join(directory,name),file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try {await file.writeFile(data);await file.sync();} finally {await file.close();}if(!(await raw(path))?.equals(data)) throw new Error('External export readback mismatch.');files[name]={bytes:data.length,sha256:hash(data)};};
 for(const source of sources) {if(!/^[a-z][a-z0-9-]*\.json$/.test(source.name)) throw new Error('Invalid external export name.');await save(source.name,Buffer.from(canonical(source.value(rows))));}
 await save('rows.ndjson',Buffer.from(rows.map(row=>canonical(row)+'\n').join('')));
 const manifest=Buffer.from(canonical({version:1,domain:repository.codec.scope,kind:'current-export',storageId:before.storageId,generation:before.authority.generation,authorityManifestSha256:before.authority.manifestSha256,revision:before.revision,build:repository.storage.context!.identity,files}));await save('manifest.json',manifest);
 for(const path of [directory,parent,dirname(parent)]) {const folder=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try {await folder.sync();} finally {await folder.close();}}
 return {directory,manifestSha256:hash(manifest)};
}
export function exportRemote(repository:ExternalRowRepository,parent:string,id:string) {
 return exportExternal(repository,parent,id,[{name:'remote-requests.json',value:rows=>rows.slice().sort((a,b)=>a.ordinal-b.ordinal).map(row=>JSON.parse(row.json))}]);
}
