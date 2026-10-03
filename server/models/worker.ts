import { masterWorkerModel } from '../../shared/models.js';
import type { CreateSessionRequest, NewSessionInput } from '../../shared/types.js';
import { requestedEffort, requestedModel } from '../providers/models.js';
import { readModelSettings } from './settings.js';
import { TowerError } from '../../shared/errors.js';

/** Resolve only at the receiving worker, inside its admission/remote request ledger. */
export async function newWorkerSession(stateDir: string, input: NewSessionInput): Promise<CreateSessionRequest> {
  const { modelRole, ...request } = input;
  if (modelRole !== undefined && modelRole !== 'master.worker') throw new TowerError('invalid', 'Unknown worker model role.');
  const choice = modelRole ? masterWorkerModel(await readModelSettings(stateDir), input) : input;
  if (choice.provider !== 'claude' && choice.provider !== 'codex') throw new TowerError('invalid', 'Choose Claude or Codex.');
  requestedModel(choice.model);
  requestedEffort(choice.effort, choice.provider);
  return { ...request, provider: choice.provider, ...(choice.model !== undefined ? { model: choice.model } : {}),
    ...(choice.effort !== undefined ? { effort: choice.effort } : {}) };
}
