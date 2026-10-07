import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import { verifyCapturedBundle, type StorageBundleCapture } from './bundle.js';
import {
  STORAGE_PROTOCOL, StorageCommandError, storageLimits,
  type CommitDisposition, type OpenResult, type PrepareResult, type PrepareThreadResult, type ReceiptLookup, type RecoveryHoldSummary, type RuntimeInfo,
  type SchemaState, type SnapshotThreadResult, type StorageBuildIdentity, type StorageBuildManifest, type StorageErrorCode, type StorageErrorPhase,
  type StorageExpectation, type StorageFailure, type StorageInspection, type StorageLimits, type StorageState, type StorageStatus, type ThreadHello,
  type ThreadRequest, type ThreadResponse, type WriteResult,
} from './contract.js';
import { createPrivateFile, pathError, sameFile, sameStorageFiles, STORAGE_DATABASE_NAME, StoragePathError, storageFiles, storageLayout, type StorageFiles, type StorageLayout } from './paths.js';
import { discardSnapshot, readRecoveryBarrier, readStorageIdentity, recordStorageIdentity, recoveryHold, recoverySummary, sealSnapshot, snapshotTarget, StorageRecoveryError, type SnapshotManifest } from './recovery.js';
import { evaluateRuntime } from './runtime.js';
import { storageManifest } from './schema.js';

/**
 * The execution worker's handle on its storage thread. One client owns one thread and one connection; commands go one
 * at a time in arrival order, within the chosen bounds. A failure (handshake, runtime, paths, schema, a thread that
 * exits, a missed deadline) leaves the client `unavailable` with the reason: it never respawns the thread, never opens
 * an empty database in place of a missing one, and never says a write it lost track of was not committed.
 * `reopen()` is the explicit retry, with the same captured bundle; it does not claim the storage again, `prepare()` does.
 */
export interface StorageClientOptions {
  stateDir: string;
  /** captureStorageBundle()'s answer, taken once when the worker started. */
  bundle: StorageBundleCapture;
  /** The contract this build expects the thread to report. Defaults to this build's domains. */
  manifest?: StorageBuildManifest;
  limits?: Partial<StorageLimits>;
  /** Called on every change to `unavailable`, a failed first open included, so the worker can hold durable intake. */
  onUnavailable?: (status: StorageStatus) => void;
}
export interface StorageGate { open: boolean; reasons: string[] }
/** `closed`: the thread answered the close after every earlier command and exited (`exitCode`, 0 when it ended on its own). */
export interface CloseResult { ack: 'closed' | 'already-closed' | 'thread-exited'; status: StorageStatus; exitCode?: number }

type Kind = 'read' | 'write' | 'control';
interface Pending {
  id: number; request: ThreadRequest; kind: Kind; phase: StorageErrorPhase; deadlineMs: number; commandId?: string;
  settled: Promise<unknown>; resolve(value: unknown): void; reject(error: StorageCommandError): void; timer?: NodeJS.Timeout;
}
interface ThreadHandle { worker: Worker; expected: boolean; exitCode?: number; lastError?: string; exited: Promise<number>; hello: Promise<ThreadHello | undefined> }

const now = () => new Date().toISOString();
/** Waits for a thread to end, keeping the process alive meanwhile (an idle thread is unreferenced). */
const gone = (thread: ThreadHandle) => { thread.worker.ref(); return thread.exited; };
/**
 * The thread is a plain CommonJS script with its own settings: it does not inherit the worker's execArgv (loaders such
 * as tsx, --input-type, --import), which could change how its text is evaluated.
 */
export const threadOptions = (): WorkerOptions => ({ eval: true, execArgv: [] });
const isHello = (message: unknown): message is ThreadHello => !!message && (message as ThreadHello).type === 'hello';
/** Control barriers wait behind the bounded queue instead of counting against it, so a full queue can still drain. */
const isBarrier = (request: ThreadRequest) => request.op === 'flush' || request.op === 'close';

