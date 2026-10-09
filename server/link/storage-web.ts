import type { WorkerStorageStatus } from '../../shared/storage.js';
import { captureStorageBundle, preflightStorage, storageBuildContext } from '../storage/index.js';
import { TowerError } from '../../shared/errors.js';
import { evaluateStorageUpdate, readRollbackRecord, resumeRollback, storageHealth, type RollbackContext, type RunningBuild, type StorageUpdateEvaluation } from './storage-update.js';

/** One captured web build; all observations of mutable state remain read-only and fresh. */
export function storageWebBuild(stateDir: string, version: string): () => Promise<RunningBuild> {
  const captured = captureStorageBundle();
  return async () => {
    const bundle = await captured;
    const context = storageBuildContext(bundle);
    const preflight = await preflightStorage({ bundle, stateDir });
    return { version, ...(context.ok ? { manifest: context.manifest } : {}), preflight };
  };
}

/** Candidate web readiness is independent of the worker, including a JSON-only attached worker. */
export async function storageWebHealth(input: { stateDir: string; managed: boolean; build: RunningBuild }, worker?: WorkerStorageStatus) {
  const evaluation = await evaluateStorageUpdate(input);
  return composeStorageWebHealth(evaluation, worker);
}

function composeStorageWebHealth(evaluation: StorageUpdateEvaluation, worker?: WorkerStorageStatus) {
  const candidate = storageHealth(evaluation);
  return { status: candidate.status === 503 || ['contract-mismatch', 'current-artifact', 'current-pointer', 'rollback-not-target'].includes(evaluation.code) || worker?.healthStatus === 503 ? 503 as const : 200 as const,
    diagnostic: evaluation.verdict !== 'ready' || Boolean(worker && !worker.admissionOpen),
    ...(worker ? { storage: worker } : {}), candidateStorage: candidate.storage };
}

/** Called only after listen succeeds; continues the existing switched owner operation, never starts a rollback. */
export async function storageWebServing(context: RollbackContext) {
  const read = await readRollbackRecord(context.stateDir);
  if (read.state === 'absent') return undefined;
  if (read.state !== 'present') throw new TowerError('unavailable', `Storage rollback record is ${read.state}.`);
  const record = read.record;
  if (record.target !== context.running.version || (!record.switched && record.state !== 'switching')) return undefined;
  if (!context.running.preflight.supported) throw new TowerError('unavailable', 'The target web storage preflight was refused.');
  // resumeRollback owns claim, current/artifact/pin/hash checks and the fenced serving proof.
  return context.serialize(() => resumeRollback(context));
}
