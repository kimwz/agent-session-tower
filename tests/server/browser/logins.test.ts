import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { applyChanges, EMPTY_STATE, loginsPath, readState, saveChanges, type Cookie, type StorageState } from '../../../server/browser/logins.js';
import { setTimeout as delay } from 'node:timers/promises';

const cookie = (name: string, value: string, extra: Partial<Cookie> = {}): Cookie => ({ name, value, domain: 'example.com', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax', ...extra });
const state = (cookies: Cookie[], origins: StorageState['origins'] = []): StorageState => ({ cookies, origins });
const values = (s: StorageState) => s.cookies.map(c => `${c.name}=${c.value}`).sort();

async function stateDir(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-browser-logins-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('a turn writes only what it changed, so another turn\'s newer login survives', () => {
  const baseline = state([cookie('sid', 'old'), cookie('pref', 'a')]);
  const savedMeanwhile = state([cookie('sid', 'refreshed-by-B'), cookie('pref', 'a')]);
  const turnA = state([cookie('sid', 'old'), cookie('pref', 'b'), cookie('new', '1')]);
  assert.deepEqual(values(applyChanges(savedMeanwhile, baseline, turnA)), ['new=1', 'pref=b', 'sid=refreshed-by-B']);
});

test('a cookie the turn had and dropped is deleted; one it never saw is kept', () => {
  const saved = state([cookie('logout-me', 'x'), cookie('other-turn', 'y')]);
  const merged = applyChanges(saved, state([cookie('logout-me', 'x')]), state([]));
  assert.deepEqual(values(merged), ['other-turn=y']);
});

test('cookies with the same name on other domains, paths or partitions are separate; expired ones go', () => {
  const now = 1_000;
  const current = state([cookie('id', '1'), cookie('id', '2', { domain: 'other.com' }), cookie('id', '3', { path: '/app' }), cookie('id', '4', { partitionKey: 'https://top.com' }), cookie('gone', 'x', { expires: 999 }), cookie('later', 'y', { expires: 2_000 })]);
  assert.deepEqual(values(applyChanges(EMPTY_STATE, EMPTY_STATE, current, now)), ['id=1', 'id=2', 'id=3', 'id=4', 'later=y']);
});

test('local storage is replaced per origin the turn changed and never deleted', () => {
  const baseline = state([], [{ origin: 'https://a.com', localStorage: [{ name: 'k', value: '1' }] }]);
  const saved = state([], [{ origin: 'https://a.com', localStorage: [{ name: 'k', value: 'other turn' }] }, { origin: 'https://b.com', localStorage: [{ name: 'k', value: 'b' }] }]);
  const unchanged = applyChanges(saved, baseline, state([], [{ origin: 'https://a.com', localStorage: [{ name: 'k', value: '1' }] }]));
  assert.deepEqual(unchanged.origins, saved.origins);
  const changed = applyChanges(saved, baseline, state([], [{ origin: 'https://a.com', localStorage: [{ name: 'k', value: 'mine' }] }]));
  assert.deepEqual(changed.origins.map(o => o.localStorage[0].value), ['mine', 'b']);
});

test('saved logins start empty, stay owner-only and refuse to be silently replaced when unreadable', async t => {
  const dir = await stateDir(t);
  assert.deepEqual(await readState(dir), EMPTY_STATE);
  await saveChanges(dir, EMPTY_STATE, state([cookie('sid', '1')]));
  assert.deepEqual(values(await readState(dir)), ['sid=1']);
  assert.equal((await stat(loginsPath(dir))).mode & 0o777, 0o600);
  await writeFile(loginsPath(dir), '{"not":"a state"}');
  await assert.rejects(readState(dir), /not a storage state/);
  await assert.rejects(saveChanges(dir, EMPTY_STATE, state([cookie('x', '1')])), /not a storage state/);
});

test('concurrent saves from several turns all land', async t => {
  const dir = await stateDir(t);
  await Promise.all(Array.from({ length: 8 }, (_, n) => saveChanges(dir, EMPTY_STATE, state([cookie(`turn${n}`, String(n))]))));
  assert.equal((await readState(dir)).cookies.length, 8);
});

test('a lock left by a dead process is taken over; a live owner is waited for and never written alongside', async t => {
  const dir = await stateDir(t);
  const lock = join(dir, 'browser', 'logins.lock');
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise(resolve => dead.on('exit', resolve));
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, 'owner'), `${dead.pid}:0:x`);
  await saveChanges(dir, EMPTY_STATE, state([cookie('after-dead', '1')]));
  assert.deepEqual(values(await readState(dir)), ['after-dead=1']);
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, 'owner'), `${process.pid}:0:someone-else`);
  await assert.rejects(saveChanges(dir, EMPTY_STATE, state([cookie('blocked', '1')]), { waitMs: 200 }), /not saved/);
  assert.equal(await readFile(join(lock, 'owner'), 'utf8'), `${process.pid}:0:someone-else`, 'another owner\'s lock is left alone');
  assert.deepEqual(values(await readState(dir)), ['after-dead=1']);
});

test('when several turns find the same dead owner, only one takes the lock over and no live owner\'s lock is removed', async t => {
  const dir = await stateDir(t);
  const lock = join(dir, 'browser', 'logins.lock');
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise(resolve => dead.on('exit', resolve));
  for (let round = 0; round < 5; round++) {
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, 'owner'), `${dead.pid}:0:dead`);
    await Promise.all(Array.from({ length: 6 }, (_, n) => saveChanges(dir, EMPTY_STATE, state([cookie(`r${round}t${n}`, '1')]))));
    assert.equal((await readState(dir)).cookies.filter(c => c.name.startsWith(`r${round}`)).length, 6, `round ${round}: every save landed`);
    await delay(1);
  }
});