function failureOf(phase: StorageErrorPhase, code: StorageErrorCode, message: string, retryable: boolean, extra: Partial<StorageFailure> = {}): StorageFailure {
  return { phase, code, message, retryable, sourcePreserved: true, at: now(), ...extra };
}
const SCHEMA_CODES = new Set<StorageErrorCode>(['unknown-schema', 'foreign-database', 'database-missing', 'storage-replaced']);
const RECOVERY_CODES = new Set<StorageErrorCode>(['recovery-in-progress', 'recovery-invalid']);
const fileError = (error: unknown) => error instanceof StoragePathError || error instanceof StorageRecoveryError
  ? { code: error.code, retryable: error.retryable, message: error.message }
  : { code: 'io-error' as const, retryable: true, message: error instanceof Error ? error.message : String(error) };

export async function openStorage(options: StorageClientOptions): Promise<StorageClient> {
  const client = new StorageClient(options);
  await client.reopen();
  return client;
}

export class StorageClient {
  readonly #options: StorageClientOptions;
  readonly #manifest: StorageBuildManifest;
  readonly #limits: StorageLimits;
  #state: StorageState = 'closed';
  #failure?: StorageFailure;
  #thread?: ThreadHandle;
  #queue: Pending[] = [];
  #inflight?: Pending;
  #nextId = 1;
  #schema?: SchemaState;
  #ownerEpoch?: number;
  #runtime?: RuntimeInfo;
  #recovery?: RecoveryHoldSummary;
  #layout?: StorageLayout;
  #transition: Promise<unknown> = Promise.resolve();

  /** Use openStorage(). Limits outside their ranges throw here. */
  constructor(options: StorageClientOptions) {
    this.#options = options;
    this.#limits = storageLimits(options.limits);
    this.#manifest = options.manifest ?? storageManifest();
  }

