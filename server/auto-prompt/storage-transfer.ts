import { importExternal, type ExternalImportInput } from '../remote/storage-transfer.js';
import { autoPromptRows } from './storage-codec.js';
export function importAutoPrompts(input:Omit<ExternalImportInput,'sources'>) {
 return importExternal({...input,sources:[{name:'auto-prompts.json',maxBytes:12000000,missing:[],rows:autoPromptRows}]});
}
export { exportExternal } from '../remote/storage-transfer.js';
import { exportExternal } from '../remote/storage-transfer.js';
import type { AutoPromptRepository } from './storage-repository.js';
export function exportAutoPrompts(repository:AutoPromptRepository,parent:string,id:string) {
 return exportExternal(repository,parent,id,[{name:'auto-prompts.json',value:rows=>rows.slice().sort((a,b)=>a.ordinal-b.ordinal).map(row=>JSON.parse(row.json))}]);
}
