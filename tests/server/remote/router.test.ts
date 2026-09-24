import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AutoPromptJob, Run, Session, Snapshot } from '../../../shared/types.js';
import type { Backend } from '../../../server/http/server.js';
import type { RequestContext } from '../../../server/http/request-context.js';
import { RemoteExclusionStore } from '../../../server/remote/exclusions.js';
import { createRemoteRouter } from '../../../server/remote/router.js';

const CONTROLLER = 'controllera1b2c3d4e5f6';
const REQUEST_ID = '0199a2b3-c4d5-7123-8abc-0123456789ab';
const now = new Date().toISOString();

async function fixture(t: TestContext, options: { coordinators?: string[] | null } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-remote-router-')));
  const open = join(root, 'open'), secret = join(root, 'secret');
  await mkdir(join(secret, 'deep'), { recursive: true });
  await mkdir(open, { recursive: true });
  const exclusions = new RemoteExclusionStore(join(root, 'state'));
  await mkdir(join(root, 'state'));
  await exclusions.start();
  await exclusions.add(secret);
  const session = (id: string, cwd: string, extra: Partial<Session> = {}): Session => ({ id, nativeId: id.split(':')[1], provider: 'codex', title: id, cwd, project: 'p',
    status: 'idle', statusReason: '', createdAt: now, updatedAt: now, lastMessage: '', messageCount: 1, isSubagent: false, resumable: true, ...extra });
  const sessions = [session('codex:open', open), session('codex:secret', secret), session('codex:deep', join(secret, 'deep')), session('codex:coordinator', open)];
  const runs: Run[] = [{ id: 'run-open', sessionId: 'codex:open', prompt: 'p', status: 'running', createdAt: now, output: '' },
    { id: 'run-secret', sessionId: 'codex:secret', prompt: 'p', status: 'running', createdAt: now, output: '' }];
  const jobs: AutoPromptJob[] = [{ id: '0199a2b3-c4d5-7123-8abc-000000000001', provider: 'codex', prompt: 'x', routerModel: 'r', status: 'routing', createdAt: now, updatedAt: now,
    origin: { kind: 'owner', controllerId: 'controllerffffffffffff' } }];
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const listeners = new Set<() => void>();
  const snapshot = (): Snapshot => ({ sessions, runs, providers: [], autoPrompts: jobs, groups: [{ cwd: open, title: 'Open', pinned: true }, { cwd: secret, title: 'Secret', pinned: true }],
    scanning: false, hostname: 'machine-b', version: 'test', updatedAt: now });
  const lookup = (id: string) => sessions.find(item => item.id === id || item.nativeId === id);
  const backend: Backend = {
    snapshot, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    detail: async id => { const found = lookup(id); return found ? { session: found, messages: [{ id: 'm', role: 'user', text: `hello from ${found.cwd}`, timestamp: now }], hasMore: false } : undefined; },
    session: lookup,
    coordinators: () => options.coordinators === null ? undefined : new Set(options.coordinators ?? ['codex:coordinator']),
    enqueue: async (id, prompt, attachments, context) => { calls.push({ method: 'enqueue', args: [id, prompt, attachments, context] }); return { ...runs[0], id: 'run-new', sessionId: id, prompt }; },
    createSession: async (input, context) => { calls.push({ method: 'createSession', args: [input, context] }); return { session: session('codex:new', input.cwd), run: { ...runs[0], id: 'run-created', sessionId: 'codex:new' } }; },
    startAutoPrompt: async (input, context) => { calls.push({ method: 'startAutoPrompt', args: [input, context] }); return { ...jobs[0], id: input.requestId, origin: context?.origin }; },
    getAutoPrompt: id => jobs.find(job => job.id === id),
    setGroup: async patch => { calls.push({ method: 'setGroup', args: [patch] }); return { cwd: patch.cwd, title: patch.title ?? '', pinned: true, hidden: true }; },
    attachment: async id => ({ metadata: { id, name: 'shot.png', mimeType: 'image/png', size: 4 }, content: Buffer.from('png!'), sessionId: id === '11111111-1111-4111-8111-111111111111' ? 'codex:open' : 'codex:secret' }),
    cancel: async id => { calls.push({ method: 'cancel', args: [id] }); },
  };
  const router = createRemoteRouter({ backend, exclusions });
  const server = createServer((req, res) => { void router.handle(req, res, { controllerId: CONTROLLER }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { router.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const call = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const response = await fetch(`${base}${path}`, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers: { 'content-type': 'application/json', ...init.headers },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
    const text = await response.text();
    let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: response.status, json, text, headers: response.headers };
  };
  return { root, open, secret, exclusions, calls, listeners, base, call };
}

test('a remote controller reads sessions, conversations and attachments only outside excluded folders', async t => {
  const f = await fixture(t);
  const view = await f.call('/api/snapshot');
  assert.equal(view.status, 200);
  assert.deepEqual(view.json.sessions.map((item: Session) => item.id), ['codex:open']);
  assert.deepEqual(view.json.runs.map((item: Run) => item.id), ['run-open']);
  assert.equal(view.text.includes(f.secret), false);
  assert.equal((await f.call('/api/sessions/codex:open')).status, 200);
  const hidden = await f.call('/api/sessions/codex:secret');
  const missing = await f.call('/api/sessions/codex:nothing');
  assert.equal(hidden.status, 404);
  assert.deepEqual(hidden.json, missing.json, 'an excluded session answers exactly like one that does not exist');
  assert.equal((await f.call('/api/sessions/secret')).status, 404, 'the native ID alias is judged as the same session');
  assert.equal((await f.call('/api/sessions/codex:deep')).status, 404, 'subfolders are excluded too');
  assert.equal((await f.call('/api/sessions/codex:coordinator')).status, 404, 'coordinator conversations stay on this machine');
  const image = await f.call('/api/attachments/11111111-1111-4111-8111-111111111111');
  assert.equal(image.status, 200);
  assert.match(image.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.equal((await f.call('/api/attachments/22222222-2222-4222-8222-222222222222')).status, 404);
});

test('a remote controller cannot start or continue work in an excluded folder', async t => {
  const f = await fixture(t);
  const headers = { 'x-tower-request-id': REQUEST_ID };
  assert.equal((await f.call('/api/sessions', { body: { provider: 'codex', cwd: join(f.secret, 'deep'), prompt: 'go' }, headers })).status, 404);
  assert.equal((await f.call('/api/sessions', { body: { provider: 'codex', cwd: join(f.secret, 'new-folder'), prompt: 'go' }, headers })).status, 404);
  assert.equal((await f.call('/api/sessions/codex:secret/messages', { body: { prompt: 'go' }, headers })).status, 404);
  assert.equal((await f.call('/api/sessions/codex:coordinator/messages', { body: { prompt: 'go' }, headers })).status, 404);
  assert.equal((await f.call('/api/auto-prompts', { body: { requestId: REQUEST_ID, provider: 'codex', cwd: f.secret, prompt: 'go' } })).status, 404);
  assert.equal((await f.call('/api/runs/run-secret/cancel', { body: {} })).status, 404);
  assert.deepEqual(f.calls, [], 'nothing reached the backend');
});

test('remote work carries the controller as its origin and a request ID, and is refused without one', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/sessions', { body: { provider: 'codex', cwd: f.open, prompt: 'go' } })).status, 400);
  const created = await f.call('/api/sessions', { body: { provider: 'codex', cwd: f.open, prompt: 'go' }, headers: { 'x-tower-request-id': REQUEST_ID } });
  assert.equal(created.status, 202);
  assert.deepEqual(f.calls[0].args[1], { origin: { kind: 'owner', controllerId: CONTROLLER }, requestId: REQUEST_ID } satisfies RequestContext);
  const sent = await f.call('/api/sessions/codex:open/messages', { body: { prompt: 'more' }, headers: { 'x-tower-request-id': REQUEST_ID } });
  assert.equal(sent.status, 202);
  assert.deepEqual((f.calls[1].args[3] as RequestContext).origin, { kind: 'owner', controllerId: CONTROLLER });
  const job = await f.call('/api/auto-prompts', { body: { requestId: REQUEST_ID, provider: 'codex', cwd: f.open, prompt: 'go' } });
  assert.equal(job.status, 202);
  assert.deepEqual(f.calls[2].args[1], { origin: { kind: 'owner', controllerId: CONTROLLER }, requestId: REQUEST_ID });
});

test('local management and routes not listed for remote controllers do not exist for them', async t => {
  const f = await fixture(t);
  for (const [path, method] of [['/api/auth/overview', 'GET'], ['/api/auth/credentials', 'POST'], ['/api/remote/exclusions', 'GET'], ['/api/remote/exclusions', 'POST'],
    ['/api/repositories', 'POST'], ['/api/workspace/tree?cwd=/', 'GET'], ['/api/workspace/terminals', 'POST'], ['/api/bootstrap', 'GET'], ['/api/health', 'GET'],
    ['/api/v1/triggers.list', 'POST'], ['/api/slack', 'GET'], ['/', 'GET'], ['/api/link/controllers', 'GET']] as const) {
    const response = await f.call(path, { method, ...(method === 'POST' ? { body: {} } : {}) });
    assert.equal(response.status, 404, `${method} ${path}`);
  }
  assert.deepEqual(f.exclusions.list(), [f.secret]);
});

test('a controller can rename a shared folder, but pins and screen hiding stay its own', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/groups', { body: { cwd: f.open, pinned: false } })).status, 400);
  assert.equal((await f.call('/api/groups', { body: { cwd: f.open, hidden: true } })).status, 400);
  assert.equal((await f.call('/api/groups', { body: { cwd: f.secret, title: 'Renamed' } })).status, 404);
  const renamed = await f.call('/api/groups', { body: { cwd: f.open, title: 'Renamed' } });
  assert.equal(renamed.status, 200);
  assert.deepEqual(renamed.json.group, { cwd: f.open, title: 'Renamed', pinned: true });
});

test('a request still choosing its folder is visible only to the controller that asked for it', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/auto-prompts/0199a2b3-c4d5-7123-8abc-000000000001')).status, 404);
});

test('nothing is served while the worker cannot name its coordinator conversations', async t => {
  const f = await fixture(t, { coordinators: null });
  const response = await f.call('/api/snapshot');
  assert.equal(response.status, 503);
  assert.equal(response.json.disposition, 'not-admitted');
});

test('the remote event stream drops a folder as soon as it is excluded', async t => {
  const f = await fixture(t);
  const frames: string[] = [];
  const url = new URL(`${f.base}/api/events?patch=1`);
  const stream = request({ host: url.hostname, port: url.port, path: `${url.pathname}${url.search}` });
  t.after(() => stream.destroy());
  const first = new Promise<void>((resolve, reject) => {
    stream.on('response', response => {
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { frames.push(chunk); if (frames.join('').includes('event: snapshot')) resolve(); });
    });
    stream.on('error', reject);
  });
  stream.end();
  await first;
  assert.match(frames.join(''), /codex:open/);
  await f.exclusions.add(f.open);
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('No frame after the exclusion.')), 3000);
    const check = setInterval(() => { if (frames.join('').includes('event: patch')) { clearInterval(check); clearTimeout(deadline); resolve(); } }, 20);
  });
  const patch = frames.join('').split('event: patch')[1];
  assert.match(patch, /"order":\[\]/, 'the open session left the stream');
});
