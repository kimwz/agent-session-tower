import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Browser, BrowserContext } from 'playwright';
import { liveDir, markerSwitch, type ProcessProbe } from '../../../server/browser/live.js';
import { readState, type StorageState } from '../../../server/browser/logins.js';
import { TurnBrowser, type TurnBrowserHooks } from '../../../server/browser/turn-browser.js';

/** Fake browsers whose processes live in `processes` until closed (unless they refuse to close). */
function fakes(options: { refuseClose?: boolean; state?: () => StorageState; contextFails?: boolean } = {}) {
  const processes = new Map<number, string>();
  const closed: number[] = [];
  let nextPid = 1000;
  const probe: ProcessProbe = { alive: () => true, command: async pid => processes.get(pid), kill: () => {} };
  const hooks: Partial<TurnBrowserHooks> = {
    probe, closeTimeoutMs: 20, stateTimeoutMs: 50, saveWaitMs: 200, goneWaitMs: 30,
    startBrowser: async (_tier, marker) => {
      const pid = nextPid++;
      processes.set(pid, `/chrome ${marker}`);
      const browser = { close: () => { closed.push(pid); if (options.refuseClose) return new Promise<void>(() => {}); processes.delete(pid); return Promise.resolve(); } } as unknown as Browser;
      return { browser };
    },
    findBrowserPid: async marker => [...processes].find(([, command]) => command.includes(markerSwitch(marker)))?.[0],
    newContext: async () => {
      if (options.contextFails) throw new Error('context failed');
      const context = new EventEmitter() as EventEmitter & { storageState(): Promise<StorageState>; close(): Promise<void> };
      context.storageState = async () => options.state?.() ?? { cookies: [], origins: [] };
      context.close = async () => { context.emit('close'); };
      return context as unknown as BrowserContext;
    },
  };
  return { hooks, processes, closed };
}

async function stateDir(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-turn-browser-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const records = async (dir: string) => (await readdir(liveDir(dir)).catch(() => [] as string[])).sort();
const cookie = (name: string, value: string) => ({ name, value, domain: 'example.com', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' as const });

test('a browser that fails to set up is closed at once, and its record goes', async t => {
  const dir = await stateDir(t);
  const f = fakes({ contextFails: true });
  const browser = new TurnBrowser({ tier: 'general', stateDir: dir, savedLogins: true }, () => {}, f.hooks);
  await assert.rejects(browser.context());
  assert.deepEqual([f.closed.length, f.processes.size], [1, 0]);
  assert.deepEqual(await records(dir), []);
  await browser.shutdown();
});

test('every browser the turn started is closed when it ends, and one that will not close keeps its record for the reaper', async t => {
  const dir = await stateDir(t);
  const f = fakes({ refuseClose: true });
  const logs: string[] = [];
  const browser = new TurnBrowser({ tier: 'light', stateDir: dir, savedLogins: false }, error => logs.push(String(error)), f.hooks);
  await browser.context();
  assert.equal((await records(dir)).length, 1);
  await browser.shutdown();
  assert.equal(f.closed.length, 1);
  assert.equal((await records(dir)).length, 1, 'still running, so still recorded');
  assert.match(logs.join(), /did not close/);
});

test('a browser closed normally leaves no record, and a turn that ends while one is starting closes it too', async t => {
  const dir = await stateDir(t);
  const f = fakes();
  const normal = new TurnBrowser({ tier: 'light', stateDir: dir, savedLogins: false }, () => {}, f.hooks);
  await normal.context();
  await normal.shutdown();
  assert.deepEqual([f.processes.size, await records(dir)], [0, []]);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const slow = fakes();
  const original = slow.hooks.newContext!;
  slow.hooks.newContext = async (...args) => { await gate; return original(...args); };
  const starting = new TurnBrowser({ tier: 'light', stateDir: dir, savedLogins: false }, () => {}, slow.hooks);
  const pending = starting.context();
  await new Promise(resolve => setTimeout(resolve, 10));
  const ending = starting.shutdown();
  release();
  await ending;
  await pending.catch(() => undefined);
  assert.equal(slow.processes.size, 0, 'the browser that was setting up is closed');
});

test('logins a failed save could not write go with the next save', async t => {
  const dir = await stateDir(t);
  let current: StorageState = { cookies: [cookie('a', '1')], origins: [] };
  const f = fakes({ state: () => current });
  const browser = new TurnBrowser({ tier: 'general', stateDir: dir, savedLogins: true }, () => {}, f.hooks);
  await browser.context();
  const lock = join(dir, 'browser', 'logins.lock');
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, 'owner'), `${process.pid}:0:another-turn`);
  browser.saveSoon();
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.deepEqual((await readState(dir)).cookies, [], 'the first save waited for the lock and gave up');
  await rm(lock, { recursive: true, force: true });
  current = { cookies: [cookie('a', '1'), cookie('b', '2')], origins: [] };
  await browser.shutdown();
  assert.deepEqual((await readState(dir)).cookies.map(c => c.name).sort(), ['a', 'b']);
});

test('a browser reopened after the agent closed one starts from the logins the closed one saved, and keeps them', async t => {
  const dir = await stateDir(t);
  const login = { cookies: [cookie('login', 'yes')], origins: [] };
  const f = fakes({ state: () => login });
  const seeded: (StorageState | undefined)[] = [];
  const original = f.hooks.newContext!;
  f.hooks.newContext = async (tier, b, options) => { seeded.push(options.storageState); return original(tier, b, options); };
  f.hooks.saveWaitMs = 5_000;
  const browser = new TurnBrowser({ tier: 'general', stateDir: dir, savedLogins: true }, () => {}, f.hooks);
  const first = await browser.context() as unknown as EventEmitter;
  const lock = join(dir, 'browser', 'logins.lock');
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, 'owner'), `${process.pid}:0:another-turn`);
  browser.saveSoon();
  await new Promise(resolve => setTimeout(resolve, 30));
  first.emit('close');
  const reopening = browser.context();
  setTimeout(() => { void rm(lock, { recursive: true, force: true }); }, 100);
  await reopening;
  assert.deepEqual(seeded.at(-1)?.cookies.map(c => c.name), ['login'], 'the new browser waited for the earlier save');
  await browser.shutdown();
  assert.deepEqual((await readState(dir)).cookies.map(c => c.name), ['login']);
});

