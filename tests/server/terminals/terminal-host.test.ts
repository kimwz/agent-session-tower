import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { startTerminalHost, terminalHostPaths } from '../../../server/terminals/host.js';
import { TerminalHostClient } from '../../../server/terminals/client.js';
import { runnerPaths } from '../../../server/runs/runner-protocol.js';
import { WorkspaceTerminals, type WorkspacePty, type WorkspaceTerminalBackend } from '../../../server/workspace-terminals.js';
import { until } from '../../helpers/until.ts';

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

async function fixture(t: TestContext, options: { idleMs?: number; legacy?: WorkspaceTerminalBackend } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-terminal-host-'));
  const ptys: Pty[] = [];
  const terminals = new WorkspaceTerminals({ keepAliveOnDisconnect: true, env: { SHELL: '/bin/fixture-shell' }, platform: 'darwin', spawnPty: () => { const pty = new Pty(); ptys.push(pty); return pty; } });
  let idle = 0;
  const host = await startTerminalHost({ stateDir, terminals, idleMs: options.idleMs, onIdle: options.idleMs === undefined ? undefined : () => { idle++; terminals.dispose(); } });
  const client = new TerminalHostClient({ stateDir, legacy: options.legacy, hostEntry: '/nonexistent/must-not-spawn.js', startupTimeoutMs: 500 });
  t.after(async () => { client.dispose(); await host.close(); terminals.dispose(); await rm(stateDir, { recursive: true, force: true }); await rm((await runnerPaths(stateDir)).directory, { recursive: true, force: true }); });
  return { stateDir, ptys, terminals, host, client, idle: () => idle };
}

/** Streams one terminal through the client the way the web server does. */
async function stream(client: TerminalHostClient, id: string, until: RegExp): Promise<string> {
  const server = createServer((_req, res) => { void client.attach(id, res).catch(error => { res.writeHead(error.statusCode || 500); res.end(); }); });
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
