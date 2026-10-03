import assert from 'node:assert/strict';
import { lstat, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handoffPath, readHandoff, writeHandoff, type HandoffRecord } from '../../../server/runs/handoff.js';
import { blockRename, temporaryFiles } from '../../helpers/private-writes.js';

const record: HandoffRecord = { previous: 'worker-a', successor: 'nonce-b', version: '1.0.0', clean: true, at: '2026-10-03T00:00:00.000Z' };

test('the handoff record is written as compact JSON with mode 0600 and read back', async t => {
  const runtime = await mkdtemp(join(tmpdir(), 'tower-handoff-record-'));
  t.after(() => rm(runtime, { recursive: true, force: true }));
  await writeHandoff(runtime, record);
  assert.equal(await readFile(handoffPath(runtime), 'utf8'), JSON.stringify(record));
  assert.equal((await stat(handoffPath(runtime))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(runtime), ['handoff.json']);
  assert.deepEqual(await readHandoff(runtime), record);
});

test('a failed write leaves no temp file and rethrows the raw error', async t => {
  const runtime = await mkdtemp(join(tmpdir(), 'tower-handoff-failed-'));
  t.after(() => rm(runtime, { recursive: true, force: true }));
  await writeHandoff(runtime, record);
  const restore = await blockRename(handoffPath(runtime));
  const error = await writeHandoff(runtime, { ...record, successor: 'nonce-c' }).then(() => undefined, (caught: unknown) => caught as NodeJS.ErrnoException & { statusCode?: number });
  assert.ok(error?.code, 'the filesystem error itself');
  assert.equal(error?.statusCode, undefined);
  assert.deepEqual(await temporaryFiles(runtime), []);
  await restore();
  assert.deepEqual(await readHandoff(runtime), record);
});

test('a stale handoff temp file is not reused', async t => {
  const runtime = await mkdtemp(join(tmpdir(), 'tower-handoff-stale-'));
  t.after(() => rm(runtime, { recursive: true, force: true }));
  const outside = join(runtime, 'outside.txt');
  await writeFile(outside, 'not the handoff record');
  // What an earlier writer of the same pid could have left behind, here pointing somewhere else.
  await symlink(outside, `${handoffPath(runtime)}.${process.pid}.tmp`);
  await writeHandoff(runtime, record);
  assert.equal(await readFile(outside, 'utf8'), 'not the handoff record', 'the symlink is never written through');
  assert.equal((await lstat(handoffPath(runtime))).isFile(), true);
  assert.deepEqual(await readHandoff(runtime), record);
});
