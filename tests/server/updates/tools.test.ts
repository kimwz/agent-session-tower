import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Provider } from '../../../shared/types.js';
import { afterUpdating, classifyInstall, nativeCommands, publicToolUpdates, readToolUpdates, ToolUpdates, toolUpdatePaths, unlessUpdating, type ToolCommands } from '../../../server/updates/tools.js';
import { until } from '../../helpers/until.ts';

const HOUR = 60 * 60_000;

/** A native Claude Code, a global npm Codex and the Node and npm that run Tower, laid out as their installers do. */
async function fixture(t: TestContext, options: { claude?: 'native' | 'npm' | 'other'; codex?: boolean; uid?: number } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-tools-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state');
  await mkdir(join(stateDir, 'runtime'), { recursive: true });
  const file = async (path: string) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, '#!/bin/sh\n', { mode: 0o755 }); };
  const link = async (target: string, path: string) => { await mkdir(join(path, '..'), { recursive: true }); await symlink(target, path); };
  const executables: Partial<Record<Provider, string>> = {};
  if (options.claude === 'native' || options.claude === undefined) {
    await file(join(root, 'home/.local/share/claude/versions/2.1.280'));
    await link(join(root, 'home/.local/share/claude/versions/2.1.280'), executables.claude = join(root, 'home/.local/bin/claude'));
  } else if (options.claude === 'npm') {
    await file(join(root, 'prefix/lib/node_modules/@anthropic-ai/claude-code/cli.js'));
    await link(join(root, 'prefix/lib/node_modules/@anthropic-ai/claude-code/cli.js'), executables.claude = join(root, 'prefix/bin/claude'));
  } else {
    await file(executables.claude = join(root, 'opt/claude/bin/claude'));
  }
  if (options.codex !== false) {
    await file(join(root, 'prefix/lib/node_modules/@openai/codex/bin/codex.js'));
    await link(join(root, 'prefix/lib/node_modules/@openai/codex/bin/codex.js'), executables.codex = join(root, 'prefix/bin/codex'));
  }
  await file(join(root, 'node/bin/node'));
  await file(join(root, 'node/lib/node_modules/npm/bin/npm-cli.js'));
  await link('../lib/node_modules/npm/bin/npm-cli.js', join(root, 'node/bin/npm'));
  const versions: Record<Provider, string | undefined> = { claude: '2.1.280', codex: '0.155.1' };
  const latest: Record<Provider, string> = { claude: '2.1.281', codex: '0.156.1' };
  const calls: string[][] = [];
  /** Every CLI asked its version: as root, none that another account could change may be. */
  const asked: string[] = [];
  /** While set, an update command runs until it is let go. */
  let gate: Promise<void> | undefined;
  let behaviour: (provider: Provider, args: string[]) => { code: number; version?: string | null } = (provider, args) => ({ code: 0, version: latest[provider] });
  let held = new Set<Provider>();
  const envs: NodeJS.ProcessEnv[] = [];
  const holds: Array<[Provider, boolean]> = [];
  let busy = new Set<Provider>();
  let clock = Date.parse('2026-09-24T00:00:00Z');
  const provider = (file: string): Provider => file.includes('claude') ? 'claude' : 'codex';
  const commands: ToolCommands = {
    version: async executable => { asked.push(executable); return versions[provider(executable)]; },
    update: async (file, args, env, limit) => {
      calls.push([file, ...args]);
      envs.push(env);
      limit.started?.(process.pid);
      await gate;
      const which = args.some(arg => arg.includes('codex')) || file.includes('codex') ? 'codex' : 'claude';
      const result = behaviour(which, args);
      if (result.version !== undefined) versions[which] = result.version ?? undefined;
      return { code: result.code, output: '' };
    },
    latest: async pkg => pkg.includes('codex') ? latest.codex : latest.claude,
  };
  const updates = new ToolUpdates({ stateDir, env: { PATH: '', CLAUDECODE: '1', CODEX_SANDBOX_NETWORK_DISABLED: '1', KEEP: 'kept' }, node: join(root, 'node/bin/node'), uid: options.uid ?? 501, commands, now: () => clock, probeWaitMs: 300,
    find: async name => executables[name],
    hold: (name, quiet) => {
      holds.push([name, quiet]);
      if (busy.has(name) || held.has(name)) return undefined;
      held.add(name);
      return () => { held.delete(name); };
    } });
  return {
    root, stateDir, updates, calls, asked, versions, latest, executables, envs, holds,
    status: () => readToolUpdates(stateDir),
    held: () => held,
    busy: (names: Provider[]) => { busy = new Set(names); },
    behave: (next: typeof behaviour) => { behaviour = next; },
    advance: (ms: number) => { clock += ms; },
    /** Holds update commands until the returned function lets them finish. */
    block: () => { let open!: () => void; gate = new Promise(resolve => { open = () => { gate = undefined; resolve(); }; }); return open; },
  };
}

