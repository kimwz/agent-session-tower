import test from 'node:test';
import assert from 'node:assert/strict';
import type { AutoPromptJob, AutoPromptRequest } from '../shared/types.js';
import { createAutoPromptAttempt, newerAutoPromptJob } from '../client/src/auto-prompt-request.js';
import { ApiError, type api } from '../client/src/lib.js';

const request = (): AutoPromptRequest => ({ requestId: 'request-1', provider: 'claude', prompt: '  Keep this request exactly.\n', attachments: [{ name: 'diagram.png', mimeType: 'image/png', data: 'aGVsbG8=' }] });
const job = (patch: Partial<AutoPromptJob> = {}): AutoPromptJob => ({ id: 'request-1', provider: 'claude', prompt: '  Keep this request exactly.\n', routerModel: 'opus', status: 'queued', createdAt: '2026-09-16T00:00:00Z', updatedAt: '2026-09-16T00:00:00Z', ...patch });

test('one auto prompt attempt coalesces concurrent sends and keeps the original serialized prompt and attachments', async () => {
  const bodies: string[] = [];
  let resolve!: (value: { job: AutoPromptJob }) => void;
  const response = new Promise<{ job: AutoPromptJob }>(done => { resolve = done; });
  const requestApi: typeof api = async <T>(_path: string, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return await response as T;
  };
  const original = request();
  const expected = JSON.stringify(original);
  const attempt = createAutoPromptAttempt(original, requestApi);
  original.prompt = 'changed after submission';
  original.attachments![0].data = 'changed';
  const first = attempt.send('token');
  const second = attempt.send('token');
  assert.equal(first, second);
  assert.deepEqual(bodies, [expected]);
  resolve({ job: job() });
  assert.deepEqual(await first, { job: job() });
});

test('a lost POST response is recovered through its request ID without a second dispatch', async () => {
  const calls: string[] = [];
  const accepted = job({ status: 'dispatching' });
  const requestApi: typeof api = async <T>(path: string, init?: RequestInit) => {
    calls.push(`${init?.method || 'GET'} ${path}`);
    if (init?.method === 'POST') throw new TypeError('connection reset');
    return { job: accepted } as T;
  };
  const result = await createAutoPromptAttempt(request(), requestApi).send('token');
  assert.deepEqual(result, { job: accepted });
  assert.deepEqual(calls, ['POST /api/auto-prompts', 'GET /api/auto-prompts/request-1']);
});

test('an uncertain admission retries the exact same request ID and bytes after a temporarily missing job', async () => {
  const bodies: string[] = [];
  const requestApi: typeof api = async <T>(_path: string, init?: RequestInit) => {
    if (init?.method !== 'POST') throw new ApiError('not found', 404);
    bodies.push(String(init.body));
    if (bodies.length === 1) throw new TypeError('network unavailable');
    return { job: job() } as T;
  };
  const attempt = createAutoPromptAttempt(request(), requestApi);
  const unknown = await attempt.send('token');
  assert.ok('uncertain' in unknown && unknown.uncertain);
  assert.deepEqual(await attempt.send('refreshed-token'), { job: job() });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(JSON.parse(bodies[1]).requestId, 'request-1');
});

test('a definitive validation rejection releases the draft but a server failure remains uncertain', async () => {
  for (const status of [400, 500]) {
    const requestApi: typeof api = async <T>(_path: string, init?: RequestInit): Promise<T> => {
      if (init?.method === 'POST') throw new ApiError('request failed', status);
      throw new ApiError('not found', 404);
    };
    const result = await createAutoPromptAttempt(request(), requestApi).send('token');
    assert.ok('uncertain' in result);
    assert.equal(result.uncertain, status === 500);
  }
});

test('a known job is recovered even when a POST returns an error', async () => {
  const accepted = job({ status: 'completed', sessionId: 'claude:chosen', runId: 'run-1' });
  const requestApi: typeof api = async <T>(_path: string, init?: RequestInit) => {
    if (init?.method === 'POST') throw new ApiError('request already exists', 409);
    return { job: accepted } as T;
  };
  assert.deepEqual(await createAutoPromptAttempt(request(), requestApi).send('token'), { job: accepted });
});

test('out-of-order snapshots never regress routing or unlock a dispatched request', () => {
  const session = job({ status: 'routing', stage: 'session', updatedAt: '2026-09-16T00:00:01Z' });
  assert.equal(newerAutoPromptJob(session, job()), session);
  assert.equal(newerAutoPromptJob(session, { ...session, stage: 'directory' }), session);
  const dispatching = job({ status: 'dispatching', updatedAt: '2026-09-16T00:00:02Z' });
  assert.equal(newerAutoPromptJob(session, dispatching), dispatching);
  assert.equal(newerAutoPromptJob(dispatching, session), dispatching);
  const completed = { ...dispatching, status: 'completed' as const, sessionId: 'claude:chosen', runId: 'run-1' };
  assert.equal(newerAutoPromptJob(dispatching, completed), completed);
  assert.equal(newerAutoPromptJob(completed, dispatching), completed);
});
