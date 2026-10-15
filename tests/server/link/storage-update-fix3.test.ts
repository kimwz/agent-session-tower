import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readlinkSync, renameSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processStart } from '../../../server/instance/process-start.js';
import { pointCurrent, runtimePaths, versionDirectory } from '../../../server/link/service.js';
import * as hold from '../../../server/link/storage-hold.js';
import { transitionBreakerPath, transitionLockPath } from '../../../server/link/storage-transition-lock.js';
import type { SavedUpdate } from '../../../server/link/storage-update.js';
import { handoffHeld, runUpdateHelper, updatePaths, Updates, type UpdateHelperSteps } from '../../../server/link/update.js';
import { lineSplitter, ownChild, ownDirectory, readLines } from '../../helpers/child-processes.js';

/**
 * The update's handoff hold (C4): every managed writer and remover takes the transition turn and removes only the
 * generation it judged. Memory hooks and real separate processes are told apart in each test's name; the processes
 * move only on explicit barriers (lines on their stdout and stdin), never on a clock, and are gone before their state
 * directory is removed.
 */

async function stateDir(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-hold-'));
  ownDirectory(t, directory);
  await mkdir(runtimePaths(directory).versions, { recursive: true });
  return directory;
}
const at = '2026-10-08T00:00:00.000Z';
const record = (version: string, previous: string, stage: SavedUpdate['stage'], extra: Partial<SavedUpdate> = {}): SavedUpdate => ({ version, previous, stage, startedAt: at, updatedAt: at, ...extra });
const save = (state: string, value: unknown) => writeFile(updatePaths(state).status, JSON.stringify(value));
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!;

const old = () => new Date(Date.now() - 60 * 60_000);
async function oldHold(state: string, version = '1.1.0') {
  await hold.writeHold(state, version);
  await utimes(hold.holdPath(state), old(), old());
}
type Answer = { ok?: boolean; result?: unknown; code?: string; entered?: number };
/**
 * fixtures/hold-child.ts in its own process. `line` waits for a JSON line matching `match` on its stdout (undefined if
 * it closes first); `release` ends a `turn`; `closed` settles once the process is gone, with its last answer. A child
 * still running when the test ends is told to stop and waited for.
 */
function child(t: TestContext, args: string[]) {
  const script = fileURLToPath(new URL('./fixtures/hold-child.ts', import.meta.url));
  const process_ = spawn(process.execPath, ['--import', 'tsx', script, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  // Diagnostics: both streams as they come. Answers: only complete JSON lines of stdout.
  let out = '';
  const lines: Answer[] = [];
  const waiters = new Set<() => void>();
  readLines(process_.stdout, text => {
    out += `${text}\n`;
    if (text.startsWith('{')) lines.push(JSON.parse(text) as Answer);
    for (const wake of waiters) wake();
  });
  process_.stderr.on('data', chunk => { out += String(chunk); });
  let exited = false;
  const closed = new Promise<{ code: number | null; answer: Answer | undefined; out: string }>(resolve => process_.on('close', code => {
    exited = true;
    for (const wake of waiters) wake();
    resolve({ code, answer: lines.filter(line => 'ok' in line).at(-1), out });
  }));
  ownChild(t, process_, closed);
  const line = (match: (line: Answer) => boolean) => new Promise<Answer | undefined>(resolve => {
    const check = () => {
      const found = lines.find(match);
      if (found || exited) { waiters.delete(check); resolve(found); }
    };
    waiters.add(check);
    check();
  });
  return { line, closed, release: () => process_.stdin.write('release\n'), out: () => out };
}

test('the children\'s answers are read as whole stdout lines, however chunks split or merge them', () => {
  const seen: string[] = [];
  const feed = lineSplitter(line => seen.push(line));
  for (const chunk of ['{"entered":', '1}\n{"ok":true,', '"result":"refreshed"}\n', '', '{"ok"', ':false}\n{"x":1}\n{"partial']) feed(chunk);
  assert.deepEqual(seen.map(line => JSON.parse(line)), [{ entered: 1 }, { ok: true, result: 'refreshed' }, { ok: false }, { x: 1 }]);
  feed('":2}\n');
  assert.deepEqual(JSON.parse(seen.at(-1)!), { partial: 2 });
});

test('C4 memory hook. a hold replaced by another version right before its removal is not removed; the remover refuses', async t => {
  const state = await stateDir(t);
  const path = hold.holdPath(state);
  await hold.writeHold(state, '1.1.0');
  const original = { unlink: fsPromises.unlink, rename: fsPromises.rename };
  let swapped = 0;
  const swap = () => { if (!swapped++) { unlinkSync(path); writeFileSync(path, JSON.stringify({ version: '2.0.0' }), { mode: 0o600 }); } };
  t.mock.method(fsPromises, 'unlink', async (...args: Parameters<typeof original.unlink>) => { if (args[0] === path) swap(); return original.unlink(...args); });
  t.mock.method(fsPromises, 'rename', async (...args: Parameters<typeof original.rename>) => { if (args[0] === path) swap(); return original.rename(...args); });
  syncBuiltinESMExports();
  let outcome: unknown;
  try { outcome = await hold.removeHold(state, { version: '1.1.0' }).catch(error => error); } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(swapped, 1);
  assert.ok(outcome instanceof hold.HoldError && outcome.code === 'hold-replaced', String(outcome));
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: '2.0.0' }, 'the other version\'s hold is there');
});

