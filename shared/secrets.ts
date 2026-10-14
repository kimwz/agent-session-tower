/** Public contracts contain names and references, never stored secret values. */
export const SECRET_OPERATIONS = ['discover', 'env', 'pipe', 'file', 'compare', 'fingerprint'] as const;
export const DEFAULT_SECRET_USE_OPERATIONS = ['discover', 'env', 'pipe', 'file'] as const;
export type SecretOperation = typeof SECRET_OPERATIONS[number];
export type SecretKind = 'scalar' | 'env' | 'file';
export const MAX_SECRET_BYTES = 1024 * 1024;
export const MIN_VAULT_PASSWORD = 12;

/** Stored rule policy of secrets saved before per-secret sharing; only `server/secrets/legacy-policy.ts` decides with it, until the owner edits that secret's sharing. */
export type SecretScope = 'global' | 'project' | 'task';
export type SecretActivation = 'manual' | 'auto';
export interface SecretProject { id: string; name: string; bindings: { hostId: string; root: string }[] }
export interface SecretGroup { id: string; name: string; scope: SecretScope; projectId?: string; taskId?: string }
export interface SecretRule {
  id: string; groupId: string; secretIds: string[]; hostId: string; projectId?: string;
  activation: SecretActivation; operations: SecretOperation[]; fields?: Record<string, string[]>; allProjects?: boolean;
  root?: string; maxTtlMs?: number; expiresAt?: number; enabled: boolean; revision: number;
}
/** `groupId` and `activation` belong to the remote wire format and the rule policy. */
export interface SecretMetadata {
  id: string; name: string; groupId: string; kind: SecretKind; version: number; reference: string;
  fields?: string[]; expiresAt?: number; operations?: SecretOperation[]; activation?: SecretActivation;
  sourceHostId?: string;
}
export interface SecretDevice { id: string; name: string; signingKey: string; encryptionKey: string; fingerprint: string }
export interface SecretPeer { device: SecretDevice; routeId: string; direction: 'node' | 'controller'; enabled: boolean }
export interface SecretTarget { hostId: string; sessionId: string; taskId: string; root: string; projectId?: string }
/** Who is using a secret: the owner's own session (no review) or any other session (attack-only review before values resolve). */
export type SecretSubjectMode = 'owner' | 'reviewed';
/** `subject` unset is reviewed: only `'owner'` is exempt. */
export interface SecretContext extends SecretTarget { runId: string; subject?: SecretSubjectMode }
export interface SecretTask {
  id: string; hostId: string; sessionId: string; root: string; status: 'open' | 'closed';
  createdAt: number; closedAt?: number; expiresAt?: number;
  /** Stopped in this session whatever else allows them, until the owner connects them again. */
  excluded: string[];
  /** The owner's explicit connections to this session, with every operation and field. */
  connected: string[];
}
export interface VaultStatus {
  initialized: boolean; locked: boolean; pendingImports?: number; pendingImportIds?: string[]; error?: string;
  /** Pending vault imports that carry their machine key: they import without the source vault's password. */
  pendingImportsKeyed?: string[];
  /** While locked: this computer's machine key opens the vault (made while it followed a host), so the page opens it without a password. */
  machineKey?: true;
  /**
   * Set by the web while the vault is locked and the account and worker support it: `ready` when the Tower (login)
   * password opens it, `missing` when the vault (recovery) password is needed once with it. Absent: the vault password opens it.
   */
  towerPassword?: SecretTowerPassword;
}
export type SecretTowerPassword = 'ready' | 'missing';

/** Canonical folder identity: the computer's vault device ID and the folder's real path. */
export interface SecretFolder { hostId: string; root: string }
/**
 * Automatic use of one secret. `allMachines` ("모든 내 머신") covers every folder of every computer this vault serves: this
 * one and its trusted node peers, those joining later included. `machines` names computers (vault device IDs) with all
 * their folders; `folders` names single folders.
 */
export interface SecretSharing { revision: number; allMachines: boolean; machines: string[]; folders: SecretFolder[] }
/** A sharing change as the owner asks for it. */
export type SecretSharingInput = Pick<SecretSharing, 'allMachines' | 'folders'> & { machines?: string[] };
/** What the rules of a secret not yet edited for sharing allow, for display only; authorization reads the rules. */
export interface SecretLegacySummary { global: { hostId: string }[]; folders: SecretFolder[]; limited: boolean }
/** `global`: shared with all machines; `machine`: with this computer as a whole. */
export type SecretBasis = 'global' | 'machine' | 'folder' | 'session' | 'legacy' | 'remote';
export interface SecretAvailable extends SecretMetadata { basis: SecretBasis[]; operations: SecretOperation[] }
export interface SecretUsage {
  at: number; secretId: string; name: string; operation: SecretOperation;
  outcome: 'delivered' | 'blocked'; review: 'exempt' | 'allowed' | 'blocked' | 'failed'; reason?: string;
}
export type SecretSessionError = 'uninitialized' | 'locked' | 'not-eligible' | 'session-closed' | 'source-unavailable' | 'worker-update-pending';
export interface SecretSessionView {
  status: VaultStatus; available: SecretAvailable[]; connectable: SecretMetadata[]; usage: SecretUsage[];
  /** Sources (vault device IDs) that could not be reached; their secrets are missing from `available`. */
  unavailableSources: string[];
  /** Sources that answer but run a build without per-secret sharing reads yet; their secrets are not listed until they update. */
  updatePendingSources: string[];
  error?: SecretSessionError; permanent?: boolean;
  /** Keys this session stopped that `connectable` does not offer again: its own temporary values and other sources' keys. */
  disconnected?: SecretDisconnected[];
  /**
   * How a turn the owner starts in this session uses secrets; work another turn delegates is reviewed wherever it runs.
   * Absent for a joined computer's session, which that computer decides.
   */
  subject?: SecretSubjectMode;
}
/** `remote`: another source's key, re-allowed by lifting this session's stop; otherwise a value kept with this session, connected again. */
export interface SecretDisconnected extends SecretMetadata { remote: boolean }
/**
 * A settings row: `sharing` once created or edited with sharing, otherwise the `legacy` summary of its rules.
 * `withheld` means an older build named the secret in a rule again, so its GLOBAL and folder sharing waits for the owner.
 */
