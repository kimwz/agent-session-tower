import { createRemoteAuthFixture } from '../../helpers/auth.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitorServer } from '../../../server/http/server.js';
import { AttachmentStore } from '../../../server/stores/attachments.js';
import { networkAccess } from '../../../server/http/remote-access.js';
import type { Session, Run, RunApprovalResponse, Snapshot } from '../../../shared/types.js';

const session: Session = {
  id: 'codex:example', nativeId: 'example', provider: 'codex', title: 'A real session', cwd: '/tmp/project', project: 'project',
  status: 'completed', statusReason: 'Turn complete', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  lastMessage: 'Done', messageCount: 2, isSubagent: false, resumable: true, filePath: '/private/native-log.jsonl',
};
const run: Run = { id: 'run-1', sessionId: session.id, prompt: 'Continue', status: 'queued', createdAt: new Date().toISOString(), output: '' };

test('tool approvals require authentication, reject modified inputs, and preserve backend stale-request errors', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-http-approvals-'));
  const decisions: Array<{ runId: string; approvalId: string; decision: RunApprovalResponse }> = [];
  const pending = new Set(['allow-request', 'deny-request', 'permission/1', 'questions', 'form', 'cancel']);
  const { auth, origins, cookie, fetch } = await createRemoteAuthFixture(dir);
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir,
    auth, remote: { origins }, backend: {
      snapshot: () => ({ sessions: [], runs: [], providers: [], scanning: false, hostname: 'test', version: 'test', updatedAt: new Date().toISOString() }),
      detail: async () => undefined, enqueue: async () => run, cancel: async () => {}, subscribe: () => () => {},
      respondToApproval: async (runId, approvalId, decision) => {
        if (runId !== run.id || !pending.delete(approvalId)) throw Object.assign(new Error('Approval is no longer pending.'), { statusCode: 409 });
        decisions.push({ runId, approvalId, decision });
        return { ...run, status: 'running' };
      },
    },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const { token } = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).json();
  const headers = { cookie, 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token };
  const endpoint = `${base}/api/runs/${run.id}/approvals/allow-request`;
  const send = (body: unknown, suppliedHeaders = headers, url = endpoint) => fetch(url, { method: 'POST', headers: suppliedHeaders, body: JSON.stringify(body) });
  assert.equal((await send({ decision: 'allow' }, { ...headers, cookie: '' })).status, 401);
  assert.equal((await send({ decision: 'allow' }, { ...headers, 'X-Agent-Monitor-Token': '' })).status, 403);
  assert.equal((await send({ decision: 'allow' }, { ...headers, Origin: 'https://attacker.example' } as typeof headers)).status, 403);
  assert.equal((await send({ decision: 'allow' }, { ...headers, 'Sec-Fetch-Site': 'cross-site' } as typeof headers)).status, 403);
  for (const body of [{}, { decision: 'always' }, { decision: true }, { decision: 'allow', input: { command: 'changed' } }, { decision: 'allow', updatedPermissions: [] },
    { decision: 'allow', answers: {} }, { answers: [] }, { answers: { question: { answers: 'not-an-array' } } }, { answers: { question: { answers: ['one'], extra: true } } },
    { action: 'accept' }, { action: 'accept', content: [], schema: {} }, { action: 'cancel', content: { hidden: 'value' } }, { action: 'accept', content: {}, _meta: {} }]) {
    assert.equal((await send(body)).status, 400);
  }
  assert.deepEqual(decisions, []);
  const allowed = await send({ decision: 'allow' });
  assert.equal(allowed.status, 200); assert.equal((await allowed.json()).run.status, 'running');
  assert.equal((await send({ decision: 'allow' })).status, 409);
  assert.equal((await send({ decision: 'deny' }, headers, `${base}/api/runs/${run.id}/approvals/deny-request`)).status, 200);
  assert.equal((await send({ decision: 'allow' }, headers, `${base}/api/runs/${run.id}/approvals/${encodeURIComponent('permission/1')}`)).status, 200);
  assert.equal((await send({ decision: 'allow' }, headers, `${base}/api/runs/another-run/approvals/unknown`)).status, 409);
  assert.deepEqual(decisions, [
    { runId: run.id, approvalId: 'allow-request', decision: 'allow' },
    { runId: run.id, approvalId: 'deny-request', decision: 'deny' },
    { runId: run.id, approvalId: 'permission/1', decision: 'allow' },
  ]);
  const responses: RunApprovalResponse[] = [{ answers: { question: { answers: ['Original choice'] } } }, { action: 'accept', content: { count: 0, enabled: false } }, { action: 'cancel', content: null }];
  for (const [index, id] of ['questions', 'form', 'cancel'].entries()) {
    assert.equal((await send(responses[index], headers, `${base}/api/runs/${run.id}/approvals/${id}`)).status, 200);
    assert.deepEqual(decisions.at(-1), { runId: run.id, approvalId: id, decision: responses[index] });
  }
});

