import { customRoleLines } from '../../shared/models.js';
import { readModelSettings } from './settings.js';

/**
 * What a Tower turn is told about the owner's skill roles: skills name a role (`review.codex`) instead of a model, and
 * this table says what each runs on now. Nothing when there are no skill roles, so turns pay for it only then.
 */
export async function modelRoleNotes(stateDir: string): Promise<string | undefined> {
  const lines = customRoleLines(await readModelSettings(stateDir));
  if (!lines.length) return undefined;
  return ['Model roles the owner set for skills (role = provider / model / reasoning effort). When a skill names one of these roles for a model, use this model. For codex exec or claude -p, the models_get tool or `agent-session-tower models args <role>` gives the flags.', ...lines].join('\n');
}
