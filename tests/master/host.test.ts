import { temporaryFixture, removeTemporaryFixture } from '../helpers/temporary.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { startMasterHost } from '../../server/master/host.js';
import { MasterClient } from '../../server/master/client.js';
import { MasterVoice } from '../../server/master/voice.js';
import { masterPaths } from '../../server/master/paths.js';
import { writePrivateJson } from '../../server/stores/private-json.js';
import type { MasterCheckpoint, MasterOverview } from '../../shared/master.js';
import { until } from '../helpers/until.js';

test('playback diagnostics survive the web to master-host RPC boundary', async t => {
  const stateDir = await temporaryFixture('tower-master-playback-rpc-');
  const host = await startMasterHost({ stateDir, idleMs: 60_000 });
  const client = new MasterClient({ stateDir, credentials: () => undefined });
  t.after(async () => { client.dispose(); await host.close(); await removeTemporaryFixture(stateDir); });
  // Observe the real callee; an unknown session still follows its normal rejection path.
  const heard = t.mock.method(MasterVoice.prototype, 'voicePlayed');
  const playback = { position: 2.5, muted: false, volume: 1, ready: 4, network: 1, context: 'running' };
  assert.equal(await client.call('voicePlayed', { session: 'unknown', id: 'unknown', result: 'played', playback }), false);
  assert.deepEqual(heard.mock.calls.at(-1)!.arguments[0].playback, playback);
});

test('the master host keeps its folder private, relays its live stream through the web, and lets go of it without stopping', async t => {
  const stateDir = await temporaryFixture('tower-master-host-');
  const cleanup: Array<() => unknown> = [];
  // In order: pages and clients let go, the host flushes and stops, then its folder goes.
  t.after(async () => { for (const step of cleanup.reverse()) await step(); await removeTemporaryFixture(stateDir); });
  const host = await startMasterHost({ stateDir, idleMs: 60_000 });
  cleanup.push(() => host.close());
  const paths = await masterPaths(stateDir);
  assert.equal((await stat(paths.token)).mode & 0o777, 0o600);
  assert.equal((await stat(paths.data)).mode & 0o777, 0o700);
  // The master's own folder holds its guide for both tools.
  const guide = await readFile(join(stateDir, 'master-session', 'CLAUDE.md'), 'utf8');
  assert.equal(await readFile(join(stateDir, 'master-session', 'AGENTS.md'), 'utf8'), guide);
  assert.match(guide, /tower_api/);
  assert.match(guide, /\[Tower report\]/);
  const client = new MasterClient({ stateDir, credentials: () => ({ port: 1, token: 'a'.repeat(64), callerSecret: 'b'.repeat(64) }) });
  cleanup.push(() => client.dispose());

  const before = await client.call('overview') as MasterOverview;
  assert.equal(before.session, undefined, 'no master session until the owner starts one');
  assert.equal(before.activeTasks, 0);
  assert.deepEqual(Object.keys(before.settings).sort(), ['heartbeat', 'voice']);
  await assert.rejects(client.call('settings', { body: { apiKey: 'sk-test-0123456789abcdef' } }), { kind: 'invalid' }, 'the master takes no model key');

  // A page's live stream goes through the web to the host.
  const checkpoint = await client.call('checkpoint') as MasterCheckpoint;
  const relay = createServer((req, res) => { void client.pipe(res, checkpoint.epoch, checkpoint.seq); });
  await new Promise<void>(resolve => relay.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => { relay.closeAllConnections(); relay.close(() => resolve()); }));
  const stream = await fetch(`http://127.0.0.1:${(relay.address() as { port: number }).port}/`);
  const reader = stream.body!.getReader();
  let text = '';
  const reading = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; text += new TextDecoder().decode(value); } })();
  await client.call('settings', { body: { voice: { endSilenceMs: 1400 } } });
  await until(() => text.includes('"endSilenceMs":1400'));
  await reader.cancel(); await reading.catch(() => {});

  // Letting go (a web shutting down) leaves the host in place; idle, it steps aside when asked.
  client.dispose();
  const again = new MasterClient({ stateDir, credentials: () => undefined });
  cleanup.push(() => again.dispose());
  assert.equal((await again.call('checkpoint') as MasterCheckpoint).epoch, checkpoint.epoch);
  assert.equal(await again.call('shutdown'), true);
  const deadline = Date.now() + 5000;
  while (await again.hostVersion().catch(() => 'error') !== null) {
    assert.ok(Date.now() < deadline, 'the host did not step aside');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
});

