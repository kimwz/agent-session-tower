import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, open, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Snapshot } from '../../shared/types.js';
import { assertWorkspace, createWorkspaceDirectory, listWorkspaceTree, MAX_WORKSPACE_FILE_BYTES, readWorkspaceFile, saveWorkspaceFile } from '../../server/workspace-files.js';
import { statusOf } from '../../shared/errors.js';

async function fixture(t: test.TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'tower-files-'));
  const cwd = join(base, 'workspace');
  const outside = join(base, 'outside');
  await mkdir(cwd); await mkdir(outside);
  const snapshot: Snapshot = { sessions: [], runs: [], providers: [], scanning: false, hostname: 'fixture', version: 'test', updatedAt: '', groups: [{ cwd, title: '', pinned: true }] };
  t.after(() => rm(base, { recursive: true, force: true }));
  return { cwd, outside, snapshot };
}

test('workspace files list, read, save and create within a known directory', async t => {
  const { cwd, snapshot } = await fixture(t);
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'hello.txt'), 'hello 한글\n');
  await chmod(join(cwd, 'hello.txt'), 0o640);
  assert.deepEqual((await listWorkspaceTree(cwd, '', snapshot)).entries, [
    { name: 'src', path: 'src', type: 'directory' }, { name: 'hello.txt', path: 'hello.txt', type: 'file' },
  ]);
  const initial = await readWorkspaceFile(cwd, 'hello.txt', snapshot);
  assert.equal(initial.content, 'hello 한글\n');
  assert.match(initial.revision, /^[a-f0-9]{64}$/);
  const updated = await saveWorkspaceFile({ cwd, path: 'hello.txt', content: 'short', revision: initial.revision }, snapshot);
  assert.equal(await readFile(join(cwd, 'hello.txt'), 'utf8'), 'short');
  assert.notEqual(updated.revision, initial.revision);
  assert.equal((await stat(join(cwd, 'hello.txt'))).mode & 0o777, 0o640);
  await createWorkspaceDirectory({ cwd, path: 'src/new' }, snapshot);
  const fresh = await saveWorkspaceFile({ cwd, path: 'src/new/new.ts', content: 'export {};\n', revision: null }, snapshot);
  assert.equal((await readWorkspaceFile(cwd, fresh.path, snapshot)).revision, fresh.revision);
  await assert.rejects(createWorkspaceDirectory({ cwd, path: 'src/new' }, snapshot), { kind: 'conflict' });
  assert.equal((await saveWorkspaceFile({ cwd, path: 'src/new/new.ts', content: 'export {};\n', revision: null }, snapshot)).revision, fresh.revision,
    'a new file sent again after its answer was lost is already there');
  for (const [path, content] of [['src/new', ''], ['src/new/new.ts', 'other']]) {
    await assert.rejects(saveWorkspaceFile({ cwd, path, content, revision: null }, snapshot), { kind: 'conflict', message: /already exists/ }, `a new file named ${path} takes a name in use`);
  }
});

test('workspace validation and relative paths reject unlisted directories and traversal', async t => {
  const { cwd, outside, snapshot } = await fixture(t);
  await assert.rejects(assertWorkspace(outside, snapshot), { kind: 'forbidden' });
  for (const bad of ['relative', '/bad\0path', '/' + 'x'.repeat(4096)]) {
    await assert.rejects(assertWorkspace(bad, snapshot), { kind: 'invalid' });
  }
  for (const path of ['../outside/file', '/tmp/file', 'src/../../file', 'src//file', 'src/./file', 'src\\file', 'bad\0file']) {
    await assert.rejects(readWorkspaceFile(cwd, path, snapshot), { kind: 'invalid' });
    await assert.rejects(saveWorkspaceFile({ cwd, path, content: 'blocked', revision: null }, snapshot), { kind: 'invalid' });
    await assert.rejects(createWorkspaceDirectory({ cwd, path }, snapshot), { kind: 'invalid' });
  }
  await assert.rejects(readWorkspaceFile(cwd, 'missing', snapshot), { kind: 'not-found' });
});

