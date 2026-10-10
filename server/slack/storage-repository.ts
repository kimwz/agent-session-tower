import type { StorageClient } from '../storage/client.js';
import type { SlackWorkflow, SlackRule } from '../../shared/slack.js';
import { ExternalRowRepository } from '../remote/storage-row-repository.js';
import { canonical, type ExternalRow, type ExternalChange } from '../remote/storage-rows.js';
import { workflowCodec, workflowSource, validateSlackRules, type WorkflowChannel } from './storage-codec.js';
export class WorkflowRepository extends ExternalRowRepository {
 constructor(storage:StorageClient) {super(storage,workflowCodec,['slack','github'].flatMap(channel=>['settings','rule','workflow'].map(kind=>({channel,kind}))));}
 source(rows:readonly ExternalRow[],channel:WorkflowChannel) {return workflowSource(rows,channel);}
 row(workflow:SlackWorkflow,channel:WorkflowChannel,ordinal:number):ExternalRow {return {channel,kind:'workflow',id:workflow.id,ordinal,json:canonical(workflow)};}
 async capacity(channel:WorkflowChannel):Promise<number> {const h=await this.head();if(!h.authority) throw new Error('Missing workflow authority.');return (await this.storage.read<{bytes:number}>(this.codec.scope,'capacity',{channel,revision:h.revision,generation:h.authority.generation})).bytes;}
 async assertAccountTeam(channel:WorkflowChannel,account:string):Promise<void> {
  const h=await this.head();if(!h.authority) throw new Error('Missing workflow authority.');
  if(await this.storage.read<boolean>(this.codec.scope,'foreignUnfinished',{channel,account,revision:h.revision,generation:h.authority.generation})) throw new Error('Unfinished/uncertain workflow belongs to another Slack account; effects held.');
 }
 async replaceRules(channel:WorkflowChannel,rules:SlackRule[]):Promise<void> {
  validateSlackRules(rules);const rows=await this.loadRows(),previous=rows.filter(r=>r.channel===channel&&r.kind==='rule');
  const changes:ExternalChange[]=[...previous.map(row=>({...row,previous:row.json,remove:true as const})),...rules.map((rule,ordinal)=>({channel,kind:'rule',id:rule.id,ordinal,json:canonical(rule),previous:null}))];
  await this.update(changes);
 }
}
