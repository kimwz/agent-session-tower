import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testedInput } from '../../scripts/ci-input.mjs';

test('local proof rejects dirty, untracked and unexpected ignored inputs, and only permits fresh declared outputs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tower-ci-input-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  await writeFile(join(root, '.gitignore'), 'node_modules/\ndist/\nartifacts/\n.env\n');
  await writeFile(join(root, 'source'), 'verified');
  git('add', '.'); git('-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'fixture');
  const clean = testedInput(root, false);
  await writeFile(join(root, 'source'), 'changed'); assert.throws(() => testedInput(root));
  await writeFile(join(root, 'source'), 'verified');
  await writeFile(join(root, 'extra.test.ts'), 'untracked'); assert.throws(() => testedInput(root));
  await rm(join(root, 'extra.test.ts'));
  await writeFile(join(root, '.env'), 'UNEXPECTED=fixture'); assert.throws(() => testedInput(root));
  await rm(join(root, '.env'));
  await mkdir(join(root, 'dist')); await writeFile(join(root, 'dist', 'built'), 'fresh result');
  assert.throws(() => testedInput(root, false), 'before installation all ignored inputs must be absent');
  assert.deepEqual(testedInput(root), clean);
});
