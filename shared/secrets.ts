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
export interface SecretBrokerApproval { id: string; hostId: string; sessionId: string; root: string; taskId: string; taskLabel: string; createdAt: number; expiresAt: number }
export interface SecretBrokerAccess { sessionId: string; root?: string; taskId: string | null; eligible: boolean; requiresApproval: boolean; reason?: string; approval?: SecretBrokerApproval; locked: boolean }
export interface SecretContext extends SecretTarget { runId: string; brokerApprovalId?: string }
export interface SecretTask {
  id: string; hostId: string; sessionId: string; root: string; status: 'open' | 'closed';
  createdAt: number; closedAt?: number; expiresAt?: number;
  /** Stopped in this session whatever else allows them, until the owner connects them again. */
  excluded: string[];
  /** The owner's explicit connections to this session, with every operation and field. */
  connected: string[];
}
export interface VaultStatus { initialized: boolean; locked: boolean; pendingImports?: number; pendingImportIds?: string[]; error?: string }

/** Canonical folder identity: the computer's vault device ID and the folder's real path. */
export interface SecretFolder { hostId: string; root: string }
/** Automatic use of one secret. GLOBAL covers every folder of every computer this vault serves: this one and its trusted node peers. */
export interface SecretSharing { revision: number; global: boolean; folders: SecretFolder[] }
/** What the rules of a secret not yet edited for sharing allow, for display only; authorization reads the rules. */
export interface SecretLegacySummary { global: { hostId: string }[]; folders: SecretFolder[]; limited: boolean }
export type SecretBasis = 'global' | 'folder' | 'session' | 'legacy' | 'remote';
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
}
/**
 * A settings row: `sharing` once created or edited with sharing, otherwise the `legacy` summary of its rules.
 * `withheld` means an older build named the secret in a rule again, so its GLOBAL and folder sharing waits for the owner.
 */
export interface SecretSettingsItem extends SecretMetadata { sharing?: SecretSharing; legacy?: SecretLegacySummary; withheld?: boolean }
export interface SecretSettingsView { status: VaultStatus; device?: SecretDevice; peers: SecretPeer[]; secrets: SecretSettingsItem[] }
export interface SecretCreateInput {
  name: string; kind: SecretKind; value?: string;
  /** Canonical base64 of an uploaded file; dotenv uploads also preserve these original bytes. */
  content?: string;
  /** For saved values; unshared when omitted. */
  sharing?: Pick<SecretSharing, 'global' | 'folders'>;
  /** Connects the value to the target session. */
  connect?: 'session';
  /** Kept with the target session's task, connected to it, and dropped when the task ends. */
  temporary?: boolean;
}
export interface SecretRunInput {
  operationId: string; command: string; args?: string[]; cwd?: string; timeoutMs?: number;
  env?: Record<string, string>; envBundle?: string; stdin?: string; files?: Record<string, string>;
}
export interface SecretRunResult { operationId: string; exitCode: number | null; stdout: string; stderr: string; timedOut?: boolean }
