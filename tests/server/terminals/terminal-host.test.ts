import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { startTerminalHost, terminalHostPaths } from '../../../server/terminals/host.js';
import { TerminalHostClient } from '../../../server/terminals/client.js';
import { runnerPaths } from '../../../server/runs/runner-protocol.js';
import { WorkspaceTerminals, type WorkspacePty, type WorkspaceTerminalBackend } from '../../../server/workspace-terminals.js';
import { until } from '../../helpers/until.ts';
import { statusOf } from '../../../shared/errors.js';

class Pty implements WorkspacePty {
  written: string[] = [];
  killed = 0;
  data = new Set<(data: string) => void>();
  exits = new Set<(event: { exitCode: number }) => void>();
  write(data: string) { this.written.push(data); }
  resize() {}
  kill() { this.killed++; }
  onData(listener: (data: string) => void) { this.data.add(listener); return { dispose: () => { this.data.delete(listener); } }; }
  onExit(listener: (event: { exitCode: number }) => void) { this.exits.add(listener); return { dispose: () => { this.exits.delete(listener); } }; }
  output(data: string) { for (const listener of this.data) listener(data); }
}

async function fixture(t: TestContext, options: { idleMs?: number; legacy?: WorkspaceTerminalBackend; keepIntervalMs?: number } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-terminal-host-'));
  const ptys: Pty[] = [];
  const terminals = new WorkspaceTerminals({ keepAliveOnDisconnect: true, env: { SHELL: '/bin/fixture-shell' }, platform: 'darwin', spawnPty: () => { const pty = new Pty(); ptys.push(pty); return pty; } });
  let idle = 0;
  const host = await startTerminalHost({ stateDir, terminals, idleMs: options.idleMs, keepIntervalMs: options.keepIntervalMs, onIdle: options.idleMs === undefined ? undefined : () => { idle++; terminals.dispose(); } });
  const client = new TerminalHostClient({ stateDir, legacy: options.legacy, hostEntry: '/nonexistent/must-not-spawn.js', startupTimeoutMs: 500 });
  t.after(async () => { client.dispose(); await host.close(); terminals.dispose(); await rm(stateDir, { recursive: true, force: true }); await rm((await runnerPaths(stateDir)).directory, { recursive: true, force: true }); });
  return { stateDir, ptys, terminals, host, client, idle: () => idle };
}

/** Streams one terminal through the client the way the web server does. */
async function stream(client: TerminalHostClient, id: string, until: RegExp): Promise<string> {
  const server = createServer((_req, res) => { void client.attach(id, res).catch(error => { res.writeHead(statusOf(error) || 500); res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: (server.address() as { port: number }).port }, res => {
        let text = '';
        res.on('data', chunk => { text += chunk; if (until.test(text)) { req.destroy(); resolve(text); } });
        res.on('end', () => resolve(text));
      });
      req.on('error', reject);
      req.end();
    });
  } finally { server.closeAllConnections(); server.close(); }
}

test('shells run in the terminal host and replay their output to a reconnecting page', async t => {
  const f = await fixture(t);
  const { id } = await f.client.create('/fixture', 80, 24);
  await f.client.input(id, 'pwd\r');
  assert.deepEqual(f.ptys[0].written, ['pwd\r']);
  f.ptys[0].output('/fixture\r\n');
  assert.match(await stream(f.client, id, /fixture/), /event: output\ndata: \{"data":"\/fixture\\r\\n"\}/);
  await f.client.close(id);
  assert.equal(f.ptys[0].killed, 1);
});

test('the terminal host answers only with its own credential', async t => {
  const f = await fixture(t);
  const paths = await terminalHostPaths(f.stateDir);
  const status = (authorization: string) => new Promise<number>((resolve, reject) => {
    const req = request({ socketPath: paths.socket, method: 'POST', path: '/rpc', headers: { authorization } }, res => { res.resume(); resolve(res.statusCode!); });
    req.on('error', reject); req.end('{}');
  });
  assert.equal(await status('Bearer wrong'), 403);
  const runnerToken = await readFile((await runnerPaths(f.stateDir)).token, 'utf8').catch(() => 'absent');
  assert.equal(await status(`Bearer ${runnerToken}`), 403, 'the execution worker credential does not open shells');
  assert.equal(await status(`Bearer ${await readFile(paths.token, 'utf8')}`), 200);
});

