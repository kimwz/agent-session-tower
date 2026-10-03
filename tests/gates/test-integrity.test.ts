import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkTestIntegrity } from '../../scripts/test-integrity.js';

const script = join(import.meta.dirname, '..', '..', 'scripts', 'test-integrity.ts');
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };

/** A repository with `files` committed on main, then `change` applied on a branch merged into a merge commit at HEAD. */
async function repository(t: test.TestContext, files: Record<string, string>, change: Record<string, string | null>): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'test-integrity-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
  const write = async (content: Record<string, string | null>) => {
    for (const [path, text] of Object.entries(content)) {
      if (text === null) { git('rm', '-q', path); continue; }
      await mkdir(dirname(join(cwd, path)), { recursive: true });
      await writeFile(join(cwd, path), text);
    }
    git('add', '-A');
  };
  git('init', '-q', '-b', 'main');
  await write(files);
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'change');
  await write(change);
  git('commit', '-q', '--allow-empty', '-m', 'change');
  git('checkout', '-q', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'main moved on');
  git('merge', '-q', '--no-ff', '-m', 'merge', 'change');
  return cwd;
}

const file = (...tests: string[]) => `import test from 'node:test';\nimport assert from 'node:assert/strict';\n\n${tests.join('\n\n')}\n`;

test('a removed test is listed by its file and titles, and duplicate titles count one by one', async t => {
  const base = file("test('keeps', () => {});", "test('twice', () => {});", "test('twice', () => {});", "test('outer', async t => {\n  await t.test('inner', () => {});\n});");
  const cwd = await repository(t, { 'tests/a.test.ts': base }, { 'tests/a.test.ts': file("test('keeps', () => {});", "test('twice', () => {});", "test('outer', async t => {});") });
  const result = checkTestIntegrity(cwd);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.removed, ['tests/a.test.ts::twice', 'tests/a.test.ts::outer › inner']);
});

test('a renamed file keeps its tests; a title edited in the same rename is listed', async t => {
  const body = file("test('one', () => {\n  assert.equal(1, 1);\n});", "test('two', () => {\n  assert.equal(2, 2);\n});");
  const renamed = await repository(t, { 'tests/old.test.ts': body }, { 'tests/old.test.ts': null, 'tests/new.test.ts': body });
  assert.deepEqual(checkTestIntegrity(renamed).removed, []);
  assert.deepEqual(checkTestIntegrity(renamed).assertions, []);
  const retitled = await repository(t, { 'tests/old.test.ts': body }, { 'tests/old.test.ts': null, 'tests/new.test.ts': body.replace("'two'", "'two, renamed'") });
  assert.deepEqual(checkTestIntegrity(retitled).removed, ['tests/new.test.ts::two']);
});

test('a new unconditional skip fails, in each of its forms', async t => {
  for (const skipped of ["test.skip('a', () => {});", "test('a', { skip: true }, () => {});", "test('a', { todo: 'later' }, () => {});",
    "test('a', t => {\n  t.skip();\n});", "test('a', t => {\n  return t.skip('later');\n});", "it.todo('a', () => {});"]) {
    const cwd = await repository(t, { 'tests/a.test.ts': file("test('a', () => {});") }, { 'tests/a.test.ts': file(skipped) });
    const result = checkTestIntegrity(cwd);
    assert.equal(result.exitCode, 1, skipped);
    assert.deepEqual(result.unconditionalSkips, ['tests/a.test.ts::a'], skipped);
    assert.match(result.report, /New unconditional skips \(fails\)/);
  }
  const already = await repository(t, { 'tests/a.test.ts': file("test.skip('a', () => {});") }, { 'tests/a.test.ts': file("test.skip('a', () => {});", "test('b', () => {});") });
  assert.equal(checkTestIntegrity(already).exitCode, 0, 'a skip that was already there');
});

test('a skip decided at run time is listed and does not fail', async t => {
  for (const skipped of ["test('a', { skip: noLookups }, () => {});", "test('a', t => {\n  if (process.getuid?.() === 0) return t.skip('root');\n});"]) {
    const cwd = await repository(t, { 'tests/a.test.ts': file("test('a', () => {});") }, { 'tests/a.test.ts': file(skipped) });
    const result = checkTestIntegrity(cwd);
    assert.equal(result.exitCode, 0, skipped);
    assert.deepEqual(result.conditionalSkips, ['tests/a.test.ts::a'], skipped);
    assert.deepEqual(result.unconditionalSkips, []);
  }
  const off = await repository(t, { 'tests/a.test.ts': file("test('a', () => {});") }, { 'tests/a.test.ts': file("test('a', { skip: false, only: true }, () => {});") });
  assert.deepEqual(checkTestIntegrity(off).conditionalSkips, []);
  assert.deepEqual(checkTestIntegrity(off).only, ['tests/a.test.ts::a']);
});

