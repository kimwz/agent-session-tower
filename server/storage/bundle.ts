import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { BUILD_STORAGE } from './build-identity.js';
import { STORAGE_BUNDLE_FORMAT, STORAGE_PROTOCOL, type StorageBuildIdentity, type StorageBuildManifest, type StorageErrorCode, type StorageFailure, type ThreadHello } from './contract.js';
import { manifestDigest, storageManifest } from './schema.js';

/**
 * The storage thread's code, captured once when the worker starts and reused for every reopen. A later build that
 * replaces dist/ (or a checkout that changes) cannot change what an already running worker hands its thread.
 *
 * Trust comes from the build, never from the artifact or the caller: each trusted thread source is bound to the
 * storage contract (manifest) its thread must declare, as one immutable StorageBuildContext. A standalone executable
 * or a server build fixes its sources in build-identity.ts. A checkout run by tsx has no build: it trusts nothing until
 * its first capture bundles the canonical thread entry from that checkout, and then only that source. A bundle of any
 * other source is refused, however consistent it is with itself. The thread states its hash on its first line and
 * reports it with its manifest in its hello, which the worker checks against the context (helloRefusal).
 */
export interface CapturedStorageBundle {
  readonly ok: true;
  readonly source: string;
  /** sha256 of `source` after its first line; a source this build trusts. */
  readonly sourceHash: string;
  /** standalone: built into the executable; dist: the build's generated artifact; development: bundled from the checkout. */
  readonly origin: 'standalone' | 'dist' | 'development' | 'artifact';
  readonly capturedAt: string;
}
export interface FailedStorageBundle { readonly ok: false; readonly failure: StorageFailure }
export type StorageBundleCapture = CapturedStorageBundle | FailedStorageBundle;

/**
 * A thread source this build trusts with the contract its thread must declare. Only this module makes one; recovery
 * decisions take nothing else (isStorageBuildContext), so no caller can widen what this build supports.
 */
export interface StorageBuildContext {
  readonly ok: true;
  readonly sourceHash: string;
  readonly manifest: StorageBuildManifest;
  readonly identity: StorageBuildIdentity;
}

const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
/** This module runs from TypeScript sources (tsx): a checkout, not a build. */
const DEVELOPMENT = import.meta.url.endsWith('.ts');
const FIRST_LINE = /^var __TOWER_STORAGE_SOURCE_HASH__ = "([0-9a-f]{64})";\n/;
const SHA256 = /^[0-9a-f]{64}$/;
const now = () => new Date().toISOString();
const failed = (code: 'bundle-missing' | 'bundle-invalid' | 'bundle-hash-mismatch' | 'bundle-untrusted', message: string): FailedStorageBundle =>
  Object.freeze({ ok: false as const, failure: { phase: 'bundle' as const, code, message, retryable: false, sourcePreserved: true, at: now() } });

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); }
  return value;
}

const issued = new WeakSet<object>();
function contextOf(sourceHash: string, manifest: StorageBuildManifest): StorageBuildContext {
  const own = deepFreeze(structuredClone(manifest));
  const context: StorageBuildContext = Object.freeze({
    ok: true as const, sourceHash, manifest: own,
    identity: Object.freeze({ appVersion: own.appVersion, protocol: STORAGE_PROTOCOL, sourceHash, manifestDigest: own.digest }),
  });
  issued.add(context);
  return context;
}
export const isStorageBuildContext = (value: unknown): value is StorageBuildContext => typeof value === 'object' && value !== null && issued.has(value);

/** The build's sources, or why it has none it can use. Read once, when this module loads. */
function fromBuild(): { trusted: ReadonlyMap<string, StorageBuildContext> } | { refusal: string } | undefined {
  if (!BUILD_STORAGE) return undefined;
  const trusted = new Map<string, StorageBuildContext>();
  for (const entry of BUILD_STORAGE.contexts ?? []) {
    const manifest = entry.manifest ?? storageManifest();
    if (!SHA256.test(entry.sourceHash) || trusted.has(entry.sourceHash) || manifest.digest !== manifestDigest(manifest)) return { refusal: 'This build\'s storage identity is malformed; rebuild the server.' };
    trusted.set(entry.sourceHash, contextOf(entry.sourceHash, manifest));
  }
  return trusted.size ? { trusted } : { refusal: 'This build trusts no storage thread; rebuild the server.' };
}
const built = fromBuild();
/** sourceHash → context. A build's are fixed above; a checkout's are set once, by its first canonical capture. */
let trusted: ReadonlyMap<string, StorageBuildContext> | undefined = built && 'trusted' in built ? built.trusted : undefined;

/** The hash a bundle text states on its first line, if the rest of the text has that hash. */
function statedHash(source: string): string | undefined {
  const line = FIRST_LINE.exec(source);
  if (!line) return undefined;
  return createHash('sha256').update(source.slice(line[0].length)).digest('hex') === line[1] ? line[1] : undefined;
}

