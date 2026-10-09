import { join } from 'node:path';
import { readPrivateJson } from '../../server/stores/private-json.js';
import { triggerBackupOf } from '../../server/triggers/backup.js';
/** Historical JSON projection reference only. Product backups obtain their DTO from the worker owner. */
export async function collectTriggers(stateDir: string) {
  let saved: unknown;
  try { saved = await readPrivateJson(join(stateDir,'trigger-engine.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return triggerBackupOf(saved);
}
