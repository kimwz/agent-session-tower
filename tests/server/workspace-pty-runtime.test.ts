import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWorkspacePty } from '../../server/workspace-pty-runtime.js';

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
