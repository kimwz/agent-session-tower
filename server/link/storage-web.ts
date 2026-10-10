import { offlineBootstrapHeld, readOfflineActivation } from './storage-offline.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { WorkerStorageStatus } from '../../shared/storage.js';
import { captureStorageBundle, preflightStorage, storageBuildContext } from '../storage/index.js';
import { TowerError } from '../../shared/errors.js';
import { evaluateStorageUpdate, readRollbackRecord, resumeRollback, storageHealth, type ServingProof, type RollbackRecord, type RollbackContext, type RollbackOutcome, type RunningBuild, type StorageUpdateEvaluation } from './storage-update.js';

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
  let evaluation = await evaluateStorageUpdate(input);
  try {
    const record = await readOfflineActivation(input.stateDir);
    if (record && await offlineBootstrapHeld(input.stateDir, input.build.preflight.identity)) {
      evaluation = { ...evaluation, verdict: 'recovery-required', code: 'offline-activation-held', reason: 'Offline completion does not bind this installation.', importAllowed: false };
    }
    // Completed evidence never overrides a refused/unknown normal candidate.
  } catch (error) {
    evaluation = { ...evaluation, verdict: 'refused', code: 'offline-record-invalid', reason: String(error), importAllowed: false };
  }
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
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  const stopped = () => Boolean(options.signal?.aborted) || Date.now() >= deadline;
  const stop = () => new TowerError('unavailable', 'The web proof observation stopped.');
  const interval = Math.max(1, options.intervalMs ?? 250);
  let eligible = false;
  let repeat = false;
  const observe = (observationOnly: boolean, previous?: RollbackRecord): RollbackContext => ({ ...context, ports: { ...context.ports,
    servingProof: async fence => {
      repeat = false;
      if (stopped()) throw stop();
      const before = await readRollbackRecord(context.stateDir);
      if (previous) {
        if (before.state !== 'present' || !before.record.attempt || !previous.attempt
          || before.record.attempt.n !== previous.attempt.n + 1
          || before.record.attempt.nonce === previous.attempt.nonce
          || before.record.attempt.pid !== previous.attempt.pid || before.record.attempt.start !== previous.attempt.start
          || !sameObservation({ ...previous, attempt: before.record.attempt }, before.record)) throw stop();
        previous = undefined;
      }
      if (before.state !== 'present' || !sameOperation(record, before.record)
        || before.record.handoff && (fence.id !== before.record.id || fence.attempt !== before.record.handoff.attempt)
        || record.handoff && JSON.stringify(record.handoff.baseline) !== JSON.stringify(before.record.handoff?.baseline)) throw stop();
      if (stopped()) throw stop();
      let pendingObservation = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      try {
        // Bound this read, not the worker or its effects. A late reply cannot complete the rollback.
        const proof = await Promise.race([
          context.ports.servingProof(fence),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(stop()), Math.max(0, deadline - Date.now()));
            abort = () => reject(stop());
            options.signal?.addEventListener('abort', abort, { once: true });
            if (stopped()) reject(stop());
          }),
        ]);
        if (stopped()) throw stop();
        if (before.state === 'present' && before.record.handoff && before.record.state !== 'completed') {
          const current = await readRollbackRecord(context.stateDir);
          if (current.state !== 'present' || !sameObservation(before.record, current.record)) throw stop();
          if (!proofIdentity(before.record, proof)) throw new TowerError('unavailable', 'The handoff proof identity is not proven.');
          if (proof.handoff === 'pending' && record.handoff?.state !== 'unknown') eligible = true;
          repeat = eligible && (proof.handoff === 'pending' || proof.handoff === 'done');
          if (before.record.handoff.state === 'unknown' && proof.handoff === 'pending') {
            // Positive predecessor evidence permits another read, not erasing durable uncertainty.
            pendingObservation = eligible;
            throw new TowerError('unavailable', 'The accepted predecessor still awaits its successor.');
          }
        }
        if (stopped()) throw stop();
        return proof;
      } catch (error) {
        const transition = (error as { proofTransition?: { reason?: string; fence?: { id?: string; attempt?: number } } })?.proofTransition;
        repeat = eligible && !stopped() && (pendingObservation || ['draining', 'socket', 'adopted'].includes(transition?.reason ?? '')
          && transition?.fence?.id === fence.id && transition.fence.attempt === fence.attempt);
        throw error;
      } finally {
        clearTimeout(timer);
        if (abort) options.signal?.removeEventListener('abort', abort);
      }
    },
    releaseAdmission: async fence => { if (stopped()) throw stop(); await context.ports.releaseAdmission(fence); },
    ...(observationOnly || record.handoff ? { handoff: async () => { throw new TowerError('unavailable', 'Web observation cannot send another handoff.'); } } : {}),
  } });
  if (stopped()) return undefined;
  let outcome: RollbackOutcome | undefined = await context.serialize(() => stopped() ? Promise.resolve(undefined) : resumeRollback(observe(false)));
  while (repeat && outcome && 'record' in outcome && outcome.record.state === 'handing-off' && outcome.record.held
    && ['pending', 'unknown'].includes(outcome.record.handoff?.state ?? '') && outcome.record.attempt) {
    const previous = outcome.record;
    if (stopped()) break;
    try { await delay(Math.min(interval, deadline - Date.now()), undefined, { signal: options.signal }); }
    catch (error) { if (options.signal?.aborted) break; throw error; }
    if (stopped()) break;
    // Only steps are serialized. The preceding wait never holds Updates.exclusive.
    const next: RollbackOutcome | undefined = await context.serialize(async () => {
      if (stopped()) return undefined;
      const current = await readRollbackRecord(context.stateDir);
      if (current.state !== 'present' || !sameObservation(previous, current.record)) return undefined;
      return resumeRollback(observe(true, previous));
    });
    if (!next) break;
    outcome = next;
  }
  return outcome;
}

