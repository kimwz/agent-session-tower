import test from 'node:test';
import assert from 'node:assert/strict';
import { request, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitorServer } from '../../../server/http/server.js';
import { AuthStore } from '../../../server/auth/store.js';
import { requestIdentity, sessionCookie } from '../../../server/http/auth.js';
import type { Session, Run, Snapshot } from '../../../shared/types.js';

function identity(address: string, host: string, headers: Record<string, string> = {}) {
  return requestIdentity({ socket: { remoteAddress: address }, headers: { host, ...headers } } as IncomingMessage);
}

test('only direct loopback requests bypass authentication; forwarding headers and remote Host never grant local access', () => {
  for (const address of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1']) {
    assert.equal(identity(address, 'localhost:8000').local, true);
    assert.equal(identity(address, 'tower.example:8000').local, false);
    for (const headers of [{ 'x-forwarded-for': '127.0.0.1' }, { forwarded: 'for=127.0.0.1' }, { 'x-real-ip': '127.0.0.1' }, { 'x-forwarded-host': 'localhost' }] as Record<string, string>[]) {
      assert.equal(identity(address, 'localhost:8000', headers).local, false);
    }
  }
  assert.equal(identity('192.0.2.10', 'localhost:8000').local, false);
  assert.equal(identity('::ffff:192.0.2.10', 'localhost:8000', { 'x-forwarded-for': '127.0.0.1' }).ip, '192.0.2.10');
  assert.equal(identity('::1', '[::1]:8000').local, true);
  for (const cookie of ['', 'tower_session=bad', `tower_session=${'a'.repeat(43)}; tower_session=${'b'.repeat(43)}`]) {
    assert.equal(sessionCookie({ headers: { cookie } } as IncomingMessage), '');
  }
});

