/**
 * The storage contract shared by the execution worker and its SQLite thread. The worker owns one thread with one
 * connection; nothing here hands a raw SQL string, a callback or the database path to the web, MCP or a remote.
 * Domains reach their tables only through fixed commands registered inside the thread (see domain.ts).
 */

/** The command protocol between the worker and its thread. Additions are additive; a change of meaning is a new value. */
export const STORAGE_PROTOCOL = 'tower-storage/1';
/** The format of a generated thread bundle (dist/server/storage/generated/thread-bundle.json, or the SEA define). */
export const STORAGE_BUNDLE_FORMAT = 'tower-storage-thread-bundle/2';
/** What storage_meta.format holds in a database this project created. Any other database is refused, never adopted. */
export const STORAGE_DATABASE_FORMAT = 'agent-session-tower/storage';

/** One schema change of one scope (`core` or a domain), applied exactly as written. */
export interface StorageMigration { version: number; sql: string }
/** A domain's tables as its owner declares them: shared by the worker (manifest) and the thread (migrations). */
export interface StorageDomainSchema {
  domain: string;
  migrations: readonly StorageMigration[];
  /** Release A of this domain: its reader/writer/exporter. Required before any release may cut it over. */
  preparation: { requiredArtifactVersion: string; readerContract: number; writerContract: number };
  /** Release B: present only once a release imports the domain. Absent means its JSON files stay authoritative. */
  cutover?: { artifactVersion: string; importContract: number };
}

export interface ScopeManifest { scope: string; schemaVersion: number; schemaDigest: string }
export interface DomainManifest extends ScopeManifest {
  preparation: StorageDomainSchema['preparation'];
  cutover?: StorageDomainSchema['cutover'];
}
/** What a build's worker and thread must agree on before the thread may touch a file. */
export interface StorageBuildManifest {
  protocol: string;
  appVersion: string;
  core: ScopeManifest;
  domains: DomainManifest[];
  /** sha256 over everything above. Equal digests mean the same contract. */
  digest: string;
}
/**
 * Which build holds the storage: recorded in schema rows, snapshots and recovery barriers. `sourceHash` is the sha256
 * of the thread bundle text after its first line (the line that states this hash to the thread itself); the build
 * fixes the hash its worker expects (see build-identity.ts), and the thread reports it in its hello.
 */
export interface StorageBuildIdentity { appVersion: string; protocol: string; sourceHash: string; manifestDigest: string }

export interface RuntimeInfo {
  node: string;
  /** sqlite_version() of an in-memory database, as the thread runs it. Absent when node:sqlite cannot load. */
  sqlite?: string;
  platform: string;
  arch: string;
  execPath: string;
  /** The node:sqlite exports the storage relies on. Newer ones (constructor timeout, backup, authorizer) are not used. */
  apis: { DatabaseSync: boolean; StatementSync: boolean };
}

export type StorageState = 'opening' | 'ready' | 'closing' | 'closed' | 'unavailable';
export type StorageErrorPhase = 'bundle' | 'handshake' | 'runtime' | 'paths' | 'recovery' | 'open' | 'schema' | 'prepare' | 'command' | 'deadline' | 'thread-exit' | 'snapshot' | 'close';
export type StorageErrorCode =
  | 'bundle-missing' | 'bundle-invalid' | 'bundle-hash-mismatch' | 'bundle-untrusted'
  | 'thread-start-failed' | 'handshake-timeout' | 'protocol-mismatch' | 'app-version-mismatch' | 'schema-contract-mismatch' | 'source-hash-mismatch'
  | 'unsupported-runtime' | 'unsupported-platform'
  | 'state-dir-invalid' | 'symlink' | 'not-regular' | 'wrong-owner' | 'wrong-permissions' | 'hard-linked' | 'unexpected-journal'
  | 'database-missing' | 'storage-replaced' | 'path-changed' | 'io-error' | 'no-space' | 'read-only'
  | 'recovery-in-progress' | 'recovery-invalid' | 'source-changed' | 'snapshot-invalid' | 'snapshot-foreign' | 'barrier-in-progress' | 'unknown-scope'
  | 'not-a-database' | 'corrupt' | 'foreign-database' | 'unknown-schema' | 'pragma-mismatch' | 'busy' | 'migration-required'
  | 'not-ready' | 'not-prepared' | 'stale-owner' | 'queue-full' | 'payload-too-large' | 'result-too-large' | 'invalid-command'
  | 'unknown-domain' | 'unknown-command' | 'command-id-conflict' | 'no-cutover-contract' | 'authority-missing' | 'contract-mismatch' | 'domain-failed'
  | 'deadline-exceeded' | 'thread-exited' | 'sqlite-error';