test('symbolic link files and parent directories cannot escape the workspace', async t => {
  const { cwd, outside, snapshot } = await fixture(t);
  await writeFile(join(outside, 'secret'), 'outside');
  await symlink(join(outside, 'secret'), join(cwd, 'link'));
  await symlink(outside, join(cwd, 'escape'));
  for (const path of ['link', 'escape/secret']) {
    await assert.rejects(readWorkspaceFile(cwd, path, snapshot), { kind: 'forbidden' });
    await assert.rejects(saveWorkspaceFile({ cwd, path, content: 'changed', revision: null }, snapshot), { kind: 'forbidden' });
  }
  await assert.rejects(saveWorkspaceFile({ cwd, path: 'escape/new', content: 'no', revision: null }, snapshot), { kind: 'forbidden' });
  await assert.rejects(createWorkspaceDirectory({ cwd, path: 'escape/new' }, snapshot), { kind: 'forbidden' });
  await assert.rejects(listWorkspaceTree(cwd, 'escape', snapshot), { kind: 'forbidden' });
  assert.deepEqual((await listWorkspaceTree(cwd, '', snapshot)).entries, []);
  assert.equal(await readFile(join(outside, 'secret'), 'utf8'), 'outside');
});

test('revision conflicts and concurrent saves preserve the winning content', async t => {
  const { cwd, snapshot } = await fixture(t);
  await writeFile(join(cwd, 'file'), 'first');
  const initial = await readWorkspaceFile(cwd, 'file', snapshot);
  await writeFile(join(cwd, 'file'), 'external');
  await assert.rejects(saveWorkspaceFile({ cwd, path: 'file', content: 'stale', revision: initial.revision }, snapshot), { kind: 'conflict' });
  assert.equal(await readFile(join(cwd, 'file'), 'utf8'), 'external');
  await assert.rejects(saveWorkspaceFile({ cwd, path: 'file', content: 'new', revision: null }, snapshot), { kind: 'conflict' });
  const current = await readWorkspaceFile(cwd, 'file', snapshot);
  const outcomes = await Promise.allSettled(['one', 'two'].map(content => saveWorkspaceFile({ cwd, path: 'file', content, revision: current.revision }, snapshot)));
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal(statusOf(rejected.reason), 409);
  const winner = outcomes.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<{ content: string }>;
  assert.equal(await readFile(join(cwd, 'file'), 'utf8'), winner.value.content);
});

test('text editor refuses oversized, binary and invalid UTF-8 content and preserves a UTF-8 BOM', async t => {
  const { cwd, snapshot } = await fixture(t);
  for (const [name, bytes, kind] of [
    ['large', Buffer.alloc(MAX_WORKSPACE_FILE_BYTES + 1, 65), 'too-large'],
    ['binary', Buffer.from([65, 0, 66]), 'unsupported'], ['invalid', Buffer.from([0xff]), 'unsupported'],
  ] as const) {
    await writeFile(join(cwd, name), bytes);
    await assert.rejects(readWorkspaceFile(cwd, name, snapshot), { kind });
  }
  await assert.rejects(saveWorkspaceFile({ cwd, path: 'new', content: 'a'.repeat(MAX_WORKSPACE_FILE_BYTES + 1), revision: null }, snapshot), { kind: 'too-large' });
  await assert.rejects(saveWorkspaceFile({ cwd, path: 'new', content: 'a\0b', revision: null }, snapshot), { kind: 'unsupported' });
  await writeFile(join(cwd, 'bom'), '\ufeffhello\r\n');
  const bom = await readWorkspaceFile(cwd, 'bom', snapshot);
  assert.equal(bom.content, '\ufeffhello\r\n');
  await saveWorkspaceFile({ cwd, ...bom }, snapshot);
  assert.equal(await readFile(join(cwd, 'bom'), 'utf8'), '\ufeffhello\r\n');
});