test('C4 memory hook. an expired hold judged old, then touched before its removal, is kept: the judgment is not taken for the new generation', async t => {
  const state = await stateDir(t);
  const path = hold.holdPath(state);
  await oldHold(state);
  const original = { unlink: fsPromises.unlink, rename: fsPromises.rename };
  let touched = 0;
  const touch = () => { if (!touched++) { const now = new Date(); utimesSync(path, now, now); } };
  t.mock.method(fsPromises, 'unlink', async (...args: Parameters<typeof original.unlink>) => { if (args[0] === path) touch(); return original.unlink(...args); });
  t.mock.method(fsPromises, 'rename', async (...args: Parameters<typeof original.rename>) => { if (args[0] === path) touch(); return original.rename(...args); });
  syncBuiltinESMExports();
  let held: unknown;
  try { held = await handoffHeld(state).catch(error => error); } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(touched, 1);
  assert.equal(held, true, 'still held');
  assert.ok(existsSync(path) && Date.now() - (await stat(path)).mtimeMs < 60_000, 'the refreshed hold is kept');
});

test('C4 memory hook. a hold replaced right after it was read, before the turn, is not removed by that read', async t => {
  const state = await stateDir(t);
  const path = hold.holdPath(state);
  await oldHold(state);
  const read = await hold.observeHold(state);
  assert.ok(read.state === 'present');
  unlinkSync(path);
  await hold.writeHold(state, '1.1.0');
  await assert.rejects(hold.removeHold(state, { generation: read.generation }), { code: 'hold-replaced' });
  assert.ok(existsSync(path), 'a new hold of the same version is not removed by the old observation');
  const again = await hold.observeHold(state);
  assert.ok(again.state === 'present');
  assert.equal(await hold.removeHold(state, { generation: again.generation }), true, 'its own generation goes');
  assert.equal(existsSync(path), false);
});

