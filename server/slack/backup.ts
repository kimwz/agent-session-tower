/** What a backup keeps of the Slack and GitHub automation files and the Slack connection, and how a restore takes them. */
import { validateSlackRules } from './automation.js';
import { validSlackConnection } from './service.js';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** The rules only; workflows are this computer's work. Used for Slack and GitHub automation alike. */
export function automationBackupOf(saved: Record<string, unknown>): Record<string, unknown> { return { rules: saved.rules ?? [] }; }

/**
 * The backup's rules with this computer's workflows; other keys are dropped. GitHub automation keeps its rules in the
 * same form as Slack's (one coordinator manager for both). Undefined when the rules are not valid.
 */
export function mergeAutomation(incoming: unknown, existing: unknown): Record<string, unknown> | undefined {
  if (!record(incoming) || !Array.isArray(incoming.rules)) return undefined;
  try { validateSlackRules(incoming.rules); } catch { return undefined; }
  return { rules: incoming.rules, workflows: record(existing) && Array.isArray(existing.workflows) ? existing.workflows : [] };
}

/** Slack work not yet finished belongs to the account that received it. */
export const UNFINISHED_SLACK = new Set(['received', 'matching', 'dispatching', 'running', 'composing', 'sending', 'reply-uncertain', 'admission-uncertain']);
export const slackAccountKey = (value: unknown) => record(value) && record(value.account) ? `${value.account.teamId}:${value.account.userId}` : '';
/** Whether this computer's Slack automation file still has work under way. */
export function hasUnfinishedSlackWork(automation: unknown): boolean {
  return record(automation) && Array.isArray(automation.workflows) && automation.workflows.some(item => record(item) && UNFINISHED_SLACK.has(String(item.status)));
}

/** The backup's connection when the Slack service would start with it; undefined otherwise, so it is never written. */
export function restoreSlackConnection(incoming: unknown): unknown { return validSlackConnection(incoming) ? incoming : undefined; }
