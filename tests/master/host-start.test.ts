import { temporaryFixture, removeTemporaryFixture } from '../helpers/temporary.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MasterClient } from '../../server/master/client.js';
import { masterPaths } from '../../server/master/paths.js';
import { writePrivateJson } from '../../server/stores/private-json.js';
import { errorStatus } from '../../server/http/requests.js';
import { until } from '../helpers/until.js';
/**
 * A stand-in master host for the web side's start logic: no process is started (spawn is replaced), and a socket with
 * a credential answers like a host once `appear()` is called.
 *
 * What a test starts is held until it has ended, whatever point the test stops at: every client is registered when it
 * is made, and every promise it starts (a call, and the start work `ensureHost`/`pendingWork` behind `start()` and
 * `call()`) is registered with a handler when it starts. The after hook, added before anything else, disposes the
 * clients, fails the replaced spawns so start loops end, waits for every registered promise to settle, and only then
 * closes the socket, restores the mocks and removes the folders. If they do not settle in time, it fails and keeps the
 * folders.
 */
async function hostStart(t: test.TestContext) {
  const childProcess = (await import('node:child_process')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { EventEmitter } = await import('node:events');
  const { MASTER_PROTOCOL } = await import('../../server/master/host.js');
  const { APP_VERSION } = await import('../../shared/app-identity.js');
  const { runnerPaths } = await import('../../server/runs/runner-protocol.js');
  const clients: MasterClient[] = [];
  const pending = new Set<Promise<unknown>>();
  const spawned: Array<{ args: string[]; child: InstanceType<typeof EventEmitter> }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => {
      methods.push((JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { method?: string }).method ?? '');
      if (answer.status !== 200) { res.writeHead(answer.status).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ protocol: MASTER_PROTOCOL, stateDir: paths.stateDir, version: APP_VERSION, result: { answered: true } }));
    });
  });
  let stateDir: string | undefined;
  t.after(async () => {
    for (const client of clients) client.dispose();
    for (const { child } of spawned) child.emit('error', new Error('the fixture is closing'));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([Promise.allSettled([...pending]).then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 10_000); })]);
    clearTimeout(timer);
    // What the settled work does next (start()'s log line) runs before the mocks go.
    await new Promise(resolve => setImmediate(resolve));
    if (!settled) throw new Error(`Start work of the master client did not settle; ${stateDir} is kept.`);
    t.mock.restoreAll(); syncBuiltinESMExports();
    if (server.listening) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    if (stateDir) {
      // Its runner folder is found before the state goes: finding it makes the state folder again.
      const runner = (await runnerPaths(stateDir)).directory;
      await removeTemporaryFixture(stateDir);
      await rm(runner, { recursive: true, force: true });
    }
  });
  t.mock.method(childProcess, 'spawn', (_command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { unref: () => {} });
    spawned.push({ args, child });
    return child;
  });
  syncBuiltinESMExports();
  stateDir = await temporaryFixture('tower-master-start-');
  const paths = await masterPaths(stateDir);
  let answer: { status: number } = { status: 200 };
  const methods: string[] = [];
  /** Registers a promise the test started, with a handler at once; the test still awaits it for its outcome. */
  const pend = <T>(work: Promise<T>): Promise<T> => { pending.add(work); work.catch(() => {}); return work; };
  /** A client, registered when made, whose start work is registered whenever it begins. */
  const client = (startupTimeoutMs: number) => {
    const made = new MasterClient({ stateDir: paths.stateDir, credentials: () => undefined, hostEntry: '/fixture/master-host.js', startupTimeoutMs });
    clients.push(made);
    const inner = made as unknown as { ensureHost(): Promise<void>; pendingWork(): Promise<boolean> };
    const ensureHost = inner.ensureHost.bind(made); const pendingWork = inner.pendingWork.bind(made);
    inner.ensureHost = () => pend(ensureHost());
    inner.pendingWork = () => pend(pendingWork());
    return made;
  };
  const credential = async () => { await mkdir(join(paths.token, '..'), { recursive: true }); await writeFile(paths.token, 'c'.repeat(64), { mode: 0o600 }); };
  const appear = async () => { await credential(); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(paths.socket, resolve); }); };
  return { stateDir: paths.stateDir, paths, spawned, methods, client, pend, appear, credential, answer: (status: number) => { answer = { status }; } };
}

test('the web starts the master host when none answers and waits while it answers 503, but not past its deadline or on another failure', async t => {
  const h = await hostStart(t);
  const client = h.client(5_000);
  // No host: 503, so one is started and waited for; it comes up a while later.
  const call = h.pend(client.call('overview'));
  await until(() => h.spawned.length === 1);
  assert.deepEqual(h.spawned[0].args.slice(-3), ['/fixture/master-host.js', '--master-host', h.paths.stateDir]);
  await new Promise(resolve => setTimeout(resolve, 350));
  await h.appear();
  assert.deepEqual(await call, { answered: true }, 'the call went on once the host answered');
  assert.equal(h.spawned.length, 1, 'started once');
  assert.deepEqual(h.methods, ['ping', 'overview']);

  // A host that answers another failure is not waited for and nothing is started.
  h.answer(500);
  const refused = await h.pend(client.call('overview')).then(() => undefined, (error: unknown) => error as Error);
  assert.deepEqual({ status: errorStatus(refused), message: refused?.message }, { status: 500, message: 'The master host refused the request.' });
  assert.equal(h.spawned.length, 1);
});

test('the web gives up starting the master host at its deadline with the host-absent failure', async t => {
  const h = await hostStart(t);
  const client = h.client(300);
  const started = Date.now();
  const error = await h.pend(client.call('overview')).then(() => undefined, (caught: unknown) => caught as Error & { hostAbsent?: boolean });
  assert.ok(Date.now() - started >= 300, 'waited until the deadline');
  assert.deepEqual({ status: errorStatus(error), message: error?.message, hostAbsent: error?.hostAbsent }, { status: 503, message: 'The master host is not running.', hostAbsent: true });
  assert.equal(h.spawned.length, 1);
});

test('when resuming waiting work fails, the log line names the errno code, else the status, else "error"', async t => {
  const logged: string[] = [];
  t.mock.method(console, 'error', (line: string) => { logged.push(line); });
  const h = await hostStart(t);
  await mkdir(h.paths.data, { recursive: true, mode: 0o700 });
  await writePrivateJson(join(h.paths.data, 'settings.json'), JSON.stringify({ session: { sessionId: 'claude:master', provider: 'claude', startedAt: new Date().toISOString() } }));
  const resume = async (prepare: () => Promise<void> | void, timeout = 300) => {
    await prepare();
    const client = h.client(timeout);
    try {
      client.start();
      await until(() => logged.length > 0);
    } finally { client.dispose(); }
    return logged.splice(0);
  };
  // A credential but no socket: every ask fails with the socket's errno (marked 503); at the deadline that failure is logged by its code.
  assert.deepEqual(await resume(() => h.credential()), ['Master could not resume waiting work: ENOENT']);
  // A host that refuses with 500 is logged by its status.
  assert.deepEqual(await resume(async () => { h.answer(500); await h.appear(); }), ['Master could not resume waiting work: 500']);
  // A start that fails with no code and no status.
  h.answer(200);
  await rm(h.paths.token);
  await new Promise<void>(resolve => setTimeout(resolve, 10));
  const before = h.spawned.length;
  const failing = resume(() => {}, 5_000);
  await until(() => h.spawned.length === before + 1);
  h.spawned.at(-1)!.child.emit('error', new Error('cannot start'));
  assert.deepEqual(await failing, ['Master could not resume waiting work: error']);
});