  get identity(): StorageBuildIdentity | undefined {
    const { bundle } = this.#options;
    return bundle.ok ? { appVersion: this.#manifest.appVersion, protocol: STORAGE_PROTOCOL, sourceHash: bundle.sourceHash, manifestDigest: this.#manifest.digest } : undefined;
  }

  status(): StorageStatus {
    return structuredClone({
      state: this.#state, pending: this.#queue.length + (this.#inflight ? 1 : 0),
      ...(this.identity ? { identity: this.identity } : {}), ...(this.#runtime ? { runtime: this.#runtime } : {}), ...(this.#schema ? { schema: this.#schema } : {}),
      ...(this.#ownerEpoch !== undefined ? { ownerEpoch: this.#ownerEpoch } : {}), ...(this.#failure ? { failure: this.#failure } : {}), ...(this.#recovery ? { recovery: this.#recovery } : {}),
    });
  }

  /**
   * Whether durable work of `scope` (`core` or a domain) may go ahead now: the storage is ready and claimed by this
   * worker (prepare() succeeded since the last open), and no recovery barrier holds the scope. Reads the barrier fresh.
   */
  async gate(scope: string): Promise<StorageGate> {
    const reasons: string[] = [];
    if (this.#state !== 'ready') reasons.push(this.#failure ? `Storage is unavailable: ${this.#failure.message}` : `Storage is ${this.#state}.`);
    else if (this.#ownerEpoch === undefined) reasons.push('Storage is open but not prepared by this worker.');
    const read = await readRecoveryBarrier(this.#layout ?? this.#options.stateDir);
    this.#recovery = recoverySummary(read);
    const hold = recoveryHold(read, scope);
    if (hold.held) reasons.push(hold.reason!);
    return { open: !reasons.length, reasons };
  }

  /** Opens the storage: the first time, after close(), or as the explicit retry of an unavailable one. Claims nothing. */
  reopen(): Promise<StorageStatus> {
    return this.#serial(async () => {
      if (this.#state === 'ready') throw new StorageCommandError({ phase: 'open', code: 'invalid-command', message: 'The storage is already open.', disposition: 'not-committed', retryable: false });
      // A failed thread was terminated, not replaced; wait until it is gone so two connections never overlap.
      if (this.#thread) await gone(this.#thread);
      this.#thread = undefined;
      return this.#open();
    });
  }

  /**
   * Closes intake, lets every command sent before it finish (a full queue included), then the thread closes its
   * connection, answers and exits.
   */
  close(): Promise<CloseResult> {
    return this.#serial(async () => {
      if (this.#state === 'closed') return { ack: 'already-closed' as const, status: this.status() };
      const thread = this.#thread;
      if (this.#state !== 'ready' || !thread) {
        if (thread) { thread.expected = true; if (thread.exitCode === undefined) void thread.worker.terminate(); await gone(thread); }
        return { ack: 'thread-exited' as const, status: this.status(), ...(thread?.exitCode !== undefined ? { exitCode: thread.exitCode } : {}) };
      }
      this.#state = 'closing';
      try {
        await this.#send({ id: 0, op: 'close' }, 'control', 'close', this.#limits.commandDeadlineMs);
        thread.expected = true;
        const exitCode = await gone(thread);
        this.#state = 'closed';
        this.#ownerEpoch = undefined;
        return { ack: 'closed' as const, status: this.status(), exitCode };
      } catch (error) {
        if (!this.#unavailable()) this.#fail(failureOf('close', (error as StorageCommandError).code ?? 'sqlite-error', (error as Error).message, true));
        const exitCode = await gone(thread);
        return { ack: 'thread-exited' as const, status: this.status(), exitCode };
      }
    });
  }

  /** Waits until every command sent before it has finished in the thread. Never refused for a full queue. */
  async flush(): Promise<void> {
    await this.#send({ id: 0, op: 'flush' }, 'control', 'command', this.#limits.commandDeadlineMs);
  }

  inspect(): Promise<StorageInspection> {
    return this.#send({ id: 0, op: 'inspect' }, 'read', 'command', this.#limits.commandDeadlineMs) as Promise<StorageInspection>;
  }

  /**
   * Claims the storage for this worker (a new owner epoch) and, only with `allowMigration`, applies this build's
   * pending schema changes in the same transaction. The worker allows migration only after its update, compatibility
   * and migration-lock checks; without it a storage that needs changes is refused unchanged.
   *
   * The claim is published (gate/write) only once the storage identity beside the database durably names this
   * storage: creating a storage records it as `creating` first and `created` after the commit. A failed identity
   * record leaves the storage unavailable; when the prepare had already committed, the error says `committed`.
   */
  async prepare(input: { allowMigration: boolean; commandId?: string }): Promise<PrepareResult> {
    const commandId = input.commandId ?? `prepare-${randomUUID()}`;
    const layout = this.#layout;
    const schema = this.#schema;
    if (this.#state !== 'ready' || !layout || !schema) throw this.#refusal('prepare', commandId);
    let storageId: string;
    if (schema.kind === 'empty') {
      if (!input.allowMigration) throw new StorageCommandError({ phase: 'prepare', code: 'migration-required', message: 'The storage is empty; creating it is a schema change this start may not make.', disposition: 'not-committed', retryable: false, commandId });
      try { storageId = await this.#identityForCreation(layout); } catch (error) {
        throw this.#failAfter(error, 'not-committed', commandId, 'The storage identity could not be recorded before creating the storage');
      }
    } else storageId = schema.storageId;
    const result = await this.#send({ id: 0, op: 'prepare', commandId, allowMigration: input.allowMigration, storageId }, 'write', 'prepare', this.#limits.commandDeadlineMs, commandId) as PrepareThreadResult;
    this.#schema = result.schema;
    // The commit is durable from here on: a failure below never says otherwise.
    try {
      if (result.schema.kind === 'empty') throw new StoragePathError('database-missing', 'The prepare committed, yet the database reads as empty.');
      await this.#recordCreated(layout, result.schema.storageId);
    } catch (error) {
      throw this.#failAfter(error, 'committed', commandId, 'The prepare committed, but the storage identity could not be recorded, so this worker does not claim the storage');
    }
    if (this.#state !== 'ready') throw this.#refusal('prepare', commandId, 'committed');
    if (result.claimed) this.#ownerEpoch = result.ownerEpoch;
    return { ownerEpoch: result.ownerEpoch, applied: result.applied, schema: result.schema, created: result.created, replayed: result.replayed };
  }

  /** Whether a command ID committed. The way to settle an `unknown` disposition, after reopen if need be. */
  receipt(commandId: string): Promise<ReceiptLookup> {
    return this.#send({ id: 0, op: 'receipt', commandId }, 'read', 'command', this.#limits.commandDeadlineMs) as Promise<ReceiptLookup>;
  }

  /** A registered domain read command. */
  async read<T = unknown>(domain: string, command: string, payload: unknown): Promise<T> {
    const text = this.#payload(payload);
    const value = await this.#send({ id: 0, op: 'read', domain, command, payload: text }, 'read', 'command', this.#limits.commandDeadlineMs) as { result: T };
    return value.result;
  }

  /** A registered domain write command, committed once per command ID with its receipt. */
  async write<T = unknown>(domain: string, command: string, payload: unknown, commandId: string): Promise<WriteResult<T>> {
    const text = this.#payload(payload, commandId);
    if (this.#ownerEpoch === undefined && this.#state === 'ready') throw new StorageCommandError({ phase: 'command', code: 'not-prepared', message: 'The storage was not prepared by this worker.', disposition: 'not-committed', retryable: false, commandId });
    // Not ready: #send refuses with the storage's own state or failure.
    const value = await this.#send({ id: 0, op: 'write', domain, command, payload: text, commandId, ownerEpoch: this.#ownerEpoch ?? 0 }, 'write', 'command', this.#limits.commandDeadlineMs, commandId) as { result: T; replayed: boolean };
    return { disposition: 'committed', result: value.result, replayed: value.replayed, commandId };
  }

  /**
   * A consistent copy of the database (WAL included) in a new private snapshot folder, checked, synced and described
   * by its manifest. Snapshots stay out of the settings backup.
   */
  async snapshot(): Promise<SnapshotManifest> {
    const layout = this.#layout;
    const schema = this.#schema;
    if (this.#state !== 'ready' || !layout || !schema || schema.kind === 'empty') {
      throw new StorageCommandError({ phase: 'snapshot', code: this.#state === 'ready' ? 'not-prepared' : 'not-ready', message: 'Only an open, prepared storage can be copied.', disposition: 'not-committed', retryable: false });
    }
    let target;
    try { target = await snapshotTarget(layout); } catch (error) { throw this.#asCommandError(error, 'snapshot'); }
    try {
      const result = await this.#send({ id: 0, op: 'snapshot', target: target.target }, 'control', 'snapshot', this.#limits.snapshotDeadlineMs) as SnapshotThreadResult;
      return await sealSnapshot(target, { build: this.identity!, storageId: schema.storageId, result });
    } catch (error) {
      await discardSnapshot(target).catch(() => {}); // best-effort: only this unfinished folder; the snapshot error below is the one reported
      throw this.#asCommandError(error, 'snapshot');
    }
  }

  // ---- internals ----

  /** Read through a method: the state changes from thread events while an await is pending. */
  #unavailable(): boolean { return this.#state === 'unavailable'; }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#transition.then(work, work);
    this.#transition = run.catch(() => {}); // best-effort: the caller gets the error from run; this chain only keeps the order
    return run;
  }

  /** The error for a command the storage cannot take in its current state. */
  #refusal(phase: StorageErrorPhase, commandId?: string, disposition: CommitDisposition = 'not-committed'): StorageCommandError {
    const code: StorageErrorCode = this.#state === 'unavailable' ? this.#failure?.code ?? 'not-ready' : 'not-ready';
    return new StorageCommandError({ phase, code, message: this.#failure ? `Storage is unavailable: ${this.#failure.message}` : `Storage is ${this.#state}.`, disposition, retryable: this.#failure?.retryable ?? true, commandId });
  }

  /** A file failure around a prepare: the storage becomes unavailable (intake holds), and the error keeps the commit's disposition. */
  #failAfter(error: unknown, disposition: CommitDisposition, commandId: string, context: string): StorageCommandError {
    if (error instanceof StorageCommandError) return error;
    const { code, retryable, message } = fileError(error);
    const text = `${context}: ${message}`;
    if (!this.#unavailable()) this.#fail(failureOf('prepare', code, text, retryable));
    return new StorageCommandError({ phase: 'prepare', code, message: text, disposition, retryable, commandId });
  }

  /** The storage ID a creating prepare uses: one already recorded as `creating`, or a new one recorded (synced) now. */
  async #identityForCreation(layout: StorageLayout): Promise<string> {
    const recorded = await readStorageIdentity(layout);
    if (recorded.state === 'invalid') throw new StoragePathError('recovery-invalid', `The storage identity cannot be read: ${recorded.reason}`);
    if (recorded.state === 'present') {
      if (recorded.identity.state !== 'creating') throw new StoragePathError('recovery-invalid', 'The storage identity says the storage was created, yet the database is empty.');
      return recorded.identity.storageId;
    }
    const storageId = randomUUID();
    await recordStorageIdentity(layout, storageId, 'creating');
    return storageId;
  }

  /** Makes the identity beside the database say `created` for `storageId`. Throws when it cannot, or names another storage. */
  async #recordCreated(layout: StorageLayout, storageId: string): Promise<void> {
    const recorded = await readStorageIdentity(layout);
    if (recorded.state === 'invalid') throw new StoragePathError('recovery-invalid', `The storage identity cannot be read: ${recorded.reason}`);
    if (recorded.state === 'present') {
      if (recorded.identity.storageId !== storageId) throw new StoragePathError('storage-replaced', 'The storage identity names another storage than the database holds.');
      if (recorded.identity.state === 'created') return;
    }
    await recordStorageIdentity(layout, storageId, 'created');
  }

  #payload(payload: unknown, commandId?: string): string {
    let text: string | undefined;
    try { text = JSON.stringify(payload === undefined ? null : payload); } catch (error) {
      throw new StorageCommandError({ phase: 'command', code: 'invalid-command', message: `The payload cannot be serialized as JSON: ${(error as Error).message}`, disposition: 'not-committed', retryable: false, commandId });
    }
    if (typeof text !== 'string') throw new StorageCommandError({ phase: 'command', code: 'invalid-command', message: 'The payload cannot be serialized as JSON.', disposition: 'not-committed', retryable: false, commandId });
    if (Buffer.byteLength(text) > this.#limits.maxPayloadBytes) throw new StorageCommandError({ phase: 'command', code: 'payload-too-large', message: `The payload is larger than ${this.#limits.maxPayloadBytes} bytes.`, disposition: 'not-committed', retryable: false, commandId });
    return text;
  }

  #asCommandError(error: unknown, phase: StorageErrorPhase): StorageCommandError {
    if (error instanceof StorageCommandError) return error;
    const { code, retryable, message } = fileError(error);
    return new StorageCommandError({ phase, code, message, disposition: 'not-committed', retryable });
  }

  async #open(): Promise<StorageStatus> {
    this.#state = 'opening';
    this.#failure = undefined; this.#schema = undefined; this.#ownerEpoch = undefined; this.#runtime = undefined;
    const { bundle } = this.#options;
    if (!bundle.ok) return this.#fail({ ...bundle.failure, at: now() });
    const untrusted = verifyCapturedBundle(bundle);
    if (untrusted) return this.#fail({ ...untrusted.failure, at: now() });

    let thread: ThreadHandle;
    try { thread = this.#spawn(bundle.source); } catch (error) { return this.#fail(failureOf('handshake', 'thread-start-failed', `The storage thread could not start: ${(error as Error).message}`, true)); }
    let timer: NodeJS.Timeout | undefined;
    const hello = await Promise.race([thread.hello, new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), this.#limits.handshakeDeadlineMs); })]);
    clearTimeout(timer);
    if (hello === 'timeout') return this.#fail(failureOf('handshake', 'handshake-timeout', 'The storage thread did not say hello in time.', true));
    if (!hello) return this.#fail(failureOf('handshake', 'thread-start-failed', `The storage thread ended before its handshake${thread.lastError ? `: ${thread.lastError}` : ''}.`, false));
    this.#runtime = hello.runtime;
    // Nothing has touched a file yet. A thread from another build, protocol, schema contract or source stops here.
    if (hello.protocol !== STORAGE_PROTOCOL) return this.#fail(failureOf('handshake', 'protocol-mismatch', `The storage thread speaks ${hello.protocol}, this worker ${STORAGE_PROTOCOL}.`, false));
    if (hello.appVersion !== this.#manifest.appVersion) return this.#fail(failureOf('handshake', 'app-version-mismatch', `The storage thread is from ${hello.appVersion}, this worker from ${this.#manifest.appVersion}.`, false));
    if (hello.manifest?.digest !== this.#manifest.digest) return this.#fail(failureOf('handshake', 'schema-contract-mismatch', 'The storage thread declares another schema contract than this worker.', false));
    if (hello.sourceHash !== bundle.sourceHash) return this.#fail(failureOf('handshake', 'source-hash-mismatch', `The storage thread runs source ${hello.sourceHash ? `${hello.sourceHash.slice(0, 12)}…` : 'without a stated hash'}; this worker expects ${bundle.sourceHash.slice(0, 12)}….`, false));
    const verdict = evaluateRuntime(hello.runtime, hello.runtimeError);
    if (!verdict.supported) return this.#fail(failureOf('runtime', 'unsupported-runtime', verdict.reason, false));

    let layout: StorageLayout;
    let before: StorageFiles;
    let expected: StorageExpectation | undefined;
    let created = false;
    try {
      layout = this.#layout = await storageLayout(this.#options.stateDir);
      const barrier = await readRecoveryBarrier(layout);
      this.#recovery = recoverySummary(barrier);
      if (barrier.state === 'present' && barrier.barrier.state === 'recorded') throw new StoragePathError('recovery-in-progress', `Snapshot recovery ${barrier.barrier.id} has not finished; retry or complete it before opening.`);
      const identity = await readStorageIdentity(layout);
      if (identity.state === 'invalid') throw new StoragePathError('recovery-invalid', `The storage identity cannot be read: ${identity.reason}`);
      if (identity.state === 'present') expected = { storageId: identity.identity.storageId, created: identity.identity.state === 'created' };
      before = await storageFiles(layout);
      if (!before.database) {
        // A missing database is new only where no storage was ever recorded, not even as being created, and no sidecar is left.
        if (expected || before.wal || before.shm) throw new StoragePathError('database-missing', `${layout.database} is missing; the storage recorded here is not replaced by an empty one.`);
        before.database = await createPrivateFile(layout.database);
        created = true;
      }
    } catch (error) {
      if (this.#unavailable()) return this.status();
      const { code, retryable, message } = fileError(error);
      return this.#fail(failureOf(RECOVERY_CODES.has(code) ? 'recovery' : 'paths', code, message, retryable));
    }
    // The thread may have ended while the paths were checked; its failure stands.
    if (this.#unavailable()) return this.status();

    // A WAL or shm means a connection ended without closing: opening the live files could recover, checkpoint and
    // remove them before the schema is known. Such a database is first checked as a private copy.
    if (!created && (before.wal || before.shm)) {
      try { await this.#checkCopy(layout, before, expected); } catch (error) {
        if (this.#unavailable()) return this.status();
        if (error instanceof StorageCommandError) return this.#fail(failureOf(SCHEMA_CODES.has(error.code) ? 'schema' : 'open', error.code, error.message, error.retryable));
        const { code, retryable, message } = fileError(error);
        return this.#fail(failureOf('open', code, message, retryable));
      }
    }

    // Without sidecars there is nothing to recover or checkpoint: the thread reads the schema before its first write
    // and closes on a refusal. Whether the files really stayed as they were is checked, not assumed.
    let opened: OpenResult;
    try {
      opened = await this.#send({ id: 0, op: 'open', open: { path: layout.database, busyTimeoutMs: this.#limits.busyTimeoutMs, maxResultBytes: this.#limits.maxResultBytes, identity: this.identity!, ...(expected ? { expected } : {}) } }, 'control', 'open', this.#limits.handshakeDeadlineMs) as OpenResult;
    } catch (error) {
      if (this.#unavailable()) return this.status();
      const commandError = error as StorageCommandError;
      // best-effort: files that can no longer be checked are reported as not preserved; the refusal itself is what is reported
      const sourcePreserved = await storageFiles(layout).then(after => sameStorageFiles(before, after), () => false);
      return this.#fail(failureOf(SCHEMA_CODES.has(commandError.code) ? 'schema' : 'open', commandError.code, commandError.message, commandError.retryable, { sourcePreserved }));
    }

    try {
      // The file SQLite opened is the one checked before, and the sidecars it made are private.
      const after = await storageFiles(layout);
      if (!after.database || !sameFile(after.database, before.database!)) throw new StoragePathError('path-changed', `${layout.database} changed while it was opened.`);
      // A storage found without its identity (or still marked as being created) is named now, before anything may claim it.
      if (opened.schema.kind !== 'empty') await this.#recordCreated(layout, opened.schema.storageId);
    } catch (error) {
      if (this.#unavailable()) return this.status();
      // best-effort: the path failure is what is reported, and #fail ends the thread either way
      await this.#send({ id: 0, op: 'close' }, 'control', 'close', this.#limits.commandDeadlineMs).catch(() => {});
      const { code, retryable, message } = fileError(error);
      return this.#fail(failureOf('paths', code, message, retryable));
    }
    this.#schema = opened.schema;
    this.#state = 'ready';
    return this.status();
  }

  /**
   * Decides whether the live files may be opened without opening them: a private copy of the database and its WAL is
   * checked by the thread, which may recover and checkpoint the copy only. The live database, WAL and shm must be the
   * same files, unchanged, before and after. The copy costs the database's size in time and free space (a clone only
   * where libuv clones, such as Linux reflink file systems). Throws the refusal.
   */
  async #checkCopy(layout: StorageLayout, before: StorageFiles, expected: StorageExpectation | undefined): Promise<void> {
    let dir: string;
    try { dir = await mkdtemp(join(layout.stateDir, '.storage-check-')); } catch (error) { throw pathError(error, layout.stateDir); }
    try {
      const copy = join(dir, STORAGE_DATABASE_NAME);
      try {
        await copyFile(layout.database, copy, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
        if (before.wal) await copyFile(layout.wal, `${copy}-wal`, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      } catch (error) { throw pathError(error, layout.database); }
      const unchanged = async () => {
        if (!sameStorageFiles(before, await storageFiles(layout))) throw new StoragePathError('source-changed', `${layout.database} changed while it was checked; another process may be using it.`, true);
      };
      await unchanged();
      await this.#send({ id: 0, op: 'check', check: { path: copy, busyTimeoutMs: this.#limits.busyTimeoutMs, ...(expected ? { expected } : {}) } }, 'control', 'open', this.#limits.handshakeDeadlineMs);
      await unchanged();
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {}); // best-effort: a private copy left in the owner-only state directory, named .storage-check-*
    }
  }

  #spawn(source: string): ThreadHandle {
    // Eval: the thread runs the captured text, never a file that a later build may have replaced.
    const worker = new Worker(source, threadOptions());
    // Referenced only while a command waits, so an idle open storage does not keep the process alive by itself.
    worker.unref();
    let greet!: (hello: ThreadHello | undefined) => void;
    const handle: ThreadHandle = { worker, expected: false, hello: new Promise(resolve => { greet = resolve; }), exited: undefined! };
    handle.exited = new Promise(resolve => worker.once('exit', code => {
      handle.exitCode = code;
      greet(undefined);
      resolve(code);
      if (handle === this.#thread && !handle.expected) {
        this.#fail(failureOf('thread-exit', 'thread-exited', `The storage thread exited with code ${code}${handle.lastError ? `: ${handle.lastError}` : ''}.`, true));
      }
    }));
    let greeted = false;
    worker.on('message', (message: unknown) => {
      if (!greeted) { greeted = true; greet(isHello(message) ? message : undefined); return; }
      this.#answer(handle, message as ThreadResponse);
    });
    worker.on('error', error => { handle.lastError = error instanceof Error ? error.message : String(error); });
    worker.on('messageerror', error => {
      handle.lastError = error.message;
      if (handle === this.#thread) this.#fail(failureOf('command', 'invalid-command', `A storage answer could not be read: ${error.message}`, true));
    });
    this.#thread = handle;
    return handle;
  }

  /**
   * Queues a request. Commands count against maxQueue; flush and close barriers do not, so a full queue still drains
   * and closes. They stay bounded: a flush right behind another flush shares its answer, and one close runs at a time.
   */
  #send(request: ThreadRequest, kind: Kind, phase: StorageErrorPhase, deadlineMs: number, commandId?: string): Promise<unknown> {
    const allowed = this.#state === 'ready' || (this.#state === 'opening' && (request.op === 'open' || request.op === 'check' || request.op === 'close'))
      || (this.#state === 'closing' && request.op === 'close');
    if (!allowed) return Promise.reject(this.#refusal(phase, commandId));
    if (!isBarrier(request) && this.#queue.filter(entry => !isBarrier(entry.request)).length + (this.#inflight && !isBarrier(this.#inflight.request) ? 1 : 0) >= this.#limits.maxQueue) {
      return Promise.reject(new StorageCommandError({ phase, code: 'queue-full', message: `The storage queue holds ${this.#limits.maxQueue} commands already.`, disposition: 'not-committed', retryable: true, commandId }));
    }
    const last = this.#queue.at(-1);
    if (request.op === 'flush' && last?.request.op === 'flush') return last.settled;
    let pending!: Pending;
    const settled = new Promise((resolve, reject) => {
      pending = { id: this.#nextId++, request, kind, phase, deadlineMs, commandId, settled: undefined!, resolve, reject };
    });
    pending.settled = settled;
    this.#queue.push(pending);
    this.#pump();
    return settled;
  }

  #pump(): void {
    const thread = this.#thread;
    if (this.#inflight || !this.#queue.length || !thread) return;
    const pending = this.#inflight = this.#queue.shift()!;
    thread.worker.ref();
    pending.timer = setTimeout(() => {
      if (this.#inflight !== pending) return;
      this.#fail(failureOf('deadline', 'deadline-exceeded', `The storage thread did not answer ${pending.request.op} within ${pending.deadlineMs} ms.`, true));
    }, pending.deadlineMs);
    thread.worker.postMessage({ ...pending.request, id: pending.id });
  }

  #answer(handle: ThreadHandle, response: ThreadResponse): void {
    const pending = this.#inflight;
    if (handle !== this.#thread) return;
    if (!pending || response?.type !== 'result' || response.id !== pending.id) {
      this.#fail(failureOf('command', 'invalid-command', 'The storage thread answered a command that was not asked.', true));
      return;
    }
    clearTimeout(pending.timer);
    this.#inflight = undefined;
    if (!this.#queue.length) handle.worker.unref();
    if (response.ok) pending.resolve(response.value);
    else {
      const { error } = response;
      // The thread decides the disposition of its own transaction; a read never commits anything.
      const disposition: CommitDisposition = pending.kind === 'write' ? error.disposition : 'not-committed';
      pending.reject(new StorageCommandError({ phase: pending.phase, code: error.code, message: error.message, disposition, retryable: error.retryable, commandId: pending.commandId }));
    }
    this.#pump();
  }

  /** Marks the storage unavailable. A running thread is terminated, never replaced; waiting commands are rejected. */
  #fail(failure: StorageFailure): StorageStatus {
    this.#state = 'unavailable';
    this.#failure = failure;
    this.#ownerEpoch = undefined;
    const thread = this.#thread;
    if (thread && thread.exitCode === undefined) { thread.expected = true; void thread.worker.terminate(); }
    const inflight = this.#inflight;
    this.#inflight = undefined;
    const queued = this.#queue.splice(0);
    if (inflight) {
      clearTimeout(inflight.timer);
      // The thread had the command: a write may have committed before the thread stopped answering.
      inflight.reject(new StorageCommandError({ phase: failure.phase, code: failure.code, message: failure.message, disposition: inflight.kind === 'write' ? 'unknown' : 'not-committed', retryable: failure.retryable, commandId: inflight.commandId }));
    }
    for (const pending of queued) pending.reject(new StorageCommandError({ phase: failure.phase, code: failure.code, message: failure.message, disposition: 'not-committed', retryable: failure.retryable, commandId: pending.commandId }));
    const status = this.status();
    try { this.#options.onUnavailable?.(status); } catch { /* best-effort: the worker's hold callback must not change the storage's own state. */ }
    return status;
  }
}