test('local HTTP service protects session data and task mutations, and streams real snapshots', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-http-'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Agent Session Tower</title>');
  let enqueued = 0;
  let created = 0;
  const snapshot: Snapshot = { sessions: [session], providers: [], runs: [], scanning: false, updatedAt: new Date().toISOString(), hostname: 'test', version: '0.1.0' };
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, backend: {
    snapshot: () => snapshot,
    detail: async id => id === session.id ? { session, messages: [], hasMore: false } : undefined,
    enqueue: async (_id, prompt, request) => { enqueued++; return { ...run, prompt, ...(request?.model ? { model: request.model } : {}) }; },
    createSession: async input => { created++; return { session, run: { ...run, prompt: input.prompt, ...(input.model ? { model: input.model } : {}),
      ...(input.codexApprovalsReviewer ? { codexApprovalsReviewer: input.codexApprovalsReviewer } : {}) } }; },
    cancel: async () => {}, subscribe: () => () => {},
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });

  await t.test('serves UI and sanitized original session data', async () => {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Agent Session Tower/);
    assert.match(page.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
    const data = await (await fetch(`${base}/api/snapshot`)).json();
    assert.equal(data.sessions[0].title, session.title);
    assert.equal(data.sessions[0].filePath, undefined);
    const detail = await (await fetch(`${base}/api/sessions/${encodeURIComponent(session.id)}`)).json();
    assert.equal(detail.session.filePath, undefined);
  });
  await t.test('rejects DNS rebinding hosts and cross-site reads', async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${base}/api/snapshot`, { headers: { Host: `attacker.example:${port}` } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 403);
    assert.equal((await fetch(`${base}/api/bootstrap`, { headers: { Origin: 'https://attacker.example' } })).status, 403);
    assert.equal((await fetch(`${base}/api/snapshot`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    // A login in front of Tower redirects back from its own site: the page opens, the API stays closed.
    // fetch() sets its own Sec-Fetch-Mode, so these go out as a browser's navigation would.
    const open = (path: string, dest = 'document', method = 'GET') => new Promise<{ status?: number; body: string }>((resolve, reject) => {
      const req = request(`${base}${path}`, { method, headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': dest } }, res => {
        let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject); req.end();
    });
    const page = await open('/?session=x');
    assert.equal(page.status, 200);
    assert.match(page.body, /Agent Session Tower/);
    assert.equal((await open('/api/snapshot')).status, 403);
    assert.equal((await open('/', 'iframe')).status, 403);
    assert.equal((await open('/api/sessions', 'document', 'POST')).status, 403);
  });
  await t.test('requires per-process token and validates message size and JSON', async () => {
    const path = `${base}/api/sessions/${encodeURIComponent(session.id)}/messages`;
    assert.equal((await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"prompt":"test"}' })).status, 403);
    const { token } = await (await fetch(`${base}/api/bootstrap`)).json();
    const headers = { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token };
    assert.equal((await fetch(path, { method: 'POST', headers, body: '{bad' })).status, 400);
    assert.equal((await fetch(path, { method: 'POST', headers, body: JSON.stringify({ prompt: ' ' }) })).status, 400);
    assert.equal((await fetch(path, { method: 'POST', headers, body: JSON.stringify({ prompt: 'x'.repeat(32001) }) })).status, 400);
    assert.equal(enqueued, 0);
    const valid = await fetch(path, { method: 'POST', headers, body: JSON.stringify({ prompt: 'Continue the work' }) });
    assert.equal(valid.status, 202);
    assert.equal((await valid.json()).run.prompt, 'Continue the work');
    assert.equal(enqueued, 1);
  });
  await t.test('validates pagination and unknown paths', async () => {
    assert.equal((await fetch(`${base}/api/sessions/${session.id}?before=-1`)).status, 400);
    assert.equal((await fetch(`${base}/api/sessions/${session.id}?limit=10000`)).status, 400);
    assert.equal((await fetch(`${base}/api/sessions/missing`)).status, 404);
    assert.equal((await fetch(`${base}/api/missing`)).status, 404);
  });
  await t.test('model overrides are passed through and invalid values fail before backend admission', async () => {
    const { token } = await (await fetch(`${base}/api/bootstrap`)).json();
    const headers = { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token };
    const path = `${base}/api/sessions/${encodeURIComponent(session.id)}/messages`;
    const before = enqueued;
    for (const model of ['', '--config', 'with space', 42, null]) {
      assert.equal((await fetch(path, { method: 'POST', headers, body: JSON.stringify({ prompt: 'test', model }) })).status, 400);
    }
    assert.equal(enqueued, before);
    const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify({ prompt: 'test', model: 'provider/model-v2' }) });
    assert.equal(response.status, 202); assert.equal((await response.json()).run.model, 'provider/model-v2');
    const body = { provider: 'claude', cwd: '/tmp/project', prompt: 'new session' };
    assert.equal((await fetch(`${base}/api/sessions`, { method: 'POST', headers, body: JSON.stringify({ ...body, model: '--config' }) })).status, 400);
    assert.equal(created, 0);
    const create = await fetch(`${base}/api/sessions`, { method: 'POST', headers, body: JSON.stringify({ ...body, model: 'sonnet' }) });
    assert.equal(create.status, 202); assert.equal((await create.json()).run.model, 'sonnet'); assert.equal(created, 1);
  });
  await t.test('the chosen approval reviewer reaches session creation and unknown values are refused', async () => {
    const { token } = await (await fetch(`${base}/api/bootstrap`)).json();
    const headers = { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token };
    const body = { provider: 'codex', cwd: '/tmp/project', prompt: 'new session' };
    const before = created;
    for (const codexApprovalsReviewer of ['', 'auto', 'AUTO_REVIEW', 42, null]) {
      assert.equal((await fetch(`${base}/api/sessions`, { method: 'POST', headers, body: JSON.stringify({ ...body, codexApprovalsReviewer }) })).status, 400);
    }
    assert.equal(created, before);
    const chosen = await fetch(`${base}/api/sessions`, { method: 'POST', headers, body: JSON.stringify({ ...body, codexApprovalsReviewer: 'auto_review' }) });
    assert.equal(chosen.status, 202);
    assert.equal((await chosen.json()).run.codexApprovalsReviewer, 'auto_review');
    const claude = await fetch(`${base}/api/sessions`, { method: 'POST', headers, body: JSON.stringify({ ...body, provider: 'claude', codexApprovalsReviewer: 'auto_review' }) });
    assert.equal(claude.status, 202);
    assert.equal((await claude.json()).run.codexApprovalsReviewer, undefined);
    const plain = await fetch(`${base}/api/sessions`, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal((await plain.json()).run.codexApprovalsReviewer, undefined);
  });
  await t.test('SSE connects with an immediate sanitized snapshot', async () => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/events`, { signal: controller.signal });
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
    const reader = response.body!.getReader();
    let data = '';
    while (!data.includes('event: snapshot')) {
      const next = await reader.read();
      if (next.done) break;
      data += new TextDecoder().decode(next.value);
    }
    controller.abort();
    assert.match(data, /A real session/);
    assert.doesNotMatch(data, /native-log/);
  });
});