/** Why the storage cannot serve, as a diagnostic shows it. Nothing here is turned into an empty state. */
export interface StorageFailure {
  phase: StorageErrorPhase;
  code: StorageErrorCode;
  message: string;
  /** An explicit retry (reopen, the same command again) can succeed without anyone changing files. */
  retryable: boolean;
  /**
   * Nothing was deleted, replaced or initialised, and SQLite wrote to the files only after they were checked as this
   * build's storage. A database left with a WAL or shm is judged on a private copy; any refused open compares the
   * live files with what it found and says false when they differ.
   */
  sourcePreserved: boolean;
  at: string;
  sqlite?: { errcode?: number; errstr?: string };
}

/**
 * Whether a write is durable. `unknown` (a thread that exited or missed its deadline after receiving the command,
 * or a failed COMMIT) never means it was not written: look the command ID up with `receipt()` after a reopen.
 * An error can say `committed`: the commit is durable and what failed came after it (a prepare whose storage identity
 * could not be recorded, a replayed answer larger than this connection's maxResultBytes).
 */
export type CommitDisposition = 'committed' | 'not-committed' | 'unknown';

export class StorageCommandError extends Error {
  readonly phase: StorageErrorPhase;
  readonly code: StorageErrorCode;
  readonly disposition: CommitDisposition;
  readonly retryable: boolean;
  readonly commandId?: string;
  constructor(init: { phase: StorageErrorPhase; code: StorageErrorCode; message: string; disposition: CommitDisposition; retryable: boolean; commandId?: string }) {
    super(init.message);
    this.name = 'StorageCommandError';
    this.phase = init.phase; this.code = init.code; this.disposition = init.disposition; this.retryable = init.retryable; this.commandId = init.commandId;
  }
}

/** Bounds the worker chooses within; a value outside its range is refused, not clamped. */
export interface StorageLimits {
  /** Commands waiting or running at once. */
  maxQueue: number;
  /** UTF-8 bytes of one command payload, serialized. */
  maxPayloadBytes: number;
  /** UTF-8 bytes of one answer. */
  maxResultBytes: number;
  /** PRAGMA busy_timeout. SQLite can wait several times this long (measured), so commandDeadlineMs is the real bound. */
  busyTimeoutMs: number;
  /** How long the worker waits for the thread's answer to one command before it fails the storage. */
  commandDeadlineMs: number;
  /** The same for a snapshot, which copies the whole database. */
  snapshotDeadlineMs: number;
  /** How long a new thread may take to say hello and open. */
  handshakeDeadlineMs: number;
}
export const STORAGE_LIMIT_RANGES: Record<keyof StorageLimits, readonly [number, number]> = {
  maxQueue: [1, 4096],
  maxPayloadBytes: [1024, 16 * 1024 * 1024],
  maxResultBytes: [1024, 32 * 1024 * 1024],
  busyTimeoutMs: [0, 1000],
  commandDeadlineMs: [1000, 120_000],
  snapshotDeadlineMs: [1000, 3_600_000],
  handshakeDeadlineMs: [1000, 120_000],
};
export const DEFAULT_STORAGE_LIMITS: StorageLimits = {
  maxQueue: 256, maxPayloadBytes: 1024 * 1024, maxResultBytes: 8 * 1024 * 1024, busyTimeoutMs: 250,
  commandDeadlineMs: 15_000, snapshotDeadlineMs: 600_000, handshakeDeadlineMs: 15_000,
};

export function storageLimits(chosen: Partial<StorageLimits> = {}): StorageLimits {
  const limits = { ...DEFAULT_STORAGE_LIMITS, ...chosen };
  for (const [key, [min, max]] of Object.entries(STORAGE_LIMIT_RANGES) as [keyof StorageLimits, readonly [number, number]][]) {
    const value = limits[key];
    if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`Storage limit ${key} must be an integer from ${min} to ${max}.`);
  }
  return limits;
}

export interface AppliedMigration { scope: string; version: number; checksum: string; appliedAt: string; appVersion: string; sourceHash: string; ownerEpoch: number }
/** What the thread found in the database file. Unknown schemas never get this far: they are refused at open. */
export type SchemaState =
  | { kind: 'empty' }
  | { kind: 'current'; storageId: string; applied: AppliedMigration[] }
  | { kind: 'behind'; storageId: string; applied: AppliedMigration[]; pending: { scope: string; version: number }[] };

/** One domain's authority over its state, written only by that domain's import/export commands (see authority.ts). */
export interface DomainAuthority {
  domain: string;
  authority: 'database' | 'legacy-exported';
  /** Grows by one with every import and every legacy export. Never reset. */
  generation: number;
  /** sha256 of the import source manifest or the export manifest of that generation. */
  manifestSha256: string;
  readerContract: number;
  writerContract: number;
  committedAt: string;
  appVersion: string;
  sourceHash: string;
  ownerEpoch: number;
}

