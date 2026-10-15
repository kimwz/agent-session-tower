/**
 * The Node.js lines Tower runs on, each from its first release with the SQLite its storage needs. package.json's
 * engines and the storage runtime check (server/storage/runtime.ts) name the same releases.
 */
export const NODE_LINES = { 22: '22.22.3', 24: '24.15.0', 26: '26.0.0' };

/** Whether `version` (as in process.versions.node) is on one of those lines, at or past its first release. */
export function nodeSupported(version) {
  const [major, minor, patch] = version.split('.').map(Number);
  const floor = NODE_LINES[major]?.split('.').map(Number);
  return !!floor && (minor > floor[1] || (minor === floor[1] && patch >= floor[2]));
}
