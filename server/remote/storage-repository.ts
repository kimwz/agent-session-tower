import type { StorageClient } from '../storage/client.js';
import { ExternalRowRepository } from './storage-row-repository.js';
import { remoteCodec, type RemoteEntry } from './storage-codec.js';
import { canonical, type ExternalRow } from './storage-rows.js';
export class RemoteRepository extends ExternalRowRepository {
 constructor(storage:StorageClient) {super(storage,remoteCodec,[{channel:'',kind:'request'}]);}
 async load():Promise<{entry:RemoteEntry;ordinal:number}[]> {return (await this.loadRows()).map(row=>({entry:JSON.parse(row.json),ordinal:row.ordinal}));}
 row(entry:RemoteEntry,ordinal:number):ExternalRow {return {channel:'',kind:'request',id:entry.key,ordinal,json:canonical(entry)};}
 async put(entry:RemoteEntry,ordinal:number,previous:RemoteEntry|null):Promise<void> {await this.update([{...this.row(entry,ordinal),previous:previous===null?null:canonical(previous)}]);}
 async remove(entry:RemoteEntry,ordinal:number):Promise<void> {const row=this.row(entry,ordinal);await this.update([{...row,previous:row.json,remove:true}]);}
}
