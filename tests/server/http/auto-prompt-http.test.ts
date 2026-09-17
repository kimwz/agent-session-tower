import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitorServer } from '../../../server/http/server.js';
import { MAX_ATTACHMENTS } from '../../../shared/attachments.js';
import type { AutoPromptJob, AutoPromptRequest } from '../../../shared/types.js';

const id = '95257141-1ee4-4438-8374-c5507b156cd7';
const now = new Date().toISOString();
const pending: AutoPromptJob = { id, provider: 'claude', prompt: 'Continue the change', routerModel: 'opus', status: 'routing', stage: 'session', createdAt: now, updatedAt: now };

test('Auto Prompt uses the existing remote, origin and mutation protections before starting a router', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-auto-prompt-http-'));
  const submissions: AutoPromptRequest[] = [];
  let cancellations = 0;
  let job = { ...pending };
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir,
    remote: { password: 'router-fixture', origins: new Set() }, backend: {
      snapshot: () => ({ sessions: [], runs: [], providers: [], autoPrompts: [job], scanning: false, hostname: 'test', version: 'test', updatedAt: now }),
      detail: async () => undefined, enqueue: async () => { throw new Error('Not used'); }, cancel: async () => {}, subscribe: () => () => {},
      startAutoPrompt: async input => { submissions.push(input); return job; },
      getAutoPrompt: value => value === id ? job : undefined,
      cancelAutoPrompt: async value => {
        if (value !== id) throw Object.assign(new Error('Not found'), { statusCode: 404 });
        if (job.status === 'dispatching') throw Object.assign(new Error('Already sending'), { statusCode: 409 });
        cancellations++; job = { ...job, status: 'cancelled' }; return job;
      },
    },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const authorization = `Basic ${Buffer.from('monitor:router-fixture').toString('base64')}`;
  const { token } = await (await fetch(`${base}/api/bootstrap`, { headers: { authorization } })).json();
  const headers = { authorization, 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token };
  const request: AutoPromptRequest = { requestId: id, provider: 'claude', prompt: '  Continue the change\n' };
  const post = (body: unknown, extra: Record<string, string> = {}, suffix = '') => fetch(`${base}/api/auto-prompts${suffix}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });

  assert.equal((await post(request, { authorization: '' })).status, 401);
  assert.equal((await post(request, { 'X-Agent-Monitor-Token': '' })).status, 403);
  assert.equal((await post(request, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await post(request, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post(request, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await fetch(`${base}/api/auto-prompts/${id}`)).status, 401);
  assert.equal((await fetch(`${base}/api/auto-prompts/${id}`, { headers: { authorization, Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal(submissions.length, 0);

  for (const input of [
    { ...request, requestId: 'not-a-uuid' }, { ...request, provider: 'other' },
    { ...request, cwd: '../elsewhere' }, { ...request, cwd: '/tmp/\0path' },
    { ...request, model: 'other-model' }, { ...request, sessionId: 'choose-for-me' },
    { ...request, decision: { action: 'create' } }, { ...request, autoPromptId: 'bypass' },
    { ...request, prompt: '' }, { ...request, prompt: 'a'.repeat(32_001) },
    { ...request, attachments: {} }, { ...request, attachments: Array(MAX_ATTACHMENTS + 1).fill({}) },
  ]) {
    const response = await post(input);
    assert.ok([400, 413].includes(response.status), `${JSON.stringify(input).slice(0, 100)}: ${response.status}`);
  }
  assert.equal(submissions.length, 0);
  const submitted = await post(request);
  assert.equal(submitted.status, 202);
  assert.equal((await submitted.json()).job.id, id);
  assert.deepEqual(submissions[0], request, 'the exact prompt and idempotency key reach the coordinator');
  const files = [{ name: 'context.txt', mimeType: 'text/plain', data: Buffer.from('Project context').toString('base64') }];
  assert.equal((await post({ ...request, cwd: '/tmp/project', prompt: '', attachments: files })).status, 202);
  assert.deepEqual(submissions[1].attachments, files);
  assert.equal(submissions[1].cwd, '/tmp/project');
  const read = await fetch(`${base}/api/auto-prompts/${id}`, { headers: { authorization } });
  assert.equal(read.status, 200); assert.equal((await read.json()).job.stage, 'session');
  assert.equal((await fetch(`${base}/api/auto-prompts/00000000-0000-0000-0000-000000000000`, { headers: { authorization } })).status, 404);
  const snapshot = await (await fetch(`${base}/api/snapshot`, { headers: { authorization } })).json();
  assert.equal(snapshot.autoPrompts[0].id, id);
  assert.equal((await post({ decision: 'create' }, {}, `/${id}/cancel`)).status, 400);
  assert.equal(cancellations, 0);
  job = { ...job, status: 'dispatching' };
  assert.equal((await post({}, {}, `/${id}/cancel`)).status, 409);
  assert.equal(cancellations, 0);
  job = { ...job, status: 'routing' };
  assert.equal((await post({}, {}, `/${id}/cancel`)).status, 200);
  assert.equal(cancellations, 1);
});

test('an unavailable Auto Prompt backend returns a clear error without attempting normal session execution', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-auto-prompt-unavailable-'));
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, backend: {
    snapshot: () => ({ sessions: [], runs: [], providers: [], scanning: false, hostname: 'test', version: 'test', updatedAt: now }),
    detail: async () => undefined, enqueue: async () => { throw new Error('Must not dispatch'); }, cancel: async () => {}, subscribe: () => () => {},
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const { token } = await (await fetch(`${base}/api/bootstrap`)).json();
  const response = await fetch(`${base}/api/auto-prompts`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token }, body: JSON.stringify({ requestId: id, provider: 'codex', prompt: 'Continue' }) });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /Auto Prompt/);
});
