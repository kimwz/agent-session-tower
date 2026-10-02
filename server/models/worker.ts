import { masterWorkerModel } from '../../shared/models.js';
import type { CreateSessionRequest, NewSessionInput } from '../../shared/types.js';
import { requestedEffort, requestedModel } from '../providers/models.js';
import { readModelSettings } from './settings.js';

/** Resolve only at the receiving worker, inside its admission/remote request ledger. */
export async function newWorkerSession(stateDir: string, input: NewSessionInput): Promise<CreateSessionRequest> {
  const { modelRole, ...request } = input;
  if (modelRole !== undefined && modelRole !== 'master.worker') throw Object.assign(new Error('Unknown worker model role.'), { statusCode: 400 });
  const choice = modelRole ? masterWorkerModel(await readModelSettings(stateDir), input) : input;
  if (choice.provider !== 'claude' && choice.provider !== 'codex') throw Object.assign(new Error('Choose Claude or Codex.'), { statusCode: 400 });
  requestedModel(choice.model);
  requestedEffort(choice.effort, choice.provider);
  return { ...request, provider: choice.provider, ...(choice.model !== undefined ? { model: choice.model } : {}),
    ...(choice.effort !== undefined ? { effort: choice.effort } : {}) };
}