test('remote form login, permanent IP blocks, local account management, and stream revocation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-remote-auth-'));
  await mkdir(join(dir, 'assets'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Agent Session Tower</title>');
  await writeFile(join(dir, 'assets/app.js'), 'console.log("monitor")');
  const password = 'unique-remote-password-for-this-test';
  const auth = new AuthStore(dir);
  await auth.start();
  const origins = new Set<string>();
  const session: Session = {
    id: 'codex:example', nativeId: 'example', provider: 'codex', title: 'Private remote session', cwd: '/tmp/project', project: 'project',
    status: 'completed', statusReason: 'Turn complete', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    lastMessage: 'Private result', messageCount: 2, isSubagent: false, resumable: true, filePath: '/private/native-log.jsonl',
  };
  const run: Run = { id: 'run-1', sessionId: session.id, prompt: 'Continue', status: 'queued', createdAt: new Date().toISOString(), output: '' };
  const snapshot: Snapshot = { sessions: [session], providers: [], runs: [], scanning: false, updatedAt: new Date().toISOString(), hostname: 'test', version: '0.1.0' };
  let reads = 0;
  let enqueued = 0;
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, auth, remote: { origins }, backend: {
    snapshot: () => { reads++; return snapshot; },
    detail: async id => { reads++; return id === session.id ? { session, messages: [], hasMore: false } : undefined; },
    enqueue: async (_id, prompt) => { enqueued++; return { ...run, prompt }; },
    cancel: async () => {}, subscribe: () => () => {},
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const publicHost = `remote.test:${port}`;
  const publicOrigin = `http://${publicHost}`;
  origins.add(publicOrigin);
  t.after(async () => {
    dispose(); auth.close(); await auth.flush();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const send = (path: string, headers: Record<string, string> = {}, method = 'GET', body?: string) => new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request(`${base}${path}`, { method, headers: { Host: publicHost, ...headers } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end(body);
  });
  const local = { Host: `localhost:${port}` };
  const status = JSON.parse((await send('/api/auth/status')).body);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => send(path, {
    'Content-Type': 'application/json', 'X-Agent-Monitor-Token': status.token, ...headers,
  }, 'POST', JSON.stringify(body));
  const login = (value = password, headers: Record<string, string> = {}) => post('/api/auth/login', { username: 'admin', password: value }, headers);
  let cookie = '';

  await t.test('login shell is public, application APIs are private, and no account means remote access stays closed', async () => {
    assert.equal(status.local, false); assert.equal(status.authenticated, false); assert.equal(status.configured, false);
    for (const path of ['/', '/assets/app.js']) assert.equal((await send(path)).status, 200);
    for (const [method, path] of [
      ['GET', '/api/bootstrap'], ['GET', '/api/snapshot'], ['GET', `/api/sessions/${session.id}`], ['GET', '/api/events'],
      ['GET', '/api/workspace/tree'], ['GET', '/api/workspace/file'], ['GET', '/api/workspace/terminals/00000000-0000-0000-0000-000000000000/events'],
      ['GET', '/api/attachments/private'], ['POST', `/api/sessions/${session.id}/messages`], ['POST', '/api/runs/run-1/cancel'],
      ['GET', '/api/unknown'], ['POST', '/api/health'], ['GET', '/api/auth/overview'],
    ]) {
      const response = await send(path, {}, method);
      assert.equal(response.status, 401, `${method} ${path}`);
      assert.doesNotMatch(response.body, /Private remote session|Private result|native-log|unique-remote-password/);
    }
    assert.equal(reads, 0); assert.equal(enqueued, 0);
    assert.equal((await login()).status, 503);
    assert.equal(auth.overview().attempts.length, 0);
    assert.equal((await send('/api/health')).status, 200);
  });

  await t.test('localhost opens without login and can configure a hashed account with mutation protection', async () => {
    assert.equal(JSON.parse((await send('/api/auth/status', local)).body).local, true);
    assert.equal((await send('/api/snapshot', local)).status, 200);
    assert.equal((await post('/api/auth/credentials', { username: 'admin', password }, { ...local, 'X-Agent-Monitor-Token': '' })).status, 403);
    assert.equal((await post('/api/auth/credentials', { username: 'admin', password }, local)).status, 200);
    assert.equal(auth.configured(), true);
    assert.equal(auth.overview().attempts.length, 0, 'local bypass does not fabricate successful attempts');
  });

  await t.test('login requires JSON and CSRF token, sets HttpOnly cookie, and protects local administration remotely', async () => {
    assert.equal((await login(password, { 'X-Agent-Monitor-Token': '' })).status, 403);
    assert.equal((await login(password, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await login(password, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await login(password, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await post('/api/auth/login', { username: 1, password })).status, 400);
    assert.equal(auth.overview().attempts.length, 0);
    const response = await login();
    assert.equal(response.status, 200);
    const header = response.headers['set-cookie']![0];
    assert.match(header, /HttpOnly/); assert.match(header, /SameSite=Strict/); assert.match(header, /Max-Age=43200/);
    cookie = header.split(';')[0];
    assert.doesNotMatch(response.body, /unique-remote-password|scrypt/);
    assert.equal(JSON.parse(response.body).authenticated, true);
    assert.equal((await send('/api/snapshot', { Cookie: cookie })).status, 200);
    for (const path of ['/api/auth/overview', '/api/auth/credentials', '/api/auth/unblock']) {
      assert.equal((await send(path, { Cookie: cookie })).status, 403);
    }
    const body = { prompt: 'Continue the remote task' };
    assert.equal((await post(`/api/sessions/${session.id}/messages`, body, { Cookie: cookie, 'X-Agent-Monitor-Token': '' })).status, 403);
    assert.equal((await post(`/api/sessions/${session.id}/messages`, body, { Cookie: cookie })).status, 202);
    assert.equal(enqueued, 1);
    const overview = JSON.parse((await send('/api/auth/overview', local)).body);
    assert.equal(overview.attempts[0].result, 'success');
    assert.equal(overview.attempts[0].ip, '127.0.0.1');
  });

  await t.test('rejects host/origin spoofing and Basic auth; forwarded headers cannot bypass login', async () => {
    for (const extra of [
      { Host: 'evil.example' }, { Origin: 'https://evil.example' }, { Origin: `https://${publicHost}` },
      { Origin: `${publicOrigin}/` }, { 'Sec-Fetch-Site': 'cross-site' },
      { Host: 'evil.example', 'X-Forwarded-Host': publicHost, 'X-Forwarded-Proto': 'http' },
    ] as Record<string, string>[]) assert.equal((await send('/api/bootstrap', { Cookie: cookie, ...extra })).status, 403);
    assert.equal((await send('/api/bootstrap', { ...local, 'X-Forwarded-For': '127.0.0.1' })).status, 401);
    assert.equal((await send('/api/bootstrap', { Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` })).status, 401);
    origins.add('https://monitor.example');
    const secureLogin = await login(password, { Host: 'monitor.example', Origin: 'https://monitor.example' });
    assert.equal(secureLogin.status, 200);
    assert.match(secureLogin.headers['set-cookie']![0], /; Secure/);
    for (const malformed of ['not a url', 'ftp://unsafe.example', 'https://unsafe.example/path', 'https://user:pass@unsafe.example']) origins.add(malformed);
    assert.equal((await send('/api/bootstrap', { Host: 'unsafe.example', Cookie: cookie })).status, 403);
  });

  async function stream() {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/events`, { headers: { Host: publicHost, Cookie: cookie, 'X-Forwarded-For': '192.0.2.1' }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /Private remote session/); assert.doesNotMatch(first, /native-log|unique-remote-password/);
    return { reader, controller };
  }

  await t.test('logout invalidates the session and ends its open event stream', async () => {
    const { reader, controller } = await stream();
    try {
      const result = await post('/api/auth/logout', {}, { Cookie: cookie });
      assert.equal(result.status, 200); assert.match(result.headers['set-cookie']![0], /Max-Age=0/);
      assert.equal((await reader.read()).done, true);
      assert.equal((await send('/api/snapshot', { Cookie: cookie })).status, 401);
    } finally { controller.abort(); }
    cookie = (await login()).headers['set-cookie']![0].split(';')[0];
  });

  await t.test('fifth cumulative failure blocks even correct credentials, revokes streams, and local unblock resets the counter', async () => {
    const { reader, controller } = await stream();
    try {
      assert.equal((await login('wrong')).status, 401);
      assert.equal((await login()).status, 200, 'success does not reset cumulative failures');
      for (let i = 0; i < 3; i++) assert.equal((await login('wrong')).status, 401);
      assert.equal((await login('wrong')).status, 403);
      assert.equal((await reader.read()).done, true);
      assert.equal((await send('/api/snapshot', { Cookie: cookie })).status, 401);
      assert.equal((await login()).status, 403);
      const overview = JSON.parse((await send('/api/auth/overview', local)).body);
      assert.equal(overview.blockedIps.length, 1);
      assert.equal(overview.blockedIps[0].failures, 5);
      assert.ok(overview.attempts.some((item: { result: string }) => item.result === 'failure'));
      assert.ok(overview.attempts.some((item: { result: string }) => item.result === 'success'));
      assert.equal(overview.attempts[0].result, 'blocked');
      assert.equal((await send('/api/snapshot', local)).status, 200, 'loopback administrator can recover blocked IP');
      assert.equal((await post('/api/auth/unblock', { ip: '127.0.0.1' }, local)).status, 200);
      const success = await login(); assert.equal(success.status, 200);
      cookie = success.headers['set-cookie']![0].split(';')[0];
      assert.equal(auth.overview().blockedIps.length, 0);
      assert.equal((await login('wrong')).status, 401);
    } finally { controller.abort(); }
  });

  await t.test('credential changes invalidate remote sessions and connected streams', async () => {
    const { reader, controller } = await stream();
    try {
      assert.equal((await post('/api/auth/credentials', { username: 'admin', password: 'another-strong-password' }, local)).status, 200);
      assert.equal((await reader.read()).done, true);
      assert.equal((await send('/api/snapshot', { Cookie: cookie })).status, 401);
      assert.equal((await login()).status, 401);
      assert.equal((await login('another-strong-password')).status, 200);
    } finally { controller.abort(); }
  });
});
