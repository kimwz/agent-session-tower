import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitorServer } from '../../../server/http/server.js';
import type { Run, Session, Snapshot } from '../../../shared/types.js';

test('authenticated master HTTP requests get the role automatically, while ordinary calls and messages retain their contract', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-master-model-http-'));
  const calls: Array<{ path: string; input: any }> = [];
  const run: Run = { id: 'r', sessionId: 'codex:s', prompt: '', output: '', status: 'queued', createdAt: '' };
  const source: Snapshot = { sessions: [], runs: [], providers: [], scanning: false, hostname: 'fixture', version: 'test', updatedAt: '' };
  const masterSecret = 'a'.repeat(64);
  const app = createMonitorServer({ port: 0, clientDir: directory, master: { callerSecret: masterSecret, handle: async () => false }, backend: {
    snapshot: () => source, detail: async () => undefined, subscribe: () => () => {}, cancel: async () => {},
    createSession: async input => { calls.push({ path: 'create', input }); return { session: { id: run.sessionId } as Session, run }; },
    startAutoPrompt: async input => { calls.push({ path: 'auto', input }); return { id: input.requestId } as never; },
    api: async (operation, input) => { calls.push({ path: operation, input }); return {}; },
    enqueue: async (_id, _prompt, input) => { calls.push({ path: 'resume', input }); return run; },
  } });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.dispose(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const { token } = await fetch(`${base}/api/bootstrap`).then(r => r.json());
  const post = (path: string, input: unknown, master = true) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Agent-Monitor-Token': token, ...(master ? { 'X-Tower-Master': masterSecret } : {}) }, body: JSON.stringify(input) });
  const body = { cwd: directory, prompt: 'work' };
  assert.equal((await post('/api/sessions', body)).status, 202);
  assert.equal(calls[0].input.modelRole, 'master.worker'); assert.equal(calls[0].input.provider, undefined);
  assert.equal((await post('/api/sessions', body, false)).status, 400);
  assert.equal((await post('/api/sessions', { ...body, provider: 'codex' }, false)).status, 202);
  assert.equal(calls[1].input.modelRole, undefined);
  assert.equal((await post('/api/auto-prompts', { ...body, requestId: '11111111-1111-4111-8111-111111111111' })).status, 202);
  assert.equal(calls[2].input.modelRole, 'master.worker');
  assert.equal((await post('/api/v1/autoPrompt.submit', { ...body, requestId: '22222222-2222-4222-8222-222222222222' })).status, 200);
  assert.equal(calls[3].input.modelRole, 'master.worker');
  assert.equal((await post('/api/sessions/codex:s/messages', { prompt: 'continue' })).status, 202);
  assert.equal(calls[4].input.model, undefined); assert.equal(calls[4].input.effort, undefined);
});
