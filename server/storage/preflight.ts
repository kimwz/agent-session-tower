import { Worker } from 'node:worker_threads';
import type { StorageBundleCapture } from './bundle.js';
import { threadOptions } from './client.js';
import {
  STORAGE_PROTOCOL,
  type ProbeResult, type RecoveryHoldSummary, type RuntimeInfo, type StorageBuildIdentity, type StorageBuildManifest, type StorageErrorCode, type StorageErrorPhase,
  type ThreadHello, type ThreadResponse,
} from './contract.js';
import { privateDirectory, StoragePathError, storageFiles, storageLayout } from './paths.js';
import { readRecoveryBarrier, readStorageIdentity, recoverySummary } from './recovery.js';
import { evaluateRuntime } from './runtime.js';
import { storageManifest } from './schema.js';

/**
 * Whether this process could run its storage, decided without opening, restoring, migrating or checkpointing anything:
 * the captured bundle starts on this execPath, agrees with this build's contract, and runs SQLite on an in-memory
 * database. With `stateDir` it also reports the state directory's storage files as they are (lstat and owner-only
 * reads; nothing is created, chmodded or opened by SQLite).
 */
export interface StorageStatePreflight {
  storage: 'absent' | 'present';
  database: 'absent' | 'present';
  sidecars: ('wal' | 'shm')[];
  identity: 'absent' | 'present' | 'invalid';
  recovery: RecoveryHoldSummary;
  problem?: { code: StorageErrorCode; message: string };
}
export interface StoragePreflight {
  supported: boolean;
  refusal?: { phase: StorageErrorPhase; code: StorageErrorCode; message: string };
  identity?: StorageBuildIdentity;
  runtime?: RuntimeInfo;
  probe?: ProbeResult;
  state?: StorageStatePreflight;
}

export async function preflightStorage(options: { bundle: StorageBundleCapture; manifest?: StorageBuildManifest; stateDir?: string; deadlineMs?: number }): Promise<StoragePreflight> {
  const manifest = options.manifest ?? storageManifest();
  const state = options.stateDir === undefined ? undefined : await inspectState(options.stateDir);
  const result = await runtimePreflight(options.bundle, manifest, options.deadlineMs ?? 15_000);
  return { ...result, ...(state ? { state } : {}) };
}

async function runtimePreflight(bundle: StorageBundleCapture, manifest: StorageBuildManifest, deadlineMs: number): Promise<Omit<StoragePreflight, 'state'>> {
  if (!bundle.ok) return { supported: false, refusal: { phase: 'bundle', code: bundle.failure.code, message: bundle.failure.message } };
  const identity: StorageBuildIdentity = { appVersion: manifest.appVersion, protocol: STORAGE_PROTOCOL, sourceHash: bundle.sourceHash, manifestDigest: manifest.digest };
  const refuse = (phase: StorageErrorPhase, code: StorageErrorCode, message: string, runtime?: RuntimeInfo) => ({ supported: false, refusal: { phase, code, message }, identity, ...(runtime ? { runtime } : {}) });
  let worker: Worker;
  try { worker = new Worker(bundle.source, threadOptions()); } catch (error) { return refuse('handshake', 'thread-start-failed', (error as Error).message); }
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
    if (hello.protocol !== STORAGE_PROTOCOL) return refuse('handshake', 'protocol-mismatch', `The storage thread speaks ${hello.protocol}.`, hello.runtime);
    if (hello.appVersion !== manifest.appVersion) return refuse('handshake', 'app-version-mismatch', `The storage thread is from ${hello.appVersion}.`, hello.runtime);
    if (hello.manifest?.digest !== manifest.digest) return refuse('handshake', 'schema-contract-mismatch', 'The storage thread declares another schema contract.', hello.runtime);
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

async function inspectState(stateDir: string): Promise<StorageStatePreflight> {
  const report: StorageStatePreflight = { storage: 'absent', database: 'absent', sidecars: [], identity: 'absent', recovery: { state: 'clear' } };
  try {
    const layout = await storageLayout(stateDir);
    report.identity = (await readStorageIdentity(layout)).state;
    report.recovery = recoverySummary(await readRecoveryBarrier(layout));
    if (!(await privateDirectory(layout.storageDir, false))) return report;
    report.storage = 'present';
    const files = await storageFiles(layout);
    if (files.database) report.database = 'present';
    if (files.wal) report.sidecars.push('wal');
    if (files.shm) report.sidecars.push('shm');
  } catch (error) {
    report.problem = { code: error instanceof StoragePathError ? error.code : 'io-error', message: error instanceof Error ? error.message : String(error) };
  }
  return report;
}
