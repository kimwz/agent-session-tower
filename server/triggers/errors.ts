import { TowerError, type ErrorKind } from '../../shared/errors.js';
/** An error with the HTTP status the API answers with. */
export const failure = (message: string, kind: ErrorKind = 'invalid') => new TowerError(kind, message);
