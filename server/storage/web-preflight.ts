import type { StorageErrorCode } from './contract.js';
import type { StoragePreflight } from './preflight.js';

export interface WebStorageRefusal { code: string; message: string }

/**
 * Refusals the same build on the same runtime gives every time: an untrusted or missing bundle, a thread that is not
 * this build's, a runtime that is not supported, SQLite that does not behave as the storage needs. A thread that did
 * not start, answer or finish in time may well do so on the next try.
 */
const DETERMINISTIC: ReadonlySet<StorageErrorCode> = new Set<StorageErrorCode>(['protocol-mismatch', 'app-version-mismatch', 'schema-contract-mismatch', 'source-hash-mismatch', 'unsupported-runtime', 'pragma-mismatch']);
const lasting = (preflight: StoragePreflight) => preflight.supported || preflight.refusal?.phase === 'bundle' || (!!preflight.refusal && DETERMINISTIC.has(preflight.refusal.code));

/**
 * The web's own storage runtime check, for its health answer (never the state directory: the worker alone opens the
 * storage). A pass and a deterministic refusal are kept for the life of the process; a transient refusal (a handshake
 * timeout, a thread that failed to start) or a check that threw is answered once and checked again on the next ask.
 * Concurrent asks share one check.
 */
export function webStorageCheck(check: () => Promise<StoragePreflight>, report: (refusal: WebStorageRefusal) => void = () => {}): () => Promise<WebStorageRefusal | undefined> {
  let kept: Promise<WebStorageRefusal | undefined> | undefined;
  return () => kept ??= check().then(
    preflight => ({ keep: lasting(preflight), refusal: preflight.supported ? undefined : { code: preflight.refusal?.code ?? 'runtime-unsupported', message: preflight.refusal?.message ?? 'The storage runtime preflight was refused.' } }),
    error => ({ keep: false, refusal: { code: 'runtime-unsupported', message: error instanceof Error ? error.message : String(error) } }),
  ).then(({ keep, refusal }) => {
    if (!keep) kept = undefined;
    if (refusal) report(refusal);
    return refusal;
  });
}
