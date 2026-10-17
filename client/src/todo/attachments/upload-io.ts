import { REQUEST_TOKEN_HEADER } from '../../../../shared/app-identity';
import type { TodoChanges, TodoFile } from '../../../../shared/todo/types';
import { api, ApiError } from '../../common/lib';
import type { AppendResult, UploadIO } from './upload';

/** The Todo upload routes (`/api/todos/uploads…`). A 409 answer names where the upload really is. */
export function httpUploadIO(token: () => string): UploadIO {
  const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token() }, body: JSON.stringify(body) });
  const path = (id: string, rest = '') => `/api/todos/uploads/${encodeURIComponent(id)}${rest}`;
  /** A 409 with a numeric `offset` is an answer, not a failure. */
  async function atOffset<T>(request: () => Promise<Response>): Promise<T | { conflict: number }> {
    const response = await request();
    if (response.ok) return response.json() as Promise<T>;
    // best-effort: a body that is not JSON leaves the status alone to explain the failure.
    const body = await response.json().catch(() => ({})) as { error?: string; offset?: unknown; code?: string };
    if (response.status === 409 && typeof body.offset === 'number') return { conflict: body.offset };
    throw new ApiError(body.error || `요청을 처리하지 못했습니다 (${response.status})`, response.status, undefined, body.code);
  }
  return {
    start: (input, signal) => api<{ id: string; offset: number }>('/api/todos/uploads', { ...json(input), signal }),
    offset: async (id, signal) => (await api<{ offset: number }>(path(id), { signal })).offset,
    append: (id, offset, piece, signal) => atOffset<AppendResult>(() => fetch(path(id, `?offset=${offset}`), {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', [REQUEST_TOKEN_HEADER]: token() }, body: piece, signal,
    })),
    complete: (id, signal) => atOffset<{ file: TodoFile; changes: TodoChanges }>(() => fetch(path(id, '/complete'), { ...json({}), signal })),
    cancel: async id => { await api(path(id, '/cancel'), json({})); },
  };
}
