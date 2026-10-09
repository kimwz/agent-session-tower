import { setTimeout as delay } from 'node:timers/promises';
import type { WorkerStorageStatus } from '../../shared/storage.js';
import { captureStorageBundle, preflightStorage, storageBuildContext } from '../storage/index.js';
import { TowerError } from '../../shared/errors.js';
import { evaluateStorageUpdate, readRollbackRecord, resumeRollback, storageHealth, type RollbackContext, type RollbackOutcome, type RunningBuild, type StorageUpdateEvaluation } from './storage-update.js';

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
export async function storageWebServing(context: RollbackContext, options: { signal?: AbortSignal; intervalMs?: number; timeoutMs?: number } = {}) {
  const read = await readRollbackRecord(context.stateDir);
  if (read.state === 'absent') return undefined;
  if (read.state !== 'present') throw new TowerError('unavailable', `Storage rollback record is ${read.state}.`);
  const record = read.record;
  if (record.target !== context.running.version || (!record.switched && record.state !== 'switching')) return undefined;
  if (!context.running.preflight.supported) throw new TowerError('unavailable', 'The target web storage preflight was refused.');
  // resumeRollback owns claim, current/artifact/pin/hash checks and the fenced serving proof.
  if (options.signal?.aborted) return undefined;
  let outcome: RollbackOutcome | undefined = await context.serialize(() => options.signal?.aborted ? Promise.resolve(undefined) : resumeRollback(context));
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  const interval = Math.max(1, options.intervalMs ?? 250);
  while (outcome && 'record' in outcome && outcome.record.state === 'handing-off' && outcome.record.held
    && outcome.record.handoff?.state === 'pending' && outcome.record.attempt) {
    const previous = outcome.record;
    const remaining = deadline - Date.now();
    if (remaining <= 0 || options.signal?.aborted) break;
    try { await delay(Math.min(interval, remaining), undefined, { signal: options.signal }); }
    catch (error) { if (options.signal?.aborted) break; throw error; }
    if (Date.now() >= deadline || options.signal?.aborted) break;
    // Each observation takes its own update turn; waiting never holds Updates.exclusive.
    const next: RollbackOutcome | undefined = await context.serialize(async () => {
      if (options.signal?.aborted) return undefined;
      const current = await readRollbackRecord(context.stateDir);
      if (current.state !== 'present') return undefined;
      const record = current.record;
      if (record.id !== previous.id || record.target !== context.running.version || record.sourceHash !== previous.sourceHash
        || record.manifestDigest !== previous.manifestDigest || record.entrySha256 !== previous.entrySha256
        || record.updateSha256 !== previous.updateSha256 || record.attempt?.nonce !== previous.attempt?.nonce
        || record.attempt?.n !== previous.attempt?.n || record.handoff?.attempt !== previous.handoff?.attempt
        || record.state !== 'handing-off' || !record.switched || !record.held || record.handoff?.state !== 'pending') return undefined;
      return resumeRollback({ ...context, ports: { ...context.ports,
        servingProof: async fence => {
          if (options.signal?.aborted) throw new TowerError('unavailable', 'The web observation stopped.');
          const proof = await context.ports.servingProof(fence);
          // Losing the accepted handoff evidence is for the owner to settle. Do not let
          // the executor's safe manual no-effect retry dispatch another handoff here.
          if (options.signal?.aborted) throw new TowerError('unavailable', 'The web observation stopped.');
          if (proof.handoff === 'none') throw new TowerError('unavailable', 'The pending handoff is no longer proven.');
          return proof;
        },
        handoff: async () => { throw new TowerError('unavailable', 'Web observation cannot send another handoff.'); },
      } });
    });
    if (!next) break;
    outcome = next;
  }
  return outcome;
}