/** Whether this process may run a thread of `sourceHash`. Answers the refusal, or undefined. */
function untrusted(sourceHash: string): FailedStorageBundle | undefined {
  if (!trusted) {
    if (built && 'refusal' in built) return failed('bundle-untrusted', built.refusal);
    return failed('bundle-untrusted', DEVELOPMENT
      ? 'No storage thread is trusted yet: a checkout trusts only the thread its first capture bundles (captureStorageBundle).'
      : 'This build does not say which storage thread it expects; rebuild the server.');
  }
  return trusted.has(sourceHash) ? undefined
    : failed('bundle-untrusted', `The storage thread bundle (${sourceHash.slice(0, 12)}…) is not one this build trusts.`);
}

/** Checks an artifact's text against its own hash and against the sources this build trusts. */
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
 * The trusted context of a capture handed to openStorage, preflightStorage or a recovery step, checked again so an
 * object built by hand cannot stand in for one. Answers the refusal otherwise.
 */
export function storageBuildContext(bundle: StorageBundleCapture): StorageBuildContext | FailedStorageBundle {
  if (!bundle.ok) return bundle;
  if (typeof bundle.source !== 'string' || statedHash(bundle.source) !== bundle.sourceHash) return failed('bundle-hash-mismatch', 'The captured storage thread bundle does not match its hash.');
  return untrusted(bundle.sourceHash) ?? trusted!.get(bundle.sourceHash)!;
}

/**
 * Why a thread's hello does not agree with the context it was started for, or undefined: protocol, version, the whole
 * manifest it declares (its digest recomputed from its body, and every field equal to the trusted one) and the source
 * it runs. Nothing has touched a file when this is asked.
 */
export function helloRefusal(hello: ThreadHello, context: StorageBuildContext): { code: StorageErrorCode; message: string } | undefined {
  if (hello.protocol !== STORAGE_PROTOCOL) return { code: 'protocol-mismatch', message: `The storage thread speaks ${hello.protocol}, this worker ${STORAGE_PROTOCOL}.` };
  if (hello.appVersion !== context.manifest.appVersion) return { code: 'app-version-mismatch', message: `The storage thread is from ${hello.appVersion}, this worker from ${context.manifest.appVersion}.` };
  const declared = hello.manifest;
  let digest: string | undefined;
  try { digest = manifestDigest(declared); } catch { digest = undefined; }
  if (!declared || digest !== declared.digest || !isDeepStrictEqual(declared, context.manifest)) {
    return { code: 'schema-contract-mismatch', message: 'The storage thread declares another schema contract than this build trusts for its source.' };
  }
  if (hello.sourceHash !== context.sourceHash) {
    return { code: 'source-hash-mismatch', message: `The storage thread runs source ${hello.sourceHash ? `${hello.sourceHash.slice(0, 12)}…` : 'without a stated hash'}; this worker expects ${context.sourceHash.slice(0, 12)}….` };
  }
  return undefined;
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
  if (BUILD_STORAGE?.artifact !== undefined) return storageBundleFromArtifact(BUILD_STORAGE.artifact, 'standalone');
  const here = import.meta.url;
  if (DEVELOPMENT && !BUILD_STORAGE) {
    // A checkout run by tsx: bundle the canonical thread entry from the sources as they are now. Only a checkout has esbuild.
    let artifact: { format: string; source: string; sourceHash: string };
    try {
      const helper = new URL('./thread-bundle.mjs', here).href;
      const { bundleStorageThread } = await import(helper) as { bundleStorageThread(): Promise<typeof artifact> };
      artifact = await bundleStorageThread();
    } catch (error) {
      return failed('bundle-missing', `The storage thread could not be bundled from the checkout: ${error instanceof Error ? error.message : String(error)}`);
    }
    const stated = statedHash(artifact.source);
    if (!stated || stated !== artifact.sourceHash) return failed('bundle-hash-mismatch', 'The storage thread bundled from the checkout does not match its hash.');
    // The one place a checkout's trust is set: the thread it just bundled from its own canonical entry, with this
    // checkout's own contract. Nothing a caller passes sets or widens it.
    trusted ??= new Map([[stated, contextOf(stated, storageManifest())]]);
    return storageBundleFromArtifact(JSON.stringify(artifact), 'development');
  }
  return readStorageBundleArtifact(fileURLToPath(new URL('./generated/thread-bundle.json', here)), 'dist');
}

let captured: Promise<StorageBundleCapture> | undefined;
/** The process's storage bundle: the first call captures it, every later call answers the same one. */
export function captureStorageBundle(): Promise<StorageBundleCapture> {
  return captured ??= capture();
}
