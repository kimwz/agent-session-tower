import { join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { importExternal, type ExternalImportInput } from '../remote/storage-transfer.js';
import { workflowRows } from './storage-codec.js';
export function importWorkflows(input:Omit<ExternalImportInput,'sources'>) {
 return importExternal({...input,sources:[{name:'slack-automation.json',maxBytes:10000000,missing:{rules:[],workflows:[]},rows:value=>workflowRows(value,'slack')},{name:'github-automation.json',maxBytes:10000000,missing:{rules:[],workflows:[]},rows:value=>workflowRows(value,'github')}]});
}
import { exportExternal } from '../remote/storage-transfer.js';
import type { WorkflowRepository } from './storage-repository.js';
export function exportWorkflows(repository:WorkflowRepository,parent:string,id:string) {
 return exportExternal(repository,parent,id,[{name:'slack-automation.json',value:rows=>repository.source(rows,'slack')},{name:'github-automation.json',value:rows=>repository.source(rows,'github')}]);
}

export async function workflowLegacyFiles(stateDir: string): Promise<'absent' | 'present'> {
  for (const name of ['slack-automation.json', 'github-automation.json', 'automation-workflows-storage-migrations']) {
    try { await lstat(join(stateDir, name)); return 'present'; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'present'; }
  }
  return 'absent';
}
