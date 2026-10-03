import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { terminalHostPaths } from '../../../server/terminals/host.js';
import { TerminalHostClient } from '../../../server/terminals/client.js';
import { runnerPaths } from '../../../server/runs/runner-protocol.js';
import { errorStatus } from '../../../server/http/requests.js';
import { until } from '../../helpers/until.ts';
test('a new shell starts the terminal host when none answers and waits while it answers 503, but not past its deadline or on another failure', async t => {
  const childProcess = (await import('node:child_process')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { EventEmitter } = await import('node:events');
  const { RUNNER_PROTOCOL } = await import('../../../server/runs/runner-protocol.js');
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-terminal-start-'));
  const paths = await terminalHostPaths(stateDir);
  // No process is started: spawn is replaced; a socket with a credential answers like a host once it appears.
  const spawned: string[][] = [];
  t.mock.method(childProcess, 'spawn', (_command: string, args: string[]) => { spawned.push(args); return Object.assign(new EventEmitter(), { unref: () => {} }); });
  syncBuiltinESMExports();
  let status = 200;
  const methods: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const method = (JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { method?: string }).method ?? '';
      methods.push(method);
      if (status !== 200) { res.writeHead(status).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ protocol: RUNNER_PROTOCOL, stateDir: paths.stateDir, instance: 'i', version: '1', result: method === 'create' ? { id: 'shell' } : 'pong' }));
    });
  });
  const clients: TerminalHostClient[] = [];
  const client = (startupTimeoutMs: number) => { const made = new TerminalHostClient({ stateDir, hostEntry: '/fixture/terminal-host.js', startupTimeoutMs }); clients.push(made); return made; };
  t.after(async () => {
    for (const made of clients) made.dispose();
    t.mock.restoreAll(); syncBuiltinESMExports();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true }); await rm((await runnerPaths(stateDir)).directory, { recursive: true, force: true });
  });
  const failed = async (work: Promise<unknown>) => { const error = await work.then(() => undefined, (caught: unknown) => caught as Error & { hostAbsent?: boolean }); return { status: errorStatus(error), message: error?.message, hostAbsent: error?.hostAbsent }; };

  // No host until its deadline: started once, then the host-absent failure.
  const started = Date.now();
  assert.deepEqual(await failed(client(300).create('/fixture', 80, 24)), { status: 503, message: 'The terminal host is not running.', hostAbsent: true });
  assert.ok(Date.now() - started >= 300, 'waited until the deadline');
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].slice(-3), ['/fixture/terminal-host.js', '--terminal-host', paths.stateDir]);

  // No host at first: one is started and waited for; it comes up a while later and the shell is made.
  const create = client(5_000).create('/fixture', 80, 24);
  await until(() => spawned.length === 2);
  await new Promise(resolve => setTimeout(resolve, 350));
  await writeFile(paths.token, 'a'.repeat(64), { mode: 0o600 });
  await new Promise<void>(resolve => server.listen(paths.socket, resolve));
  assert.deepEqual(await create, { id: 'shell' });
  assert.deepEqual(methods, ['ping', 'create']);

  // A host that answers another failure is not waited for and nothing is started.
  status = 500;
  assert.deepEqual(await failed(client(5_000).create('/fixture', 80, 24)), { status: 500, message: 'The terminal host refused the request.', hostAbsent: undefined });
  assert.equal(spawned.length, 2);
});
