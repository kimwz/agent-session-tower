/**
 * The fixture parent's entry: the storage as a worker sees it, plus the internals the storage tests drive. helpers.ts
 * compiles it with server/storage/build-identity.ts replaced by the fixture build's fixed thread sources, the way the
 * server and executable builds replace it with theirs; tests take every storage value from that compiled module.
 * Nothing in server/ imports this file.
 */
export * from '../../../../server/storage/index.js';
export { isStorageBuildContext, readStorageBundleArtifact, storageBundleFromArtifact } from '../../../../server/storage/bundle.js';
export { jsonBytesWith, writeResult } from '../../../../server/storage/contract.js';
export { storageFs, storageLayout } from '../../../../server/storage/paths.js';
export { proveRecoveryBarrier, readStorageIdentity, recordStorageIdentity } from '../../../../server/storage/recovery.js';
