import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error plain .mjs script without type declarations
import { swapInto } from '../../scripts/build-server.mjs';

test('a new build replaces dist without leaving stale outputs or its staging folder', async t => {
  const dist = await mkdtemp(join(tmpdir(), 'tower-build-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await mkdir(join(dist, 'server'));
  await writeFile(join(dist, 'server', 'index.js'), 'old');
  await mkdir(join(dist, 'server', 'gone'));
  await writeFile(join(dist, 'server', 'gone', 'removed.js'), 'stale');
  const staging = join(dist, '.build-test');
  for (const name of ['server', 'shared']) {
    await mkdir(join(staging, name, 'nested'), { recursive: true });
    await writeFile(join(staging, name, 'index.js'), `new ${name}`);
    await writeFile(join(staging, name, 'nested', 'part.js'), name);
  }
  await swapInto(dist, staging);
  assert.equal(await readFile(join(dist, 'server', 'index.js'), 'utf8'), 'new server');
  assert.equal(await readFile(join(dist, 'shared', 'index.js'), 'utf8'), 'new shared');
  assert.equal(await readFile(join(dist, 'shared', 'nested', 'part.js'), 'utf8'), 'shared');
  await assert.rejects(access(join(dist, 'server', 'gone')));
  await assert.rejects(access(staging));
});
