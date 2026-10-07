import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import { helloRefusal, storageBuildContext, type FailedStorageBundle, type StorageBuildContext, type StorageBundleCapture } from './bundle.js';
import {
  StorageCommandError, storageLimits, writeResult,
  type CommitDisposition, type OpenResult, type PrepareResult, type PrepareThreadResult, type ReceiptLookup, type RecoveryHoldSummary, type RuntimeInfo,
  type SchemaState, type SnapshotThreadResult, type StorageBuildIdentity, type StorageErrorCode, type StorageErrorPhase,
  type StorageExpectation, type StorageFailure, type StorageInspection, type StorageLimits, type StorageOpenCheck, type StorageState, type StorageStatus, type ThreadHello,
  type ThreadRequest, type ThreadResponse, type WriteResult,
} from './contract.js';
import { createPrivateFile, pathError, sameFile, sameStorageFiles, STORAGE_DATABASE_NAME, StoragePathError, storageFiles, storageFs, storageLayout, type StorageFiles, type StorageLayout } from './paths.js';
import {
  discardSnapshot, proveRecoveryBarrier, proveStorageIdentity, readRecoveryBarrier, readStorageIdentity, recordStorageIdentity, recoveryHold, recoverySummary, sealSnapshot,
  snapshotTarget, StorageRecoveryError, type SnapshotManifest,
} from './recovery.js';
import { evaluateRuntime } from './runtime.js';

/**
 * The execution worker's handle on its storage thread. One client owns one thread and one connection; commands go one
 * at a time in arrival order, within the chosen bounds. A failure (handshake, runtime, paths, schema, a thread that
 * exits, a missed deadline) leaves the client `unavailable` with the reason: it never respawns the thread, never opens
 * an empty database in place of a missing one, and never says a write it lost track of was not committed.
 * `reopen()` is the explicit retry, with the same captured bundle; it does not claim the storage again, `prepare()` does.
 *
 * The worker starts it in this order, all under its runtime lock (the single writer of the state directory) and
 * before takeWorkerRestore: captureStorageBundle once → preflightStorage (the runtime only) → its update evidence →
 * openStorage → status() → prepare({ allowMigration }) with a new command ID → gate('core') → takeWorkerRestore only
 * when the gate is open. A reopen is reopen() → prepare({ allowMigration: false }) → gate. Only gate() says durable
 * work may go ahead: a prepare's answer, replayed or not, does not; a held gate keeps the worker in its diagnostic mode.
 * The lock is what keeps a second Tower writer away between the check of the files and the open; a program other than
 * Tower that writes the database is not held back by it.
 */
export interface StorageClientOptions {
  stateDir: string;
  /** captureStorageBundle()'s answer, taken once when the worker started. It decides the contract the thread must declare. */
  bundle: StorageBundleCapture;
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
const CHECK_PREFIX = '.storage-check-';

function failureOf(phase: StorageErrorPhase, code: StorageErrorCode, message: string, retryable: boolean, extra: Partial<StorageFailure> = {}): StorageFailure {
  return { phase, code, message, retryable, sourcePreserved: true, at: now(), ...extra };
}
const SCHEMA_CODES = new Set<StorageErrorCode>(['unknown-schema', 'foreign-database', 'database-missing', 'storage-replaced']);
const RECOVERY_CODES = new Set<StorageErrorCode>(['recovery-in-progress', 'recovery-invalid']);
const fileError = (error: unknown) => error instanceof StoragePathError || error instanceof StorageRecoveryError
  ? { code: error.code, retryable: error.retryable, message: error.message, ...(error instanceof StoragePathError && error.space ? { space: error.space } : {}) }
  : { code: 'io-error' as const, retryable: true, message: error instanceof Error ? error.message : String(error) };
const sameStorage = (a: SchemaState, b: SchemaState) => a.kind === 'empty' ? b.kind === 'empty' : b.kind !== 'empty' && a.storageId === b.storageId;

export async function openStorage(options: StorageClientOptions): Promise<StorageClient> {
  const client = new StorageClient(options);
  await client.reopen();
  return client;
}

export class StorageClient {
  readonly #options: StorageClientOptions;
  readonly #context: StorageBuildContext | FailedStorageBundle;
  readonly #source?: string;
  readonly #limits: StorageLimits;
  #state: StorageState = 'closed';
  #failure?: StorageFailure;
  #thread?: ThreadHandle;
  #queue: Pending[] = [];
  #inflight?: Pending;
  #nextId = 1;
  #schema?: SchemaState;
  /** A new object for every open: what gate() and prepare() started on, never reused (unlike owner numbers). */
  #generation: object = {};
  /** This worker's claim in the current open, a new object for every claim. */
  #claim?: { readonly ownerEpoch: number };
  #runtime?: RuntimeInfo;
  #recovery?: RecoveryHoldSummary;
  #openCheck?: StorageOpenCheck;
  #layout?: StorageLayout;
  /** While opening: the thread failed (exit, deadline, unreadable answer). #open turns it into the failure, compared. */
  #lost?: StorageFailure;
  #transition: Promise<unknown> = Promise.resolve();