test('pattern.test(…) inside a test is not a subtest', async t => {
  const cwd = await repository(t, { 'tests/a.test.ts': file("test('a', () => {\n  assert.ok(/x/.test('x'));\n  const re = /y/;\n  re.test('y');\n});") },
    { 'tests/a.test.ts': file("test('a', () => {\n  assert.ok(/x/.test('x'));\n});") });
  assert.deepEqual(checkTestIntegrity(cwd).removed, []);
});

test('a changed assert.equal line is listed with its base and head', async t => {
  const cwd = await repository(t, { 'tests/a.test.ts': file("test('a', () => {\n  assert.equal(add(1, 2), 3);\n});") },
    { 'tests/a.test.ts': file("test('a', () => {\n  assert.equal(add(1, 2), 4);\n});") });
  const [change] = checkTestIntegrity(cwd).assertions;
  assert.deepEqual(change, { path: 'tests/a.test.ts', base: [{ start: 5, end: 5, source: 'assert.equal(add(1, 2), 3)' }], head: [{ start: 5, end: 5, source: 'assert.equal(add(1, 2), 4)' }] });
});

test('a multi-line expected value changed inside an assertion is reported', async t => {
  const expectation = (middle: string) => file(`test('a', () => {\n  assert.deepEqual(x, [\n    1,\n    ${middle},\n    3\n  ]);\n});`);
  const cwd = await repository(t, { 'tests/a.test.ts': expectation('2') }, { 'tests/a.test.ts': expectation('20') });
  const result = checkTestIntegrity(cwd);
  assert.equal(result.assertions.length, 1);
  assert.deepEqual(result.assertions[0]!.base.map(({ start, end }) => [start, end]), [[5, 9]]);
  assert.deepEqual(result.assertions[0]!.head.map(({ start, end }) => [start, end]), [[5, 9]]);
  assert.match(result.report, /base `tests\/a\.test\.ts:5-9`/);
});

test('a pure insertion inside an assertion is reported, and an edit outside any assertion is not', async t => {
  const base = file("test('a', () => {\n  const x = 1;\n  assert.deepEqual(list, [\n    1,\n    2\n  ]);\n});");
  const inserted = await repository(t, { 'tests/a.test.ts': base }, { 'tests/a.test.ts': base.replace('    1,\n', '    1,\n    1.5,\n') });
  const [change] = checkTestIntegrity(inserted).assertions;
  assert.deepEqual(change!.base.map(({ start, end }) => [start, end]), [[6, 9]]);
  assert.deepEqual(change!.head.map(({ start, end }) => [start, end]), [[6, 10]]);
  const outside = await repository(t, { 'tests/a.test.ts': base }, { 'tests/a.test.ts': base.replace('const x = 1;', 'const x = 2;') });
  assert.deepEqual(checkTestIntegrity(outside).assertions, []);
  const appended = await repository(t, { 'tests/a.test.ts': base }, { 'tests/a.test.ts': `${base}// note\n` });
  assert.deepEqual(checkTestIntegrity(appended).assertions, [], 'an insertion right after an assertion is not inside it');
});

test('a deleted test file lists its tests and every assertion as removed', async t => {
  const cwd = await repository(t, { 'tests/a.test.ts': file("test('a', () => {\n  assert.ok(true);\n});"), 'tests/b.test.ts': file("test('b', () => {});") },
    { 'tests/a.test.ts': null });
  const result = checkTestIntegrity(cwd);
  assert.deepEqual(result.removed, ['tests/a.test.ts::a']);
  assert.deepEqual(result.assertions, [{ path: 'tests/a.test.ts', base: [{ start: 5, end: 5, source: 'assert.ok(true)' }], head: [] }]);
  assert.match(result.report, /head: removed/);
});

test('without --base, HEAD must be a merge commit; the CLI exits 2 otherwise and compares with the first parent when it is', async t => {
  const cwd = await repository(t, { 'tests/a.test.ts': file("test('a', () => {});") }, { 'tests/a.test.ts': file("test.skip('a', () => {});") });
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), script, ...args], { cwd, env: { ...env, GITHUB_STEP_SUMMARY: '' }, encoding: 'utf8' });
  const merged = run();
  assert.equal(merged.status, 1, merged.stderr);
  assert.match(merged.stdout, /tests\/a\.test\.ts::a/);
  execFileSync('git', ['checkout', '-q', 'change'], { cwd, env });
  const single = run();
  assert.equal(single.status, 2);
  assert.match(single.stderr, /--base/);
  assert.equal(checkTestIntegrity(cwd).exitCode, 2);
  assert.equal(run('--base', 'main^1').status, 1, 'an explicit base uses the merge base');
  assert.equal(run('--base').status, 2);
});
