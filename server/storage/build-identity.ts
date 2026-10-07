declare const __TOWER_STORAGE_EXPECTED_SOURCE_HASH__: string | undefined;

/**
 * The storage thread source hash this build's worker trusts, fixed when the build is made: the standalone executable
 * defines it (scripts/build-executable.mjs), and the server build replaces this compiled module with the hash of the
 * artifact it writes beside it (scripts/build-server.mjs). A checkout run by tsx has none; there the thread is
 * bundled from the same checkout at the process's first capture (see bundle.ts).
 */
export const BUILD_STORAGE_SOURCE_HASH: string | undefined = typeof __TOWER_STORAGE_EXPECTED_SOURCE_HASH__ === 'string' ? __TOWER_STORAGE_EXPECTED_SOURCE_HASH__ : undefined;
