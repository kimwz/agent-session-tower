import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { api } from '../common/lib';

/** A change on the master's routes, with the page token like every change on Tower's pages. */
export const post = <T,>(path: string, token: string, body: unknown) => api<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token }, body: JSON.stringify(body) });