test('attachment uploads and downloads retain authentication, size limits, safe MIME handling and persisted metadata', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'monitor-http-attachments-'));
  await writeFile(join(directory, 'index.html'), '<!doctype html><title>Agent Session Tower</title>');
  const store = new AttachmentStore(directory); await store.start();
  const runs: Run[] = [];
  const { auth, origins, cookie, fetch } = await createRemoteAuthFixture(directory);
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: directory,
    auth, remote: { origins },
    backend: {
      snapshot: () => ({ sessions: [session], runs, providers: [], scanning: false, hostname: 'test', version: 'test', updatedAt: new Date().toISOString() }),
      detail: async () => undefined,
      enqueue: async (id, prompt, request) => {
        const prepared = await store.prepare(id, request);
        const accepted = { ...run, id: `run-${runs.length}`, sessionId: id, prompt, attachments: prepared.attachments };
        runs.push(accepted); return accepted;
      },
      attachment: async id => { const { metadata, content } = await store.read(id); return { metadata, content }; },
      cancel: async () => {}, subscribe: () => () => {},
    },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  const { token } = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).json();
  const headers = { cookie, 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token };
  const endpoint = `${base}/api/sessions/${session.id}/messages`;
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2S8AAAAASUVORK5CYII=';
  const body = JSON.stringify({ prompt: '', attachments: [
    { name: '붙여넣은 이미지.png', mimeType: 'image/png', data: png },
    { name: 'active.svg', mimeType: 'image/svg+xml', data: Buffer.from('<svg onload="alert(document.cookie)"></svg>').toString('base64') },
    { name: 'large.txt', mimeType: 'text/plain', data: Buffer.alloc(160_000, 'x').toString('base64') },
  ] });
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token }, body })).status, 401);
  const accepted = await fetch(endpoint, { method: 'POST', headers, body });
  assert.equal(accepted.status, 202);
  const saved = (await accepted.json()).run;
  assert.equal(saved.prompt, ''); assert.equal(saved.attachments.length, 3);
  assert.doesNotMatch(JSON.stringify(saved), /base64|\/attachments\//);
  const path = `${base}/api/attachments/${saved.attachments[0].id}`;
  assert.equal((await fetch(path)).status, 401);
  assert.equal((await fetch(path, { headers: { cookie, Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await fetch(path, { headers: { cookie, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const image = await fetch(path, { headers: { cookie } });
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.match(image.headers.get('content-disposition') || '', /^inline;/);
  assert.equal(Buffer.from(await image.arrayBuffer()).toString('base64'), png);
  const unsafe = await fetch(`${base}/api/attachments/${saved.attachments[1].id}`, { headers: { cookie } });
  assert.equal(unsafe.headers.get('content-type'), 'application/octet-stream');
  assert.match(unsafe.headers.get('content-disposition') || '', /^attachment;/);
  assert.match(unsafe.headers.get('content-security-policy') || '', /sandbox; default-src 'none'/);
  assert.equal(unsafe.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(`${base}/api/attachments/unknown`, { headers: { cookie } })).status, 404);
  assert.equal((await fetch(`${base}/api/sessions`, { method: 'POST', headers, body })).status, 413, 'other endpoints retain the original 128 KiB body limit');
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ prompt: '', attachmentIds: [saved.attachments[0].id] }) })).status, 202);
  assert.equal((await fetch(`${base}/api/sessions/another/messages`, { method: 'POST', headers, body: JSON.stringify({ prompt: '', attachmentIds: [saved.attachments[0].id] }) })).status, 404);
  for (const invalid of [{ prompt: '', attachments: [] }, { prompt: 'x', attachments: null }, { prompt: 'x', attachmentIds: 'bad' }, { prompt: 'x', attachments: [{ name: '../bad', mimeType: 'text/plain', data: '' }] }]) {
    assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(invalid) })).status, 400);
  }
});