test('installs are recognised by where their command leads', () => {
  assert.deepEqual(classifyInstall('claude', '/Users/me/.local/share/claude/versions/2.1.280'), { method: 'native' });
  assert.deepEqual(classifyInstall('claude', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'), { method: 'npm', prefix: '/usr' });
  assert.deepEqual(classifyInstall('codex', '/Users/me/.local/lib/node_modules/@openai/codex/bin/codex.js'), { method: 'npm', prefix: '/Users/me/.local' });
  assert.deepEqual(classifyInstall('codex', '/opt/homebrew/Caskroom/codex/0.156.1/codex'), { method: 'unsupported' });
  assert.deepEqual(classifyInstall('codex', '/Users/me/.local/share/claude/versions/2.1.280'), { method: 'unsupported' });
});

test('a CLI behind its latest release is updated by its own installer while Tower holds its launches, then recorded current', async t => {
  const f = await fixture(t);
  await f.updates.check();
  const [claude, codex] = f.calls;
  assert.deepEqual(claude, [f.executables.claude, 'update']);
  assert.equal(codex[0], join(f.root, 'node/bin/node'));
  assert.deepEqual(codex.slice(1), [join(f.root, 'node/lib/node_modules/npm/bin/npm-cli.js'), 'install', '-g', '--prefix', join(f.root, 'prefix'), '@openai/codex@0.156.1', '--no-audit', '--no-fund', '--loglevel=error']);
  const status = await f.status();
  assert.deepEqual([status.claude?.state, status.claude?.version, status.claude?.method, status.codex?.state, status.codex?.version, status.codex?.method],
    ['current', '2.1.281', 'native', 'current', '0.156.1', 'npm']);
  assert.ok(status.claude?.updatedAt);
  assert.equal(f.held().size, 0, 'launches are released');
  assert.deepEqual((await readdir(toolUpdatePaths(f.stateDir).flags)).filter(name => name.endsWith('.update')), []);
  await f.updates.check();
  assert.equal(f.calls.length, 2, 'nothing to do once current');
});

test('a CLI with a run starting or running in Tower waits, and nothing is installed under it', async t => {
  const f = await fixture(t);
  f.busy(['claude', 'codex']);
  await f.updates.check();
  assert.deepEqual(f.calls, []);
  const status = await f.status();
  assert.deepEqual([status.claude?.state, status.codex?.state], ['waiting', 'waiting']);
  f.busy([]);
  await f.updates.check();
  assert.equal(f.calls.length, 2);
});

test('an update that does not change the version is tried again on the schedule, not in a loop', async t => {
  const f = await fixture(t);
  f.behave(() => ({ code: 0 }));
  await f.updates.check();
  let status = await f.status();
  assert.deepEqual([status.codex?.state, status.codex?.reason, status.codex?.nextAt], ['failed', 'not-updated', '2026-09-24T01:00:00.000Z']);
  f.advance(30 * 60_000);
  await f.updates.check();
  assert.equal(f.calls.length, 2, 'not before its time');
  f.advance(31 * 60_000);
  f.behave((provider, args) => ({ code: 0, version: f.latest[provider] }));
  await f.updates.check();
  status = await f.status();
  assert.equal(f.calls.length, 4);
  assert.deepEqual([status.claude?.state, status.codex?.state], ['current', 'current']);
});

test('a global npm install that no longer starts is put back to its version; one that cannot be is reported broken', async t => {
  const repaired = await fixture(t, { claude: 'other' });
  repaired.behave((_provider, args) => args.some(arg => arg.endsWith('@0.156.1')) ? { code: 1, version: null } : { code: 0, version: '0.155.1' });
  await repaired.updates.check();
  assert.deepEqual(repaired.calls.map(call => call.find(arg => arg.startsWith('@openai/codex@'))), ['@openai/codex@0.156.1', '@openai/codex@0.155.1']);
  let status = await repaired.status();
  assert.deepEqual([status.codex?.state, status.codex?.reason, status.codex?.version], ['failed', 'command-failed', '0.155.1']);
  assert.deepEqual([status.claude?.state, status.claude?.reason], ['unsupported', 'install-method'], 'an install Tower does not know is left alone');
  const broken = await fixture(t);
  broken.behave(() => ({ code: 1, version: null }));
  await broken.updates.check();
  status = await broken.status();
  assert.deepEqual([status.codex?.state, status.codex?.nextAt, status.codex?.fix], ['broken', '2026-09-24T01:00:00.000Z', `npm install -g --prefix '${join(broken.root, 'prefix')}' @openai/codex@0.156.1`]);
  assert.deepEqual([status.claude?.state, status.claude?.fix], ['broken', 'curl -fsSL https://claude.ai/install.sh | bash'], 'Claude Code’s own installer puts it back by hand');
  // Still not starting when its retry is due, it stays broken, with its fix, and nothing more is run.
  broken.advance(2 * HOUR);
  await broken.updates.check();
  status = await broken.status();
  assert.deepEqual([status.codex?.state, status.codex?.nextAt, status.codex?.retry?.attempts, status.codex?.checkedAt], ['broken', '2026-09-24T01:00:00.000Z', 1, '2026-09-24T02:00:00.000Z']);
  assert.ok(status.codex?.fix);
  assert.equal(broken.calls.length, 3);
  // Its command gone altogether, it is still broken, not uninstalled.
  delete broken.executables.codex;
  await broken.updates.check();
  assert.equal((await broken.status()).codex?.state, 'broken');
  // The fix names folders on this computer: only its own page gets it.
  status = await broken.status();
  assert.equal(publicToolUpdates(status).codex?.fix, undefined);
  assert.equal(publicToolUpdates(status, true).codex?.fix, status.codex?.fix);
  assert.equal('retry' in publicToolUpdates(status, true).codex!, false, 'retry bookkeeping stays in the status file');
  // Put back by hand, it is read again and kept current as usual.
  broken.executables.codex = join(broken.root, 'prefix/bin/codex');
  broken.versions.codex = '0.156.1';
  await broken.updates.check();
  status = await broken.status();
  assert.deepEqual([status.codex?.state, status.codex?.version, status.codex?.fix], ['current', '0.156.1', undefined]);
});

test('as root, a CLI, Node or npm another account could change is never run, not even to ask its version', async t => {
  const f = await fixture(t, { uid: 0 });
  await f.updates.check();
  assert.deepEqual(f.asked, [], 'no version asked');
  assert.deepEqual(f.calls, [], 'no update run');
  const status = await f.status();
  assert.deepEqual([status.claude?.state, status.claude?.reason, status.claude?.version, status.codex?.state, status.codex?.reason, status.codex?.version],
    ['unsupported', 'not-root-only', undefined, 'unsupported', 'not-root-only', undefined]);
  assert.equal(status.codex?.target, '0.156.1');
});

test('a capability probe and an update never run the same CLI at once', async t => {
  const f = await fixture(t);
  // A probe is under way: the update waits for it, then gives up for now.
  const { flags } = toolUpdatePaths(f.stateDir);
  await mkdir(flags, { recursive: true });
  await writeFile(join(flags, `codex.probe-${process.pid}-fixture`), '');
  await f.updates.check();
  assert.deepEqual(f.calls.map(call => call.includes('update') ? 'claude' : 'codex'), ['claude']);
  assert.equal((await f.status()).codex?.state, 'waiting');
  await rm(join(flags, `codex.probe-${process.pid}-fixture`));
  // An update holds the CLI: a probe then reads nothing.
  await writeFile(join(flags, 'codex.update'), String(process.pid));
  assert.equal(await unlessUpdating(f.stateDir, 'codex', async () => 'read'), undefined);
  // One left by a process that is gone holds nothing.
  await writeFile(join(flags, 'codex.update'), '999999999');
  assert.equal(await unlessUpdating(f.stateDir, 'codex', async () => 'read'), 'read');
  assert.deepEqual((await readdir(flags)).filter(name => name.includes('.probe-')), []);
});

test('a probe and an update started together never run the same CLI at once', async t => {
  const f = await fixture(t, { claude: 'other' });
  // An update holds its claim while it runs: a probe then reads nothing.
  const open = f.block();
  const updating = f.updates.check();
  await until(() => f.calls.length === 1);
  let read = 0;
  assert.equal(await unlessUpdating(f.stateDir, 'codex', async () => { read++; return 'read'; }), undefined);
  assert.equal(read, 0);
  open();
  await updating;
  assert.equal(await unlessUpdating(f.stateDir, 'codex', async () => { read++; return 'read'; }), 'read', 'once it is done, probes read again');
  // Started at the same moment, whichever claims first goes ahead and the other stands aside or waits.
  let running = 0;
  let overlapped = false;
  const using = async <T>(value: T) => { running++; overlapped ||= running > 1; await new Promise(resolve => setTimeout(resolve, 30)); running--; return value; };
  f.behave(() => ({ code: 0, version: f.latest.codex }));
  for (let round = 0; round < 4; round++) {
    f.versions.codex = '0.155.1';
    const open = f.block();
    const [, probe] = await Promise.all([
      f.updates.check(),
      unlessUpdating(f.stateDir, 'codex', () => using('read')),
      (async () => { await until(() => f.calls.length === 2 + round); await using('update'); open(); })(),
    ]);
    assert.ok(probe === 'read' || probe === undefined);
  }
  assert.equal(overlapped, false, 'the CLI is never probed while it is being updated');
  assert.equal(f.calls.length, 5, 'every round updated it once');
});

test('an update command runs in its own process group: a stuck npm is only reported, a stuck installer is stopped with everything it started', async t => {
  const script = (lines: string) => [process.execPath, ['-e', lines]] as const;
  // Left running past its limit, it is reported and then finishes by itself.
  let stuck = 0;
  const started = Date.now();
  const [node, args] = script('setTimeout(() => { console.log("done"); process.exit(0); }, 500);');
  const finished = await nativeCommands.update(node, [...args], process.env, { ms: 100, kill: false, stuck: () => { stuck++; } });
  assert.equal(stuck, 1);
  assert.deepEqual([finished.code, finished.output.trim()], [0, 'done'], 'never stopped');
  assert.ok(Date.now() - started >= 450);
  // Stopped: the child it started goes too.
  const [parent, parentArgs] = script('const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log(child.pid); setInterval(() => {}, 1000);');
  const stopped = await nativeCommands.update(parent, [...parentArgs], process.env, { ms: 300, kill: true });
  const child = Number(stopped.output.trim());
  t.after(() => { try { process.kill(child, 'SIGKILL'); } catch { /* Already gone. */ } });
  assert.equal(stopped.code, null, 'ended by a signal');
  assert.ok(child > 0);
  await until(() => { try { process.kill(child, 0); return false; } catch { return true; } }, 3000);
});

test('a CLI that is not installed has no status', async t => {
  const f = await fixture(t, { codex: false });
  f.latest.claude = '2.1.280';
  await f.updates.check();
  const status = await f.status();
  assert.equal(status.codex, undefined);
  assert.deepEqual([status.claude?.state, status.claude?.target], ['current', '2.1.280']);
  void HOUR;
});

test('an npm update asks Tower to keep every conversation of the CLI quiet, and runs without an agent session’s own markers', async t => {
  const f = await fixture(t);
  await f.updates.check();
  assert.deepEqual(f.holds, [['claude', false], ['codex', true]], 'only npm, which replaces files as it goes, needs every conversation quiet');
  for (const env of f.envs) {
    assert.equal(env.CLAUDECODE, undefined);
    assert.equal(env.CODEX_SANDBOX_NETWORK_DISABLED, undefined);
    assert.equal(env.KEEP, 'kept');
  }
});

test('a worker handing off starts no update, and one resumed carries on', async t => {
  const f = await fixture(t);
  f.updates.pause();
  await f.updates.check();
  assert.deepEqual(f.calls, []);
  f.updates.resume();
  await f.updates.check();
  assert.equal(f.calls.length, 2);
});

test('a routing call waits for an update of its CLI, then runs; cancelled, it stops waiting', async t => {
  const f = await fixture(t);
  const { flags } = toolUpdatePaths(f.stateDir);
  await mkdir(flags, { recursive: true });
  // The worker that took the update is gone, but the installer it started still runs: the CLI is still held.
  await writeFile(join(flags, 'codex.update'), `999999999 ${process.pid}`);
  let ran = false;
  const waiting = afterUpdating(f.stateDir, 'codex', new AbortController().signal, async () => { ran = true; return 'routed'; }, 20);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(ran, false, 'nothing runs the CLI while it is being replaced');
  assert.equal(await unlessUpdating(f.stateDir, 'codex', async () => 'probed'), undefined, 'a probe reads nothing then either');
  await rm(join(flags, 'codex.update'));
  assert.equal(await waiting, 'routed');
  await writeFile(join(flags, 'codex.update'), String(process.pid));
  const controller = new AbortController();
  const cancelled = afterUpdating(f.stateDir, 'codex', controller.signal, async () => 'never', 20);
  controller.abort(new Error('Routing was cancelled.'));
  await assert.rejects(cancelled, /cancelled/);
  assert.deepEqual((await readdir(flags)).filter(name => name.includes('.probe-')), [], 'a waiting call leaves nothing behind');
});

test('an installer a previous worker left running still holds its CLI: its turns wait until it is gone', async t => {
  const f = await fixture(t);
  const { flags } = toolUpdatePaths(f.stateDir);
  await mkdir(flags, { recursive: true });
  // The worker that took it is gone; the installer (this process, here) still runs.
  await writeFile(join(flags, 'codex.update'), `999999999 ${process.pid}`);
  const updates = new ToolUpdates({ stateDir: f.stateDir, env: { PATH: '' }, firstMs: 10 ** 9, adoptPollMs: 20, find: async () => undefined,
    hold: (name, quiet) => { f.holds.push([name, quiet]); f.held().add(name); return () => { f.held().delete(name); }; } });
  t.after(() => updates.stop());
  // With automatic updates off too, and before anything of the worker runs.
  await updates.start(false);
  assert.deepEqual([...f.held()], ['codex'], 'held as soon as start returns');
  assert.equal(updates.busy(), true, 'the worker does not hand off meanwhile');
  await rm(join(flags, 'codex.update'));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual([...f.held()], []);
  assert.equal(updates.busy(), false);
});