export interface SecretSettingsItem extends SecretMetadata { sharing?: SecretSharing; legacy?: SecretLegacySummary; withheld?: boolean }
export interface SecretSettingsView {
  status: VaultStatus; device?: SecretDevice; peers: SecretPeer[]; secrets: SecretSettingsItem[];
  /** The attached worker predates per-secret sharing: only the vault's status is known, and only lock/unlock work. */
  workerUpdatePending?: boolean;
  /** This signed-in browser unlocked value viewing with the Tower password, and the vault has not been locked since. */
  valueView?: boolean;
}
/** One saved value, for the owner's value view only: `value` for text, `content` (base64) for a file or an uploaded .env. */
export interface SecretValue { id: string; version: number; kind: SecretKind; value?: string; content?: string }
/** Why value viewing (`view-unlock`, `value`, `value-update`) answered no; the HTTP error's `code`. */
export type SecretViewError = 'needs-recovery' | 'view-locked' | 'account-required' | 'login-required';
export interface SecretCreateInput {
  name: string; kind: SecretKind; value?: string;
  /** Canonical base64 of an uploaded file; dotenv uploads also preserve these original bytes. */
  content?: string;
  /** For saved values; unshared when omitted. */
  sharing?: SecretSharingInput;
  /** Connects the value to the target session. */
  connect?: 'session';
  /** Kept with the target session's task, connected to it, and dropped when the task ends. */
  temporary?: boolean;
}
export interface SecretRunInput {
  operationId: string; command: string; args?: string[]; cwd?: string; timeoutMs?: number;
  env?: Record<string, string>; envBundle?: string; stdin?: string; files?: Record<string, string>;
}
export interface SecretRunResult {
  operationId: string; exitCode: number | null; stdout: string; stderr: string; timedOut?: boolean;
  /** Set when the secret-use reviewer refused the request; no value was resolved and no consumer started. */
  blocked?: { code: 'SECRET_USE_BLOCKED'; reason: string };
}

/**
 * A host secret as a computer that follows the host lists it (`catalog`): its name and reference, never a value or field,
 * and whether that computer's session may use it. `not-shared` ones can still be asked for, which asks the owner to share.
 */
export interface SecretCatalogItem { id: string; name: string; kind: SecretKind; reference: string; status: 'available' | 'not-shared' }
/** Why a host refused a following computer's use, as that computer's agent is told. */
export type SecretRefusal = 'not-shared' | 'host-locked' | 'host-offline';
/**
 * One side of the automatic secret trust between a host and a computer that follows it: its vault, its public device
 * while open, and whether it trusts the other side now. `untrusted`: the owner removed that trust there, so it is not
 * made again automatically. `needs-open`: a following computer's vault the owner has to open once for it to open by itself.
 */
export interface SecretAlignment { vault: 'missing' | 'locked' | 'needs-open' | 'open'; device?: SecretDevice; trusted: boolean; untrusted?: true; available?: number }
/**
 * Secrets for a computer that follows this host, for its card: `connected` with how many secrets it may use on the whole
 * computer, or what keeps it from them (this host's vault locked, the trust still being made, its vault to open once,
 * the link down, or trust the owner removed).
 */
export interface NodeSecretStatus { state: 'connected' | 'trust-pending' | 'host-locked' | 'needs-open' | 'offline' | 'untrusted'; available?: number; checkedAt: string }
/**
 * A push for the owner from secret use by a computer that follows this host: it asked for a secret not shared with it
 * (`not-shared`, with the secret and that computer's vault ID, so one tap opens its sharing), or found this host's vault
 * locked (`host-locked`). Names only, never values. `nodeId` is the computer's link ID. A lost link has no push: this host
 * cannot see requests while it is down (the computer's agent is told at once, and its card shows the link down).
 */
export interface SecretShareNotice { key: string; at: number; kind: 'not-shared' | 'host-locked'; nodeId: string; nodeName?: string; hostId?: string; secretId?: string; secretName?: string }
