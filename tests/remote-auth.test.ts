import test from 'node:test';
import assert from 'node:assert/strict';
import { request, type IncomingHttpHeaders } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitorServer } from '../server/http/server.js';
import type { Session, Run, Snapshot } from '../shared/types.js';

test('remote HTTP access requires credentials and preserves host, origin, and mutation protections', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-remote-auth-'));
  await mkdir(join(dir, 'assets'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Agent Session Tower</title>');
  await writeFile(join(dir, 'assets/app.js'), 'console.log("monitor")');
  const password = 'unique-remote-password-for-this-test';
  const basic = (value: string) => `Basic ${Buffer.from(value).toString('base64')}`;
  const authorization = basic(`monitor:${password}`);
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
  let canceled = 0;
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, remote: { password, origins }, backend: {
    snapshot: () => { reads++; return snapshot; },
    detail: async id => { reads++; return id === session.id ? { session, messages: [], hasMore: false } : undefined; },
    enqueue: async (_id, prompt) => { enqueued++; return { ...run, prompt }; },
    cancel: async () => { canceled++; }, subscribe: () => () => {},
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const publicHost = `198.51.100.42:${port}`;
  const publicOrigin = `http://${publicHost}`;
  t.after(async () => {
    dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const send = (path: string, headers: Record<string, string> = {}, method = 'GET', body?: string) => new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request(`${base}${path}`, { method, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });

  await t.test('rejects every unauthenticated UI, data, stream, and mutation request before accessing the backend', async () => {
    for (const [method, path] of [
      ['GET', '/'], ['HEAD', '/'], ['GET', '/assets/app.js'], ['GET', '/api/bootstrap'],
      ['GET', '/api/snapshot'], ['GET', `/api/sessions/${session.id}`], ['GET', '/api/events'],
      ['POST', `/api/sessions/${session.id}/messages`], ['POST', '/api/runs/run-1/cancel'],
      ['GET', '/api/unknown'], ['POST', '/api/health'],
    ]) {
      const response = await send(path, {}, method);
      assert.equal(response.status, 401, `${method} ${path}`);
      assert.match(response.headers['www-authenticate'] || '', /^Basic realm="Agent Session Tower"/);
      assert.doesNotMatch(response.body, /Private remote session|Private result|native-log|unique-remote-password/);
    }
    assert.equal(reads, 0);
    assert.equal(enqueued, 0);
    assert.equal(canceled, 0);
    const health = await send('/api/health');
    assert.equal(health.status, 200);
    assert.deepEqual(Object.keys(JSON.parse(health.body)).sort(), ['application', 'bindHost', 'ok', 'pid', 'remoteAccess', 'version']);
    assert.equal(JSON.parse(health.body).bindHost, '127.0.0.1');
    assert.equal(JSON.parse(health.body).remoteAccess, true);
    assert.equal(reads, 0);
  });

  await t.test('rejects malformed, incorrect, and oversized credentials', async () => {
    for (const value of [
      'Basic', 'Basic !!!', 'Basic AA=', 'Basic Zg==extra', 'Basic AA== AA==',
      `Bearer ${password}`, basic(`admin:${password}`), basic(`Monitor:${password}`),
      basic('monitor:wrong'), basic(`monitor:${password}:extra`), `Basic ${'A'.repeat(2048)}`,
    ]) {
      assert.equal((await send('/api/bootstrap', { Authorization: value })).status, 401);
    }
    assert.equal(reads, 0);
  });

  await t.test('accepts explicitly configured public origins added after startup and keeps secrets out of responses', async () => {
    assert.equal((await send('/api/bootstrap', { Host: publicHost, Authorization: authorization })).status, 403);
    origins.add(publicOrigin);
    const headers = { Host: publicHost, Origin: publicOrigin, Authorization: authorization };
    assert.equal((await send('/', { ...headers, Authorization: authorization.replace('Basic', 'basic') })).status, 200);
    const assets = await send('/assets/app.js', headers);
    assert.equal(assets.status, 200);
    assert.equal(assets.headers['cache-control'], 'no-store');
    const bootstrap = await send('/api/bootstrap', headers);
    assert.equal(bootstrap.status, 200);
    assert.deepEqual(Object.keys(JSON.parse(bootstrap.body)), ['token']);
    assert.doesNotMatch(bootstrap.body, /unique-remote-password/);
    const token: string = JSON.parse(bootstrap.body).token;
    assert.match(token, /^[a-f0-9]{64}$/);
    const data = await send('/api/snapshot', headers);
    assert.equal(data.status, 200);
    assert.equal(JSON.parse(data.body).sessions[0].title, session.title);
    assert.equal(JSON.parse(data.body).sessions[0].filePath, undefined);
    const detail = await send(`/api/sessions/${session.id}`, headers);
    assert.equal(detail.status, 200);
    assert.equal(JSON.parse(detail.body).session.filePath, undefined);
    const messagePath = `/api/sessions/${session.id}/messages`;
    const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };
    const body = JSON.stringify({ prompt: 'Continue the remote task' });
    assert.equal((await send(messagePath, jsonHeaders, 'POST', body)).status, 403);
    assert.equal(enqueued, 0);
    const mutationHeaders = { ...jsonHeaders, 'X-Agent-Monitor-Token': token };
    assert.equal((await send(messagePath, mutationHeaders, 'POST', body)).status, 202);
    assert.equal(enqueued, 1);
    assert.equal((await send('/api/runs/run-1/cancel', mutationHeaders, 'POST', '{}')).status, 200);
    assert.equal(canceled, 1);
    assert.equal((await send('/api/health', { Host: publicHost })).status, 200);
  });

  await t.test('rejects untrusted host, origin, cross-site, and forwarded-header attempts even with valid credentials', async () => {
    const headers = { Host: publicHost, Authorization: authorization };
    for (const extra of [
      { Host: 'evil.example' }, { Origin: 'https://evil.example' },
      { Origin: `https://${publicHost}` }, { Origin: `${publicOrigin}/` },
      { 'Sec-Fetch-Site': 'cross-site' },
      { Host: 'evil.example', 'X-Forwarded-Host': publicHost, 'X-Forwarded-Proto': 'http' },
      { Origin: 'https://evil.example', Forwarded: `host=${publicHost};proto=http` },
    ] as Record<string, string>[]) {
      assert.equal((await send('/api/bootstrap', { ...headers, ...extra })).status, 403);
    }
    origins.add('https://monitor.example');
    assert.equal((await send('/api/bootstrap', { Host: 'monitor.example', Origin: 'https://monitor.example', Authorization: authorization })).status, 200);
    assert.equal((await send('/api/bootstrap', { Host: 'monitor.example', Origin: 'http://monitor.example', Authorization: authorization })).status, 403);
    for (const malformed of ['not a url', 'ftp://unsafe.example', 'https://unsafe.example/path', 'https://user:pass@unsafe.example']) origins.add(malformed);
    assert.equal((await send('/api/bootstrap', { Host: 'unsafe.example', Authorization: authorization })).status, 403);
    origins.delete(publicOrigin);
    assert.equal((await send('/api/bootstrap', headers)).status, 403);
  });

  await t.test('streams sanitized session data after authentication', async () => {
    const controller = new AbortController();
    try {
      const response = await fetch(`${base}/api/events`, { headers: { Authorization: authorization }, signal: controller.signal });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
      const reader = response.body!.getReader();
      let data = '';
      while (!data.includes('event: snapshot')) {
        const next = await reader.read();
        if (next.done) break;
        data += new TextDecoder().decode(next.value);
      }
      assert.match(data, /Private remote session/);
      assert.doesNotMatch(data, /native-log|unique-remote-password/);
    } finally { controller.abort(); }
  });
});
