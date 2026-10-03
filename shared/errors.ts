/**
 * The one error type of Tower's own code. A domain says what kind of failure happened; how that is answered over HTTP
 * (`STATUS`) is the edge's business, and only edge and wire modules read statuses (`statusOf`, `fromStatus`). The
 * gate in tests/gates/import-boundaries.test.ts keeps it that way.
 *
 * Errors of other libraries, and the plain `Object.assign(new Error(m), { statusCode })` an older worker or host may
 * still send, keep working: `statusOf` and `kindOf` read their `statusCode` as the code they replace did.
 */

export type ErrorKind = 'invalid' | 'unauthorized' | 'forbidden' | 'not-found' | 'conflict' | 'gone' | 'too-large' | 'unsupported'
  | 'unprocessable' | 'locked' | 'rate-limited' | 'internal' | 'upstream' | 'unavailable' | 'storage-full';

/** Every delivery value in use: whether a refused request was admitted (`handoff`, `not-admitted`, `uncertain`), and a steering refusal (`rejected`). */
export type Disposition = 'not-admitted' | 'uncertain' | 'handoff' | 'rejected';

/** How each kind is answered over HTTP. One status per kind and one kind per status. */
export const STATUS: Readonly<Record<ErrorKind, number>> = {
  invalid: 400, unauthorized: 401, forbidden: 403, 'not-found': 404, conflict: 409, gone: 410, 'too-large': 413, unsupported: 415,
  unprocessable: 422, locked: 423, 'rate-limited': 429, internal: 500, upstream: 502, unavailable: 503, 'storage-full': 507,
};
const KIND_OF_STATUS: ReadonlyMap<number, ErrorKind> = new Map(Object.entries(STATUS).map(([kind, status]) => [status, kind as ErrorKind]));

export interface TowerErrorOptions {
  disposition?: Disposition;
  /** A status another process or computer answered that no kind names, kept exactly as it came (see `fromStatus`). */
  relayedStatus?: number;
  cause?: unknown;
}

export class TowerError extends Error {
  readonly kind: ErrorKind;
  declare readonly disposition?: Disposition;
  declare readonly relayedStatus?: number;
  constructor(kind: ErrorKind, message: string, options: TowerErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.kind = kind;
    if (options.disposition !== undefined) this.disposition = options.disposition;
    if ('relayedStatus' in options) this.relayedStatus = options.relayedStatus;
  }
}

const make = (kind: ErrorKind) => (message: string, options?: TowerErrorOptions) => new TowerError(kind, message, options);
export const invalid = make('invalid');
export const unauthorized = make('unauthorized');
export const forbidden = make('forbidden');
export const notFound = make('not-found');
export const conflict = make('conflict');
export const gone = make('gone');
export const tooLarge = make('too-large');
export const unsupported = make('unsupported');
export const unprocessable = make('unprocessable');
export const locked = make('locked');
export const rateLimited = make('rate-limited');
export const internal = make('internal');
export const upstream = make('upstream');
export const unavailable = make('unavailable');
export const storageFull = make('storage-full');

const relayed = (error: TowerError) => Object.hasOwn(error, 'relayedStatus');

/**
 * The kind of a failure, or undefined when it says none. Another error's `statusCode` is read the way Tower's
 * "has a status" checks read it: an empty one (0, NaN, missing) is none, a status no kind names reads as `upstream`.
 * Like those checks, it fails on a thrown null or undefined.
 */
export function kindOf(error: unknown): ErrorKind | undefined {
  if (error instanceof TowerError) return relayed(error) && !error.relayedStatus ? undefined : error.kind;
  const status = (error as { statusCode?: unknown }).statusCode;
  if (!status) return undefined;
  return (typeof status === 'number' ? KIND_OF_STATUS.get(status) : undefined) ?? 'upstream';
}

export const isKind = (error: unknown, kind: ErrorKind): boolean => kindOf(error) === kind;

/** Whether a failure already says how it is answered: a TowerError, or any object that carries a `statusCode`. */
export function isTyped(error: unknown): boolean {
  return error instanceof TowerError || (!!error && typeof error === 'object' && 'statusCode' in error);
}

/**
 * The HTTP status of a failure: its kind's, a relayed status as it came, or another error's `statusCode` as it is
 * (whatever its value). Undefined when there is none. Like the reads it replaces, it fails on a thrown null or undefined.
 */
export function statusOf(error: unknown): number | undefined {
  if (error instanceof TowerError) return relayed(error) ? error.relayedStatus : STATUS[error.kind];
  return (error as { statusCode?: number }).statusCode;
}

/**
 * A failure another process or computer answered with `status`: its kind when one names it, otherwise `upstream`
 * keeping the status exactly as received (an older peer may send 599, 0 or null), so it is answered on unchanged.
 */
export function fromStatus(status: unknown, message: string, options: Omit<TowerErrorOptions, 'relayedStatus'> = {}): TowerError {
  const kind = typeof status === 'number' ? KIND_OF_STATUS.get(status) : undefined;
  return kind ? new TowerError(kind, message, options) : new TowerError('upstream', message, { ...options, relayedStatus: status as number });
}
