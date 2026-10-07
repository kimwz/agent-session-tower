import type { StorageBuildManifest } from './contract.js';

/**
 * The storage thread sources this build trusts, fixed when the build is made: each build replaces this module whole.
 * The server build writes it beside the compiled server with the hash of the artifact it writes there
 * (scripts/build-server.mjs); the standalone executable is bundled with it, the artifact text included
 * (storageThreadPlugin in thread-bundle.mjs). A source listed without a manifest runs this build's own storage contract
 * (storageManifest()). A checkout run by tsx keeps this module as it is: it trusts nothing until its first capture
 * bundles the canonical thread entry from the same checkout (see bundle.ts).
 */
export interface BuildStorageIdentity {
  readonly contexts: readonly { readonly sourceHash: string; readonly manifest?: StorageBuildManifest }[];
  /** The bundle artifact's JSON text, for a build without files beside it. */
  readonly artifact?: string;
}
export const BUILD_STORAGE: BuildStorageIdentity | undefined = undefined;
