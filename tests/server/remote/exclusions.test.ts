import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteExclusionStore } from '../../../server/remote/exclusions.js';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-exclusions-')));
  const stateDir = join(root, 'state');
  const work = join(root, 'work');
  await mkdir(join(work, 'secret', 'deep'), { recursive: true });
  await mkdir(join(work, 'secretive'), { recursive: true });
  await mkdir(join(work, 'open'), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const open = async () => { const store = new RemoteExclusionStore(stateDir); await store.start(); return store; };
  return { root, stateDir, work, open };
}

test('an excluded folder hides itself and everything below it, but not a neighbour with a similar name', async t => {
  const f = await fixture(t);
  const store = await f.open();
  await store.add(join(f.work, 'secret'));
  for (const path of [join(f.work, 'secret'), join(f.work, 'secret', 'deep'), join(f.work, 'secret', 'not-created-yet')]) assert.equal(await store.excludesNow(path), true, path);
  for (const path of [join(f.work, 'secretive'), join(f.work, 'open'), f.work]) assert.equal(await store.excludesNow(path), false, path);
  await store.prepare([join(f.work, 'secret', 'deep'), join(f.work, 'secretive')]);
  const matcher = store.matcher();
  assert.equal(matcher.excludes(join(f.work, 'secret', 'deep')), true);
  assert.equal(matcher.excludes(join(f.work, 'secretive')), false);
  assert.equal(matcher.excludes(`${join(f.work, 'secret')}/`), true, 'a trailing slash is the same folder');
  assert.equal(matcher.excludes(join(f.work, 'open', '..', 'secret', 'deep')), true, 'a path through .. is judged where it lands');
});

test('a symlink or another letter case cannot reach an excluded folder', async t => {
  const f = await fixture(t);
  const store = await f.open();
  await store.add(join(f.work, 'secret'));
  await symlink(join(f.work, 'secret'), join(f.work, 'alias'));
  assert.equal(await store.excludesNow(join(f.work, 'alias', 'deep')), true);
  // Excluding the link excludes where it points too.
  await store.remove(join(f.work, 'secret'));
  await store.add(join(f.work, 'alias'));
  assert.equal(await store.excludesNow(join(f.work, 'secret', 'deep')), true);
  // macOS folders ignore letter case by default, so "SECRET" is the excluded folder too.
  if (process.platform === 'darwin') assert.equal(await store.excludesNow(join(f.work, 'SECRET', 'deep')), true);
});

test('a path whose real location is not known yet counts as excluded until it is resolved', async t => {
  const f = await fixture(t);
  const store = await f.open();
  const open = join(f.work, 'open');
  // Nothing excluded: nothing needs resolving.
  assert.equal(store.matcher().excludes(open), false);
  await store.add(join(f.work, 'secret'));
  const resolved = once(store, 'resolved');
  assert.equal(store.matcher().excludes(open), true, 'unknown until resolved, so it stays private');
  await resolved;
  assert.equal(store.matcher().excludes(open), false);
});

test('the list is kept across restarts, another reader follows its changes, and every change has a new revision', async t => {
  const f = await fixture(t);
  const store = await f.open();
  const reader = await f.open();
  assert.equal(store.revision, 0);
  assert.deepEqual(await store.add(join(f.work, 'secret')), [join(f.work, 'secret')]);
  assert.equal(store.revision, 1);
  assert.deepEqual(await store.add(join(f.work, 'secret')), [join(f.work, 'secret')], 'adding the same folder again changes nothing');
  assert.equal(store.revision, 1);
  await reader.reload();
  assert.deepEqual(reader.list(), [join(f.work, 'secret')]);
  assert.equal(await reader.excludesNow(join(f.work, 'secret', 'deep')), true);
  await store.remove(join(f.work, 'secret'));
  assert.equal(store.revision, 2);
  await reader.reload();
  assert.equal(await reader.excludesNow(join(f.work, 'secret', 'deep')), false);
  const saved = JSON.parse(await readFile(join(f.stateDir, 'remote-exclusions.json'), 'utf8'));
  assert.equal(saved.revision, 2);
  assert.equal((await stat(join(f.stateDir, 'remote-exclusions.json'))).mode & 0o777, 0o600);
  const restarted = await f.open();
  assert.equal(restarted.revision, 2);
  assert.deepEqual(restarted.list(), []);
});

test('only absolute folder paths can be excluded', async t => {
  const f = await fixture(t);
  const store = await f.open();
  for (const value of ['relative/path', '', 42, null, '/with\0nul']) assert.throws(() => store.add(value), /absolute folder path/);
});
