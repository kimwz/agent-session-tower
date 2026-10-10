import type { StorageClient } from '../storage/client.js';
import { ExternalRowRepository } from '../remote/storage-row-repository.js';
import { canonical, type ExternalRow } from '../remote/storage-rows.js';
import { autoPromptCodec, type Entry } from './storage-codec.js';
export class AutoPromptRepository extends ExternalRowRepository {
 constructor(storage:StorageClient) {super(storage,autoPromptCodec,[{channel:'',kind:'job'}]);}
 async load():Promise<{entry:Entry;ordinal:number}[]> {return (await this.loadRows()).map(row=>({entry:JSON.parse(row.json),ordinal:row.ordinal}));}
 row(entry:Entry,ordinal:number):ExternalRow {return {channel:'',kind:'job',id:entry.job.id,ordinal,json:canonical(entry)};}
}