test('C4 real processes. an expired hold judged by this web while another process holds the turn and refreshes it: kept, still held', async t => {
  const state = await stateDir(t);
  await oldHold(state);
  const refresher = child(t, [state, 'turn', '1.1.0']);
  // Barrier 1: the other process is inside the turn.
  assert.ok(await refresher.line(line => 'entered' in line), refresher.out());
  // Barrier 2: this web judged the hold old and now waits for that turn (its own lock publication was refused).
  const path = transitionLockPath(state);
  const original = fsPromises.link;
  let refused!: () => void;
  const waiting = new Promise<void>(resolve => { refused = resolve; });
  t.mock.method(fsPromises, 'link', async (...args: Parameters<typeof original>) => {
    try { return await original(...args); } catch (error) { if (args[1] === path && (error as NodeJS.ErrnoException).code === 'EEXIST') refused(); throw error; }
  });
  syncBuiltinESMExports();
  try {
    const judged = handoffHeld(state).catch(error => error);
    await waiting;
    // Barrier 3: the other process refreshes the hold and leaves the turn; only then can this web take it.
    refresher.release();
    const done = await refresher.closed;
    assert.deepEqual([done.code, done.answer], [0, { ok: true, result: 'refreshed' }], done.out);
    assert.equal(await judged, true, 'the web found the hold refreshed once it had the turn');
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.ok(existsSync(hold.holdPath(state)) && Date.now() - (await stat(hold.holdPath(state))).mtimeMs < 60_000, 'the refreshed hold is kept');
});

test('C4 real processes. another process replacing the generation judged here (same or another version) keeps it; the same generation goes', async t => {
  for (const next of ['1.1.0', '2.0.0'] as const) {
    const state = await stateDir(t);
    await oldHold(state);
    const judged = await hold.observeHold(state);
    assert.ok(judged.state === 'present');
    const removed = await child(t, [state, 'remove', '1.1.0']).closed;
    assert.deepEqual(removed.answer, { ok: true, result: true }, removed.out);
    const written = await child(t, [state, 'write', next]).closed;
    assert.deepEqual(written.answer, { ok: true, result: 'created' }, written.out);
    await assert.rejects(hold.removeHold(state, { generation: judged.generation }), { code: 'hold-replaced' }, next);
    assert.deepEqual(JSON.parse(await readFile(hold.holdPath(state), 'utf8')), { version: next }, next);
  }
  const state = await stateDir(t);
  await oldHold(state);
  const judged = await hold.observeHold(state);
  assert.ok(judged.state === 'present');
  assert.equal(await hold.removeHold(state, { generation: judged.generation }), true);
});

test('C4. an expired hold beside a helper lock: removed only once no helper can be running; running, invalid or unreadable keep it', async t => {
  const own = (await processStart(process.pid))!;
  for (const [lock, expected] of [
    [`${process.pid} ${own}`, true], ['not a lock', true], [`${deadPid()} Thu Jan  1 00:00:00 1970`, false], ['link', 'throws'], [undefined, false],
  ] as const) {
    const state = await stateDir(t);
    await oldHold(state);
    if (lock === 'link') await symlink(join(state, 'nowhere'), updatePaths(state).lock);
    else if (lock !== undefined) await writeFile(updatePaths(state).lock, lock, { mode: 0o600 });
    const held = await handoffHeld(state).then(value => value, () => 'throws');
    assert.equal(held, expected, `${lock}`);
    assert.equal(existsSync(hold.holdPath(state)), expected !== false, `${lock}: the hold ${expected === false ? 'goes' : 'stays'}`);
  }
});

test('C4. the turn refused (busy, or a stale breaker) keeps the hold and holds; the breaker and lock are left as they are', async t => {
  const state = await stateDir(t);
  await oldHold(state);
  const ownerFile = (role: 'lock' | 'breaker', pid: number) => JSON.stringify({ format: 'tower-transition-owner', version: 1, role, pid, start: 'gone', nonce: randomBytes(10).toString('hex') });
  writeFileSync(transitionLockPath(state), ownerFile('lock', deadPid()), { mode: 0o600 });
  writeFileSync(transitionBreakerPath(state), ownerFile('breaker', deadPid()), { mode: 0o600 });
  const before = [readFileSync(transitionLockPath(state)), readFileSync(transitionBreakerPath(state))];
  await assert.rejects(handoffHeld(state), { code: 'transition-lock-stale-breaker' });
  assert.ok(existsSync(hold.holdPath(state)));
  await assert.rejects(hold.writeHold(state, '1.1.0'), { code: 'transition-lock-stale-breaker' });
  assert.deepEqual([readFileSync(transitionLockPath(state)), readFileSync(transitionBreakerPath(state))], before);
});

test('C4. links, FIFOs, folders and garbage at the hold: no observation removes them; their bytes and targets are left', async t => {
  for (const shape of ['link', 'dangling', 'fifo', 'folder', 'garbage'] as const) {
    const state = await stateDir(t);
    const path = hold.holdPath(state);
    const target = join(state, 'target');
    if (shape === 'link') { await writeFile(target, 'ORIGINAL'); await symlink(target, path); }
    if (shape === 'dangling') await symlink(target, path);
    if (shape === 'fifo') spawnSync('mkfifo', [path]);
    if (shape === 'folder') await mkdir(path);
    if (shape === 'garbage') { await writeFile(path, '{', { mode: 0o600 }); await utimes(path, old(), old()); }
    if (shape === 'garbage') {
      // A plain file nobody can read as a hold, judged old: its own generation goes, nothing else.
      const judged = await hold.observeHold(state);
      assert.ok(judged.state === 'present' && judged.generation.version === undefined);
      await writeFile(path, '{"', { mode: 0o600 });
      await assert.rejects(hold.removeHold(state, { generation: judged.generation }), { code: 'hold-replaced' });
      assert.equal(await readFile(path, 'utf8'), '{"');
      continue;
    }
    await assert.rejects(hold.observeHold(state), { code: 'hold-not-a-file' }, shape);
    await assert.rejects(handoffHeld(state), Error, shape);
    await assert.rejects(hold.writeHold(state, '1.1.0'), { code: 'hold-not-a-file' }, shape);
    if (shape === 'link') assert.deepEqual([readlinkSync(path), await readFile(target, 'utf8')], [target, 'ORIGINAL']);
    if (shape === 'dangling') assert.equal(existsSync(target), false);
    if (shape === 'fifo') assert.ok((await fsPromises.lstat(path)).isFIFO());
    if (shape === 'folder') assert.ok((await fsPromises.lstat(path)).isDirectory());
  }
});

test('C4. the helper\'s release that fails after it kept the update is recorded on the update, not swallowed', async t => {
  const state = await stateDir(t);
  for (const version of ['1.0.0', '1.1.0']) await mkdir(versionDirectory(state, version), { recursive: true });
  await pointCurrent(state, '1.0.0');
  await save(state, record('1.1.0', '1.0.0', 'installing'));
  let clock = Date.parse(at);
  let pid = 1;
  const steps: UpdateHelperSteps = {
    free: async () => undefined, install: async version => versionDirectory(state, version), check: async () => {}, point: async version => { await pointCurrent(state, version); },
    restart: async () => { pid++; }, health: async () => ({ version: '1.1.0', pid }), controllers: async () => [], log: () => {},
    sleep: async ms => {
      clock += ms;
      // Meanwhile something other than this update replaced its hold.
      if (existsSync(hold.holdPath(state)) && JSON.parse(readFileSync(hold.holdPath(state), 'utf8')).version === '1.1.0') {
        renameSync(hold.holdPath(state), `${hold.holdPath(state)}.gone`);
        writeFileSync(hold.holdPath(state), JSON.stringify({ version: '9.9.9' }), { mode: 0o600 });
      }
    },
    now: () => clock,
  };
  const status = await runUpdateHelper(state, '1.1.0', steps);
  const saved = JSON.parse(readFileSync(updatePaths(state).status, 'utf8')) as SavedUpdate & { hold?: { code: string } };
  assert.equal(status?.stage, 'done');
  assert.equal(saved.hold?.code, 'hold-owned-elsewhere', JSON.stringify(saved));
  assert.deepEqual(JSON.parse(readFileSync(hold.holdPath(state), 'utf8')), { version: '9.9.9' }, 'the other hold is left');
});

test('C4. recovery writes and removes the hold in the turn, and does not remove a hold of a new update recorded after it judged', async t => {
  const state = await stateDir(t);
  await save(state, record('1.1.0', '1.0.0', 'failed', { code: 'start-failed' }));
  await hold.writeHold(state, '1.1.0');
  // Between the record recovery judged and its removal, a new update to 1.1.0 is recorded and holds again.
  const original = fsPromises.open;
  let changed = 0;
  t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof original>) => {
    if (args[0] === hold.holdPath(state) && !changed++) await save(state, record('1.1.0', '1.0.0', 'switching', { startedAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z' }));
    return original(...args);
  });
  syncBuiltinESMExports();
  try { await new Updates({ stateDir: state, version: '1.0.0', port: 1, managed: true, spawnHelper: () => {} }).recover(); } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.ok(changed > 0);
  assert.ok(existsSync(hold.holdPath(state)), 'the new update\'s hold stays');
});