test('a running host writes its credential again when /tmp cleaning removed it', async t => {
  const f = await fixture(t, { keepIntervalMs: 20 });
  const paths = await terminalHostPaths(f.stateDir);
  const { id } = await f.client.create('/fixture', 80, 24);
  const token = await readFile(paths.token, 'utf8');
  await rm(paths.token);
  await until(() => existsSync(paths.token) && readFileSync(paths.token, 'utf8') === token);
  assert.equal((await stat(paths.token)).mode & 0o777, 0o600);
  await f.client.input(id, 'ls\r');
  assert.deepEqual(f.ptys[0].written, ['ls\r']);
});

test('shells an older worker still owns stay reachable until they are closed', async t => {
  const calls: string[] = [];
  const legacy: WorkspaceTerminalBackend = {
    create: async () => { throw new Error('new shells never start in the old worker'); },
    attach: () => { calls.push('attach'); throw Object.assign(new Error('gone'), { statusCode: 404 }); },
    input: id => { calls.push(`input:${id}`); }, resize: id => { calls.push(`resize:${id}`); }, close: id => { calls.push(`close:${id}`); }, dispose: () => {},
  };
  const f = await fixture(t, { legacy });
  const old = '11111111-1111-4111-8111-111111111111';
  await f.client.input(old, 'ls\r');
  await f.client.resize(old, 100, 30);
  await f.client.close(old);
  assert.deepEqual(calls, [`input:${old}`, `resize:${old}`, `close:${old}`]);
  const { id } = await f.client.create('/fixture', 80, 24);
  await f.client.input(id, 'echo host\r');
  assert.equal(calls.length, 3, 'shells the host owns never reach the old worker');
  await f.host.close();
  await f.client.input(old, 'still reachable\r');
  assert.deepEqual(calls.at(-1), `input:${old}`, 'without a running host every known shell is the old worker’s');
});

test('the terminal host leaves once no shell is open and no page has called for a while', async t => {
  const f = await fixture(t, { idleMs: 0 });
  const { id } = await f.client.create('/fixture', 80, 24);
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(f.idle(), 0, 'an open shell keeps its host');
  await f.client.close(id);
  await until(() => f.idle() === 1);
});

test('the worker credential cannot reach shells and the terminal credential cannot reach the worker', async t => {
  const f = await fixture(t);
  const { RunManager } = await import('../../../server/runs/manager.js');
  const { startRunnerHost } = await import('../../../server/runs/worker.js');
  const { EventEmitter } = await import('node:events');
  const runs = new RunManager({ stateDir: f.stateDir, getSession: () => undefined, refreshSessions: async () => {}, pollMs: 60_000, findExecutable: async () => undefined });
  await runs.start();
  const sessions = Object.assign(new EventEmitter(), { list: () => [] }) as unknown as import('../../../server/sessions/service.js').SessionService;
  const worker = await startRunnerHost({ stateDir: f.stateDir, sessions, runs });
  t.after(async () => { await worker.close(); await runs.close(); });
  const runner = await runnerPaths(f.stateDir);
  const terminal = await terminalHostPaths(f.stateDir);
  const status = (socketPath: string, token: string) => new Promise<number>((resolve, reject) => {
    const req = request({ socketPath, method: 'POST', path: '/rpc', headers: { authorization: `Bearer ${token}` } }, res => { res.resume(); resolve(res.statusCode!); });
    req.on('error', reject); req.end('{}');
  });
  const [runnerToken, terminalToken] = await Promise.all([readFile(runner.token, 'utf8'), readFile(terminal.token, 'utf8')]);
  assert.notEqual(runnerToken, terminalToken);
  assert.equal(await status(terminal.socket, runnerToken), 403);
  assert.equal(await status(runner.socket, terminalToken), 403);
});

test('the version shown on the page asks a terminal host once, so looking never keeps it alive', async t => {
  const f = await fixture(t);
  const asked: string[] = [];
  const exchange = (f.client as unknown as { exchange: (method: string, args?: unknown[]) => Promise<unknown> }).exchange.bind(f.client);
  (f.client as unknown as { exchange: typeof exchange }).exchange = (method, args) => { asked.push(method); return exchange(method, args); };
  const version = await f.client.displayVersion();
  assert.match(version ?? '', /^\d+\.\d+\.\d+/);
  for (let index = 0; index < 3; index++) assert.equal(await f.client.displayVersion(), version);
  assert.deepEqual(asked, ['ping'], 'one request, then what its reply said');
  // A host that crashed leaves its credential file behind; it no longer listens, so it shows as not running.
  const token = await readFile((await terminalHostPaths(f.stateDir)).token, 'utf8');
  await f.host.close();
  await writeFile((await terminalHostPaths(f.stateDir)).token, token, { mode: 0o600 });
  assert.equal(await f.client.displayVersion(), null, 'a host that left shows as not running, without asking');
  assert.deepEqual(asked, ['ping']);
});

