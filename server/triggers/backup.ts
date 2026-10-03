import type { OnceConsumption } from '../../shared/triggers.js';
import type { GitHubCursor } from './github.js';
import { validStoredSecret } from './secrets.js';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

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

/**
 * What a backup keeps of the trigger engine's saved state, in this key order (older engines read only the named
 * fields). Triggers are passed through as saved: archived, consumed and encoded once reservations included, so only
 * the trigger owner ever decodes them. Undefined when there is no saved state.
 */
export function triggerBackupOf(saved: unknown): TriggerBackup | undefined {
  if (!record(saved)) return undefined;
  const github: Record<string, GitHubCursor> = {};
  if (record(saved.cursors)) for (const [id, cursor] of Object.entries(saved.cursors)) if (record(cursor) && record(cursor.github)) github[id] = cursor.github as GitHubCursor;
  return {
    onceConsumed: record(saved.onceConsumed) ? saved.onceConsumed as TriggerBackup['onceConsumed'] : {},
    triggers: Array.isArray(saved.triggers) ? saved.triggers : [],
    settings: saved.settings ?? {},
    trustedFolders: Array.isArray(saved.trustedFolders) ? saved.trustedFolders.filter((item): item is string => typeof item === 'string') : [],
    secretGrants: record(saved.secretGrants) ? saved.secretGrants as Record<string, string[]> : {},
    fired: record(saved.fired) ? saved.fired as Record<string, string> : {},
    github,
  };
}

/** What a backup keeps of the plaintext trigger secrets file: the list (or an object) as it is; nothing otherwise. */
export function secretsBackupOf(saved: unknown): unknown {
  return Array.isArray(saved) || record(saved) ? saved : undefined;
}

/**
 * The backup's secrets (its value wins for the same one), then the secrets only this computer has, so a trigger kept
 * here never loses the one it uses. Undefined when any incoming entry is not a stored secret.
 */
export function mergeTriggerSecrets(incoming: unknown, existing: unknown): unknown[] | undefined {
  if (!Array.isArray(incoming) || !incoming.every(item => record(item) && validStoredSecret(item))) return undefined;
  const ids = new Set(incoming.map(item => item.id));
  return [...incoming, ...(Array.isArray(existing) ? existing.filter(item => record(item) && !ids.has(String(item.id))) : [])];
}
