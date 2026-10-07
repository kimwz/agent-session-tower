import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { applyChanges, EMPTY_STATE, fitToBudget, LoginSaver, loginsPath, readState, saveChanges, type Cookie, type StorageState } from '../../../server/browser/logins.js';
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
  assert.deepEqual(changed.origins.map(o => o.localStorage[0].value), ['b', 'mine'], 'what changed moves to the end');
});

test('saved logins start empty and stay owner-only; an unreadable file is set aside and reported, not left to break every turn', async t => {
  const dir = await stateDir(t);
  assert.deepEqual(await readState(dir), EMPTY_STATE);
  await saveChanges(dir, EMPTY_STATE, state([cookie('sid', '1')]));
  assert.deepEqual(values(await readState(dir)), ['sid=1']);
  assert.equal((await stat(loginsPath(dir))).mode & 0o777, 0o600);
  for (const damaged of ['{"not":"a state"}', 'not json', 'x'.repeat(8_000_001)]) {
    await writeFile(loginsPath(dir), damaged);
    const logs: string[] = [];
    assert.deepEqual(await readState(dir, error => logs.push(String(error))), EMPTY_STATE);
    assert.match(logs.join(), /set aside at .*logins\.json\.unreadable-/);
    const aside = (await readdir(join(dir, 'browser'))).filter(name => name.startsWith('logins.json.unreadable-'));
    assert.ok(aside.length >= 1, 'kept for inspection');
    await saveChanges(dir, EMPTY_STATE, state([cookie('after', '1')]));
    assert.deepEqual(values(await readState(dir)), ['after=1']);
  }
});

test('the saved order is the order of last change, and room is made from what changed least recently', () => {
  const big = 'v'.repeat(1_000);
  const origin = (name: string) => ({ origin: `https://${name}.com`, localStorage: [{ name: 'k', value: big }] });
  const saved = state([cookie('old-session', 'x'.repeat(600)), cookie('persistent', 'y', { expires: 9_999_999_999 })], [origin('a'), origin('b'), origin('c')]);
  const changed = applyChanges(saved, state([], [origin('a')]), state([cookie('fresh', '1')], [{ origin: 'https://a.com', localStorage: [{ name: 'k', value: 'new' }] }]));
  assert.deepEqual(changed.origins.map(o => o.origin), ['https://b.com', 'https://c.com', 'https://a.com'], 'a moved to the end');
  const keep = { cookies: new Set([JSON.stringify(['fresh', 'example.com', '/', ''])]), origins: new Set(['https://a.com']) };
  assert.deepEqual(fitToBudget(changed, keep, { maxOrigins: 2 }).origins.map(o => o.origin), ['https://c.com', 'https://a.com']);
  const tight = fitToBudget(changed, keep, { budget: 700 });
  assert.deepEqual(tight.origins.map(o => o.origin), ['https://a.com'], 'unchanged local storage goes first');
  assert.deepEqual(tight.cookies.map(c => c.name).sort(), ['fresh', 'persistent'], 'then session cookies');
  assert.deepEqual(fitToBudget(changed, keep, { budget: 300 }).cookies.map(c => c.name), ['fresh'], 'then any other cookie, never what this save changed');
  assert.throws(() => fitToBudget(changed, keep, { budget: 10 }), /were not saved/, 'what this save changed is never dropped to fit');
});

test('saving keeps the logins under their budget without dropping what the turn changed, and a later save still lands', async t => {
  const dir = await stateDir(t);
  const many = Array.from({ length: 40 }, (_, i) => ({ origin: `https://site${i}.com`, localStorage: [{ name: 'k', value: 'v' }] }));
  await saveChanges(dir, EMPTY_STATE, state([], many.slice(0, 20)));
  await saveChanges(dir, EMPTY_STATE, state([], many.slice(20)));
  const kept = await readState(dir);
  assert.equal(kept.origins.length, 30);
  assert.ok(kept.origins.some(o => o.origin === 'https://site39.com') && !kept.origins.some(o => o.origin === 'https://site0.com'), 'the oldest went');
  await saveChanges(dir, EMPTY_STATE, state([cookie('login', 'yes')]));
  assert.deepEqual(values(await readState(dir)), ['login=yes']);
  const huge = state([], [{ origin: 'https://cache.com', localStorage: [{ name: 'blob', value: 'x'.repeat(4_000_001) }] }]);
  await assert.rejects(saveChanges(dir, EMPTY_STATE, huge), /were not saved/);
  assert.deepEqual(values(await readState(dir)), ['login=yes'], 'a save too big by itself changes nothing');
});

test('a read that started earlier never overwrites a newer one, and origins a save did not see keep what was saved', async t => {
  const dir = await stateDir(t);
  const saver = new LoginSaver(dir, () => {});
  saver.started(EMPTY_STATE);
  await saver.save(state([cookie('a', '1')], [{ origin: 'https://app.com', localStorage: [{ name: 'token', value: 't' }] }]), 1);
  await saver.save(state([cookie('a', '2')], [{ origin: 'https://news.com', localStorage: [{ name: 'k', value: 'v' }] }]), 3);
  await saver.save(state([cookie('a', 'stale')]), 2);
  const saved = await readState(dir);
  assert.deepEqual([values(saved), saved.origins.map(o => o.origin)], [['a=2'], ['https://app.com', 'https://news.com']]);
});

test('an origin the turn used without changing it moves to the end, so a login in use is not the next to go', () => {
  const origin = (name: string) => ({ origin: `https://${name}.com`, localStorage: [{ name: 'k', value: name }] });
  const saved = state([], [origin('login'), origin('a'), origin('b')]);
  const used = applyChanges(saved, saved, state([], [origin('login'), origin('a'), origin('b')]), 0, new Set(['https://login.com']));
  assert.deepEqual(used.origins.map(o => o.origin), ['https://a.com', 'https://b.com', 'https://login.com']);
  assert.deepEqual(used.origins.at(-1), origin('login'), 'with the saved value');
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