test('steering requires authentication and preserves queued content and backend conflicts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-http-steer-'));
  const calls: string[] = [];
  const { auth, origins, cookie, fetch } = await createRemoteAuthFixture(dir);
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir,
    auth, remote: { origins }, backend: {
      snapshot: () => ({ sessions: [], runs: [], providers: [], scanning: false, hostname: 'test', version: 'test', updatedAt: new Date().toISOString() }),
      detail: async () => undefined, enqueue: async () => run, cancel: async () => {}, subscribe: () => () => {},
      steerRun: async id => {
        calls.push(id);
        if (id !== 'queued-request') throw Object.assign(new Error('No active turn.'), { statusCode: 409 });
        return { ...run, steering: { targetRunId: 'active-run', state: 'delivered', requestedAt: run.createdAt } };
      },
    },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { token } = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).json();
  const headers = { cookie, 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token };
  const endpoint = `${base}/api/runs/queued%2Drequest/steer`;
  assert.equal((await fetch(endpoint, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ prompt: 'replacement' }) })).status, 400);
  assert.deepEqual(calls, []);
  const response = await fetch(endpoint, { method: 'POST', headers, body: '{}' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).run.steering.state, 'delivered');
  assert.deepEqual(calls, ['queued-request']);
  assert.equal((await fetch(`${base}/api/runs/stale/steer`, { method: 'POST', headers, body: '{}' })).status, 409);
});

