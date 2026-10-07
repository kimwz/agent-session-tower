import type { RuntimeInfo } from './contract.js';

/**
 * Node.js lines whose official binaries were run against the storage fixtures, with the first patch of each that
 * bundles SQLite 3.51.3 (the WAL-reset fix). A line missing here (odd releases, newer majors) is unverified and refused
 * until it is verified and added; it never counts as supported by default.
 */
export const VERIFIED_NODE_LINES: Readonly<Record<number, string>> = { 22: '22.22.3', 24: '24.15.0', 26: '26.0.0' };
/** SQLite with the WAL-reset fix: 3.51.3 and later, or one of SQLite's official backports on an older line. */
export const PATCHED_SQLITE = { minimum: '3.51.3', backports: ['3.44.6', '3.50.7'] } as const;

export type RuntimeVerdict = { supported: true } | { supported: false; reason: string };

function parse(version: string): number[] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? match.slice(1, 4).map(Number) : undefined;
}
function atLeast(version: number[], minimum: number[]): boolean {
  for (let index = 0; index < 3; index++) if (version[index] !== minimum[index]) return version[index] > minimum[index];
  return true;
}

export function sqlitePatched(version: string): boolean {
  const parsed = parse(version);
  if (!parsed) return false;
  if (atLeast(parsed, parse(PATCHED_SQLITE.minimum)!)) return true;
  return PATCHED_SQLITE.backports.some(backport => {
    const fixed = parse(backport)!;
    return parsed[0] === fixed[0] && parsed[1] === fixed[1] && parsed[2] >= fixed[2];
  });
}

export function nodeVerified(version: string): boolean {
  const parsed = parse(version);
  const minimum = parsed && VERIFIED_NODE_LINES[parsed[0]];
  return !!parsed && !!minimum && atLeast(parsed, parse(minimum)!);
}

/** Decides from what the thread itself reported, before any file is touched. */
export function evaluateRuntime(runtime: RuntimeInfo, runtimeError?: string): RuntimeVerdict {
  if (runtimeError) return { supported: false, reason: `node:sqlite is not usable: ${runtimeError}` };
  if (!runtime.apis.DatabaseSync || !runtime.apis.StatementSync) return { supported: false, reason: 'node:sqlite lacks DatabaseSync or StatementSync.' };
  if (!runtime.sqlite || !sqlitePatched(runtime.sqlite)) return { supported: false, reason: `SQLite ${runtime.sqlite ?? 'unknown'} lacks the WAL-reset fix (needs ${PATCHED_SQLITE.minimum}+ or ${PATCHED_SQLITE.backports.join('/')}).` };
  if (!nodeVerified(runtime.node)) return { supported: false, reason: `Node.js ${runtime.node} is not a verified storage runtime (${Object.values(VERIFIED_NODE_LINES).map(version => `${version}+`).join(', ')}).` };
  return { supported: true };
}
