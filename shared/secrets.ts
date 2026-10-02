/** Public contracts contain names and references, never stored secret values. */
export const SECRET_OPERATIONS = ['discover', 'env', 'pipe', 'file', 'compare', 'fingerprint'] as const;
export const DEFAULT_SECRET_USE_OPERATIONS = ['discover', 'env', 'pipe', 'file'] as const;
export type SecretOperation = typeof SECRET_OPERATIONS[number];
export type SecretScope = 'global' | 'project' | 'task';
export type SecretKind = 'scalar' | 'env' | 'file';
export type SecretActivation = 'manual' | 'auto';
export const MAX_SECRET_BYTES = 1024 * 1024;
export const MIN_VAULT_PASSWORD = 12;

export interface SecretProject { id: string; name: string; bindings: { hostId: string; root: string }[] }
export interface SecretGroup { id: string; name: string; scope: SecretScope; projectId?: string; taskId?: string }
export interface SecretRule {
  id: string; groupId: string; secretIds: string[]; hostId: string; projectId?: string;
  activation: SecretActivation; operations: SecretOperation[]; fields?: Record<string, string[]>; allProjects?: boolean;
  root?: string; maxTtlMs?: number; expiresAt?: number; enabled: boolean; revision: number;
}
export interface SecretMetadata {
  id: string; name: string; groupId: string; kind: SecretKind; version: number; reference: string;
  fields?: string[]; expiresAt?: number; operations?: SecretOperation[]; activation?: SecretActivation;
  sourceHostId?: string;
}
export interface SecretDevice { id: string; name: string; signingKey: string; encryptionKey: string; fingerprint: string }
export interface SecretPeer { device: SecretDevice; routeId: string; direction: 'node' | 'controller'; enabled: boolean }
export interface SecretTarget { hostId: string; sessionId: string; taskId: string; root: string; projectId?: string }
export interface SecretContext extends SecretTarget { runId: string }
export interface SecretTask {
  id: string; hostId: string; sessionId: string; root: string; status: 'open' | 'closed';
  createdAt: number; closedAt?: number; expiresAt?: number; excluded: string[];
}
export interface VaultStatus { initialized: boolean; locked: boolean; pendingImports?: number; pendingImportIds?: string[]; error?: string }
export interface SecretOverview {
  status: VaultStatus; device?: SecretDevice; peers: SecretPeer[]; projects: SecretProject[];
  groups: SecretGroup[]; secrets: SecretMetadata[]; rules: SecretRule[];
  target?: SecretTarget; task?: SecretTask; connected: string[];
}
export interface SecretCreateInput {
  name: string; kind: SecretKind; scope: SecretScope; value?: string;
  /** Canonical base64 of an uploaded file; dotenv uploads also preserve these original bytes. */
  content?: string;
  groupId?: string; groupName?: string; projectId?: string; projectRoot?: string;
  target?: SecretTarget; allProjects?: boolean; activation?: SecretActivation; operations?: SecretOperation[]; connect?: boolean; expiresAt?: number;
}
export interface SecretRunInput {
  operationId: string; command: string; args?: string[]; cwd?: string; timeoutMs?: number;
  env?: Record<string, string>; envBundle?: string; stdin?: string; files?: Record<string, string>;
}
export interface SecretRunResult { operationId: string; exitCode: number | null; stdout: string; stderr: string; timedOut?: boolean }
