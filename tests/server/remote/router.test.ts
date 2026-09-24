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

async function fixture(t: TestContext, options: { coordinators?: string[] | null; beforeDetail?: () => Promise<void>; job?: (job: AutoPromptJob) => AutoPromptJob; beforeCancel?: () => Promise<void>; repositories?: boolean } = {}) {
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
  // A conversation Tower created keeps its own ID; its native ID is an alias for it.
  const sessions = [session('codex:open', open), { ...session('codex:monitor-7d1e0c2a-5b8f-4e31-9a6d-2f4c8b1e9a70', secret), nativeId: 'b3f1c9d2-8a47-4e6b-9c15-3d2e7f0a1b64' },
    session('codex:deep', join(secret, 'deep')), session('codex:coordinator', open)];
  let coordinatorIds = options.coordinators;
  const runs: Run[] = [{ id: 'run-open', sessionId: 'codex:open', prompt: 'p', status: 'running', createdAt: now, output: '' },
    { id: 'run-secret', sessionId: sessions[1].id, prompt: 'p', status: 'running', createdAt: now, output: '' }];
  const jobs: AutoPromptJob[] = [{ id: '0199a2b3-c4d5-7123-8abc-000000000001', provider: 'codex', prompt: 'x', routerModel: 'r', status: 'routing', createdAt: now, updatedAt: now,
    origin: { kind: 'owner', controllerId: 'controllerffffffffffff' } },
    { id: '0199a2b3-c4d5-7123-8abc-000000000002', provider: 'codex', prompt: 'routing into the open folder', routerModel: 'r', status: 'routing', createdAt: now, updatedAt: now, cwd: open,
      origin: { kind: 'owner', controllerId: CONTROLLER } }];
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const listeners = new Set<() => void>();
  const repository = (cwd: string, root = cwd) => ({ cwd, root, branch: 'main', upstream: 'origin/main', ahead: 0, behind: 1, changes: 0, checkedAt: now, lastAction: { kind: 'pull' as const, ok: false, error: `could not pull ${root}`, at: now } });
  const snapshot = (): Snapshot => ({ sessions, runs, providers: [], autoPrompts: jobs, groups: [{ cwd: open, title: 'Open', pinned: true }, { cwd: secret, title: 'Secret', pinned: true }],
    ...(options.repositories ? { repositories: [repository(open), repository(join(open, 'nested'), secret)] } : {}), scanning: false, hostname: 'machine-b', version: 'test', updatedAt: now });
  const lookup = (id: string) => sessions.find(item => item.id === id || `${item.provider}:${item.nativeId}` === id);
  const backend: Backend = {
    snapshot, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    detail: async id => { await options.beforeDetail?.(); const found = lookup(id); return found ? { session: found, messages: [{ id: 'm', role: 'user', text: `hello from ${found.cwd}`, timestamp: now }], hasMore: false } : undefined; },
    session: lookup,
    coordinators: () => coordinatorIds === null ? undefined : new Set(coordinatorIds ?? ['codex:coordinator']),
    enqueue: async (id, prompt, attachments, context) => { calls.push({ method: 'enqueue', args: [id, prompt, attachments, context] }); return { ...runs[0], id: 'run-new', sessionId: id, prompt }; },
    createSession: async (input, context) => { calls.push({ method: 'createSession', args: [input, context] }); return { session: session('codex:new', input.cwd), run: { ...runs[0], id: 'run-created', sessionId: 'codex:new' } }; },
    startAutoPrompt: async (input, context) => {
      calls.push({ method: 'startAutoPrompt', args: [input, context] });
      const job: AutoPromptJob = { ...jobs[0], id: input.requestId, origin: context?.origin, ...(input.cwd ? { cwd: input.cwd } : {}) };
      return options.job ? options.job(job) : job;
    },
    getAutoPrompt: id => jobs.find(job => job.id === id),
    cancelAutoPrompt: async id => { await options.beforeCancel?.(); return { ...jobs.find(job => job.id === id)!, status: 'cancelled' }; },
    setGroup: async patch => { calls.push({ method: 'setGroup', args: [patch] }); return { cwd: patch.cwd, title: patch.title ?? '', pinned: true, hidden: true }; },
    attachment: async id => ({ metadata: { id, name: 'shot.png', mimeType: 'image/png', size: 4 }, content: Buffer.from('png!'), sessionId: id === '11111111-1111-4111-8111-111111111111' ? 'codex:open' : sessions[1].id }),
    cancel: async id => { calls.push({ method: 'cancel', args: [id] }); },
    ...(options.repositories ? { repositoryAction: async (cwd: string, action: string) => { calls.push({ method: 'repositoryAction', args: [cwd, action] }); return repository(cwd); } } : {}),
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
  return { root, open, secret, exclusions, calls, listeners, base, call, secretSession: sessions[1], setCoordinators: (value: string[] | null) => { coordinatorIds = value; } };
}

test('a remote controller reads sessions, conversations and attachments only outside excluded folders', async t => {
  const f = await fixture(t);
  const view = await f.call('/api/snapshot');
  assert.equal(view.status, 200);
  assert.deepEqual(view.json.sessions.map((item: Session) => item.id), ['codex:open']);
  assert.deepEqual(view.json.runs.map((item: Run) => item.id), ['run-open']);
  assert.equal(view.text.includes(f.secret), false);
  assert.equal((await f.call('/api/sessions/codex:open')).status, 200);
  const hidden = await f.call(`/api/sessions/${f.secretSession.id}`);
  const missing = await f.call('/api/sessions/codex:nothing');
  assert.equal(hidden.status, 404);
  assert.deepEqual(hidden.json, missing.json, 'an excluded session answers exactly like one that does not exist');
  assert.equal((await f.call(`/api/sessions/codex:${f.secretSession.nativeId}`)).status, 404, 'the native ID alias is judged as the same session');
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
  assert.equal((await f.call(`/api/sessions/${f.secretSession.id}/messages`, { body: { prompt: 'go' }, headers })).status, 404);
  assert.equal((await f.call(`/api/sessions/codex:${f.secretSession.nativeId}/messages`, { body: { prompt: 'go' }, headers })).status, 404);
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
    ['/api/workspace/tree?cwd=/', 'GET'], ['/api/workspace/terminals', 'POST'], ['/api/bootstrap', 'GET'], ['/api/health', 'GET'],
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

test('an excluded folder and a folder Tower does not list look the same to a remote controller', async t => {
  const f = await fixture(t);
  const excluded = await f.call('/api/auto-prompts', { body: { requestId: REQUEST_ID, provider: 'codex', cwd: join(f.secret, 'deep'), prompt: 'go' } });
  const unlisted = await f.call('/api/auto-prompts', { body: { requestId: REQUEST_ID, provider: 'codex', cwd: join(f.root, 'unlisted'), prompt: 'go' } });
  assert.equal(excluded.status, 404);
  assert.deepEqual(unlisted, { ...unlisted, status: 404, json: excluded.json });
});

test('a view that cannot be built safely ends the stream instead of stopping this Tower', async t => {
  const f = await fixture(t);
  const url = new URL(`${f.base}/api/events`);
  const ended = new Promise<void>((resolve, reject) => {
    const stream = request({ host: url.hostname, port: url.port, path: url.pathname });
    stream.on('response', response => {
      response.resume();
      response.once('data', () => {
        // The worker is being replaced and cannot name its coordinator conversations for a moment.
        f.setCoordinators(null);
        for (const listener of f.listeners) listener();
      });
      response.on('end', () => resolve());
    });
    stream.on('error', reject);
    stream.end();
  });
  await ended;
  f.setCoordinators(['codex:coordinator']);
  assert.equal((await f.call('/api/snapshot')).status, 200, 'this Tower keeps serving');
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

test('a folder excluded while a request waits is not in its answer, and a retry never reveals it', async t => {
  let exclude: (() => Promise<void>) | undefined;
  const f = await fixture(t, { beforeDetail: async () => { await exclude?.(); } });
  exclude = async () => { await f.exclusions.add(f.open); };
  assert.equal((await f.call('/api/sessions/codex:open')).status, 404, 'the conversation is not sent after its folder was excluded mid-request');
});

test('cancelling an Auto Prompt whose folder was excluded meanwhile answers not found', async t => {
  let exclude: (() => Promise<void>) | undefined;
  const f = await fixture(t, { beforeCancel: async () => { await exclude?.(); } });
  exclude = async () => { await f.exclusions.add(f.open); };
  const response = await f.call('/api/auto-prompts/0199a2b3-c4d5-7123-8abc-000000000002/cancel', { body: {} });
  assert.equal(response.status, 404);
  assert.equal(response.text.includes('routing into the open folder'), false);
});

test('a retried Auto Prompt that ended up in a folder excluded since answers not found', async t => {
  let secret = '';
  const f = await fixture(t, { job: job => ({ ...job, status: 'completed', decision: { action: 'create', cwd: secret, reason: 'secret reason' } }) });
  secret = join(f.secret, 'deep');
  const response = await f.call('/api/auto-prompts', { body: { requestId: REQUEST_ID, provider: 'codex', prompt: 'go' } });
  assert.equal(response.status, 404);
  assert.equal(response.text.includes('secret reason'), false);
});

test('changing the exclusion list ends the remote event stream, and the next one starts without the folder', async t => {
  const f = await fixture(t);
  const open = () => new Promise<{ frames: string[]; ended: Promise<void>; destroy: () => void }>((resolve, reject) => {
    const url = new URL(`${f.base}/api/events?patch=1`);
    const frames: string[] = [];
    let resolved = false;
    const stream = request({ host: url.hostname, port: url.port, path: `${url.pathname}${url.search}` });
    stream.on('response', response => {
      response.setEncoding('utf8');
      const ended = new Promise<void>(done => response.on('end', () => done()));
      response.on('data', (chunk: string) => { frames.push(chunk); if (!resolved && frames.join('').includes('event: snapshot')) { resolved = true; resolve({ frames, ended, destroy: () => stream.destroy() }); } });
    });
    stream.on('error', reject);
    stream.end();
  });
  const first = await open();
  t.after(() => first.destroy());
  assert.match(first.frames.join(''), /codex:open/);
  await f.exclusions.add(f.open);
  await first.ended;
  assert.equal(first.frames.join('').includes('event: patch'), false, 'no frame built from the old list went out');
  const second = await open();
  t.after(() => second.destroy());
  assert.equal(second.frames.join('').includes('codex:open'), false);
});

test('an Auto Prompt answer looks at its folder again now, even right after a symlink was pointed at an excluded folder', async t => {
  let link = '';
  const f = await fixture(t, { job: job => ({ ...job, status: 'completed', decision: { action: 'create', cwd: link, reason: 'fits' } }) });
  const { symlink, rm: remove } = await import('node:fs/promises');
  link = join(f.root, 'current');
  await symlink(f.open, link);
  // Looked at once while the link still pointed at a shared folder.
  await f.exclusions.prepare([link]);
  assert.equal(f.exclusions.matcher().excludes(link), false);
  await remove(link);
  await symlink(f.secret, link);
  const response = await f.call('/api/auto-prompts', { body: { requestId: '0199a2b3-c4d5-7123-8abc-000000000003', provider: 'codex', prompt: 'go' } });
  assert.equal(response.status, 404, 'no wait for the regular recheck');
});

test('a controller can sync a shared folder’s branch, never one reaching into an excluded folder', async t => {
  const f = await fixture(t, { repositories: true });
  await mkdir(join(f.open, 'nested'));
  const pulled = await f.call('/api/repositories', { body: { cwd: f.open, action: 'pull' } });
  assert.equal(pulled.status, 200);
  assert.deepEqual(pulled.json.repository.lastAction, { kind: 'pull', ok: false, at: pulled.json.repository.lastAction.at }, 'git’s own words, which can name other folders, stay here');
  assert.equal((await f.call('/api/repositories', { body: { cwd: f.secret, action: 'refresh' } })).status, 404);
  assert.equal((await f.call('/api/repositories', { body: { cwd: join(f.open, 'nested'), action: 'push' } })).status, 404, 'a repository whose root is excluded is not pushed');
  assert.equal((await f.call('/api/repositories', { body: { cwd: join(f.open, 'unknown'), action: 'pull' } })).status, 404, 'a pull needs a repository Tower already knows');
  assert.equal((await f.call('/api/repositories', { body: { cwd: f.open, action: 'rebase' } })).status, 400);
  assert.deepEqual(f.calls.filter(call => call.method === 'repositoryAction').map(call => call.args), [[f.open, 'pull']]);
});
