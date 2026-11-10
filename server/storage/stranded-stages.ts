import { randomUUID } from 'node:crypto';
import { readdir, readFile, rename } from 'node:fs/promises';
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
    // Nor does a domain a recovery barrier still holds: the owner reconciles it first.
    if (!(await storage.gate(scope)).open) continue;
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
    // Written, durably, before any row goes: it is also the mark that runs restore has not yet been told (see below).
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

const evidenceDir = async (stateDir: string) => join((await storageLayout(stateDir)).recoveryDir, 'stranded-stages');

/**
 * Evidence documents of retired runs stages whose restore has not yet been settled. A retired runs write may have been
 * the start of a queued run, so until the restore that cancels queued runs has been saved, every start asks for it
 * again (a failed retry, an aborted attempt or another reboot keep the mark). A document that cannot be read counts.
 */
export async function unsettledRunsRetirements(stateDir: string): Promise<string[]> {
  const dir = await evidenceDir(stateDir);
  let names: string[];
  try { names = await readdir(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const pending: string[] = [];
  for (const name of names.filter(name => name.endsWith('.json') && !name.startsWith('.')).sort()) {
    const path = join(dir, name);
    try {
      const document = JSON.parse(await readFile(path, 'utf8')) as { stages?: { scope?: string }[]; runsSettledAt?: string };
      if (document.runsSettledAt || !document.stages?.some(stage => stage.scope === 'runs')) continue;
    } catch (error) { console.error(`Stranded stage evidence ${path} is unreadable; runs restore treats it as unsettled: ${error instanceof Error ? error.message : String(error)}`); }
    pending.push(path);
  }
  return pending;
}

/**
 * Marks the documents settled once the restore that cancelled queued runs has been saved. An unreadable one is kept,
 * renamed `<name>.unreadable`, so it no longer holds every later start.
 */
export async function settleRunsRetirements(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    let document: Record<string, unknown>;
    try { document = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>; }
    catch (error) {
      console.error(`Stranded stage evidence ${path} is unreadable; kept as ${path}.unreadable: ${error instanceof Error ? error.message : String(error)}`);
      await rename(path, `${path}.unreadable`);
      continue;
    }
    await writePrivateDocument(path, JSON.stringify({ ...document, runsSettledAt: new Date().toISOString() }, null, 2));
  }
}
