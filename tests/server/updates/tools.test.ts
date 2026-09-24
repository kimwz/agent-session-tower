import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Provider } from '../../../shared/types.js';
import { classifyInstall, readToolUpdates, ToolUpdates, toolUpdatePaths, unlessUpdating, type ToolCommands } from '../../../server/updates/tools.js';

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
  let behaviour: (provider: Provider, args: string[]) => { code: number; version?: string | null } = (provider, args) => ({ code: 0, version: latest[provider] });
  let held = new Set<Provider>();
  let busy = new Set<Provider>();
  let clock = Date.parse('2026-09-24T00:00:00Z');
  const provider = (file: string): Provider => file.includes('claude') ? 'claude' : 'codex';
  const commands: ToolCommands = {
    version: async executable => versions[provider(executable)],
    update: async (file, args) => {
      calls.push([file, ...args]);
      const which = args.some(arg => arg.includes('codex')) || file.includes('codex') ? 'codex' : 'claude';
      const result = behaviour(which, args);
      if (result.version !== undefined) versions[which] = result.version ?? undefined;
      return { code: result.code, output: '' };
    },
    latest: async pkg => pkg.includes('codex') ? latest.codex : latest.claude,
  };
  const updates = new ToolUpdates({ stateDir, env: { PATH: '' }, node: join(root, 'node/bin/node'), uid: options.uid ?? 501, commands, now: () => clock, probeWaitMs: 300,
    find: async name => executables[name],
    hold: name => {
      if (busy.has(name) || held.has(name)) return undefined;
      held.add(name);
      return () => { held.delete(name); };
    } });
  return {
    root, stateDir, updates, calls, versions, latest, executables,
    status: () => readToolUpdates(stateDir),
    held: () => held,
    busy: (names: Provider[]) => { busy = new Set(names); },
    behave: (next: typeof behaviour) => { behaviour = next; },
    advance: (ms: number) => { clock += ms; },
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
  const broken = await fixture(t, { claude: 'other' });
  broken.behave(() => ({ code: 1, version: null }));
  await broken.updates.check();
  status = await broken.status();
  assert.deepEqual([status.codex?.state, status.codex?.nextAt], ['broken', '2026-09-24T01:00:00.000Z']);
});

test('as root, a CLI, Node or npm another account could change is never run to update', async t => {
  const f = await fixture(t, { uid: 0 });
  await f.updates.check();
  assert.deepEqual(f.calls, []);
  const status = await f.status();
  assert.deepEqual([status.claude?.state, status.claude?.reason, status.codex?.reason], ['unsupported', 'not-root-only', 'not-root-only']);
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

test('a CLI that is not installed has no status', async t => {
  const f = await fixture(t, { codex: false });
  f.latest.claude = '2.1.280';
  await f.updates.check();
  const status = await f.status();
  assert.equal(status.codex, undefined);
  assert.deepEqual([status.claude?.state, status.claude?.target], ['current', '2.1.280']);
  void HOUR;
});