test('request bodies cannot choose who a run belongs to', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-http-origin-'));
  const received: unknown[][] = [];
  const snapshot: Snapshot = { sessions: [session], providers: [], runs: [], scanning: false, updatedAt: new Date().toISOString(), hostname: 'test', version: '0.1.0' };
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, backend: {
    snapshot: () => snapshot, detail: async () => undefined, cancel: async () => {}, subscribe: () => () => {},
    enqueue: async (...args) => { received.push(['enqueue', ...args]); return run; },
    createSession: async (...args) => { received.push(['create', ...args]); return { session, run }; },
    startAutoPrompt: async (...args) => { received.push(['autoPrompt', ...args]); throw new Error('unreachable'); },
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const { token } = await (await fetch(`${base}/api/bootstrap`)).json();
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token }, body: JSON.stringify(body) });
  const claim = { origin: { kind: 'slack', workflowId: '12345678-1234-4234-8234-123456789abc' }, untrustedInput: true, autoPromptId: '12345678-1234-4234-8234-123456789abd' };
  assert.equal((await post(`/api/sessions/${encodeURIComponent(session.id)}/messages`, { prompt: 'Hello', ...claim })).status, 202);
  assert.equal((await post('/api/sessions', { provider: 'codex', cwd: '/tmp/project', prompt: 'Hello', ...claim })).status, 202);
  assert.equal((await post('/api/auto-prompts', { requestId: '12345678-1234-4234-8234-123456789abe', provider: 'codex', prompt: 'Hello', ...claim })).status, 400);
  assert.deepEqual(received.map(call => call[0]), ['enqueue', 'create']);
  assert.doesNotMatch(JSON.stringify(received), /slack|untrustedInput|autoPromptId/, 'the backend never sees an origin claim from a request body');
});

