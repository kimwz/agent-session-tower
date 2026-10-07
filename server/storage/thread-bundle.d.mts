export interface StorageThreadArtifact { format: string; source: string; sourceHash: string }
export const STORAGE_BUNDLE_FORMAT: string;
export const STORAGE_BUNDLE_DEFINE: string;
export const STORAGE_EXPECTED_HASH_DEFINE: string;
export const STORAGE_SOURCE_HASH_VARIABLE: string;
export const STORAGE_BUNDLE_ARTIFACT: string;
export const STORAGE_BUILD_IDENTITY_MODULE: string;
export const STORAGE_THREAD_ENTRY: string;
export function bundleStorageThread(entry?: string): Promise<StorageThreadArtifact>;
export function writeStorageThreadArtifact(outputRoot: string, entry?: string): Promise<{ path: string; artifact: StorageThreadArtifact }>;
export function storageThreadDefine(entry?: string): Promise<Record<string, string>>;
