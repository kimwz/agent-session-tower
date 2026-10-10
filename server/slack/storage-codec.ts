import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { validModelId } from '../providers/models.js';
import type { SlackRule, SlackWorkflow, SlackMention, SlackMessage } from '../../shared/slack.js';
import { canonical, object, type ExternalCodec, type ExternalRow } from '../remote/storage-rows.js';
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const MAX_RULE_BYTES=100_000, MAX_REACTIONS=20, MAX_FOLLOW_UPS=100, MAX_FOLLOW_UP_TEXT=8_000, MAX_WORKING_MARKS=101;
const validEmoji = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9_+'-]{1,100}$/.test(v);
export type WorkflowChannel = 'slack' | 'github';
export function validateSlackRules(value: unknown): asserts value is SlackRule[] {
  if (!Array.isArray(value) || value.length > 100 || value.some(rule => !record(rule) || !text(rule.id, 100)
    || !text(rule.name, 200) || typeof rule.enabled !== 'boolean' || !text(rule.condition, 4000)
    || !text(rule.instructions, 8000) || !text(rule.replyInstructions, 4000) || !['claude', 'codex'].includes(String(rule.provider))
    || (rule.model !== undefined && !validModelId(rule.model)) || (rule.autoReply !== undefined && typeof rule.autoReply !== 'boolean')
    || (rule.cwd !== undefined && (typeof rule.cwd !== 'string' || !isAbsolute(rule.cwd) || rule.cwd.includes('\0') || rule.cwd.length > 4096)))
    || new Set(value.map(rule => rule.id)).size !== value.length) throw new Error('Slack 처리 지침이 올바르지 않습니다.');
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_RULE_BYTES) throw new Error('Slack 처리 지침은 합계 100 KB 이하여야 합니다.');
}
function validMention(value: unknown): value is SlackMention {
  return record(value) && ['id', 'teamId', 'channel', 'user', 'ts', 'threadTs'].every(key => text(value[key], 200)) && text(value.text, 40_000);
}
function validThread(value: unknown): value is SlackMessage[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 1000 && value.every(item => record(item)
    && typeof item.text === 'string' && item.text.length <= 40_000 && text(item.user, 200) && text(item.ts, 200));
}
export function slackRequestId(mention: SlackMention): string {
  const hex = createHash('sha256').update(JSON.stringify([mention.teamId, mention.id])).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function validateAutomationSource(saved:unknown,channel:WorkflowChannel): asserts saved is { rules:SlackRule[];workflows:SlackWorkflow[] } {
const validReaction=channel==='github'?(name:unknown)=>typeof name==='string'&&['+1','-1','laugh','confused','heart','hooray','rocket','eyes'].includes(name):validEmoji;
      if (!record(saved) || !Array.isArray(saved.workflows) || saved.workflows.length > 10_000) throw new Error('Saved Slack automation state is invalid.');
      validateSlackRules(saved.rules);
      for (const item of saved.workflows) {
        if (!record(item) || !validMention(item.mention) || item.id !== slackRequestId(item.mention)
          || !['received', 'matching', 'ignored', 'dispatching', 'running', 'composing', 'sending', 'completed', 'error', 'admission-uncertain', 'reply-uncertain'].includes(String(item.status))) throw new Error('Saved Slack workflow is invalid.');
        if (item.mode !== undefined && item.mode !== 'conversation') throw new Error('Saved Slack workflow mode is invalid.');
        if (item.approvals !== undefined && item.approvals !== 'auto' && item.approvals !== 'owner') throw new Error('Saved Slack workflow approvals are invalid.');
        if (item.conversationClaimed !== undefined && typeof item.conversationClaimed !== 'boolean') throw new Error('Saved Slack creation claim is invalid.');
        if (item.repliesHeld !== undefined && item.repliesHeld !== true && item.repliesHeld !== 'unclear') throw new Error('Saved Slack reply hold is invalid.');
        if (item.delegatedTasks !== undefined && (!Array.isArray(item.delegatedTasks) || item.delegatedTasks.length > 100 || item.delegatedTasks.some(task => !record(task)
          || !text(task.requestKey, 200) || !text(task.requestId, 200) || !text(task.prompt, 32_000) || !['claude', 'codex'].includes(String(task.provider))
          || (task.createdSessionId !== undefined && !text(task.createdSessionId, 500))
          || (task.delegatedFinished !== undefined && typeof task.delegatedFinished !== 'boolean')
          || (task.model !== undefined && !validModelId(task.model))
          || (task.cwd !== undefined && (!text(task.cwd, 4096) || !isAbsolute(task.cwd)))))) throw new Error('Saved Slack tasks are invalid.');
        if (item.replies !== undefined && (!Array.isArray(item.replies) || item.replies.length > 100 || item.replies.some(reply => !record(reply)
          || !text(reply.requestKey, 200) || !text(reply.text, 4000) || !['proposed', 'sending', 'sent', 'uncertain'].includes(String(reply.status))))) throw new Error('Saved Slack replies are invalid.');
        if (item.ownerReplySelection !== undefined && (!record(item.ownerReplySelection) || !text(item.ownerReplySelection.requestKey, 200) || !text(item.ownerReplySelection.text, 4000))) throw new Error('Saved Slack owner selection is invalid.');
        if (item.ownerConditionalReply !== undefined) {
          const consent = item.ownerConditionalReply;
          if (!record(consent) || !text(consent.requestId, 200) || !text(consent.requestKey, 200) || !text(consent.text, 4000)
            || !text(consent.authorizedAt, 100) || !['pending', 'sent', 'blocked', 'cancelled', 'uncertain'].includes(String(consent.status))
            || (consent.mode !== undefined && consent.mode !== 'composed') || (consent.ruleId !== undefined && !text(consent.ruleId, 100))
            || (consent.requestIds !== undefined && (!Array.isArray(consent.requestIds) || consent.requestIds.length > 100 || consent.requestIds.some(id => !text(id, 200))))
            || (consent.instruction !== undefined && !text(consent.instruction, 32000))
            || (consent.evidence !== undefined && !text(consent.evidence, 4000))) throw new Error('Saved Slack conditional authorization is invalid.');
        }
        if (item.reactions !== undefined && (!Array.isArray(item.reactions) || item.reactions.length > MAX_REACTIONS || item.reactions.some(reaction => !record(reaction)
          || !(typeof reaction.name === 'string' && (validReaction)(reaction.name)) || !['add', 'remove'].includes(String(reaction.action)) || !text(reaction.at, 100)))) throw new Error('Saved Slack reactions are invalid.');
        if (item.followUps !== undefined && (!Array.isArray(item.followUps) || item.followUps.length > MAX_FOLLOW_UPS || item.followUps.some(followUp => !record(followUp)
          || !text(followUp.ts, 200) || !text(followUp.user, 200) || typeof followUp.text !== 'string' || followUp.text.length > MAX_FOLLOW_UP_TEXT || !text(followUp.receivedAt, 100)
          || !['received', 'pending', 'delivering', 'delivered', 'skipped', 'error', 'uncertain'].includes(String(followUp.status))
          || (followUp.mentioned !== undefined && typeof followUp.mentioned !== 'boolean')
          || (followUp.addressed !== undefined && !(typeof followUp.addressed === 'number' && followUp.addressed >= 0 && followUp.addressed <= 1))
          || (followUp.reason !== undefined && !text(followUp.reason, 1500)) || (followUp.runId !== undefined && !text(followUp.runId, 200))
          || (followUp.deliveredAt !== undefined && !text(followUp.deliveredAt, 100))))) throw new Error('Saved Slack follow-ups are invalid.');
        if (item.reactions?.some(reaction => (reaction as { ts?: unknown }).ts !== undefined && !text((reaction as { ts?: unknown }).ts, 200))) throw new Error('Saved Slack reactions are invalid.');
        if (item.workingMarks !== undefined && (!Array.isArray(item.workingMarks) || item.workingMarks.length > MAX_WORKING_MARKS || item.workingMarks.some(mark => !record(mark)
          || !text(mark.ts, 200) || !validEmoji(mark.name) || !['add', 'on', 'off'].includes(String(mark.state))
          || (mark.error !== undefined && !text(mark.error, 1500))))) throw new Error('Saved Slack working marks are invalid.');
        validateSlackRules(item.rules);
        if (item.rule) validateSlackRules([item.rule]);
        if (item.thread !== undefined && !validThread(item.thread)) throw new Error('Saved Slack thread is invalid.');
      }
}

export const workflowCodec:ExternalCodec={
 scope:'automation-workflows',table:'automation_workflows',maxBytes:120_000_000,
 needsIntent(row,previous) {
  if(row.kind!=='workflow') return false;if(previous===null) return true;
  const next=JSON.parse(row.json) as SlackWorkflow,old=JSON.parse(previous) as SlackWorkflow;
  if(next.conversationClaimed&&!old.conversationClaimed || next.status==='sending'&&old.status!=='sending') return true;
  if(next.replies?.some(reply=>reply.status==='sending'&&!old.replies?.some(saved=>saved.requestKey===reply.requestKey&&saved.status==='sending'))) return true;
  if(next.delegatedTasks?.some(task=>task.notificationClaimed&&!old.delegatedTasks?.some(saved=>saved.requestId===task.requestId&&saved.notificationClaimed))) return true;
  return !!next.followUps?.some(follow=>follow.status==='delivering'&&!old.followUps?.some(saved=>saved.ts===follow.ts&&saved.status==='delivering'));
 },
 validate(row) {
  if(!['slack','github'].includes(row.channel)||!Number.isSafeInteger(row.ordinal)||row.ordinal<0||Buffer.byteLength(row.json)>60_000_000) throw new Error('Invalid workflow storage row.');
  const v=object(JSON.parse(row.json));
  if(row.kind==='settings') {if(row.id!=='wrapper'||'rules' in v||'workflows' in v) throw new Error('Invalid workflow wrapper.');return {};}
  if(row.kind==='rule') {validateSlackRules([v]);if(v.id!==row.id) throw new Error('Workflow rule ID mismatch.');return {status:v.enabled?'enabled':'disabled'};}
  if(row.kind!=='workflow'||row.id!==v.id) throw new Error('Workflow identity mismatch.');
  validateAutomationSource({rules:[],workflows:[v]},row.channel as WorkflowChannel);
  const w=v as unknown as SlackWorkflow;
  return {status:w.status,created:w.createdAt,request:w.id,account:w.mention.teamId,
   links:[...(w.sessionId?[{kind:'session',id:w.sessionId}]:[]),...(w.runId?[{kind:'run',id:w.runId}]:[]),...(w.autoPromptId?[{kind:'request',id:w.autoPromptId}]:[]),
    ...(w.delegatedTasks??[]).flatMap(task=>[{kind:'request',id:task.requestId,status:task.submissionError?'uncertain':task.notifiedRunId?'notified':'pending'},...(task.delegatedRunId?[{kind:'run',id:task.delegatedRunId}]:[]),...(task.notifiedRunId?[{kind:'notification',id:task.notifiedRunId}]:[]),...(task.createdSessionId?[{kind:'session',id:task.createdSessionId}]:[])]),
    ...(w.replies??[]).map(reply=>({kind:'reply',id:reply.requestKey,status:reply.status})),...(w.followUps??[]).map(follow=>({kind:'follow-up',id:follow.ts,status:follow.status})),
    ...(w.ownerConditionalReply?[{kind:'permission',id:w.ownerConditionalReply.requestKey,status:w.ownerConditionalReply.status}]:[])]};
 },
 validateCollection(rows) {
  if(rows.some(r=>!['slack','github'].includes(r.channel))) throw new Error('Unknown workflow channel.');
  for(const channel of ['slack','github']) {
   const own=rows.filter(r=>r.channel===channel);if(!own.length) continue;
   if(own.filter(r=>r.kind==='settings').length!==1||own.filter(r=>r.kind==='workflow').length>10_000) throw new Error('Invalid workflow collection capacity/wrapper.');
   const rules=own.filter(r=>r.kind==='rule').sort((a,b)=>a.ordinal-b.ordinal).map(r=>JSON.parse(r.json));validateSlackRules(rules);
   const keys=new Set<string>();for(const row of own) {this.validate(row);const key=canonical([row.kind,row.id]);if(keys.has(key)) throw new Error('Duplicate workflow source ID.');keys.add(key);}
  }
 },
};
export function workflowRows(value:unknown,channel:WorkflowChannel):ExternalRow[] {
 validateAutomationSource(value,channel);const {rules,workflows,...wrapper}=value as unknown as Record<string,unknown> & {rules:SlackRule[];workflows:SlackWorkflow[]};
 const rows=[{channel,kind:'settings',id:'wrapper',ordinal:0,json:canonical(wrapper)},...rules.map((rule,ordinal)=>({channel,kind:'rule',id:rule.id,ordinal,json:canonical(rule)})),...workflows.map((workflow,ordinal)=>({channel,kind:'workflow',id:workflow.id,ordinal,json:canonical(workflow)}))];workflowCodec.validateCollection(rows);return rows;
}
export function workflowSource(rows:readonly ExternalRow[],channel:WorkflowChannel):Record<string,unknown> & {rules:SlackRule[];workflows:SlackWorkflow[]} {
 const own=rows.filter(r=>r.channel===channel),wrapper=own.find(r=>r.kind==='settings');if(!wrapper) throw new Error('Missing workflow wrapper authority.');
 const source={...JSON.parse(wrapper.json),rules:own.filter(r=>r.kind==='rule').sort((a,b)=>a.ordinal-b.ordinal).map(r=>JSON.parse(r.json)),workflows:own.filter(r=>r.kind==='workflow').sort((a,b)=>a.ordinal-b.ordinal).map(r=>JSON.parse(r.json))};validateAutomationSource(source,channel);return source;
}
