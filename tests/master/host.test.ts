import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { startMasterHost } from '../../server/master/host.js';
import { MasterClient } from '../../server/master/client.js';
import { masterPaths } from '../../server/master/paths.js';
import { writePrivateJson } from '../../server/stores/private-json.js';
import type { ModelCall } from '../../server/master/model-openai.js';
import type { MasterCheckpoint, MasterOverview } from '../../shared/master.js';
import { until } from '../helpers/until.js';

test('the master runs in its own host: the web relays its conversation live and lets go of it without stopping it', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-master-host-'));
  const cleanup: Array<() => unknown> = [];
  // In order: pages and clients let go, the host flushes and stops, then its folder goes.
  t.after(async () => { for (const step of cleanup.reverse()) await step(); await rm(stateDir, { recursive: true, force: true }); });
  const model: ModelCall = async () => ({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '네, 지금은 조용합니다.' }] }], text: '네, 지금은 조용합니다.' });
  const host = await startMasterHost({ stateDir, model, idleMs: 60_000 });
  cleanup.push(() => host.close());
  const paths = await masterPaths(stateDir);
  assert.equal((await stat(paths.token)).mode & 0o777, 0o600);
  assert.equal((await stat(paths.data)).mode & 0o777, 0o700);
  const client = new MasterClient({ stateDir, credentials: () => ({ port: 1, token: 'a'.repeat(64), callerSecret: 'b'.repeat(64) }) });
  cleanup.push(() => client.dispose());

  const before = await client.call('overview') as MasterOverview;
  assert.equal(before.state, 'unconfigured');
  assert.equal(before.settings.guards.maxIrreversiblePerTurn, 0, 'no limits unless the owner sets them');
  const after = await client.call('settings', { body: { apiKey: 'sk-test-0123456789abcdef' } }) as MasterOverview;
  assert.equal(after.configured, true);
  assert.equal(after.keyHint, '…cdef');
  assert.doesNotMatch(JSON.stringify(after), /0123456789ab/);
  assert.equal(((await stat(join(paths.data, 'openai-key.json'))).mode & 0o777), 0o600);

  // A page's live stream goes through the web to the host.
  const checkpoint = await client.call('checkpoint') as MasterCheckpoint;
  const relay = createServer((req, res) => { void client.pipe(res, checkpoint.epoch, checkpoint.seq); });
  await new Promise<void>(resolve => relay.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => { relay.closeAllConnections(); relay.close(() => resolve()); }));
  const stream = await fetch(`http://127.0.0.1:${(relay.address() as { port: number }).port}/`);
  const reader = stream.body!.getReader();
  let text = '';
  const reading = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; text += new TextDecoder().decode(value); } })();
  await client.call('send', { clientMessageId: 'message-0001', text: '지금 뭐 돌아가?', local: true });
  await until(() => text.includes('조용합니다'));
  assert.match(text, /"kind":"owner"/);
  await reader.cancel(); await reading.catch(() => {});

  // Letting go (a web shutting down) leaves the host and its conversation in place.
  client.dispose();
  const again = new MasterClient({ stateDir, credentials: () => undefined });
  cleanup.push(() => again.dispose());
  const resumed = await again.call('checkpoint') as MasterCheckpoint;
  assert.equal(resumed.epoch, checkpoint.epoch);
  assert.ok(resumed.entries.some(entry => entry.data.kind === 'master'));
  // Idle (its answer saved), it steps aside when asked; then nothing answers and no version is in use.
  for (let tries = 0; (await again.call('overview') as MasterOverview).state === 'thinking'; tries++) {
    assert.ok(tries < 250, 'the turn did not end');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(await again.hostVersion() !== null, true);
  assert.equal(await again.call('shutdown'), true);
  const deadline = Date.now() + 5000;
  while (await again.hostVersion().catch(() => 'error') !== null) {
    assert.ok(Date.now() < deadline, 'the host did not step aside');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
});

test('the host answers a page\'s voice requests, refusing what is not its call, and shows voice use in its overview', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-master-host-voice-'));
  const cleanup: Array<() => unknown> = [];
  t.after(async () => { for (const step of cleanup.reverse()) await step(); await rm(stateDir, { recursive: true, force: true }); });
  const host = await startMasterHost({ stateDir, model: async () => ({ output: [], text: '' }), idleMs: 60_000 });
  cleanup.push(() => host.close());
  const client = new MasterClient({ stateDir, credentials: () => undefined });
  cleanup.push(() => client.dispose());
  await client.call('settings', { body: { apiKey: 'sk-test-0123456789abcdef' } });
  const overview = await client.call('overview') as MasterOverview;
  assert.deepEqual(overview.voice?.today, { seconds: 0, dollars: 0 });
  assert.deepEqual(overview.settings.voice, { voice: 'marin', silenceSeconds: 15, dailyMinutes: 0, autoWake: true });
  const attemptId = '0190f1c2-3d4e-7f00-8a00-000000000003';
  assert.equal(await client.call('voiceStop', { attemptId, reason: 'owner' }), false);
  assert.equal(await client.call('voiceReady', { attemptId }), false);
  assert.equal(await client.call('voiceActivity', { attemptId, speaking: true, playing: false }), false);
  assert.equal(await client.call('voiceNotice', { noticeId: 'n', result: 'played' }), false);
  await assert.rejects(client.call('voiceStart', { attemptId: 'x', sdp: 'v=0', tabId: attemptId, wake: false }), { statusCode: 400 });
  await assert.rejects(client.call('settings', { body: { voice: { voice: 'nobody' } } }), { statusCode: 400 });
  assert.equal(((await client.call('settings', { body: { voice: { silenceSeconds: 30 } } })) as MasterOverview).settings.voice.silenceSeconds, 30);
});

test('the master stays removable: only three existing files reach into it', async () => {
  const root = join(import.meta.dirname, '..', '..');
  const allowed = new Set(['server/index.ts', 'client/src/app/App.tsx']);
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
  // The header's panel buttons carry a marker the master presses them by; nothing else of theirs changed.
  const marked: string[] = [];
  const mark = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'master') await mark(path); continue; }
      if (/\.tsx$/.test(entry.name) && (await readFile(path, 'utf8')).includes('data-master-panel')) marked.push(relative(root, path));
    }
  };
  await mark(join(root, 'client/src'));
  assert.deepEqual(marked.sort(), ['client/src/auth/AccountPanel.tsx', 'client/src/decisions/DecisionPanel.tsx', 'client/src/notifications/NotificationPanel.tsx', 'client/src/remote/RemotePanel.tsx', 'client/src/triggers/TriggerPanel.tsx']);
  // server/http/server.ts takes the master only as an option and never imports it.
  assert.doesNotMatch(await readFile(join(root, 'server/http/server.ts'), 'utf8'), /from '\.\.\/master\//);
});

test('a web that starts while delegated work or a message still waits starts the master host itself, without waiting for a page', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-master-resume-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
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
  assert.equal(existsSync(marker), false, 'nothing waits, so no host is started');

  await writePrivateJson(join(paths.data, 'tasks.json'), JSON.stringify({ items: [{ id: 'task-1', state: 'running' }] }));
  const web = start();
  t.after(() => web.dispose());
  await until(() => existsSync(marker));
  assert.match(await readFile(marker, 'utf8'), /--master-host/);
});
