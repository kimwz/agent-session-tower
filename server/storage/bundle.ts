import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { STORAGE_BUNDLE_FORMAT, type StorageFailure } from './contract.js';

/**
 * The storage thread's code, captured once when the worker starts and reused for every reopen. A later build that
 * replaces dist/ (or a checkout that changes) cannot change what an already running worker hands its thread.
 */
export interface CapturedStorageBundle {
  readonly ok: true;
  readonly source: string;
  readonly sourceHash: string;
  /** standalone: defined into the executable; dist: the build's generated artifact; development: bundled from the checkout. */
  readonly origin: 'standalone' | 'dist' | 'development' | 'artifact';
  readonly capturedAt: string;
}
export interface FailedStorageBundle { readonly ok: false; readonly failure: StorageFailure }
export type StorageBundleCapture = CapturedStorageBundle | FailedStorageBundle;

declare const __TOWER_STORAGE_THREAD_BUNDLE__: string | undefined;

const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
const now = () => new Date().toISOString();
const failed = (code: 'bundle-missing' | 'bundle-invalid' | 'bundle-hash-mismatch', message: string): FailedStorageBundle =>
  Object.freeze({ ok: false as const, failure: { phase: 'bundle' as const, code, message, retryable: false, sourcePreserved: true, at: now() } });

/** Checks an artifact's text against its own hash. */
export function storageBundleFromArtifact(text: string, origin: CapturedStorageBundle['origin']): StorageBundleCapture {
  let artifact: { format?: unknown; source?: unknown; sourceHash?: unknown };
  try { artifact = JSON.parse(text); } catch { return failed('bundle-invalid', 'The storage thread bundle is not valid JSON.'); }
  if (artifact?.format !== STORAGE_BUNDLE_FORMAT || typeof artifact.source !== 'string' || typeof artifact.sourceHash !== 'string') {
    return failed('bundle-invalid', 'The storage thread bundle has an unknown format.');
  }
  const actual = createHash('sha256').update(artifact.source).digest('hex');
  if (actual !== artifact.sourceHash) return failed('bundle-hash-mismatch', `The storage thread bundle does not match its hash (${artifact.sourceHash.slice(0, 12)}…).`);
  return Object.freeze({ ok: true as const, source: artifact.source, sourceHash: actual, origin, capturedAt: now() });
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
  if (here.endsWith('.ts')) {
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
