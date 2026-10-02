import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { commandEvidence } from '../../../server/permissions/evidence.js';

test('reads full referenced scripts and redirected input across quoted cd and chained commands', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tower-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'space dir');
  await mkdir(dir);
  const body = '# Python helper\n' + 'x = 1\n'.repeat(500) + '# required final operation\n';
  await writeFile(join(dir, 'run.py'), body);
  await writeFile(join(dir, 'prompt.txt'), 'review this code');
  const evidence = await commandEvidence(`cd '${dir}' && /usr/bin/python3 run.py && claude -p < prompt.txt > output.json`, root);
  assert.deepEqual(evidence.files.map(file => [file.path, file.text]), [[join(dir, 'run.py'), body], [join(dir, 'prompt.txt'), 'review this code']]);
});

test('missing, oversized and secret inputs are explicit without partial contents', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tower-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'big.py'), 'x'.repeat(200_000));
  await writeFile(join(root, '.env'), 'PRIVATE_VALUE=fixture');
  const evidence = await commandEvidence('python3 big.py && node missing.mjs && cat < .env', root);
  assert.deepEqual(evidence.files.map(file => file.status), ['too-large', 'unavailable', 'excluded']);
  assert.ok(evidence.files.every(file => file.text === undefined));
  assert.ok(!JSON.stringify(evidence).includes('PRIVATE_VALUE'));
});

test('does not interpret substitutions or read output paths as input evidence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tower-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = await commandEvidence('python3 "$SCRIPT" > result.py', root);
  assert.equal(evidence.files.length, 0);
  assert.ok(evidence.notes.length > 0);
});

test('credential symlink targets and nonregular inputs do not expose contents', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tower-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.env'), 'fixture-private');
  await symlink(join(root, '.env'), join(root, 'helper.py'));
  await mkdir(join(root, 'dir.py'));
  const evidence = await commandEvidence('python3 helper.py && python3 dir.py', root);
  assert.deepEqual(evidence.files.map(file => file.status), ['excluded', 'unavailable']);
});

test('fd redirections and pipelines without cd retain the literal working directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tower-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'check.py'), 'print(1)');
  const evidence = await commandEvidence('git diff 2>&1 | python3 check.py && echo done >&2 && node check.py', root);
  assert.deepEqual(evidence.files.map(file => [file.path, file.text]), [[join(root, 'check.py'), 'print(1)']]);
});

test('uninterpreted subshells and heredocs never attach a different same-name file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tower-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'run.py'), 'wrong script');
  for (const command of ['(cd sub && python3 run.py)', "python3 - <<'PY'\ncd sub\nrun.py\nPY", '{ cd sub; python3 run.py; }']) {
    const evidence = await commandEvidence(command, root);
    assert.equal(evidence.files.length, 0);
    assert.ok(evidence.notes.length > 0);
  }
});

test('an absolute cd restores directory evidence after a linear absolute cd', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tower-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'run.py'), 'print(1)');
  const evidence = await commandEvidence(`cd "$TARGET" && cd '${root}' && python3 run.py`, root);
  assert.equal(evidence.files[0]?.text, 'print(1)');
});

test('reads extensionless helpers passed directly to an interpreter or executed by relative path', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tower-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'release'), '#!/bin/sh\necho fixture');
  const evidence = await commandEvidence('bash release && ./release', root);
  assert.equal(evidence.files[0]?.text, '#!/bin/sh\necho fixture');
});

test('failed commands after cd do not assume which directory an OR branch uses', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tower-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'sub'));
  await writeFile(join(root, 'sub', 'run.py'), 'different helper');
  const evidence = await commandEvidence('cd sub && false || python3 run.py', root);
  assert.equal(evidence.files.length, 0);
  assert.ok(evidence.notes.some(note => note.includes('not interpreted')));
});


test('conditional cd and remote execution never use a wrong local script body', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tower-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'run.py'), 'local helper');
  for (const command of [`true || cd '${root}' && python3 run.py`, 'ssh host python3 run.py', 'docker exec c python3 run.py', 'timeout 30 ssh host python3 run.py', 'nice docker exec c python3 run.py', 'xargs kubectl exec p -- python3 run.py', 'FOO=$VALUE ssh host python3 run.py', '$PROGRAM python3 run.py']) {
    const evidence = await commandEvidence(command, root);
    assert.equal(evidence.files.length, 0);
    assert.ok(evidence.notes.length > 0);
  }
});


test('directory mutations through shell keywords and wrappers are explicitly unsupported', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tower-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'run.py'), 'wrong local code');
  for (const command of ['if cd sub; then python3 run.py; fi', 'pushd sub && python3 run.py', 'builtin cd sub && python3 run.py', 'env X=1 ssh host python3 run.py', 'cd sub && build & python3 run.py', 'x | cd sub && python3 run.py', 'true && cd sub; python3 run.py']) {
    const evidence = await commandEvidence(command, root);
    assert.equal(evidence.files.length, 0);
    assert.ok(evidence.notes.length > 0);
  }
});


test('unknown runners with directory options do not attach cwd code as executed code', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tower-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'run.py'), 'wrong code');
  const evidence = await commandEvidence('uv run --directory sub run.py', root);
  assert.equal(evidence.files.length, 0);
  assert.ok(evidence.notes.length > 0);
});
