import type { Plugin } from 'esbuild';
import type { BuildStorageIdentity } from './build-identity.js';

export interface StorageThreadArtifact { format: string; source: string; sourceHash: string }
export const STORAGE_BUNDLE_FORMAT: string;
export const STORAGE_SOURCE_HASH_VARIABLE: string;
export const STORAGE_BUNDLE_ARTIFACT: string;
export const STORAGE_BUILD_IDENTITY_MODULE: string;
export const STORAGE_THREAD_ENTRY: string;
export function bundleStorageThread(entry?: string): Promise<StorageThreadArtifact>;
export function buildIdentityModule(identity: BuildStorageIdentity): string;
export function buildIdentityPlugin(moduleText: string): Plugin;
export function writeStorageThreadArtifact(outputRoot: string, entry?: string): Promise<{ path: string; artifact: StorageThreadArtifact }>;
export function storageThreadPlugin(entry?: string): Promise<Plugin>;
