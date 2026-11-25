import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWorkspacePty, ptyLoader } from '../../server/workspace-pty-runtime.js';

test('real PTY starts an isolated shell in the workspace with terminal dimensions', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-pty-check-'));
  const pty = await loadWorkspacePty();
  // No login profile, personal home, credentials, providers, or native session records.
  const child = pty.spawn('/bin/sh', ['-c', 'pwd; stty size; printf "PTY_OK\\n"'], {
    cwd: directory, cols: 93, rows: 27, name: 'xterm-256color',
    env: { HOME: directory, PATH: '/usr/bin:/bin', TERM: 'xterm-256color' },
  });
  let output = '';
  child.onData(data => { output += data; });
  try {
    const code = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error('PTY timed out')); }, 5000);
      child.onExit(event => { clearTimeout(timeout); resolve(event.exitCode); });
    });
    assert.equal(code, 0, output);
    assert.equal(await realpath(output.split(/\r?\n/)[0]), await realpath(directory));
    assert.match(output, /27\s+93/);
    assert.match(output, /PTY_OK/);
  } finally { try { child.kill(); } catch { /* Already exited. */ } await rm(directory, { recursive: true, force: true }); }
});

test('a private PTY copy whose helper was deleted is copied again on the next shell', async () => {
  const modules = [{ spawn: () => { throw new Error('first'); } }, { spawn: () => { throw new Error('second'); } }];
  const present = new Set<string>(['/copy-1/spawn-helper']);
  let loads = 0;
  const load = ptyLoader(async () => {
    const index = loads++;
    present.add(`/copy-${index + 1}/spawn-helper`);
    return { module: modules[index], helper: `/copy-${index + 1}/spawn-helper` };
  }, async path => present.has(path));
  assert.equal(await load(), modules[0]);
  assert.equal(await load(), modules[0]);
  assert.equal(loads, 1);
  present.delete('/copy-1/spawn-helper');
  assert.equal(await load(), modules[1]);
  assert.equal(await load(), modules[1]);
  assert.equal(loads, 2);
});

test('an installation helper is never checked again, and a failed load is retried', async () => {
  const module = { spawn: () => { throw new Error('unused'); } };
  let loads = 0;
  const load = ptyLoader(async () => { if (loads++ === 0) throw new Error('no pty'); return { module }; }, async () => assert.fail('checked'));
  await assert.rejects(load(), /no pty/);
  assert.equal(await load(), module);
  assert.equal(await load(), module);
  assert.equal(loads, 2);
});
