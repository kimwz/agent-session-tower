import { Worker } from 'node:worker_threads';
import { helloRefusal, storageBuildContext, type CapturedStorageBundle, type StorageBuildContext, type StorageBundleCapture } from './bundle.js';
import { threadOptions } from './client.js';
import type { ProbeResult, RecoveryHoldSummary, RuntimeInfo, StorageBuildIdentity, StorageErrorCode, StorageErrorPhase, ThreadHello, ThreadResponse } from './contract.js';
import { StoragePathError, storageFiles, storageLayout } from './paths.js';
import { readRecoveryBarrier, readStorageIdentity, recoverySummary } from './recovery.js';
import { evaluateRuntime } from './runtime.js';

/**
 * Whether this process could run its storage, decided without opening, restoring, migrating or checkpointing anything:
 * the captured bundle is a source this build trusts, starts on this execPath, declares exactly the contract this build
 * binds to that source, and runs SQLite on an in-memory database. With `stateDir` it also reports the state
 * directory's storage files as they are (lstat and owner-only reads; nothing is created, synced, chmodded or opened by
 * SQLite).
 */
export interface StorageStatePreflight {
  database: 'absent' | 'present';
  sidecars: ('wal' | 'shm')[];
  /** `creating`: a storage may have been created here and its creation was not confirmed; it is not replaced either. */
  identity: 'absent' | 'creating' | 'created' | 'invalid';
  recovery: RecoveryHoldSummary;
  /** A path or file this state directory fails; openStorage would refuse it. */
  problem?: { code: StorageErrorCode; message: string };
}
export interface StoragePreflight {
  /**
   * The runtime verdict only: bundle, handshake, runtime gate and in-memory probe. It does not judge the state
   * directory or the live database: a caller deciding readiness also checks `state.problem`, `state.identity` (with
   * the database and sidecars) and `state.recovery`, and the storage's schema is known only when it is opened and
   * prepared (openStorage refuses an unknown schema; gate() is the readiness).
   */
  supported: boolean;
  refusal?: { phase: StorageErrorPhase; code: StorageErrorCode; message: string };
  identity?: StorageBuildIdentity;
  runtime?: RuntimeInfo;
  probe?: ProbeResult;
  state?: StorageStatePreflight;
}

export async function preflightStorage(options: { bundle: StorageBundleCapture; stateDir?: string; deadlineMs?: number }): Promise<StoragePreflight> {
  const context = storageBuildContext(options.bundle);
  const state = options.stateDir === undefined ? undefined : await inspectState(options.stateDir, context.ok ? context : undefined);
  const result = context.ok
    // A trusted context means the bundle was captured and its text checked.
    ? await runtimePreflight((options.bundle as CapturedStorageBundle).source, context, options.deadlineMs ?? 15_000)
    : { supported: false, refusal: { phase: 'bundle' as const, code: context.failure.code, message: context.failure.message } };
  return { ...result, ...(state ? { state } : {}) };
}

async function runtimePreflight(source: string, context: StorageBuildContext, deadlineMs: number): Promise<Omit<StoragePreflight, 'state'>> {
  const identity: StorageBuildIdentity = { ...context.identity };
  const refuse = (phase: StorageErrorPhase, code: StorageErrorCode, message: string, runtime?: RuntimeInfo) => ({ supported: false, refusal: { phase, code, message }, identity, ...(runtime ? { runtime } : {}) });
  let worker: Worker;
  try { worker = new Worker(source, threadOptions()); } catch (error) { return refuse('handshake', 'thread-start-failed', (error as Error).message); }
  let lastError: string | undefined;
  worker.on('error', error => { lastError = error instanceof Error ? error.message : String(error); });
  const messages: unknown[] = [];
  let wake: (() => void) | undefined;
  let exited = false;
  worker.on('message', message => { messages.push(message); wake?.(); });
  const exit = new Promise<void>(resolve => worker.once('exit', () => { exited = true; wake?.(); resolve(); }));
  const deadline = Date.now() + deadlineMs;
  const next = async (): Promise<unknown> => {
    while (!messages.length) {
      if (exited) return undefined;
      const left = deadline - Date.now();
      if (left <= 0) return 'timeout';
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, left); wake = () => { clearTimeout(timer); resolve(); }; });
      wake = undefined;
    }
    return messages.shift();
  };
  try {
    const hello = await next() as ThreadHello | 'timeout' | undefined;
    if (hello === 'timeout') return refuse('handshake', 'handshake-timeout', 'The storage thread did not say hello in time.');
    if (!hello || hello.type !== 'hello') return refuse('handshake', 'thread-start-failed', `The storage thread ended before its handshake${lastError ? `: ${lastError}` : ''}.`);
    const refusal = helloRefusal(hello, context);
    if (refusal) return refuse('handshake', refusal.code, refusal.message, hello.runtime);
    const verdict = evaluateRuntime(hello.runtime, hello.runtimeError);
    if (!verdict.supported) return refuse('runtime', 'unsupported-runtime', verdict.reason, hello.runtime);
    worker.postMessage({ id: 1, op: 'probe' });
    const answer = await next() as ThreadResponse | 'timeout' | undefined;
    if (answer === 'timeout') return refuse('deadline', 'deadline-exceeded', 'The storage thread did not finish its probe in time.', hello.runtime);
    if (!answer || answer.type !== 'result' || answer.id !== 1) return refuse('thread-exit', 'thread-exited', `The storage thread stopped during its probe${lastError ? `: ${lastError}` : ''}.`, hello.runtime);
    if (!answer.ok) return refuse('runtime', answer.error.code, answer.error.message, hello.runtime);
    const probe = answer.value as ProbeResult;
    if (!probe.foreignKeysEnforced || probe.trustedSchema !== 0 || !probe.transactionRollback || probe.preparedRows !== 50) {
      return { ...refuse('runtime', 'pragma-mismatch', `SQLite did not behave as the storage needs: ${JSON.stringify(probe)}.`, hello.runtime), probe };
    }
    return { supported: true, identity, runtime: hello.runtime, probe };
  } finally {
    if (!exited) { worker.postMessage({ id: 2, op: 'close' }); await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 2000).unref())]); }
    if (!exited) await worker.terminate();
  }
}

async function inspectState(stateDir: string, context: StorageBuildContext | undefined): Promise<StorageStatePreflight> {
  const report: StorageStatePreflight = { database: 'absent', sidecars: [], identity: 'absent', recovery: { state: 'clear' } };
  try {
    const layout = await storageLayout(stateDir);
    const identity = await readStorageIdentity(layout);
    report.identity = identity.state === 'present' ? identity.identity.state : identity.state;
    // Without a trusted contract a present barrier is summarised as held: recoverySummary does not judge it.
    report.recovery = recoverySummary(await readRecoveryBarrier(layout), context);
    const files = await storageFiles(layout);
    if (files.database) report.database = 'present';
    if (files.wal) report.sidecars.push('wal');
    if (files.shm) report.sidecars.push('shm');
  } catch (error) {
    report.problem = { code: error instanceof StoragePathError ? error.code : 'io-error', message: error instanceof Error ? error.message : String(error) };
  }
  return report;
}
