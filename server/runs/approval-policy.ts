import type { CodexApprovalsReviewer, CreateSessionRequest, Run, RunOrigin } from '../../shared/types.js';
import { requestedApprovalsReviewer } from '../providers/approvals.js';
import { ownerOrigin } from './origin.js';

/** The owner's own turns always run in the provider's automatic approval mode; triggers and Slack follow their setting. */
export function automaticApprovals(run: Run): boolean { return run.unattended === true || ownerOrigin(run.origin); }
/** Modes at least as careful as asking the owner. Anything else is not what an unattended run asked for. */
export const OWNER_APPROVAL_MODES = new Set(['default', 'manual', 'plan', 'dontAsk']);

/**
 * What a Claude turn does about the permission mode it reports when it starts: nothing, go on with a note, or stop.
 * An unattended run continues only in automatic mode, or in a mode that asks the owner; any other or missing mode is
 * stopped. The owner's own turns go on and say so.
 */
export function claudeStartMode(run: Run, permissionMode: unknown): { stop: string } | { note: string } | undefined {
  if (!automaticApprovals(run) || permissionMode === 'auto') return undefined;
  const mode = permissionMode === undefined ? 'not reported' : String(permissionMode);
  const asksOwner = OWNER_APPROVAL_MODES.has(mode);
  if (!asksOwner && run.unattended) return { stop: `Claude started in an unexpected permission mode (${mode}). The unattended run was stopped before doing anything.` };
  return { note: `[Tower] Claude did not start in automatic permission mode (${mode}).${asksOwner ? ' Approval requests will wait for you in Tower.' : ''}\n` };
}

/**
 * The owner's own turns hand approvals to Codex's automatic reviewer, in new and resumed threads alike; if Codex does
 * not confirm it, the turn still runs and approvals wait in Tower. Other work keeps the reviewer its setting chose when
 * the thread started, and Slack's tools require the automatic one.
 */
export function codexReviewer(run: Run, creating: boolean, slackTools: boolean): { approvalsReviewer?: CodexApprovalsReviewer; approvalsReviewerPreferred?: true } {
  const owner = ownerOrigin(run.origin);
  const approvalsReviewer = slackTools || owner ? 'auto_review' as const : creating ? run.codexApprovalsReviewer : undefined;
  return { ...(approvalsReviewer ? { approvalsReviewer } : {}), ...(owner && !slackTools ? { approvalsReviewerPreferred: true as const } : {}) };
}

/**
 * The reviewer a new Codex thread keeps. Only a Codex thread has one. The owner's own turns always use the automatic one
 * (see codexReviewer), so one an older page sends is still checked, then left out; triggers and Slack keep theirs.
 */
export function creationReviewer(input: CreateSessionRequest, origin: RunOrigin | undefined): CodexApprovalsReviewer | undefined {
  const requested = input.provider === 'codex' ? requestedApprovalsReviewer(input.codexApprovalsReviewer) : undefined;
  return ownerOrigin(origin) ? undefined : requested;
}