test('closing the browser on the agent\'s request saves its logins first, and the next call starts a new browser', async t => {
  const dir = await stateDir(t);
  const f = fakes({ state: () => ({ cookies: [cookie('fresh', 'login')], origins: [] }) });
  const browser = new TurnBrowser({ tier: 'general', stateDir: dir, savedLogins: true }, () => {}, f.hooks);
  const first = await browser.context();
  await browser.closeActive();
  assert.deepEqual((await readState(dir)).cookies.map(c => c.name), ['fresh']);
  assert.deepEqual([f.closed.length, f.processes.size, await records(dir)], [1, 0, []]);
  const second = await browser.context();
  assert.notEqual(second, first);
  await browser.closeActive();
  await browser.closeActive();
  await browser.shutdown();
  assert.equal(f.processes.size, 0);
});

test('every tool call\'s login changes are saved at once, so a browser that dies later loses none of them', async t => {
  const dir = await stateDir(t);
  let current: StorageState = { cookies: [cookie('a', '1')], origins: [] };
  const f = fakes({ state: () => current });
  const browser = new TurnBrowser({ tier: 'general', stateDir: dir, savedLogins: true }, () => {}, f.hooks);
  const context = await browser.context() as unknown as EventEmitter;
  browser.saveSoon();
  current = { cookies: [cookie('a', '1'), cookie('b', '2')], origins: [] };
  browser.saveSoon();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual((await readState(dir)).cookies.map(c => c.name).sort(), ['a', 'b'], 'a call finishing during a save gets one more');
  context.emit('close');
  await browser.shutdown();
  assert.deepEqual((await readState(dir)).cookies.map(c => c.name).sort(), ['a', 'b']);
});

test('a conversation with outside content gets a guarded context and no saved logins', async t => {
  const dir = await stateDir(t);
  const f = fakes();
  const asked: unknown[] = [];
  const original = f.hooks.newContext!;
  f.hooks.newContext = async (tier, b, options) => { asked.push(options); return original(tier, b, options); };
  const browser = new TurnBrowser({ tier: 'general', stateDir: dir, savedLogins: false, outsideContent: true }, () => {}, f.hooks);
  await browser.context();
  await browser.shutdown();
  assert.deepEqual(asked, [{ storageState: undefined, outsideContent: true }]);
});

test('code that closes the context itself saves what that call changed first', async t => {
  const dir = await stateDir(t);
  const f = fakes({ state: () => ({ cookies: [cookie('made-in-code', '1')], origins: [] }) });
  const browser = new TurnBrowser({ tier: 'general', stateDir: dir, savedLogins: true }, () => {}, f.hooks);
  const context = await browser.context();
  await context.close();
  assert.deepEqual((await readState(dir)).cookies.map(c => c.name), ['made-in-code']);
  assert.notEqual(await browser.context(), context, 'the next call starts a new one');
  await browser.shutdown();
});

test('browser_close while a browser is still starting closes that browser', async t => {
  const dir = await stateDir(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fakes();
  const original = f.hooks.newContext!;
  f.hooks.newContext = async (...args) => { await gate; return original(...args); };
  const browser = new TurnBrowser({ tier: 'light', stateDir: dir, savedLogins: false }, () => {}, f.hooks);
  const starting = browser.context();
  await new Promise(resolve => setTimeout(resolve, 10));
  const closing = browser.closeActive();
  release();
  await starting;
  await closing;
  assert.equal(f.processes.size, 0);
  await browser.shutdown();
});