  /** Use openStorage(). Limits outside their ranges throw here. */
  constructor(options: StorageClientOptions) {
    this.#options = options;
    this.#limits = storageLimits(options.limits);
    this.#context = storageBuildContext(options.bundle);
    // The text just checked against the trusted source, kept: every reopen runs exactly it.
    if (this.#context.ok && options.bundle.ok) this.#source = options.bundle.source;
  }

  /** The trusted contract this client runs (recovery steps take it), or undefined for a bundle this build does not trust. */
  get context(): StorageBuildContext | undefined {
    return this.#context.ok ? this.#context : undefined;
  }

  get identity(): StorageBuildIdentity | undefined {
    return this.#context.ok ? { ...this.#context.identity } : undefined;
  }

  status(): StorageStatus {
    return structuredClone({
      state: this.#state, pending: this.#queue.length + (this.#inflight ? 1 : 0),
      ...(this.identity ? { identity: this.identity } : {}), ...(this.#runtime ? { runtime: this.#runtime } : {}), ...(this.#schema ? { schema: this.#schema } : {}),
      ...(this.#claim ? { ownerEpoch: this.#claim.ownerEpoch } : {}), ...(this.#failure ? { failure: this.#failure } : {}), ...(this.#recovery ? { recovery: this.#recovery } : {}),
      ...(this.#openCheck ? { openCheck: this.#openCheck } : {}),
    });
  }

  /**
   * Whether durable work of `scope` (`core` or a domain) may go ahead now: the storage is ready and claimed by this
   * worker (prepare() succeeded since the last open), and no recovery barrier holds the scope. Reads the barrier fresh,
   * and a barrier that releases the scope counts only once it is proven durable. The answer is for the open and claim
   * the call started on, checked again after each wait: a thread that ended, a close, or a reopen and a new claim
   * meanwhile keep it closed, and only a read of the current open is published as its recovery status.
   */
  async gate(scope: string): Promise<StorageGate> {
    const generation = this.#generation;
    const claim = this.#claim;
    const current = () => this.#generation === generation && this.#state === 'ready' && this.#claim === claim;
    const reasons: string[] = [];
    if (this.#state !== 'ready') reasons.push(this.#stateReason());
    else if (!claim) reasons.push('Storage is open but not prepared by this worker.');
    if (!this.#context.ok) return { open: false, reasons: [...reasons, this.#context.failure.message] };
    const read = await readRecoveryBarrier(this.#layout ?? this.#options.stateDir);
    if (this.#generation === generation) this.#recovery = recoverySummary(read, this.#context);
    const hold = recoveryHold(read, scope, this.#context);
    if (hold.held) reasons.push(hold.reason!);
    else if (read.state === 'present' && !reasons.length && current()) {
      try { await proveRecoveryBarrier(this.#layout!, read); } catch (error) {
        reasons.push(`The recovery barrier that releases ${scope} is not durable yet: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!reasons.length && !current()) {
      reasons.push(this.#state === 'ready' ? 'Storage was reopened or claimed again while the gate was checked; ask again.' : this.#stateReason());
    }
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
        this.#claim = undefined;
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
   * and migration-lock checks; without it a storage that needs changes is refused unchanged. Give each open a new
   * command ID (the default): a replayed prepare claims nothing once another prepare has claimed since.
   *
   * The claim is published (gate/write) only once the storage identity beside the database durably names this
   * storage: creating a storage records it as `creating` first and `created` after the commit, and an identity found
   * there (from an earlier, perhaps failed, record) is proven durable again before it is used. A failed identity
   * record or proof leaves the storage unavailable; when the prepare had already committed, the error says `committed`.
   * All of it belongs to the open the prepare started on: after a close or reopen meanwhile it claims nothing and fails
   * nothing in the open since, and a commit the thread answered still says `committed`.
   */
  async prepare(input: { allowMigration: boolean; commandId?: string }): Promise<PrepareResult> {
    const commandId = input.commandId ?? `prepare-${randomUUID()}`;
    const generation = this.#generation;
    const current = () => this.#generation === generation && this.#state === 'ready';
    const layout = this.#layout;
    const schema = this.#schema;
    if (this.#state !== 'ready' || !layout || !schema) throw this.#refusal('prepare', commandId);
    let storageId: string;
    if (schema.kind === 'empty') {
      if (!input.allowMigration) throw new StorageCommandError({ phase: 'prepare', code: 'migration-required', message: 'The storage is empty; creating it is a schema change this start may not make.', disposition: 'not-committed', retryable: false, commandId });
      try { storageId = await this.#identityForCreation(layout); } catch (error) {
        throw this.#failAfter(error, 'not-committed', commandId, 'The storage identity could not be recorded before creating the storage', generation);
      }
      if (!current()) throw this.#stalePrepare(commandId, 'not-committed');
    } else storageId = schema.storageId;
    const result = await this.#send({ id: 0, op: 'prepare', commandId, allowMigration: input.allowMigration, storageId }, 'write', 'prepare', this.#limits.commandDeadlineMs, commandId) as PrepareThreadResult;
    // The commit is durable from here on: a failure below never says otherwise.
    if (this.#generation === generation) this.#schema = result.schema;
    if (!current()) throw this.#stalePrepare(commandId, 'committed');
    try {
      if (result.schema.kind === 'empty') throw new StoragePathError('database-missing', 'The prepare committed, yet the database reads as empty.');
      await this.#recordCreated(layout, result.schema.storageId);
    } catch (error) {
      throw this.#failAfter(error, 'committed', commandId, 'The prepare committed, but the storage identity could not be recorded durably, so this worker does not claim the storage', generation);
    }
    if (!current()) throw this.#stalePrepare(commandId, 'committed');
    if (result.claimed) this.#claim = { ownerEpoch: result.ownerEpoch };
    return { ownerEpoch: result.ownerEpoch, applied: result.applied, schema: result.schema, created: result.created, replayed: result.replayed, claimed: result.claimed };
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
    if (!this.#claim && this.#state === 'ready') throw new StorageCommandError({ phase: 'command', code: 'not-prepared', message: 'The storage was not prepared by this worker.', disposition: 'not-committed', retryable: false, commandId });
    // Not ready: #send refuses with the storage's own state or failure.
    const value = await this.#send({ id: 0, op: 'write', domain, command, payload: text, commandId, ownerEpoch: this.#claim?.ownerEpoch ?? 0 }, 'write', 'command', this.#limits.commandDeadlineMs, commandId) as { result: T; replayed: boolean };
    return writeResult(value.result, value.replayed, commandId);
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

  #stateReason(): string {
    return this.#failure ? `Storage is unavailable: ${this.#failure.message}` : `Storage is ${this.#state}.`;
  }

  /** The error for a command the storage cannot take in its current state. */
  #refusal(phase: StorageErrorPhase, commandId?: string, disposition: CommitDisposition = 'not-committed'): StorageCommandError {
    const code: StorageErrorCode = this.#state === 'unavailable' ? this.#failure?.code ?? 'not-ready' : 'not-ready';
    return new StorageCommandError({ phase, code, message: this.#stateReason(), disposition, retryable: this.#failure?.retryable ?? true, commandId });
  }

  /** The error of a prepare whose open ended, or was replaced by another, while it waited. */
  #stalePrepare(commandId: string, disposition: CommitDisposition): StorageCommandError {
    if (this.#state !== 'ready') return this.#refusal('prepare', commandId, disposition);
    return new StorageCommandError({ phase: 'prepare', code: 'not-ready', message: 'The storage was closed and opened again while this prepare ran, so it claims nothing; prepare again.', disposition, retryable: true, commandId });
  }

  /**
   * A file failure around a prepare: the storage becomes unavailable (intake holds) when it is still the open the
   * prepare started on (`generation`), and the error keeps the commit's disposition.
   */
  #failAfter(error: unknown, disposition: CommitDisposition, commandId: string, context: string, generation: object): StorageCommandError {
    if (error instanceof StorageCommandError) return error;
    const { code, retryable, message } = fileError(error);
    const text = `${context}: ${message}`;
    if (!this.#unavailable() && this.#generation === generation) this.#fail(failureOf('prepare', code, text, retryable));
    return new StorageCommandError({ phase: 'prepare', code, message: text, disposition, retryable, commandId });
  }

  /**
   * The storage ID a creating prepare uses: one already recorded as `creating` (proven durable first: it may be what
   * a failed record left), or a new one recorded (synced) now.
   */
  async #identityForCreation(layout: StorageLayout): Promise<string> {
    const recorded = await readStorageIdentity(layout);
    if (recorded.state === 'invalid') throw new StoragePathError('recovery-invalid', `The storage identity cannot be read: ${recorded.reason}`);
    if (recorded.state === 'present') {
      if (recorded.identity.state !== 'creating') throw new StoragePathError('recovery-invalid', 'The storage identity says the storage was created, yet the database is empty.');
      await proveStorageIdentity(layout);
      return recorded.identity.storageId;
    }
    const storageId = randomUUID();
    await recordStorageIdentity(layout, storageId, 'creating');
    return storageId;
  }

  /**
   * Makes the identity beside the database say `created` for `storageId`, durably: one found already saying so is
   * proven durable again (with the state directory's links to the database and the recovery folder). Throws when it
   * cannot, or names another storage.
   */
  async #recordCreated(layout: StorageLayout, storageId: string): Promise<void> {
    const recorded = await readStorageIdentity(layout);
    if (recorded.state === 'invalid') throw new StoragePathError('recovery-invalid', `The storage identity cannot be read: ${recorded.reason}`);
    if (recorded.state === 'present' && recorded.identity.storageId !== storageId) throw new StoragePathError('storage-replaced', 'The storage identity names another storage than the database holds.');
    if (recorded.state !== 'present' || recorded.identity.state !== 'created') await recordStorageIdentity(layout, storageId, 'created');
    await proveStorageIdentity(layout);
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
    this.#generation = {};
    this.#failure = undefined; this.#schema = undefined; this.#claim = undefined; this.#runtime = undefined; this.#openCheck = undefined; this.#lost = undefined;
    const context = this.#context;
    if (!context.ok) return this.#fail({ ...context.failure, at: now() });

    let thread: ThreadHandle;
    try { thread = this.#spawn(this.#source!); } catch (error) { return this.#fail(failureOf('handshake', 'thread-start-failed', `The storage thread could not start: ${(error as Error).message}`, true)); }
    let timer: NodeJS.Timeout | undefined;
    const hello = await Promise.race([thread.hello, new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), this.#limits.handshakeDeadlineMs); })]);
    clearTimeout(timer);
    if (hello === 'timeout') return this.#fail(failureOf('handshake', 'handshake-timeout', 'The storage thread did not say hello in time.', true));
    if (!hello) return this.#fail(failureOf('handshake', 'thread-start-failed', `The storage thread ended before its handshake${thread.lastError ? `: ${thread.lastError}` : ''}.`, false));
    this.#runtime = hello.runtime;
    // Nothing has touched a file yet. A thread from another build, protocol, schema contract or source stops here.
    const refusal = helloRefusal(hello, context);
    if (refusal) return this.#fail(failureOf('handshake', refusal.code, refusal.message, false));
    const verdict = evaluateRuntime(hello.runtime, hello.runtimeError);
    if (!verdict.supported) return this.#fail(failureOf('runtime', 'unsupported-runtime', verdict.reason, false));

    let layout: StorageLayout | undefined;
    let before: StorageFiles | undefined;
    let expected: StorageExpectation | undefined;
    let created = false;
    let phase: StorageErrorPhase = 'paths';
    try {
      layout = this.#layout = await storageLayout(this.#options.stateDir);
      phase = 'recovery';
      const barrier = await readRecoveryBarrier(layout);
      this.#recovery = recoverySummary(barrier, context);
      if (barrier.state === 'present') {
        if (barrier.barrier.state === 'recorded') throw new StoragePathError('recovery-in-progress', `Snapshot recovery ${barrier.barrier.id} has not finished; retry or complete it before opening.`);
        // Opened on an activation only once that activation is durable: otherwise a crash could bring back the recorded
        // barrier under a database that already moved on.
        await proveRecoveryBarrier(layout, barrier);
      }
      phase = 'paths';
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
      const { code, retryable, message, ...extra } = fileError(error);
      const failure = this.#lost ?? failureOf(RECOVERY_CODES.has(code) ? 'recovery' : phase, code, message, retryable, extra);
      // Until the live files were found nothing was sent to SQLite, and there is nothing to compare them with: they
      // are as found. From then on (a new empty database being made included) the refusal compares them.
      return before ? this.#refuse(failure, layout!, before) : this.#fail(failure);
    }
    if (this.#lost) return this.#refuse(this.#lost, layout, before);

    // Every existing database is judged on a private copy first: opening the live files read-write could recover,
    // checkpoint or remove a WAL before the schema is known, sidecars or not. A file this open just made is empty.
    let checked: SchemaState | undefined;
    if (!created) {
      try { checked = await this.#checkCopy(layout, before, expected); } catch (error) { return this.#refuse(this.#openFailure(error), layout, before); }
    }
    let opened: OpenResult;
    try {
      // The live files are opened only as they were checked: the same files, unchanged since.
      await this.#unchanged(layout, before);
      opened = await this.#send({ id: 0, op: 'open', open: { path: layout.database, busyTimeoutMs: this.#limits.busyTimeoutMs, maxResultBytes: this.#limits.maxResultBytes, identity: context.identity, ...(expected ? { expected } : {}) } }, 'control', 'open', this.#limits.handshakeDeadlineMs) as OpenResult;
    } catch (error) { return this.#refuse(this.#openFailure(error), layout, before); }

    try {
      // The file SQLite opened is the one checked before, and it holds the storage its copy was checked as.
      const after = await storageFiles(layout);
      if (!after.database || !sameFile(after.database, before.database!)) throw new StoragePathError('path-changed', `${layout.database} changed while it was opened.`);
      if (checked && !sameStorage(checked, opened.schema)) throw new StoragePathError('source-changed', `${layout.database} is not the storage its copy was checked as; another process may be using it.`, true);
      // A storage found without its identity (or still marked as being created) is named now, durably, before anything may claim it.
      if (opened.schema.kind !== 'empty') await this.#recordCreated(layout, opened.schema.storageId);
    } catch (error) {
      const { code, retryable, message, ...extra } = fileError(error);
      return this.#refuse(this.#lost ?? failureOf('paths', code, message, retryable, extra), layout, before);
    }
    if (this.#lost) return this.#refuse(this.#lost, layout, before);
    this.#schema = opened.schema;
    this.#state = 'ready';
    return this.status();
  }

  /** Throws `source-changed` when the live files are no longer exactly the ones found before the check. */
  async #unchanged(layout: StorageLayout, before: StorageFiles): Promise<void> {
    if (!sameStorageFiles(before, await storageFiles(layout))) throw new StoragePathError('source-changed', `${layout.database} changed while it was checked; another process may be using it.`, true);
  }

  /** Why the check or the open of the live files failed: the thread's own failure when it was lost. */
  #openFailure(error: unknown): StorageFailure {
    if (this.#lost) return this.#lost;
    if (error instanceof StorageCommandError) return failureOf(SCHEMA_CODES.has(error.code) ? 'schema' : 'open', error.code, error.message, error.retryable);
    const { code, retryable, message, ...extra } = fileError(error);
    return failureOf('open', code, message, retryable, extra);
  }

  /**
   * The one end of every open refused after the live files were found (`before`). `cause` is fixed on entry: what the
   * cleanup meets (a lost thread, a failed close) never replaces it. The thread is first made unable to change the
   * files: asked to close its connection (unless it was lost), then ended, each within the command deadline. Only
   * then are the live database, WAL and shm compared with `before` and the storage failed, once. A thread that did not
   * end in time (it stays, so the next reopen waits for it), files that cannot be compared, or a change the open saw
   * are never reported as preserved.
   */
  async #refuse(cause: StorageFailure, layout: StorageLayout, before: StorageFiles): Promise<StorageStatus> {
    const thread = this.#thread;
    let settled = !thread || thread.exitCode !== undefined;
    if (thread && !settled) {
      const deadlineMs = this.#limits.commandDeadlineMs;
      // best-effort: a close that fails or is not answered is followed by ending the thread; the cause is what is reported
      if (!this.#lost) await this.#send({ id: 0, op: 'close' }, 'control', 'close', deadlineMs).catch(() => {});
      thread.expected = true;
      if (thread.exitCode === undefined) void thread.worker.terminate();
      let timer: NodeJS.Timeout | undefined;
      settled = await Promise.race([gone(thread).then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), deadlineMs); })]);
      clearTimeout(timer);
    }
    // best-effort: files that can no longer be compared are reported as not preserved
    const same = settled && await storageFiles(layout).then(after => sameStorageFiles(before, after), () => false);
    return this.#fail({ ...cause, sourcePreserved: same && cause.code !== 'source-changed' && cause.code !== 'path-changed' });
  }

  /**
   * Decides whether the live files may be opened without opening them: a private copy of the database and its WAL is
   * checked by the thread, which may recover and checkpoint the copy only. The live database, WAL and shm must be the
   * same files, unchanged, before and after. Every open pays the copy in time and in free space (the database and WAL
   * sizes; a clone only where the file system clones); without that space it is refused `no-space`, retryable, the
   * live files untouched. Answers the schema the copy holds; throws the refusal.
   */
  async #checkCopy(layout: StorageLayout, before: StorageFiles, expected: StorageExpectation | undefined): Promise<SchemaState> {
    const started = performance.now();
    const requiredBytes = (before.database?.size ?? 0) + (before.wal?.size ?? 0);
    // best-effort: a state directory that cannot be listed only leaves the count of stale copies unknown (0)
    const staleCopies = (await readdir(layout.stateDir).catch(() => [] as string[])).filter(name => name.startsWith(CHECK_PREFIX)).length;
    let availableBytes: number;
    try { availableBytes = await storageFs.availableBytes(layout.stateDir); } catch (error) { throw pathError(error, layout.stateDir); }
    const short = (message: string) => new StoragePathError('no-space', `Opening ${layout.database} needs ${requiredBytes} bytes free for a private check copy of the database and its WAL: ${message}`, true, { requiredBytes, availableBytes });
    if (availableBytes < requiredBytes) throw short(`${availableBytes} are available.`);
    const spaceError = (error: unknown, path: string) => { const failure = pathError(error, path); return failure.code === 'no-space' ? short(failure.message) : failure; };
    let dir: string;
    try { dir = await mkdtemp(join(layout.stateDir, CHECK_PREFIX)); } catch (error) { throw spaceError(error, layout.stateDir); }
    try {
      const copy = join(dir, STORAGE_DATABASE_NAME);
      try {
        await copyFile(layout.database, copy, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
        if (before.wal) await copyFile(layout.wal, `${copy}-wal`, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      } catch (error) { throw spaceError(error, layout.database); }
      await this.#unchanged(layout, before);
      const { schema } = await this.#send({ id: 0, op: 'check', check: { path: copy, busyTimeoutMs: this.#limits.busyTimeoutMs, ...(expected ? { expected } : {}) } }, 'control', 'open', this.#limits.handshakeDeadlineMs) as { schema: SchemaState };
      await this.#unchanged(layout, before);
      return schema;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {}); // best-effort: a private copy left in the owner-only state directory, named .storage-check-* (counted as staleCopies)
      this.#openCheck = { copiedBytes: requiredBytes, durationMs: Math.round(performance.now() - started), staleCopies };
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
        this.#threadFailed(failureOf('thread-exit', 'thread-exited', `The storage thread exited with code ${code}${handle.lastError ? `: ${handle.lastError}` : ''}.`, true));
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
      if (handle === this.#thread) this.#threadFailed(failureOf('command', 'invalid-command', `A storage answer could not be read: ${error.message}`, true));
    });
    this.#thread = handle;
    return handle;
  }

  /**
   * Queues a request. Commands count against maxQueue; flush and close barriers do not, so a full queue still drains
   * and closes. They stay bounded: a flush right behind another flush shares its answer, and one close runs at a time.
   */
  #send(request: ThreadRequest, kind: Kind, phase: StorageErrorPhase, deadlineMs: number, commandId?: string): Promise<unknown> {
    if (this.#lost) return Promise.reject(new StorageCommandError({ phase: this.#lost.phase, code: this.#lost.code, message: this.#lost.message, disposition: 'not-committed', retryable: this.#lost.retryable, commandId }));
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
      this.#threadFailed(failureOf('deadline', 'deadline-exceeded', `The storage thread did not answer ${pending.request.op} within ${pending.deadlineMs} ms.`, true));
    }, pending.deadlineMs);
    thread.worker.postMessage({ ...pending.request, id: pending.id });
  }

  #answer(handle: ThreadHandle, response: ThreadResponse): void {
    const pending = this.#inflight;
    if (handle !== this.#thread) return;
    if (!pending || response?.type !== 'result' || response.id !== pending.id) {
      this.#threadFailed(failureOf('command', 'invalid-command', 'The storage thread answered a command that was not asked.', true));
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

  /**
   * The thread can no longer be trusted to answer (it exited, missed a deadline, sent something unreadable). While
   * opening, #open owns the outcome: it learns of it here, compares the live files and fails once. Otherwise the
   * storage fails now.
   */
  #threadFailed(failure: StorageFailure): void {
    if (this.#state !== 'opening') { this.#fail(failure); return; }
    this.#lost ??= failure;
    this.#stopThread(failure);
  }

  /** Ends a running thread (never replaced) and rejects what it was given: a write it had may have committed (`unknown`). */
  #stopThread(failure: StorageFailure): void {
    const thread = this.#thread;
    if (thread && thread.exitCode === undefined) { thread.expected = true; void thread.worker.terminate(); }
    const inflight = this.#inflight;
    this.#inflight = undefined;
    const queued = this.#queue.splice(0);
    if (inflight) {
      clearTimeout(inflight.timer);
      inflight.reject(new StorageCommandError({ phase: failure.phase, code: failure.code, message: failure.message, disposition: inflight.kind === 'write' ? 'unknown' : 'not-committed', retryable: failure.retryable, commandId: inflight.commandId }));
    }
    for (const pending of queued) pending.reject(new StorageCommandError({ phase: failure.phase, code: failure.code, message: failure.message, disposition: 'not-committed', retryable: failure.retryable, commandId: pending.commandId }));
  }

  /** Marks the storage unavailable. A running thread is terminated, never replaced; waiting commands are rejected. */
  #fail(failure: StorageFailure): StorageStatus {
    this.#state = 'unavailable';
    this.#failure = failure;
    this.#claim = undefined;
    this.#stopThread(failure);
    const status = this.status();
    try { this.#options.onUnavailable?.(status); } catch { /* best-effort: the worker's hold callback must not change the storage's own state. */ }
    return status;
  }
}
