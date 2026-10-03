import type { OnceConsumption } from '../../shared/triggers.js';
import type { GitHubCursor } from './github.js';

/** Trigger settings as a backup keeps them; the trigger service merges them with what it holds (`TriggerService.start`). */
export interface TriggerBackup {
  onceConsumed?: Record<string, OnceConsumption>;
  triggers: unknown[];
  settings: unknown;
  trustedFolders: string[];
  secretGrants: Record<string, string[]>;
  /** `${triggerId} ${dedupKey}` → when it fired. */
  fired: Record<string, string>;
  /** Per trigger, what its GitHub watch has already taken or noted. */
  github: Record<string, GitHubCursor>;
}
