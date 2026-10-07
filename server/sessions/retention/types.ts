import type { Provider } from '../../../shared/types.js';
import type { RetentionCandidate, RetentionRecord } from './policy.js';
export interface RetentionSourceFile { path: string; originalPath?: string; provenance?: 'native-archive' | 'cold-original'; root: string; nativeId: string; provider: Provider }
export type { RetentionCandidate, RetentionFileManifest, RetentionManifest, RetentionPhase, RetentionJournalEntry, RetentionMember, RetentionCapability, RetentionOverview } from '../../../shared/retention.js';
import type { RetentionManifest, RetentionCapability, RetentionMember } from '../../../shared/retention.js';
export interface RetentionOperationContext {
  operationId: string;
  managedCold(): RetentionMember[];
  fresh(): Promise<import('./policy.js').RetentionObservation>;
  commitMember(member: RetentionMember): Promise<void>;
}
/** Tower admission is held throughout effects; providers preserve their original cold records. */
export interface RetentionLease {
  revalidate(): Promise<boolean>;
  preserveOwnership(): Promise<void>;
  moveCold(): Promise<RetentionMember[]>;
  sources(members: RetentionMember[]): Promise<RetentionSourceFile[]>;
  release(): Promise<void>;
}
export interface RetentionAdapter {
  capability(provider: Provider): RetentionCapability;
  reserve(candidate: RetentionCandidate, records: RetentionRecord[], context: RetentionOperationContext): Promise<RetentionLease | undefined>;
  files(records: RetentionRecord[]): Promise<RetentionSourceFile[]>;
  inspectCold(members: RetentionMember[]): Promise<{ complete: boolean; members: RetentionMember[]; issues: string[] }>;
  restore?(manifest: RetentionManifest, operationId: string, members: RetentionMember[], context: RetentionOperationContext): Promise<RetentionMember[]>;
}
