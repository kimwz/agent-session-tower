import type { Provider } from '../../../shared/types.js';
import type { RetentionCandidate, RetentionRecord } from './policy.js';
export interface RetentionSourceFile { path: string; root: string; nativeId: string; provider: Provider }
export type { RetentionCandidate, RetentionFileManifest, RetentionManifest, RetentionPhase, RetentionJournalEntry, RetentionCapability, RetentionOverview } from '../../../shared/retention.js';
import type { RetentionManifest, RetentionCapability } from '../../../shared/retention.js';
/** Admission reservation must exclude provider writes as well as Tower starts. */
export interface RetentionLease {
  revalidate(): Promise<boolean>;
  preserveOwnership(): Promise<void>;
  remove(manifest: RetentionManifest): Promise<void>;
  release(): Promise<void>;
}
export interface RetentionAdapter {
  capability(provider: Provider): RetentionCapability;
  reserve(candidate: RetentionCandidate, records: RetentionRecord[]): Promise<RetentionLease | undefined>;
  files(records: RetentionRecord[]): Promise<RetentionSourceFile[]>;
  restore?(manifest: RetentionManifest, operationId: string): Promise<void>;
}