test('directory listing is bounded and invalid write payloads do not create files', async t => {
  const { cwd, snapshot } = await fixture(t);
  for (let batch = 0; batch < 21; batch++) {
    await Promise.all(Array.from({ length: batch === 20 ? 1 : 100 }, (_, index) => writeFile(join(cwd, `file-${batch * 100 + index}`), '')));
  }
  await assert.rejects(listWorkspaceTree(cwd, '', snapshot), { kind: 'too-large' });
  for (const body of [
    { cwd, path: 'invalid', content: 'text' },
    { cwd, path: 'invalid', content: 'text', revision: null, command: 'no' },
    { cwd, path: 'invalid', content: 123, revision: null },
  ]) await assert.rejects(saveWorkspaceFile(body, snapshot), { kind: 'invalid' });
  await assert.rejects(saveWorkspaceFile({ cwd, path: 'invalid', content: '\ud800', revision: null }, snapshot), { kind: 'unsupported' });
  await assert.rejects(stat(join(cwd, 'invalid')), { code: 'ENOENT' });
});


test('failed staging writes preserve original bytes and remove temporary files', async t => {
  const { cwd, snapshot } = await fixture(t);
  await writeFile(join(cwd, 'original'), 'keep these bytes');
  const original = await readWorkspaceFile(cwd, 'original', snapshot);
  const probe = await open(join(cwd, 'original'), 'r');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  t.mock.method(prototype, 'sync', async () => { throw Object.assign(new Error('fixture disk failure'), { code: 'EIO' }); });
  await assert.rejects(saveWorkspaceFile({ cwd, path: 'original', content: 'replacement', revision: original.revision }, snapshot), { kind: 'internal' });
  await assert.rejects(saveWorkspaceFile({ cwd, path: 'new-file', content: 'replacement', revision: null }, snapshot), { kind: 'internal' });
  assert.equal(await readFile(join(cwd, 'original'), 'utf8'), 'keep these bytes');
  assert.deepEqual(await readdir(cwd), ['original']);
});

test('a new file appearing during staging is never overwritten', async t => {
  const { cwd, snapshot } = await fixture(t);
  const probe = await open(join(cwd, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe);
  const sync = prototype.sync;
  await probe.close();
  t.mock.method(prototype, 'sync', async function (this: typeof probe) {
    await writeFile(join(cwd, 'new-file'), 'external winner');
    return sync.call(this);
  });
  await assert.rejects(saveWorkspaceFile({ cwd, path: 'new-file', content: 'replacement', revision: null }, snapshot), { kind: 'conflict' });
  assert.equal(await readFile(join(cwd, 'new-file'), 'utf8'), 'external winner');
  assert.deepEqual((await readdir(cwd)).sort(), ['new-file', 'probe']);
});

test('existing files changed while staging retain external changes', async t => {
  const { cwd, snapshot } = await fixture(t);
  await writeFile(join(cwd, 'original'), 'initial');
  const original = await readWorkspaceFile(cwd, 'original', snapshot);
  const probe = await open(join(cwd, 'original'), 'r');
  const prototype = Object.getPrototypeOf(probe);
  const sync = prototype.sync;
  await probe.close();
  t.mock.method(prototype, 'sync', async function (this: typeof probe) {
    await writeFile(join(cwd, 'original'), 'external update');
    return sync.call(this);
  });
  await assert.rejects(saveWorkspaceFile({ cwd, path: 'original', content: 'replacement', revision: original.revision }, snapshot), { kind: 'conflict' });
  assert.equal(await readFile(join(cwd, 'original'), 'utf8'), 'external update');
  assert.deepEqual(await readdir(cwd), ['original']);
});

test('a folder named as a file is refused as not a text file, and names with spaces and Hangul read as written', async t => {
  const { cwd, snapshot } = await fixture(t);
  await mkdir(join(cwd, '영상 대본'));
  await writeFile(join(cwd, '영상 대본', '연출 대본.md'), '# 대본\n');
  await assert.rejects(readWorkspaceFile(cwd, '영상 대본', snapshot), { kind: 'invalid', message: 'Only regular text files can be opened.' });
  assert.equal((await readWorkspaceFile(cwd, '영상 대본/연출 대본.md', snapshot)).content, '# 대본\n');
});