test('Tower operations are posted by name with the page token and reach the worker unchanged', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-http-api-'));
  const calls: unknown[][] = [];
  const snapshot: Snapshot = { sessions: [], providers: [], runs: [], scanning: false, updatedAt: new Date().toISOString(), hostname: 'test', version: '0.1.0' };
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, backend: {
    snapshot: () => snapshot, detail: async () => undefined, enqueue: async () => run, cancel: async () => {}, subscribe: () => () => {},
    api: async (operation, input) => { calls.push([operation, input]); return { ok: operation }; },
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const { token } = await (await fetch(`${base}/api/bootstrap`)).json();
  const post = (path: string, body: unknown, headers: Record<string, string> = { 'X-Agent-Monitor-Token': token }) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const listed = await post('/api/v1/triggers.list', {});
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), { result: { ok: 'triggers.list' } });
  assert.equal((await post('/api/v1/triggers.list', {}, {})).status, 403, 'the page token is required');
  assert.equal((await post('/api/v1/sessions.destroy', {})).status, 404);
  assert.equal((await fetch(`${base}/api/v1/triggers.list`)).status, 404, 'operations are posted, never fetched');
  assert.deepEqual(calls, [['triggers.list', {}]]);
});

test('the owner can move a background-service Tower to a version or the latest release; the request is checked first', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-http-update-'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Agent Session Tower</title>');
  const asked: Array<string | undefined> = [];
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, service: true,
    towerUpdate: async version => { asked.push(version); return { status: 202, body: { update: { version: version ?? '1.40.0' } } }; },
    backend: { snapshot: () => ({ sessions: [], providers: [], runs: [], scanning: false, updatedAt: new Date().toISOString(), hostname: 'test', version: '1.39.0' }),
      detail: async () => undefined, enqueue: async () => run, cancel: async () => {}, subscribe: () => () => {} } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  assert.equal((await (await fetch(`${base}/api/health`)).json()).service, true);
  const { token } = await (await fetch(`${base}/api/bootstrap`)).json();
  const send = (body: unknown, headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token }) =>
    fetch(`${base}/api/tower/update`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await send({}, { 'Content-Type': 'application/json' })).status, 403);
  for (const body of [{ version: 'latest' }, { version: 1 }, { version: '1.40.0', force: true }]) assert.equal((await send(body)).status, 400);
  assert.equal((await send({})).status, 202);
  assert.equal((await send({ version: '1.40.1' })).status, 202);
  assert.deepEqual(asked, [undefined, '1.40.1']);
});

test('a tunnel serving a public URL reaches the login page, never the local owner bypass', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-http-public-url-'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Agent Session Tower</title>');
  const { auth } = await createRemoteAuthFixture(dir);
  const { origins } = networkAccess('127.0.0.1', 0, {}, ['https://tower.example.com']);
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, auth, remote: { origins }, backend: {
    snapshot: () => ({ sessions: [session], runs: [], providers: [], scanning: false, hostname: 'test', version: 'test', updatedAt: new Date().toISOString() }),
    detail: async () => undefined, enqueue: async () => run, cancel: async () => {}, subscribe: () => () => {},
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const get = (path: string, headers: Record<string, string>) => new Promise<{ status?: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject); req.end();
  });
  // cloudflared keeps the public Host and adds forwarding headers, as a proxy in front of Tower must.
  const tunnel = { Host: 'tower.example.com', 'X-Forwarded-For': '198.51.100.7', Origin: 'https://tower.example.com' };
  assert.equal((await get('/', tunnel)).status, 200);
  assert.equal((await get('/api/snapshot', tunnel)).status, 401);
  assert.equal(JSON.parse((await get('/api/auth/status', tunnel)).body).local, false);
  assert.equal((await get('/api/snapshot', { ...tunnel, Host: 'other.example.com' })).status, 403);
  assert.equal((await get('/api/snapshot', { ...tunnel, Origin: 'http://tower.example.com' })).status, 403);
  assert.equal((await get('/api/snapshot', { Host: `localhost:${port}` })).status, 200);
});
