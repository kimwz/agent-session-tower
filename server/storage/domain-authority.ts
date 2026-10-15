import type { StorageClient } from './client.js';
import type { DomainAuthority } from './contract.js';

/**
 * The seven storage domains and the check every domain's consumer makes before it reads or writes: that the database
 * holds the domain. Depends on the storage client alone, so a domain module can ask it without reaching the others
 * (initialize.ts, which creates the authorities, reaches every domain's repository).
 */

export const STORAGE_DOMAINS = ['runs', 'retention', 'triggers', 'permissions', 'remote', 'auto-prompt', 'automation-workflows'] as const;
export type StorageDomainScope = typeof STORAGE_DOMAINS[number];

export class StorageInitializationError extends Error {
  readonly code: 'authority-missing' | 'legacy-source-present' | 'legacy-exported' | 'stages-held';
  readonly scope: StorageDomainScope;
  constructor(code: StorageInitializationError['code'], scope: StorageDomainScope, message: string) {
    super(message);
    this.name = 'StorageInitializationError';
    this.code = code; this.scope = scope;
  }
}

/** Domains whose staged (multi-part) writes leave rows a crash can strand; permissions commits in one command. */
const STAGED: ReadonlySet<StorageDomainScope> = new Set(['runs', 'retention', 'triggers', 'remote', 'auto-prompt', 'automation-workflows']);
export const stagesOf = async (storage: StorageClient, scope: StorageDomainScope) => STAGED.has(scope) ? (await storage.read<{ stages: number }>(scope, 'bootstrapHistory', {})).stages : 0;

/** Throws unless the database holds `scope` (authority `database`) with no stranded stages. */
export async function requireDomainAuthority(storage: StorageClient, scope: StorageDomainScope): Promise<void> {
  // The authority row itself first: a domain's head() refuses rows without one in its own words.
  const authority = (await storage.inspect()).authority.find(entry => entry.domain === scope);
  if (!authority) throw new StorageInitializationError('authority-missing', scope, `${scope} has no storage authority.`);
  if (authority.authority !== 'database') throw new StorageInitializationError('legacy-exported', scope, `${scope} was exported back to its legacy files; only the owner can recover it.`);
  const head = await storage.read<{ authority?: DomainAuthority | null }>(scope, 'head', {});
  if (head.authority?.authority !== 'database' || head.authority.generation !== authority.generation) throw new StorageInitializationError('authority-missing', scope, `${scope} has no storage authority.`);
  const stages = await stagesOf(storage, scope);
  if (stages) throw new StorageInitializationError('stages-held', scope, `${scope} holds ${stages} unfinished staged write(s); they need explicit owner recovery.`);
}
