import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { liveDir, markerSwitch, playwrightProfile, reapBrowsers, recordBrowser, type ProcessProbe } from '../../../server/browser/live.js';

const MARKER = 'a'.repeat(32);
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'tower-browser-live-'));
  const temp = join(root, 'temp');
  await mkdir(temp);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { stateDir: join(root, 'state'), temp };
}

/** Processes as a table: pid → command line; killing removes the entry once `stubborn` allows. */
function probe(processes: Map<number, string>, alive: Set<number>, stubborn = new Set<number>()) {
  const signals: [number, string][] = [];
  const fake: ProcessProbe = {
    alive: pid => alive.has(pid),
    command: async pid => processes.get(pid),
    kill: (pid, signal) => { signals.push([pid, signal]); if (!stubborn.has(pid)) processes.delete(pid); },
  };
  return { fake, signals };
}

test('a browser whose tool server died is ended, with its Playwright profile, and its record goes', async t => {
  const f = await fixture(t);
  const profile = join(f.temp, 'playwright_chromiumdev_profile-abc');
  await mkdir(profile);
  await recordBrowser(f.stateDir, { serverPid: 100, browserPid: 200, marker: MARKER, startedAt: '' });
  const { fake, signals } = probe(new Map([[200, `/chrome --user-data-dir=${profile} ${markerSwitch(MARKER)}`]]), new Set());
  assert.equal(await reapBrowsers(f.stateDir, fake, { graceMs: 0, tempDir: f.temp }), 1);
  assert.deepEqual(signals, [[200, 'SIGTERM']]);
  await assert.rejects(stat(profile));
  assert.deepEqual(await readdir(liveDir(f.stateDir)), []);
});

test('a live tool server\'s browser and a reused process ID are never touched', async t => {
  const f = await fixture(t);
  await recordBrowser(f.stateDir, { serverPid: 100, browserPid: 200, marker: MARKER, startedAt: '' });
  await recordBrowser(f.stateDir, { serverPid: 101, browserPid: 201, marker: 'b'.repeat(32), startedAt: '' });
  const processes = new Map([[200, `/chrome ${markerSwitch(MARKER)}`], [201, '/usr/bin/vim notes.txt']]);
  const { fake, signals } = probe(processes, new Set([100]));
  assert.equal(await reapBrowsers(f.stateDir, fake, { graceMs: 0, tempDir: f.temp }), 0);
  assert.deepEqual(signals, []);
  assert.deepEqual((await readdir(liveDir(f.stateDir))).sort(), [`100-${MARKER}.json`], 'the gone browser\'s record goes; the live one stays');
});

test('a browser that ignores SIGTERM gets SIGKILL; one that survives both keeps its record for the next start', async t => {
  const f = await fixture(t);
  await recordBrowser(f.stateDir, { serverPid: 100, browserPid: 200, marker: MARKER, startedAt: '' });
  const stubborn = probe(new Map([[200, `/chrome ${markerSwitch(MARKER)}`]]), new Set(), new Set([200]));
  assert.equal(await reapBrowsers(f.stateDir, stubborn.fake, { graceMs: 0, tempDir: f.temp }), 0);
  assert.deepEqual(stubborn.signals, [[200, 'SIGTERM'], [200, 'SIGKILL']]);
  assert.deepEqual(await readdir(liveDir(f.stateDir)), [`100-${MARKER}.json`]);
});

test('a record claimed by a reaper that died is put back; malformed records are dropped', async t => {
  const f = await fixture(t);
  await recordBrowser(f.stateDir, { serverPid: 100, browserPid: 200, marker: MARKER, startedAt: '' });
  const { rename } = await import('node:fs/promises');
  await rename(join(liveDir(f.stateDir), `100-${MARKER}.json`), join(liveDir(f.stateDir), `100-${MARKER}.json.reaping-999`));
  await writeFile(join(liveDir(f.stateDir), `300-${'c'.repeat(32)}.json`), JSON.stringify({ serverPid: 300, browserPid: 400, marker: '../../etc' }));
  const { fake } = probe(new Map([[200, `/chrome ${markerSwitch(MARKER)}`]]), new Set());
  assert.equal(await reapBrowsers(f.stateDir, fake, { graceMs: 0, tempDir: f.temp }), 1);
  assert.deepEqual(await readdir(liveDir(f.stateDir)), []);
});

test('only Playwright\'s own profile folder directly in the temp folder is ever removed', () => {
  assert.equal(playwrightProfile('/c --user-data-dir=/tmp/x/playwright_chromiumdev_profile-1 --flag', '/tmp/x'), '/tmp/x/playwright_chromiumdev_profile-1');
  assert.equal(playwrightProfile('/c --user-data-dir=/tmp/x/sub/playwright_chromiumdev_profile-1', '/tmp/x'), undefined);
  assert.equal(playwrightProfile('/c --user-data-dir=/tmp/x/../playwright_chromiumdev_profile-1', '/tmp/x'), undefined);
  assert.equal(playwrightProfile('/c --user-data-dir=/Users/me/Library/Chrome', '/tmp/x'), undefined);
  assert.equal(playwrightProfile('/c --no-profile', '/tmp/x'), undefined);
});

test('two servers starting together end a leftover browser once', async t => {
  const f = await fixture(t);
  await recordBrowser(f.stateDir, { serverPid: 100, browserPid: 200, marker: MARKER, startedAt: '' });
  const { fake, signals } = probe(new Map([[200, `/chrome ${markerSwitch(MARKER)}`]]), new Set());
  const results = await Promise.all([reapBrowsers(f.stateDir, fake, { graceMs: 5, tempDir: f.temp }), reapBrowsers(f.stateDir, fake, { graceMs: 5, tempDir: f.temp })]);
  assert.deepEqual(results.sort(), [0, 1]);
  assert.deepEqual(signals, [[200, 'SIGTERM']]);
  assert.deepEqual(await readdir(liveDir(f.stateDir)), []);
});