/** Compare the latest returned claim, while permitting only our next resume to renew it. */
function sameObservation(previous: RollbackRecord, current: RollbackRecord): boolean {
  return sameOperation(previous, current) && current.attempt?.nonce === previous.attempt?.nonce
    && current.attempt?.n === previous.attempt?.n && current.attempt?.pid === previous.attempt?.pid
    && current.attempt?.start === previous.attempt?.start && current.handoff?.attempt === previous.handoff?.attempt
    && JSON.stringify(current.handoff?.baseline) === JSON.stringify(previous.handoff?.baseline)
    && current.state === previous.state && current.switched === previous.switched && current.held === previous.held;
}

function sameOperation(previous: RollbackRecord, current: RollbackRecord): boolean {
  return current.id === previous.id && current.target === previous.target && current.from === previous.from
    && current.sourceHash === previous.sourceHash && current.manifestDigest === previous.manifestDigest
    && current.entrySha256 === previous.entrySha256 && current.updateSha256 === previous.updateSha256
    && JSON.stringify(current.storage) === JSON.stringify(previous.storage);
}

/** Pending is not evidence until both worker and storage match the accepted handoff. */
function proofIdentity(record: RollbackRecord, proof: ServingProof): boolean {
  const base = record.handoff!.baseline;
  const worker = proof?.worker;
  const schema = proof?.inspection?.schema;
  if (!worker || !schema || !proof.status || !proof.gate || !['pending', 'done'].includes(proof.handoff)
    || proof.status.state !== 'ready' || worker.protocol !== base.worker.protocol || !Number.isSafeInteger(proof.inspection.ownerEpoch)
    || typeof proof.gate.open !== 'boolean') return false;
  const sameProcess = worker.pid === base.worker.pid && worker.start === base.worker.start;
  const predecessor = sameProcess && Object.entries(base.worker).every(([key, value]) => worker[key as keyof typeof worker] === value);
  const successor = !sameProcess && Number.isSafeInteger(worker.pid) && worker.pid > 0 && typeof worker.start === 'string'
    && worker.version === record.target && worker.sourceHash === record.sourceHash && worker.manifestDigest === record.manifestDigest;
  if (proof.handoff === 'pending' ? !predecessor : !successor) return false;
  const claimed = proof.status.ownerEpoch;
  if (claimed !== undefined && (!Number.isSafeInteger(claimed) || claimed < 1 || claimed !== proof.inspection.ownerEpoch)) return false;
  if (base.storage.kind === 'empty') return schema.kind === 'empty' && proof.inspection.ownerEpoch === 0 && claimed === undefined;
  if (schema.kind !== 'current' || schema.storageId !== base.storage.storageId || !proof.gate.open) return false;
  return predecessor ? claimed === base.ownerEpoch && proof.inspection.ownerEpoch === base.ownerEpoch
    : claimed === undefined ? proof.inspection.ownerEpoch >= base.ownerEpoch : claimed > base.ownerEpoch;
}
