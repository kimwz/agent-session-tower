import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { keepEndpoint } from '../../../server/runs/endpoint-keeper.js';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function files(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-endpoint-keeper-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { socket: join(directory, 'rpc.sock'), token: join(directory, 'token'), value: 'a'.repeat(64) };
}

test('files older than an hour are touched so /tmp cleaners keep them', async t => {
  const f = await files(t);
  await writeFile(f.token, f.value, { mode: 0o600 });
  await writeFile(f.socket, '');
  const old = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
  await utimes(f.token, old, old);
  await utimes(f.socket, old, old);
  const stop = keepEndpoint(f, 10);
  t.after(() => stop());
  await pause(100);
  for (const path of [f.token, f.socket]) {
    const info = await stat(path);
    assert.ok(Date.now() - info.mtimeMs < 60_000 && Date.now() - info.atimeMs < 60_000, path);
  }
});

test('an existing credential is never replaced, and nothing is written once stopped', async t => {
  const f = await files(t);
  await writeFile(f.token, 'b'.repeat(64), { mode: 0o600 });
  const stop = keepEndpoint(f, 10);
  await pause(60);
  assert.equal(await readFile(f.token, 'utf8'), 'b'.repeat(64));
  await stop();
  await rm(f.token);
  await pause(60);
  await assert.rejects(stat(f.token), { code: 'ENOENT' });
});

test('stopping waits for a credential being written, so it never lands after the host removed its files', async t => {
  const f = await files(t);
  let finish!: () => void;
  const writing = new Promise<void>(resolve => { finish = resolve; });
  let started = false;
  let written = false;
  const missing = () => Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }));
  const stop = keepEndpoint(f, 5, {
    lstat: missing as never,
    utimes: (() => Promise.resolve()) as never,
    writeFile: (async () => { started = true; await writing; written = true; }) as never,
  });
  while (!started) await pause(5);
  let stopped = false;
  const stopping = stop().then(() => { stopped = true; });
  await pause(30);
  assert.equal(stopped, false, 'stop waits for the write underway');
  finish();
  await stopping;
  assert.equal(written, true);
});
