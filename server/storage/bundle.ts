import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BUILD_STORAGE_SOURCE_HASH } from './build-identity.js';
import { STORAGE_BUNDLE_FORMAT, type StorageFailure } from './contract.js';

/**
 * The storage thread's code, captured once when the worker starts and reused for every reopen. A later build that
 * replaces dist/ (or a checkout that changes) cannot change what an already running worker hands its thread.
 *
 * Trust comes from the build, not from the artifact: a standalone executable or a server build fixes the source hash
 * its worker expects (build-identity.ts), and a bundle with any other hash is refused, however consistent it is with
 * itself. A checkout run by tsx has no build; its expected hash is the one of the thread it bundles from that same
 * checkout at the first capture. The thread states the hash on its first line and reports it in its hello, where the
 * worker compares it with the capture again (client.ts, preflight.ts).
 */
export interface CapturedStorageBundle {
  readonly ok: true;
  readonly source: string;
  /** sha256 of `source` after its first line; equal to the build's expected hash outside development. */
  readonly sourceHash: string;
  /** standalone: defined into the executable; dist: the build's generated artifact; development: bundled from the checkout. */
  readonly origin: 'standalone' | 'dist' | 'development' | 'artifact';
  readonly capturedAt: string;
}
export interface FailedStorageBundle { readonly ok: false; readonly failure: StorageFailure }
export type StorageBundleCapture = CapturedStorageBundle | FailedStorageBundle;

declare const __TOWER_STORAGE_THREAD_BUNDLE__: string | undefined;

const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
/** This module runs from TypeScript sources (tsx): a checkout, not a build. */
const DEVELOPMENT = import.meta.url.endsWith('.ts');
const FIRST_LINE = /^var __TOWER_STORAGE_SOURCE_HASH__ = "([0-9a-f]{64})";\n/;
const now = () => new Date().toISOString();
const failed = (code: 'bundle-missing' | 'bundle-invalid' | 'bundle-hash-mismatch' | 'bundle-untrusted', message: string): FailedStorageBundle =>
  Object.freeze({ ok: false as const, failure: { phase: 'bundle' as const, code, message, retryable: false, sourcePreserved: true, at: now() } });

/** The hash a bundle text states on its first line, if the rest of the text has that hash. */
function statedHash(source: string): string | undefined {
  const line = FIRST_LINE.exec(source);
  if (!line) return undefined;
  return createHash('sha256').update(source.slice(line[0].length)).digest('hex') === line[1] ? line[1] : undefined;
}

/** Whether this build may run a thread of `sourceHash`. Answers the refusal, or undefined. */
function untrusted(sourceHash: string): FailedStorageBundle | undefined {
  if (BUILD_STORAGE_SOURCE_HASH === undefined) {
    return DEVELOPMENT ? undefined : failed('bundle-untrusted', 'This build does not say which storage thread it expects; rebuild the server.');
  }
  return sourceHash === BUILD_STORAGE_SOURCE_HASH ? undefined
    : failed('bundle-untrusted', `The storage thread bundle (${sourceHash.slice(0, 12)}…) is not the one this build expects (${BUILD_STORAGE_SOURCE_HASH.slice(0, 12)}…).`);
}

/** Checks an artifact's text against its own hash and against the hash this build expects. */
export function storageBundleFromArtifact(text: string, origin: CapturedStorageBundle['origin']): StorageBundleCapture {
  let artifact: { format?: unknown; source?: unknown; sourceHash?: unknown };
  try { artifact = JSON.parse(text); } catch { return failed('bundle-invalid', 'The storage thread bundle is not valid JSON.'); }
  if (artifact?.format !== STORAGE_BUNDLE_FORMAT || typeof artifact.source !== 'string' || typeof artifact.sourceHash !== 'string') {
    return failed('bundle-invalid', 'The storage thread bundle has an unknown format.');
  }
  const stated = statedHash(artifact.source);
  if (!stated || stated !== artifact.sourceHash) return failed('bundle-hash-mismatch', `The storage thread bundle does not match its hash (${artifact.sourceHash.slice(0, 12)}…).`);
  return untrusted(stated) ?? Object.freeze({ ok: true as const, source: artifact.source, sourceHash: stated, origin, capturedAt: now() });
}

/**
 * The same checks again for a capture handed to openStorage or preflightStorage, so an object built by hand cannot
 * stand in for one: answers the refusal, or undefined.
 */
export function verifyCapturedBundle(bundle: CapturedStorageBundle): FailedStorageBundle | undefined {
  if (typeof bundle.source !== 'string' || statedHash(bundle.source) !== bundle.sourceHash) return failed('bundle-hash-mismatch', 'The captured storage thread bundle does not match its hash.');
  return untrusted(bundle.sourceHash);
}

/** Reads a generated artifact file once. */
export async function readStorageBundleArtifact(path: string, origin: CapturedStorageBundle['origin'] = 'artifact'): Promise<StorageBundleCapture> {
  let text: string;
  try {
    const bytes = await readFile(path);
    if (bytes.length > MAX_BUNDLE_BYTES) return failed('bundle-invalid', 'The storage thread bundle is too large.');
    text = bytes.toString('utf8');
  } catch (error) {
    return failed('bundle-missing', `The storage thread bundle is missing (${(error as NodeJS.ErrnoException).code ?? String(error)}). Rebuild the server.`);
  }
  return storageBundleFromArtifact(text, origin);
}

async function capture(): Promise<StorageBundleCapture> {
  if (typeof __TOWER_STORAGE_THREAD_BUNDLE__ === 'string') return storageBundleFromArtifact(__TOWER_STORAGE_THREAD_BUNDLE__, 'standalone');
  const here = import.meta.url;
  if (DEVELOPMENT) {
    // A checkout run by tsx: bundle the thread from the sources as they are now. Only a checkout has esbuild.
    try {
      const helper = new URL('./thread-bundle.mjs', here).href;
      const { bundleStorageThread } = await import(helper) as { bundleStorageThread(): Promise<{ format: string; source: string; sourceHash: string }> };
      return storageBundleFromArtifact(JSON.stringify(await bundleStorageThread()), 'development');
    } catch (error) {
      return failed('bundle-missing', `The storage thread could not be bundled from the checkout: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return readStorageBundleArtifact(fileURLToPath(new URL('./generated/thread-bundle.json', here)), 'dist');
}

let captured: Promise<StorageBundleCapture> | undefined;
/** The process's storage bundle: the first call captures it, every later call answers the same one. */
export function captureStorageBundle(): Promise<StorageBundleCapture> {
  return captured ??= capture();
}
