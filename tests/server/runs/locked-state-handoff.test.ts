import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DurableRunManager } from '../../../server/runs/durable-runner.js';
import { runnerPaths } from '../../../server/runs/runner-protocol.js';
import { startTerminalHost } from '../../../server/terminals/host.js';
import { TerminalHostClient } from '../../../server/terminals/client.js';
import { WorkspaceTerminals, type WorkspacePty } from '../../../server/workspace-terminals.js';
import { until } from '../../helpers/until.ts';

class Pty implements WorkspacePty {
  written: string[] = [];
  killed = 0;
  data = new Set<(data: string) => void>();
  write(data: string) { this.written.push(data); }
  resize() {}
  kill() { this.killed++; }
  onData(listener: (data: string) => void) { this.data.add(listener); return { dispose: () => { this.data.delete(listener); } }; }
  onExit() { return { dispose: () => {} }; }
}

const lines = (path: string) => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('locked state does not stop a handoff and is never written over; the turn ends on its own and the shell survives', { timeout: 90_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-locked-handoff-')));
  const stateDir = join(root, 'state');
  for (const name of ['home', 'codex', 'claude']) await mkdir(join(root, name));
  await mkdir(stateDir, { mode: 0o700 });
  const corrupt: Record<string, string> = {
    'trigger-engine.json': '{ "version": 1, "triggers": [ not json',
    'session-tasks.json': '{ "version": 1, "sessions": not json',
    'skills.json': '{ "version": 1, "targets": not json',
  };
  for (const [name, text] of Object.entries(corrupt)) await writeFile(join(stateDir, name), text, { mode: 0o600 });
  const entry = fileURLToPath(new URL('./fixtures/durable-process.ts', import.meta.url));
  const paths = await runnerPaths(stateDir);

  // Shells belong to the terminal host, never to the execution worker, so they cannot hold up its handoff.
  const ptys: Pty[] = [];
  const terminals = new WorkspaceTerminals({ keepAliveOnDisconnect: true, env: { SHELL: '/bin/fixture-shell' }, platform: 'darwin', spawnPty: () => { const pty = new Pty(); ptys.push(pty); return pty; } });
  const terminalHost = await startTerminalHost({ stateDir, terminals });
  const terminalClient = () => new TerminalHostClient({ stateDir, hostEntry: '/nonexistent/must-not-spawn.js', startupTimeoutMs: 500 });

  const { TOWER_HANDOFF: _proof, ...env } = process.env;
  const first = spawn(process.execPath, ['--import', 'tsx', entry, '--runner-worker', stateDir], {
    env: { ...env, HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'),
      FIXTURE_PROVIDER: 'claude', FIXTURE_ROOT: root, FIXTURE_LOCKED_STATE: root },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  first.stderr.on('data', data => { stderr += data; });
  const clients: DurableRunManager[] = [];
  const shells: TerminalHostClient[] = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    for (const client of shells) client.dispose();
    for (const { pid } of lines(join(root, 'workers.jsonl'))) if (alive(pid)) {
      process.kill(pid, 'SIGTERM');
      await until(() => !alive(pid), 5000).catch(() => { if (alive(pid)) process.kill(pid, 'SIGKILL'); });
    }
    if (first.exitCode === null && first.signalCode === null) first.kill('SIGKILL');
    await terminalHost.close(); terminals.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(paths.directory, { recursive: true, force: true });
  });
  const unchanged = async () => { for (const [name, text] of Object.entries(corrupt)) assert.equal(await readFile(join(stateDir, name), 'utf8'), text, `${name} is never written over`); };

  await until(() => {
    if (first.exitCode !== null) throw new Error(`The first worker exited: ${stderr}`);
    return lines(join(root, 'workers.jsonl')).length === 1;
  }, 20_000);
  const faults = lines(join(root, 'rename-faults.jsonl'));
  for (const name of Object.keys(corrupt)) assert.ok(faults.some(fault => fault.from === join(stateDir, name) && fault.pid === first.pid), `moving ${name} aside failed in the first worker`);
  await unchanged();

  let web = new DurableRunManager({ stateDir, workerEntry: entry, pollMs: 10 });
  clients.push(web);
  await web.start();
  let shellClient = terminalClient();
  shells.push(shellClient);
  const { id: shell } = await shellClient.create(root, 80, 24);
  const session = `claude:10000000-0000-4000-8000-000000000001`;
  const run = await web.enqueue(session, 'locked-state turn');
  await until(() => web.list().find(item => item.id === run.id)?.approvals?.length, 15_000);
  await shellClient.input(shell, 'echo before\r');

  // The web restarts while the turn waits: the turn and the shell go on.
  await web.close(); shellClient.dispose();
  web = new DurableRunManager({ stateDir, workerEntry: entry, pollMs: 10 });
  clients.push(web);
  await web.start();
  shellClient = terminalClient();
  shells.push(shellClient);
  assert.equal(web.list().find(item => item.id === run.id)?.status, 'running');
  await shellClient.input(shell, 'echo after-web\r');
  await unchanged();

  // A web of a newer build asks for a handoff; the running turn keeps the first worker in service.
  await web.close();
  web = new DurableRunManager({ stateDir, workerEntry: entry, pollMs: 10, version: '99.0.0' });
  clients.push(web);
  await web.start();
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.deepEqual(lines(join(root, 'handed-off.jsonl')), [], 'a running turn keeps the old worker');
  assert.equal(alive(first.pid!), true);
  await unchanged();

  // The owner answers the turn's approval; it ends on its own, and only then does the worker hand off.
  const waiting = web.list().find(item => item.id === run.id)!;
  await web.respondToApproval(run.id, waiting.approvals![0].id, 'allow');
  await until(() => lines(join(root, 'workers.jsonl')).some(worker => worker.successor), 30_000);
  const successor = lines(join(root, 'workers.jsonl')).find(worker => worker.successor)!;
  assert.deepEqual(lines(join(root, 'quiesced.jsonl')).map(item => item.pid), [first.pid], 'the locked stores were flushed in quiesce without blocking it');
  assert.deepEqual(lines(join(root, 'handed-off.jsonl')).map(item => item.pid), [first.pid]);
  await until(() => first.exitCode !== null, 10_000);
  await until(() => (web as unknown as { snapshot?: { instance: string } }).snapshot?.instance === successor.instance && web.list().find(item => item.id === run.id), 15_000);
  assert.equal(web.list().find(item => item.id === run.id)?.status, 'completed', 'the turn finished normally');

  // The successor, with no fault, moves each unreadable file aside with its original bytes.
  assert.equal(lines(join(root, 'rename-faults.jsonl')).every(fault => fault.pid === first.pid), true, 'the successor inherits no fault');
  for (const [name, text] of Object.entries(corrupt)) {
    const kept = (await readdir(stateDir)).filter(item => item.startsWith(`${name}.unreadable-`));
    assert.equal(kept.length, 1, name);
    assert.equal(await readFile(join(stateDir, kept[0]), 'utf8'), text, `${name} was kept as it was`);
  }

  // The same shell answers after the handoff; nothing was cancelled or killed.
  await shellClient.input(shell, 'echo after-handoff\r');
  assert.deepEqual(ptys[0].written, ['echo before\r', 'echo after-web\r', 'echo after-handoff\r']);
  assert.equal(ptys.length, 1);
  assert.equal(ptys[0].killed, 0);
  const transcript = await readFile(join(root, 'transcript.jsonl'), 'utf8');
  assert.equal(transcript.includes('interrupt'), false);
  assert.equal(lines(join(root, 'provider-pids.jsonl')).length, 1, 'one provider process for the turn');
});