export interface StoragePragmas { journalMode: string; synchronous: number; foreignKeys: number; trustedSchema: number; busyTimeout: number }
export interface StorageInspection {
  schema: SchemaState;
  pragmas: StoragePragmas;
  ownerEpoch: number;
  authority: DomainAuthority[];
  sqlite: string;
  pageSize: number;
  pageCount: number;
  freelistCount: number;
}

/**
 * A committed command. Its stored answer comes back only when it fits the connection's current maxResultBytes;
 * otherwise only its size and hash do, which still settle whether (and as what) the command committed.
 */
export interface ReceiptRecord {
  commandId: string;
  scope: string;
  command: string;
  payloadSha256: string;
  ownerEpoch: number;
  committedAt: string;
  result: { state: 'included'; value: unknown } | { state: 'omitted'; bytes: number; sha256: string; limit: number };
}
export type ReceiptLookup = { found: true; receipt: ReceiptRecord } | { found: false };
/** Answered only once the storage identity beside the database names this storage (durably); see StorageClient.prepare. */
export interface PrepareResult {
  ownerEpoch: number;
  applied: { scope: string; version: number }[];
  schema: SchemaState;
  /** This prepare created the storage in an empty file. */
  created: boolean;
  /** The command ID had already committed; the answer is the stored one. */
  replayed: boolean;
}
export interface PrepareThreadResult { ownerEpoch: number; applied: { scope: string; version: number }[]; schema: SchemaState; created: boolean; replayed: boolean; claimed: boolean }
export interface WriteResult<T = unknown> { disposition: 'committed'; result: T; replayed: boolean; commandId: string }

/**
 * Summary of the historical-recovery hold, for status and diagnostics. While a barrier exists the storage is never
 * `clear`: scopes are released one by one (gate(scope) is the answer per scope), and any scope not reconciled by name
 * (`unreconciled` lists the barrier's own, an unknown or later domain is never listed) stays held. See recovery.ts.
 */
export type RecoveryHoldSummary =
  | { state: 'clear' }
  | { state: 'held'; barrierId?: string; reason: string; reconciled: string[]; unreconciled: string[] };

export interface StorageStatus {
  state: StorageState;
  identity?: StorageBuildIdentity;
  runtime?: RuntimeInfo;
  schema?: SchemaState;
  /** Set once prepare() claimed the database for this worker. Writes carry it; another owner's epoch refuses them. */
  ownerEpoch?: number;
  failure?: StorageFailure;
  /** Commands waiting or running. */
  pending: number;
  recovery?: RecoveryHoldSummary;
}

// ---- Messages between the worker and the thread (structured clone). ----

export interface ThreadHello {
  type: 'hello';
  protocol: string;
  appVersion: string;
  manifest: StorageBuildManifest;
  /** The source hash stated in the first line of the text this thread runs. */
  sourceHash?: string;
  runtime: RuntimeInfo;
  /** Set when node:sqlite could not be loaded or queried. */
  runtimeError?: string;
}
/**
 * The storage recorded beside the database. `created`: the database must hold it. Not yet created (its first
 * prepare was about to run): the database is empty or holds it. Anything else is refused before it is written to.
 */
export interface StorageExpectation { storageId: string; created: boolean }
/** Checks a private copy of the database (with its WAL) the way open would, then closes it. The live files are not opened. */
export interface CheckRequest { path: string; busyTimeoutMs: number; expected?: StorageExpectation }
export interface OpenRequest {
  path: string;
  busyTimeoutMs: number;
  maxResultBytes: number;
  identity: StorageBuildIdentity;
  expected?: StorageExpectation;
}
export type ThreadRequest =
  | { id: number; op: 'check'; check: CheckRequest }
  | { id: number; op: 'open'; open: OpenRequest }
  | { id: number; op: 'inspect' }
  | { id: number; op: 'prepare'; commandId: string; allowMigration: boolean; storageId: string }
  | { id: number; op: 'receipt'; commandId: string }
  | { id: number; op: 'read'; domain: string; command: string; payload: string }
  | { id: number; op: 'write'; domain: string; command: string; payload: string; commandId: string; ownerEpoch: number }
  | { id: number; op: 'snapshot'; target: string }
  | { id: number; op: 'probe' }
  | { id: number; op: 'flush' }
  | { id: number; op: 'close' };
export interface ThreadError { code: StorageErrorCode; message: string; disposition: CommitDisposition; retryable: boolean; sqlite?: { errcode?: number; errstr?: string } }
export type ThreadResponse = { type: 'result'; id: number; ok: true; value: unknown } | { type: 'result'; id: number; ok: false; error: ThreadError };

export interface OpenResult { schema: SchemaState; pragmas: StoragePragmas; ownerEpoch: number }
export interface SnapshotThreadResult { schema: SchemaState; ownerEpoch: number; authority: DomainAuthority[]; quickCheck: string; foreignKeyViolations: number; journalMode: string }
export interface ProbeResult { foreignKeysEnforced: boolean; trustedSchema: number; busyTimeout: number; transactionRollback: boolean; preparedRows: number }