test('the terminal client reads host failures as before: absent host, old host, unknown shell, refusals and replies', async t => {
  const { errorStatus } = await import('../../../server/http/requests.js');
  const { RUNNER_PROTOCOL } = await import('../../../server/runs/runner-protocol.js');
  const { chmod } = await import('node:fs/promises');
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-terminal-client-'));
  const paths = await terminalHostPaths(stateDir);
  const legacyCalls: string[] = [];
  const legacy = { attach: async (id: string, res: { writeHead(status: number): void; end(): void }) => { legacyCalls.push(`attach ${id}`); res.writeHead(299); res.end(); }, input: async (id: string) => { legacyCalls.push(`input ${id}`); }, dispose: () => {} } as unknown as WorkspaceTerminalBackend;
  const plain = new TerminalHostClient({ stateDir, hostEntry: '/nonexistent/must-not-spawn.js', startupTimeoutMs: 200 });
  const withLegacy = new TerminalHostClient({ stateDir, legacy, hostEntry: '/nonexistent/must-not-spawn.js', startupTimeoutMs: 200 });
  let answer: { status: number; body?: unknown } = { status: 200 };
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (answer.status !== 200) { res.writeHead(answer.status); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ protocol: RUNNER_PROTOCOL, stateDir: paths.stateDir, instance: 'i', version: '1', ...answer.body as object }));
    });
  });
  t.after(async () => { server.closeAllConnections(); server.close(); plain.dispose(); withLegacy.dispose(); await rm(stateDir, { recursive: true, force: true }); await rm((await runnerPaths(stateDir)).directory, { recursive: true, force: true }); });
  const failed = async (work: Promise<unknown>) => { const error = await work.then(() => undefined, (caught: unknown) => caught) as Error & { hostAbsent?: boolean }; return { status: errorStatus(error), message: error.message, hostAbsent: error.hostAbsent }; };
  const response = () => { const seen: { status?: number; headersSent: boolean } = { headersSent: false }; return { seen, res: { headersSent: false, destroyed: false, writableEnded: false, writeHead: (status: number) => { seen.status = status; }, end: () => {}, once: () => {} } as never }; };

  // No host: absent, so list is empty and shells belong to the older worker.
  assert.deepEqual(await plain.list(), []);
  assert.deepEqual(await failed(plain.input('a', 'x')), { status: 503, message: 'The terminal host is not running.', hostAbsent: true });
  await withLegacy.input('a', 'x');
  assert.deepEqual(await failed(plain.attach('a', response().res)), { status: 404, message: '터미널을 찾을 수 없습니다. 새 터미널을 여세요.', hostAbsent: undefined });
  const viaLegacy = response();
  await withLegacy.attach('b', viaLegacy.res);
  assert.equal(viaLegacy.seen.status, 299);
  assert.equal(await plain.hostVersion(), null);
  assert.equal(await plain.displayVersion(), null);
  assert.deepEqual(legacyCalls, ['input a', 'attach b']);

  // A host that answers.
  await writeFile(paths.token, 'a'.repeat(64), { mode: 0o600 }); await chmod(paths.token, 0o600);
  await new Promise<void>(resolve => server.listen(paths.socket, resolve));
  answer = { status: 200, body: { error: { message: 'Unknown method.', statusCode: 400 } } };
  assert.equal(await plain.list(), undefined, 'a host too old to list answers 400');
  answer = { status: 200, body: { error: { message: 'Unknown terminal.', statusCode: 404 } } };
  await withLegacy.input('c', 'x');
  assert.deepEqual(legacyCalls.at(-1), 'input c', 'an unknown shell belongs to the older worker');
  assert.deepEqual(await failed(plain.input('c', 'x')), { status: 404, message: 'Unknown terminal.', hostAbsent: undefined });
  for (const statusCode of [409, 599, 0]) {
    answer = { status: 200, body: { error: { message: `m${statusCode}`, statusCode } } };
    assert.deepEqual(await failed(withLegacy.input('d', 'x')), { status: statusCode, message: `m${statusCode}`, hostAbsent: undefined }, String(statusCode));
  }
  answer = { status: 403 };
  assert.deepEqual(await failed(plain.input('e', 'x')), { status: 503, message: 'The terminal host refused the request.', hostAbsent: undefined });
  answer = { status: 500 };
  assert.deepEqual(await failed(plain.input('e', 'x')), { status: 500, message: 'The terminal host refused the request.', hostAbsent: undefined });
  answer = { status: 200, body: { result: 'ok' } };
  assert.equal(await plain.hostVersion(), '1');
});