test('settings of the master that talked through a model API are dropped, its key files deleted, and its conversation left as it was', async t => {
  const stateDir = await temporaryFixture('tower-master-migrate-');
  const cleanup: Array<() => unknown> = [];
  t.after(async () => { for (const step of cleanup.reverse()) await step(); await removeTemporaryFixture(stateDir); });
  const paths = await masterPaths(stateDir);
  await mkdir(join(paths.data, 'room'), { recursive: true, mode: 0o700 });
  await writePrivateJson(join(paths.data, 'settings.json'), JSON.stringify({ enabled: true, model: 'gpt-6-sol', effort: 'medium', showResults: true, guards: { hideSecrets: true }, voice: { endSilenceMs: 1300, voice: 'old' } }));
  await writePrivateJson(join(paths.data, 'openai-key.json'), JSON.stringify({ apiKey: 'sk-old-0123456789abcdef' }));
  await writePrivateJson(join(paths.data, 'anthropic-key.json'), JSON.stringify({ apiKey: 'sk-ant-0123456789abcdef' }));
  await writePrivateJson(join(paths.data, 'elevenlabs-key.json'), JSON.stringify({ apiKey: 'el-0123456789abcdef' }));
  const archived = JSON.stringify({ version: 1, entries: [{ id: 'e1', order: 0, at: '2026-09-27T00:00:00.000Z', revision: 1, data: { kind: 'owner', text: 'old' } }] });
  await writeFile(join(paths.data, 'room', '000000.json'), archived, { mode: 0o600 });
  const host = await startMasterHost({ stateDir, idleMs: 60_000 });
  cleanup.push(() => host.close());
  const client = new MasterClient({ stateDir, credentials: () => undefined });
  cleanup.push(() => client.dispose());
  const overview = await client.call('overview') as MasterOverview;
  assert.equal(overview.settings.voice.endSilenceMs, 1300, 'voice settings are kept');
  assert.equal(overview.voiceConfigured, true, 'the ElevenLabs key is kept');
  assert.deepEqual(JSON.parse(await readFile(join(paths.data, 'settings.json'), 'utf8')), { voice: overview.settings.voice, heartbeat: overview.settings.heartbeat });
  assert.equal(existsSync(join(paths.data, 'openai-key.json')), false);
  assert.equal(existsSync(join(paths.data, 'anthropic-key.json')), false);
  assert.equal(await readFile(join(paths.data, 'room', '000000.json'), 'utf8'), archived, 'the old conversation stays as it was');
});

