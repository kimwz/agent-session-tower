import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { StorageClient } from './client.js';
import type { DomainAuthority } from './contract.js';
import { STAGED_DOMAINS, StorageInitializationError, type StorageDomainScope } from './domain-authority.js';
import { privateDirectory, storageLayout, writePrivateDocument } from './paths.js';
import type { StrandedStage } from './stranded-stage-commands.js';

/**
 * Stage rows an earlier worker left (see stranded-stage-commands.ts) are retired when a worker starts: kept first in a
 * verified storage snapshot and an owner-only evidence document, then removed by name. They never took effect, so
 * nothing is replayed and no committed row changes.
 */
export interface RetiredStages { snapshotId: string; evidence: string; stages: (StrandedStage & { scope: StorageDomainScope })[] }

export async function retireStrandedStages(storage: StorageClient, stateDir: string, authorities: ReadonlyMap<string, DomainAuthority>): Promise<RetiredStages | undefined> {
  const ownerEpoch = storage.status().ownerEpoch;
  if (ownerEpoch === undefined) return undefined;
  const stranded: RetiredStages['stages'] = [];
  for (const scope of STAGED_DOMAINS) {
    // A domain without database authority keeps its refusal: its rows are not this store's to judge.
    if (authorities.get(scope)?.authority !== 'database') continue;
    for (const stage of await storage.read<StrandedStage[]>(scope, 'strandedStages', {})) if (stage.ownerEpoch < ownerEpoch) stranded.push({ scope, ...stage });
  }
  if (!stranded.length) return undefined;
  const first = stranded[0];
  const held = (reason: string, error: unknown) => new StorageInitializationError('stages-held', first.scope,
    `${stranded.length} stranded staged write(s) were kept: ${reason} (${error instanceof Error ? error.message : String(error)}).`);
  let snapshotId: string, evidence: string;
  try {
    snapshotId = (await storage.snapshot()).id;
    const layout = await storageLayout(stateDir);
    const dir = join(layout.recoveryDir, 'stranded-stages');
    await privateDirectory(layout.recoveryDir, true);
    await privateDirectory(dir, true);
    evidence = join(dir, `${snapshotId}.json`);
    await writePrivateDocument(evidence, JSON.stringify({
      format: 'tower-stranded-stages', version: 1, recordedAt: new Date().toISOString(), build: storage.identity, ownerEpoch, snapshotId, stages: stranded,
    }, null, 2));
  } catch (error) { throw held('their snapshot or evidence could not be written', error); }
  for (const scope of new Set(stranded.map(stage => stage.scope))) {
    const named = stranded.filter(stage => stage.scope === scope).map(({ intent, ownerEpoch: epoch, sha256 }) => ({ intent, ownerEpoch: epoch, sha256 }));
    await storage.write(scope, 'discardStranded', { stages: named }, `stranded-${scope}-${randomUUID()}`);
  }
  return { snapshotId, evidence, stages: stranded };
}
