import { isAbsolute } from 'node:path';
import type { Attachment, AutoPromptJob, AutoPromptDecision } from '../../shared/types.js';
import { attachmentMetadata } from '../stores/attachments.js';
import { validEffort, validModelId } from '../providers/models.js';
import { isSavedDelegation } from '../runs/saved-state.js';
import { parseRunOrigin } from '../runs/origin.js';
import { pickProblem } from '../../shared/models.js';
import { canonical, object as requiredObject, type ExternalRow, type ExternalCodec } from '../remote/storage-rows.js';
type Relation = 'continuation' | 'adjacent' | 'new';
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const validTarget = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
export interface Entry {
  job: AutoPromptJob; fingerprint: string; staged: Attachment[];
  /** Present only before an effect or after proven non-admission. */
  resumable?: true;
  selection?: { decision: AutoPromptDecision; relation: Relation; expectedNativeId?: string };
}
export function validEntry(value: unknown): value is Entry {
  const entry = object(value);
  const job = object(entry?.job);
  const selection = object(entry?.selection);
  const decision = object(selection?.decision);
  const checkpointValid = entry?.selection === undefined || !!selection && !!decision
    && ['continuation', 'adjacent', 'new'].includes(String(selection.relation))
    && (selection.expectedNativeId === undefined || validTarget(selection.expectedNativeId))
    && typeof decision.cwd === 'string' && decision.cwd === job?.cwd
    && typeof decision.reason === 'string' && !!decision.reason.trim() && decision.reason.length <= 1500
    && (decision.action === 'create' && decision.sessionId === undefined
      || decision.action === 'resume' && validTarget(decision.sessionId) && validTarget(selection.expectedNativeId) && selection.relation !== 'new');
  return checkpointValid && (entry?.resumable === undefined || entry.resumable === true
      && !!job && (job.status === 'queued' || job.status === 'routing' || job.status === 'dispatching' && !!selection))
    && !!job && typeof entry?.fingerprint === 'string' && /^[a-f\d]{64}$/.test(entry.fingerprint)
    && Array.isArray(entry.staged) && entry.staged.length <= 10 && entry.staged.every(item => attachmentMetadata(item))
    && (job.delegation === undefined || isSavedDelegation(job.delegation))
    && (job.origin === undefined || !!parseRunOrigin(job.origin))
    && (job.untrustedInput === undefined || job.untrustedInput === true)
    && typeof job.id === 'string' && UUID.test(job.id) && ['claude', 'codex'].includes(String(job.provider))
    && (job.sessionMode === undefined || job.sessionMode === 'new')
    && (job.targetSessionId === undefined || (validTarget(job.targetSessionId) && job.sessionMode === undefined && typeof job.cwd === 'string'))
    && (job.routingContext === undefined || typeof job.routingContext === 'string' && job.routingContext.length <= 32_000)
    && (job.newSessionModel === undefined || !pickProblem(job.newSessionModel, job.provider as 'claude' | 'codex'))
    && (job.model === undefined || validModelId(job.model))
    && (job.effort === undefined || validEffort(job.effort))
    && typeof job.prompt === 'string' && job.prompt.length <= 32_000 && typeof job.routerModel === 'string'
    && (job.routerProvider === undefined || ['claude', 'codex'].includes(String(job.routerProvider))) && (job.routerEffort === undefined || validEffort(job.routerEffort))
    && typeof job.createdAt === 'string' && typeof job.updatedAt === 'string'
    && ['queued', 'routing', 'dispatching', 'completed', 'error', 'cancelled', 'uncertain'].includes(String(job.status))
    && (job.cwd === undefined || typeof job.cwd === 'string' && isAbsolute(job.cwd) && job.cwd.length <= 4096)
    && (job.codexApprovalsReviewer === undefined || ['user', 'auto_review'].includes(String(job.codexApprovalsReviewer)))
    && (job.exclusionRevision === undefined || Number.isSafeInteger(job.exclusionRevision));
}

export const autoPromptCodec: ExternalCodec = {
 scope:'auto-prompt',table:'auto_prompt',maxBytes:72_000_000,
 needsIntent(row,previous) { return previous === null || JSON.parse(row.json).job.status === 'dispatching' && JSON.parse(previous).job.status !== 'dispatching'; },
 validate(row) {
  const v=JSON.parse(row.json);
  if(row.channel!==''||row.kind!=='job'||!Number.isSafeInteger(row.ordinal)||row.ordinal<0||Buffer.byteLength(row.json)>72_000_000||!validEntry(v)||v.job.id!==row.id) throw new Error('Invalid Auto Prompt storage entry.');
  const j=v.job;
  return {status:j.status,created:j.createdAt,controller:j.origin?.controllerId,request:j.id,fingerprint:v.fingerprint,
    links:[...(j.runId?[{kind:'run',id:j.runId}]:[]),...(j.sessionId?[{kind:'session',id:j.sessionId}]:[]),...v.staged.map(a=>({kind:'attachment',id:a.id})),...(v.selection?.expectedNativeId?[{kind:'native-reference',id:v.selection.expectedNativeId}]:[]),...(j.delegation?[{kind:'delegation',id:JSON.stringify(j.delegation)}]:[])]};
 },
 validateCollection(rows) {if(rows.length>100||new Set(rows.map(r=>r.id)).size!==rows.length) throw new Error('Invalid Auto Prompt history capacity/IDs.');for(const row of rows) this.validate(row);},
};
export function autoPromptRows(value:unknown):ExternalRow[] {
 if(!Array.isArray(value)) throw new Error('Invalid Auto Prompt history source.');
 const rows=value.map((entry,ordinal)=>({channel:'',kind:'job',id:String(requiredObject(requiredObject(entry).job).id),ordinal,json:canonical(entry)}));
 autoPromptCodec.validateCollection(rows);return rows;
}