test('a master session keeps the host alive past its idle time, yet another build may take it over', async t => {
  const stateDir = await temporaryFixture('tower-master-host-bound-');
  const cleanup: Array<() => unknown> = [];
  t.after(async () => { for (const step of cleanup.reverse()) await step(); await removeTemporaryFixture(stateDir); });
  const paths = await masterPaths(stateDir);
  await mkdir(paths.data, { recursive: true, mode: 0o700 });
  await writePrivateJson(join(paths.data, 'settings.json'), JSON.stringify({ session: { sessionId: 'claude:master', provider: 'claude', startedAt: new Date().toISOString() } }));
  const host = await startMasterHost({ stateDir, idleMs: 50 });
  cleanup.push(() => host.close());
  const client = new MasterClient({ stateDir, credentials: () => undefined });
  cleanup.push(() => client.dispose());
  assert.equal((await client.call('overview') as MasterOverview).session?.id, 'claude:master');
  // Past its idle time it stays, to report the work the master handed out.
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.notEqual(await client.hostVersion(), null);
  // What it follows is on disk, so it steps aside for another build all the same.
  assert.equal(await client.call('shutdown'), true);
  const deadline = Date.now() + 5000;
  while (await client.hostVersion().catch(() => 'error') !== null) {
    assert.ok(Date.now() < deadline, 'the host did not step aside');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
});

test('the host answers a page\'s voice requests, refusing what is not its call, and shows voice use in its overview', async t => {
  const stateDir = await temporaryFixture('tower-master-host-voice-');
  const cleanup: Array<() => unknown> = [];
  t.after(async () => { for (const step of cleanup.reverse()) await step(); await removeTemporaryFixture(stateDir); });
  const host = await startMasterHost({ stateDir, idleMs: 60_000 });
  cleanup.push(() => host.close());
  const client = new MasterClient({ stateDir, credentials: () => undefined });
  cleanup.push(() => client.dispose());
  const overview = await client.call('overview') as MasterOverview;
  assert.deepEqual(overview.voice?.today, { sttSeconds: 0, ttsChars: 0, dollars: 0 });
  assert.deepEqual(overview.settings.voice, { voiceId: 'cgSgspJ2msm6clMCkdW9', model: 'eleven_v4_turbo', endSilenceMs: 1000, listenMinutes: 5, readReports: true, dailyDollars: 0, playbackRate: 1 });
  assert.equal(overview.voiceConfigured, false);
  const session = '0190f1c2-3d4e-7f00-8a00-000000000003';
  await assert.rejects(client.call('voiceOn', { tabId: session }), { kind: 'conflict' }, 'no master session yet');
  assert.equal(await client.call('voiceOff', { session }), false);
  assert.equal(await client.call('voicePresence', { session, listening: true, panelOpen: true }), false);
  assert.equal(await client.call('voiceActivity', { session, speaking: true }), false);
  assert.equal(await client.call('voicePlayed', { session, id: 'x', result: 'played' }), false);
  assert.equal(await client.call('voiceUsage', { tokenId: 'x', seconds: 1 }), false);
  assert.deepEqual(await client.call('voiceRequest', { session, clientMessageId: 'message-0001', text: '안녕' }), { stale: true });
  await assert.rejects(client.call('settings', { body: { voice: { model: 'nobody' } } }), { kind: 'invalid' });
  const saved = await client.call('settings', { body: { voiceKey: 'el-test-0123456789abcdef', voice: { endSilenceMs: 1200 } } }) as MasterOverview;
  assert.equal(saved.settings.voice.endSilenceMs, 1200);
  // Reading speed: from 1 (as made) to 2, kept to twentieths.
  for (const playbackRate of [0.9, 2.5, Number.NaN, '1.4']) await assert.rejects(client.call('settings', { body: { voice: { playbackRate } } }), { kind: 'invalid' });
  const faster = await client.call('settings', { body: { voice: { playbackRate: 1.43 } } }) as MasterOverview;
  assert.equal(faster.settings.voice.playbackRate, 1.45);
  assert.equal(faster.settings.voice.endSilenceMs, 1200, 'the rest is kept');
  assert.equal(saved.voiceKeyHint, '…cdef');
  assert.doesNotMatch(JSON.stringify(saved), /0123456789ab/);
});

test('the master stays removable: only these existing files reach into it', async () => {
  const root = join(import.meta.dirname, '..', '..');
  // The worker knows the master's folder, to give its turns their tools and keep them to a subscription sign-in.
  // Heartbeat's shared admission contract crosses HTTP and worker boundaries; no runtime master module enters them.
  const allowed = new Set(['server/index.ts', 'client/src/app/App.tsx', 'server/api/run-tools.ts', 'server/runs/subscription.ts',
    'server/http/request-context.ts', 'server/http/server.ts', 'server/runs/manager.ts', 'server/runs/worker.ts']);
  const offenders: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { if (!['node_modules', 'master'].includes(entry.name)) await walk(path); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const name = relative(root, path);
      if (name === 'shared/master.ts') continue;
      const source = await readFile(path, 'utf8');
      if (/from\s+['"][^'"]*\/master(\/|\.js['"]|['"])/.test(source) && !allowed.has(name)) offenders.push(name);
    }
  };
  for (const folder of ['server', 'client/src', 'shared']) await walk(join(root, folder));
  assert.deepEqual(offenders, []);
  // The master opens the settings' sections the way the settings button does, never by pressing marked buttons.
  const screen = await readFile(join(root, 'client/src/master/screen.ts'), 'utf8');
  assert.match(screen, /openSettings\(\{ section: command\.panel \}\)/);
  assert.doesNotMatch(screen, /data-master-panel/);
  // server/http/server.ts takes the master only as an option and never imports it.
  assert.doesNotMatch(await readFile(join(root, 'server/http/server.ts'), 'utf8'), /from '\.\.\/master\//);
});

test('a web that starts while a master session exists starts the master host itself, without waiting for a page', async t => {
  const stateDir = await temporaryFixture('tower-master-resume-');
  t.after(() => removeTemporaryFixture(stateDir));
  const paths = await masterPaths(stateDir);
  await mkdir(paths.data, { recursive: true, mode: 0o700 });
  const marker = join(stateDir, 'started');
  // Stands in for the host: it only notes that it was started, and how.
  const entry = join(stateDir, 'fake-host.mjs');
  await writeFile(entry, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' '));`);
  const start = () => { const web = new MasterClient({ stateDir, credentials: () => undefined, hostEntry: entry, startupTimeoutMs: 300 }); web.start(); return web; };

  const quiet = start();
  await new Promise(resolve => setTimeout(resolve, 400));
  quiet.dispose();
  assert.equal(existsSync(marker), false, 'no master session, so no host is started');

  await writePrivateJson(join(paths.data, 'settings.json'), JSON.stringify({ session: { sessionId: 'claude:master', provider: 'claude', startedAt: new Date().toISOString() } }));
  const web = start();
  t.after(() => web.dispose());
  await until(() => existsSync(marker));
  assert.match(await readFile(marker, 'utf8'), /--master-host/);
});

test('a settings file this build cannot read is left as it is, not replaced by defaults', async t => {
  const stateDir = await temporaryFixture('tower-master-unreadable-');
  const cleanup: Array<() => unknown> = [];
  t.after(async () => { for (const step of cleanup.reverse()) await step(); await removeTemporaryFixture(stateDir); });
  const paths = await masterPaths(stateDir);
  await mkdir(paths.data, { recursive: true, mode: 0o700 });
  const newer = JSON.stringify({ voice: { endSilenceMs: 1300 }, session: { sessionId: 'claude:master', provider: 'claude', startedAt: '2026-09-28T00:00:00.000Z' }, somethingNewer: true });
  await writePrivateJson(join(paths.data, 'settings.json'), newer);
  const host = await startMasterHost({ stateDir, idleMs: 60_000 });
  cleanup.push(() => host.close());
  assert.equal(await readFile(join(paths.data, 'settings.json'), 'utf8'), newer);
});

test('master host error replies keep their status and message across the host wire, and the route clamps what it answers', async t => {
  const stateDir = await temporaryFixture('tower-master-error-wire-');
  const host = await startMasterHost({ stateDir, idleMs: 60_000 });
  const client = new MasterClient({ stateDir, credentials: () => undefined });
  t.after(async () => { client.dispose(); await host.close(); await removeTemporaryFixture(stateDir); });
  const { errorStatus } = await import('../../server/http/requests.js');
  const { masterRoutes } = await import('../../server/master/routes.js');
  const plain = (message: string, fields: Record<string, unknown>) => Object.assign(new Error(message), fields);
  const cases: Array<[name: string, thrown: unknown, status: number, message: string]> = [
    ['mapped', plain('a', { statusCode: 404 }), 404, 'a'],
    ['unmapped', plain('b', { statusCode: 599 }), 599, 'b'],
    ['zero', plain('c', { statusCode: 0 }), 0, 'c'],
    ['no status', new Error('d'), 500, 'd'],
    ['not an Error', 'boom', 500, 'Master operation failed.'],
  ];
  let thrown: unknown;
  t.mock.method(MasterVoice.prototype, 'voicePlayed', () => { throw thrown; });
  for (const [name, value, status, message] of cases) {
    thrown = value;
    const error = await client.call('voicePlayed', { session: 's', id: 'i', result: 'played' }).then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof Error, name);
    assert.deepEqual({ status: errorStatus(error), message: error.message, hostAbsent: (error as { hostAbsent?: boolean }).hostAbsent }, { status, message, hostAbsent: undefined }, name);
  }
  // The page route answers 400–599 as it is and anything else as 503, with the message or its own.
  const answered = async (failure: unknown) => {
    const handle = masterRoutes({ call: async () => { throw failure; } } as never);
    let status: unknown; let body = '';
    await handle({ method: 'GET' } as never, { writeHead: (value: unknown) => { status = value; }, end: (text: string) => { body = text; } } as never, '/api/master', new URL('http://x/api/master'), { local: true });
    return { status, body: JSON.parse(body) as { error: string } };
  };
  assert.deepEqual(await answered(plain('e', { statusCode: 404 })), { status: 404, body: { error: 'e' } });
  assert.deepEqual(await answered(plain('f', { statusCode: 599 })), { status: 599, body: { error: 'f' } });
  for (const statusCode of [600, 399, 0, Number.NaN, undefined]) assert.deepEqual(await answered(plain('g', { statusCode })), { status: 503, body: { error: 'g' } }, String(statusCode));
  assert.deepEqual(await answered(new Error('h')), { status: 503, body: { error: 'h' } });
  assert.deepEqual(await answered({}), { status: 503, body: { error: '마스터를 사용할 수 없습니다.' } });
});
