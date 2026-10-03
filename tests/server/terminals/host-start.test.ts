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
  // What the test starts is held until it has ended, whatever point it stops at: every client is registered when it is
  // made and every promise it starts (a create, and the start work behind it) with a handler when it starts. The after
  // hook, added before anything else, disposes the clients, fails the replaced spawns so start loops end, waits for
  // every registered promise, and only then closes the socket, restores the mocks and removes the folders; if they do
  // not settle in time it fails and keeps the folders.
  const clients: TerminalHostClient[] = [];
  const pending = new Set<Promise<unknown>>();
  const children: Array<InstanceType<typeof EventEmitter>> = [];
  let stateDir: string | undefined;
  t.after(async () => {
    for (const made of clients) made.dispose();
    for (const child of children) child.emit('error', new Error('the fixture is closing'));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([Promise.allSettled([...pending]).then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 10_000); })]);
    clearTimeout(timer);
    if (!settled) throw new Error(`Start work of the terminal client did not settle; ${stateDir} is kept.`);
    t.mock.restoreAll(); syncBuiltinESMExports();
    if (server.listening) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    if (stateDir) {
      // Its runner folder is found before the state goes: finding it makes the state folder again.
      const runner = (await runnerPaths(stateDir)).directory;
      await rm(stateDir, { recursive: true, force: true }); await rm(runner, { recursive: true, force: true });
    }
  });
  // No process is started: spawn is replaced; a socket with a credential answers like a host once it appears.
  const spawned: string[][] = [];
  t.mock.method(childProcess, 'spawn', (_command: string, args: string[]) => {
    spawned.push(args);
    const child = Object.assign(new EventEmitter(), { unref: () => {} });
    children.push(child);
    return child;
  });
  syncBuiltinESMExports();
  stateDir = await mkdtemp(join(tmpdir(), 'tower-terminal-start-'));
  const paths = await terminalHostPaths(stateDir);
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
  /** Registers a promise the test started, with a handler at once; the test still awaits it for its outcome. */
  const pend = <T>(work: Promise<T>): Promise<T> => { pending.add(work); work.catch(() => {}); return work; };
  /** A client, registered when made, whose start work is registered whenever it begins. */
  const client = (startupTimeoutMs: number) => {
    const made = new TerminalHostClient({ stateDir: paths.stateDir, hostEntry: '/fixture/terminal-host.js', startupTimeoutMs });
    clients.push(made);
    const inner = made as unknown as { ensureHost(): Promise<void> };
    const ensureHost = inner.ensureHost.bind(made);
    inner.ensureHost = () => pend(ensureHost());
    return made;
  };
  const failed = async (work: Promise<unknown>) => { const error = await work.then(() => undefined, (caught: unknown) => caught as Error & { hostAbsent?: boolean }); return { status: errorStatus(error), message: error?.message, hostAbsent: error?.hostAbsent }; };

  // No host until its deadline: started once, then the host-absent failure.
  const started = Date.now();
  assert.deepEqual(await failed(pend(client(300).create('/fixture', 80, 24))), { status: 503, message: 'The terminal host is not running.', hostAbsent: true });
  assert.ok(Date.now() - started >= 300, 'waited until the deadline');
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].slice(-3), ['/fixture/terminal-host.js', '--terminal-host', paths.stateDir]);

  // No host at first: one is started and waited for; it comes up a while later and the shell is made.
  const create = pend(client(5_000).create('/fixture', 80, 24));
  await until(() => spawned.length === 2);
  await new Promise(resolve => setTimeout(resolve, 350));
  await writeFile(paths.token, 'a'.repeat(64), { mode: 0o600 });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(paths.socket, resolve); });
  assert.deepEqual(await create, { id: 'shell' });
  assert.deepEqual(methods, ['ping', 'create']);

  // A host that answers another failure is not waited for and nothing is started.
  status = 500;
  assert.deepEqual(await failed(pend(client(5_000).create('/fixture', 80, 24))), { status: 500, message: 'The terminal host refused the request.', hostAbsent: undefined });
  assert.equal(spawned.length, 2);
});
